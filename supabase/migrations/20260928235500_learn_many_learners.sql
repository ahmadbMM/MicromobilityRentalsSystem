-- ============================================================================
-- Learn to ride: several learners on one sign-up (the owner, 2026-09-28).
--
-- A sign-up used to carry one learner (for_whom + learner_* columns). Now one person signs up
-- for up to five: themselves, their children, and other adults (a spouse, a friend). The
-- sign-up stays one contact, one lesson time and one account, as before.
--
--  1. learn_applications.learners jsonb - the learners, the source of truth from now on:
--       [{"who": "self"|"child"|"other", "name": text|null, "age": int, "gender": "male"|"female",
--         "height": int, "level": "never"|"tried"|"refresh"}, ...]
--     "self" (the person signing up; no name of its own) is always first. The old columns keep
--     learner #1 (for_whom may now read 'other'), so a page from before this still reads a
--     sign-up, and staff_learn_schedule, which fills an existing account's height and gender
--     from a self sign-up, is unchanged. Rows from before are copied into learners.
--  2. learn_apply(p) - 20260928230000's definition (heard_from kept, including a resend without
--     one keeping the earlier answer) reading p.learners: 1 to 5, at most one self, no two
--     alike (who + name); self and other 12 to 99, a child 3 to 17; a child's or another
--     adult's name follows the account name rules. A learner's error carries its place
--     ("index", from 0). A page from before this sends one learner in the old fields
--     (for_whom, learner_*), which is still read. A second sign-up from the same email or phone
--     while one is pending adds its learners to that one (a learner already on it is updated),
--     up to six in all.
--
-- Rollback:
--   re-run learn_apply from 20260928230000;
--   alter table public.learn_applications drop constraint if exists learn_applications_learners_check;
--   alter table public.learn_applications drop column if exists learners;
--   (and put back check (for_whom in ('self','child')) once no row reads 'other')
-- Idempotent.
-- ============================================================================

begin;

do $$ begin
  if to_regclass('public.learn_applications') is null then
    raise exception 'Run 20260928210000_learn_to_ride first.';
  end if;
end $$;

alter table public.learn_applications add column if not exists learners jsonb not null default '[]'::jsonb;
alter table public.learn_applications drop constraint if exists learn_applications_learners_check;
alter table public.learn_applications add constraint learn_applications_learners_check
  check (jsonb_typeof(learners) = 'array' and jsonb_array_length(learners) <= 6);
alter table public.learn_applications drop constraint if exists learn_applications_for_whom_check;
alter table public.learn_applications add constraint learn_applications_for_whom_check
  check (for_whom in ('self','child','other'));

update public.learn_applications
   set learners = jsonb_build_array(jsonb_build_object('who', for_whom, 'name', learner_name, 'age', learner_age,
     'gender', learner_gender, 'height', learner_height, 'level', level))
 where learners = '[]'::jsonb;

