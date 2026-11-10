-- ============================================================================
-- The desk's bulk writes in one call each (staff website round s10, item 1), 2026-11-11.
--
-- Bulk check-in, bulk return and the close-out sent one write per rider, all at once (Promise.all): a select-all on a
-- 40-rider night put 40 writes on the web layer's ten shared connections together, and the close-out said only its first
-- refusal. Three functions take the whole set in one call and answer one result per rider, so every refusal is said on
-- its own row (named staff_bulk_* and not staff_checkin_many: a filter on 'rpc/staff_checkin' would take one for the other):
--
-- 1. staff_bulk_checkin(p_ids, p_ops, p_at): each rider through staff_checkin itself (every guard it has: staff only, the
--    op id receipt, waiting or waitlist only, an approval ride's request approved first, the reserved bike claimed or
--    dropped, the desk's time), each in its own savepoint. Answers [{id, ok:true, r:<staff_checkin's answer>} |
--    {id, ok:false, code, message}].
-- 2. staff_bulk_return(p_rows, p_at): p_rows [{id, cond, notes, op, paid, mins}]. Each through staff_return itself (staff
--    only, the receipt, on a bike only, the bikes freed or held for a check or sent to maintenance, the assignment
--    closed), then in the same savepoint what the desk wrote after it as a second call: paid by card when the return
--    marks it paid, and the ride's minutes. A rider whose payment is refused is not returned either (it was half done:
--    the bike back, the payment not). Answers as above.
-- 3. staff_close_out(p_session_id, p_returns, p_done, p_noshow): the close-out in ONE transaction. p_returns as
--    staff_bulk_return's rows plus 'missing' (the bike ids marked Missing: once the return has landed they go to
--    'missing' as Missing on the bike's row does, only from available / maintenance / check); p_done the riders
--    checked in without a bike (or named They rode) made done while still waiting; p_noshow the never-arrived made
--    no-show while still waiting. Every row must be of p_session_id. Each row in its own savepoint; a row another desk
--    moved first answers {ok:false, lost:true}. Answers [{id, k:'return'|'done'|'noshow', ok, ...}].
--
-- Nothing else changes: the single-row functions stay as they are and the desk falls back to them (two or three at a
-- time) on a database without these. The waitlist number needs nothing new (item 2): _wl_num_assign already gives the
-- number under a per-session advisory lock (20260922122000, 20261005210000), and the desk now sends none for a rider
-- going to the end of the line. Prod had no duplicate (session_id, waitlist_num) among waitlisted rows on 2026-11-10;
-- no unique index is added because the waitlist's reorder renumbers its rows one update at a time (_wlApplyOrder).
--
-- Rollback: drop function staff_bulk_checkin(text[], uuid[], text), staff_bulk_return(jsonb, text),
--   staff_close_out(text, jsonb, text[], text[]).
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================
begin;

