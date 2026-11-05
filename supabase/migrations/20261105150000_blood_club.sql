-- ============================================================================
-- Which club or community a Blood Donation registrant is from (the owner, 2026-11-05: "add a text field question in the
-- registration to ask from which club/community is the donor/visitor, and add a button i dont have one and show a
-- forced pop-up for everyone who already registered").
--
--  1. queue_entries.blood_club: the name they typed; '' = they said they have none; null = not answered yet, which is
--     what the forced pop-up asks (everyone who registered before the question, and a page without it).
--  2. customer_create_booking stores it, on this event alone.
--  3. customer_set_blood_club(p_id, p_token, p_session_id, p_club): the pop-up's answer, on the rider's own live booking
--     of a session not over yet. Answers how many rows changed, -1 for a stale token. A blank p_club means none.
--
-- Safe before the app, and touches no existing booking: nothing reads the column yet and null is the state they are all
-- already in. Seen only by the rider and staff; volunteers are not given it.
--
-- Rollback:
--   drop function if exists public.customer_set_blood_club(text, text, text, text);
--   then run the patch below backwards;
--   alter table public.queue_entries drop column if exists blood_club;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if position(b in def) > 0 then return def; end if;
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

alter table public.queue_entries add column if not exists blood_club text;
comment on column public.queue_entries.blood_club is
  'Blood Donation event: the club or community they are from; empty = they have none; null = not answered yet (20261105150000).';

do $do$
declare v text;
begin
  select pg_get_functiondef('public.customer_create_booking'::regproc) into v;
  v := pg_temp._once(v,
    $a$blood_role,                                     -- the Blood Donation event: donor or visitor (20261105140000)$a$,
    $b$blood_role,                                     -- the Blood Donation event: donor or visitor (20261105140000)
      blood_club,                                     -- and their club or community: '' = none, null = not asked (20261105150000)$b$);
  v := pg_temp._once(v,
    $a$case when coalesce(s.ride_kind, '') = 'blood' and it->>'blood_role' in ('donor', 'visitor') then it->>'blood_role' end,$a$,
    $b$case when coalesce(s.ride_kind, '') = 'blood' and it->>'blood_role' in ('donor', 'visitor') then it->>'blood_role' end,
      case when coalesce(s.ride_kind, '') = 'blood' and it->>'blood_club' is not null
           then left(btrim(regexp_replace(it->>'blood_club', '\s+', ' ', 'g')), 80) end,$b$);
  execute v;
end $do$;

create or replace function public.customer_set_blood_club(p_id text, p_token text, p_session_id text, p_club text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare _n int;
begin
  if not _cust_token_ok(p_id, p_token) then return -1; end if;
  update queue_entries x
     set blood_club = left(btrim(regexp_replace(coalesce(p_club, ''), '\s+', ' ', 'g')), 80)
    from sessions s
   where s.id = x.session_id
     and coalesce(s.ride_kind, '') = 'blood'
     and x.customer_id = p_id
     and x.session_id = p_session_id
     and coalesce(x.status, '') not in ('cancelled', 'removed', 'noshow')
     and coalesce(x.session_date, '') >= to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  get diagnostics _n = row_count;
  return _n;
end $function$;
revoke all on function public.customer_set_blood_club(text, text, text, text) from public;
grant execute on function public.customer_set_blood_club(text, text, text, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261105150000', 'blood_club')
on conflict (version) do nothing;

commit;
