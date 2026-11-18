-- ============================================================================
-- 20261118221000_found_items
--
-- Lost and found for any item (the user, 2026-11-18, item 10 of the staff Bookings round: "Lost and found for any item.
-- The Lockers section already keeps a left-behind list (kept until, WhatsApp, donated). This opens it to anything found
-- at a night, linked to a booking when known.").
--
--   public.found_items   One record per thing found at a night (a session): what it is (required), where it was found,
--                        a note, a photo (a small picture as a data: URL, the same rule as locker_items, read only when
--                        one is opened), whose it is when known (a booking of that night, or an account), the state
--                        (kept / collected / disposed, as locker_items) and the date it is kept until.
--                        The database fills, whatever the page sends:
--                        - the owner's account and name from the booking (as booking_incidents copies them), or the name
--                          from the account when only an account is linked; a booking always on the item's own night;
--                        - keep_until, when the page sends none: 14 days after the night (locker_items' rule,
--                          _lk_items_fill), else 14 days after today;
--                        - who added it and when, who changed it last and when (_lk_who, as _lk_items_fill does).
--                        Staff read (is_staff()); staff who may change Bookings (_staff_mod('queue', true), which the
--                        Lockers section's editors are too: 'lockers' reads as 'queue') add and change; admins delete. No
--                        anon grant at all. The Door role has no section to change, so it writes nothing here.
--                        Every change is broadcast on the private topic staff-ref (event found_items, the row without
--                        its photo, has_photo in its place), which realtime.messages opens to is_staff() only
--                        (20260921160000), so another desk's list follows without a read. Copied from
--                        _session_notes_broadcast (20261111180300).
--
-- locker_items (20261109233000) is left as it is: one record per locker rental. The staff page lists both together.
-- No foreign key on session or booking: a session moves by insert and delete (staff_move_session), which would take the
-- rows with it (as session_notes and booking_incidents).
--
-- Safe before or after the app: until this is applied, Lost and found and Record found item say "Waiting for the
-- database update", and Lockers > Items lists the locker items alone.
--
-- Rollback: drop table if exists public.found_items; drop function if exists public._found_items_fill();
--           drop function if exists public._found_items_broadcast();
-- Idempotent: safe to re-run. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create table if not exists public.found_items (
  id           uuid primary key default gen_random_uuid(),
  session_id   text not null check (length(session_id) between 1 and 80),
  booking_id   text check (booking_id is null or length(booking_id) between 1 and 80),
  customer_id  text check (customer_id is null or length(customer_id) between 1 and 80),
  name         text check (name is null or length(name) <= 120),
  what         text not null check (length(btrim(what)) between 1 and 200),
  place        text not null default '' check (length(place) <= 120),
  note         text not null default '' check (length(note) <= 500),
  photo        text check (photo is null or (length(photo) <= 1500000 and photo ~ '^data:image/(jpeg|png|webp);base64,')),
  state        text not null default 'kept' check (state in ('kept', 'collected', 'disposed')),
  keep_until   date,
  created_at   timestamptz not null default now(),
  created_by   text check (created_by is null or length(created_by) <= 60),
  updated_at   timestamptz not null default now(),
  updated_by   text check (updated_by is null or length(updated_by) <= 60)
);
create index if not exists found_items_session on public.found_items (session_id, created_at);
create index if not exists found_items_kept on public.found_items (keep_until) where state = 'kept';
create index if not exists found_items_customer on public.found_items (customer_id) where customer_id is not null;
create index if not exists found_items_booking on public.found_items (booking_id) where booking_id is not null;
comment on table public.found_items is 'Lost and found: anything found at a night (20261118221000); staff only, never shown to customers';

alter table public.found_items enable row level security;

drop policy if exists "found items staff read" on public.found_items;
create policy "found items staff read" on public.found_items for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "found items queue insert" on public.found_items;
create policy "found items queue insert" on public.found_items for insert to authenticated
  with check ((select public._staff_mod('queue', true)));
drop policy if exists "found items queue update" on public.found_items;
create policy "found items queue update" on public.found_items for update to authenticated
  using ((select public._staff_mod('queue', true)))
  with check ((select public._staff_mod('queue', true)));
drop policy if exists "found items admin delete" on public.found_items;
create policy "found items admin delete" on public.found_items for delete to authenticated
  using ((select public.is_admin()));

revoke all on public.found_items from anon, authenticated;
grant select, insert, update, delete on public.found_items to authenticated;

-- The owner from the booking or the account, the date it is kept until, who and when: the database's.
create or replace function public._found_items_fill()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare q record; v_day date;
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.session_id := old.session_id;          -- found at a night: that does not change
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.keep_until := coalesce(new.keep_until, old.keep_until);
  end if;
  if new.booking_id is not null then
    if tg_op = 'INSERT' or new.booking_id is distinct from old.booking_id then
      select e.session_id, e.customer_id, e.name into q from queue_entries e where e.id = new.booking_id;
      if not found then
        raise exception 'That booking is no longer there.' using errcode = 'P0001';
      end if;
      if tg_op = 'INSERT' then
        new.session_id := q.session_id;
      elsif q.session_id is distinct from new.session_id then
        raise exception 'That booking is on another session.' using errcode = 'P0001';
      end if;
      new.customer_id := q.customer_id;
      new.name := left(nullif(btrim(coalesce(q.name, '')), ''), 120);
    else
      new.customer_id := old.customer_id;       -- the booking's, as copied
      new.name := old.name;
    end if;
  elsif new.customer_id is not null then
    if tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id or old.booking_id is not null then
      select c.name into q from customers c where c.id = new.customer_id;
      if not found then
        raise exception 'That account is no longer there.' using errcode = 'P0001';
      end if;
      new.name := left(nullif(btrim(coalesce(q.name, '')), ''), 120);
    else
      new.name := old.name;
    end if;
  else
    new.name := left(nullif(btrim(coalesce(new.name, '')), ''), 120);
  end if;
  new.what := btrim(new.what);
  new.place := btrim(coalesce(new.place, ''));
  new.note := btrim(coalesce(new.note, ''));
  if tg_op = 'INSERT' then
    select case when s.session_date::text ~ '^\d{4}-\d{2}-\d{2}' then left(s.session_date::text, 10)::date end
      into v_day from sessions s where s.id = new.session_id;
    new.keep_until := coalesce(new.keep_until, coalesce(v_day, (now() at time zone 'Asia/Riyadh')::date) + 14);
    new.state := coalesce(new.state, 'kept');
    new.created_at := now();
    new.created_by := _lk_who();
  end if;
  if new.keep_until > (now() at time zone 'Asia/Riyadh')::date + 366 then
    raise exception 'Keep until can be at most a year away.' using errcode = 'P0001';
  end if;
  new.updated_at := now();
  new.updated_by := _lk_who();
  return new;
end $function$;
revoke all on function public._found_items_fill() from public, anon, authenticated;
drop trigger if exists found_items_fill on public.found_items;
create trigger found_items_fill before insert or update on public.found_items
  for each row execute function public._found_items_fill();

-- The other desks hear of it on staff-ref; the photo stays out of the message (up to 1.5 MB), has_photo says there is one.
-- A change is never refused because its broadcast failed.
create or replace function public._found_items_broadcast()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r jsonb; o jsonb;
begin
  if tg_op <> 'DELETE' then r := (to_jsonb(new) - 'photo') || jsonb_build_object('has_photo', new.photo is not null); end if;
  if tg_op <> 'INSERT' then o := jsonb_build_object('id', old.id, 'session_id', old.session_id); end if;
  begin
    perform realtime.send(jsonb_build_object('op', tg_op, 'row', r, 'old', o), 'found_items', 'staff-ref', true);
  exception when others then
    null;
  end;
  return null;
end $function$;
revoke all on function public._found_items_broadcast() from public, anon, authenticated;
drop trigger if exists found_items_broadcast on public.found_items;
create trigger found_items_broadcast after insert or update or delete on public.found_items
  for each row execute function public._found_items_broadcast();

-- ── Checks ───────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public._found_items_fill()', 'public._found_items_broadcast()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.found_items'::regclass) then
    raise exception 'row level security is off on found_items';
  end if;
  if has_table_privilege('anon', 'public.found_items', 'select') or has_table_privilege('anon', 'public.found_items', 'insert') then
    raise exception 'anon can reach found_items';
  end if;
  foreach f in array array['public.is_staff()', 'public.is_admin()', 'public._staff_mod(text,boolean)', 'public._lk_who()'] loop
    if to_regprocedure(f) is null then raise exception '% is missing', f; end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118221000', 'found_items')
on conflict (version) do nothing;

commit;

-- check: select count(*) as policies, bool_and(c.relrowsecurity) as rls from pg_policies p join pg_class c on c.oid = 'public.found_items'::regclass where p.tablename = 'found_items';
--        (4 policies, rls true) and: select version from supabase_migrations.schema_migrations where version = '20261118221000';
