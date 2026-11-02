-- ============================================================================
-- The Community page's activities (the owner, 2026-11-03): kudos, Rider of the Month, challenges and
-- the community goal, squads, the photo wall, the new member welcome and the year in review.
--
-- Every member read and write is a token-checked function that answers community members only.
-- No account id goes out: another member is named by `ref`, an opaque code the database works out
-- with a secret visitors cannot read, so a ref cannot be turned into an account by anyone else.
-- Hidden members (member_prefs.hidden) cannot be picked for kudos or the vote.
-- Photos stay in the database, not the public 'photos' bucket: anyone with a bucket link could open one,
-- and these show people and are for members only. They are small (the page sends at most about
-- 200 KB of text), read one at a time, and a rejected photo's picture is deleted.
-- ============================================================================

begin;

create table if not exists public.hub_secret (
  id     integer primary key default 1 check (id = 1),
  secret text not null default replace(gen_random_uuid()::text, '-', '')
);
insert into public.hub_secret (id) values (1) on conflict (id) do nothing;

create table if not exists public.member_kudos (
  from_id    text not null references public.customers(id) on delete cascade,
  to_id      text not null references public.customers(id) on delete cascade,
  session_id text not null,
  created_at timestamptz not null default now(),
  primary key (from_id, to_id, session_id),
  check (from_id <> to_id)
);
create index if not exists member_kudos_to_idx on public.member_kudos (to_id);

create table if not exists public.rotm_rounds (
  id          text primary key default ('rotm_' || replace(gen_random_uuid()::text, '-', '')),
  label       text not null check (char_length(btrim(label)) between 1 and 40),
  label_ar    text not null check (char_length(btrim(label_ar)) between 1 and 40),
  opens_on    date not null,
  closes_on   date not null,
  title_id    text references public.titles(id) on delete set null,
  winner_id   text references public.customers(id) on delete set null,
  winner_name text check (char_length(winner_name) <= 120),
  created_at  timestamptz not null default now(),
  check (closes_on >= opens_on)
);

create table if not exists public.rotm_votes (
  round_id   text not null references public.rotm_rounds(id) on delete cascade,
  voter_id   text not null references public.customers(id) on delete cascade,
  choice_id  text not null references public.customers(id) on delete cascade,
  voted_at   timestamptz not null default now(),
  primary key (round_id, voter_id),
  check (voter_id <> choice_id)
);

create table if not exists public.hub_goals (
  id        text primary key default ('goal_' || replace(gen_random_uuid()::text, '-', '')),
  kind      text not null check (kind in ('challenge', 'goal')),
  name      text not null check (char_length(btrim(name)) between 1 and 60),
  name_ar   text not null check (char_length(btrim(name_ar)) between 1 and 60),
  reward    text check (char_length(reward) <= 120),
  reward_ar text check (char_length(reward_ar) <= 120),
  scope     text not null default 'saturday' check (scope in ('saturday', 'community')),
  target    integer not null check (target between 1 and 100000),
  starts_on date not null,
  ends_on   date not null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on)
);

