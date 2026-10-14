-- ============================================================================
-- Bug hunt 2026-10-14, staff side of the database (worker dbb).
--
-- (staff_refund_receipt stamping pay = 'refunded' on house/team lines is CONFIRMED but not changed
--  here: some 15 client reads take pay = 'refunded' as the only refund mark; see the bh14 report.)
-- 1. queue_num_update_guard: it re-numbered a booking only when its number changed. A booking
--    moved to another ride, or restored from cancelled/removed/no-show, kept a number that may be
--    taken there, and the write failed on queue_entries_session_qnum_uniq. It now takes the next
--    free number in those cases too (no change when the number is free).
-- 2. staff_delete_customer: deleting an account left the accounts merged into it behind; the
--    merged_into key is ON DELETE SET NULL, so each came back as a live account with the person's
--    old name, email and phone. The merged-in accounts (any depth) now go with it, their links
--    cleared the same way, and a live booking on any of them stops the delete as before.
-- 3. staff_unmerge_customers: with either account gone it failed on a foreign key half way;
--    it now answers NOT_FOUND first.
-- 4. _purge_old: the anonymiser's own update wrote the old name, email and phone into audit_log
--    (customers_audit_upd), and the activity log kept them too. After anonymising, the audit rows
--    of those accounts are dropped and their activity lines lose the rider's name and contact
--    details. (Anonymising is off on prod today: biz.retention.anon_years is unset.)
--
-- Each function is replaced from its live definition (header copied from pg_get_functiondef);
-- CREATE OR REPLACE keeps the grants. Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- 1 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_num_update_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  -- A new number, a move to another ride, or a booking back from cancelled / removed / no-show
  -- (the statuses the unique index leaves out) can each land on a number taken there (bh14).
  if new.queue_num is distinct from old.queue_num
     or new.session_id is distinct from old.session_id
     or (coalesce(old.status, '') in ('cancelled','removed','noshow')
         and coalesce(new.status, '') not in ('cancelled','removed','noshow')) then
    if exists (select 1 from queue_entries
                where session_id = new.session_id
                  and queue_num  = new.queue_num
                  and id <> new.id
                  and status not in ('cancelled','removed','noshow')) then
      update sessions
         set last_qnum = greatest(coalesce(last_qnum, 0),
                                  coalesce((select max(queue_num) from queue_entries
                                             where session_id = new.session_id), 0)) + 1
       where id = new.session_id
       returning last_qnum into n;
      if n is not null then new.queue_num := n; end if;
    end if;
  end if;
  return new;
end $function$;

-- 2 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_delete_customer(p_id text, p_op text DEFAULT NULL::text, p_approval text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_live int; v_bookings int := 0; v_sales int := 0; v_tags int := 0; v_push int := 0;
  v_flags int := 0; v_riders int := 0; v_ids text[];
begin
  -- Admins only, as in the staff panel and in the customers table's own delete policy.
  if not is_admin() then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  -- The operator's PIN approval (staff_pin_approve), 2026-10-04.
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  -- The account row is locked first. A booking being made for it needs that row (its foreign
  -- key), so it waits here and then fails on the missing account, instead of landing between
  -- the check below and the delete.
  perform 1 from customers where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'NOT_FOUND'); end if;
  -- The accounts merged into this one, at any depth, are the same person: they go with it. Left
  -- behind, merged_into (on delete set null) turned each back into a live account with the old
  -- name, email and phone (bh14, 2026-10-14).
  with recursive m(id) as (
    select p_id
    union
    select c.id from customers c join m on c.merged_into = m.id
  )
  select array_agg(id) into v_ids from m;
  perform 1 from customers where id = any(v_ids) and id <> p_id order by id for update;
  select count(*) into v_live from queue_entries
   where customer_id = any(v_ids) and status in ('waiting', 'waitlist', 'active');
  if v_live > 0 then
    return jsonb_build_object('ok', false, 'error', 'LIVE_BOOKINGS', 'live', v_live);
  end if;
  -- Past bookings and sales stay, name and all, so rosters, close-outs and analytics read as
  -- they did; they only lose the link. Every row the server holds, not a date window.
  update queue_entries set customer_id = null where customer_id = any(v_ids);
  get diagnostics v_bookings = row_count;
  update cashier_sales set customer_id = null where customer_id = any(v_ids);
  get diagnostics v_sales = row_count;
  -- What was personal to the account goes with it. No key ties these two to customers.
  delete from customer_tags where customer_id = any(v_ids);
  get diagnostics v_tags = row_count;
  delete from push_subscriptions where customer_id = any(v_ids);
  get diagnostics v_push = row_count;
  -- The keys do the rest: customer_flags go with the account (on delete cascade) and a rider
  -- registration matched to it keeps its row with the match cleared (on delete set null).
  -- Counted first, so the answer says everything that moved.
  select count(*) into v_flags from customer_flags where customer_id = any(v_ids);
  select count(*) into v_riders from rider_registrations where matched_customer_id = any(v_ids);
  -- the merged-in accounts first, so none is set loose by the keeper's delete
  delete from customers where id = any(v_ids) and id <> p_id;
  delete from customers where id = p_id;
  return jsonb_build_object('ok', true, 'bookings', v_bookings, 'sales', v_sales, 'tags', v_tags,
                            'push_subscriptions', v_push, 'flags', v_flags, 'rider_links', v_riders,
                            'merged_accounts', coalesce(array_length(v_ids, 1), 1) - 1);
