-- ============================================================================
-- The club chat (2026-11-20; the user: "can we create a live chat in the booking app but only for community members?",
-- then, asked how a member should appear, where the chat lives and what may be sent: "Full name", "One club chat",
-- "Text only"). One room for every active Community member, in the booking app's Community tab.
--
-- The full name is the owner's pick and the second allowed exception to "members see nothing about each other"
-- (2026-11-04; the first is race partners): a chat read gives the author's full name and the message and NOTHING else
-- about a member (no title, badge, photo, mobile or ride). A member agrees to that once, with their first message
-- (hub_chat_members.agreed_at); reading shows nobody the reader.
--
--  1. hub_chat: one row per message. customer_id = the member who wrote it, or null for a message from the team
--     (staff_user then says which staff user). body 1 to 500 characters, text only. removed_at / removed_by
--     (self | staff | reports) / removed_user: a removed message stays for staff and is never sent to a member again.
--     reports = how many members reported it; checked_at = staff looked and kept it (reports no longer hide it).
--     hub_chat_members: one row per member who wrote or was muted: agreed_at (their yes to the full name),
--     muted_until (null = not muted, 'infinity' = until staff lift it), who muted and when.
--     hub_chat_reports: who reported which message, once each.
--     All three: RLS on, staff read under _staff_mod('community'), nobody writes them directly.
--  2. _chat_clean (the text as stored: control and direction-override characters out, three or more line breaks to
--     two, trimmed), _chat_shown (a message members may see: not removed, its author not archived, not asking for
--     deletion, not blacklisted) and _chat_row (a message as a member reads it: id, time, Riyadh's day, body, team,
--     mine, the author's full name, and `k`, the author's opaque ref, so a run of one person's messages is drawn together).
--  3. The member's calls, all token-checked and for active members only (_cust_token_ok, _member_active):
--     chat_read(p_id, p_token, p_after, p_before): the newest 50 (both null), the 50 before an id (p_before), or what
--       came after an id (p_after, with the last 15 seconds' messages just under it again, for an insert committed
--       late; over 100 behind answers the newest 50 with reset). Also `gone` (ids removed in the
--       last two days, on a p_after read), `more` (older ones exist) and `me` {agreed, muted, until}. STABLE.
--     chat_peek(p_id, p_token, p_after): how many messages from others came after an id (the last three days when
--       null), at most 100, for the Community tab's card. STABLE.
--     chat_send(p_id, p_token, p_body, p_agree): errors denied, member, invalid, agree (the first message needs
--       p_agree true), muted (+ until), fast (under 1.5 s after their last), limit (20 in five minutes). The same
--       text again within a minute answers the message already stored, so a retry never doubles it.
--     chat_remove(p_id, p_token, p_msg): their own message, removed for everyone.
--     chat_report(p_id, p_token, p_msg): another member's message, once per person, 20 a day; the third person's
--       report removes it until staff look (removed_by 'reports'), unless staff already kept it.
--  4. Staff (Community editors, _staff_mod('community', true)): staff_chat_send(p_body) writes as the team;
--     staff_chat_set(p_mid, p_removed) removes a message or puts it back (and marks it checked);
--     staff_chat_mute(p_customer, p_days): null lifts, 0 = until lifted, 1 to 365 = that many days.
--  5. The ping: a trigger on hub_chat sends an EMPTY broadcast ('tick' on the public realtime topic 'hub-chat') for
--     a new message and for one removed or put back. It carries no message, no name and no id: an open chat page
--     hears it and asks chat_read, which checks the member. Riders have no Supabase login, so a private topic is not
--     open to them; the topic being public therefore tells a listener only that something happened.
--  6. _chat_purge (pg_cron 'mm-chat-purge', daily): messages older than 12 months are deleted, as the Privacy
--     Notice says.
--
-- No existing function is rebuilt.
--
-- Rollback:
--   select cron.unschedule('mm-chat-purge');
--   drop trigger if exists hub_chat_tick_ins on public.hub_chat; drop trigger if exists hub_chat_tick_upd on public.hub_chat;
--   drop function if exists public.staff_chat_mute(text, integer), public.staff_chat_set(bigint, boolean),
--     public.staff_chat_send(text), public.chat_report(text, text, bigint), public.chat_remove(text, text, bigint),
--     public.chat_send(text, text, text, boolean), public.chat_peek(text, text, bigint),
--     public.chat_read(text, text, bigint, bigint), public._chat_purge(), public._chat_tick(),
--     public._chat_row(public.hub_chat, text[]), public._chat_shown(public.hub_chat), public._chat_clean(text);
--   (the tables are kept: they hold what members wrote; drop them only if the chat is given up for good)
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $need$
begin
  if to_regprocedure('public._member_active(text)') is null or to_regprocedure('public._member_ref(text)') is null
     or to_regprocedure('public._accts_of(text)') is null or to_regprocedure('public._cust_token_ok(text,text)') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'customers' and column_name = 'archived_at') then
    raise exception 'community_chat: apply the member hub (20261103120500) and the account archive (20261111200000) first';
  end if;