create table if not exists public.squads (
  id         text primary key default ('sq_' || replace(gen_random_uuid()::text, '-', '')),
  name       text not null check (char_length(btrim(name)) between 2 and 30),
  code       text not null unique check (code ~ '^[A-Z0-9]{6}$'),
  created_by text references public.customers(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.squad_members (
  customer_id text primary key references public.customers(id) on delete cascade,
  squad_id    text not null references public.squads(id) on delete cascade,
  joined_at   timestamptz not null default now()
);
create index if not exists squad_members_squad_idx on public.squad_members (squad_id);

create table if not exists public.hub_photos (
  id            text primary key default ('ph_' || replace(gen_random_uuid()::text, '-', '')),
  customer_id   text not null references public.customers(id) on delete cascade,
  img           text check (char_length(img) <= 200000),
  caption       text check (char_length(caption) <= 140),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reported_at   timestamptz,
  report_reason text check (char_length(report_reason) <= 200),
  decided_by    text check (char_length(decided_by) <= 60),
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists hub_photos_status_idx on public.hub_photos (status, created_at desc);
create index if not exists hub_photos_customer_idx on public.hub_photos (customer_id, created_at desc);

create table if not exists public.hub_photo_reacts (
  photo_id    text not null references public.hub_photos(id) on delete cascade,
  customer_id text not null references public.customers(id) on delete cascade,
  primary key (photo_id, customer_id)
);

create table if not exists public.member_welcome (
  customer_id text primary key references public.customers(id) on delete cascade,
  buddy_id    text not null references public.customers(id) on delete cascade,
  assigned_by text check (char_length(assigned_by) <= 60),
  assigned_at timestamptz not null default now(),
  check (customer_id <> buddy_id)
);
create index if not exists member_welcome_buddy_idx on public.member_welcome (buddy_id);

alter table public.hub_secret       enable row level security;
alter table public.member_kudos     enable row level security;
alter table public.rotm_rounds      enable row level security;
alter table public.rotm_votes       enable row level security;
alter table public.hub_goals        enable row level security;
alter table public.squads           enable row level security;
alter table public.squad_members    enable row level security;
alter table public.hub_photos       enable row level security;
alter table public.hub_photo_reacts enable row level security;
alter table public.member_welcome   enable row level security;

revoke all on public.hub_secret, public.member_kudos, public.rotm_rounds, public.rotm_votes, public.hub_goals, public.squads,
              public.squad_members, public.hub_photos, public.hub_photo_reacts, public.member_welcome
  from public, anon, authenticated;

-- Staff run these from Community > Activities. hub_secret has no policy and no grant: functions only.
grant select on public.member_kudos, public.rotm_votes, public.squad_members, public.hub_photo_reacts to authenticated;
grant select, insert, update, delete on public.rotm_rounds, public.hub_goals, public.member_welcome to authenticated;
grant select, update, delete on public.squads to authenticated;
grant select, update, delete on public.hub_photos to authenticated;

drop policy if exists "staff read" on public.member_kudos;
create policy "staff read" on public.member_kudos for select to authenticated using ((select is_staff()));
drop policy if exists "staff read" on public.rotm_votes;
create policy "staff read" on public.rotm_votes for select to authenticated using ((select is_staff()));
drop policy if exists "staff read" on public.squad_members;
create policy "staff read" on public.squad_members for select to authenticated using ((select is_staff()));
drop policy if exists "staff read" on public.hub_photo_reacts;
create policy "staff read" on public.hub_photo_reacts for select to authenticated using ((select is_staff()));
drop policy if exists "staff full" on public.rotm_rounds;
create policy "staff full" on public.rotm_rounds for all to authenticated using ((select is_staff())) with check ((select is_staff()));
drop policy if exists "staff full" on public.hub_goals;
create policy "staff full" on public.hub_goals for all to authenticated using ((select is_staff())) with check ((select is_staff()));
drop policy if exists "staff full" on public.member_welcome;
create policy "staff full" on public.member_welcome for all to authenticated using ((select is_staff())) with check ((select is_staff()));
drop policy if exists "staff full" on public.squads;
create policy "staff full" on public.squads for all to authenticated using ((select is_staff())) with check ((select is_staff()));
drop policy if exists "staff full" on public.hub_photos;
create policy "staff full" on public.hub_photos for all to authenticated using ((select is_staff())) with check ((select is_staff()));

-- ── Helpers: closed to visitors ──────────────────────────────────────────────
create or replace function public._member_ref(p_id text)
returns text
language sql stable security definer set search_path to 'public'
as $$
  select substr(md5((select secret from hub_secret where id = 1) || ':' || p_id), 1, 16);
$$;
revoke all on function public._member_ref(text) from public, anon, authenticated;

-- A listed member from their ref: a member, not merged, not hidden, not asking for deletion, not blacklisted.
create or replace function public._member_by_ref(p_ref text)
returns text
language sql stable security definer set search_path to 'public'
as $$
  select c.id
    from customers c
    join customer_tags ct on ct.customer_id = c.id and ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at)
    left join member_prefs p on p.customer_id = c.id
   where c.merged_into is null and c.deletion_requested_at is null and coalesce(p.hidden, false) = false
     and not exists (select 1 from customer_tags b where b.customer_id = c.id and b.tag_id = 'tag_blacklist')
     and _member_ref(c.id) = p_ref
   limit 1;
$$;
revoke all on function public._member_by_ref(text) from public, anon, authenticated;

create or replace function public._accts_of(p_id text)
returns text[]
language sql stable security definer set search_path to 'public'
as $$
  select array_append(coalesce((select array_agg(x.id) from customers x where x.merged_into = p_id), '{}'::text[]), p_id);
$$;
revoke all on function public._accts_of(text) from public, anon, authenticated;

-- Sessions done by these accounts between two days: Saturday rides, or every community session.
create or replace function public._hub_count(p_accts text[], p_scope text, p_from date, p_to date)
returns integer
language sql stable security definer set search_path to 'public'
as $$
  select count(distinct q.session_id)::integer
    from queue_entries q join sessions s on s.id = q.session_id
   where q.customer_id = any(p_accts) and q.status = 'done'
     and s.session_date >= to_char(p_from, 'YYYY-MM-DD') and s.session_date <= to_char(p_to, 'YYYY-MM-DD')
     and (case when p_scope = 'saturday' then s.ride_kind = 'saturday' else s.event_kind = 'community' end);
$$;
revoke all on function public._hub_count(text[], text, date, date) from public, anon, authenticated;

create or replace function public._ksa_today()
returns date
language sql stable set search_path to 'public'
as $$ select (now() at time zone 'Asia/Riyadh')::date; $$;
revoke all on function public._ksa_today() from public, anon, authenticated;

-- ── The members list: as 20261102200000, with each member's ref, kudos and whether they are new ───
create or replace function public.member_directory(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  return jsonb_build_object('ok', true, 'members', coalesce((
    with mem as (
      select c.id, btrim(c.name) as name, p.shown_title_id, ct.added_at
        from customers c
        join customer_tags ct on ct.customer_id = c.id and ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at)
        left join member_prefs p on p.customer_id = c.id
       where c.merged_into is null and c.deletion_requested_at is null
         and coalesce(p.hidden, false) = false and coalesce(btrim(c.name), '') <> ''
         and not exists (select 1 from customer_tags b where b.customer_id = c.id and b.tag_id = 'tag_blacklist')
    ), acct as (
      select m.id, m.name, m.shown_title_id, m.added_at,
             array_append(coalesce((select array_agg(x.id) from customers x where x.merged_into = m.id), '{}'::text[]), m.id) as accts
        from mem m
    )
    select jsonb_agg(jsonb_build_object(
             'name', a.name, 'me', a.id = p_id, 'ref', _member_ref(a.id),
             'new', coalesce(a.added_at, 0) > (extract(epoch from now() - interval '30 days') * 1000),
             'kudos', (select count(*) from member_kudos k where k.to_id = any(a.accts)),
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

-- ── Everything the page's activities show, in one read ───────────────────────
create or replace function public.hub_overview(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_today date := _ksa_today();
  v_accts text[];
  v_month_from date := date_trunc('month', _ksa_today())::date;
  v_month_to date := (date_trunc('month', _ksa_today()) + interval '1 month - 1 day')::date;
  v_sess record;
  v_round rotm_rounds%rowtype;
  v_sq squads%rowtype;
  v_year integer;
  v_year_doc jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_accts := _accts_of(p_id);

  -- The newest community session this member finished in the last fourteen days: who else finished it.
  select s.id, s.session_date, s.title into v_sess
    from queue_entries q join sessions s on s.id = q.session_id
   where q.customer_id = any(v_accts) and q.status = 'done' and s.event_kind = 'community'
     and s.session_date >= to_char(v_today - 14, 'YYYY-MM-DD')
   order by s.session_date desc limit 1;

  select * into v_round from rotm_rounds r where r.winner_id is null and v_today between r.opens_on and r.closes_on order by r.closes_on limit 1;
  select s.* into v_sq from squad_members m join squads s on s.id = m.squad_id where m.customer_id = p_id;

  -- December and January: the year that is ending or has just ended.
  if extract(month from v_today) in (12, 1) then
    v_year := extract(year from v_today)::integer - (case when extract(month from v_today) = 1 then 1 else 0 end);
    select jsonb_build_object('year', v_year,
             'rides', count(distinct q.session_id),
             'saturdays', count(distinct q.session_id) filter (where s.ride_kind = 'saturday'),
             'kinds', count(distinct coalesce(s.ride_kind, 'rental')),
             'first', min(s.session_date),
             'kudos', (select count(*) from member_kudos k where k.to_id = any(v_accts) and extract(year from k.created_at at time zone 'Asia/Riyadh') = v_year),
             'badges', (select count(*) from customer_badges cb where cb.customer_id = any(v_accts) and extract(year from cb.awarded_at at time zone 'Asia/Riyadh') = v_year))
      into v_year_doc
      from queue_entries q join sessions s on s.id = q.session_id
     where q.customer_id = any(v_accts) and q.status = 'done' and left(s.session_date, 4) = v_year::text;
  end if;

  return jsonb_build_object('ok', true,
    'kudos_got', (select count(*) from member_kudos k where k.to_id = any(v_accts)),
    'together', case when v_sess.id is null then null else jsonb_build_object('session', v_sess.id, 'date', v_sess.session_date,
      'people', coalesce((
        select jsonb_agg(jsonb_build_object('ref', _member_ref(c.id), 'name', btrim(c.name),
                 'given', exists (select 1 from member_kudos k where k.from_id = p_id and k.to_id = c.id and k.session_id = v_sess.id)) order by lower(btrim(c.name)))
          from customers c
          join customer_tags ct on ct.customer_id = c.id and ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at)
          left join member_prefs p on p.customer_id = c.id
         where c.id <> all(v_accts) and c.merged_into is null and c.deletion_requested_at is null
           and coalesce(p.hidden, false) = false
           and exists (select 1 from queue_entries q2 where q2.customer_id = c.id and q2.session_id = v_sess.id and q2.status = 'done')), '[]'::jsonb)) end,
    'round', case when v_round.id is null then null else jsonb_build_object('id', v_round.id, 'label', v_round.label, 'label_ar', v_round.label_ar, 'closes_on', v_round.closes_on,
      'mine', (select _member_ref(v.choice_id) from rotm_votes v where v.round_id = v_round.id and v.voter_id = p_id)) end,
    'last_winner', (select jsonb_build_object('label', r.label, 'label_ar', r.label_ar, 'name', r.winner_name)
                      from rotm_rounds r where r.winner_id is not null order by r.closes_on desc limit 1),
    'goals', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'kind', g.kind, 'name', g.name, 'name_ar', g.name_ar, 'reward', g.reward, 'reward_ar', g.reward_ar,
               'target', g.target, 'ends_on', g.ends_on,
               'progress', case when g.kind = 'challenge' then _hub_count(v_accts, g.scope, g.starts_on, g.ends_on)
                 else (select count(*) from (select distinct q.customer_id, q.session_id
                         from queue_entries q join sessions s on s.id = q.session_id
                         join customer_tags ct on ct.customer_id = q.customer_id and ct.tag_id = 'tag_saturday'
                        where q.status = 'done'
                          and s.session_date >= to_char(g.starts_on, 'YYYY-MM-DD') and s.session_date <= to_char(g.ends_on, 'YYYY-MM-DD')
                          and (case when g.scope = 'saturday' then s.ride_kind = 'saturday' else s.event_kind = 'community' end)) z) end)
               order by g.kind, g.ends_on)
        from hub_goals g where v_today between g.starts_on and g.ends_on), '[]'::jsonb),
    'squad', case when v_sq.id is null then null else jsonb_build_object('name', v_sq.name, 'code', v_sq.code,
      'members', coalesce((select jsonb_agg(btrim(c.name) order by lower(btrim(c.name))) from squad_members m join customers c on c.id = m.customer_id where m.squad_id = v_sq.id), '[]'::jsonb)) end,
    'board', coalesce((
      select jsonb_agg(jsonb_build_object('name', t.name, 'members', t.n, 'rides', t.rides, 'mine', t.id = v_sq.id) order by t.rides desc, lower(t.name))
        from (select s.id, s.name, count(*) as n, sum(_hub_count(_accts_of(m.customer_id), 'community', v_month_from, v_month_to)) as rides
                from squads s join squad_members m on m.squad_id = s.id group by s.id, s.name
               order by rides desc, lower(s.name) limit 20) t), '[]'::jsonb),
    'buddy', (select btrim(c.name) from member_welcome w join customers c on c.id = w.buddy_id where w.customer_id = p_id),
    'welcoming', coalesce((select jsonb_agg(btrim(c.name) order by lower(btrim(c.name))) from member_welcome w join customers c on c.id = w.customer_id where w.buddy_id = p_id), '[]'::jsonb),
    'year', v_year_doc);
end $$;
revoke execute on function public.hub_overview(text, text) from public;
grant  execute on function public.hub_overview(text, text) to anon, authenticated;

-- ── Kudos: to someone who finished the same community session, once a session, within fourteen days ───
create or replace function public.hub_kudos(p_id text, p_token text, p_session text, p_ref text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_to text; v_accts text[];
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_accts := _accts_of(p_id);
  v_to := _member_by_ref(p_ref);
  if v_to is null or v_to = any(v_accts) then return jsonb_build_object('ok', false, 'error', 'person'); end if;
  if not exists (select 1 from sessions s where s.id = p_session and s.event_kind = 'community'
                  and s.session_date >= to_char(_ksa_today() - 14, 'YYYY-MM-DD'))
     or not exists (select 1 from queue_entries q where q.session_id = p_session and q.customer_id = any(v_accts) and q.status = 'done')
     or not exists (select 1 from queue_entries q where q.session_id = p_session and q.customer_id = v_to and q.status = 'done') then
    return jsonb_build_object('ok', false, 'error', 'session');
  end if;
  insert into member_kudos (from_id, to_id, session_id) values (p_id, v_to, p_session) on conflict do nothing;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_kudos(text, text, text, text) from public;
grant  execute on function public.hub_kudos(text, text, text, text) to anon, authenticated;

-- ── Rider of the Month: one vote a round, changeable until it closes; never for oneself ───
create or replace function public.hub_vote(p_id text, p_token text, p_round text, p_ref text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_to text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if not exists (select 1 from rotm_rounds r where r.id = p_round and r.winner_id is null and _ksa_today() between r.opens_on and r.closes_on) then
    return jsonb_build_object('ok', false, 'error', 'closed');
  end if;
  v_to := _member_by_ref(p_ref);
  if v_to is null or v_to = any(_accts_of(p_id)) then return jsonb_build_object('ok', false, 'error', 'person'); end if;
  insert into rotm_votes (round_id, voter_id, choice_id) values (p_round, p_id, v_to)
  on conflict (round_id, voter_id) do update set choice_id = excluded.choice_id, voted_at = now();
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_vote(text, text, text, text) from public;
grant  execute on function public.hub_vote(text, text, text, text) to anon, authenticated;

-- ── Squads: any member makes one or joins by its code; up to eight; one squad each ───
create or replace function public.hub_squad_create(p_id text, p_token text, p_name text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g'); v_id text; v_code text; v_try integer := 0;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if char_length(v_name) not between 2 and 30 then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if exists (select 1 from squad_members m where m.customer_id = p_id) then return jsonb_build_object('ok', false, 'error', 'already'); end if;
  if exists (select 1 from squads s where lower(s.name) = lower(v_name)) then return jsonb_build_object('ok', false, 'error', 'taken'); end if;
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (select 1 from squads s where s.code = v_code);
    v_try := v_try + 1;
    if v_try > 8 then return jsonb_build_object('ok', false, 'error', 'retry'); end if;
  end loop;
  insert into squads (name, code, created_by) values (v_name, v_code, p_id) returning id into v_id;
  insert into squad_members (customer_id, squad_id) values (p_id, v_id);
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_squad_create(text, text, text) from public;
grant  execute on function public.hub_squad_create(text, text, text) to anon, authenticated;

create or replace function public.hub_squad_join(p_id text, p_token text, p_code text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_id text;
begin
  if not _ip_gate('squad_join', 20, interval '10 minutes') then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if exists (select 1 from squad_members m where m.customer_id = p_id) then return jsonb_build_object('ok', false, 'error', 'already'); end if;
  select s.id into v_id from squads s where s.code = upper(btrim(coalesce(p_code, ''))) for update;
  if v_id is null then return jsonb_build_object('ok', false, 'error', 'code'); end if;
  if (select count(*) from squad_members m where m.squad_id = v_id) >= 8 then return jsonb_build_object('ok', false, 'error', 'full'); end if;
  insert into squad_members (customer_id, squad_id) values (p_id, v_id);
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_squad_join(text, text, text) from public;
grant  execute on function public.hub_squad_join(text, text, text) to anon, authenticated;

-- Leaving the last place ends the squad.
create or replace function public.hub_squad_leave(p_id text, p_token text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_id text;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  delete from squad_members m where m.customer_id = p_id returning m.squad_id into v_id;
  if v_id is not null and not exists (select 1 from squad_members m where m.squad_id = v_id) then delete from squads s where s.id = v_id; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_squad_leave(text, text) from public;
grant  execute on function public.hub_squad_leave(text, text) to anon, authenticated;

-- ── The photo wall: a member posts, staff approve; nobody else sees it until then ───
create or replace function public.hub_photos_list(p_id text, p_token text, p_before timestamptz)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  return jsonb_build_object('ok', true,
    'pending', (select count(*) from hub_photos h where h.customer_id = p_id and h.status = 'pending'),
    'photos', coalesce((
      select jsonb_agg(jsonb_build_object('id', x.id, 'caption', x.caption, 'at', x.created_at, 'mine', x.customer_id = p_id,
               'by', case when coalesce(pr.hidden, false) then null else btrim(c.name) end,
               'reacts', (select count(*) from hub_photo_reacts r where r.photo_id = x.id),
               'reacted', exists (select 1 from hub_photo_reacts r where r.photo_id = x.id and r.customer_id = p_id)) order by x.created_at desc)
        from (select * from hub_photos h where h.status = 'approved' and (p_before is null or h.created_at < p_before) order by h.created_at desc limit 12) x
        join customers c on c.id = x.customer_id
        left join member_prefs pr on pr.customer_id = x.customer_id), '[]'::jsonb));
end $$;
revoke execute on function public.hub_photos_list(text, text, timestamptz) from public;
grant  execute on function public.hub_photos_list(text, text, timestamptz) to anon, authenticated;

create or replace function public.hub_photo_img(p_id text, p_token text, p_photo text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) or not _member_active(p_id) then return null; end if;
  return (select h.img from hub_photos h where h.id = p_photo and (h.status = 'approved' or h.customer_id = p_id));
end $$;
revoke execute on function public.hub_photo_img(text, text, text) from public;
grant  execute on function public.hub_photo_img(text, text, text) to anon, authenticated;

create or replace function public.hub_photo_post(p_id text, p_token text, p_img text, p_caption text, p_ack boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if p_ack is not true then return jsonb_build_object('ok', false, 'error', 'ack'); end if;
  if coalesce(p_img, '') !~ '^data:image/jpeg;base64,[A-Za-z0-9+/=]+$' or char_length(p_img) > 200000 then return jsonb_build_object('ok', false, 'error', 'image'); end if;
  if (select count(*) from hub_photos h where h.customer_id = p_id and h.status = 'pending') >= 5
     or (select count(*) from hub_photos h where h.customer_id = p_id and h.created_at > now() - interval '1 day') >= 3 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  insert into hub_photos (customer_id, img, caption) values (p_id, p_img, nullif(left(btrim(coalesce(p_caption, '')), 140), ''));
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_photo_post(text, text, text, text, boolean) from public;
grant  execute on function public.hub_photo_post(text, text, text, text, boolean) to anon, authenticated;

create or replace function public.hub_photo_react(p_id text, p_token text, p_photo text, p_on boolean)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if not exists (select 1 from hub_photos h where h.id = p_photo and h.status = 'approved') then return jsonb_build_object('ok', false, 'error', 'photo'); end if;
  if p_on then insert into hub_photo_reacts (photo_id, customer_id) values (p_photo, p_id) on conflict do nothing;
  else delete from hub_photo_reacts r where r.photo_id = p_photo and r.customer_id = p_id; end if;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_photo_react(text, text, text, boolean) from public;
grant  execute on function public.hub_photo_react(text, text, text, boolean) to anon, authenticated;

-- A member asks for a photo to come down: it leaves the wall at once and waits for staff.
create or replace function public.hub_photo_report(p_id text, p_token text, p_photo text, p_reason text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  update hub_photos set status = 'pending', reported_at = now(), report_reason = left(btrim(coalesce(p_reason, '')), 200)
   where id = p_photo and status = 'approved';
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_photo_report(text, text, text, text) from public;
grant  execute on function public.hub_photo_report(text, text, text, text) to anon, authenticated;

-- A member takes their own photo down.
create or replace function public.hub_photo_delete(p_id text, p_token text, p_photo text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  delete from hub_photos h where h.id = p_photo and h.customer_id = p_id;
  return jsonb_build_object('ok', true);
end $$;
revoke execute on function public.hub_photo_delete(text, text, text) from public;
grant  execute on function public.hub_photo_delete(text, text, text) to anon, authenticated;

-- ── Staff: the vote's count, and who has finished a challenge ────────────────
create or replace function public.staff_rotm_tally(p_round text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not coalesce(is_staff(), false) then raise exception 'not staff' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('customer_id', t.choice_id, 'name', t.name, 'votes', t.n) order by t.n desc, lower(t.name))
    from (select v.choice_id, btrim(c.name) as name, count(*) as n
            from rotm_votes v join customers c on c.id = v.choice_id where v.round_id = p_round group by v.choice_id, c.name) t), '[]'::jsonb);
end $$;
revoke execute on function public.staff_rotm_tally(text) from public, anon;
grant  execute on function public.staff_rotm_tally(text) to authenticated;

create or replace function public.staff_goal_progress(p_goal text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare g hub_goals%rowtype;
begin
  if not coalesce(is_staff(), false) then raise exception 'not staff' using errcode = '42501'; end if;
  select * into g from hub_goals where id = p_goal;
  if not found then return '[]'::jsonb; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('customer_id', t.id, 'name', t.name, 'n', t.n) order by t.n desc, lower(t.name))
    from (select c.id, btrim(c.name) as name, _hub_count(_accts_of(c.id), g.scope, g.starts_on, g.ends_on) as n
            from customers c join customer_tags ct on ct.customer_id = c.id and ct.tag_id = 'tag_saturday' and _ctag_active(ct.starts_at, ct.expires_at)
           where c.merged_into is null) t where t.n >= g.target or g.kind = 'goal' and t.n > 0), '[]'::jsonb);
end $$;
revoke execute on function public.staff_goal_progress(text) from public, anon;
grant  execute on function public.staff_goal_progress(text) to authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261103120000', 'member_hub')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): RLS on all ten tables, every function definer, helpers and the secret closed to visitors, the ledger row.
select (select bool_and(relrowsecurity) from pg_class
         where relnamespace = 'public'::regnamespace and relname in ('hub_secret', 'member_kudos', 'rotm_rounds', 'rotm_votes', 'hub_goals', 'squads',
           'squad_members', 'hub_photos', 'hub_photo_reacts', 'member_welcome')) as rls_on,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('_member_ref', '_member_by_ref', '_accts_of', '_hub_count', 'member_directory', 'hub_overview', 'hub_kudos', 'hub_vote',
           'hub_squad_create', 'hub_squad_join', 'hub_squad_leave', 'hub_photos_list', 'hub_photo_img', 'hub_photo_post', 'hub_photo_react',
           'hub_photo_report', 'hub_photo_delete', 'staff_rotm_tally', 'staff_goal_progress')) as definer_19,
       has_function_privilege('anon', 'public._member_ref(text)', 'execute') as ref_open_to_anon,
       has_table_privilege('anon', 'public.hub_secret', 'select') or has_table_privilege('authenticated', 'public.hub_secret', 'select') as secret_open,
       has_table_privilege('anon', 'public.hub_photos', 'select') as photos_open_to_anon,
       (select version from supabase_migrations.schema_migrations where version = '20261103120000') as ledger;
