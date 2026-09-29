-- ============================================================================
-- The VIP tag (the owner, 2026-09-29: "add a new vip tag, design it yourself, i want it to make
-- who has it always on the house and always hide the road carbon choice"). A locked system tag,
-- like Community and the blacklist; the app wears it gold with a drawn crown (TAG_BRANDS.vip).
-- While a grant is active its holder:
--   * rides on the house, every bike type, whatever customers.default_pay says, under the rule
--     default_pay already follows: the account's own name on the row (a friend booked under the
--     account pays), not already paid - then paid, at 0;
--   * never gets Road Carbon on a booking they make or change themselves: their picker hides it
--     (customer_profile below), and a Road Carbon that reaches the table from them becomes Road,
--     as _comm_no_carbon does on community rides. Staff can still put a VIP on one.
--
-- 1. tags: tag_vip (slug vip).
-- 2. _is_vip(customer_id): security definer, execute revoked from public, anon, authenticated.
-- 3. _apply_default_pay + trg_apply_default_pay: 20260929040000's trigger with a VIP counted as
--    'house'. It is the whole of that migration and more, so this one runs on its own; running
--    040000 AFTER this one would drop the VIP clause again (run 040000, then this).
-- 4. customer_create_booking: a VIP counts as 'house' (patched in place from its live definition,
--    attributes and grants kept; skipped when already patched).
-- 5. customer_profile: a VIP's own app is told default_pay 'house' and Road Carbon among its
--    hidden_types, which is all its booking picker reads (_regHouseFor, _regTypeHidden).
-- 6. _vip_no_carbon + queue_entries_vip_no_carbon: before insert, or an update of type_preference,
--    by anyone but staff.
-- 7. Once: the tag on every account whose default payment is on the house (15 on 2026-09-29).
--
-- Rollback:
--   drop trigger if exists queue_entries_vip_no_carbon on public.queue_entries;
--   drop function if exists public._vip_no_carbon();
--   re-run customer_profile from 20260925140000_review_fixes.sql and _apply_default_pay from
--   20260929040000; in customer_create_booking remove the "if _is_vip(p_id) then ... elsif" lines;
--   drop function if exists public._is_vip(text);
--   delete from public.customer_tags where tag_id = 'tag_vip'; delete from public.tags where id = 'tag_vip';
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_vip', 'vip', 'VIP', '#a67c00',
        'Always on the house, every bike type; Road Carbon is hidden from their own booking.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do nothing;

create or replace function public._is_vip(p_customer text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select p_customer is not null and exists (
    select 1
      from customer_tags ct
      join tags tg on tg.id = ct.tag_id
     where ct.customer_id = p_customer
       and lower(tg.slug) = 'vip'
       and _ctag_active(ct.starts_at, ct.expires_at));
$$;
revoke execute on function public._is_vip(text) from public, anon, authenticated;

create or replace function public._apply_default_pay()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare _dp text; _nm text; _house text;
begin
  if new.customer_id is null or coalesce(new.paid, false)
     or coalesce(new.status, '') in ('cancelled', 'removed') then
    return new;
  end if;
  select c.default_pay, c.name into _dp, _nm from customers c where c.id = new.customer_id;
  if _is_vip(new.customer_id) then
    _house := 'all';                                   -- VIP: every type, whatever default_pay says
  elsif coalesce(_dp, '') like 'house%' then
    _house := case when _dp = 'house' then 'all' else substring(_dp from 7) end;
  else
    return new;
  end if;
  if lower(btrim(coalesce(new.name, ''))) = lower(btrim(coalesce(_nm, '')))
     and (_house = 'all' or coalesce(nullif(new.type_preference, ''), 'Any') = any(string_to_array(_house, ','))) then
    new.paid := true;
    new.price := 0;
  end if;
  return new;
end $$;
revoke execute on function public._apply_default_pay() from public, anon, authenticated;

drop trigger if exists trg_apply_default_pay on public.queue_entries;
create trigger trg_apply_default_pay
  before insert on public.queue_entries
  for each row execute function public._apply_default_pay();

do $$
declare d text; n text;
begin
  d := pg_get_functiondef('public.customer_create_booking(text,text,jsonb)'::regprocedure);
  if position('_is_vip(p_id)' in d) > 0 then return; end if;
  n := replace(d, $a$  if coalesce(cust.default_pay,'') like 'house%' then$a$,
$a$  if _is_vip(p_id) then
    _house := 'all';                                   -- VIP (20260929090000): every type
  elsif coalesce(cust.default_pay,'') like 'house%' then$a$);
  if n = d then
    raise exception 'customer_create_booking: its default_pay block was not found - patch it by hand';
  end if;
  execute n;
end $$;

create or replace function public.customer_profile(p_id text, p_token text)
 returns table(id text, name text, email text, phone text, height integer, type_preference text, created_at text, birth_date text, country text, city text, photo text, gender text, nationality text, socials jsonb, hidden_types text, default_pay text)
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
declare _vip boolean;
begin
  if not _cust_token_ok(p_id,p_token) then return; end if;
  _vip := _is_vip(p_id);
  return query select c.id, c.name, c.email, c.phone, c.height, c.type_preference,
    c.created_at, c.birth_date, c.country, c.city, c.photo, c.gender, c.nationality, c.socials,
    case when _vip and not ('Road Carbon' = any(string_to_array(replace(coalesce(c.hidden_types, ''), ', ', ','), ',')))
         then concat_ws(',', nullif(c.hidden_types, ''), 'Road Carbon')
         else c.hidden_types end,
    case when _vip then 'house' else c.default_pay end
  from customers c where c.id = p_id;
end $function$;

create or replace function public._vip_no_carbon()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.type_preference is distinct from 'Road Carbon' or new.customer_id is null then return new; end if;
  if tg_op = 'UPDATE' and old.type_preference is not distinct from new.type_preference then return new; end if;
  if not is_staff() and _is_vip(new.customer_id) then
    new.type_preference := 'Road';
  end if;
  return new;
end $$;
revoke execute on function public._vip_no_carbon() from public, anon, authenticated;

drop trigger if exists queue_entries_vip_no_carbon on public.queue_entries;
create trigger queue_entries_vip_no_carbon
  before insert or update of type_preference on public.queue_entries
  for each row execute function public._vip_no_carbon();

-- 7. Once: every account on the house by its default payment gets the tag (the owner, 2026-09-29:
--    "apply the tag on every account that has the oth as a default payment option"). On
--    2026-09-29 that was 15 accounts (3 'house', 12 'house:' every type but Road Carbon), every
--    one of them with Road Carbon hidden already; none had an unpaid booking of their own that the
--    tag newly covers, so no booking is repriced. A grant already on file is left as it is.
insert into public.customer_tags (customer_id, tag_id, added_by, added_at, note)
select c.id, 'tag_vip', 'staff', (extract(epoch from now()) * 1000)::bigint, 'On the house by default payment when VIP began'
  from public.customers c
 where c.default_pay like 'house%'
on conflict (customer_id, tag_id) do nothing;

commit;
