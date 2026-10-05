-- ============================================================================
-- An email staff change moves the account to the new address (the owner, 2026-09-30: "i want to
-- link the outlook.sa for [the customer] not the apple", and for every account from now on: "New email
-- only").
--
-- 20260930100000 made customers_email_alias keep a shared Apple sign-in address (an iCloud one,
-- say) in apple_email whenever the main email moved off it, so the Apple button kept opening the
-- account. The owner wants the opposite when staff make the change: the account is the new
-- email's alone, and staff send a temporary password (the account editor's Generate). So the
-- shared address is kept only when the change is not a staff member's - a rider changing their
-- own email in My Account, who would otherwise lock themselves out, having no password. A hidden
-- relay address stays linked whoever changes the email, as since 20260921150000 (the check-up
-- that asks those accounts for a real email depends on it).
--
-- That account's Apple link was removed by hand on 2026-09-30 (apple_email null; it signs in
-- with its outlook.sa address once it has a password).
--
-- Rollback: re-run _customer_email_alias from 20260930100000.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function public._customer_email_alias()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare e text; a text; o text;
begin
  e := lower(btrim(coalesce(new.email,'')));
  if e like '%@privaterelay.appleid.com' and coalesce(btrim(new.apple_email),'') = '' then
    new.apple_email := e;
  end if;
  if tg_op = 'UPDATE' and coalesce(btrim(new.apple_email),'') = ''
     and lower(btrim(coalesce(old.email,''))) like '%@privaterelay.appleid.com' then
    new.apple_email := lower(btrim(old.email));   -- the main email moved off the relay address
  end if;
  -- ...or off a shared address the account signs in to with Apple, when the rider changed it
  -- themselves (20260930100000); an email staff change is the new address's alone (20260930130000)
  if tg_op = 'UPDATE' and coalesce(btrim(new.apple_email),'') = '' and not is_staff() then
    o := lower(btrim(coalesce(old.email,'')));
    if o <> '' and o <> e
       and (exists(select 1 from auth.identities i where i.provider = 'apple' and i.email = o)
            or exists(select 1 from auth.identities i join auth.users u on u.id = i.user_id
                       where i.provider = 'apple' and lower(btrim(u.email)) = o)) then
      new.apple_email := o;
    end if;
  end if;
  a := lower(btrim(coalesce(new.apple_email,'')));
  if e <> '' and exists(select 1 from customers c where c.id <> new.id and lower(btrim(c.apple_email)) = e) then
    raise exception 'email_taken' using errcode = '23505';
  end if;
  if a <> '' and exists(select 1 from customers c where c.id <> new.id and lower(btrim(c.email)) = a) then
    raise exception 'email_taken' using errcode = '23505';
  end if;
  return new;
end $function$;

commit;