end $function$;

-- 3 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_unmerge_customers(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  m customer_merges%rowtype; ids text[]; col text; tg text; bj jsonb;
  cols text[] := array['height','gender','birth_date','country','city','nationality','type_preference','photo','profession','workplace','heard_from','socials'];
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select * into m from customer_merges where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if m.undone_at is not null then raise exception 'ALREADY_UNDONE' using errcode = '22023'; end if;
  if m.merged_at < now() - interval '30 days' then raise exception 'TOO_LATE' using errcode = '22023'; end if;
  perform 1 from customers where id in (m.keep_id, m.drop_id) order by id for update;
  -- Either account deleted since: nothing to give back to (it failed on a foreign key half way; bh14).
  if (select count(*) from customers where id in (m.keep_id, m.drop_id)) < 2 then
    raise exception 'NOT_FOUND: account' using errcode = 'P0002';
  end if;
  -- The keeper was merged into a third account since: that merge is undone first (20261005210100).
  if exists (select 1 from customers where id = m.keep_id and merged_into is not null) then
    raise exception 'KEEPER_MERGED' using errcode = '22023';
  end if;

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'queue_entries', '[]')) x;
  update queue_entries set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'cashier_sales', '[]')) x;
  update cashier_sales set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_notes', '[]')) x;
  update customer_notes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_flags', '[]')) x;
  update customer_flags set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  -- Two open flags were folded at the merge: the keeper's gets its own fields back, the other
  -- is open again on its own account (20261005210100).
  if m.moved ? 'flag_fold' then
    update customer_flags
       set fields = array(select x from jsonb_array_elements_text(m.moved->'flag_fold'->'keep_fields') with ordinality t(x, o) order by o)
     where id = (m.moved->'flag_fold'->>'keep')::uuid and status = 'pending';
    update customer_flags set status = 'pending', answered_at = null
     where id = (m.moved->'flag_fold'->>'drop')::uuid and customer_id = m.drop_id and status = 'withdrawn'
       and not exists (select 1 from customer_flags x where x.customer_id = m.drop_id and x.status = 'pending');
  end if;
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'push_subscriptions', '[]')) x;
  update push_subscriptions set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'rider_registrations', '[]')) x;
  update rider_registrations set matched_customer_id = m.drop_id where matched_customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'ambassadors', '[]')) x;
  update ambassadors set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'community_applications', '[]')) x;
  update community_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'learn_applications', '[]')) x;
  update learn_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'workshop_jobs', '[]')) x;
  update workshop_jobs set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'site_messages', '[]')) x;
  update site_messages set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'promo_codes', '[]')) x;
  update promo_codes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_moved', '[]')) x loop
    update customer_tags set customer_id = m.drop_id where customer_id = m.keep_id and tag_id = tg
      and not exists (select 1 from customer_tags where customer_id = m.drop_id and tag_id = tg);
  end loop;
  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_dup', '[]')) x loop
    insert into customer_tags (customer_id, tag_id, added_by, added_at)
      values (m.drop_id, tg, 'unmerge', (extract(epoch from now()) * 1000)::bigint)
      on conflict do nothing;
  end loop;

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'badges_moved', '[]')) x loop
    update customer_badges set customer_id = m.drop_id where customer_id = m.keep_id and badge_id = tg
      and not exists (select 1 from customer_badges where customer_id = m.drop_id and badge_id = tg);
  end loop;
  for bj in select x from jsonb_array_elements(coalesce(m.moved->'badges_dup', '[]')) x loop
    insert into customer_badges select (jsonb_populate_record(null::customer_badges, bj || jsonb_build_object('customer_id', m.drop_id))).*
      on conflict do nothing;
  end loop;
  if coalesce((m.moved->>'ig_followers')::boolean, false)
     and not exists (select 1 from customer_ig_followers where customer_id = m.drop_id) then
    update customer_ig_followers set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  if coalesce((m.moved->>'owner_pwd')::boolean, false)
     and not exists (select 1 from customer_owner_pwd where customer_id = m.drop_id) then
    update customer_owner_pwd set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;

  for col in select x from jsonb_array_elements_text(coalesce(m.filled, '[]')) x loop
    -- only while the keeper still holds the value it was given: one it set since is its own (20261007120100)
    if col = any(cols) then
      execute format('update customers k set %I = null from customers d where k.id = $1 and d.id = $2 and k.%I is not distinct from d.%I',
                     col, col, col)
        using m.keep_id, m.drop_id;
    end if;
  end loop;

  update customers set merged_into = null where id = m.drop_id and merged_into = m.keep_id;
  update customer_merges set undone_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'keep_name', m.keep_name, 'drop_name', m.drop_name);