create or replace function public.staff_bulk_checkin(p_ids text[], p_ops uuid[] default null, p_at text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb := '[]'::jsonb; i int; n int := coalesce(array_length(p_ids, 1), 0); r jsonb;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if n > 200 then raise exception 'TOO_MANY: at most 200 riders at once' using errcode = '22023'; end if;
  for i in 1..n loop
    begin
      r := public.staff_checkin(p_ids[i], null, null, null, null, null, null, null, p_ops[i], p_at);
      v := v || jsonb_build_array(jsonb_build_object('id', p_ids[i], 'ok', true, 'r', r));
    exception when others then
      v := v || jsonb_build_array(jsonb_build_object('id', p_ids[i], 'ok', false, 'code', sqlstate, 'message', sqlerrm));
    end;
  end loop;
  return v;
end $$;

-- One return as the desk makes it: staff_return, then the payment and the ride's minutes (the desk's second write).
create or replace function public._desk_return_one(x jsonb, p_at text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r jsonb; m int;
begin
  r := public.staff_return(x->>'id', coalesce(nullif(x->>'cond', ''), 'ok'), nullif(x->>'notes', ''), nullif(x->>'op', '')::uuid, p_at);
  if coalesce((x->>'paid')::boolean, false) then
    update public.queue_entries set paid = true, pay_method = 'card' where id = x->>'id';
  end if;
  m := case when coalesce(x->>'mins', '') ~ '^\d{1,6}$' then (x->>'mins')::int end;
  if m > 0 then update public.queue_entries set ride_duration = m where id = x->>'id'; end if;
  return r;
end $$;

create or replace function public.staff_bulk_return(p_rows jsonb, p_at text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb := '[]'::jsonb; x jsonb; r jsonb;
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'BAD_ROWS' using errcode = '22023'; end if;
  if jsonb_array_length(p_rows) > 200 then raise exception 'TOO_MANY: at most 200 riders at once' using errcode = '22023'; end if;
  for x in select value from jsonb_array_elements(p_rows) loop
    begin
      r := public._desk_return_one(x, p_at);
      v := v || jsonb_build_array(jsonb_build_object('id', x->>'id', 'ok', true, 'r', r));
    exception when others then
      v := v || jsonb_build_array(jsonb_build_object('id', x->>'id', 'ok', false, 'code', sqlstate, 'message', sqlerrm));
    end;
  end loop;
  return v;
end $$;

create or replace function public.staff_close_out(p_session_id text, p_returns jsonb default '[]'::jsonb,
                                                  p_done text[] default '{}', p_noshow text[] default '{}')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare v jsonb := '[]'::jsonb; x jsonb; r jsonb; bid text; k text; st text; got text;
        today text := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
begin
  if not is_staff() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_returns, '[]'::jsonb)) is distinct from 'array' then raise exception 'BAD_ROWS' using errcode = '22023'; end if;
  if jsonb_array_length(coalesce(p_returns, '[]'::jsonb)) + coalesce(array_length(p_done, 1), 0) + coalesce(array_length(p_noshow, 1), 0) > 400 then
    raise exception 'TOO_MANY: at most 400 riders at once' using errcode = '22023';
  end if;
  -- the riders on a bike: returned, and the bikes marked Missing taken out of the pool once their return has landed
  for x in select value from jsonb_array_elements(coalesce(p_returns, '[]'::jsonb)) loop
    begin
      if not exists (select 1 from public.queue_entries where id = x->>'id' and session_id = p_session_id) then
        raise exception 'BOOKING_NOT_FOUND: no booking % on this session', x->>'id';
      end if;
      r := public._desk_return_one(x, null);
      for bid in select jsonb_array_elements_text(case when jsonb_typeof(x->'missing') = 'array' then x->'missing' else '[]'::jsonb end) loop
        update public.bikes set status = 'missing', retired_date = today
         where id = bid and status in ('available', 'maintenance', 'check');
      end loop;
      v := v || jsonb_build_array(jsonb_build_object('id', x->>'id', 'k', 'return', 'ok', true, 'r', r));
    exception when others then
      v := v || jsonb_build_array(jsonb_build_object('id', x->>'id', 'k', 'return', 'ok', false, 'code', sqlstate, 'message', sqlerrm));
    end;
  end loop;
  -- checked in without a bike (or They rode): done; never arrived: no-show. Each only while still waiting.
  foreach k in array array['done', 'noshow'] loop
    for bid in select unnest(case when k = 'done' then coalesce(p_done, '{}') else coalesce(p_noshow, '{}') end) loop
      begin
        got := null;
        update public.queue_entries set status = k
         where id = bid and session_id = p_session_id and status = 'waiting'
        returning id into got;
        if got is null then
          select status into st from public.queue_entries where id = bid;
          v := v || jsonb_build_array(jsonb_build_object('id', bid, 'k', k, 'ok', false, 'lost', true, 'status', st));
        else
          v := v || jsonb_build_array(jsonb_build_object('id', bid, 'k', k, 'ok', true));
        end if;
      exception when others then
        v := v || jsonb_build_array(jsonb_build_object('id', bid, 'k', k, 'ok', false, 'code', sqlstate, 'message', sqlerrm));
      end;
    end loop;
  end loop;
  return v;
end $$;

revoke all on function public.staff_bulk_checkin(text[], uuid[], text) from public, anon;
revoke all on function public._desk_return_one(jsonb, text) from public, anon, authenticated;
revoke all on function public.staff_bulk_return(jsonb, text) from public, anon;
revoke all on function public.staff_close_out(text, jsonb, text[], text[]) from public, anon;
grant execute on function public.staff_bulk_checkin(text[], uuid[], text) to authenticated;
grant execute on function public.staff_bulk_return(jsonb, text) to authenticated;
grant execute on function public.staff_close_out(text, jsonb, text[], text[]) to authenticated;

-- Checks: SECURITY DEFINER with its search_path, staff may call the three, nobody calls the helper.
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_bulk_checkin(text[],uuid[],text)', 'public._desk_return_one(jsonb,text)',
                           'public.staff_bulk_return(jsonb,text)', 'public.staff_close_out(text,jsonb,text[],text[])'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  if has_function_privilege('authenticated', 'public._desk_return_one(jsonb,text)', 'execute') then
    raise exception '_desk_return_one is executable by a client';
  end if;
  foreach f in array array['public.staff_bulk_checkin(text[],uuid[],text)', 'public.staff_bulk_return(jsonb,text)',
                           'public.staff_close_out(text,jsonb,text[],text[])'] loop
    if not has_function_privilege('authenticated', f, 'execute') then raise exception '% is not executable by staff', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261111180000', 'desk_bulk_writes')
on conflict (version) do nothing;

commit;
