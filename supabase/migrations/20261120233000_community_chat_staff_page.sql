-- ============================================================================
-- The Community chat gets a staff page of its own, where staff edit and delete messages live (2026-11-20; the user:
-- "create a whole separate page in staff for chat and let them be able to edit delete and modify messages in real
-- time"). Follows 20261120203000 and 20261120213000, applied the same day.
--
--  1. Edits are kept, never lost: hub_chat gains edited_at / edited_user (the last staff edit) and hub_chat_edits keeps
--     every earlier wording (msg_id, body_before, body_after, staff_user, created_at). RLS on, staff read under
--     _staff_mod('community'), nobody writes it directly. Members see "Edited by the team" on an edited message
--     (_chat_row's `ed`); they never see the earlier words.
--  2. staff_chat_edit(p_mid, p_body, p_was): Community editors only (_staff_mod('community', true)). The text is cleaned
--     as a member's is (_chat_clean, 1 to 500). p_was = the words the staffer saw: when the message has changed since
--     (another staffer edited it), it raises CHANGED and changes nothing, so two staff never overwrite each other blind.
--     The same words again change nothing. A deleted message can be edited too (staff may tidy it before putting it back).
--  3. Live for staff: hub_chat.changed_at (set on every insert and update by the trigger hub_chat_changed) lets the staff
--     page read only what changed since its last read (hub_chat_changed_at). hub_chat_waiting indexes the reported
--     messages nobody has looked at, for the rail's number.
--  4. The ping: an edit sends the members' empty 'tick' as a removal does (hub_chat_tick_body), so an open member page asks
--     chat_read at once. A report, a Keep and a mute send an empty 'staff' broadcast on the same public topic (members'
--     pages listen for 'tick' only): it names nobody and carries no words or id, like the tick.
--  5. chat_read (rebuilt): a p_after read also gives `edits`, the messages still shown that were edited in the last two
--     days, as _chat_row gives them, so an open page swaps the words in place. Header and checks as in 20261120213000.
--
-- Nothing is deleted. Rollback:
--   drop trigger if exists hub_chat_changed on public.hub_chat; drop trigger if exists hub_chat_tick_body on public.hub_chat;
--   drop trigger if exists hub_chat_tick_staff on public.hub_chat;
--   drop trigger if exists hub_chat_members_tick_ins on public.hub_chat_members; drop trigger if exists hub_chat_members_tick_upd on public.hub_chat_members;
--   drop function if exists public.staff_chat_edit(bigint, text, text), public._chat_changed(), public._chat_tick_staff();
--   then run 20261120213000_community_chat_six_hours.sql again (chat_read) and 20261120203000's _chat_row.
--   (hub_chat_edits and the new columns are kept: they hold what was written; drop them only if the chat is given up)
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $need$
begin
  if to_regprocedure('public._chat_keep()') is null or to_regprocedure('public.chat_read(text,text,bigint,bigint)') is null then
    raise exception 'community_chat_staff_page: apply 20261120203000 and 20261120213000 first';
  end if;
end $need$;


/* -- 1. edits kept; what changed when ------------------------------------------------------------- */
alter table public.hub_chat add column if not exists edited_at timestamptz;
alter table public.hub_chat add column if not exists edited_user uuid;
alter table public.hub_chat add column if not exists changed_at timestamptz;
-- the messages already written: changed when they were written, removed or looked at, whichever came last (no trigger
-- below exists yet, and none of the older ones watches changed_at, so this sends nothing)
update public.hub_chat
   set changed_at = greatest(created_at, coalesce(removed_at, created_at), coalesce(checked_at, created_at))
 where changed_at is null;
alter table public.hub_chat alter column changed_at set default now();
alter table public.hub_chat alter column changed_at set not null;
create index if not exists hub_chat_changed_at on public.hub_chat (changed_at);
create index if not exists hub_chat_waiting on public.hub_chat (id) where reports > 0 and checked_at is null;
comment on column public.hub_chat.changed_at is
  'Set on every insert and update (hub_chat_changed): the staff page reads only what changed since its last read.';
comment on column public.hub_chat.edited_at is
  'The last staff edit (staff_chat_edit); every earlier wording is in hub_chat_edits. Members see "Edited by the team".';

create table if not exists public.hub_chat_edits (
  id          bigint generated always as identity primary key,
  msg_id      bigint not null references public.hub_chat (id) on delete cascade,
  body_before text not null,
  body_after  text not null,
  staff_user  uuid,
  created_at  timestamptz not null default now()
);
comment on table public.hub_chat_edits is
  'The club chat (20261120233000): every staff edit of a message, the words before and after, who and when. Staff read; written only by staff_chat_edit. Nothing is deleted from it.';
create index if not exists hub_chat_edits_msg on public.hub_chat_edits (msg_id, id);
alter table public.hub_chat_edits enable row level security;
revoke all on public.hub_chat_edits from public, anon, authenticated;
grant select on public.hub_chat_edits to authenticated;
drop policy if exists "staff read" on public.hub_chat_edits;
create policy "staff read" on public.hub_chat_edits for select using ((select _staff_mod('community')));

-- changed_at follows every update; it reads nothing but NEW, so it needs no definer rights
create or replace function public._chat_changed()
returns trigger
language plpgsql set search_path to 'public'
as $$
begin
  new.changed_at := now();
  return new;
end $$;
revoke all on function public._chat_changed() from public, anon, authenticated;
drop trigger if exists hub_chat_changed on public.hub_chat;
create trigger hub_chat_changed before update on public.hub_chat
  for each row execute function public._chat_changed();


/* -- 2. staff edit ------------------------------------------------------------------------------- */
create or replace function public.staff_chat_edit(p_mid bigint, p_body text, p_was text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_body text := _chat_clean(p_body); r hub_chat%rowtype;
begin
  if (select _staff_mod('community', true)) is not true then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_mid is null or char_length(v_body) not between 1 and 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  select * into r from hub_chat m where m.id = p_mid for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_was is not null and r.body is distinct from p_was then raise exception 'CHANGED' using errcode = 'P0001'; end if;
  if r.body = v_body then return to_jsonb(r); end if;
  insert into hub_chat_edits (msg_id, body_before, body_after, staff_user) values (r.id, r.body, v_body, auth.uid());
  update hub_chat m set body = v_body, edited_at = now(), edited_user = auth.uid() where m.id = r.id returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.staff_chat_edit(bigint, text, text) from public, anon;
grant execute on function public.staff_chat_edit(bigint, text, text) to authenticated;


/* -- 3. the pings --------------------------------------------------------------------------------- */
-- An empty 'staff' broadcast on the same PUBLIC topic: a report, a Keep or a mute changed something only staff see.
create or replace function public._chat_tick_staff()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  begin
    perform realtime.send('{}'::jsonb, 'staff', 'hub-chat', false);
  exception when others then
    null;
  end;
  return null;
end $$;
revoke all on function public._chat_tick_staff() from public, anon, authenticated;

-- an edit reaches the members' open pages as a removal does: the empty tick, then chat_read's `edits`
drop trigger if exists hub_chat_tick_body on public.hub_chat;
create trigger hub_chat_tick_body after update of body on public.hub_chat
  for each row when (old.body is distinct from new.body) execute function public._chat_tick();
drop trigger if exists hub_chat_tick_staff on public.hub_chat;
create trigger hub_chat_tick_staff after update of reports, checked_at on public.hub_chat
  for each row when (old.reports is distinct from new.reports or old.checked_at is distinct from new.checked_at)
  execute function public._chat_tick_staff();
drop trigger if exists hub_chat_members_tick_ins on public.hub_chat_members;
create trigger hub_chat_members_tick_ins after insert on public.hub_chat_members
  for each row when (new.muted_until is not null) execute function public._chat_tick_staff();
drop trigger if exists hub_chat_members_tick_upd on public.hub_chat_members;
create trigger hub_chat_members_tick_upd after update of muted_until on public.hub_chat_members
  for each row when (old.muted_until is distinct from new.muted_until) execute function public._chat_tick_staff();


/* -- 4. what members read ------------------------------------------------------------------------- */
-- A message as a member reads it (20261120203000), and `ed`: the team edited it. Never the earlier words.
create or replace function public._chat_row(m public.hub_chat, p_me text[])
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  select jsonb_build_object(
    'id', m.id, 'at', m.created_at, 'day', to_char(m.created_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD'),
    'body', m.body, 'team', m.customer_id is null,
    'mine', m.customer_id is not null and m.customer_id = any(coalesce(p_me, '{}'::text[])),
    'name', case when m.customer_id is null then null
                 else (select nullif(btrim(c.name), '') from customers c where c.id = m.customer_id) end,
    'k', case when m.customer_id is null then 'team' else _member_ref(m.customer_id) end,
    'ed', m.edited_at is not null);
$$;
revoke all on function public._chat_row(public.hub_chat, text[]) from public, anon, authenticated;

-- chat_read as in 20261120213000, and on a p_after read `edits`: the messages still shown that were edited in the last
-- two days (inside the six hours by v_min), so the open page swaps their words.
create or replace function public.chat_read(p_id text, p_token text, p_after bigint default null, p_before bigint default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_me text[]; v_rows jsonb; v_n integer := 0; v_more boolean := false; v_reset boolean := false;
        v_gone jsonb := '[]'::jsonb; v_edits jsonb := '[]'::jsonb; v_agreed boolean; v_until timestamptz; v_min bigint;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_me := _accts_of(p_id);
  -- the first message still inside the six hours, found by its time (hub_chat_created_at; a min(id) would walk the
  -- primary key from the oldest message). Every read below starts 50 ids under it, room for an id handed out a moment
  -- before an earlier-stamped one, so none walks the messages kept for staff; _chat_shown still decides each message.
  select m.id - 50 into v_min from hub_chat m where m.created_at > now() - _chat_keep() order by m.created_at limit 1;
  if v_min is null then v_min := 9223372036854775807; end if;
  if p_after is not null then
    -- what came since, oldest first; a page more than 100 behind takes the newest page instead
    if (select count(*) from (select 1 from hub_chat m where m.id >= v_min and m.id > p_after and _chat_shown(m) limit 101) x) > 100 then
      v_reset := true;
    else
      -- also the last seconds' messages just under p_after: one whose insert began earlier but was committed after a
      -- later id had been read would otherwise never reach this page (the page drops what it already holds)
      select coalesce(jsonb_agg(_chat_row(m, v_me) order by m.id), '[]'::jsonb) into v_rows
        from hub_chat m
       where m.id >= v_min
         and (m.id > p_after or (m.id > p_after - 200 and m.created_at > now() - interval '15 seconds')) and _chat_shown(m);
      select coalesce(jsonb_agg(x.id), '[]'::jsonb) into v_gone
        from (select m.id from hub_chat m where m.id >= v_min and m.removed_at > now() - interval '2 days' order by m.id desc limit 200) x;
      select coalesce(jsonb_agg(x.j order by x.id), '[]'::jsonb) into v_edits
        from (select m.id, _chat_row(m, v_me) as j from hub_chat m
               where m.id >= v_min and m.id <= p_after and m.edited_at > now() - interval '2 days' and _chat_shown(m)
               order by m.id desc limit 200) x;
    end if;
  end if;
  if p_after is null or v_reset then
    select coalesce(jsonb_agg(x.j order by x.id), '[]'::jsonb), count(*)::integer into v_rows, v_n
      from (select m.id, _chat_row(m, v_me) as j
              from hub_chat m
             where m.id >= v_min and (p_before is null or v_reset or m.id < p_before) and _chat_shown(m)
             order by m.id desc limit 50) x;
    v_more := v_n = 50 and exists (select 1 from hub_chat m where m.id >= v_min and m.id < (v_rows -> 0 ->> 'id')::bigint and _chat_shown(m));
  end if;
  select bool_or(cm.agreed_at is not null), max(cm.muted_until) into v_agreed, v_until
    from hub_chat_members cm where cm.customer_id = any(v_me);
  return jsonb_build_object('ok', true, 'rows', v_rows, 'reset', v_reset, 'more', v_more, 'gone', v_gone, 'edits', v_edits,
    'now', now(), 'keep', extract(epoch from _chat_keep())::integer,
    'me', jsonb_build_object('agreed', coalesce(v_agreed, false),
                             'muted', v_until is not null and v_until > now(),
                             'until', case when v_until is null or v_until = 'infinity' or v_until <= now() then null else v_until end));
end $$;
revoke all on function public.chat_read(text, text, bigint, bigint) from public;
grant execute on function public.chat_read(text, text, bigint, bigint) to anon, authenticated;


/* -- 5. checks ----------------------------------------------------------------------------------- */
do $chk$
declare f text;
begin
  foreach f in array array['public._chat_row(public.hub_chat,text[])', 'public.chat_read(text,text,bigint,bigint)',
                           'public.staff_chat_edit(bigint,text,text)', 'public._chat_tick_staff()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._chat_row(public.hub_chat,text[])', 'public._chat_tick_staff()', 'public._chat_changed()'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.staff_chat_edit(bigint,text,text)', 'execute') then raise exception 'staff_chat_edit is executable by anon'; end if;
  if not has_function_privilege('authenticated', 'public.staff_chat_edit(bigint,text,text)', 'execute') then raise exception 'staff_chat_edit is not executable by staff'; end if;
  if not has_function_privilege('anon', 'public.chat_read(text,text,bigint,bigint)', 'execute') then raise exception 'chat_read is not executable by anon'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.hub_chat_edits'::regclass) then raise exception 'hub_chat_edits has no RLS'; end if;
  if has_table_privilege('anon', 'public.hub_chat_edits', 'select') or has_table_privilege('authenticated', 'public.hub_chat_edits', 'insert')
     or has_table_privilege('authenticated', 'public.hub_chat_edits', 'update') or has_table_privilege('authenticated', 'public.hub_chat_edits', 'delete') then
    raise exception 'hub_chat_edits is writable by a client, or readable by anon';
  end if;
  if exists (select 1 from public.hub_chat where changed_at is null) then raise exception 'a message has no changed_at'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261120233000', 'community_chat_staff_page')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): the edits table closed, the columns, the five triggers, the functions definers, the ledger.
-- select (select relrowsecurity from pg_class where oid = 'public.hub_chat_edits'::regclass) as edits_rls_true,
--        (select count(*) from pg_policies where schemaname = 'public' and tablename = 'hub_chat_edits') as edits_policy_1,
--        (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'hub_chat'
--          and column_name in ('edited_at', 'edited_user', 'changed_at')) as columns_3,
--        (select count(*) from pg_trigger where tgname in ('hub_chat_changed', 'hub_chat_tick_body', 'hub_chat_tick_staff',
--          'hub_chat_members_tick_ins', 'hub_chat_members_tick_upd')) as triggers_5,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
--          and proname in ('_chat_row', 'chat_read', 'staff_chat_edit', '_chat_tick_staff')) as definer_4,
--        has_function_privilege('anon', 'public.staff_chat_edit(bigint,text,text)', 'execute') as anon_edit_false,
--        has_table_privilege('anon', 'public.hub_chat_edits', 'select') as anon_edits_false,
--        (select count(*) from public.hub_chat where changed_at is null) as unstamped_0,
--        (select name from supabase_migrations.schema_migrations where version = '20261120233000') as ledger;
