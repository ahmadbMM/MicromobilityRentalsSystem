-- What a customer's account learns reaches their applications too (the owner, 2026-10-10: "if any info
-- was added to a customer by staff or by customer himself update it everywhere in his account and
-- applications if he had any").
--
-- Answers already flow application -> account (_community_app_to_account / _learn_app_to_account,
-- 20261004140000). Nothing flowed back: a member who later fixed their name, email or phone, or added
-- an Instagram or WhatsApp on their account (themselves, through a check-up, or a staffer in the
-- editor) still showed the old answer on their Community / Learn to ride application cards.
--
-- Now an AFTER UPDATE trigger on customers copies every changed, non-blank field to each application
-- linked to the account (and to accounts merged into it): name, email, phone, birth date, gender,
-- height, nationality, profession, company (workplace), Instagram, LinkedIn, how they heard, WhatsApp.
-- A field cleared on the account is left as answered on the application. Each value passes the
-- application table's own checks first, and a failed copy never stops the account's save.
-- Learn to ride: only the applicant's own columns; the learners list is not touched.
--
-- A one-off pass at the end brings existing linked applications in line with their accounts.
--
-- Rollback:
--   drop trigger if exists customers_to_applications on public.customers;
--   drop function if exists public._account_to_applications();
-- Idempotent.

