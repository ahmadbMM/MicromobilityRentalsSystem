-- ============================================================================
-- Business settings (Staff app research 2026-10-09, M7), 2026-10-09.
--
-- The values an admin changes without a deploy live in staff_options 'biz' (one row, items = a
-- JSON object: VAT, caps, times, lists, reasons, fitting, reorder rule, KPI targets, approvals,
-- retention). The booking app keeps every built-in constant as the default, so nothing moves until
-- an admin saves a value.
--
--  1. staff_options: any staffer still reads and writes the shared lists (bike brands, inventory
--     categories, saved views...), but the 'biz' row is an admin's alone. The old "staff full"
--     policy is split into a read policy and write policies that refuse 'biz' to non-admins.
--  2. _audit_keyed(): the audit trigger for tables keyed by something other than id / user_id
--     (staff_options.key, ride_prices.type); the column is the trigger's argument. staff_options is
--     audited for 'biz' and 'views', ride_prices for every row.
--  3. staff_set_biz(p_patch): admins merge a patch into 'biz' (a key set to null goes back to the
--     built-in value), the change is logged in staff_actions with the account, and the keys a
--     rider's page reads are copied to site_content 'biz.public' (public read): the rider's page
--     cannot read staff_options.
--  4. _biz_int(key, default): a whole number from the settings, else the default (out of range,
--     missing, not a number: the default).
--  5. _group_ride_cap: the three caps (2 on a group ride, 5 on an event, 3 per account on the
--     circuit) are read from the settings group_ride_max / event_seat_max / jcc_account_cap, the
--     same values the booking app shows, with today's numbers as the defaults.
--
-- Rollback: drop function public.staff_set_biz(jsonb); drop function public._biz_int(text,int);
--   restore the "staff full" policy (for all using/with check (select is_staff())) and drop
--   staff_options_read / _ins / _upd / _del; drop the two audit triggers and public._audit_keyed();
--   re-run the saved pg_get_functiondef of public._group_ride_cap() (every changed line carries
--   "(20261009160000)"). site_content 'biz.public' may stay (it only mirrors).
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

-- ── 1. staff_options: 'biz' is an admin's ───────────────────────────────────────────────────
drop policy if exists "staff full" on public.staff_options;
drop policy if exists staff_options_read on public.staff_options;
drop policy if exists staff_options_ins on public.staff_options;
drop policy if exists staff_options_upd on public.staff_options;
drop policy if exists staff_options_del on public.staff_options;
create policy staff_options_read on public.staff_options for select
  using ((select is_staff()));
create policy staff_options_ins on public.staff_options for insert
  with check ((select is_staff()) and (key <> 'biz' or (select is_admin())));
create policy staff_options_upd on public.staff_options for update
  using ((select is_staff()) and (key <> 'biz' or (select is_admin())))
  with check ((select is_staff()) and (key <> 'biz' or (select is_admin())));
create policy staff_options_del on public.staff_options for delete
  using ((select is_staff()) and (key <> 'biz' or (select is_admin())));

-- ── 2. The audit trigger for rows keyed by another column ───────────────────────────────────
create or replace function public._audit_keyed()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  o jsonb; n jsonb; ch jsonb := '{}'::jsonb; k text; col text := coalesce(tg_argv[0], 'id');
  hide text[] := array['updated_at'];
begin
  if tg_op = 'DELETE' then
    o := to_jsonb(old) - hide;
    insert into audit_log (tbl, row_id, op, changed) values (tg_table_name, o ->> col, 'DELETE', o);
    return null;
  end if;
  n := to_jsonb(new) - hide;
  if tg_op = 'INSERT' then
    insert into audit_log (tbl, row_id, op, changed) values (tg_table_name, n ->> col, 'INSERT', n);
    return null;
  end if;
  o := to_jsonb(old) - hide;
  for k in select key from jsonb_each(n) loop
    if n -> k is distinct from o -> k then
      ch := ch || jsonb_build_object(k, jsonb_build_object('old', o -> k, 'new', n -> k));
    end if;
  end loop;
  if ch = '{}'::jsonb then return null; end if;
  insert into audit_log (tbl, row_id, op, changed) values (tg_table_name, n ->> col, 'UPDATE', ch);
  return null;
end $$;
revoke execute on function public._audit_keyed() from public, anon, authenticated;

-- (a WHEN may name NEW only on insert / update and OLD only on delete: two triggers)
drop trigger if exists staff_options_audit on public.staff_options;
create trigger staff_options_audit
  after insert or update on public.staff_options
  for each row
  when (new.key in ('biz', 'views'))
  execute function public._audit_keyed('key');
