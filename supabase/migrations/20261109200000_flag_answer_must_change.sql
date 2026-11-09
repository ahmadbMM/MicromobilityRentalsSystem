-- ============================================================================
-- A flagged account field is answered only by something else (the owner, 2026-11-09: "don't allow a flagged
-- account field to type in the same info in the field again"). Staff flag a field they think is wrong
-- (customers.fix_fields); typing what the account already holds used to clear the flag. Now a flag whose field came
-- back as it was stays asked, on every way a flag is answered:
--   customer_fix_save        - the rider's correction pop-up in the booking app, and the DEFE / Saturday forms;
--   customer_set_whatsapp    - the WhatsApp card on My Account;
--   customer_community_apply - the community application form (its flags_answered lists only real answers too);
--   customer_learn_apply     - the learn-to-ride sign-up.
-- "The same" is judged by _fix_changed: words with their spaces tidied, an email in any case, a number by its last
-- nine digits, a handle in any case, an emergency contact by name, number and relation together, the rest exactly.
-- "I don't have one" is an answer and is never compared, nor is a password (staff cannot flag one). The two forms
-- save the emergency contact by its own call before applying, so there it is taken as answered, as before.
-- The four functions are patched in place from their LIVE definitions (anchors that must each be found exactly
-- once), so no other change made to them since their migrations is lost; running this twice changes nothing.
-- ============================================================================

begin;

-- p_keys that changed between c (the row as it was) and the row as it is now, in their order; p_keep pass as changed.
create or replace function public._fix_changed(c public.customers, p_id text, p_keys text[], p_keep text[] default '{}'::text[])
returns text[]
language plpgsql stable
set search_path to 'public'
as $$
declare n customers%rowtype;
begin
  select * into n from customers where customers.id = p_id;
  if not found then return coalesce(p_keys, '{}'::text[]); end if;
  return array(
    select k from unnest(coalesce(p_keys, '{}'::text[])) with ordinality u(k, i)
     where k = any (coalesce(p_keep, '{}'::text[]))
        or not coalesce(case
             when k = 'name' then
               regexp_replace(btrim(coalesce(n.name, '')), '\s+', ' ', 'g') = regexp_replace(btrim(coalesce(c.name, '')), '\s+', ' ', 'g')
             when k = 'email' then lower(btrim(coalesce(n.email, ''))) = lower(btrim(coalesce(c.email, '')))
             when k = 'phone' then
               right(regexp_replace(coalesce(n.phone, ''), '\D', '', 'g'), 9) = right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9)
             when k = 'whatsapp' then
               n.whatsapp_same is not distinct from c.whatsapp_same
               and case when coalesce(n.whatsapp_same, false)
                        then right(regexp_replace(coalesce(n.phone, ''), '\D', '', 'g'), 9) = right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 9)
                        else right(regexp_replace(coalesce(n.whatsapp, ''), '\D', '', 'g'), 9) = right(regexp_replace(coalesce(c.whatsapp, ''), '\D', '', 'g'), 9) end
             when k in ('country', 'city') then
               n.country is not distinct from c.country and coalesce(n.city, '') = coalesce(c.city, '')
             when k in ('profession', 'workplace') then
               regexp_replace(btrim(coalesce(to_jsonb(n) ->> k, '')), '\s+', ' ', 'g') = regexp_replace(btrim(coalesce(to_jsonb(c) ->> k, '')), '\s+', ' ', 'g')
             when k in ('instagram', 'x', 'tiktok', 'linkedin') then
               lower(btrim(coalesce(n.socials ->> k, ''))) = lower(btrim(coalesce(c.socials ->> k, '')))
             when k = 'emergency' then
               regexp_replace(btrim(coalesce(n.emergency_name, '')), '\s+', ' ', 'g') = regexp_replace(btrim(coalesce(c.emergency_name, '')), '\s+', ' ', 'g')
               and right(regexp_replace(coalesce(n.emergency_phone, ''), '\D', '', 'g'), 9) = right(regexp_replace(coalesce(c.emergency_phone, ''), '\D', '', 'g'), 9)
               and lower(coalesce(n.emergency_relation, '')) = lower(coalesce(c.emergency_relation, ''))
             when k = 'emergency2' then
               regexp_replace(btrim(coalesce(n.emergency2_name, '')), '\s+', ' ', 'g') = regexp_replace(btrim(coalesce(c.emergency2_name, '')), '\s+', ' ', 'g')
               and right(regexp_replace(coalesce(n.emergency2_phone, ''), '\D', '', 'g'), 9) = right(regexp_replace(coalesce(c.emergency2_phone, ''), '\D', '', 'g'), 9)
               and lower(coalesce(n.emergency2_relation, '')) = lower(coalesce(c.emergency2_relation, ''))
             when k in ('birth_date', 'gender', 'nationality', 'height', 'photo', 'type_preference', 'heard_from') then
               (to_jsonb(n) -> k) is not distinct from (to_jsonb(c) -> k)
             else false  -- the password, and anything unknown: never "the same"
           end, false)
     order by i);