end $need$;


/* -- 1. the tables ------------------------------------------------------------------------------- */
create table if not exists public.hub_chat (
  id           bigint generated always as identity primary key,
  customer_id  text references public.customers (id) on update cascade on delete cascade,
  staff_user   uuid,
  body         text not null check (char_length(body) between 1 and 500),
  created_at   timestamptz not null default now(),
  removed_at   timestamptz,
  removed_by   text check (removed_by is null or removed_by in ('self', 'staff', 'reports')),
  removed_user uuid,
  reports      integer not null default 0,
  checked_at   timestamptz,
  constraint hub_chat_author check ((customer_id is null) <> (staff_user is null)),
  constraint hub_chat_removed check ((removed_at is null) = (removed_by is null))
);
comment on table public.hub_chat is
  'The club chat (20261120203000): one row per message in the Community members'' one room. customer_id = the member who wrote it, null = the team (staff_user). removed_at/removed_by (self, staff, reports): never sent to a member again, kept for staff. Members read it only through chat_read (full name + message, nothing else about a member); staff read it under _staff_mod(''community''). Deleted after 12 months (_chat_purge).';
create index if not exists hub_chat_customer on public.hub_chat (customer_id, created_at desc);
create index if not exists hub_chat_removed_at on public.hub_chat (removed_at) where removed_at is not null;
alter table public.hub_chat enable row level security;
revoke all on public.hub_chat from public, anon, authenticated;
grant select on public.hub_chat to authenticated;
drop policy if exists "staff read" on public.hub_chat;
create policy "staff read" on public.hub_chat for select using ((select _staff_mod('community')));

create table if not exists public.hub_chat_members (
  customer_id text primary key references public.customers (id) on update cascade on delete cascade,
  agreed_at   timestamptz,
  muted_until timestamptz,
  muted_at    timestamptz,
  muted_by    uuid
);
comment on table public.hub_chat_members is
  'The club chat (20261120203000): a member who wrote or was muted. agreed_at = their yes to their full name being shown with their messages (asked with the first one). muted_until: null = not muted, infinity = until staff lift it. Staff read; written only by chat_send and staff_chat_mute.';
alter table public.hub_chat_members enable row level security;
revoke all on public.hub_chat_members from public, anon, authenticated;
grant select on public.hub_chat_members to authenticated;
drop policy if exists "staff read" on public.hub_chat_members;
create policy "staff read" on public.hub_chat_members for select using ((select _staff_mod('community')));

create table if not exists public.hub_chat_reports (
  msg_id      bigint not null references public.hub_chat (id) on delete cascade,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (msg_id, customer_id)
);
comment on table public.hub_chat_reports is
  'The club chat (20261120203000): which member reported which message, once each. Staff read; written only by chat_report.';
