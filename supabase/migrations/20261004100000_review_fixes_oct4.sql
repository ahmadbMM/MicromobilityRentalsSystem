-- ============================================================================
-- Database fixes from the 2026-10-03 database review (the owner, 2026-10-04: "fix them all").
--
--  1. customer_change_password: a wrong current password is ANSWERED with the text 'BAD_PASSWORD'
--     instead of raised, so the failure count in login_throttle ('pwchange:<id>') is kept and five
--     wrong tries really lock changes for 15 minutes. Before, the raise rolled the count back and
--     the lock never came. The other refusals (BAD_TOKEN, LOCKED, WEAK_PASSWORD, SAME_PASSWORD)
--     write nothing and still raise. A new session token (48 hex characters) is still the answer to
--     a change that went through. THE APP MUST treat the answer 'BAD_PASSWORD' as the refusal.
--  2. customer_change_password keeps customer_owner_pwd in step: an account that had no password
--     (Google or Apple only), or whose password was the one its Google/Apple owner chose, has the
--     new hash recorded as the owner's, so the next Google or Apple sign-in (customer_oauth_login)
--     keeps it instead of ending it.
--  3. The old anonymous application forms are closed: community_apply(jsonb) and learn_apply(jsonb)
--     are no longer callable by anon or authenticated (nothing calls them: the booking app and the
--     website use customer_community_apply / customer_learn_apply, which need the account). They
--     updated ANY pending application with the same email OR phone, so whoever knew a number could
--     rewrite someone else's application. customer_learn_apply still calls learn_apply inside
--     itself, as its owner, which the revoke does not touch.
--  4. The booking window holds a move too: queue_entries_booking_window_upd runs
--     _booking_window_guard when a booking's session changes (customer_booking_update's move), so
--     a ride that has not opened yet cannot be reached by booking another and moving. Staff are
--     exempt, as on insert. The rider's move is refused with NOT_OPEN_YET, as a new booking is.
--  5. Operator PINs: _pin_ok refuses an operator name that is not on the team list unless it is
--     the signed-in account's own name (staff.display_name, else its op_name). A device with no
--     operator (p_op null) is answered as before; the account is on record in audit_log. Only an
--     admin removes a name from the team list (team_members DELETE). staff_my_settings renames the
--     team-list entry only from the account's own display_name (op_name in auth metadata is the
--     user's to write, so it no longer decides which entry is renamed).
--  6. Merging accounts also moves customer_badges (a badge the keeper holds already is kept aside
--     and comes back on unmerge), learn_applications.customer_id, customer_ig_followers and
--     customer_owner_pwd (each only when the keeper has none), and fills the keeper's empty
--     workplace and heard_from. Every move is recorded in customer_merges.moved; unmerge reverses
--     them (merges recorded before this carry none of the new keys, and unmerge leaves those alone).
--  7. customer_booking_update: restoring a cancelled rider on a community ride counts against the
--     cap _group_ride_cap applies (an event ride takes five per booker, the others two, an approval
--     ride one); it was always two.
--  8. (No change.) A waitlisted booking moved to a full ride already gets a new number:
--     wl_num_assign_upd fires on a session change since 20260922122000.
--  9. badge_weeks reads only dates that are real dates (_safe_date) and leaves private, tag-gated
--     sessions out (it is open to anyone); _vendor_session_fill skips a ride whose date is not a
--     real date instead of failing its insert.
-- 10. customer_push_subscribe takes only an https endpoint on a known push service (Google FCM,
--     Mozilla, Apple, Windows) and keys of a sane length; anything else is answered false.
-- 11. rider_register (rider_edit goes through it): every word of the employee's name and of a
--     typed companion name has at least two letters, the rule customers' names follow; the desk
--     is exempt, as staff are for customers. The refusal reuses the codes the Petromin form already
--     shows (name_chars / rider_name_chars), with "why":"short".
-- 12. vendor_logout(p_uid, p_token): ends a vendor login's session token when the token matches.
-- 13. _group_ride_cap and _solo_ride_cap take a lock on (session, customer) before counting, so two
--     bookings sent at once cannot both pass the cap.
-- 14. customer_booking_update ignores a rating (scores, tags, the detailed rating, the comment) on
--     a booking whose ride is still ahead (session_date after today in Riyadh). Ratings of rides
--     today or earlier are unchanged.
-- Not changed: _client_ip (whether every request carries cf-connecting-ip could not be confirmed).
--
-- Also: the ledger rows of the 2026-10-03 migrations that were applied by hand without one, under
-- their file names (three were renamed to end 0001 because their numbers clashed).
--
-- Rollback (in this order):
--   drop trigger if exists queue_entries_booking_window_upd on public.queue_entries;
--   drop function if exists public.vendor_logout(text, text);
--   re-run from their previous migrations: customer_change_password (20261003120000), _pin_ok
--   (20260928200000), staff_my_settings (20261002140000), staff_merge_customers (20260928190000),
--   staff_unmerge_customers (20260928130000), _group_ride_cap (20260928160000), _solo_ride_cap
--   (20260922150000), badge_weeks (20260929050000), _vendor_session_fill (20261003190000),
--   customer_push_subscribe (20260922121000);
--   customer_booking_update and rider_register: run the patch blocks below backwards (replace each
--   new text with its anchor) on pg_get_functiondef;
--   grant execute on function public.community_apply(jsonb), public.learn_apply(jsonb) to anon, authenticated;
--   drop policy team_members_delete ... and re-create it from 20260925120000;
--   drop function if exists public._safe_date(text);
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