end $$;
revoke execute on function public._fix_changed(public.customers, text, text[], text[]) from public, anon, authenticated;

do $patch$
declare
  f text; d text; a text; b text;
  -- each: function, anchor, replacement
  p text[][] := array[
    array['public.customer_fix_save(text,text,jsonb)',
$a1$  stored := array(select f from unnest(stored) f where f <> all(done));$a1$,
$b1$  -- A field staff flagged is answered only by something else (the owner, 2026-11-09): one that came back as it was
  -- stays asked (_fix_changed, 20261109200000). "I don't have one" is an answer; the server's own asks are not flags.
  done := array(select x from unnest(done) x
                 where x = any(none)
                    or not (x = any(stored) or (x in ('country','city') and stored && array['country','city']))
                    or x = any(_fix_changed(c, p_id, done)));
  stored := array(select f from unnest(stored) f where f <> all(done));$b1$],
    array['public.customer_set_whatsapp(text,text,boolean,text)',
$a2$  if 'whatsapp' = any(coalesce(c.fix_fields, '{}'::text[])) then$a2$,
$b2$  -- the same answer again leaves the flag asked (20261109200000)
  if 'whatsapp' = any(coalesce(c.fix_fields, '{}'::text[])) and 'whatsapp' = any(_fix_changed(c, p_id, array['whatsapp'])) then$b2$],
    array['public.customer_community_apply(text,text,jsonb)',
$a3$    update customers set fix_fields = array(select f from unnest(fix_fields) f where not (f = any (v_answered)))
     where id = p_id;$a3$,
$b3$    -- an answer that left a flagged field as it was keeps its flag (20261109200000); the emergency contact was saved
    -- by its own call before this one, so it counts as answered, as before
    v_answered := _fix_changed(c, p_id, v_answered, array['emergency']);
    update community_applications set flags_answered = array(select f from unnest(flags_answered) f where f = any (v_answered))
     where track_token = v_track;
    update customers set fix_fields = array(select f from unnest(fix_fields) f where not (f = any (v_answered)))
     where id = p_id;$b3$],
    array['public.customer_learn_apply(text,text,jsonb)',
$a4$where not (f = any (array_remove(array[$a4$,
$b4$where not (f = any (_fix_changed(c, p_id, array_remove(array[$b4$],
    array['public.customer_learn_apply(text,text,jsonb)',
$a5$]::text[], null))))$a5$,
$b5$]::text[], null), array['emergency']))))$b5$]
  ];
  i int;
  changed boolean := false;
begin
  -- a function's edits are made together (customer_learn_apply's two open and close one bracket), then it is replaced once
  for i in 1 .. array_length(p, 1) loop
    f := p[i][1]; a := p[i][2]; b := p[i][3];
    if i = 1 or f <> p[i - 1][1] then d := pg_get_functiondef(f::regprocedure); changed := false; end if;
    if position(b in d) = 0 then  -- not patched yet
      if (length(d) - length(replace(d, a, ''))) / length(a) <> 1 then
        raise exception '20261109200000: % - anchor % not found exactly once', f, i;
      end if;
      d := replace(d, a, b); changed := true;
    end if;
    if i = array_length(p, 1) or f <> coalesce(p[i + 1][1], '') then
      if changed then execute d; end if;
    end if;
  end loop;
end $patch$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261109200000', 'flag_answer_must_change')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- Check (read only): the helper is there and closed to clients, the four functions call it and are still definer
-- with their search_path, and the ledger row is in. Every column should read true.
select (select count(*) = 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = '_fix_changed') as helper,
       not has_function_privilege('anon', 'public._fix_changed(public.customers,text,text[],text[])', 'execute')
         and not has_function_privilege('authenticated', 'public._fix_changed(public.customers,text,text[],text[])', 'execute') as helper_closed,
       (select count(*) = 4 from pg_proc where pronamespace = 'public'::regnamespace and prosecdef and proconfig is not null
          and proname in ('customer_fix_save', 'customer_set_whatsapp', 'customer_community_apply', 'customer_learn_apply')
          and prosrc like '%\_fix\_changed(%') as four_patched_definer,
       (select count(*) = 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'customer_learn_apply'
          and prosrc like '%null), array[''emergency'']))))%') as learn_closed_right,
       exists (select 1 from supabase_migrations.schema_migrations where version = '20261109200000' and name = 'flag_answer_must_change') as ledger;
