-- ============================================================================
-- Staff functions and triggers: the 2026-10-07 bug hunt, database half (staff side). Each patch is
-- made in place from the live definition (pg_get_functiondef, so SECURITY DEFINER, search_path,
-- volatility and grants stay as they are); every anchor must match exactly once.
--
--  1. staff_set_access refused (SECTION, 22023) any section list that named Vendors. The staff page
--     has had a Vendors section since 2026-10-03 and an admin account's list carries it, so limiting
--     an admin to some sections failed whenever Vendors was among them. 'vendors' joins the list.
--  2. staff_my_settings dropped 'vlate' (a venue's late cancellation, the bell's newest kind) from
--     the notifications an account turns off, so the switch in Settings sprang back on and the
--     alert kept coming. 'vlate' joins the list.
--  3. _staff_ref_broadcast sent the other staff devices only the columns the rider list had on
--     2026-09-21. The list has since carried merged_into, deletion_requested_at, ride_news(_at),
--     heard_from, profession and workplace (staff_sync returns all of them), and a change to only
--     those was not broadcast at all: an account merged on one device stayed on every other one's
--     lists, and a deletion request reached the bell, until the next whole read (up to half an hour
--     while the live channel is up). They are broadcast now. updated_at stays out (every write
--     moves it), and so does the photo (a staff device never holds one).
--  4. customer_tags: a row whose key changed (staff_merge_customers moves the dropped account's
--     tags to the keeper, staff_unmerge_customers moves them back) left no tombstone, so each staff
--     device's synced copy kept the old key: after an undone merge the keeper still showed the tags
--     that had gone back, until the fortnightly whole read. The old key is now tombstoned when it
--     moves (zz_sync_tombstone_key, the same _sync_tombstone the delete uses).
--  5. staff_unmerge_customers cleared every field the merge had filled in on the keeper, also one
--     the keeper had changed since (a birth date corrected after the merge was wiped by the undo).
--     It clears a field only while the keeper still holds the dropped account's value; the dropped
--     account cannot edit itself while merged, so that value is the one the merge copied.
--  6. staff_community_new_password made a temporary password for an account merged into another
--     since the approval. A merged account signs in as its keeper (customer_login), so the code
--     opened the keeper's account without asking for a new password there. It now answers 'missing'
--     for a merged account, as staff_learn_new_password always has (the page says the account is gone).
--  7. staff_vendor_venue_save left a venue's confirmed Saturdays as they were: a name, map link or
--     offer staff corrected kept the old one on the ride ("Breakfast at ...") until another booking
--     was decided. It now resyncs the venue's confirmed days still ahead, as vendor_profile_save does
--     for a venue's own edit, and leaves a stop staff typed by hand on the ride (p_keep_hand).
--  8. staff_community_approve gave the Community tag with "on conflict do nothing", so an applicant
--     whose Community grant had lapsed (expired, or dated to start later: not _ctag_active) stayed
--     without membership after the approval. A lapsed grant now becomes a permanent one, as the
--     insert would make it (no start or end, added by / at / note of the approval); a grant still in
--     force, time-limited or not, stays as it is. The booking app's approve dialog does the same on
--     its side since 2026-10-07 (it replaces an expired row); both together are harmless.
--
-- Rollback: re-run the saved pg_get_functiondef of staff_set_access, staff_my_settings,
--   _staff_ref_broadcast, staff_unmerge_customers, staff_community_new_password,
--   staff_vendor_venue_save and staff_community_approve from before this migration (or reverse each
--   patch below: every changed line carries "(20261007120100)");
--   drop trigger if exists zz_sync_tombstone_key on public.customer_tags;
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


-- ── 1. staff_set_access: the Vendors section ─────────────────────────────────────────────────
do $sa$
declare d text;
begin
  d := pg_get_functiondef('public.staff_set_access(uuid,text,text[],text[])'::regprocedure);
  if position('(20261007120100)' in d) > 0 then
    raise notice 'staff_set_access already takes vendors; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$'ambassadors','website','catalog','messages','analytics','history','team'];$a$,
$b$'ambassadors','vendors','website','catalog','messages','analytics','history','team'];  -- vendors: the section since 2026-10-03 (20261007120100)$b$);
  execute d;
end $sa$;


-- ── 2. staff_my_settings: the venue-late notification can be turned off ──────────────────────
do $ms$
declare d text;
begin
  d := pg_get_functiondef('public.staff_my_settings(text,text,boolean,text[])'::regprocedure);
  if position('(20261007120100)' in d) > 0 then
    raise notice 'staff_my_settings already keeps vlate; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$k in ('long','ws','apps','learn','bday','msgs','attn','lowrate','stock');$a$,
$b$k in ('long','ws','apps','learn','bday','msgs','attn','lowrate','stock','vlate');  -- vlate: a venue's late cancellation (20261007120100)$b$);
  execute d;
end $ms$;


-- ── 3. _staff_ref_broadcast: every column the desk's rider list holds ────────────────────────
do $rb$
declare d text;
begin
  d := pg_get_functiondef('public._staff_ref_broadcast()'::regprocedure);
  if position('(20261007120100)' in d) > 0 then
    raise notice '_staff_ref_broadcast already sends the later columns; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$    'hidden_types','fix_fields','apple_email'];$a$,
