-- The post-ride rating asks per ride kind (the owner, 2026-10-03): a circuit or Petromin ride scores
-- service, the bike and the experience; a Saturday social ride scores the ride (check-in and
-- collection, staff, bike, route), the breakfast (restaurant, atmosphere, food, service) and the whole
-- experience; any score of 8 or under carries the rider's reason. The answers are kept whole in
-- queue_entries.rating_detail:
--   {"form": "rental"|"social", "s": {"<question>": 1-10, ...}, "why": {"<question>": "text", ...}, "skip_bf": true?}
-- rating_bike / rating_exp / feedback are still written beside it (the bike, the experience or overall
-- score, the comment), so the bike health, the bell and the averages read on unchanged.
--
-- customer_booking_update takes rating_detail and cleans it (form one of two words; question keys
-- [a-z_]{1,24}; scores 1-10; reasons trimmed to 300 characters; at most 20 of each). It is patched from
-- its own live definition (pg_get_functiondef keeps SECURITY DEFINER and the search_path), like
-- 20261002160000, and refuses to run if the text it edits is not there. my_bookings (select *) and
-- staff_sync (to_jsonb) carry the new column without a change; the table grants are table-level.
--
-- Rollback: alter table public.queue_entries drop column rating_detail; then re-run the function from
-- its definition before this (pg_get_functiondef md5 9c8f5861876b0016d15019cc2c022344 on 2026-10-03).
-- Idempotent.

alter table public.queue_entries add column if not exists rating_detail jsonb;
alter table public.queue_entries drop constraint if exists queue_entries_rating_detail_small;
alter table public.queue_entries add constraint queue_entries_rating_detail_small
  check (rating_detail is null or (jsonb_typeof(rating_detail) = 'object' and octet_length(rating_detail::text) <= 8000));

do $mig$
declare d text; n text;
begin
  d := pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure);
  if position('rating_detail' in d) > 0 then return; end if;

  n := replace(d, $a$_rt text[];
begin$a$, $b$_rt text[]; _rd jsonb;
begin$b$);
  if n = d then raise exception 'customer_booking_update: declare line not found'; end if;
  d := n;

  n := replace(d, $a$  _cancelling := coalesce(_p->>'status','') = 'cancelled'$a$, $b$  if _p ? 'rating_detail' and jsonb_typeof(_p->'rating_detail') = 'object' then
    _rd := jsonb_strip_nulls(jsonb_build_object(
      'form', case when (_p->'rating_detail'->>'form') in ('rental','social') then _p->'rating_detail'->>'form' end,
      's', (select coalesce(jsonb_object_agg(k, case when v ~ '^[0-9]{1,2}$' then v::int end), '{}'::jsonb)
              from (select k, v from jsonb_each_text(case when jsonb_typeof(_p->'rating_detail'->'s') = 'object'
                                                          then _p->'rating_detail'->'s' else '{}'::jsonb end) e(k, v)
                     where k ~ '^[a-z_]{1,24}$'
                       and (case when v ~ '^[0-9]{1,2}$' then v::int end) between 1 and 10
                     limit 20) s1),
      'why', (select coalesce(jsonb_object_agg(k, left(btrim(v), 300)), '{}'::jsonb)
                from (select k, v from jsonb_each_text(case when jsonb_typeof(_p->'rating_detail'->'why') = 'object'
                                                            then _p->'rating_detail'->'why' else '{}'::jsonb end) e(k, v)
                       where k ~ '^[a-z_]{1,24}$' and btrim(v) <> ''
                       limit 20) w1),
      'skip_bf', case when (_p->'rating_detail'->>'skip_bf') = 'true' then true end));
  end if;
  _cancelling := coalesce(_p->>'status','') = 'cancelled'$b$);
  if n = d then raise exception 'customer_booking_update: _cancelling line not found'; end if;
  d := n;

  n := replace(d, $a$    rating_tags      = case when _p ? 'rating_tags' then _rt else x.rating_tags end,
$a$, $b$    rating_tags      = case when _p ? 'rating_tags' then _rt else x.rating_tags end,
    rating_detail    = case when _p ? 'rating_detail' then _rd else x.rating_detail end,
$b$);
  if n = d then raise exception 'customer_booking_update: rating_tags set line not found'; end if;

  execute n;
end $mig$;

do $chk$
declare d text := pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure);
begin
  if not (select prosecdef from pg_proc where oid = 'public.customer_booking_update(text,text,text,jsonb)'::regprocedure) then
    raise exception 'customer_booking_update lost SECURITY DEFINER';
  end if;
  if position('rating_detail    = case' in d) = 0 or position('_rd jsonb' in d) = 0 then
    raise exception 'customer_booking_update does not take rating_detail';
  end if;
end $chk$;
