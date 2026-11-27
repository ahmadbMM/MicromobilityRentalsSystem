-- ============================================================================
-- 20261128120000_tv_party_key.sql
-- The collection-area TVs' new board (the user, 2026-11-28: picked the departure board, "Group by booking"): each row
-- of screen_feed also carries 'g', a short key shared by the riders of one party (8 hex of md5 of the group, else of
-- the account), only when the party has more than one rider, so the TV keeps a family's rows together. Nothing else
-- in the function changes (rebuilt from the live text of 20261121120000, md5(prosrc) dc5e63db on both databases on
-- 2026-11-28). The key is not the group or account id and cannot be turned back into one.
--
-- Rollback: run the screen_feed block of 20261121120000_collection_screens.sql again (a TV without 'g' shows rows
-- ungrouped).
-- Idempotent.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.screen_feed(p_token text, p_etag text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public', 'extensions'
as $$
declare v_s collection_screens; v_today text; v_sids text[]; v_body jsonb; v_etag text; v_biz jsonb;
begin
  if p_token is null or length(p_token) < 20 then return jsonb_build_object('state', 'unknown'); end if;
  select * into v_s from collection_screens where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
  if v_s.id is null then return jsonb_build_object('state', 'unknown'); end if;
  if v_s.paired_at is null then
    if v_s.created_at < now() - interval '1 hour' then
      delete from collection_screens where id = v_s.id;
      return jsonb_build_object('state', 'unknown');
    end if;
    return jsonb_build_object('state', 'pairing', 'code', v_s.pair_code);
  end if;
  if v_s.last_seen_at is null or v_s.last_seen_at < now() - interval '1 minute' then
    update collection_screens set last_seen_at = now() where id = v_s.id;
  end if;

  v_today := to_char(now() at time zone 'Asia/Riyadh', 'YYYY-MM-DD');
  if v_s.session_id is not null then
    v_sids := array[v_s.session_id];
  else
    select coalesce(array_agg(s.id), '{}') into v_sids from sessions s
     where s.session_date = v_today and s.cancelled_at is null and s.draft is not true;
  end if;
  select items into v_biz from staff_options where key = 'biz';

  v_body := jsonb_build_object(
    'area', v_s.area,
    'label', v_s.label,
    'sessions', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', coalesce(nullif(s.title, ''), s.day),
                                                              'title_ar', s.title_ar, 'date', s.session_date, 'day', s.day)
                                           order by s.session_date, s.id)
                            from sessions s where s.id = any(v_sids)), '[]'::jsonb),
    'chart', case when jsonb_typeof(v_biz -> 'size_chart') = 'object' then v_biz -> 'size_chart' end,
    'kids_max', case when jsonb_typeof(v_biz -> 'kids_max_cm') = 'number' then v_biz -> 'kids_max_cm' end,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('id', left(x.id, 12), 'n', x.queue_num, 'name', x.first_name, 'h', x.height,
                                          'type', x.type_preference, 'size', x.size, 'at', x.checked_in_at,
                                          'pos', x.pos, 'of', x.party_n, 'g', x.party_key, 'area', x.eff_area, 'sid', x.session_id)
                       order by x.checked_in_at, x.queue_num)
        from (
          select q.*, split_part(trim(coalesce(q.name, '')), ' ', 1) as first_name,
                 _screen_area(q.collect_area, q.type_preference) as eff_area,
                 p.pos, p.party_n,
                 case when p.party_n > 1 then left(md5(coalesce('g' || q.group_id::text, 'c' || q.customer_id::text)), 8) end as party_key
            from queue_entries q
            left join lateral (
              select count(*) filter (where o.queue_num < q.queue_num or (o.queue_num = q.queue_num and o.id <= q.id)) as pos,
                     count(*) as party_n
                from queue_entries o
               where o.session_id = q.session_id
                 and o.status in ('waiting', 'waitlist', 'active', 'done')
                 and ((q.group_id is not null and o.group_id = q.group_id)
                      or (q.group_id is null and q.customer_id is not null and o.group_id is null and o.customer_id = q.customer_id))
            ) p on true
           where q.session_id = any(v_sids)
             and q.status = 'active'
             and q.checked_in_at is not null and q.checked_in_at <> ''
             and q.checked_in_at::timestamptz > now() - interval '30 minutes'
             and q.handed_at is null
             and coalesce(q.assigned_bike_id, '') = ''
             and coalesce(q.type_preference, 'Any') not in ('Own', 'None')
        ) x
       where x.eff_area is null or x.eff_area = v_s.area), '[]'::jsonb));
  v_etag := md5(v_body::text);
  if p_etag is not null and p_etag = v_etag then
    return jsonb_build_object('state', 'same', 'etag', v_etag, 'now', now());
  end if;
  return v_body || jsonb_build_object('state', 'paired', 'etag', v_etag, 'now', now());
end;
$$;
revoke all on function public.screen_feed(text, text) from public;
grant execute on function public.screen_feed(text, text) to anon, authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.screen_feed(text,text)'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
                   and p.prosrc like '%party_key%') then
    raise exception 'screen_feed is missing its party key, or lost SECURITY DEFINER or its search_path';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261128120000', 'tv_party_key')
on conflict (version) do nothing;

commit;

-- Check (read-only): one row, ok = true.
-- select (prosrc like '%party_key%') and prosecdef as ok,
--        (select name from supabase_migrations.schema_migrations where version = '20261128120000') as ledger
--   from pg_proc where oid = 'public.screen_feed(text,text)'::regprocedure;
