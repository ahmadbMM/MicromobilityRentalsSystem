-- Part-timers and the hours they work (the owner, 2026-10-07: "create me a part timers logging system that i
-- type in the number of hours a part timer has worked for and the amount of money for each hour and you give
-- me the total for a date range or a number of sessions i choose"; "part timers are added with their staff
-- accounts").
--
-- part_timers: a staff account marked as a part-timer, with the hourly rate a new entry starts from. The
--   name is kept on the row (the account's display name or email when it was added, editable), so the
--   hours and what was paid still read with a name after the account itself is removed - which is also why
--   user_id is not a foreign key to staff.
-- part_timer_shifts: one row per stretch of work - a day, and the ride it was for when there was one - with
--   the hours and the rate of THAT entry (a rate changed later does not rewrite what is owed for the past).
--   amount is computed by the table, so every screen and report adds the same number.
-- staff_part_timer_accounts(): the staff accounts an admin can pick from (email, display name, role).
-- Admins only, read and write: pay is not a desk matter (Team is an admin section).

begin;

create table if not exists public.part_timers (
  user_id     uuid primary key,
  name        text not null check (length(trim(name)) between 2 and 80),
  rate        numeric(8,2) not null default 0 check (rate >= 0 and rate <= 10000),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.part_timer_shifts (
  id             bigint generated always as identity primary key,
  part_timer_id  uuid not null references public.part_timers(user_id) on delete restrict,
  work_date      date not null,
  -- the ride the hours were for; a ride purged later leaves the hours on their day
  session_id     text references public.sessions(id) on delete set null,
  hours          numeric(5,2) not null check (hours > 0 and hours <= 24),
  rate           numeric(8,2) not null check (rate >= 0 and rate <= 10000),
  amount         numeric(10,2) generated always as (round(hours * rate, 2)) stored,
  note           text not null default '' check (length(note) <= 300),
  created_at     timestamptz not null default now(),
  created_by     uuid,
  updated_at     timestamptz not null default now()
);
create index if not exists part_timer_shifts_date_idx on public.part_timer_shifts (work_date);
create index if not exists part_timer_shifts_session_idx on public.part_timer_shifts (session_id);
create index if not exists part_timer_shifts_person_idx on public.part_timer_shifts (part_timer_id, work_date);

-- who and when are the table's own: stamped on insert, kept on update
create or replace function public._pt_shift_touch()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
revoke all on function public._pt_shift_touch() from public, anon, authenticated;

drop trigger if exists part_timer_shifts_touch on public.part_timer_shifts;
create trigger part_timer_shifts_touch before insert or update on public.part_timer_shifts
  for each row execute function public._pt_shift_touch();

do $rls$
declare t text;
begin
  foreach t in array array['part_timers','part_timer_shifts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || ' admin all', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t || ' admin all', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $rls$;

-- The staff accounts to pick a part-timer from (staff_team_list's rows, with the display name).
create or replace function public.staff_part_timer_accounts()
returns table(user_id uuid, email text, display_name text, role text)
language plpgsql
stable
security definer
set search_path to 'public'
as $fn$
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  return query
    select s.user_id, u.email::text, s.display_name, s.role
      from staff s left join auth.users u on u.id = s.user_id
     order by coalesce(nullif(trim(s.display_name), ''), u.email::text);
end
$fn$;
revoke all on function public.staff_part_timer_accounts() from public, anon;
grant execute on function public.staff_part_timer_accounts() to authenticated;

do $chk$
begin
  if has_table_privilege('anon', 'public.part_timers', 'select')
     or has_table_privilege('anon', 'public.part_timer_shifts', 'select') then
    raise exception 'anon can read the part-timer tables';
  end if;
  if not has_table_privilege('authenticated', 'public.part_timer_shifts', 'insert') then
    raise exception 'staff cannot log hours';
  end if;
  if (select count(*) from pg_policies where schemaname = 'public'
        and tablename in ('part_timers','part_timer_shifts')) <> 2 then
    raise exception 'the admin policies are missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'part_timer_shifts_touch' and not tgisinternal) then
    raise exception 'part_timer_shifts_touch is missing';
  end if;
  if not (select prosecdef from pg_proc where proname = 'staff_part_timer_accounts')
     or has_function_privilege('anon', 'public.staff_part_timer_accounts()', 'execute') then
    raise exception 'staff_part_timer_accounts carries the wrong attributes';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007210000', 'part_timers')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
