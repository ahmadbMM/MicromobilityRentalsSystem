-- A staff account's own preferences (2026-10-09, report section 4 "Customisation that staff would use").
--
-- staff.prefs (jsonb, '{}' by default) holds what follows the person to every device:
--   start            the section the staff page opens on when no address names one
--   tabbar           up to four sections for the phone tab bar
--   ntread           the bell's read state: {b:{kind:iso time last marked all read}, ids:{kind:[newest ids read]}}
--   state.<section>  the last filters, sorts and layouts of a section (Bookings, History, Bikes, ...)
--   views.<section>  reserved for named saved views
-- The table keeps its one policy (staff read self); the account's row is read whole at sign-in (select *),
-- so the column comes with it (authenticated holds table-level SELECT). Nobody writes it directly:
-- staff_my_prefs(p_set) merges the given keys into the caller's own row only. A key set to null is removed;
-- a key the function does not know is ignored (an older or newer page); ntread keeps, per kind, the latest
-- "marked all read" of any device (b) and the ids read as the last device to send that kind holds them (80 at most). Each value is at most 8000 characters (ntread 32000), the whole at most
-- 64000. Called with nothing, it returns the caller's prefs.
--
-- The page works without this migration: it keeps the same choices in this device's storage and sends
-- them up once the function exists.
--
-- Rollback: drop function if exists public.staff_my_prefs(jsonb); alter table public.staff drop column if exists prefs;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

alter table public.staff add column if not exists prefs jsonb not null default '{}'::jsonb;

create or replace function public.staff_my_prefs(p_set jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  _uid uuid := auth.uid(); _cur jsonb; _k text; _v jsonb; _old jsonb; _kind text; _ids jsonb; _b jsonb;
begin
  if _uid is null or not exists (select 1 from staff where user_id = _uid) then
    raise exception 'NOT_STAFF' using errcode = '42501';
  end if;
  select coalesce(prefs, '{}'::jsonb) into _cur from staff where user_id = _uid for update;
  if jsonb_typeof(_cur) <> 'object' then _cur := '{}'::jsonb; end if;
  if p_set is null then return _cur; end if;
  if jsonb_typeof(p_set) <> 'object' then
    raise exception 'BAD_PREFS' using errcode = '22023';
  end if;
  for _k, _v in select key, value from jsonb_each(p_set) loop
    continue when _k !~ '^(start|tabbar|ntread|state\.[a-z]{1,20}|views\.[a-z]{1,20})$';
    if jsonb_typeof(_v) = 'null' then
      _cur := _cur - _k;
      continue;
    end if;
    if length(_v::text) > (case when _k = 'ntread' then 32000 else 8000 end) then
      raise exception 'PREF_TOO_BIG' using errcode = '22023';
    end if;
    if _k = 'start' and (jsonb_typeof(_v) <> 'string' or length(_v #>> '{}') > 20) then
      raise exception 'BAD_PREFS' using errcode = '22023';
    end if;
    if _k = 'tabbar' and (jsonb_typeof(_v) <> 'array' or jsonb_array_length(_v) > 4) then
      raise exception 'BAD_PREFS' using errcode = '22023';
    end if;
    if _k ~ '^(ntread|state\.|views\.)' and jsonb_typeof(_v) not in ('object', 'array') then
      raise exception 'BAD_PREFS' using errcode = '22023';
    end if;
    if _k = 'ntread' then
      if jsonb_typeof(_v) <> 'object' then raise exception 'BAD_PREFS' using errcode = '22023'; end if;
      _old := case when jsonb_typeof(_cur -> 'ntread') = 'object' then _cur -> 'ntread' else '{}'::jsonb end;
      -- the newest "marked all read" per kind
      _b := case when jsonb_typeof(_old -> 'b') = 'object' then _old -> 'b' else '{}'::jsonb end;
      if jsonb_typeof(_v -> 'b') = 'object' then
        for _kind in select key from jsonb_each_text(_v -> 'b') loop
          if jsonb_typeof(_v -> 'b' -> _kind) = 'string'
             and coalesce(_b ->> _kind, '') < (_v -> 'b' ->> _kind) then
            _b := jsonb_set(_b, array[_kind], _v -> 'b' -> _kind, true);
          end if;
        end loop;
      end if;
      -- the ids read: a kind the device sends is its own list (the newest 80; what left the device's list is
      -- left out, so a thing that comes back is news again); kinds it does not send stay as they were
      _ids := case when jsonb_typeof(_old -> 'ids') = 'object' then _old -> 'ids' else '{}'::jsonb end;
      if jsonb_typeof(_v -> 'ids') = 'object' then
        for _kind in select key from jsonb_each(_v -> 'ids') where jsonb_typeof(value) = 'array' loop
          _ids := jsonb_set(_ids, array[_kind], (
            select coalesce(jsonb_agg(x.value order by x.ord), '[]'::jsonb) from (
              select value, ord from jsonb_array_elements(_v -> 'ids' -> _kind) with ordinality as y(value, ord)
               where jsonb_typeof(value) = 'string'
               order by ord desc limit 80) x), true);
        end loop;
      end if;
      _v := jsonb_build_object('b', _b, 'ids', _ids);
    end if;
    _cur := jsonb_set(_cur, array[_k], _v, true);
  end loop;
  if length(_cur::text) > 64000 then
    raise exception 'PREFS_TOO_BIG' using errcode = '22023';
  end if;
  update staff set prefs = _cur where user_id = _uid;
  return _cur;
end $function$;

revoke all on function public.staff_my_prefs(jsonb) from public, anon;
grant execute on function public.staff_my_prefs(jsonb) to authenticated;

do $chk$
begin
  if not (select prosecdef from pg_proc where oid = 'public.staff_my_prefs(jsonb)'::regprocedure) then
    raise exception 'staff_my_prefs is not SECURITY DEFINER';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009190000', 'staff_prefs')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
