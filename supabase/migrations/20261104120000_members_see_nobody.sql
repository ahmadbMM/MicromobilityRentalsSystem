-- Members see nothing about each other (2026-11-04): no names, titles, badges, ride counts, kudos, squads,
-- photos or buddies. Only reads change, and nothing is deleted, so staff still see everything:
--   member_directory  still answers "is this account a member" (the page's gate), with an empty list
--   hub_overview      only the caller's own challenges, the community goal's total and the caller's own year
--   hub_photos_list   only the caller's count of photos waiting; no wall
--   hub_photo_img     only the caller's own picture
-- A cached older app keeps working: it finds empty lists.

begin;

create or replace function public.member_directory(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  return jsonb_build_object('ok', true, 'members', '[]'::jsonb);
end $$;

create or replace function public.hub_overview(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  v_today date := _ksa_today();
  v_accts text[];
  v_year integer;
  v_year_doc jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  v_accts := _accts_of(p_id);

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
    'year', v_year_doc);
end $$;

create or replace function public.hub_photos_list(p_id text, p_token text, p_before timestamptz)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  return jsonb_build_object('ok', true,
    'pending', (select count(*) from hub_photos h where h.customer_id = p_id and h.status = 'pending'),
    'photos', '[]'::jsonb);
end $$;

create or replace function public.hub_photo_img(p_id text, p_token text, p_photo text)
returns text
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) or not _member_active(p_id) then return null; end if;
  return (select h.img from hub_photos h where h.id = p_photo and h.customer_id = p_id);
end $$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261104120000', 'members_see_nobody')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): four definer functions, none of them reading a name; the ledger row.
select (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
         and proname in ('member_directory', 'hub_overview', 'hub_photos_list', 'hub_photo_img')) as definer_4,
       (select count(*) from pg_proc where pronamespace = 'public'::regnamespace
         and proname in ('member_directory', 'hub_overview', 'hub_photos_list', 'hub_photo_img')
         and prosrc ~ '(c\.name|winner_name|member_welcome|squad_members)') as naming_0,
       (select version from supabase_migrations.schema_migrations where version = '20261104120000') as ledger;
