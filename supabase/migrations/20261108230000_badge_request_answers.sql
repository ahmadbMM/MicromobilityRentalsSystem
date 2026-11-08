-- ============================================================================
-- Badge requests, the owner's second round (2026-11-08: "i want the images or pdfs attached in request a badge to be
-- deleted after the approval or request of staff, i want each badge when clicking on it to have its details and
-- request button if the customer didnt have it, make a dedicated section for it in staff website").
--
--  1. A proof goes the moment staff answer: badge_requests_drop_proof (before insert or update) clears proof on any
--     row that is no longer pending, whichever device or version answers it. proof_kind and proof_name stay, so staff
--     still see that one was sent. Proofs of requests already answered go now.
--  2. _badge_proof_purge (pg_cron mm-badge-proofs, daily) clears any answered request's proof at once, no longer 30 days
--     after the answer: a net under the trigger.
--  3. customer_badge_request takes any badge the rider does not hold, earned-by-riding ones too (was: only the ones staff
--     give). A retired badge, one held, an eleventh waiting are still refused.
--
-- Rollback (the 30-day rule and staff-given only):
--   drop trigger if exists badge_requests_drop_proof on public.badge_requests;
--   drop function if exists public._badge_req_drop_proof();
--   then re-run sections 2 and 4 of 20261108210000_badge_requests.sql.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- 1. the proof goes with the answer ----------------------------------------------------------- */
create or replace function public._badge_req_drop_proof()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
begin
  if new.status <> 'pending' then new.proof := null; end if;
  return new;
end $function$;
revoke all on function public._badge_req_drop_proof() from public, anon, authenticated;

drop trigger if exists badge_requests_drop_proof on public.badge_requests;
create trigger badge_requests_drop_proof before insert or update on public.badge_requests
  for each row execute function public._badge_req_drop_proof();

update public.badge_requests set proof = null where status <> 'pending' and proof is not null;

comment on table public.badge_requests is
  'A rider asks for a badge, with an optional comment and proof (a picture or PDF as a data: URL); staff give or decline it in the Badge requests section, and the proof is deleted with the answer (20261108210000, 20261108230000).';


/* -- 2. the daily net ------------------------------------------------------------------------------ */
create or replace function public._badge_proof_purge()
 returns integer
 language sql
 security definer
 set search_path to 'public'
as $function$
  with x as (update badge_requests set proof = null
              where proof is not null and status <> 'pending'
             returning 1)
  select count(*)::integer from x;
$function$;
revoke all on function public._badge_proof_purge() from public, anon, authenticated;


/* -- 3. any badge not held may be asked for -------------------------------------------------------- */
create or replace function public.customer_badge_request(p_id text, p_token text, p_badge text,
  p_comment text default null, p_proof text default null, p_proof_name text default null)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_b record;
  v_c text := left(nullif(btrim(coalesce(p_comment, '')), ''), 500);
  v_p text := nullif(btrim(coalesce(p_proof, '')), '');
  v_n text := left(nullif(btrim(regexp_replace(coalesce(p_proof_name, ''), '[[:cntrl:]]', '', 'g')), ''), 120);
  v_k text;
  v_id bigint;
begin
  if not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'token'); end if;
  select id, retired into v_b from badges where slug = lower(btrim(coalesce(p_badge, '')));
  if not found or v_b.retired then return jsonb_build_object('ok', false, 'error', 'badge'); end if;
  if v_p is null then
    v_n := null;
  elsif length(v_p) > 3000000 then
    return jsonb_build_object('ok', false, 'error', 'proof');
  elsif v_p ~ '^data:image/(jpeg|png|webp);base64,' then
    v_k := 'image';
  elsif v_p ~ '^data:application/pdf;base64,' then
    v_k := 'pdf';
  else
    return jsonb_build_object('ok', false, 'error', 'proof');
  end if;
  if exists (select 1 from customer_badges cb join customers c on c.id = cb.customer_id
              where cb.badge_id = v_b.id and (c.id = p_id or c.merged_into = p_id)) then
    return jsonb_build_object('ok', false, 'error', 'held');
  end if;
  if (select count(*) from badge_requests where customer_id = p_id and status = 'pending' and badge_id <> v_b.id) >= 10 then
    return jsonb_build_object('ok', false, 'error', 'limit');
  end if;
  insert into badge_requests (customer_id, badge_id, comment, proof, proof_kind, proof_name)
  values (p_id, v_b.id, v_c, v_p, v_k, v_n)
  on conflict (customer_id, badge_id) where status = 'pending'
  do update set comment = excluded.comment, proof = excluded.proof, proof_kind = excluded.proof_kind,
                proof_name = excluded.proof_name, created_at = now()
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $function$;
revoke all on function public.customer_badge_request(text, text, text, text, text, text) from public;
grant execute on function public.customer_badge_request(text, text, text, text, text, text) to anon, authenticated;


/* -- checks ------------------------------------------------------------------------------------------ */
do $chk$
declare f text;
begin
  foreach f in array array['public.customer_badge_request(text,text,text,text,text,text)', 'public._badge_proof_purge()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'public.customer_badge_request(text,text,text,text,text,text)', 'execute') then
    raise exception 'customer_badge_request lost its client grant';
  end if;
  if has_function_privilege('anon', 'public._badge_proof_purge()', 'execute')
     or has_function_privilege('authenticated', 'public._badge_proof_purge()', 'execute') then
    raise exception '_badge_proof_purge is open to a client';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.badge_requests'::regclass
                   and tgname = 'badge_requests_drop_proof' and not tgisinternal) then
    raise exception 'badge_requests_drop_proof is missing';
  end if;
  if exists (select 1 from public.badge_requests where status <> 'pending' and proof is not null) then
    raise exception 'an answered request still holds its proof';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108230000', 'badge_request_answers')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
