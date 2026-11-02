-- ============================================================================
-- An account takes back an email from an account merged into it (the owner, 2026-11-02: adding
-- u_bin_h@hotmail.com to the account kept by merge 14 said "an account already exists", though the
-- other account had been merged).
--
-- A merged account keeps its email on purpose, so its holder can still sign in with it: customer_login
-- follows merged_into to the keeper (20260928130000). But customers_email_lower_uniq and this trigger
-- still count that row, so the keeper could never be given the address.
--
-- Now, when a live account's email or Apple address changes to one held by an account merged into it
-- (directly or through a chain of merges), that merged account gives it up in the same statement. Its
-- email becomes '' and its apple_email null. An address on an account merged into ANY OTHER account
-- stays refused: it signs in someone else, and only the keeper is the same person.
--
-- customer_login then reads only the keeper's password_hash for that address, so a keeper with no
-- password of its own (oauth:*) takes the merged account's, or the old address and password would stop
-- working. A keeper that has a password keeps it.
--
-- staff_unmerge_customers does not give the address back: the merged account comes back with no email,
-- and audit_log (customers_audit_upd) holds the old value.
--
-- Rollback: re-run _customer_email_alias from 20260930130000.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function public._customer_email_alias()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare e text; a text; o text; fam text[]; taken text[]; h text;
begin
  e := lower(btrim(coalesce(new.email,'')));
  -- a merged account giving its address up to its keeper (below): nothing to alias, nothing to check
  if new.merged_into is not null and e = '' and coalesce(btrim(new.apple_email),'') = '' then
    return new;
  end if;
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
  -- a live account takes its new address back from the accounts merged into it (20261102180000)
  if tg_op = 'UPDATE' and new.merged_into is null
     and (e <> lower(btrim(coalesce(old.email,''))) or a <> lower(btrim(coalesce(old.apple_email,'')))) then
    taken := array_remove(array[e, a], '');
    with recursive merged(id) as (
      select c.id from customers c where c.merged_into = new.id
      union
      select c.id from customers c join merged m on c.merged_into = m.id
    )
    select array_agg(c.id) into fam from customers c join merged m on m.id = c.id
     where lower(btrim(c.email)) = any(taken) or lower(btrim(c.apple_email)) = any(taken);
    if fam is not null then
      if coalesce(new.password_hash,'') like 'oauth:%' then
        select c.password_hash into h from customers c
         where c.id = any(fam) and lower(btrim(c.email)) = e
           and coalesce(c.password_hash,'') <> '' and c.password_hash not like 'oauth:%'
         limit 1;
        if h is not null then new.password_hash := h; end if;
      end if;
      update customers c
         set email = case when lower(btrim(c.email)) = any(taken) then '' else c.email end,
             apple_email = case when lower(btrim(c.apple_email)) = any(taken) then null else c.apple_email end
       where c.id = any(fam);
    end if;
  end if;
  if e <> '' and exists(select 1 from customers c where c.id <> new.id and lower(btrim(c.apple_email)) = e) then
    raise exception 'email_taken' using errcode = '23505';
  end if;
  if a <> '' and exists(select 1 from customers c where c.id <> new.id and lower(btrim(c.email)) = a) then
    raise exception 'email_taken' using errcode = '23505';
  end if;
  return new;
end $function$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261102180000', 'merge_email_back_to_keeper')
on conflict (version) do nothing;

commit;
