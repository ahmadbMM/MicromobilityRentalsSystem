-- Part-timers, step 2 (the owner, 2026-10-07, answering the questions on 20261007210000: "1 do it, 2 do a, 3 admins
-- only, 4 rate for each kind of work, part timers here are meant for the front desk labor that welcome customers and
-- collect payment and give them their bikes").
--
-- part_timer_kinds: the kinds of front-desk work (welcoming and checking in, taking payment, handing out bikes...),
--   each with its rate per hour. An entry names its kind and starts from that rate; the entry keeps its own rate,
--   so a kind's rate changed later leaves the past as it was.
-- part_timer_payouts: one payment to one part-timer (the day, how, a note, and the hours and money it covered);
--   the entries it paid carry its id. Paid entries are locked: their person, day, ride, kind, hours and rate
--   cannot change and they cannot be deleted, until the payment is undone.
-- staff_pt_pay(ids, day, method, note): pays the unpaid entries among ids, one payment per part-timer.
-- staff_pt_unpay(payout): undoes a payment; its entries are unpaid again.
-- Admins only, as before. payout_id moves only inside these two functions.

begin;

create table if not exists public.part_timer_kinds (
  id          bigint generated always as identity primary key,
  name        text not null check (length(trim(name)) between 2 and 60),
  rate        numeric(8,2) not null check (rate >= 0 and rate <= 10000),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index if not exists part_timer_kinds_name_key on public.part_timer_kinds (lower(trim(name)));

create table if not exists public.part_timer_payouts (
  id             bigint generated always as identity primary key,
  part_timer_id  uuid not null references public.part_timers(user_id) on delete restrict,
  paid_on        date not null,
  method         text not null default 'cash' check (method in ('cash','transfer','other')),
  note           text not null default '' check (length(note) <= 300),
  hours          numeric(8,2) not null default 0,
  amount         numeric(12,2) not null default 0,
  entries        integer not null default 0,
  created_at     timestamptz not null default now(),
  created_by     uuid default auth.uid()
);
create index if not exists part_timer_payouts_person_idx on public.part_timer_payouts (part_timer_id, paid_on);

alter table public.part_timer_shifts
  add column if not exists kind_id bigint references public.part_timer_kinds(id) on delete restrict,
  add column if not exists payout_id bigint references public.part_timer_payouts(id) on delete restrict;
create index if not exists part_timer_shifts_payout_idx on public.part_timer_shifts (payout_id);

-- who and when are the table's own; payout_id moves only inside staff_pt_pay / staff_pt_unpay (the flag
-- mm.pt_pay, local to their transaction); a paid entry keeps what was paid for
create or replace function public._pt_shift_touch()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
declare paying boolean := coalesce(current_setting('mm.pt_pay', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    if new.payout_id is not null and not paying then
      raise exception 'PT_PAY_ONLY' using errcode = '42501';
    end if;
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    if new.payout_id is distinct from old.payout_id and not paying then
      raise exception 'PT_PAY_ONLY' using errcode = '42501';
    end if;
    if old.payout_id is not null and new.payout_id is not distinct from old.payout_id
       and (new.part_timer_id, new.work_date, new.session_id, new.kind_id, new.hours, new.rate)
           is distinct from (old.part_timer_id, old.work_date, old.session_id, old.kind_id, old.hours, old.rate) then
      raise exception 'PT_PAID_LOCKED' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
revoke all on function public._pt_shift_touch() from public, anon, authenticated;

create or replace function public._pt_shift_no_delete_paid()
returns trigger
language plpgsql
set search_path to 'public'
as $fn$
begin
  if old.payout_id is not null then
    raise exception 'PT_PAID_LOCKED' using errcode = '42501';
  end if;
  return old;
end
$fn$;
revoke all on function public._pt_shift_no_delete_paid() from public, anon, authenticated;

drop trigger if exists part_timer_shifts_no_delete_paid on public.part_timer_shifts;
create trigger part_timer_shifts_no_delete_paid before delete on public.part_timer_shifts
  for each row execute function public._pt_shift_no_delete_paid();

do $rls$
declare t text;
begin
  foreach t in array array['part_timer_kinds','part_timer_payouts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || ' admin all', t);
    execute format('create policy %I on public.%I for all to authenticated using ((select public.is_admin())) with check ((select public.is_admin()))', t || ' admin all', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end $rls$;
grant select, insert, update on public.part_timer_kinds to authenticated;
grant select on public.part_timer_payouts to authenticated; -- written by staff_pt_pay / staff_pt_unpay only

create or replace function public.staff_pt_pay(p_shift_ids bigint[], p_paid_on date, p_method text, p_note text)
returns setof public.part_timer_payouts
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  r record;
  pid bigint;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  if p_paid_on is null then raise exception 'PT_NO_DAY' using errcode = '22023'; end if;
  if coalesce(p_method, '') not in ('cash','transfer','other') then raise exception 'PT_BAD_METHOD' using errcode = '22023'; end if;
  perform set_config('mm.pt_pay', '1', true);
  perform 1 from part_timer_shifts where id = any(coalesce(p_shift_ids, '{}')) and payout_id is null for update;
  for r in
    select part_timer_id, sum(hours) h, sum(amount) a, count(*)::int n
      from part_timer_shifts
     where id = any(coalesce(p_shift_ids, '{}')) and payout_id is null
     group by part_timer_id
  loop
    insert into part_timer_payouts (part_timer_id, paid_on, method, note, hours, amount, entries, created_by)
    values (r.part_timer_id, p_paid_on, p_method, left(coalesce(trim(p_note), ''), 300), r.h, r.a, r.n, auth.uid())
    returning id into pid;
    update part_timer_shifts set payout_id = pid
     where id = any(p_shift_ids) and payout_id is null and part_timer_id = r.part_timer_id;
    return query select * from part_timer_payouts where id = pid;
  end loop;
  perform set_config('mm.pt_pay', '', true);
end
$fn$;
revoke all on function public.staff_pt_pay(bigint[], date, text, text) from public, anon;
grant execute on function public.staff_pt_pay(bigint[], date, text, text) to authenticated;

create or replace function public.staff_pt_unpay(p_payout_id bigint)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare n integer;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  perform set_config('mm.pt_pay', '1', true);
  update part_timer_shifts set payout_id = null where payout_id = p_payout_id;
  get diagnostics n = row_count;
  delete from part_timer_payouts where id = p_payout_id;
  perform set_config('mm.pt_pay', '', true);
  return n;
end
$fn$;
revoke all on function public.staff_pt_unpay(bigint) from public, anon;
grant execute on function public.staff_pt_unpay(bigint) to authenticated;

do $chk$
begin
  if has_table_privilege('anon', 'public.part_timer_kinds', 'select')
     or has_table_privilege('anon', 'public.part_timer_payouts', 'select') then
    raise exception 'anon can read the part-timer pay tables';
  end if;
  if has_table_privilege('authenticated', 'public.part_timer_payouts', 'insert')
     or has_table_privilege('authenticated', 'public.part_timer_payouts', 'update')
     or has_table_privilege('authenticated', 'public.part_timer_payouts', 'delete') then
    raise exception 'payouts are writable outside staff_pt_pay';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'part_timer_shifts' and column_name in ('kind_id')) then
    raise exception 'part_timer_shifts.kind_id is missing';
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'part_timer_shifts_no_delete_paid' and not tgisinternal) then
    raise exception 'part_timer_shifts_no_delete_paid is missing';
  end if;
  if not (select bool_and(prosecdef) from pg_proc where proname in ('staff_pt_pay','staff_pt_unpay'))
     or has_function_privilege('anon', 'public.staff_pt_pay(bigint[],date,text,text)', 'execute')
     or has_function_privilege('anon', 'public.staff_pt_unpay(bigint)', 'execute') then
    raise exception 'the pay functions carry the wrong attributes';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007220000', 'part_timer_pay')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