create or replace function public.learn_apply(p jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_name   text := regexp_replace(trim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_email  text := lower(trim(coalesce(p->>'email','')));
  v_phone  text := trim(coalesce(p->>'phone',''));
  v_notes  text := trim(coalesce(p->>'notes',''));
  v_heard  text := nullif(trim(coalesce(p->>'heard_from','')), '');
  v_lang   text := lower(coalesce(nullif(p->>'lang',''), 'en'));
  v_pv     text := coalesce(p->>'privacy_version','');
  v_in     jsonb := p->'learners';
  v_list   jsonb := '[]'::jsonb;
  v_l      jsonb;
  v_i      int := 0;
  v_selves int := 0;
  v_who    text;
  v_lname  text;
  v_age    int;
  v_height int;
  v_gender text;
  v_level  text;
  v_one    jsonb;
  v_prev   learn_applications%rowtype;
begin
  if not _ip_gate('learn', 20, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;

  -- A page from before several learners sends its one learner in the old fields.
  if v_in is null or jsonb_typeof(v_in) <> 'array' then
    v_in := case when coalesce(p->>'for_whom', '') = '' then '[]'::jsonb
      else jsonb_build_array(jsonb_build_object('who', p->>'for_whom', 'name', p->>'learner_name',
        'age', p->>'learner_age', 'gender', p->>'learner_gender', 'height', p->>'learner_height', 'level', p->>'level')) end;
  end if;
  if jsonb_array_length(v_in) < 1 or jsonb_array_length(v_in) > 5 then
    return jsonb_build_object('ok', false, 'error', 'learners'); end if;

  -- The learners, in the form's order: each is checked, and an error names its place.
  for v_l in select value from jsonb_array_elements(v_in) loop
    if jsonb_typeof(v_l) <> 'object' then return jsonb_build_object('ok', false, 'error', 'learner_who', 'index', v_i); end if;
    v_who    := coalesce(v_l->>'who', '');
    v_lname  := nullif(regexp_replace(trim(coalesce(v_l->>'name', '')), '\s+', ' ', 'g'), '');
    v_gender := coalesce(v_l->>'gender', '');
    v_level  := coalesce(v_l->>'level', '');
    begin v_age := nullif(regexp_replace(coalesce(v_l->>'age', ''), '\D', '', 'g'), '')::int;
    exception when others then v_age := null; end;
    begin v_height := nullif(regexp_replace(coalesce(v_l->>'height', ''), '\D', '', 'g'), '')::int;
    exception when others then v_height := null; end;

    if v_who not in ('self','child','other') then return jsonb_build_object('ok', false, 'error', 'learner_who', 'index', v_i); end if;
    if v_who = 'self' then
      v_selves := v_selves + 1;
      if v_selves > 1 then return jsonb_build_object('ok', false, 'error', 'learners', 'index', v_i); end if;
      v_lname := null;
    elsif v_lname is null or length(v_lname) > 60 or not _name_chars_ok(v_lname) or not _name_parts_ok(v_lname) then
      return jsonb_build_object('ok', false, 'error', 'learner_name', 'index', v_i);
    end if;
    -- Under 12 signs up through a parent, as a child.
    if v_age is null or (v_who = 'child' and (v_age < 3 or v_age > 17)) or (v_who <> 'child' and (v_age < 12 or v_age > 99)) then
      return jsonb_build_object('ok', false, 'error', 'learner_age', 'index', v_i); end if;
    if v_gender not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'learner_gender', 'index', v_i); end if;
    if v_height is null or v_height < 80 or v_height > 250 then return jsonb_build_object('ok', false, 'error', 'learner_height', 'index', v_i); end if;
    if v_level not in ('never','tried','refresh') then return jsonb_build_object('ok', false, 'error', 'level', 'index', v_i); end if;
    -- The same learner twice (who + name).
    if exists (select 1 from jsonb_array_elements(v_list) x
                where x->>'who' = v_who and lower(coalesce(x->>'name', '')) = lower(coalesce(v_lname, ''))) then
      return jsonb_build_object('ok', false, 'error', 'learners', 'index', v_i); end if;
    v_list := v_list || jsonb_build_array(jsonb_build_object('who', v_who, 'name', v_lname, 'age', v_age,
      'gender', v_gender, 'height', v_height, 'level', v_level));
    v_i := v_i + 1;
  end loop;

  -- The applicant's name becomes an account's name: the booking app's rules (first and last name,
  -- letters, spaces and periods, every part at least two letters).
  if v_name = '' or length(v_name) > 120 or v_name !~ '\s' or not _name_chars_ok(v_name) or not _name_parts_ok(v_name) then
    return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if length(v_email) > 254 or v_email !~ '^[a-z0-9._%+''-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$' then
    return jsonb_build_object('ok', false, 'error', 'email'); end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$') then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  if length(v_notes) > 600 then return jsonb_build_object('ok', false, 'error', 'notes'); end if;
  if v_heard is not null and v_heard not in ('instagram','tiktok','snapchat','x','facebook','youtube','whatsapp',
     'google','friend','invited','passed_by','event','hotel','school','work','community','other') then
    return jsonb_build_object('ok', false, 'error', 'heard_from'); end if;
  if v_pv !~ '^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok', false, 'error', 'privacy'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;

  -- One pending sign-up per person: the same email or phone adds its learners to it (one already
  -- on it, by who and name, is replaced by the new details), up to six in all.
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_email));
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_phone));
  select * into v_prev from learn_applications
   where status = 'pending' and (lower(email) = v_email or phone = v_phone)
   order by (lower(email) = v_email) desc, created_at limit 1;
  if v_prev.id is not null then
    select coalesce(jsonb_agg(m.value order by m.value->>'who' = 'self' desc, m.pos), '[]'::jsonb) into v_list
      from (
        select o.value, o.pos from jsonb_array_elements(v_prev.learners) with ordinality as o(value, pos)
         where not exists (select 1 from jsonb_array_elements(v_list) n
                            where n->>'who' = o.value->>'who'
                              and lower(coalesce(n->>'name', '')) = lower(coalesce(o.value->>'name', '')))
        union all
        select n.value, 100 + n.pos from jsonb_array_elements(v_list) with ordinality as n(value, pos)
      ) m;
    if jsonb_array_length(v_list) > 6 then return jsonb_build_object('ok', false, 'error', 'learners'); end if;
  else
    select coalesce(jsonb_agg(x.value order by x.value->>'who' = 'self' desc, x.pos), '[]'::jsonb) into v_list
      from jsonb_array_elements(v_list) with ordinality as x(value, pos);
  end if;
  -- The old columns keep learner #1 (self when there is one) for pages from before.
  v_one := v_list->0;

  if v_prev.id is not null then
    update learn_applications set
      name = v_name, email = v_email, phone = v_phone, learners = v_list,
      for_whom = v_one->>'who', learner_name = v_one->>'name', learner_age = (v_one->>'age')::int,
      learner_gender = v_one->>'gender', learner_height = (v_one->>'height')::int, level = v_one->>'level',
      notes = v_notes, heard_from = coalesce(v_heard, heard_from), lang = v_lang, privacy_version = v_pv,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into learn_applications (for_whom, name, email, phone, learners, learner_name, learner_age, learner_gender,
      learner_height, level, notes, heard_from, lang, privacy_version)
    values (v_one->>'who', v_name, v_email, v_phone, v_list, v_one->>'name', (v_one->>'age')::int, v_one->>'gender',
      (v_one->>'height')::int, v_one->>'level', v_notes, v_heard, v_lang, v_pv);
  end if;
  -- The form learns nothing about accounts or earlier sign-ups.
  return jsonb_build_object('ok', true);
end $function$;
revoke execute on function public.learn_apply(jsonb) from public;
grant  execute on function public.learn_apply(jsonb) to anon, authenticated;

commit;