-- ── helper: the date a text names, or null ─────────────────────────────────────────────────────
create or replace function public._safe_date(v text)
returns date
language plpgsql immutable set search_path to 'public', 'pg_temp'
as $$
begin
  if v is null or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return null; end if;
  return v::date;
exception when others then
  return null;
end $$;
revoke all on function public._safe_date(text) from public, anon, authenticated;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;


-- ── 1 + 2. customer_change_password ────────────────────────────────────────────────────────────
create or replace function public.customer_change_password(p_id text, p_token text, p_current text, p_new text)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare c customers%rowtype; tok text; ident text; thr login_throttle%rowtype; nfails int; has_pwd boolean;
        owner boolean; h text;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'BAD_TOKEN' using errcode = '28000'; end if;
  ident := 'pwchange:' || p_id;
  select * into thr from login_throttle where identifier = ident;
  if thr.locked_until is not null and thr.locked_until > now() then
    raise exception 'LOCKED' using errcode = 'P0001';
  end if;
  select * into c from customers where id = p_id for update;
  has_pwd := left(coalesce(c.password_hash, ''), 2) = '$2' or left(coalesce(c.password_hash, ''), 7) = 'sha256:';
  if has_pwd and not _cust_pwd_ok(c.password_hash, coalesce(p_current, '')) then
    -- Answered, not raised: a raise would roll this count back and the lock would never come.
    nfails := (case when (thr.locked_until is not null and thr.locked_until <= now())
                      or thr.updated_at < now() - interval '1 day' then 0
                    else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until, updated_at)
      values (ident, nfails, case when nfails >= 5 then now() + interval '15 minutes' else null end, now())
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until,
                                             updated_at = excluded.updated_at;
    return 'BAD_PASSWORD';
  end if;
  if length(coalesce(p_new, '')) < 8 or p_new !~ '[A-Z]' or p_new !~ '[0-9]' then
    raise exception 'WEAK_PASSWORD' using errcode = '22023';
  end if;
  if has_pwd and _cust_pwd_ok(c.password_hash, p_new) then raise exception 'SAME_PASSWORD' using errcode = '22023'; end if;
  -- The Google/Apple owner's own password (customer_owner_pwd) stays the owner's after a change:
  -- an account that had none, or whose password was the one the owner chose.
  owner := not has_pwd or exists (select 1 from customer_owner_pwd o
                                   where o.customer_id = p_id and o.pwd_hash = c.password_hash);
  delete from login_throttle where identifier = ident;
  tok := encode(gen_random_bytes(24), 'hex');
  h := crypt(p_new, gen_salt('bf'));
  update customers set password_hash = h, session_token = tok, must_change_pwd = false
   where id = p_id;
  if owner then
    insert into customer_owner_pwd (customer_id, pwd_hash) values (p_id, h)
    on conflict (customer_id) do update set pwd_hash = excluded.pwd_hash, set_at = now();
  end if;
  return tok;
end $function$;
revoke all on function public.customer_change_password(text, text, text, text) from public;
grant execute on function public.customer_change_password(text, text, text, text) to anon, authenticated;


-- ── 3. the old anonymous application forms ─────────────────────────────────────────────────────
revoke execute on function public.community_apply(jsonb) from public, anon, authenticated;
revoke execute on function public.learn_apply(jsonb) from public, anon, authenticated;


