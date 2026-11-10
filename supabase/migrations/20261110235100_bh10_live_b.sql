-- ============================================================================
-- Bug hunt 2026-11-10 (bh10), live database fixes, part B (prod and staging).
--
-- 1. _purge_old (sql01-6): retention turned an old account into 'Former Rider' but kept customers.name_ar,
--    the person's name in Arabic (added 20261108220000 for the volunteer certificate). It is cleared now with
--    the rest. Issued certificates (volunteer_certs) keep the name they were printed with, as before.
-- 2. _staff_cap (sql02-1): the Owner role only looks (_staff_mod refuses it every edit), yet with no can_refund
--    in its caps it held the refund right by default, so a direct call could void a receipt, cancel a store
--    order or decline a refund. The Owner role never holds can_refund now, ticked or not; can_see_costs stays.
-- 3. ambassador_apply (sql02-2): a signed-out application was linked to the only account carrying the same
--    nine phone digits, a number nobody checks, so that account saw the ambassador's code, history and
--    redemptions, and the applicant's own account later found nothing. Only a caller proving the account (its
--    token) links it now. Unlinked, ambassador_mine shows a phone match the points only, as it does every phone
--    match since 2026-10-28.
-- 4. badge_weeks (sql02-3): a night staff called off (Cancel night cancels its bookings and closes it) stayed in
--    its week's list, so nobody could have a Perfect Week that week and every Perfect Month run through it
--    broke. A past session counts now only if someone was checked in on it (active or done); today and the
--    days ahead count as before; a session with cancelled_at set is left out.
-- 5. _tag_one_of_two and its trigger (sql02-4): the Community tag and the Petromin or Victory Lap tag were
--    judged by expires_at alone, so a grant dated to start after the other ends (a switch planned ahead) was
--    refused. They clash now only when their windows share a moment from now on. The trigger also fires when
--    starts_at changes, since the check reads it.
-- 6. learn_apply (sql04-3): a sign-up was merged into a pending one that has no account when the email OR the
--    mobile matched, taking over that application's name, email and 'Me' learner. Such a row is merged now
--    only when the email and the mobile both match; otherwise the sign-up is an application of its own. (Only
--    customer_learn_apply calls learn_apply since 20261004100000, with the account's own email and mobile; an
--    account's own pending sign-up is still found by its id.)
-- 7. staff_merge_customers, staff_unmerge_customers (sql07-1): when both accounts held a tag, the merge kept
--    only the tag's id and unmerge gave it back with no window, so an expired or temporary VIP, Community or
--    Petromin grant came back permanent. The merge keeps the whole row now, as it keeps a badge, and unmerge
--    restores it as it was; a record from before (ids only) is restored as before.
-- 8. staff_volunteer_checkin (sql07-2): the volunteer panel's undo of a check-in always set 'waiting', so a
--    waitlisted donor checked in by mistake took a held place. The check-in logs the status it found
--    (prev_status, as the portal's volunteer_checkin does) and the undo puts it back.
-- 9. vendor_login, vendor_set_password (sql08-1): a wrong password was counted by reading the count and writing
--    it plus one, so tries at the same moment counted once and a late one could clear a lock just set. Tries on
--    one login take turns now (a transaction advisory lock) before the count is read.
-- 10. vl_team_peek (sql08-3): a signed-in rider could test Victory Lap / Arena team codes without limit, and a
--    hit gave a stranger's first name and gender. Each look costs a try from the caller's address now (_ip_gate,
--    30 in ten minutes, THROTTLED after that); the function is VOLATILE so the count can be written.
--
-- Not here: workshop_request (sql08-2) still keeps the browser's estimate as price_quoted. The database holds no
-- workshop price list to check it against (the prices are the website's), so that needs the owner's call.
--
-- Each function is replaced from its live definition on prod (pg_get_functiondef, checked by md5; staging runs
-- the same text). Headers are unchanged except vl_team_peek's volatility; CREATE OR REPLACE keeps the grants.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

-- Every function replaced below must still be the live text this file was built from (md5 of the body, read on
-- prod and staging 2026-11-10), or already this file's (a re-run): else stop, rather than undo a change made since.
do $pre$
declare f record; m text;
begin
  for f in select * from (values
    ('public._staff_cap(text)', 'ec152bcd217ee6f78f3b8d1b6e78d3c9', '38748ed4781548f800fc533b99b5ab93'),
    ('public._tag_one_of_two()', 'f56cf91ecf3dc44a80d056dae28b0a19', '0d07444fa8ba11d305049adf121ac4d1'),
    ('public.ambassador_apply(jsonb)', '0f9691af965b203568157d256bc41dad', '286a59c1414a3e8ebb29257b0217f865'),
    ('public.badge_weeks()', '7e50c7ed8cf61ce205fcc626054ee256', '412b7fb168385e315c4fb3b075b250de'),
    ('public.learn_apply(jsonb)', '84a6f7c8faea4a05b4c529452741c8dd', '0320a650f80b17ba7ec23b3e059f902c'),
    ('public.staff_merge_customers(text,text,text,text,text)', 'fd8d329e4a68fa57b7f463544ced8c71', '6bf8a5ba4a929b035d38faa52dc44748'),
    ('public.staff_unmerge_customers(bigint)', 'bf96b2c65728a4d010c8d55fd65b87e1', '407bc9981ee04df979518dafeb46fbed'),
    ('public.staff_volunteer_checkin(text,boolean)', '64ec3ce52b5d336ac74e3fce89495a5f', '5aeb031db5df09683fd41416d628fa65'),
    ('public.vendor_login(text,text)', '931b0031a8c5636986e7929a744a4732', '546e1462206a6ec15a58c749bbb3932e'),
    ('public.vendor_set_password(bigint,text,text,text)', 'f0c5aa252dba3e5eb33bf4390bd12169', '434e67be1faa3449c4c481d519fc9013'),
    ('public.vl_team_peek(text,text,text,text)', 'ea5d9a14a9cf72a2a3e33a5b83a0330d', '28ae3f0ecc5b6f7d1c3a5f8ab0bbe268')
  ) v(fn, was, now_) loop
    select md5(p.prosrc) into m from pg_proc p where p.oid = f.fn::regprocedure;
    if m is distinct from f.was and m is distinct from f.now_ then
      raise exception '% changed since 2026-11-10 (md5 %): rebuild this file from the live definition', f.fn, m;
    end if;
  end loop;
end $pre$;

-- 1 _purge_old ------------------------------------------------------------
-- Patched in place, as the sport question's migration (20261110233000) patched it the same day: the live text
-- keeps every line it has (the sport answer's included) and gains name_ar. Skipped on a re-run.
do $do$
declare d text; a text := 'apple_email = null, session_token = null,';
begin
  select pg_get_functiondef('public._purge_old(boolean)'::regprocedure) into d;
  if position('(bh10, 20261110235100)' in d) > 0 then return; end if;
  if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then
    raise exception '_purge_old: anchor not found exactly once: rebuild this step from the live definition';
  end if;
  execute replace(d, a, a || chr(10) || '             name_ar = null /* the name in Arabic (20261108220000), missed here before (bh10, 20261110235100) */,');
end $do$;

-- 2 _staff_cap ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._staff_cap(p_cap text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists(
    select 1 from staff s
     where s.user_id = auth.uid() and s.disabled_at is null
       and s.role is distinct from 'volunteer'  -- can_refund and can_see_costs default to true (20261105090000)
       and not (s.role = 'owner' and p_cap = 'can_refund')  /* the Owner role only looks: no refund, ticked or not (bh10) */
       and (s.role = 'admin'
            or case when jsonb_typeof(s.caps -> p_cap) = 'boolean' then (s.caps ->> p_cap)::boolean
                    else p_cap in ('can_refund', 'can_see_costs') end))
$function$;

-- 3 ambassador_apply -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.ambassador_apply(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare
  v_name  text := regexp_replace(trim(coalesce(p->>'name','')), '\s+', ' ', 'g');
  v_phone text := trim(coalesce(p->>'phone',''));
  v_insta text := nullif(regexp_replace(trim(coalesce(p->>'instagram','')), '^(https?://)?(www\.)?(instagram\.com/)?@?', '', 'i'), '');
  v_why   text := nullif(trim(coalesce(p->>'why','')), '');
  v_lang  text := coalesce(nullif(p->>'lang',''), 'en');
  v_cust  text;
  v_prev  ambassadors%rowtype;
begin
  if not _ip_gate('ambapply', 5, interval '10 minutes') then return jsonb_build_object('ok', false, 'error', 'throttled'); end if;
  if v_name = '' or length(v_name) > 120 or not _name_chars_ok(v_name) then return jsonb_build_object('ok', false, 'error', 'name'); end if;
  if v_phone !~ '^\+[1-9][0-9]{7,14}$' or (v_phone like '+966%' and v_phone !~ '^\+9665[0-9]{8}$') then
    return jsonb_build_object('ok', false, 'error', 'phone'); end if;
  v_insta := rtrim(v_insta, '/');
  if v_insta is not null and v_insta !~ '^[A-Za-z0-9._]{1,30}$' then return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
  if v_why is not null and length(v_why) > 1000 then return jsonb_build_object('ok', false, 'error', 'why'); end if;
  if v_lang !~ '^[a-z]{2}$' then v_lang := 'en'; end if;
  /* The account only when the caller proves it (its token). The mobile alone links none (bh10): an account's
     number is its own word, never checked, and a linked ambassador shows that account the code (with the
     phone, what ambassador_redeem spends), the history and the redemptions. Unlinked, ambassador_mine shows
     a phone match the points only, as it does every phone match (bug hunt 2026-10-28). */
  if coalesce(p->>'customer_id','') <> '' and coalesce(p->>'token','') <> '' and _cust_token_ok(p->>'customer_id', p->>'token') then
    v_cust := p->>'customer_id';
  end if;
  perform pg_advisory_xact_lock(hashtext('ambapply:' || v_phone));
  select * into v_prev from ambassadors where phone = v_phone and status in ('pending','active','paused') limit 1;
  if v_prev.id is not null then
    return jsonb_build_object('ok', true, 'status', v_prev.status, 'repeat', true);
  end if;
  insert into ambassadors(name, phone, instagram, why, lang, customer_id, updated_by)
  values (v_name, v_phone, v_insta, v_why, v_lang, v_cust, 'website');
  return jsonb_build_object('ok', true, 'status', 'pending');
end $function$;

-- 4 badge_weeks ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.badge_weeks()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with today as (select (now() at time zone 'Asia/Riyadh')::date as d),
  s as (
    select id, _safe_date(session_date) as d
      from sessions
     where coalesce(status, '') <> 'deleted'
       and required_tag_id is null          -- private events are nobody else's business (20261004100000)
       and gender_only is null              -- nor is one for men only or women only, which half could never attend (20261027150000)
       and cancelled_at is null             /* nor one called off (bh10) */
  )
  select coalesce(jsonb_agg(jsonb_build_object('w', w, 'ids', ids) order by w), '[]'::jsonb)
    from (select to_char(s.d - extract(dow from s.d)::int, 'YYYY-MM-DD') as w,
                 jsonb_agg(s.id order by s.d, s.id) as ids
            from s, today
           where s.d is not null
             and s.d <= today.d + (6 - extract(dow from today.d)::int)
             /* A day gone by keeps a session only if someone was checked in on it: a night staff called off
                (Cancel night cancels its bookings and closes it) or one nobody came to was not held, and no
                rider could ride it to complete the week (bh10). Today and the days ahead are listed as before. */
             and (s.d >= today.d
                  or exists (select 1 from queue_entries q where q.session_id = s.id and q.status in ('active', 'done')))
           group by 1) x
$function$;

-- 5 _tag_one_of_two and its trigger ---------------------------------------
CREATE OR REPLACE FUNCTION public._tag_one_of_two()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare rivals text[]; _now bigint := (extract(epoch from now()) * 1000)::bigint; _lo bigint;
begin
  rivals := case new.tag_id when 'tag_saturday' then array['tag_petromin', 'tag_vlap']
                            when 'tag_petromin' then array['tag_saturday']
                            when 'tag_vlap'     then array['tag_saturday'] end;
  if rivals is null then return new; end if;
  if new.expires_at is not null and new.expires_at <= _now then return new; end if;
  /* Never both at once: the two windows must share a moment from now on (bh10). A grant dated to start after
     the other ends, or to end before it starts, is a switch planned ahead, not both. */
  _lo := greatest(coalesce(new.starts_at, _now), _now);
  if new.expires_at is not null and new.expires_at <= _lo then return new; end if;
  if exists (select 1 from customer_tags ct
              where ct.customer_id = new.customer_id and ct.tag_id = any(rivals)
                and (ct.expires_at is null or ct.expires_at > _lo)
                and (new.expires_at is null or ct.starts_at is null or ct.starts_at < new.expires_at)) then
    raise exception 'An account holds the Community tag, or the Petromin or Victory Lap tag, never both.'
      using errcode = 'P0001', detail = 'TAG_EXCLUSIVE';
  end if;
  return new;
end $function$;

-- The check reads starts_at now, so a change of starts_at alone is checked too (it was not in the list).
drop trigger if exists customer_tags_one_of_two on public.customer_tags;
create trigger customer_tags_one_of_two
  before insert or update of tag_id, customer_id, starts_at, expires_at on public.customer_tags
  for each row execute function public._tag_one_of_two();

-- 6 learn_apply ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.learn_apply(p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
  v_new    boolean := p ?| array['birth_date','nationality','profession'];
  v_birth  text := trim(coalesce(p->>'birth_date',''));
  v_bd     date;
  v_cage   int;
  v_cgend  text := coalesce(p->>'gender','');
  v_cheight int;
  v_nat    text := trim(coalesce(p->>'nationality',''));
  v_prof   text := regexp_replace(trim(coalesce(p->>'profession','')), '\s+', ' ', 'g');
  v_wp     text := regexp_replace(trim(coalesce(p->>'workplace','')), '\s+', ' ', 'g');
  v_wp_on  boolean := p ? 'workplace';
  v_ig     text := regexp_replace(trim(coalesce(p->>'instagram','')), '^@+', '');
  v_li     text := trim(coalesce(p->>'linkedin',''));
  v_news   boolean := false;
  v_today  date := (now() at time zone 'Asia/Riyadh')::date;
begin
  if not _ip_gate('learn', 20, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'throttled');
  end if;

  if v_in is null or jsonb_typeof(v_in) <> 'array' then
    v_in := case when coalesce(p->>'for_whom', '') = '' then '[]'::jsonb
      else jsonb_build_array(jsonb_build_object('who', p->>'for_whom', 'name', p->>'learner_name',
        'age', p->>'learner_age', 'gender', p->>'learner_gender', 'height', p->>'learner_height', 'level', p->>'level')) end;
  end if;
  if jsonb_array_length(v_in) < 1 or jsonb_array_length(v_in) > 5 then
    return jsonb_build_object('ok', false, 'error', 'learners'); end if;

  if v_new then
    begin v_bd := v_birth::date; exception when others then v_bd := null; end;
    if v_bd is null or v_birth !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or v_bd > v_today or v_bd <= (v_today - interval '100 years')::date then
      return jsonb_build_object('ok', false, 'error', 'birth_date'); end if;
    v_cage := extract(year from age(v_today::timestamp, v_bd::timestamp))::int;
    if v_cgend not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'gender'); end if;
    if v_nat = '' or length(v_nat) > 60 or v_nat ~ '[<>"`]' then return jsonb_build_object('ok', false, 'error', 'nationality'); end if;
    begin v_cheight := nullif(regexp_replace(coalesce(p->>'height', ''), '\D', '', 'g'), '')::int;
    exception when others then v_cheight := null; end;
    if v_cheight is null or v_cheight < 80 or v_cheight > 250 then return jsonb_build_object('ok', false, 'error', 'height'); end if;
    if v_ig <> '' and v_ig !~ '^[A-Za-z0-9._]{1,30}$' then return jsonb_build_object('ok', false, 'error', 'instagram'); end if;
    if v_li <> '' and v_li !~ '^[A-Za-z0-9._%-]{3,100}$' then return jsonb_build_object('ok', false, 'error', 'linkedin'); end if;
    if length(v_prof) < 2 or length(v_prof) > 80 or v_prof ~ '[<>"`{}]' then
      return jsonb_build_object('ok', false, 'error', 'profession'); end if;
    if v_wp_on and (length(v_wp) < 2 or length(v_wp) > 120 or v_wp ~ '[<>"`{}]') then
      return jsonb_build_object('ok', false, 'error', 'workplace'); end if;
    begin v_news := coalesce((p->>'ride_news')::boolean, false); exception when others then v_news := false; end;
  end if;

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
    if v_who = 'self' and v_new then v_age := v_cage; v_gender := v_cgend; v_height := v_cheight; end if;
    if v_who = 'self' then
      v_selves := v_selves + 1;
      if v_selves > 1 then return jsonb_build_object('ok', false, 'error', 'learners', 'index', v_i); end if;
      v_lname := null;
    elsif v_lname is null or length(v_lname) > 60 or not _name_chars_ok(v_lname) or not _name_parts_ok(v_lname) then
      return jsonb_build_object('ok', false, 'error', 'learner_name', 'index', v_i);
    end if;
    if v_age is null or v_age < 1 or v_age > 99 then
      return jsonb_build_object('ok', false, 'error', 'learner_age', 'index', v_i); end if;
    if v_gender not in ('male','female') then return jsonb_build_object('ok', false, 'error', 'learner_gender', 'index', v_i); end if;
    if v_height is null or v_height < 80 or v_height > 250 then return jsonb_build_object('ok', false, 'error', 'learner_height', 'index', v_i); end if;
    if v_level not in ('never','tried','refresh') then return jsonb_build_object('ok', false, 'error', 'level', 'index', v_i); end if;
    if exists (select 1 from jsonb_array_elements(v_list) x
                where x->>'who' = v_who and lower(coalesce(x->>'name', '')) = lower(coalesce(v_lname, ''))) then
      return jsonb_build_object('ok', false, 'error', 'learners', 'index', v_i); end if;
    v_list := v_list || jsonb_build_array(jsonb_build_object('who', v_who, 'name', v_lname, 'age', v_age,
      'gender', v_gender, 'height', v_height, 'level', v_level));
    v_i := v_i + 1;
  end loop;

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

  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_email));
  perform pg_advisory_xact_lock(hashtext('learnapp:' || v_phone));
  select * into v_prev from learn_applications
   -- The calling account's pending sign-up, or one with no account; never another account's on
   -- the same number or email (customer_learn_apply sets mm.learn_cid; 20261005210200).
   /* One that is not the caller's own is theirs only when the email and the mobile both match: either alone
      may be someone else's sign-up (a shared family phone), and the merge would put this person's name,
      email and 'Me' learner over it (bh10). */
   where status = 'pending'
     and (customer_id = nullif(current_setting('mm.learn_cid', true), '')
          or ((customer_id is null or nullif(current_setting('mm.learn_cid', true), '') is null)
              and lower(email) = v_email and phone = v_phone))
   order by (customer_id = nullif(current_setting('mm.learn_cid', true), '')) desc nulls last,
            (lower(email) = v_email) desc, created_at limit 1;
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
    -- one submission's limit, merged or not (20261005210200)
    if jsonb_array_length(v_list) > 5 then return jsonb_build_object('ok', false, 'error', 'learners'); end if;
  else
    select coalesce(jsonb_agg(x.value order by x.value->>'who' = 'self' desc, x.pos), '[]'::jsonb) into v_list
      from jsonb_array_elements(v_list) with ordinality as x(value, pos);
  end if;
  v_one := v_list->0;

  if v_prev.id is not null then
    update learn_applications set
      name = v_name, email = v_email, phone = v_phone, learners = v_list,
      for_whom = v_one->>'who', learner_name = v_one->>'name', learner_age = (v_one->>'age')::int,
      learner_gender = v_one->>'gender', learner_height = (v_one->>'height')::int, level = v_one->>'level',
      notes = v_notes, heard_from = coalesce(v_heard, heard_from), lang = v_lang, privacy_version = v_pv,
      birth_date  = case when v_new then v_birth   else birth_date end,
      gender      = case when v_new then v_cgend   else gender end,
      nationality = case when v_new then v_nat     else nationality end,
      height      = case when v_new then v_cheight else height end,
      profession  = case when v_new then v_prof    else profession end,
      workplace   = case when v_new and v_wp_on then v_wp else workplace end,
      instagram   = case when v_new then nullif(v_ig, '') else instagram end,
      linkedin    = case when v_new then nullif(v_li, '') else linkedin end,
      ride_news   = case when v_new then v_news    else ride_news end,
      submissions = submissions + 1, updated_at = now()
     where id = v_prev.id;
  else
    insert into learn_applications (for_whom, name, email, phone, learners, learner_name, learner_age, learner_gender,
      learner_height, level, notes, heard_from, lang, privacy_version,
      birth_date, gender, nationality, height, profession, workplace, instagram, linkedin, ride_news)
    values (v_one->>'who', v_name, v_email, v_phone, v_list, v_one->>'name', (v_one->>'age')::int, v_one->>'gender',
      (v_one->>'height')::int, v_one->>'level', v_notes, v_heard, v_lang, v_pv,
      case when v_new then v_birth end, case when v_new then v_cgend end, case when v_new then v_nat end,
      case when v_new then v_cheight end, case when v_new then v_prof end,
      case when v_new and v_wp_on then nullif(v_wp, '') end,
      case when v_new then nullif(v_ig, '') end, case when v_new then nullif(v_li, '') end, v_new and v_news);
  end if;
  return jsonb_build_object('ok', true);
end $function$;

-- 7 staff_merge_customers -------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_merge_customers(p_keep text, p_drop text, p_by text DEFAULT NULL::text, p_op text DEFAULT NULL::text, p_approval text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  k customers%rowtype; d customers%rowtype;
  mv jsonb := '{}'::jsonb; fl text[] := '{}'; ids text[]; m_id bigint;
  tags_moved text[] := '{}'; tags_dup jsonb := '[]'::jsonb; ct customer_tags%rowtype;
  bd customer_badges%rowtype; bdg_moved text[] := '{}'; bdg_dup jsonb := '[]'::jsonb;
  kf customer_flags%rowtype; df customer_flags%rowtype;
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  -- The operator's PIN approval (staff_pin_approve), 2026-10-04.
  if not _pin_ok_strict(p_op, p_approval) then raise exception 'PIN_REQUIRED' using errcode = '42501'; end if;
  if p_keep is null or p_drop is null or p_keep = p_drop then raise exception 'SAME_ACCOUNT' using errcode = '22023'; end if;
  -- both rows locked, lower id first, so two admins merging the same pair cannot cross
  if p_keep < p_drop then
    select * into k from customers where id = p_keep for update;
    select * into d from customers where id = p_drop for update;
  else
    select * into d from customers where id = p_drop for update;
    select * into k from customers where id = p_keep for update;
  end if;
  if k.id is null then raise exception 'NOT_FOUND: keep' using errcode = 'P0002'; end if;
  if d.id is null then raise exception 'NOT_FOUND: drop' using errcode = 'P0002'; end if;
  if k.merged_into is not null or d.merged_into is not null then raise exception 'ALREADY_MERGED' using errcode = '22023'; end if;

  with u as (update queue_entries set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('queue_entries', to_jsonb(ids));
  with u as (update cashier_sales set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('cashier_sales', to_jsonb(ids));
  with u as (update customer_notes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_notes', to_jsonb(ids));
  -- Both accounts may have a correction flag open (one pending per account,
  -- customer_flags_one_pending): the dropped one's fields join the keeper's flag and it is
  -- withdrawn before it moves; unmerge puts both back (20261005210100).
  select * into kf from customer_flags where customer_id = p_keep and status = 'pending' for update;
  select * into df from customer_flags where customer_id = p_drop and status = 'pending' for update;
  if kf.id is not null and df.id is not null then
    update customer_flags
       set fields = kf.fields || array(select f from unnest(df.fields) f where f <> all(kf.fields))
     where id = kf.id;
    update customer_flags set status = 'withdrawn', answered_at = now() where id = df.id;
    mv := mv || jsonb_build_object('flag_fold',
            jsonb_build_object('keep', kf.id, 'drop', df.id, 'keep_fields', to_jsonb(kf.fields)));
  end if;
  with u as (update customer_flags set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('customer_flags', to_jsonb(ids));
  with u as (update push_subscriptions set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('push_subscriptions', to_jsonb(ids));
  with u as (update rider_registrations set matched_customer_id = p_keep where matched_customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('rider_registrations', to_jsonb(ids));
  with u as (update ambassadors set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('ambassadors', to_jsonb(ids));
  with u as (update community_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('community_applications', to_jsonb(ids));
  with u as (update learn_applications set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('learn_applications', to_jsonb(ids));
  with u as (update workshop_jobs set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('workshop_jobs', to_jsonb(ids));
  with u as (update site_messages set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('site_messages', to_jsonb(ids));
  with u as (update promo_codes set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('promo_codes', to_jsonb(ids));
  -- One live award per person per session: the keeper's stands, the other waits voided for an unmerge.
  with u as (update volunteer_hours dup set voided_at = now(), voided_by = 'merge'
              where dup.customer_id = p_drop and dup.source = 'session' and dup.voided_at is null
                and exists (select 1 from volunteer_hours kept where kept.customer_id = p_keep and kept.session_id = dup.session_id
                             and kept.source = 'session' and kept.voided_at is null) returning dup.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_hours_void', to_jsonb(ids));
  with u as (update volunteer_hours set customer_id = p_keep where customer_id = p_drop returning id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_hours', to_jsonb(ids));
  with u as (update volunteer_shifts h set customer_id = p_keep where h.customer_id = p_drop
              and not exists (select 1 from volunteer_shifts x where x.customer_id = p_keep and x.session_id = h.session_id) returning h.id)
    select coalesce(array_agg(id::text), '{}') into ids from u;
  mv := mv || jsonb_build_object('volunteer_shifts', to_jsonb(ids));
  update volunteer_log set customer_id = p_keep where customer_id = p_drop;
  if not exists (select 1 from volunteers where customer_id = p_keep)
     and exists (select 1 from volunteers where customer_id = p_drop) then
    update volunteers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('volunteer', true);
  end if;
  delete from customer_handoffs where customer_id = p_drop; -- two-minute sign-in codes: nothing to keep

  -- tags: a tag the keeper holds already is dropped, the others move (the primary key is (customer, tag))
  /* A dropped one is kept whole in the record, as a badge is, so unmerge gives it back with its window and who
     gave it when, not as a grant with no end (bh10). */
  for ct in select * from customer_tags where customer_id = p_drop loop
    if exists (select 1 from customer_tags where customer_id = p_keep and tag_id = ct.tag_id) then
      delete from customer_tags where customer_id = p_drop and tag_id = ct.tag_id;
      tags_dup := tags_dup || jsonb_build_array(to_jsonb(ct));
    else
      update customer_tags set customer_id = p_keep where customer_id = p_drop and tag_id = ct.tag_id;
      tags_moved := tags_moved || ct.tag_id;
    end if;
  end loop;
  mv := mv || jsonb_build_object('tags_moved', to_jsonb(tags_moved), 'tags_dup', tags_dup);

  -- badges, the same way; a badge the keeper holds already is kept whole in the record for unmerge
  for bd in select * from customer_badges where customer_id = p_drop loop
    if exists (select 1 from customer_badges where customer_id = p_keep and badge_id = bd.badge_id) then
      delete from customer_badges where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_dup := bdg_dup || jsonb_build_array(to_jsonb(bd));
    else
      update customer_badges set customer_id = p_keep where customer_id = p_drop and badge_id = bd.badge_id;
      bdg_moved := array_append(bdg_moved, bd.badge_id);
    end if;
  end loop;
  mv := mv || jsonb_build_object('badges_moved', to_jsonb(bdg_moved), 'badges_dup', bdg_dup);

  -- one-row-per-account records: moved only when the keeper has none
  if not exists (select 1 from customer_ig_followers where customer_id = p_keep)
     and exists (select 1 from customer_ig_followers where customer_id = p_drop) then
    update customer_ig_followers set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('ig_followers', true);
  end if;
  if not exists (select 1 from customer_owner_pwd where customer_id = p_keep)
     and exists (select 1 from customer_owner_pwd where customer_id = p_drop) then
    update customer_owner_pwd set customer_id = p_keep where customer_id = p_drop;
    mv := mv || jsonb_build_object('owner_pwd', true);
  end if;

  -- what the keeper lacked, from the other
  if coalesce(k.height, 0) = 0 and coalesce(d.height, 0) > 0 then update customers set height = d.height where id = p_keep; fl := array_append(fl, 'height'); end if;
  if coalesce(k.gender, '') = '' and coalesce(d.gender, '') <> '' then update customers set gender = d.gender where id = p_keep; fl := array_append(fl, 'gender'); end if;
  if coalesce(k.birth_date, '') = '' and coalesce(d.birth_date, '') <> '' then update customers set birth_date = d.birth_date where id = p_keep; fl := array_append(fl, 'birth_date'); end if;
  if coalesce(k.country, '') = '' and coalesce(d.country, '') <> '' then update customers set country = d.country where id = p_keep; fl := array_append(fl, 'country'); end if;
  if coalesce(k.city, '') = '' and coalesce(d.city, '') <> '' then update customers set city = d.city where id = p_keep; fl := array_append(fl, 'city'); end if;
  if coalesce(k.nationality, '') = '' and coalesce(d.nationality, '') <> '' then update customers set nationality = d.nationality where id = p_keep; fl := array_append(fl, 'nationality'); end if;
  if coalesce(k.type_preference, '') = '' and coalesce(d.type_preference, '') <> '' then update customers set type_preference = d.type_preference where id = p_keep; fl := array_append(fl, 'type_preference'); end if;
  if coalesce(k.photo, '') = '' and coalesce(d.photo, '') <> '' then update customers set photo = d.photo where id = p_keep; fl := array_append(fl, 'photo'); end if;
  if coalesce(k.profession, '') = '' and coalesce(d.profession, '') <> '' then update customers set profession = d.profession where id = p_keep; fl := array_append(fl, 'profession'); end if;
  if coalesce(k.workplace, '') = '' and coalesce(d.workplace, '') <> '' then update customers set workplace = d.workplace where id = p_keep; fl := array_append(fl, 'workplace'); end if;
  if coalesce(k.heard_from, '') = '' and coalesce(d.heard_from, '') <> '' then update customers set heard_from = d.heard_from where id = p_keep; fl := array_append(fl, 'heard_from'); end if;
  if k.socials is null and d.socials is not null then update customers set socials = d.socials where id = p_keep; fl := array_append(fl, 'socials'); end if;

  update customers set merged_into = p_keep, session_token = null where id = p_drop;

  insert into customer_merges (keep_id, drop_id, keep_name, drop_name, moved, filled, merged_by)
    values (p_keep, p_drop, k.name, d.name, mv, to_jsonb(fl), p_by) returning id into m_id;
  return jsonb_build_object('ok', true, 'id', m_id, 'moved', mv, 'filled', to_jsonb(fl), 'keep_name', k.name, 'drop_name', d.name);
end $function$;

-- 7 staff_unmerge_customers -----------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_unmerge_customers(p_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  m customer_merges%rowtype; ids text[]; col text; tg text; bj jsonb;
  cols text[] := array['height','gender','birth_date','country','city','nationality','type_preference','photo','profession','workplace','heard_from','socials'];
begin
  if not is_admin() then raise exception 'ADMIN_ONLY' using errcode = '42501'; end if;
  select * into m from customer_merges where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if m.undone_at is not null then raise exception 'ALREADY_UNDONE' using errcode = '22023'; end if;
  if m.merged_at < now() - interval '30 days' then raise exception 'TOO_LATE' using errcode = '22023'; end if;
  perform 1 from customers where id in (m.keep_id, m.drop_id) order by id for update;
  -- Either account deleted since: nothing to give back to (it failed on a foreign key half way; bh14).
  if (select count(*) from customers where id in (m.keep_id, m.drop_id)) < 2 then
    raise exception 'NOT_FOUND: account' using errcode = 'P0002';
  end if;
  -- The keeper was merged into a third account since: that merge is undone first (20261005210100).
  if exists (select 1 from customers where id = m.keep_id and merged_into is not null) then
    raise exception 'KEEPER_MERGED' using errcode = '22023';
  end if;

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'queue_entries', '[]')) x;
  update queue_entries set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'cashier_sales', '[]')) x;
  update cashier_sales set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_notes', '[]')) x;
  update customer_notes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'customer_flags', '[]')) x;
  update customer_flags set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  -- Two open flags were folded at the merge: the keeper's gets its own fields back, the other
  -- is open again on its own account (20261005210100).
  if m.moved ? 'flag_fold' then
    update customer_flags
       set fields = array(select x from jsonb_array_elements_text(m.moved->'flag_fold'->'keep_fields') with ordinality t(x, o) order by o)
     where id = (m.moved->'flag_fold'->>'keep')::uuid and status = 'pending';
    update customer_flags set status = 'pending', answered_at = null
     where id = (m.moved->'flag_fold'->>'drop')::uuid and customer_id = m.drop_id and status = 'withdrawn'
       and not exists (select 1 from customer_flags x where x.customer_id = m.drop_id and x.status = 'pending');
  end if;
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'push_subscriptions', '[]')) x;
  update push_subscriptions set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'rider_registrations', '[]')) x;
  update rider_registrations set matched_customer_id = m.drop_id where matched_customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'ambassadors', '[]')) x;
  update ambassadors set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'community_applications', '[]')) x;
  update community_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'learn_applications', '[]')) x;
  update learn_applications set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'workshop_jobs', '[]')) x;
  update workshop_jobs set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'site_messages', '[]')) x;
  update site_messages set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'promo_codes', '[]')) x;
  update promo_codes set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);

  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_hours', '[]')) x;
  update volunteer_hours set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_hours_void', '[]')) x;
  update volunteer_hours set voided_at = null, voided_by = null where id::text = any(ids);
  select coalesce(array_agg(x), '{}') into ids from jsonb_array_elements_text(coalesce(m.moved->'volunteer_shifts', '[]')) x;
  update volunteer_shifts set customer_id = m.drop_id where customer_id = m.keep_id and id::text = any(ids);
  if coalesce((m.moved->>'volunteer')::boolean, false)
     and not exists (select 1 from volunteers where customer_id = m.drop_id) then
    update volunteers set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'tags_moved', '[]')) x loop
    update customer_tags set customer_id = m.drop_id where customer_id = m.keep_id and tag_id = tg
      and not exists (select 1 from customer_tags where customer_id = m.drop_id and tag_id = tg);
  end loop;
  /* The dropped account's own copy of a tag both held comes back as it was: its window, who gave it and when
     (bh10; zz_sync_touch stamps updated_at, so the staff pages see it). A record from before kept the tag's id
     alone, and that comes back as before. */
  for bj in select x from jsonb_array_elements(coalesce(m.moved->'tags_dup', '[]')) x loop
    if jsonb_typeof(bj) = 'object' then
      insert into customer_tags select (jsonb_populate_record(null::customer_tags, bj || jsonb_build_object('customer_id', m.drop_id))).*
        on conflict do nothing;
    elsif jsonb_typeof(bj) = 'string' then
      insert into customer_tags (customer_id, tag_id, added_by, added_at)
        values (m.drop_id, bj #>> '{}', 'unmerge', (extract(epoch from now()) * 1000)::bigint)
        on conflict do nothing;
    end if;
  end loop;

  for tg in select x from jsonb_array_elements_text(coalesce(m.moved->'badges_moved', '[]')) x loop
    update customer_badges set customer_id = m.drop_id where customer_id = m.keep_id and badge_id = tg
      and not exists (select 1 from customer_badges where customer_id = m.drop_id and badge_id = tg);
  end loop;
  for bj in select x from jsonb_array_elements(coalesce(m.moved->'badges_dup', '[]')) x loop
    insert into customer_badges select (jsonb_populate_record(null::customer_badges, bj || jsonb_build_object('customer_id', m.drop_id))).*
      on conflict do nothing;
  end loop;
  if coalesce((m.moved->>'ig_followers')::boolean, false)
     and not exists (select 1 from customer_ig_followers where customer_id = m.drop_id) then
    update customer_ig_followers set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;
  if coalesce((m.moved->>'owner_pwd')::boolean, false)
     and not exists (select 1 from customer_owner_pwd where customer_id = m.drop_id) then
    update customer_owner_pwd set customer_id = m.drop_id where customer_id = m.keep_id;
  end if;

  for col in select x from jsonb_array_elements_text(coalesce(m.filled, '[]')) x loop
    -- only while the keeper still holds the value it was given: one it set since is its own (20261007120100)
    if col = any(cols) then
      execute format('update customers k set %I = null from customers d where k.id = $1 and d.id = $2 and k.%I is not distinct from d.%I',
                     col, col, col)
        using m.keep_id, m.drop_id;
    end if;
  end loop;

  update customers set merged_into = null where id = m.drop_id and merged_into = m.keep_id;
  update customer_merges set undone_at = now() where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id, 'keep_name', m.keep_name, 'drop_name', m.drop_name);
