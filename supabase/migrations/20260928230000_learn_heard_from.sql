-- ============================================================================
-- "How did you hear about us?" on the learn-to-ride sign-up (the owner, 2026-09-28).
--
-- The booking app's own sign-up stopped asking it; the website's community form
-- (20260928220000_community_heard_from) and the learn-to-ride form ask it instead. Runs AFTER
-- 20260928210000_learn_to_ride (it refuses to run without learn_applications).
--
--  1. learn_applications.heard_from - one of customers.heard_from's codes, never 'desk'.
--  2. learn_apply(p) - 20260928210000's definition (as of 857904f, no days/times) with only the
--     heard_from lines added: it reads p->>'heard_from'; the form requires it, the function lets an
--     empty answer through (a page built before the form's update sends none, and a resend without
--     one keeps the earlier answer) and refuses a code it does not know with 'heard_from'.
--     Any later change to learn_apply belongs in this migration or a later one.
--  3. _learn_heard_to_account - when a sign-up lands on an account (staff_learn_schedule sets
--     customer_id), the account takes the answer only where it has none. A trigger, so
--     staff_learn_schedule itself is untouched. The account is the applicant's (a child's parent's).
--
-- Rollback:
--   drop trigger if exists learn_heard_to_account on public.learn_applications;
--   drop function if exists public._learn_heard_to_account();
--   re-run learn_apply from 20260928210000;
--   alter table public.learn_applications drop column if exists heard_from;
-- Idempotent.
-- ============================================================================

begin;

do $$ begin
  if to_regclass('public.learn_applications') is null then
    raise exception 'Run 20260928210000_learn_to_ride (mm-learn-to-ride-2026-09-28.sql) first.';
  end if;
end $$;

alter table public.learn_applications add column if not exists heard_from text;
alter table public.learn_applications drop constraint if exists learn_applications_heard_from_check;
alter table public.learn_applications add constraint learn_applications_heard_from_check
  check (heard_from is null or heard_from in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
    'google','friend','invited','passed_by','event','hotel','school','work','community','other'));

create or replace function public.learn_apply(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_for    text := coalesce(p->>'for_whom','');
  v_name   text := regexp_replace(trim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_email  text := lower(trim(coalesce(p->>'email','')));
  v_phone  text := trim(coalesce(p->>'phone',''));
  v_lname  text := nullif(regexp_replace(trim(coalesce(p->>'learner_name','')), '\s+', ' ', 'g'), '');
  v_age    int;
  v_height int;
  v_gender text := coalesce(p->>'learner_gender','');
  v_level  text := coalesce(p->>'level','');
  v_notes  text := trim(coalesce(p->>'notes',''));
  v_heard  text := nullif(trim(coalesce(p->>'heard_from','')), '');
  v_lang   text := lower(coalesce(nullif(p->>'lang',''), 'en'));
  v_pv     text := coalesce(p->>'privacy_version','');
  v_prev   learn_applications%rowtype;
begin
  if not _ip_gate('learn', 20, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;
  begin v_age := nullif(regexp_replace(coalesce(p->>'learner_age',''), '\D', '', 'g'), '')::int;
  exception when others then v_age := null; end;
  begin v_height := nullif(regexp_replace(coalesce(p->>'learner_height',''), '\D', '', 'g'), '')::int;
  exception when others then v_height := null; end;

  if v_for not in ('self','child') then return jsonb_build_object('ok', false, 'error', 'for_whom'); end if;
  -- The applicant's name becomes an account's name: the booking app's rules (first and last name,
  -- letters, spaces and periods, every part at least two letters).
  if v_name = '' or length(v_name) > 120 or v_name !~ '\s' or not _name_chars_ok(v_name) or not _name_parts_ok(v_name) then
    return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if length(v_email) > 254 or v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$') then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if v_for = 'child' then
    if v_lname is null or length(v_lname) > 60 or not _name_chars_ok(v_lname) or not _name_parts_ok(v_lname) then
      return jsonb_build_object('ok', false, 'error', 'learner_name'); end if;
    if v_age is null or v_age < 3 or v_age > 17 then return jsonb_build_object('ok', false, 'error', 'learner_age'); end if;
  else
    v_lname := null;
    -- Under 12 signs up through a parent (for_whom 'child').
    if v_age is null or v_age < 12 or v_age > 99 then return jsonb_build_object('ok', false, 'error', 'learner_age'); end if;
  end if;
  if v_gender not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'learner_gender'); end if;
  if v_height is null or v_height < 80 or v_height > 250 then return jsonb_build_object('ok', false, 'error', 'learner_height'); end if;
  if v_level not in ('never','tried','refresh') then return jsonb_build_object('ok', false, 'error', 'level'); end if;
  if length(v_notes) > 600 then return jsonb_build_object('ok', false, 'error', 'notes'); end if;
  if v_heard is not null and v_heard not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
     'google','friend','invited','passed_by','event','hotel','school','work','community','other') then
    return jsonb_build_object('ok', false, 'error', 'heard_from'); end if;
  if v_pv !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;

  -- One pending sign-up per person and learner: the same email or phone, for the same learner,
  -- updates it. A parent signing up two children makes two.
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_email));
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_phone));
  select * into v_prev from learn_applications
   where status = 'pending' and (lower(email) = v_email or phone = v_phone)
     and for_whom = v_for and lower(coalesce(learner_name, '')) = lower(coalesce(v_lname, ''))
   order by (lower(email) = v_email) desc, created_at limit 1;
  if v_prev.id is not null then
    update learn_applications set
      name = v_name, email = v_email, phone = v_phone, learner_name = v_lname, learner_age = v_age,
      learner_gender = v_gender, learner_height = v_height, level = v_level,
      notes = v_notes, heard_from = coalesce(v_heard, heard_from), lang = v_lang, privacy_version = v_pv,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into learn_applications (for_whom, name, email, phone, learner_name, learner_age, learner_gender,
      learner_height, level, notes, heard_from, lang, privacy_version)
    values (v_for, v_name, v_email, v_phone, v_lname, v_age, v_gender, v_height, v_level, v_notes, v_heard, v_lang, v_pv);
  end if;
  -- The form learns nothing about accounts or earlier sign-ups.
  return jsonb_build_object('ok', true);
end $function$;
revoke execute on function public.learn_apply(jsonb) from public;
grant  execute on function public.learn_apply(jsonb) to anon, authenticated;

create or replace function public._learn_heard_to_account()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  update customers set heard_from = new.heard_from
   where id = new.customer_id and heard_from is null;
  return null;
end $function$;
revoke execute on function public._learn_heard_to_account() from public, anon, authenticated;

drop trigger if exists learn_heard_to_account on public.learn_applications;
create trigger learn_heard_to_account
  after insert or update of customer_id, heard_from on public.learn_applications
  for each row
  when (new.customer_id is not null and new.heard_from is not null)
  execute function public._learn_heard_to_account();

commit;