-- ── 4. the booking window on a move ────────────────────────────────────────────────────────────
drop trigger if exists queue_entries_booking_window_upd on public.queue_entries;
create trigger queue_entries_booking_window_upd
  before update of session_id on public.queue_entries
  for each row when (new.session_id is distinct from old.session_id)
  execute function public._booking_window_guard();


-- ── 5. operator PINs ───────────────────────────────────────────────────────────────────────────
create or replace function public._pin_ok(p_op text, p_approval text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $$
declare op text := nullif(btrim(coalesce(p_op, '')), ''); listed boolean := false; h text; own text;
begin
  delete from pin_approvals where expires_at < now();
  -- A device with no operator gate: the signed-in account answers for it (audit_log.actor).
  if op is null then return true; end if;
  select true, t.pin_hash into listed, h from team_members t where t.name = op limit 1;
  if not coalesce(listed, false) then
    -- A name off the team list is only the account's own.
    select coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(u.raw_user_meta_data ->> 'op_name'), ''))
      into own
      from staff s left join auth.users u on u.id = s.user_id
     where s.user_id = auth.uid();
    return own is not null and lower(own) = lower(op);
  end if;
  if h is null then return true; end if;
  return exists (select 1 from pin_approvals
                  where token = p_approval and user_id = auth.uid() and op_name = op and expires_at >= now());
end $$;
revoke all on function public._pin_ok(text, text) from public, anon, authenticated;

drop policy if exists team_members_delete on public.team_members;
create policy team_members_delete on public.team_members for delete
  using ((select is_admin()));