drop trigger if exists staff_options_audit_del on public.staff_options;
create trigger staff_options_audit_del
  after delete on public.staff_options
  for each row
  when (old.key in ('biz', 'views'))
  execute function public._audit_keyed('key');

drop trigger if exists ride_prices_audit on public.ride_prices;
create trigger ride_prices_audit
  after insert or update or delete on public.ride_prices
  for each row execute function public._audit_keyed('type');

-- ── 4. A whole number from the settings ─────────────────────────────────────────────────────
create or replace function public._biz_int(p_key text, p_default int)
returns int
language sql stable security definer set search_path to 'public'
as $$
  select coalesce((
    select case when jsonb_typeof(o.items -> p_key) = 'number'
                 and (o.items ->> p_key)::numeric = trunc((o.items ->> p_key)::numeric)
                 and (o.items ->> p_key)::numeric between 1 and 1000
                then (o.items ->> p_key)::int end
      from staff_options o where o.key = 'biz'), p_default)
$$;
revoke execute on function public._biz_int(text, int) from public, anon, authenticated;

-- ── 3. Admins save the settings ─────────────────────────────────────────────────────────────
create or replace function public.staff_set_biz(p_patch jsonb)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare
  cur jsonb; nxt jsonb; k text; pub jsonb := '{}'::jsonb;
  pub_keys text[] := array['group_ride_max','event_seat_max','jcc_account_cap','rg_low','default_price',
                           'cancel_off','cancel_custom','addr','hours','vat_no'];
  who text;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'BAD_PATCH' using errcode = '22023'; end if;
  if length(p_patch::text) > 20000 then raise exception 'TOO_BIG' using errcode = '22023'; end if;
  select items into cur from staff_options where key = 'biz' for update;
  if cur is null or jsonb_typeof(cur) <> 'object' then cur := '{}'::jsonb; end if;
  nxt := cur;
  for k in select key from jsonb_each(p_patch) loop
    if k !~ '^[a-z_]{2,40}$' then raise exception 'BAD_KEY' using errcode = '22023'; end if;
    if jsonb_typeof(p_patch -> k) = 'null' then nxt := nxt - k; else nxt := nxt || jsonb_build_object(k, p_patch -> k); end if;
  end loop;
  insert into staff_options (key, items, updated_at) values ('biz', nxt, now())
    on conflict (key) do update set items = excluded.items, updated_at = excluded.updated_at;
  foreach k in array pub_keys loop
    if nxt ? k then pub := pub || jsonb_build_object(k, nxt -> k); end if;
  end loop;
  select coalesce(nullif(btrim(s.display_name), ''), u.email) into who
    from staff s left join auth.users u on u.id = s.user_id where s.user_id = auth.uid();
  insert into site_content (key, value, updated_by) values ('biz.public', pub, left(coalesce(who, 'admin'), 80))
    on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by;
  insert into staff_actions (at, action, who, device, view, user_id)
    values (to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            left('Business settings: ' || (select string_agg(x, ', ') from jsonb_object_keys(p_patch) x), 300),
            left(coalesce(who, 'admin'), 80), 'server', 'settings', auth.uid());
  return nxt;
end $$;
revoke execute on function public.staff_set_biz(jsonb) from public, anon;
grant execute on function public.staff_set_biz(jsonb) to authenticated;

-- ── 5. _group_ride_cap reads the caps from the settings ─────────────────────────────────────
do $gc$
declare d text;
begin
  d := pg_get_functiondef('public._group_ride_cap()'::regprocedure);
  if position('(20261009160000)' in d) > 0 then
    raise notice '_group_ride_cap already reads the settings; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$                        when coalesce(s.ride_kind, '') = 'event' then 5 else 2 end
              else 3 end,$a$,
$b$                        when coalesce(s.ride_kind, '') = 'event' then _biz_int('event_seat_max', 5)
                        else _biz_int('group_ride_max', 2) end
              else _biz_int('jcc_account_cap', 3) end,  -- Settings > Business (20261009160000)$b$);
  execute d;
end $gc$;

-- ── Checks ──────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array['public.staff_set_biz(jsonb)', 'public._group_ride_cap()', 'public._biz_int(text,integer)', 'public._audit_keyed()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if has_function_privilege('anon', f, 'execute') then raise exception '% is executable by anon', f; end if;
  end loop;
  if position('(20261009160000)' in pg_get_functiondef('public._group_ride_cap()'::regprocedure)) = 0 then
    raise exception '_group_ride_cap was not patched';
  end if;
  if not has_function_privilege('authenticated', 'public.staff_set_biz(jsonb)', 'execute') then
    raise exception 'staff_set_biz lost its authenticated grant';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009160000', 'business_settings')
on conflict (version) do nothing;

commit;
