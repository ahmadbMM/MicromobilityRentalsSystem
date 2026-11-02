-- ============================================================================
-- Titles for community members, and members seeing each other (the owner, 2026-11-02).
--
--   titles           the catalogue staff make: English + Arabic name, one of the badge colours,
--                    and auto_rides: given by hand when null, otherwise held automatically from
--                    that many Saturday ride nights. Retired: off the Give list and no longer
--                    automatic, while those it was given to keep it (as a retired badge).
--   customer_titles  who was given which, with an optional last day (Rider of the Month).
--   member_prefs     the member's own choices: which held title others see, and hidden (left off
--                    the members list completely). Written only through customer_title_prefs.
--
-- Until now members never saw each other. member_directory is the one read that names another
-- person, so it answers only a signed-in community member, and only with full name, title, the
-- badges staff gave and a ride count: no id, phone, email, handle, birth date or badge note.
-- Automatic titles are worked out when read, so nothing is stored or goes stale. An account merged
-- into another counts for the keeper, as customer_my_badges does.
-- ============================================================================

begin;

create table if not exists public.titles (
  id         text primary key default ('ttl_' || replace(gen_random_uuid()::text, '-', '')),
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  name_ar    text not null check (char_length(btrim(name_ar)) between 1 and 40),
  color      text not null default 'green'
             check (color in ('green', 'gold', 'blue', 'red', 'purple', 'orange', 'teal', 'silver')),
  auto_rides integer check (auto_rides between 1 and 1000),
  retired    boolean not null default false,
  sort       integer not null default 500,
  created_at timestamptz not null default now()
);

create table if not exists public.customer_titles (
  customer_id text not null references public.customers(id) on delete cascade,
  title_id    text not null references public.titles(id) on delete restrict,
  expires_on  date,
  given_by    text check (char_length(given_by) <= 60),
  given_at    timestamptz not null default now(),
  primary key (customer_id, title_id)
);
create index if not exists customer_titles_title_idx on public.customer_titles (title_id);

create table if not exists public.member_prefs (
  customer_id    text primary key references public.customers(id) on delete cascade,
  shown_title_id text references public.titles(id) on delete set null,
  hidden         boolean not null default false,
  updated_at     timestamptz not null default now()
);

alter table public.titles enable row level security;
alter table public.customer_titles enable row level security;
alter table public.member_prefs enable row level security;

drop policy if exists "staff read" on public.titles;
drop policy if exists "admin insert" on public.titles;
drop policy if exists "admin update" on public.titles;
drop policy if exists "admin delete" on public.titles;
create policy "staff read"   on public.titles for select to authenticated using ((select is_staff()));
create policy "admin insert" on public.titles for insert to authenticated with check ((select is_admin()));
create policy "admin update" on public.titles for update to authenticated using ((select is_admin())) with check ((select is_admin()));
create policy "admin delete" on public.titles for delete to authenticated using ((select is_admin()));

drop policy if exists "staff full" on public.customer_titles;
create policy "staff full" on public.customer_titles for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));

drop policy if exists "staff read" on public.member_prefs;
create policy "staff read" on public.member_prefs for select to authenticated using ((select is_staff()));

revoke all on public.titles, public.customer_titles, public.member_prefs from public, anon;
revoke all on public.member_prefs from authenticated;
grant select, insert, update, delete on public.titles, public.customer_titles to authenticated;
grant select on public.member_prefs to authenticated;

-- An active, listable community member: the tag the members gate reads, not merged away, not asking
-- for deletion, not blacklisted.
create or replace function public._member_active(p_id text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from customer_tags ct
                  where ct.customer_id = p_id and ct.tag_id = 'tag_saturday'
                    and _ctag_active(ct.starts_at, ct.expires_at));
$$;
revoke all on function public._member_active(text) from public, anon, authenticated;

-- The titles held by the accounts of one person (a keeper and those merged into it): given and not
-- past their last day (Riyadh's calendar), or automatic and reached.
create or replace function public._titles_held(p_accts text[], p_saturdays integer)
returns table (id text, name text, name_ar text, color text, auto boolean, expires_on date, sort integer, auto_rides integer)
language sql stable security definer set search_path to 'public'
as $$
  select distinct on (t.id) t.id, t.name, t.name_ar, t.color, false, ct.expires_on, t.sort, t.auto_rides
    from customer_titles ct join titles t on t.id = ct.title_id
   where ct.customer_id = any(p_accts)
     and (ct.expires_on is null or ct.expires_on >= (now() at time zone 'Asia/Riyadh')::date)
   union all
  select t.id, t.name, t.name_ar, t.color, true, null, t.sort, t.auto_rides
    from titles t
   where t.auto_rides is not null and not t.retired and t.auto_rides <= p_saturdays
     and not exists (select 1 from customer_titles ct where ct.title_id = t.id and ct.customer_id = any(p_accts)
                       and (ct.expires_on is null or ct.expires_on >= (now() at time zone 'Asia/Riyadh')::date));
$$;
revoke all on function public._titles_held(text[], integer) from public, anon, authenticated;

-- Saturday nights ridden by these accounts. Nights, not rows: a party is one night.
create or replace function public._saturday_nights(p_accts text[])
returns integer
language sql stable security definer set search_path to 'public'
as $$
  select count(distinct q.session_id)::integer
    from queue_entries q join sessions s on s.id = q.session_id
   where q.customer_id = any(p_accts) and q.status = 'done' and s.ride_kind = 'saturday';
$$;
revoke all on function public._saturday_nights(text[]) from public, anon, authenticated;

-- The member's own titles and choices, for their account page.
create or replace function public.customer_my_titles(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_accts text[]; v_pref member_prefs%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', true, 'member', false); end if;
  select array_agg(c.id) into v_accts from customers c where c.id = p_id or c.merged_into = p_id;
  select * into v_pref from member_prefs where customer_id = p_id;
  return jsonb_build_object('ok', true, 'member', true, 'hidden', coalesce(v_pref.hidden, false), 'shown', v_pref.shown_title_id,
    'titles', coalesce((select jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'name_ar', h.name_ar, 'color', h.color,
                                 'auto', h.auto, 'expires_on', h.expires_on)
                                 order by h.auto, h.sort, h.auto_rides desc nulls last, h.name)
                         from _titles_held(v_accts, _saturday_nights(v_accts)) h), '[]'::jsonb));
