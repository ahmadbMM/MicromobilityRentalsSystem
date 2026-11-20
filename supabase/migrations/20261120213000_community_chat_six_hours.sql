-- ============================================================================
-- The Community chat: members see a message for 6 hours, staff keep every message (2026-11-20; the user: "delete chats
-- when it completes 6 hours but keep it shown for staff and never delete them"). Follows 20261120203000, applied the
-- same day.
--
--  1. _chat_keep(): how long a message is shown to members, 6 hours, in one place.
--     _chat_shown (rebuilt): a message older than that is no longer one members may see. Nothing is removed from
--     hub_chat for it: staff go on reading every message there, under the same "staff read" policy.
--  2. Nothing is deleted any more: the daily job mm-chat-purge is unscheduled and _chat_purge is dropped (it deleted
--     messages older than 12 months). hub_chat now only grows, so the member's reads no longer walk it:
--     hub_chat_created_at (new index) finds the first message inside the 6 hours and every read starts from that id.
--  3. chat_read (rebuilt): the same answer as before, from the messages of the last 6 hours only, plus `now` (the
--     database's clock) and `keep` (the 6 hours, in seconds), so an open page drops a message at the moment it turns 6
--     hours old without trusting the phone's clock. chat_peek (rebuilt): counts inside the 6 hours.
--     chat_send (rebuilt): the member's last message is found by time through hub_chat_customer; nothing else changes.
--     Headers as in 20261120203000 (security definer, search_path, volatility); grants are kept by create or replace.
--
-- Rollback (back to 20261120203000's behaviour: shown without a time limit, deleted after 12 months):
--   run 20261120203000_community_chat.sql again (it rebuilds _chat_shown, chat_read, chat_peek, chat_send and _chat_purge
--   and schedules the job); drop function if exists public._chat_keep(); drop index if exists public.hub_chat_created_at.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $need$
begin
  if to_regclass('public.hub_chat') is null or to_regprocedure('public.chat_read(text,text,bigint,bigint)') is null then
    raise exception 'community_chat_six_hours: apply 20261120203000_community_chat first';
  end if;
end $need$;


/* -- 1. six hours for members -------------------------------------------------------------------- */
create index if not exists hub_chat_created_at on public.hub_chat (created_at);

create or replace function public._chat_keep()
returns interval
language sql immutable set search_path to 'public'
as $$
  select interval '6 hours';
$$;
revoke all on function public._chat_keep() from public, anon, authenticated;

-- A message members may see: not removed, not older than _chat_keep(), and its author (when a member wrote it) not
-- archived, not asking for deletion and not blacklisted. Staff read hub_chat itself and see every message.
create or replace function public._chat_shown(m public.hub_chat)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select m.removed_at is null
     and m.created_at > now() - _chat_keep()
     and (m.customer_id is null
          or exists (select 1 from customers c
                      where c.id = m.customer_id and c.archived_at is null and c.deletion_requested_at is null
                        and not exists (select 1 from customer_tags b where b.customer_id = c.id and b.tag_id = 'tag_blacklist')));
$$;
revoke all on function public._chat_shown(public.hub_chat) from public, anon, authenticated;


/* -- 2. nothing is deleted ----------------------------------------------------------------------- */
do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'mm-chat-purge') then perform cron.unschedule('mm-chat-purge'); end if;
  end if;
end $cron$;
drop function if exists public._chat_purge();
comment on table public.hub_chat is
  'The club chat (20261120203000, 20261120213000): one row per message in the Community members'' one room. customer_id = the member who wrote it, null = the team (staff_user). Members read it only through chat_read (full name + message, nothing else about a member) and only for 6 hours (_chat_keep); removed_at/removed_by (self, staff, reports) takes a message off their page at once. Staff read every message under _staff_mod(''community''). Nothing is ever deleted from it.';


/* -- 3. the member's reads, inside the six hours -------------------------------------------------- */
create or replace function public.chat_read(p_id text, p_token text, p_after bigint default null, p_before bigint default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_me text[]; v_rows jsonb; v_n integer := 0; v_more boolean := false; v_reset boolean := false;
        v_gone jsonb := '[]'::jsonb; v_agreed boolean; v_until timestamptz; v_min bigint;
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
  return jsonb_build_object('ok', true, 'rows', v_rows, 'reset', v_reset, 'more', v_more, 'gone', v_gone,
    'now', now(), 'keep', extract(epoch from _chat_keep())::integer,
    'me', jsonb_build_object('agreed', coalesce(v_agreed, false),
                             'muted', v_until is not null and v_until > now(),
                             'until', case when v_until is null or v_until = 'infinity' or v_until <= now() then null else v_until end));
end $$;
revoke all on function public.chat_read(text, text, bigint, bigint) from public;
grant execute on function public.chat_read(text, text, bigint, bigint) to anon, authenticated;

create or replace function public.chat_peek(p_id text, p_token text, p_after bigint default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_me text[]; v_n integer; v_min bigint;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_me := _accts_of(p_id);
  select m.id - 50 into v_min from hub_chat m where m.created_at > now() - _chat_keep() order by m.created_at limit 1; -- as chat_read
  if v_min is null then v_min := 9223372036854775807; end if;
  select count(*)::integer into v_n
    from (select 1 from hub_chat m
           where m.id >= v_min and m.id > coalesce(p_after, 0)
             and (m.customer_id is null or not (m.customer_id = any(v_me)))
             and _chat_shown(m)
           limit 100) x;
  return jsonb_build_object('ok', true, 'n', v_n);
end $$;
revoke all on function public.chat_peek(text, text, bigint) from public;
grant execute on function public.chat_peek(text, text, bigint) to anon, authenticated;

create or replace function public.chat_send(p_id text, p_token text, p_body text, p_agree boolean default false)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_body text := _chat_clean(p_body); v_me text[]; v_agreed boolean; v_until timestamptz; r hub_chat%rowtype; prev hub_chat%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if char_length(v_body) not between 1 and 500 then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  v_me := _accts_of(p_id);
  -- one person's sends one at a time, so two taps at once cannot pass the limits together
  perform pg_advisory_xact_lock(hashtext('chat_send:' || p_id));
  select bool_or(cm.agreed_at is not null), max(cm.muted_until) into v_agreed, v_until
    from hub_chat_members cm where cm.customer_id = any(v_me);
  if v_until is not null and v_until > now() then
    return jsonb_build_object('ok', false, 'error', 'muted', 'until', case when v_until = 'infinity' then null else v_until end);
  end if;
  if not coalesce(v_agreed, false) then
    if p_agree is not true then return jsonb_build_object('ok', false, 'error', 'agree'); end if;
    insert into hub_chat_members (customer_id, agreed_at) values (p_id, now())
    on conflict (customer_id) do update set agreed_at = coalesce(hub_chat_members.agreed_at, excluded.agreed_at);
  end if;
  -- their last message, found through hub_chat_customer (the table is never emptied, so never by walking it whole)
  select * into prev from hub_chat m where m.customer_id = any(v_me) order by m.created_at desc, m.id desc limit 1;
  if found then
    -- the same words again within a minute: the answer to the first send was lost, or a second tap; never stored twice
    if prev.body = v_body and prev.removed_at is null and prev.created_at > now() - interval '1 minute' then
      return jsonb_build_object('ok', true, 'row', _chat_row(prev, v_me), 'again', true);
    end if;
    if prev.created_at > now() - interval '1.5 seconds' then return jsonb_build_object('ok', false, 'error', 'fast'); end if;
  end if;
  if (select count(*) from hub_chat m where m.customer_id = any(v_me) and m.created_at > now() - interval '5 minutes') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  insert into hub_chat (customer_id, body) values (p_id, v_body) returning * into r;
  return jsonb_build_object('ok', true, 'row', _chat_row(r, v_me));
end $$;
revoke all on function public.chat_send(text, text, text, boolean) from public;
grant execute on function public.chat_send(text, text, text, boolean) to anon, authenticated;


/* -- 4. checks ----------------------------------------------------------------------------------- */
do $chk$
declare f text;
begin
  foreach f in array array['public._chat_shown(public.hub_chat)', 'public.chat_read(text,text,bigint,bigint)',
                           'public.chat_peek(text,text,bigint)', 'public.chat_send(text,text,text,boolean)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._chat_keep()', 'public._chat_shown(public.hub_chat)'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.chat_read(text,text,bigint,bigint)', 'public.chat_peek(text,text,bigint)',
                           'public.chat_send(text,text,text,boolean)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% is not executable by anon', f; end if;
  end loop;
  if to_regprocedure('public._chat_purge()') is not null then raise exception '_chat_purge is still there'; end if;
  if _chat_keep() <> interval '6 hours' then raise exception '_chat_keep is not 6 hours'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261120213000', 'community_chat_six_hours')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): six hours, the purge and its job gone, the index, the four functions definers, the ledger.
-- select (select public._chat_keep()::text) as keep_6h,
--        to_regprocedure('public._chat_purge()') is null as purge_gone_true,
--        (select count(*) from cron.job where jobname = 'mm-chat-purge') as job_0,
--        (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'hub_chat_created_at') as index_1,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
--          and proname in ('_chat_shown', 'chat_read', 'chat_peek', 'chat_send')) as definer_4,
--        has_function_privilege('anon', 'public.chat_read(text,text,bigint,bigint)', 'execute') as anon_read_true,
--        has_function_privilege('anon', 'public._chat_keep()', 'execute') as anon_keep_false,
--        (select name from supabase_migrations.schema_migrations where version = '20261120213000') as ledger;