create index if not exists hub_chat_reports_customer on public.hub_chat_reports (customer_id, created_at desc);
alter table public.hub_chat_reports enable row level security;
revoke all on public.hub_chat_reports from public, anon, authenticated;
grant select on public.hub_chat_reports to authenticated;
drop policy if exists "staff read" on public.hub_chat_reports;
create policy "staff read" on public.hub_chat_reports for select using ((select _staff_mod('community')));


/* -- 2. helpers ---------------------------------------------------------------------------------- */
-- The text as it is stored: no control characters (line breaks stay), no direction overrides or isolates (they can make
-- a line read as something else), Windows line ends as one break, three or more breaks as two, trimmed.
create or replace function public._chat_clean(p text)
returns text
language sql immutable set search_path to 'public'
as $$
  -- every special character is named by its number (chr), so no escape in this text can be misread on its way here:
  -- 1-9 and 11-31 and 127 = control characters (10, the line break, stays); 8234-8238 and 8294-8297 = direction
  -- overrides and isolates; 160 = the no-break space; 13 10 = a Windows line end
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(replace(coalesce(p, ''), chr(13) || chr(10), chr(10)),
                            '[' || chr(1) || '-' || chr(9) || chr(11) || '-' || chr(31) || chr(127)
                                || chr(8234) || '-' || chr(8238) || chr(8294) || '-' || chr(8297) || ']', '', 'g'),
             '[ ' || chr(160) || ']*' || chr(10) || '[ ' || chr(160) || ']*', chr(10), 'g'),
           chr(10) || '{3,}', chr(10) || chr(10), 'g'), ' ' || chr(10) || chr(160));
$$;
revoke all on function public._chat_clean(text) from public, anon, authenticated;

-- A message members may see: not removed, and its author (when a member wrote it) not archived, not asking for
-- deletion and not blacklisted. A member who left the Community keeps their old messages on the page.
create or replace function public._chat_shown(m public.hub_chat)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select m.removed_at is null
     and (m.customer_id is null
          or exists (select 1 from customers c
                      where c.id = m.customer_id and c.archived_at is null and c.deletion_requested_at is null
                        and not exists (select 1 from customer_tags b where b.customer_id = c.id and b.tag_id = 'tag_blacklist')));
$$;
revoke all on function public._chat_shown(public.hub_chat) from public, anon, authenticated;

-- A message as a member reads it. The author's full name and nothing else about them; `k` is their opaque ref
-- (_member_ref), the same for every message of one person, so the page draws a run of them under one name.
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
    'k', case when m.customer_id is null then 'team' else _member_ref(m.customer_id) end);
$$;
revoke all on function public._chat_row(public.hub_chat, text[]) from public, anon, authenticated;


