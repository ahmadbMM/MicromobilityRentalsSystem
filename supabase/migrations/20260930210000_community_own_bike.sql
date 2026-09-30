-- ============================================================================
-- The community application asks whether the applicant has their own bike (the owner, 2026-09-30:
-- "add a new field that has two options ask the registrant if he has a bike or not in the community
-- registration form"). A yes/no answer, stored as community_applications.own_bike (null on
-- applications from before it).
--
-- customer_community_apply (the form's call) and customer_community_me (what the form fills back)
-- are patched in place from their live definitions: each replace must change the text, or the
-- migration stops. The server takes own_bike when the form sends it (true or false, anything else
-- is refused as 'own_bike') and leaves it alone when it does not, so a form page cached from before
-- still goes through; the form itself will not go on without an answer. Security definer,
-- search_path and grants are unchanged (create or replace keeps the grants).
--
-- Rollback: re-run customer_community_apply and customer_community_me from
-- 20260930160000_community_account_first.sql, then drop the column.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

alter table public.community_applications add column if not exists own_bike boolean;

do $patch$
declare d text; n text;
begin
  -- customer_community_apply: read, check and store own_bike
  d := pg_get_functiondef('public.customer_community_apply(text,text,jsonb)'::regprocedure);
  if position('v_own' in d) = 0 then
    n := d;
    n := replace(n, E'  v_prev   community_applications%rowtype;\nbegin',
                    E'  v_prev   community_applications%rowtype;\n  v_own    boolean;\nbegin');
    n := replace(n, E'  -- The notice the account confirmed',
                    E'  -- Their own bike (20260930210000): yes or no; a form from before it sends nothing.\n'
                 || E'  if p ? ''own_bike'' then\n'
                 || E'    if jsonb_typeof(p->''own_bike'') <> ''boolean'' then return jsonb_build_object(''ok'', false, ''error'', ''own_bike''); end if;\n'
                 || E'    v_own := (p->>''own_bike'')::boolean;\n'
                 || E'  end if;\n'
                 || E'  -- The notice the account confirmed');
    n := replace(n, E'heard_from = v_heard, lang = v_lang,',
                    E'heard_from = v_heard, own_bike = coalesce(v_own, own_bike), lang = v_lang,');
    n := replace(n, E'privacy_version, ride_news, customer_id)',
                    E'privacy_version, ride_news, customer_id, own_bike)');
    n := replace(n, E'coalesce(c.ride_news, false), p_id);',
                    E'coalesce(c.ride_news, false), p_id, v_own);');
    if (length(n) - length(d)) < 300 or position('own_bike = coalesce(v_own' in n) = 0
       or position('customer_id, own_bike)' in n) = 0 or position('p_id, v_own);' in n) = 0
       or position(E'  v_own    boolean;\nbegin' in n) = 0 or position('error'', ''own_bike''' in n) = 0 then
      raise exception 'customer_community_apply is not the definition this migration expects';
    end if;
    execute n;
  end if;

  -- customer_community_me: hand the pending application's answer back to the form
  d := pg_get_functiondef('public.customer_community_me(text,text)'::regprocedure);
  if position('own_bike' in d) = 0 then
    n := replace(d, E'then c.heard_from end));', E'then c.heard_from end),\n    ''own_bike'', a.own_bike);');
    if n = d then raise exception 'customer_community_me is not the definition this migration expects'; end if;
    execute n;
  end if;
end $patch$;

commit;
