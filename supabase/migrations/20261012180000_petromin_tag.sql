-- ============================================================================
-- The Petromin tag and Petromin Days (the owner, 2026-10-12: "add a new petromin tag that gives its
-- holders access only to petromin sessions through a new event card that has the name Petromin Days
-- that only is visible for petromin tag holders").
--
-- Owner's answers: Community members keep finding the Petromin nights inside MicroMobility
-- Experiences as today; a Petromin tag holder books them through the Petromin Days card and nothing
-- else members-only. "when giving a petromin tag to a community member show an error that asks that
-- only one of them must be given per account and vice versa": an account holds one of the two.
--
-- 1. tags: tag_petromin (slug petromin, locked).
-- 2. _petromin_holder(customer): the tag in force. Server-only.
-- 3. petromin_member(id, token): the app's answer for the card, as community_member answers the
--    members gate (a bare boolean, so the tag system stays invisible to customers).
-- 4. _community_booking_gate: a Petromin tag holder passes on a Petromin night (ride_kind 'petromin');
--    every other members-only ride still needs the Community tag.
-- 5. customer_booking_update: the same allowance where a rider re-books a booking they cancelled
--    (patched in place from its live definition, by one anchor).
-- 6. _tag_one_of_two: customer_tags refuses the Community tag on an account that holds the Petromin
--    tag (in force or still to start), and the other way round: TAG_EXCLUSIVE.
--
-- Undo:
--   drop trigger if exists customer_tags_one_of_two on public.customer_tags;
--   drop function if exists public._tag_one_of_two();
--   (gate: re-run _community_booking_gate from 20260819120000's successor without the petromin clause)
--   delete from public.customer_tags where tag_id = 'tag_petromin'; delete from public.tags where id = 'tag_petromin';
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 1. the tag ────────────────────────────────────────────────────────────────────────────────
insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_petromin', 'petromin', 'Petromin', '#d6202a',
        'Books the Petromin nights through the Petromin Days card, and no other members-only ride. Never on an account with the Community tag.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do nothing;


-- ── 2. who holds it ───────────────────────────────────────────────────────────────────────────
create or replace function public._petromin_holder(p_customer text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select p_customer is not null and exists (
    select 1 from customer_tags ct
     where ct.customer_id = p_customer and ct.tag_id = 'tag_petromin'
       and _ctag_active(ct.starts_at, ct.expires_at));
$$;
revoke execute on function public._petromin_holder(text) from public, anon, authenticated;


-- ── 3. the app's answer ───────────────────────────────────────────────────────────────────────
create or replace function public.petromin_member(p_id text, p_token text)
returns boolean
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then
    return false;
  end if;
  return _petromin_holder(p_id);
end $$;
revoke execute on function public.petromin_member(text, text) from public;
grant  execute on function public.petromin_member(text, text) to anon, authenticated;


-- ── 4. the members gate on a booking ─────────────────────────────────────────────────────────
create or replace function public._community_booking_gate()
returns trigger
language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare s sessions%rowtype;
begin
  select * into s from sessions where id = new.session_id;
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
     -- a Petromin tag holder rides the Petromin nights (20261012180000)
     and not (coalesce(s.ride_kind, '') = 'petromin' and _petromin_holder(new.customer_id))
  then
    raise exception 'This ride is for community members only.' using detail = 'MEMBERS_ONLY';
  end if;
  return new;
end $function$;
revoke execute on function public._community_booking_gate() from public, anon, authenticated;


-- ── 5. re-booking a cancelled booking ─────────────────────────────────────────────────────────
do $cbu$
declare d text;
begin
  d := pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure);
  if position('(20261012180000)' in d) > 0 then
    raise notice 'customer_booking_update already lets a Petromin tag holder back on; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$      if not coalesce(_at.open_to_all,false) and not exists ($a$,
$b$      if not coalesce(_at.open_to_all,false)
         and not (coalesce(_at.ride_kind,'') = 'petromin' and _petromin_holder(p_id))   -- (20261012180000)
         and not exists ($b$);
  execute d;
end $cbu$;


-- ── 6. one of the two tags per account ───────────────────────────────────────────────────────
-- A grant counts while its window has not closed: in force, or dated to start later. A lapsed one
-- does not stand in the way (it stays on file, the chip reads "expired").
create or replace function public._tag_one_of_two()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare other text;
begin
  if new.tag_id not in ('tag_saturday', 'tag_petromin') then return new; end if;
  if new.expires_at is not null and new.expires_at <= (extract(epoch from now()) * 1000)::bigint then return new; end if;
  other := case new.tag_id when 'tag_saturday' then 'tag_petromin' else 'tag_saturday' end;
  if exists (select 1 from customer_tags ct
              where ct.customer_id = new.customer_id and ct.tag_id = other
                and (ct.expires_at is null or ct.expires_at > (extract(epoch from now()) * 1000)::bigint)) then
    raise exception 'An account holds the Community tag or the Petromin tag, never both.'
      using errcode = 'P0001', detail = 'TAG_EXCLUSIVE';
  end if;
  return new;
end $$;
revoke execute on function public._tag_one_of_two() from public, anon, authenticated;

drop trigger if exists customer_tags_one_of_two on public.customer_tags;
create trigger customer_tags_one_of_two
  before insert or update of tag_id, customer_id, expires_at on public.customer_tags
  for each row execute function public._tag_one_of_two();


-- ── checks ───────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['_petromin_holder','petromin_member','_community_booking_gate','customer_booking_update','_tag_one_of_two'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if position('(20261012180000)' in pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure)) = 0 then
    raise exception 'the customer_booking_update patch did not take';
  end if;
  if not has_function_privilege('anon', 'public.petromin_member(text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_booking_update(text,text,text,jsonb)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public._petromin_holder(text)', 'execute')
     or has_function_privilege('authenticated', 'public._petromin_holder(text)', 'execute') then
    raise exception '_petromin_holder is executable by a client';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'customer_tags_one_of_two'
                   and tgrelid = 'public.customer_tags'::regclass and not tgisinternal) then
    raise exception 'customer_tags_one_of_two is missing';
  end if;
  if not exists (select 1 from public.tags where id = 'tag_petromin' and slug = 'petromin' and locked) then
    raise exception 'tag_petromin is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261012180000', 'petromin_tag')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
