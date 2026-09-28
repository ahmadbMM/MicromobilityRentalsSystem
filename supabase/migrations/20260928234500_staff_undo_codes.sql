-- ============================================================================
-- Undo codes (the owner, 2026-09-28).
--
-- Only an admin undoes an action on the staff page (History > Log and the topbar's Undo), and
-- every undo is confirmed with a 6-digit code the admin chose. An admin without a code is asked
-- for one when they sign in or next open the staff page; the other roles are never asked and
-- cannot undo.
--
-- The hash is never readable from the app: the table has RLS on and no policy, and every read
-- and write goes through the definer functions below. A 6-digit code's bcrypt hash falls to a
-- laptop, so it must not be selectable at all. A code is checked here, 5 tries then a 60-second
-- lock (login_throttle, key 'undo:<user id>'), as the operator PINs are.
-- An admin sets their own code once. A forgotten code is cleared from the SQL editor
-- (delete from public.staff_undo_codes where user_id = '<id>'), and its admin is asked again.
-- ============================================================================

create table if not exists public.staff_undo_codes (
  user_id uuid primary key references public.staff(user_id) on delete cascade,
  code_hash text not null,
  set_at timestamptz not null default now()
);
alter table public.staff_undo_codes enable row level security;
revoke all on public.staff_undo_codes from public, anon, authenticated;

-- {admin, has_code} for the signed-in account.
create or replace function public.staff_undo_code_state()
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if not is_staff() then raise exception 'STAFF_ONLY' using errcode = '42501'; end if;
  return jsonb_build_object('admin', is_admin(),
    'has_code', exists(select 1 from staff_undo_codes where user_id = auth.uid()));
end $$;

-- An admin chooses their own code, once: {ok:true}, or CODE_EXISTS when there already is one.
create or replace function public.staff_set_undo_code(p_code text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if coalesce(p_code, '') !~ '^[0-9]{6}$' then raise exception 'CODE_FORMAT' using errcode = '22023'; end if;
  insert into staff_undo_codes (user_id, code_hash) values (auth.uid(), crypt(p_code, gen_salt('bf', 8)))
  on conflict (user_id) do nothing;
  if not found then raise exception 'CODE_EXISTS' using errcode = '23505'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- Check the signed-in admin's code. {ok:true} | {ok:false, reason:'wrong', left:n} |
-- {ok:false, reason:'locked', seconds:n} | {ok:false, reason:'no_code'}.
create or replace function public.staff_check_undo_code(p_code text)
returns jsonb
language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare
  h text;
  k text := 'undo:' || coalesce(auth.uid()::text, '');
  lt login_throttle%rowtype;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select code_hash into h from staff_undo_codes where user_id = auth.uid();
  if h is null then return jsonb_build_object('ok', false, 'reason', 'no_code'); end if;
  select * into lt from login_throttle where identifier = k for update;
  if found and lt.locked_until is not null and lt.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', ceil(extract(epoch from lt.locked_until - now()))::int);
  end if;
  if coalesce(p_code, '') ~ '^[0-9]{6}$' and crypt(p_code, h) = h then
    delete from login_throttle where identifier = k;
    return jsonb_build_object('ok', true);
  end if;
  insert into login_throttle as l (identifier, fails, locked_until, updated_at) values (k, 1, null, now())
  on conflict (identifier) do update
    set fails = case when l.locked_until is not null and l.locked_until <= now() then 1 else l.fails + 1 end,
        locked_until = null, updated_at = now()
  returning * into lt;
  if lt.fails >= 5 then
    update login_throttle set fails = 0, locked_until = now() + interval '60 seconds' where identifier = k;
    return jsonb_build_object('ok', false, 'reason', 'locked', 'seconds', 60);
  end if;
  return jsonb_build_object('ok', false, 'reason', 'wrong', 'left', 5 - lt.fails);
end $$;

revoke execute on function public.staff_undo_code_state() from public, anon;
revoke execute on function public.staff_set_undo_code(text) from public, anon;
revoke execute on function public.staff_check_undo_code(text) from public, anon;
grant execute on function public.staff_undo_code_state() to authenticated;
grant execute on function public.staff_set_undo_code(text) to authenticated;
grant execute on function public.staff_check_undo_code(text) to authenticated;