end $function$;

-- 8 staff_volunteer_checkin -----------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_volunteer_checkin(p_entry_id text, p_on boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  _sess text := _volunteer_session();
  q queue_entries%rowtype;
  _prev text;
begin
  if _sess is null then raise exception 'VOL_CLOSED' using errcode = '42501'; end if;
  select * into q from queue_entries where id = p_entry_id and session_id = _sess for update;
  if not found then raise exception 'BOOKING_NOT_FOUND' using errcode = 'P0001'; end if;

  if coalesce(p_on, false) then
    if q.status in ('active', 'done') then return jsonb_build_object('ok', true, 'noop', true); end if;
    if q.status not in ('waiting', 'waitlist') then raise exception 'BAD_BOOKING_STATE' using errcode = 'P0001'; end if;
    update queue_entries set status = 'active', checked_in_at = _iso_now() where id = q.id;
    /* the status it had, which the undo puts back (bh10) */
    insert into volunteer_log (user_id, session_id, action, entry_id, prev_status) values (auth.uid(), _sess, 'checkin', q.id, q.status);
    return jsonb_build_object('ok', true);
  end if;

  if q.status in ('waiting', 'waitlist') then return jsonb_build_object('ok', true, 'noop', true); end if;
  if q.status <> 'active' then raise exception 'BAD_BOOKING_STATE' using errcode = 'P0001'; end if;
  if q.donated_at is not null then raise exception 'VOL_DONATED_FIRST' using errcode = 'P0001'; end if;
  if not _volunteer_mine(q.id, 'checkin', 'uncheckin') then raise exception 'VOL_NOT_YOURS' using errcode = '42501'; end if;
  /* Back to what it was before the check-in, a place on the waitlist included, as the portal's undo does; a
     check-in logged before this kept no status and goes back to waiting as it did (bh10). */
  select l.prev_status into _prev from volunteer_log l
   where l.entry_id = q.id and l.action = 'checkin' order by l.at desc, l.id desc limit 1;
  update queue_entries set status = case when _prev = 'waitlist' then 'waitlist' else 'waiting' end, checked_in_at = null
   where id = q.id;
  insert into volunteer_log (user_id, session_id, action, entry_id) values (auth.uid(), _sess, 'uncheckin', q.id);
  return jsonb_build_object('ok', true);
end $function$;

-- 9 vendor_login ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vendor_login(p_login text, p_pwd text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare k text := _vendor_login_key(p_login); u vendor_users%rowtype; thr login_throttle%rowtype; nf int; tok text;
        gate text; hdr text; ua text; got boolean;
begin
  -- the gate (dormant while vendor_gate is empty): only the portal's Worker knows the secret
  select secret_hash into gate from vendor_gate limit 1;
  if gate is not null then
    begin
      hdr := current_setting('request.headers', true)::json ->> 'x-vendor-gate';
    exception when others then hdr := null;
    end;
    if hdr is null or encode(sha256(convert_to(hdr, 'UTF8')), 'hex') <> gate then
      raise exception 'FORBIDDEN' using errcode = '42501';
    end if;
  end if;
  if k is null or coalesce(p_pwd, '') = '' then raise exception 'BAD_LOGIN' using errcode = '28000'; end if;
  /* One try at a time per login: two at once both read the same count and each wrote it plus one, so a burst
     counted as one strike, and a late one could clear a lock just set (bh10). vendor_set_password takes the
     same lock. */
  perform pg_advisory_xact_lock(hashtext('vendorlogin:' || k));
  select * into thr from login_throttle where identifier = 'vendor:' || k;
  if thr.locked_until is not null and thr.locked_until > now() then raise exception 'LOCKED' using errcode = 'P0001'; end if;
  select x.* into u from vendor_users x join vendor_venues v on v.id = x.venue_id
   where x.login = k and x.active and v.status <> 'ended';
  got := found;
  -- No such login costs the same bcrypt round as a wrong password: the time says nothing (20261005210200).
  if not got or u.password_hash is null then perform crypt(p_pwd, gen_salt('bf')); end if;
  if not got or u.password_hash is null or crypt(p_pwd, u.password_hash) <> u.password_hash then
    nf := (case when (thr.locked_until is not null and thr.locked_until <= now()) or thr.updated_at < now() - interval '1 day'
                then 0 else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until, updated_at)
      values ('vendor:' || k, nf, case when nf >= 8 then now() + interval '15 minutes' end, now())
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    return jsonb_build_object('error', 'BAD_LOGIN');
  end if;
  delete from login_throttle where identifier = 'vendor:' || k;
  -- a temporary password lasts 72 hours; staff send a new one after that
  if u.must_change_pwd and u.temp_expires_at is not null and u.temp_expires_at < now() then
    return jsonb_build_object('error', 'TEMP_EXPIRED');
  end if;
  begin
    ua := left(coalesce(current_setting('request.headers', true)::json ->> 'user-agent', ''), 300);
  exception when others then ua := '';
  end;
  tok := encode(gen_random_bytes(32), 'hex');
  delete from vendor_sessions where user_id = u.id and (expires_at <= now() or last_seen < now() - interval '14 days');
  -- at most ten devices at once: the oldest goes
  delete from vendor_sessions where id in (select id from vendor_sessions where user_id = u.id order by last_seen desc offset 9);
  insert into vendor_sessions (user_id, token_hash, expires_at, user_agent)
  values (u.id, sha256(convert_to(tok, 'UTF8')), now() + interval '30 days', ua);
  update vendor_users set last_login_at = now() where id = u.id;
  return jsonb_build_object('id', u.id, 'token', tok, 'must_change', u.must_change_pwd);
end $function$;

-- 9 vendor_set_password --------------------------------------------------
CREATE OR REPLACE FUNCTION public.vendor_set_password(p_uid bigint, p_token text, p_new text, p_old text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare u vendor_users%rowtype := _vendor_auth(p_uid, p_token, true); tok text; why text;
        thr login_throttle%rowtype; nf int; ua text;
begin
  if not u.must_change_pwd then
    perform pg_advisory_xact_lock(hashtext('vendorlogin:' || u.login));  /* one try at a time, as vendor_login (bh10) */
    select * into thr from login_throttle where identifier = 'vendor:' || u.login;
    if thr.locked_until is not null and thr.locked_until > now() then raise exception 'LOCKED' using errcode = 'P0001'; end if;
    if p_old is null or crypt(p_old, u.password_hash) <> u.password_hash then
      -- answered, not raised: a raise would roll the count back
      nf := (case when (thr.locked_until is not null and thr.locked_until <= now()) or thr.updated_at < now() - interval '1 day'
                  then 0 else coalesce(thr.fails, 0) end) + 1;
      insert into login_throttle(identifier, fails, locked_until, updated_at)
        values ('vendor:' || u.login, nf, case when nf >= 8 then now() + interval '15 minutes' end, now())
        on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
      return jsonb_build_object('error', 'BAD_PASSWORD');
    end if;
    delete from login_throttle where identifier = 'vendor:' || u.login;
  end if;
  why := _vendor_pwd_problem(p_new, u.login, u.venue_id);
  if why <> '' then raise exception '%', why using errcode = '22023'; end if;
  if crypt(p_new, u.password_hash) = u.password_hash then raise exception 'SAME_PASSWORD' using errcode = '22023'; end if;
  begin
    ua := left(coalesce(current_setting('request.headers', true)::json ->> 'user-agent', ''), 300);
  exception when others then ua := '';
  end;
  -- every device is signed out; this one gets a fresh session
  delete from vendor_sessions where user_id = u.id;
  tok := encode(gen_random_bytes(32), 'hex');
  insert into vendor_sessions (user_id, token_hash, expires_at, user_agent)
  values (u.id, sha256(convert_to(tok, 'UTF8')), now() + interval '30 days', ua);
  update vendor_users set password_hash = crypt(p_new, gen_salt('bf')), session_token = null,
         must_change_pwd = false, temp_expires_at = null where id = u.id;
  return jsonb_build_object('token', tok);
end $function$;

-- 10 vl_team_peek ---------------------------------------------------------
CREATE OR REPLACE FUNCTION public.vl_team_peek(p_id text, p_token text, p_session_id text, p_code text)
 RETURNS TABLE(team text, race text, div text, partner text, need text, is_full boolean)
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare _code text; m record;
begin
  if p_id is null or not _cust_token_ok(p_id, p_token) then return; end if;
  -- the code read with the prefix of the session's kind: AH- on the Arena race, VL- on Victory Lap (20261028200000)
  _code := _race_code_norm(p_code, case when (select x.ride_kind from sessions x where x.id = p_session_id) = 'arena' then 'AH' else 'VL' end);
  if _code is null then return; end if;
  /* Each look costs a try from this address, 30 in ten minutes: with no limit a script could test codes until
     one named a stranger's first name and gender (bh10). VOLATILE above, so the count is written. */
  if not _ip_gate('vlpeek', 30, interval '10 minutes') then
    raise exception 'THROTTLED' using errcode = 'P0001';
  end if;
  select count(*) as n, min(q.vl->>'race') as race, min(q.vl->>'div') as div,
         min(coalesce(nullif(btrim(q.vl->>'first'), ''), split_part(btrim(coalesce(cx.name, '')), ' ', 1))) as first, min(cx.gender) as gender
    into m
    from queue_entries q join sessions s on s.id = q.session_id
    left join customers cx on cx.id = q.customer_id
   where q.session_id = p_session_id and coalesce(s.ride_kind, '') in ('vlap', 'arena')
     and q.vl->>'team' = _code and coalesce(q.customer_id, '') <> p_id
     and coalesce(q.status, '') not in ('cancelled', 'removed', 'noshow');
  if m.n = 0 then return; end if;
  team := _code; race := m.race; div := m.div; is_full := m.n >= 2;
  partner := case when m.n = 1 then nullif(m.first, '') end;
  need := case m.race when 'wd' then 'female' when 'md' then 'male'
                      when 'xd' then case m.gender when 'male' then 'female' when 'female' then 'male' else '' end
                      else '' end;
  return next;
end $function$;

-- checks: every function kept SECURITY DEFINER and its search_path; vl_team_peek can write; the trigger reads starts_at
do $chk$
declare f text;
begin
  foreach f in array array['public._purge_old(boolean)', 'public._staff_cap(text)', 'public.ambassador_apply(jsonb)',
                           'public.badge_weeks()', 'public._tag_one_of_two()', 'public.learn_apply(jsonb)',
                           'public.staff_merge_customers(text,text,text,text,text)', 'public.staff_unmerge_customers(bigint)',
                           'public.staff_volunteer_checkin(text,boolean)', 'public.vendor_login(text,text)',
                           'public.vendor_set_password(bigint,text,text,text)', 'public.vl_team_peek(text,text,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if (select p.provolatile from pg_proc p where p.oid = 'public.vl_team_peek(text,text,text,text)'::regprocedure) <> 'v' then
    raise exception 'vl_team_peek is not VOLATILE, so its throttle cannot write';
  end if;
  if not exists (select 1 from pg_trigger t where t.tgrelid = 'public.customer_tags'::regclass and t.tgname = 'customer_tags_one_of_two'
                   and pg_get_triggerdef(t.oid) like '%starts_at%') then
    raise exception 'customer_tags_one_of_two is missing or does not fire on starts_at';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261110235100', 'bh10_live_b')
on conflict (version) do nothing;

commit;