end $function$;

-- 4 -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._purge_old(p_dry boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c_sa timestamptz := _ret_cut('staff_actions', 'm', 24);
  c_ca timestamptz := _ret_cut('customer_activity', 'm', 24);
  c_al timestamptz := _ret_cut('audit_log', 'm', 24);
  c_sh timestamptz := _ret_cut('site_content_history', 'm', 24);
  c_el timestamptz := _ret_cut('error_log', 'd', 90);
  yrs int := coalesce((select case when jsonb_typeof(o.items -> 'retention' -> 'anon_years') = 'number'
                                    and (o.items -> 'retention' ->> 'anon_years')::numeric between 1 and 20
                                   then (o.items -> 'retention' ->> 'anon_years')::numeric::int end
                         from staff_options o where o.key = 'biz'), 0);
  n_sa int; n_ca int; n_al int; n_sh int; n_el int; n_an int := 0; ids text[];
begin
  if p_dry then
    select count(*) into n_sa from staff_actions
     where coalesce(at_server, case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end) < c_sa;
    select count(*) into n_ca from customer_activity where at < c_ca;
    select count(*) into n_al from audit_log where at < c_al;
    select count(*) into n_sh from site_content_history where changed_at < c_sh;
    select count(*) into n_el from error_log where case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end < c_el;
  else
    delete from staff_actions
     where coalesce(at_server, case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end) < c_sa;
    get diagnostics n_sa = row_count;
    delete from customer_activity where at < c_ca;              get diagnostics n_ca = row_count;
    delete from audit_log where at < c_al;                      get diagnostics n_al = row_count;
    delete from site_content_history where changed_at < c_sh;   get diagnostics n_sh = row_count;
    delete from error_log where case when at ~ '^\d{4}-\d{2}-\d{2}' then left(at, 10)::date::timestamptz end < c_el;
    get diagnostics n_el = row_count;
  end if;

  if yrs >= 1 then
    select array_agg(c.id) into ids
      from customers c
     where c.merged_into is null
       and c.created_at ~ '^\d{4}-\d{2}-\d{2}' and left(c.created_at, 10)::date < (now() - make_interval(years => yrs))::date
       and not (c.name = 'Former Rider' and c.email is null and c.phone is null)
       and not exists (select 1 from queue_entries q where q.customer_id = c.id
                        and (q.status in ('waiting', 'waitlist', 'active')
                             or (q.session_date ~ '^\d{4}-\d{2}-\d{2}' and left(q.session_date, 10)::date > (now() - make_interval(years => yrs))::date)))
       and not exists (select 1 from cashier_sales s where s.customer_id = c.id
                        and (s.created_at !~ '^\d{4}-\d{2}-\d{2}' or left(s.created_at, 10)::date > (now() - make_interval(years => yrs))::date))
       and not exists (select 1 from customer_activity a where a.customer_id = c.id and a.at > now() - make_interval(years => yrs));
    n_an := coalesce(array_length(ids, 1), 0);
    if not p_dry and n_an > 0 then
      update customers set name = 'Former Rider', email = null, phone = null, whatsapp = null, whatsapp_same = null,
             photo = null, birth_date = null, emergency_name = null, emergency_phone = null, emergency_relation = null,
             emergency2_name = null, emergency2_phone = null, emergency2_relation = null, socials = null,
             workplace = null, profession = null, apple_email = null, session_token = null,
             password_hash = 'anonymised'
       where id = any(ids);
      update queue_entries set name = 'Former Rider', phone = null, email = null where customer_id = any(ids);
      -- The update above wrote the old name, email and phone into audit_log (customers_audit_upd),
      -- and the activity log holds them too: an anonymised account keeps neither (bh14, 2026-10-14).
      delete from audit_log where tbl = 'customers' and row_id = any(ids);
      update customer_activity
         set who = 'Former Rider',
             detail = coalesce(detail, '{}'::jsonb) - array['email', 'phone', 'rider', 'from_rider', 'text', 'feedback', 'note', 'ch']
       where customer_id = any(ids);
    end if;
  end if;

  if not p_dry then
    insert into staff_actions (at, action, who, device, view, user_id)
      values (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              format('Retention purge: actions %s, customer activity %s, audit %s, website history %s, errors %s, anonymised %s',
                     n_sa, n_ca, n_al, n_sh, n_el, n_an),
              'server', 'server', 'settings', auth.uid());
  end if;
  return jsonb_build_object('staff_actions', n_sa, 'customer_activity', n_ca, 'audit_log', n_al,
                            'site_content_history', n_sh, 'error_log', n_el, 'anon', n_an);
end $function$;

-- checks: every function kept SECURITY DEFINER and its search_path
do $chk$
declare f text;
begin
  foreach f in array array['queue_num_update_guard','staff_delete_customer','staff_unmerge_customers','_purge_old'] loop
    if not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = f and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261014120100', 'bh14_staff')
on conflict (version) do nothing;

commit;