create or replace function public._account_to_applications()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  ids    text[];
  heard  text[] := array['instagram','tiktok','snapchat','x','facebook','youtube','whatsapp','google','friend',
                         'invited','passed_by','event','hotel','school','work','community','other'];
  -- changed and worth copying (null = leave the application's answer)
  v_name text; v_email text; v_phone text; v_birth text; v_gender text; v_height int; v_nat text;
  v_prof text; v_work text; v_ig text; v_li text; v_heard text; v_wa boolean := false;
begin
  if new.name is distinct from old.name then v_name := nullif(btrim(new.name), ''); end if;
  if new.email is distinct from old.email then v_email := nullif(btrim(new.email), ''); end if;
  if new.phone is distinct from old.phone then v_phone := nullif(btrim(new.phone), ''); end if;
  if new.birth_date is distinct from old.birth_date and new.birth_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    v_birth := new.birth_date;
  end if;
  if new.gender is distinct from old.gender and new.gender in ('male','female') then v_gender := new.gender; end if;
  if new.height is distinct from old.height and new.height between 100 and 250 then v_height := new.height; end if;
  if new.nationality is distinct from old.nationality then v_nat := nullif(btrim(new.nationality), ''); end if;
  if new.profession is distinct from old.profession then v_prof := nullif(btrim(new.profession), ''); end if;
  if new.workplace is distinct from old.workplace then v_work := nullif(btrim(new.workplace), ''); end if;
  if new.socials->>'instagram' is distinct from old.socials->>'instagram' then
    v_ig := nullif(ltrim(btrim(new.socials->>'instagram'), '@'), '');
  end if;
  if new.socials->>'linkedin' is distinct from old.socials->>'linkedin' then
    v_li := nullif(btrim(new.socials->>'linkedin'), '');
  end if;
  if new.heard_from is distinct from old.heard_from and new.heard_from = any(heard) then v_heard := new.heard_from; end if;
  if (new.whatsapp_same, new.whatsapp) is distinct from (old.whatsapp_same, old.whatsapp)
     and (new.whatsapp_same is true or (new.whatsapp_same is false and new.whatsapp ~ '^\+?[0-9]{8,15}$')) then
    v_wa := true;
  end if;

  if v_name is null and v_email is null and v_phone is null and v_birth is null and v_gender is null
     and v_height is null and v_nat is null and v_prof is null and v_work is null and v_ig is null
     and v_li is null and v_heard is null and not v_wa then
    return null;
  end if;

  ids := array[new.id] || coalesce((select array_agg(id) from customers where merged_into = new.id), '{}');

  begin
    update community_applications a set
      name        = coalesce(v_name, a.name),
      email       = coalesce(v_email, a.email),
      phone       = coalesce(v_phone, a.phone),
      birth_date  = coalesce(v_birth, a.birth_date),
      gender      = coalesce(v_gender, a.gender),
      height      = coalesce(v_height, a.height),
      nationality = coalesce(v_nat, a.nationality),
      profession  = coalesce(v_prof, a.profession),
      workplace   = coalesce(case when length(v_work) <= 120 then v_work end, a.workplace),
      instagram   = coalesce(v_ig, a.instagram),
      linkedin    = coalesce(v_li, a.linkedin),
      heard_from  = coalesce(v_heard, a.heard_from),
      whatsapp_same = case when v_wa then new.whatsapp_same else a.whatsapp_same end,
      whatsapp      = case when v_wa then case when new.whatsapp_same then null else new.whatsapp end else a.whatsapp end
     where a.customer_id = any(ids);
  exception when others then
    raise warning '_account_to_applications community %: %', new.id, sqlerrm;
  end;

  begin
    update learn_applications a set
      name        = coalesce(v_name, a.name),
      email       = coalesce(v_email, a.email),
      phone       = coalesce(v_phone, a.phone),
      birth_date  = coalesce(v_birth, a.birth_date),
      gender      = coalesce(v_gender, a.gender),
      height      = coalesce(v_height, a.height),
      nationality = coalesce(case when length(v_nat) <= 60 then v_nat end, a.nationality),
      profession  = coalesce(case when length(v_prof) <= 80 then v_prof end, a.profession),
      workplace   = coalesce(case when length(v_work) <= 120 then v_work end, a.workplace),
      instagram   = coalesce(case when v_ig ~ '^[A-Za-z0-9._]{1,30}$' then v_ig end, a.instagram),
      linkedin    = coalesce(case when v_li ~ '^[A-Za-z0-9._%-]{3,100}$' then v_li end, a.linkedin),
      heard_from  = coalesce(v_heard, a.heard_from),
      whatsapp_same = case when v_wa then new.whatsapp_same else a.whatsapp_same end,
      whatsapp      = case when v_wa then case when new.whatsapp_same then null else new.whatsapp end else a.whatsapp end
     where a.customer_id = any(ids);
  exception when others then
    raise warning '_account_to_applications learn %: %', new.id, sqlerrm;
  end;

  return null;
end $$;

revoke execute on function public._account_to_applications() from public, anon, authenticated;

drop trigger if exists customers_to_applications on public.customers;
create trigger customers_to_applications
  after update of name, email, phone, birth_date, gender, height, nationality, profession, workplace,
                  socials, heard_from, whatsapp_same, whatsapp
  on public.customers
  for each row execute function public._account_to_applications();

-- One-off: every linked application takes its account's current non-blank answers.
update community_applications a set
  name        = coalesce(nullif(btrim(c.name), ''), a.name),
  email       = coalesce(nullif(btrim(c.email), ''), a.email),
  phone       = coalesce(nullif(btrim(c.phone), ''), a.phone),
  birth_date  = case when c.birth_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then c.birth_date else a.birth_date end,
  gender      = case when c.gender in ('male','female') then c.gender else a.gender end,
  height      = case when c.height between 100 and 250 then c.height else a.height end,
  nationality = coalesce(nullif(btrim(c.nationality), ''), a.nationality),
  profession  = coalesce(nullif(btrim(c.profession), ''), a.profession),
  workplace   = case when length(btrim(c.workplace)) between 1 and 120 then btrim(c.workplace) else a.workplace end,
  instagram   = coalesce(nullif(ltrim(btrim(c.socials->>'instagram'), '@'), ''), a.instagram),
  linkedin    = coalesce(nullif(btrim(c.socials->>'linkedin'), ''), a.linkedin),
  heard_from  = case when c.heard_from = any(array['instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
                  'google','friend','invited','passed_by','event','hotel','school','work','community','other'])
                     then c.heard_from else a.heard_from end,
  whatsapp_same = case when c.whatsapp_same is true or (c.whatsapp_same is false and c.whatsapp ~ '^\+?[0-9]{8,15}$')
                       then c.whatsapp_same else a.whatsapp_same end,
  whatsapp      = case when c.whatsapp_same is true then null
                       when c.whatsapp_same is false and c.whatsapp ~ '^\+?[0-9]{8,15}$' then c.whatsapp
                       else a.whatsapp end
  from customers c
 where c.id = a.customer_id;

update learn_applications a set
  name        = coalesce(nullif(btrim(c.name), ''), a.name),
  email       = coalesce(nullif(btrim(c.email), ''), a.email),
  phone       = coalesce(nullif(btrim(c.phone), ''), a.phone),
  birth_date  = case when c.birth_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then c.birth_date else a.birth_date end,
  gender      = case when c.gender in ('male','female') then c.gender else a.gender end,
  height      = case when c.height between 100 and 250 then c.height else a.height end,
  nationality = case when length(btrim(c.nationality)) between 1 and 60 then btrim(c.nationality) else a.nationality end,
  profession  = case when length(btrim(c.profession)) between 1 and 80 then btrim(c.profession) else a.profession end,
  workplace   = case when length(btrim(c.workplace)) between 1 and 120 then btrim(c.workplace) else a.workplace end,
  instagram   = case when ltrim(btrim(c.socials->>'instagram'), '@') ~ '^[A-Za-z0-9._]{1,30}$'
                     then ltrim(btrim(c.socials->>'instagram'), '@') else a.instagram end,
  linkedin    = case when btrim(c.socials->>'linkedin') ~ '^[A-Za-z0-9._%-]{3,100}$' then btrim(c.socials->>'linkedin') else a.linkedin end,
  heard_from  = case when c.heard_from = any(array['instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
                  'google','friend','invited','passed_by','event','hotel','school','work','community','other'])
                     then c.heard_from else a.heard_from end,
  whatsapp_same = case when c.whatsapp_same is true or (c.whatsapp_same is false and c.whatsapp ~ '^\+?[0-9]{8,15}$')
                       then c.whatsapp_same else a.whatsapp_same end,
  whatsapp      = case when c.whatsapp_same is true then null
                       when c.whatsapp_same is false and c.whatsapp ~ '^\+?[0-9]{8,15}$' then c.whatsapp
                       else a.whatsapp end
  from customers c
 where c.id = a.customer_id;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261010120000', 'account_to_applications')
on conflict (version) do nothing;

-- Check (expect: trigger present, definer, 0 and 0 differences left on name/email/phone):
-- select tgname from pg_trigger where tgname = 'customers_to_applications';
-- select prosecdef from pg_proc where proname = '_account_to_applications';
-- select (select count(*) from community_applications a join customers c on c.id = a.customer_id
--          where coalesce(nullif(btrim(c.name),''), a.name) is distinct from a.name
--             or coalesce(nullif(btrim(c.email),''), a.email) is distinct from a.email
--             or coalesce(nullif(btrim(c.phone),''), a.phone) is distinct from a.phone) ca_left,
--        (select count(*) from learn_applications a join customers c on c.id = a.customer_id
--          where coalesce(nullif(btrim(c.name),''), a.name) is distinct from a.name
--             or coalesce(nullif(btrim(c.email),''), a.email) is distinct from a.email
--             or coalesce(nullif(btrim(c.phone),''), a.phone) is distinct from a.phone) la_left;