$b$    'hidden_types','fix_fields','apple_email',
    -- and the rest staff_sync hands the desk (20261007120100): a merge, a deletion request, the
    -- ride-news choice and the about-fields reached the other devices only at the next whole read
    'ride_news_at','ride_news','deletion_requested_at','merged_into','heard_from','profession','workplace'];$b$);
  execute d;
end $rb$;


-- ── 4. customer_tags: a key that moves leaves a tombstone ────────────────────────────────────
drop trigger if exists zz_sync_tombstone_key on public.customer_tags;
create trigger zz_sync_tombstone_key
  after update of customer_id, tag_id on public.customer_tags
  for each row
  when (old.customer_id is distinct from new.customer_id or old.tag_id is distinct from new.tag_id)
  execute function public._sync_tombstone('customer_id', 'tag_id');
comment on trigger zz_sync_tombstone_key on public.customer_tags is
  'A tag moved to another account (a merge, or its undo) leaves its old key in sync_deletions, as a delete does, '
  'so staff devices drop it from their synced copy (20261007120100).';


-- ── 5. staff_unmerge_customers: a value the keeper set since is its own ──────────────────────
do $um$
declare d text;
begin
  d := pg_get_functiondef('public.staff_unmerge_customers(bigint)'::regprocedure);
  if position('(20261007120100)' in d) > 0 then
    raise notice 'staff_unmerge_customers already keeps the keeper''s own values; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$    if col = any(cols) then execute format('update customers set %I = null where id = $1', col) using m.keep_id; end if;$a$,
$b$    -- only while the keeper still holds the value it was given: one it set since is its own (20261007120100)
    if col = any(cols) then
      execute format('update customers k set %I = null from customers d where k.id = $1 and d.id = $2 and k.%I is not distinct from d.%I',
                     col, col, col)
        using m.keep_id, m.drop_id;
    end if;$b$);
  execute d;
end $um$;


-- ── 6. staff_community_new_password: never for a merged account ──────────────────────────────
do $np$
declare d text;
begin
  d := pg_get_functiondef('public.staff_community_new_password(uuid)'::regprocedure);
  if position('(20261007120100)' in d) > 0 then
    raise notice 'staff_community_new_password already refuses a merged account; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$  if c.id is null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;$a$,
$b$  -- an account merged into another signs in as its keeper: no password of its own (20261007120100)
  if c.id is null or c.merged_into is not null then return jsonb_build_object('ok', false, 'error', 'missing'); end if;$b$);
  execute d;
end $np$;


-- ── 7. staff_vendor_venue_save: the confirmed Saturdays follow ───────────────────────────────
do $vv$
declare d text;
begin
  d := pg_get_functiondef('public.staff_vendor_venue_save(jsonb)'::regprocedure);
  if position('(20261007120100)' in d) > 0 then
    raise notice 'staff_vendor_venue_save already resyncs; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$   where id = vid;
  return vid;$a$,
$b$   where id = vid;
  -- the venue's confirmed Saturdays still ahead show what was saved, as vendor_profile_save does;
  -- a stop staff typed by hand on a ride stays (20261007120100)
  perform _vendor_sync_day(b.day, true) from vendor_bookings b
   where b.venue_id = vid and b.status = 'confirmed' and b.day >= _vendor_today();
  return vid;$b$);
  execute d;
end $vv$;


-- ── 8. staff_community_approve: a lapsed Community grant becomes a permanent one ─────────────
do $ca$
declare d text;
begin
  d := pg_get_functiondef('public.staff_community_approve(uuid,text,boolean)'::regprocedure);
  if position('(20261007120100)' in d) > 0 then
    raise notice 'staff_community_approve already renews a lapsed grant; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$    on conflict (customer_id, tag_id) do nothing;$a$,
$b$    -- a lapsed grant (expired, or dated to start later) gives way to a permanent one, as the insert
    -- would make it; a grant in force stays as it is (20261007120100)
    on conflict (customer_id, tag_id) do update
       set starts_at = null, expires_at = null,
           added_by = excluded.added_by, added_at = excluded.added_at, note = excluded.note
     where not _ctag_active(customer_tags.starts_at, customer_tags.expires_at);$b$);
  execute d;
end $ca$;


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array[
    'public.staff_set_access(uuid,text,text[],text[])',
    'public.staff_my_settings(text,text,boolean,text[])',
    'public._staff_ref_broadcast()',
    'public.staff_unmerge_customers(bigint)',
    'public.staff_community_new_password(uuid)',
    'public.staff_vendor_venue_save(jsonb)',
    'public.staff_community_approve(uuid,text,boolean)'] loop
    if position('(20261007120100)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '% was not patched', f;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then
      raise exception '% is executable by anon', f;
    end if;
    if f <> 'public._staff_ref_broadcast()' and not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost its authenticated grant', f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public._staff_ref_broadcast()', 'execute') then
    raise exception '_staff_ref_broadcast is executable by a client';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'zz_sync_tombstone_key' and tgrelid = 'public.customer_tags'::regclass) then
    raise exception 'zz_sync_tombstone_key is missing';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007120100', 'bug_hunt_staff')
on conflict (version) do nothing;

commit;