end $$;
revoke execute on function public.customer_my_titles(text, text) from public;
grant  execute on function public.customer_my_titles(text, text) to anon, authenticated;

-- Which held title others see (null: the first one held), and whether to stay off the list.
create or replace function public.customer_title_prefs(p_id text, p_token text, p_shown text, p_hidden boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_accts text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  select array_agg(c.id) into v_accts from customers c where c.id = p_id or c.merged_into = p_id;
  if p_shown is not null and not exists (select 1 from _titles_held(v_accts, _saturday_nights(v_accts)) h where h.id = p_shown) then
    return jsonb_build_object('ok', false, 'error', 'title');
  end if;
  insert into member_prefs (customer_id, shown_title_id, hidden, updated_at)
  values (p_id, p_shown, coalesce(p_hidden, false), now())
  on conflict (customer_id) do update
    set shown_title_id = excluded.shown_title_id, hidden = excluded.hidden, updated_at = now();
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.customer_title_prefs(text, text, text, boolean) from public;
grant  execute on function public.customer_title_prefs(text, text, text, boolean) to anon, authenticated;

-- The members list and every member's card, for a signed-in member. Nothing in it identifies an
-- account: no id goes out, so the card is drawn from this same answer.
create or replace function public.member_directory(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  return jsonb_build_object('ok', true, 'members', coalesce((
    with mem as (
      select c.id, btrim(c.name) as name, p.shown_title_id
        from customers c
        join customer_tags ct on ct.customer_id = c.id and ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at)
        left join member_prefs p on p.customer_id = c.id
       where c.merged_into is null and c.deletion_requested_at is null
         and coalesce(p.hidden, false) = false and coalesce(btrim(c.name), '') <> ''
         and not exists (select 1 from customer_tags b where b.customer_id = c.id and b.tag_id = 'tag_blacklist')
    ), acct as (
      select m.id, m.name, m.shown_title_id,
             array_append(coalesce((select array_agg(x.id) from customers x where x.merged_into = m.id), '{}'::text[]), m.id) as accts
        from mem m
    )
    select jsonb_agg(jsonb_build_object(
             'name', a.name, 'me', a.id = p_id,
             'title', (select jsonb_build_object('name', h.name, 'name_ar', h.name_ar, 'color', h.color)
                         from _titles_held(a.accts, _saturday_nights(a.accts)) h
                        order by (h.id = a.shown_title_id) desc nulls last, h.auto, h.sort, h.auto_rides desc nulls last, h.name limit 1),
             'rides', (select count(distinct q.session_id) from queue_entries q where q.customer_id = any(a.accts) and q.status = 'done'),
             'badges', coalesce((select jsonb_agg(jsonb_build_object('slug', b.slug, 'icon', b.icon, 'color', b.color, 'name', b.name,
                                        'name_ar', b.name_ar, 'system', b.system) order by x.at desc)
                                   from (select cb.badge_id, max(cb.awarded_at) as at from customer_badges cb
                                          where cb.customer_id = any(a.accts) group by cb.badge_id) x
                                   join badges b on b.id = x.badge_id), '[]'::jsonb))
             order by lower(a.name))
      from acct a), '[]'::jsonb));
end $$;
revoke execute on function public.member_directory(text, text) from public;
grant  execute on function public.member_directory(text, text) to anon, authenticated;

-- Who holds an automatic title right now, for Community > Titles: staff only.
create or replace function public.staff_title_auto_holders(p_title text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_at integer;
begin
  if not is_staff() then raise exception 'not staff' using errcode = '42501'; end if;
  select auto_rides into v_at from titles where id = p_title and not retired;
  if v_at is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('customer_id', y.keeper, 'nights', y.n) order by y.n desc)
      from (select coalesce(c.merged_into, c.id) as keeper, count(distinct q.session_id) as n
              from queue_entries q join sessions s on s.id = q.session_id join customers c on c.id = q.customer_id
             where q.status = 'done' and s.ride_kind = 'saturday'
             group by 1 having count(distinct q.session_id) >= v_at) y
     where _member_active(y.keeper)), '[]'::jsonb);
end $$;
revoke execute on function public.staff_title_auto_holders(text) from public, anon;
grant  execute on function public.staff_title_auto_holders(text) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261102200000', 'member_titles')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): RLS on all three, every function definer, helpers closed to visitors, the ledger row.
select (select bool_and(relrowsecurity) from pg_class
         where oid in ('public.titles'::regclass, 'public.customer_titles'::regclass, 'public.member_prefs'::regclass)) as rls_on,
       (select bool_and(prosecdef) from pg_proc
         where pronamespace = 'public'::regnamespace
           and proname in ('_member_active', '_titles_held', '_saturday_nights', 'customer_my_titles',
                           'customer_title_prefs', 'member_directory', 'staff_title_auto_holders')) as all_definer,
       has_function_privilege('anon', 'public._titles_held(text[], integer)', 'execute') as helper_open_to_anon,
       has_table_privilege('anon', 'public.member_prefs', 'select') as prefs_open_to_anon,
       (select version from supabase_migrations.schema_migrations where version = '20261102200000') as ledger;