/* -- 3. the member's calls ----------------------------------------------------------------------- */
create or replace function public.chat_read(p_id text, p_token text, p_after bigint default null, p_before bigint default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_me text[]; v_rows jsonb; v_n integer := 0; v_more boolean := false; v_reset boolean := false;
        v_gone jsonb := '[]'::jsonb; v_agreed boolean; v_until timestamptz;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_me := _accts_of(p_id);
  if p_after is not null then
    -- what came since, oldest first; a page more than 100 behind takes the newest page instead
    if (select count(*) from (select 1 from hub_chat m where m.id > p_after and _chat_shown(m) limit 101) x) > 100 then
      v_reset := true;
    else
      -- also the last seconds' messages just under p_after: one whose insert began earlier but was committed after a
      -- later id had been read would otherwise never reach this page (the page drops what it already holds)
      select coalesce(jsonb_agg(_chat_row(m, v_me) order by m.id), '[]'::jsonb) into v_rows
        from hub_chat m
       where (m.id > p_after or (m.id > p_after - 200 and m.created_at > now() - interval '15 seconds')) and _chat_shown(m);
      select coalesce(jsonb_agg(x.id), '[]'::jsonb) into v_gone
        from (select m.id from hub_chat m where m.removed_at > now() - interval '2 days' order by m.id desc limit 200) x;
    end if;
  end if;
  if p_after is null or v_reset then
    select coalesce(jsonb_agg(x.j order by x.id), '[]'::jsonb), count(*)::integer into v_rows, v_n
      from (select m.id, _chat_row(m, v_me) as j
              from hub_chat m
             where (p_before is null or v_reset or m.id < p_before) and _chat_shown(m)
             order by m.id desc limit 50) x;
    v_more := v_n = 50 and exists (select 1 from hub_chat m where m.id < (v_rows -> 0 ->> 'id')::bigint and _chat_shown(m));
  end if;
  select bool_or(cm.agreed_at is not null), max(cm.muted_until) into v_agreed, v_until
    from hub_chat_members cm where cm.customer_id = any(v_me);
  return jsonb_build_object('ok', true, 'rows', v_rows, 'reset', v_reset, 'more', v_more, 'gone', v_gone,
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
declare v_me text[]; v_n integer;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_me := _accts_of(p_id);
  select count(*)::integer into v_n
    from (select 1 from hub_chat m
           where m.id > coalesce(p_after, 0)
             and (p_after is not null or m.created_at > now() - interval '3 days')
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
  select * into prev from hub_chat m where m.customer_id = any(v_me) order by m.id desc limit 1;
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

create or replace function public.chat_remove(p_id text, p_token text, p_msg bigint)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  update hub_chat m set removed_at = now(), removed_by = 'self'
   where m.id = p_msg and m.customer_id = any(_accts_of(p_id)) and m.removed_at is null;
  if not found and not exists (select 1 from hub_chat m where m.id = p_msg and m.customer_id = any(_accts_of(p_id))) then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  return jsonb_build_object('ok', true, 'id', p_msg);
end $$;
revoke all on function public.chat_remove(text, text, bigint) from public;
grant execute on function public.chat_remove(text, text, bigint) to anon, authenticated;

create or replace function public.chat_report(p_id text, p_token text, p_msg bigint)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_me text[]; m hub_chat%rowtype; v_n integer;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_me := _accts_of(p_id);
  perform pg_advisory_xact_lock(hashtext('chat_report:' || p_id));
  select * into m from hub_chat x where x.id = p_msg for update;
  -- only another member's message: never their own, never the team's
  if not found or m.customer_id is null or m.customer_id = any(v_me) then return jsonb_build_object('ok', false, 'error', 'invalid'); end if;
  if m.removed_at is not null then return jsonb_build_object('ok', true, 'id', p_msg); end if; -- already gone
  if exists (select 1 from hub_chat_reports rp where rp.msg_id = p_msg and rp.customer_id = any(v_me)) then
    return jsonb_build_object('ok', true, 'id', p_msg); -- already reported by this person: said once, counted once
  end if;
  if (select count(*) from hub_chat_reports rp where rp.customer_id = any(v_me) and rp.created_at > now() - interval '1 day') >= 20 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  insert into hub_chat_reports (msg_id, customer_id) values (p_msg, p_id) on conflict do nothing;
  select count(*)::integer into v_n from hub_chat_reports rp where rp.msg_id = p_msg;
  update hub_chat x
     set reports = v_n,
         removed_at = case when x.removed_at is null and x.checked_at is null and v_n >= 3 then now() else x.removed_at end,
         removed_by = case when x.removed_at is null and x.checked_at is null and v_n >= 3 then 'reports' else x.removed_by end
   where x.id = p_msg;
  return jsonb_build_object('ok', true, 'id', p_msg);
end $$;
revoke all on function public.chat_report(text, text, bigint) from public;
grant execute on function public.chat_report(text, text, bigint) to anon, authenticated;


/* -- 4. staff ------------------------------------------------------------------------------------ */
create or replace function public.staff_chat_send(p_body text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_body text := _chat_clean(p_body); r hub_chat%rowtype;
begin
  if (select _staff_mod('community', true)) is not true then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if char_length(v_body) not between 1 and 500 then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  insert into hub_chat (staff_user, body) values (auth.uid(), v_body) returning * into r;
  return to_jsonb(r);
end $$;
revoke all on function public.staff_chat_send(text) from public, anon;
grant execute on function public.staff_chat_send(text) to authenticated;

create or replace function public.staff_chat_set(p_mid bigint, p_removed boolean)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r hub_chat%rowtype;
begin
  if (select _staff_mod('community', true)) is not true then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_removed is null then raise exception 'BAD_INPUT' using errcode = '22023'; end if;
  update hub_chat m
     set removed_at = case when p_removed then coalesce(m.removed_at, now()) else null end,
         removed_by = case when p_removed then 'staff' else null end,
         removed_user = case when p_removed then auth.uid() else null end,
         checked_at = now()
   where m.id = p_mid
  returning * into r;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return to_jsonb(r);
end $$;
revoke all on function public.staff_chat_set(bigint, boolean) from public, anon;
grant execute on function public.staff_chat_set(bigint, boolean) to authenticated;

create or replace function public.staff_chat_mute(p_customer text, p_days integer default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r hub_chat_members%rowtype;
        v_until timestamptz := case when p_days is null then null when p_days = 0 then 'infinity'::timestamptz
                                    else now() + make_interval(days => p_days) end;
begin
  if (select _staff_mod('community', true)) is not true then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if p_customer is null or (p_days is not null and p_days not between 0 and 365)
     or not exists (select 1 from customers c where c.id = p_customer) then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  insert into hub_chat_members (customer_id, muted_until, muted_at, muted_by)
  values (p_customer, v_until, case when v_until is null then null else now() end, case when v_until is null then null else auth.uid() end)
  on conflict (customer_id) do update
    set muted_until = excluded.muted_until, muted_at = excluded.muted_at, muted_by = excluded.muted_by
  returning * into r;
  return jsonb_build_object('customer_id', r.customer_id, 'agreed_at', r.agreed_at, 'muted_at', r.muted_at,
                            'muted_until', case when r.muted_until = 'infinity' then to_jsonb('infinity'::text) else to_jsonb(r.muted_until) end);
end $$;
revoke all on function public.staff_chat_mute(text, integer) from public, anon;
grant execute on function public.staff_chat_mute(text, integer) to authenticated;


/* -- 5. the ping --------------------------------------------------------------------------------- */
-- An empty broadcast on the PUBLIC topic 'hub-chat': it says only that something changed. The page that hears it asks
-- chat_read, which checks the member. A send that fails (no realtime schema on a test database) is never the message's.
create or replace function public._chat_tick()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  begin
    perform realtime.send('{}'::jsonb, 'tick', 'hub-chat', false);
  exception when others then
    null;
  end;
  return null;
end $$;
revoke all on function public._chat_tick() from public, anon, authenticated;
drop trigger if exists hub_chat_tick_ins on public.hub_chat;
create trigger hub_chat_tick_ins after insert on public.hub_chat
  for each row execute function public._chat_tick();
drop trigger if exists hub_chat_tick_upd on public.hub_chat;
create trigger hub_chat_tick_upd after update of removed_at on public.hub_chat
  for each row when (old.removed_at is distinct from new.removed_at) execute function public._chat_tick();


/* -- 6. kept for 12 months ----------------------------------------------------------------------- */
create or replace function public._chat_purge()
returns integer
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_n integer;
begin
  delete from hub_chat m where m.created_at < now() - interval '12 months';
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public._chat_purge() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'mm-chat-purge') then perform cron.unschedule('mm-chat-purge'); end if;
    perform cron.schedule('mm-chat-purge', '37 1 * * *', 'select public._chat_purge()');
  end if;
end $cron$;


/* -- 7. checks ----------------------------------------------------------------------------------- */
do $chk$
declare f text; tb text;
begin
  foreach f in array array['public._chat_shown(public.hub_chat)', 'public._chat_row(public.hub_chat,text[])',
                           'public.chat_read(text,text,bigint,bigint)', 'public.chat_peek(text,text,bigint)',
                           'public.chat_send(text,text,text,boolean)', 'public.chat_remove(text,text,bigint)',
                           'public.chat_report(text,text,bigint)', 'public.staff_chat_send(text)',
                           'public.staff_chat_set(bigint,boolean)', 'public.staff_chat_mute(text,integer)',
                           'public._chat_tick()', 'public._chat_purge()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  foreach f in array array['public._chat_clean(text)', 'public._chat_shown(public.hub_chat)', 'public._chat_row(public.hub_chat,text[])',
                           'public._chat_tick()', 'public._chat_purge()'] loop
    if has_function_privilege('anon', f, 'execute') or has_function_privilege('authenticated', f, 'execute') then
      raise exception '% is executable by a client', f;
    end if;
  end loop;
  foreach f in array array['public.staff_chat_send(text)', 'public.staff_chat_set(bigint,boolean)', 'public.staff_chat_mute(text,integer)'] loop
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  foreach f in array array['public.chat_read(text,text,bigint,bigint)', 'public.chat_peek(text,text,bigint)',
                           'public.chat_send(text,text,text,boolean)', 'public.chat_remove(text,text,bigint)',
                           'public.chat_report(text,text,bigint)'] loop
    if not has_function_privilege('anon', f, 'execute') then raise exception '% is not executable by anon', f; end if;
  end loop;
  foreach tb in array array['public.hub_chat', 'public.hub_chat_members', 'public.hub_chat_reports'] loop
    if not (select relrowsecurity from pg_class where oid = tb::regclass) then raise exception '% has no RLS', tb; end if;
    if has_table_privilege('anon', tb, 'select') or has_table_privilege('authenticated', tb, 'insert')
       or has_table_privilege('authenticated', tb, 'update') or has_table_privilege('authenticated', tb, 'delete') then
      raise exception '% is writable by a client, or readable by anon', tb;
    end if;
  end loop;
  if _chat_clean('  hi' || chr(13) || chr(10) || chr(13) || chr(10) || chr(13) || chr(10) || chr(10) || 'there ' || chr(8238) || chr(160) || ' ')
     <> 'hi' || chr(10) || chr(10) || 'there' then raise exception '_chat_clean does not clean'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261120203000', 'community_chat')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): the three tables with RLS and one policy each, the functions definers, the two triggers, the job, the ledger.
-- select (select count(*) from pg_class where oid in ('public.hub_chat'::regclass, 'public.hub_chat_members'::regclass, 'public.hub_chat_reports'::regclass) and relrowsecurity) as rls_3,
--        (select count(*) from pg_policies where schemaname = 'public' and tablename in ('hub_chat', 'hub_chat_members', 'hub_chat_reports')) as policies_3,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
--          and proname in ('_chat_shown', '_chat_row', 'chat_read', 'chat_peek', 'chat_send', 'chat_remove', 'chat_report',
--                          'staff_chat_send', 'staff_chat_set', 'staff_chat_mute', '_chat_tick', '_chat_purge')) as definer_12,
--        has_function_privilege('anon', 'public.chat_send(text,text,text,boolean)', 'execute') as anon_send_true,
--        has_function_privilege('anon', 'public.staff_chat_send(text)', 'execute') as anon_staff_false,
--        has_function_privilege('anon', 'public._chat_row(public.hub_chat,text[])', 'execute') as anon_row_false,
--        has_table_privilege('anon', 'public.hub_chat', 'select') as anon_table_false,
--        (select count(*) from pg_trigger where tgname in ('hub_chat_tick_ins', 'hub_chat_tick_upd')) as triggers_2,
--        (select count(*) from cron.job where jobname = 'mm-chat-purge') as job_1,
--        (select name from supabase_migrations.schema_migrations where version = '20261120203000') as ledger;