create or replace function public.staff_my_settings(p_name text default null, p_photo text default null,
                                                    p_set_photo boolean default false, p_nt_off text[] default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  _uid uuid := auth.uid(); _old text; _new text; _off text[];
begin
  if _uid is null or not exists (select 1 from staff where user_id = _uid) then
    raise exception 'NOT_STAFF' using errcode = '42501';
  end if;
  if p_name is not null then
    _new := left(btrim(regexp_replace(p_name, '\s+', ' ', 'g')), 40);
    if length(_new) < 2 then raise exception 'BAD_NAME' using errcode = '22023'; end if;
    -- The account's own name only: op_name in the auth metadata is the user's to write, so it
    -- must not say which team-list entry (and PIN) moves (20261004100000).
    select nullif(btrim(s.display_name), '') into _old from staff s where s.user_id = _uid;
    update staff set display_name = _new where user_id = _uid;
    update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('op_name', _new)
     where id = _uid;
    if _old is not null and _old <> _new
       and not exists (select 1 from team_members where lower(name) = lower(_new)) then
      update team_members set name = _new where name = _old;
    end if;
  end if;
  if p_set_photo then
    if p_photo is not null
       and p_photo !~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/photos/p/[A-Za-z0-9_-]{1,64}\.jpg$'
       and (p_photo !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' or length(p_photo) > 200000) then
      raise exception 'BAD_PHOTO' using errcode = '22023';
    end if;
    update staff set photo = p_photo where user_id = _uid;
  end if;
  if p_nt_off is not null then
    select coalesce(array_agg(distinct k), '{}') into _off
      from unnest(p_nt_off) k where k in ('long','ws','apps','learn','bday','msgs','attn','lowrate','stock');
    update staff set nt_off = _off where user_id = _uid;
  end if;
  return (select jsonb_build_object('display_name', display_name, 'photo', photo, 'nt_off', nt_off)
            from staff where user_id = _uid);
end $function$;
revoke all on function public.staff_my_settings(text, text, boolean, text[]) from public, anon;
grant execute on function public.staff_my_settings(text, text, boolean, text[]) to authenticated;


-- ── 6. merging accounts ────────────────────────────────────────────────────────────────────────
create or replace function public.staff_merge_customers(p_keep text, p_drop text, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  k customers%rowtype; d customers%rowtype;
  mv jsonb := '{}'::jsonb; fl text[] := '{}'; ids text[]; m_id bigint;
  tags_moved text[] := '{}'; tags_dup text[] := '{}'; tg text;
  bd customer_badges%rowtype; bdg_moved text[] := '{}'; bdg_dup jsonb := '[]'::jsonb;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then raise exception 'SAME_ACCOUNT' using errcode = '22023'; end if;
  -- both rows locked, lower id first, so two admins merging the same pair cannot cross
  if p_keep < p_drop then
    select * into k from customers where id = p_keep for update;
    select * into d from customers where id = p_drop for update;
  else
    select * into d from customers where id = p_drop for update;
    select * into k from customers where id = p_keep for update;
  end if;
  if k.id is null then raise exception 'NOT_FOUND: keep' using errcode = 'P0002'; end if;
  if d.id is null then raise exception 'NOT_FOUND: drop' using errcode = 'P0002'; end if;
  if k.merged_into is not null or d.merged_into is not null then raise exception 'ALREADY_MERGED' using errcode = '22023'; end if;

  with u as (update queue_entries set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('queue_entries', to_jsonb(ids));
  with u as (update cashier_sales set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('cashier_sales', to_jsonb(ids));
  with u as (update customer_notes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_notes', to_jsonb(ids));
  with u as (update customer_flags set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_flags', to_jsonb(ids));
  with u as (update push_subscriptions set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('push_subscriptions', to_jsonb(ids));
  with u as (update rider_registrations set matched_customer_id = p_keep where matched_customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('rider_registrations', to_jsonb(ids));
  with u as (update ambassadors set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('ambassadors', to_jsonb(ids));
  with u as (update community_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('community_applications', to_jsonb(ids));
  with u as (update learn_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('learn_applications', to_jsonb(ids));
  with u as (update workshop_jobs set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('workshop_jobs', to_jsonb(ids));
  with u as (update site_messages set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('site_messages', to_jsonb(ids));
  with u as (update promo_codes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('promo_codes', to_jsonb(ids));
  delete from customer_handoffs where customer_id = p_drop; -- two-minute sign-in codes: nothing to keep

  -- tags: a tag the keeper holds already is dropped, the others move (the primary key is (customer, tag))
  for tg in select tag_id from customer_tags where customer_id = p_drop loop
    if exists (select 1 from customer_tags where customer_id = p_keep and tag_id = tg) then
      delete from customer_tags where customer_id = p_drop and tag_id = tg;
      tags_dup := tags_dup || tg;
    else
      update customer_tags set customer_id = p_keep where customer_id = p_drop and tag_id = tg;
      tags_moved := tags_moved || tg;
    end if;
  end loop;
  mv := mv || jsonb_build_object('tags_moved', to_jsonb(tags_moved), 'tags_dup', to_jsonb(tags_dup));

  -- badges, the same way; a badge the keeper holds already is kept whole in the record for unmerge
  for bd in select * from customer_badges where customer_id = p_drop loop
    if exists (select 1 from customer_badges where customer_id = p_keep and badge_id = bd.badge_id) then
      delete from customer_badges where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_dup := bdg_dup || jsonb_build_array(to_jsonb(bd));
    else
      update customer_badges set customer_id = p_keep where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_moved := array_append(bdg_moved, bd.badge_id);
    end if;
  end loop;
  mv := mv || jsonb_build_object('badges_moved', to_jsonb(bdg_moved), 'badges_dup', bdg_dup);

  -- one-row-per-account records: moved only when the keeper has none
  if not exists (select 1 from customer_ig_followers where customer_id = p_keep)
     and exists (select 1 from customer_ig_followers where customer_id = p_drop) then
    update customer_ig_followers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('ig_followers', true);
  end if;
  if not exists (select 1 from customer_owner_pwd where customer_id = p_keep)
     and exists (select 1 from customer_owner_pwd where customer_id = p_drop) then
    update customer_owner_pwd set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('owner_pwd', true);
  end if;

  -- what the keeper lacked, from the other
  if coalesce(k.height, 0) = 0 and coalesce(d.height, 0) > 0 then update customers set height = d.height where id = p_keep; fl := array_append(fl, 'height'); end if;
  if coalesce(k.gender, '') = '' and coalesce(d.gender, '') <> '' then update customers set gender = d.gender where id = p_keep; fl := array_append(fl, 'gender'); end if;
  if coalesce(k.birth_date, '') = '' and coalesce(d.birth_date, '') <> '' then update customers set birth_date = d.birth_date where id = p_keep; fl := array_append(fl, 'birth_date'); end if;
  if coalesce(k.country, '') = '' and coalesce(d.country, '') <> '' then update customers set country = d.country where id = p_keep; fl := array_append(fl, 'country'); end if;
  if coalesce(k.city, '') = '' and coalesce(d.city, '') <> '' then update customers set city = d.city where id = p_keep; fl := array_append(fl, 'city'); end if;
  if coalesce(k.nationality, '') = '' and coalesce(d.nationality, '') <> '' then update customers set nationality = d.nationality where id = p_keep; fl := array_append(fl, 'nationality'); end if;
  if coalesce(k.type_preference, '') = '' and coalesce(d.type_preference, '') <> '' then update customers set type_preference = d.type_preference where id = p_keep; fl := array_append(fl, 'type_preference'); end if;
  if coalesce(k.photo, '') = '' and coalesce(d.photo, '') <> '' then update customers set photo = d.photo where id = p_keep; fl := array_append(fl, 'photo'); end if;
  if coalesce(k.profession, '') = '' and coalesce(d.profession, '') <> '' then update customers set profession = d.profession where id = p_keep; fl := array_append(fl, 'profession'); end if;
  if coalesce(k.workplace, '') = '' and coalesce(d.workplace, '') <> '' then update customers set workplace = d.workplace where id = p_keep; fl := array_append(fl, 'workplace'); end if;
  if coalesce(k.heard_from, '') = '' and coalesce(d.heard_from, '') <> '' then update customers set heard_from = d.heard_from where id = p_keep; fl := array_append(fl, 'heard_from'); end if;
  if k.socials is null and d.socials is not null then update customers set socials = d.socials where id = p_keep; fl := array_append(fl, 'socials'); end if;

  update customers set merged_into = p_keep, session_token = null where id = p_drop;

  insert into customer_merges (keep_id, drop_id, keep_name, drop_name, moved, filled, merged_by)
    values (p_keep, p_drop, k.name, d.name, mv, to_jsonb(fl), p_by) returning id into m_id;
  return jsonb_build_object('ok', true, 'id', m_id, 'moved', mv, 'filled', to_jsonb(fl), 'keep_name', k.name, 'drop_name', d.name);
end $$;
revoke all on function public.staff_merge_customers(text, text, text) from public, anon;
grant execute on function public.staff_merge_customers(text, text, text) to authenticated;

create or replace function public.staff_unmerge_customers(p_id bigint)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
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

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'queue_entries', '[]')) x;
  update queue_entries set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'cashier_sales', '[]')) x;
  update cashier_sales set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_notes', '[]')) x;
  update customer_notes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_flags', '[]')) x;
  update customer_flags set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
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
    if col = any(cols) then execute format('update customers set %I = null where id = $1', col) using m.keep_id; end if;
  end loop;

  update customers set merged_into = null where id = m.drop_id and merged_into = m.keep_id;
  update customer_merges set undone_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'keep_name', m.keep_name, 'drop_name', m.drop_name);
end $$;
revoke all on function public.staff_unmerge_customers(bigint) from public, anon;
grant execute on function public.staff_unmerge_customers(bigint) to authenticated;


-- ── 7 + 14. customer_booking_update (patched from its live definition) ─────────────────────────
do $cbu$
declare d text;
begin
  d := pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure);
  if position('(20261004100000)' in d) > 0 then
    raise notice 'customer_booking_update already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
    E'      if _live >= (case when coalesce(_at.needs_approval,false) then 1 else 2 end) then return false; end if;\n',
    E'      -- the cap _group_ride_cap applies: an event takes five per booker (20261004100000)\n'
 || E'      if _live >= (case when coalesce(_at.needs_approval,false) then 1\n'
 || E'                        when coalesce(_at.ride_kind,'''') = ''event'' then 5 else 2 end) then return false; end if;\n');
  d := pg_temp._once(d,
    E'  if _p ? ''rating_bike'' then\n',
    E'  -- A ride still ahead is not rated (20261004100000).\n'
 || E'  if coalesce(q.session_date, '''') > _today then\n'
 || E'    _p := _p - ''rating_bike'' - ''rating_exp'' - ''rating_tags'' - ''rating_detail'' - ''feedback'';\n'
 || E'  end if;\n'
 || E'  if _p ? ''rating_bike'' then\n');
  execute d;
end $cbu$;


-- ── 9. badge_weeks and _vendor_session_fill: real dates only ───────────────────────────────────
create or replace function public.badge_weeks()
returns jsonb
language sql stable security definer set search_path to 'public'
as $$
  with today as (select (now() at time zone 'Asia/Riyadh')::date as d),
  s as (
    select id, _safe_date(session_date) as d
      from sessions
     where coalesce(status, '') <> 'deleted'
       and required_tag_id is null          -- private events are nobody else's business (20261004100000)
  )
  select coalesce(jsonb_agg(jsonb_build_object('w', w, 'ids', ids) order by w), '[]'::jsonb)
    from (select to_char(s.d - extract(dow from s.d)::int, 'YYYY-MM-DD') as w,
                 jsonb_agg(s.id order by s.d, s.id) as ids
            from s, today
           where s.d is not null
             and s.d <= today.d + (6 - extract(dow from today.d)::int)
           group by 1) x
$$;
revoke execute on function public.badge_weeks() from public;
grant  execute on function public.badge_weeks() to anon, authenticated;

create or replace function public._vendor_session_fill()
returns trigger language plpgsql security definer set search_path to 'public'
as $$
declare v vendor_venues%rowtype; d date := _safe_date(new.session_date);
begin
  if new.event_kind = 'community' and coalesce(new.ride_kind, 'saturday') = 'saturday' and d is not null then
    select ve.* into v from vendor_bookings b join vendor_venues ve on ve.id = b.venue_id
     where b.day = d and b.status = 'confirmed'
     order by b.decided_at nulls last, b.id limit 1;
    if found then
      new.breakfast_name := v.name;
      new.breakfast_url := nullif(v.map_url, '');
      update vendor_dates set synced_name = v.name where day = d;
    end if;
  end if;
  return new;
end $$;
revoke all on function public._vendor_session_fill() from public, anon, authenticated;


-- ── 10. push endpoints on known push services only ─────────────────────────────────────────────
create or replace function public.customer_push_subscribe(p_id text, p_token text, p_endpoint text, p_p256dh text, p_auth text, p_ua text)
returns boolean
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare n int;
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if coalesce(p_endpoint,'') = '' or coalesce(p_p256dh,'') = '' or coalesce(p_auth,'') = '' then
    return false;
  end if;
  -- A browser's push service, nothing else: the server posts to this address (20261004100000).
  if length(p_endpoint) > 1000
     or p_endpoint !~ '^https://(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|([a-z0-9-]+\.)*push\.apple\.com|([a-z0-9-]+\.)+notify\.windows\.com)/[^[:space:]]+$'
     or p_p256dh !~ '^[A-Za-z0-9_+/=-]{40,200}$'
     or p_auth !~ '^[A-Za-z0-9_+/=-]{8,64}$' then
    return false;
  end if;
  if (select count(*) from push_subscriptions where customer_id = p_id) > 20
     and not exists (select 1 from push_subscriptions where endpoint = p_endpoint) then
    return false;
  end if;

  insert into push_subscriptions (id, customer_id, endpoint, p256dh, auth, user_agent)
  values (encode(gen_random_bytes(12),'hex'), p_id, p_endpoint, p_p256dh, p_auth, left(coalesce(p_ua,''), 200))
  on conflict (endpoint) do update
     set customer_id = excluded.customer_id,
         p256dh      = excluded.p256dh,
         auth        = excluded.auth,
         user_agent  = excluded.user_agent,
         fail_count  = 0
   -- Knowing an endpoint is not owning it. The row is refreshed for its own account, or moved
   -- to another only by the browser that holds its secret (one device, a new account).
   where push_subscriptions.customer_id = excluded.customer_id
      or push_subscriptions.auth = excluded.auth;
  get diagnostics n = row_count;
  return n > 0;
end $$;


-- ── 11. rider_register: every word of a name two letters or more (patched from live) ───────────
do $rr$
declare d text;
begin
  d := pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text)'::regprocedure);
  if position('(20261004100000)' in d) > 0 then
    raise notice 'rider_register already patched; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
    E'  if not _name_chars_ok(v_name) then return jsonb_build_object(''ok'', false, ''error'', ''name_chars''); end if;\n',
    E'  if not _name_chars_ok(v_name) then return jsonb_build_object(''ok'', false, ''error'', ''name_chars''); end if;\n'
 || E'  -- Every word at least two letters, the customers'' rule; the desk is exempt, as staff are (20261004100000).\n'
 || E'  if not v_staff and not _name_parts_ok(v_name) then return jsonb_build_object(''ok'', false, ''error'', ''name_chars'', ''why'', ''short''); end if;\n');
  d := pg_temp._once(d,
    E'    if v_cname <> '''' and not _name_chars_ok(v_cname) then return jsonb_build_object(''ok'', false, ''error'', ''rider_name_chars'', ''rider'', v_i + 2); end if;\n',
    E'    if v_cname <> '''' and not _name_chars_ok(v_cname) then return jsonb_build_object(''ok'', false, ''error'', ''rider_name_chars'', ''rider'', v_i + 2); end if;\n'
 || E'    if v_cname <> '''' and not v_staff and not _name_parts_ok(v_cname) then return jsonb_build_object(''ok'', false, ''error'', ''rider_name_chars'', ''rider'', v_i + 2, ''why'', ''short''); end if;\n');
  execute d;
end $rr$;


-- ── 12. vendor_logout ──────────────────────────────────────────────────────────────────────────
create or replace function public.vendor_logout(p_uid text, p_token text)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  if coalesce(p_uid, '') !~ '^[0-9]{1,18}$' or coalesce(p_token, '') = '' then return; end if;
  -- The login's token ends (every device it was handed to); the next sign-in makes a new one.
  update vendor_users set session_token = null
   where id = p_uid::bigint and session_token = p_token;
end $$;
revoke all on function public.vendor_logout(text, text) from public;
grant execute on function public.vendor_logout(text, text) to anon, authenticated;


-- ── 13. the per-booker caps take a lock before counting ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._group_ride_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _live int; _cap int;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;

  select case when coalesce(s.ride_kind, '') = 'event' then 5 else 2 end into _cap
    from sessions s
   where s.id = new.session_id
     and s.event_kind = 'community'
     and coalesce(s.needs_approval,false) = false;
  if _cap is null then return new; end if;

  -- Two bookings sent at once by one account take turns (20261004100000).
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and coalesce(q.status,'') not in ('cancelled','removed','noshow')
     and q.id <> new.id;

  if _live >= _cap then
    raise exception 'Up to % riders per booking on this ride.', _cap using detail = 'GROUP_CAP';
  end if;

  return new;
end $function$;

CREATE OR REPLACE FUNCTION public._solo_ride_cap()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare _live int;
begin
  if new.customer_id is null or (select is_staff()) then return new; end if;

  if not exists (select 1 from sessions s
                  where s.id = new.session_id
                    and s.event_kind = 'community'
                    and coalesce(s.needs_approval, false) = true) then
    return new;
  end if;

  -- Two bookings sent at once by one account take turns (20261004100000).
  perform pg_advisory_xact_lock(hashtext('ridecap:' || coalesce(new.session_id, '') || ':' || new.customer_id));
  select count(*) into _live
    from queue_entries q
   where q.session_id = new.session_id
     and q.customer_id = new.customer_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow')
     and q.id <> new.id;

  if _live >= 1 then
    raise exception 'One place per person on this session.' using detail = 'ONE_PER_SESSION';
  end if;

  return new;
end $function$;


-- ── checks ─────────────────────────────────────────────────────────────────────────────────────
do $chk$
begin
  if exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and not p.prosecdef
               and p.proname in ('customer_change_password','_pin_ok','staff_my_settings','staff_merge_customers',
                                 'staff_unmerge_customers','customer_booking_update','badge_weeks','_vendor_session_fill',
                                 'customer_push_subscribe','rider_register','vendor_logout','_group_ride_cap','_solo_ride_cap')) then
    raise exception 'a function lost SECURITY DEFINER';
  end if;
  if position('(20261004100000)' in pg_get_functiondef('public.customer_booking_update(text,text,text,jsonb)'::regprocedure)) = 0
     or position('(20261004100000)' in pg_get_functiondef('public.rider_register(text,text,integer,text,text,text,text,text,jsonb,text)'::regprocedure)) = 0 then
    raise exception 'a patch did not take';
  end if;
  if has_function_privilege('anon', 'public.community_apply(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.learn_apply(jsonb)', 'execute') then
    raise exception 'the old application forms are still open';
  end if;
end $chk$;


-- ── the ledger: 2026-10-03 migrations applied by hand without a row, and this one ──────────────
insert into supabase_migrations.schema_migrations (version, name) values
  ('20261003120000', 'customer_password_and_purchases'),
  ('20261003130000', 'saturday_badge_ladder'),
  ('20261003150001', 'rating_detail'),
  ('20261003210001', 'booking_needs_waiver'),
  ('20261003220001', 'rider_register_needs_waiver'),
  ('20261004100000', 'review_fixes_oct4')
on conflict do nothing;

commit;
