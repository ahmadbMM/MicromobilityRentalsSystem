-- A members' waitlist on a ride with partner places (the owner, 2026-10-18: "make 15 waitlist for the next saturday
-- social ride but only for community members, defe have only 80 with no waitlist"; then: members with their own bike
-- still get in past the limit, the six already past it keep their places, staff move riders up by hand).
--
--  1. sessions.member_wl: how many members may wait for our bikes once the members limit (member_cap) is reached;
--     null = no waitlist (past the limit our bikes are simply taken, as before).
--  2. _community_booking_gate: a member's booking on our bikes past member_cap lands on the waitlist while it holds
--     fewer than member_wl members; then MEMBER_BIKES_FULL as before. The limit now counts the members' places only
--     (a waitlisted member holds none). Own bikes are never limited. A partner's booking (Defe) never waits.
--  3. member_bikes_open: our bikes stay open while there is a place or room on the waitlist;
--     member_bikes_state: 'open' | 'waitlist' | 'full', for the booking app's notice.
--  4. The Saturday ride with Defe, 2026-10-24: member_wl 15.
--
-- Undo: alter table public.sessions drop column member_wl; drop function public.member_bikes_state(text);
--       and _community_booking_gate / member_bikes_open as 20261017120000 has them.

begin;

alter table public.sessions add column if not exists member_wl integer;
alter table public.sessions drop constraint if exists sessions_member_wl_range;
alter table public.sessions add constraint sessions_member_wl_range check (member_wl is null or member_wl between 0 and 10000);
comment on column public.sessions.member_wl is
  'Members'' waitlist for our bikes once member_cap is reached; null = none (20261018140000).';

create or replace function public._community_booking_gate()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype; pb text[]; _live int; _wl int;
begin
  select * into s from sessions where id = new.session_id;
  pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
  if tg_op = 'INSERT' and cardinality(pb) = 3 and pb[1] = new.session_id then
    new.partner := pb[2];
    new.partner_code := (pb[3] = '1');
    new.approval := 'approved';
    if new.status = 'waitlist' then new.status := 'waiting'; end if;
    return new;
  end if;
  if s.id is not null
     and s.event_kind = 'community'
     and coalesce(s.open_to_all, false) = false
     and not is_staff()
     and (new.customer_id is null or not exists (
            select 1
              from customer_tags ct
              join tags tg on tg.id = ct.tag_id
             where ct.customer_id = new.customer_id
               and lower(tg.slug) = 'saturday'
               and _ctag_active(ct.starts_at, ct.expires_at)))
     and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(new.customer_id))
     and not (coalesce(s.ride_kind, '') = 'vlap' and _vlap_holder(new.customer_id))
  then
    raise exception 'This ride is for community members only.' using detail = 'MEMBERS_ONLY';
  end if;
  -- The members limit (20261017120000) and its waitlist (20261018140000). Own bikes are never limited.
  if s.id is not null and s.member_cap is not null and new.partner is null
     and coalesce(new.type_preference, '') <> 'Own'
     and coalesce(new.status, '') not in ('cancelled', 'removed', 'noshow') then
    perform pg_advisory_xact_lock(hashtext('membercap:' || s.id));
    if coalesce(new.status, '') <> 'waitlist' then
      select count(*) into _live from queue_entries q
       where q.session_id = s.id and q.partner is null and q.id <> new.id
         and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow', 'waitlist');
      if _live < s.member_cap then
        return new;
      end if;
    end if;
    -- Past the limit (or a booking sent as waitlist): the members' waitlist while it has room.
    if tg_op = 'INSERT' and s.member_wl is not null then
      select count(*) into _wl from queue_entries q
       where q.session_id = s.id and q.partner is null and q.id <> new.id and q.status = 'waitlist';
      if _wl < s.member_wl then
        new.status := 'waitlist';
        return new;
      end if;
      raise exception 'Our bikes are taken for this ride. You can still join with your own bike.'
        using detail = 'MEMBER_BIKES_FULL';
    end if;
    if coalesce(new.status, '') <> 'waitlist' then
      raise exception 'Our bikes are taken for this ride. You can still join with your own bike.'
        using detail = 'MEMBER_BIKES_FULL';
    end if;
  end if;
  return new;
end $function$;

create or replace function public.member_bikes_state(p_session_id text)
 returns text
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select coalesce((
    select case
      when s.member_cap is null then 'open'
      when (select count(*) from queue_entries q
             where q.session_id = s.id and q.partner is null
               and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow', 'waitlist')) < s.member_cap then 'open'
      when s.member_wl is not null
       and (select count(*) from queue_entries q
             where q.session_id = s.id and q.partner is null and q.status = 'waitlist') < s.member_wl then 'waitlist'
      else 'full' end
      from sessions s where s.id = p_session_id), 'open')
$function$;
revoke all on function public.member_bikes_state(text) from public;
grant execute on function public.member_bikes_state(text) to anon, authenticated;

create or replace function public.member_bikes_open(p_session_id text)
 returns boolean
 language sql
 stable
 security definer
 set search_path to 'public'
as $function$
  select public.member_bikes_state(p_session_id) <> 'full'
$function$;
revoke all on function public.member_bikes_open(text) from public;
grant execute on function public.member_bikes_open(text) to anon, authenticated;

update public.sessions set member_wl = 15 where id = '2026-10-24';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261018140000', 'member_waitlist')
on conflict (version) do nothing;

commit;

-- Check: the ride's limits, what a member sees now, and the gate still a definer with its search_path.
select s.member_cap, s.member_wl, public.member_bikes_state(s.id) as state,
       (select prosecdef from pg_proc where oid = 'public._community_booking_gate()'::regprocedure) as gate_definer,
       (select proconfig from pg_proc where oid = 'public._community_booking_gate()'::regprocedure) as gate_settings
  from public.sessions s where s.id = '2026-10-24';
