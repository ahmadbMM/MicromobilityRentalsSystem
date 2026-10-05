-- ============================================================================
-- An account's Google or Apple mark after its email is changed (the owner, 2026-09-30: "[a
-- customer] had her account signed up with apple id button then i changed it to a manual email not
-- using the buttons but it shows that it is linked using the google button, fix this issue").
--
-- The marks (20260929140000) match Supabase Auth's sign-in records on the account's email or its
-- linked Apple address. Changing the email of an account that signed up with Apple under a
-- shared (not hidden) address, an iCloud one say, lost both: nothing kept the old address,
-- because customers_email_alias keeps only a hidden relay address, so the Apple button no
-- longer opened the account, and with no record matching, the mark fell back to the account's
-- 'oauth:google' stamp, which customer_oauth_signup writes for Google and Apple sign-ups alike.
-- On 2026-09-30, 11 accounts made since the move to this project (2026-07-04) wore a Google mark
-- on that stamp alone; 7 of them signed up with Apple.
--
--  1. _customer_email_alias(): when the main email moves off an address the account signs in to
--     with Apple (an Apple sign-in record carries it), that address is kept in apple_email, as a
--     relay address already is. The Apple button keeps opening the account (customer_oauth_login
--     matches apple_email), and an account without a password is asked to choose one at its next
--     event pick, as relay accounts are (_customer_asks), so the new email signs in too. Only
--     when the email really changes: saving the same address links nothing.
--  2. _sign_in_methods(): the stamp counts only for an account made before the move (the first
--     sign-in record here is 2026-07-04 18:16:43 UTC; the earlier accounts' records stayed
--     behind), and only while its email has not been changed (audit_log). Every later account
--     has records here, so none of them is marked on the stamp: an account the buttons no
--     longer reach shows no mark. A linked Apple address (apple_email) is an Apple mark in itself.
--  3. Accounts whose email was changed off an Apple sign-in address since the audit log began
--     (2026-09-28) get that address back as apple_email (one account's iCloud address,
--     changed on 2026-09-30); none other on 2026-09-30.
--
-- Rollback:
--   re-run _customer_email_alias from 20260921150000 and _sign_in_methods from 20260929140000;
--   update customers set apple_email = null where id = 'z20k4nemrz6qjlc';
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

-- 1. Keep the Apple sign-in address when the main email moves off it.
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
  -- ...or off a shared address the account signs in to with Apple (20260930100000)
  if tg_op = 'UPDATE' and coalesce(btrim(new.apple_email),'') = '' then
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

-- 2. The stamp speaks only for an old account whose email is the one it signed up with.
create or replace function public._sign_in_methods(p_id text default null)
 returns table(id text, google boolean, apple boolean)
 language sql
 stable
 security definer
 set search_path to 'public', 'extensions'
as $function$
  with idp as (
    -- Every Google or Apple sign-in record, by the email it carries and by its user's email.
    select distinct lower(btrim(x.em)) as em, x.provider
      from (select i.identity_data->>'email' as em, i.provider
              from auth.identities i where i.provider in ('google', 'apple')
            union all
            select u.email, i.provider
              from auth.identities i join auth.users u on u.id = i.user_id
             where i.provider in ('google', 'apple')) x
     where coalesce(btrim(x.em), '') <> ''
  ), c as (
    select cu.id, lower(btrim(coalesce(cu.email, ''))) as em, lower(btrim(coalesce(cu.apple_email, ''))) as aem,
           coalesce(cu.password_hash, '') as ph,
           -- the 'oauth:' stamp is to be believed: made before the move, email never changed
           (coalesce(cu.created_at, '') < '2026-07-04T18:16:43'
            and not exists (select 1 from audit_log al
                             where al.tbl = 'customers' and al.row_id = cu.id and al.changed ? 'email')) as so
      from customers cu
     where p_id is null or cu.id = p_id
  ), k as (
    -- Two plain matches (the email, the relay address), so each is a hash join.
    select c.id, idp.provider from c join idp on idp.em = c.em
    union all
    select c.id, idp.provider from c join idp on idp.em = c.aem where c.aem <> ''
  ), m as (
    select c.id, c.em, c.aem, c.ph, c.so,
           coalesce(bool_or(k.provider = 'google'), false) as g,
           coalesce(bool_or(k.provider = 'apple'), false) as a
      from c left join k on k.id = c.id
     group by c.id, c.em, c.aem, c.ph, c.so
  )
  select m.id,
         m.g or (m.so and not m.a and m.aem = '' and m.ph = 'oauth:google'
                 and m.em not like '%@privaterelay.appleid.com'),
         m.a or m.aem <> '' or m.em like '%@privaterelay.appleid.com'
             or (m.so and not m.g and m.ph = 'oauth:apple')
    from m
$function$;
revoke execute on function public._sign_in_methods(text) from public, anon, authenticated;

-- 3. Link back the Apple address of an account whose email was changed off it.
update public.customers c set apple_email = x.o
  from (select distinct on (al.row_id) al.row_id, lower(btrim(al.changed->'email'->>'old')) as o
          from public.audit_log al
         where al.tbl = 'customers' and al.changed ? 'email'
           and coalesce(btrim(al.changed->'email'->>'old'), '') <> ''
           and (exists(select 1 from auth.identities i
                        where i.provider = 'apple' and i.email = lower(btrim(al.changed->'email'->>'old')))
                or exists(select 1 from auth.identities i join auth.users u on u.id = i.user_id
                           where i.provider = 'apple' and lower(btrim(u.email)) = lower(btrim(al.changed->'email'->>'old'))))
         order by al.row_id, al.at desc) x
 where c.id = x.row_id
   and coalesce(btrim(c.apple_email), '') = ''
   and x.o <> lower(btrim(coalesce(c.email, '')))
   and not exists (select 1 from public.customers o2
                    where o2.id <> c.id and (lower(btrim(o2.email)) = x.o or lower(btrim(o2.apple_email)) = x.o));

commit;
