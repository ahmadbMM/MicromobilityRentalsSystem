-- ============================================================================
-- The public (customer / anon) RPCs: the 2026-10-07 bug hunt, database half. Each function is patched in
-- place from its live definition (pg_get_functiondef, so SECURITY DEFINER, search_path, volatility and
-- the grants stay as they are); each anchor must match exactly once. Signatures and answers unchanged.
--
--  1. customer_community_me fills the community and learn forms' step 2 back from a pending application.
--     It still matched one by the account's email or phone whoever's it was, so a second account on a
--     shared number (staff allow that, 20260930180000) was told it had applied and was handed the other
--     person's answers (birth date, nationality, handles, profession, workplace). It now matches the
--     account's own application, or by email / phone only one that has no account - the rule
--     customer_community_apply and customer_learn_apply follow since 20261005210200 (item 9).
--  2. customer_fix_save took any 'YYYY-MM-DD' as a birth date: an impossible date (2026-02-31) or one in
--     the future was stored. It now takes what customer_set_birth_nat and customer_update_profile take
--     (_ymd_ok: a real date from 1900 to today in Riyadh); anything else stays asked, as other refusals do.
--  3. customer_token_ok - the boot check that signs a stale device out - still said yes to the token of
--     an account merged into another, which every other door refuses (_cust_token_ok, 20261005210100).
--     Such a device stayed signed in to an account whose every call failed. It now agrees with
--     _cust_token_ok, so the device is signed out and signs back in as the keeper (one such token is live).
--  4. member_area listed the next members' rides with private (tag-gated) events among them, to members
--     who do not hold the tag; club_rides and badge_weeks leave those out ("private events are nobody
--     else's business", 20260925140000 item 11, 20261004100000). A private ride is now listed only to an
--     account that holds its tag or a booking on it, as list_sessions shows them.
--  5. customer_update_profile: an email another account has was refused by the unique index, whose
--     words the runner step (and _emErrSay) do not know, so the rider read "could not reach the server".
--     It is now refused as 'email_taken' (23505, the same code), the words customer_fix_save and the
--     _customer_email_alias trigger already use and the app already says errEmailTaken for. Only a
--     changed email is checked, so an account that already shares one still saves its other fields.
--  6. ambassador_mine ordered "(customer_id = p_id) desc": a null sorts first under desc, so an
--     ambassador row found by the phone alone came before the one linked to the account. Now nulls last,
--     as every other such ordering.
--
-- Not touched: staff_* and trigger functions; grants; tables.
--
-- Rollback: run each patch backwards (the replacement text back to its anchor) or re-run the
-- pg_get_functiondef of customer_community_me, customer_fix_save, customer_token_ok, member_area,
-- customer_update_profile(11 arguments) and ambassador_mine saved before this migration.
-- Idempotent (each patch is skipped when its function already carries '(20261007120000)').
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

create or replace function pg_temp._patch(sig text, a text, b text) returns void language plpgsql as $f$
declare d text;
begin
  d := pg_get_functiondef(sig::regprocedure);
  if position('(20261007120000)' in d) > 0 then
    raise notice '% is already patched; nothing to do', sig;
    return;
  end if;
  execute pg_temp._once(d, a, b);
end $f$;


-- ── 1. customer_community_me: another account's application stays its own ──────────────────
select pg_temp._patch('public.customer_community_me(text,text)',
$a$     and (x.customer_id = p_id or lower(x.email) = lower(btrim(coalesce(c.email,''))) or x.phone = c.phone)$a$,
$b$     -- another account's application stays its own, whatever number or email it shares (20261007120000)
     and (x.customer_id = p_id
          or (x.customer_id is null and (lower(x.email) = lower(btrim(coalesce(c.email,''))) or x.phone = c.phone)))$b$);


-- ── 2. customer_fix_save: a birth date is a real date, not in the future ────────────────────
select pg_temp._patch('public.customer_fix_save(text,text,jsonb)',
$a$      when 'birth_date' then
        if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then continue; end if;$a$,
$b$      when 'birth_date' then
        -- a real date up to today, as customer_set_birth_nat takes it (20261007120000)
        if v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or not _ymd_ok(v) then continue; end if;$b$);


-- ── 3. customer_token_ok: a merged-away account's token opens nothing ───────────────────────
select pg_temp._patch('public.customer_token_ok(text,text)',
$a$and p_token is not null);$a$,
$b$and p_token is not null
                                         and merged_into is null);  -- as _cust_token_ok (20261007120000)$b$);


-- ── 4. member_area: a private ride only to those it is for ──────────────────────────────────
select pg_temp._patch('public.member_area(text,text)',
$a$       and s.session_date >= v_today order by s.session_date limit 8) t;$a$,
$b$       -- a private (tag-gated) ride only to an account holding its tag or a booking on it, as
       -- list_sessions shows them (20261007120000)
       and (s.required_tag_id is null
            or exists (select 1 from customer_tags ct
                        where ct.customer_id = p_id and ct.tag_id = s.required_tag_id
                          and _ctag_active(ct.starts_at, ct.expires_at))
            or exists (select 1 from queue_entries q2
                        where q2.session_id = s.id and q2.customer_id = p_id
                          and q2.status in ('waiting','waitlist','active','done')))
       and s.session_date >= v_today order by s.session_date limit 8) t;$b$);


-- ── 5. customer_update_profile: another account's email is 'email_taken' ────────────────────
select pg_temp._patch('public.customer_update_profile(text,text,text,text,text,integer,text,text,text,text,text)',
$a$  elsif v_email is null then
    v_email := case when p_email is null then null else '' end;
  end if;$a$,
$b$  elsif v_email is null then
    v_email := case when p_email is null then null else '' end;
  end if;
  -- An email another account has is refused in the words the app knows (customer_fix_save's), not the
  -- unique index's; another account's Apple address is _customer_email_alias's to refuse (20261007120000).
  if coalesce(v_email, '') <> '' and lower(btrim(v_email)) is distinct from lower(btrim(coalesce(c.email, '')))
     and exists (select 1 from customers o where o.id <> p_id and lower(btrim(o.email)) = lower(btrim(v_email))) then
    raise exception 'email_taken' using errcode = '23505';
  end if;$b$);


-- ── 6. ambassador_mine: the row linked to the account first ─────────────────────────────────
select pg_temp._patch('public.ambassador_mine(text,text)',
$a$   order by (customer_id = p_id) desc, id limit 1;$a$,
$b$   order by (customer_id = p_id) desc nulls last, id limit 1;   -- a null sorts first under desc (20261007120000)$b$);


-- ── checks ────────────────────────────────────────────────────────────────────────────────────
do $chk$
declare f text;
begin
  foreach f in array array[
    'public.customer_community_me(text,text)',
    'public.customer_fix_save(text,text,jsonb)',
    'public.customer_token_ok(text,text)',
    'public.member_area(text,text)',
    'public.customer_update_profile(text,text,text,text,text,integer,text,text,text,text,text)',
    'public.ambassador_mine(text,text)'] loop
    if position('(20261007120000)' in pg_get_functiondef(f::regprocedure)) = 0 then
      raise exception '% was not patched', f;
    end if;
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% lost SECURITY DEFINER or its search_path', f;
    end if;
    if not has_function_privilege('anon', f, 'execute') or not has_function_privilege('authenticated', f, 'execute') then
      raise exception '% lost a client grant', f;
    end if;
  end loop;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261007120000', 'bug_hunt_public')
on conflict (version) do nothing;

commit;
