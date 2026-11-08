-- ============================================================================
-- Badge requests (the owner, 2026-11-08: "add a button on badges for customers to request a badge and
-- adding a proof either a pdf or an image as optional and a comment too optional").
--
-- A rider asks for one of the badges staff give (not one earned by riding: the app works those out
-- itself), with an optional comment and an optional proof, a picture or a PDF. Staff see the requests in
-- People > Badges and give the badge or decline it.
--
--  1. badge_requests: one row per request. Staff read, decide and delete (RLS is_staff()); a rider writes
--     only through customer_badge_request and reads their own through customer_my_badge_requests. The
--     proof is a data: URL (JPEG/PNG/WebP picture or PDF, under 3 MB), the same as vl_receipts: never the
--     public photos bucket. One request waits per rider and badge; sending again replaces it.
--  2. customer_badge_request(p_id, p_token, p_badge, p_comment, p_proof, p_proof_name): token-checked,
--     definer. p_badge is the badge's slug. Refused: a badge earned by riding, a retired one, one the
--     account (or an account merged into it) already holds, an eleventh request waiting.
--     {ok:true,id} | {ok:false,error:'token'|'badge'|'held'|'proof'|'limit'}.
--  3. customer_my_badge_requests(p_id, p_token): the account's requests waiting, and those decided in
--     the last 60 days: [{id, slug, status, at, decided_at, reply, proof_kind}]; null on a bad token.
--  4. _badge_proof_purge(), daily at 00:40 UTC (pg_cron mm-badge-proofs): a proof is deleted 30 days
--     after staff decide (the Privacy Notice says so). The request itself stays.
--
-- Rollback:
--   select cron.unschedule(jobid) from cron.job where jobname = 'mm-badge-proofs';
--   drop function if exists public._badge_proof_purge();
--   drop function if exists public.customer_my_badge_requests(text, text);
--   drop function if exists public.customer_badge_request(text, text, text, text, text, text);
--   drop table if exists public.badge_requests;
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';


/* -- 1. the requests --------------------------------------------------------------------------- */
create table if not exists public.badge_requests (
  id          bigint generated always as identity primary key,
  customer_id text not null references public.customers (id) on delete cascade,
  badge_id    text not null references public.badges (id) on delete cascade,
  comment     text,
  proof       text,
  proof_kind  text,
  proof_name  text,
  status      text not null default 'pending',
  created_at  timestamptz not null default now(),
  decided_at  timestamptz,
  decided_by  text,
  reply       text,
  constraint badge_requests_comment_chk check (comment is null or char_length(comment) <= 500),
  constraint badge_requests_proof_chk check (proof is null
    or (proof ~ '^data:(image/(jpeg|png|webp)|application/pdf);base64,' and length(proof) <= 3000000)),
  constraint badge_requests_kind_chk check (proof_kind is null or proof_kind in ('image', 'pdf')),
  constraint badge_requests_name_chk check (proof_name is null or char_length(proof_name) <= 120),
  constraint badge_requests_status_chk check (status in ('pending', 'given', 'declined')),
  constraint badge_requests_by_chk check (decided_by is null or char_length(decided_by) <= 60),
  constraint badge_requests_reply_chk check (reply is null or char_length(reply) <= 140)
);
comment on table public.badge_requests is
  'A rider asks for a badge staff give, with an optional comment and proof (a picture or PDF as a data: URL); staff give or decline it in People > Badges (20261108210000).';
create unique index if not exists badge_requests_one_waiting on public.badge_requests (customer_id, badge_id) where status = 'pending';
create index if not exists badge_requests_status_idx on public.badge_requests (status, created_at desc);
create index if not exists badge_requests_badge_idx on public.badge_requests (badge_id);

alter table public.badge_requests enable row level security;
revoke all on public.badge_requests from public, anon, authenticated;
grant select, update, delete on public.badge_requests to authenticated;
drop policy if exists badge_requests_staff_read on public.badge_requests;
create policy badge_requests_staff_read on public.badge_requests for select to authenticated using ((select is_staff()));
drop policy if exists badge_requests_staff_update on public.badge_requests;
create policy badge_requests_staff_update on public.badge_requests for update to authenticated
  using ((select is_staff())) with check ((select is_staff()));
drop policy if exists badge_requests_staff_delete on public.badge_requests;
create policy badge_requests_staff_delete on public.badge_requests for delete to authenticated using ((select is_staff()));


/* -- 2. a rider asks ------------------------------------------------------------------------------- */
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
  select id, retired, auto into v_b from badges where slug = lower(btrim(coalesce(p_badge, '')));
  if not found or v_b.retired or v_b.auto then return jsonb_build_object('ok', false, 'error', 'badge'); end if;
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


/* -- 3. a rider reads theirs ------------------------------------------------------------------------ */
create or replace function public.customer_my_badge_requests(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'slug', b.slug, 'status', r.status, 'at', r.created_at,
             'decided_at', r.decided_at, 'reply', r.reply, 'proof_kind', r.proof_kind) order by r.created_at desc)
      from badge_requests r
      join badges b on b.id = r.badge_id
      join customers c on c.id = r.customer_id
     where (c.id = p_id or c.merged_into = p_id)
       and (r.status = 'pending' or r.decided_at > now() - interval '60 days')), '[]'::jsonb);
end $function$;
revoke all on function public.customer_my_badge_requests(text, text) from public;
grant execute on function public.customer_my_badge_requests(text, text) to anon, authenticated;


/* -- 4. a proof goes 30 days after the decision ------------------------------------------------------ */
create or replace function public._badge_proof_purge()
 returns integer
 language sql
 security definer
 set search_path to 'public'
as $function$
  with x as (update badge_requests set proof = null
              where proof is not null and status <> 'pending' and decided_at < now() - interval '30 days'
             returning 1)
  select count(*)::integer from x;
$function$;
revoke all on function public._badge_proof_purge() from public, anon, authenticated;

do $cron$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'mm-badge-proofs';
    perform cron.schedule('mm-badge-proofs', '40 0 * * *', $j$select public._badge_proof_purge()$j$);
  end if;
end $cron$;


/* -- checks ------------------------------------------------------------------------------------------ */
do $chk$
declare f text;
begin
  foreach f in array array['public.customer_badge_request(text,text,text,text,text,text)',
                           'public.customer_my_badge_requests(text,text)', 'public._badge_proof_purge()'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if not has_function_privilege('anon', 'public.customer_badge_request(text,text,text,text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.customer_my_badge_requests(text,text)', 'execute') then
    raise exception 'a client grant is missing';
  end if;
  if has_function_privilege('anon', 'public._badge_proof_purge()', 'execute')
     or has_function_privilege('authenticated', 'public._badge_proof_purge()', 'execute') then
    raise exception '_badge_proof_purge is open to a client';
  end if;
  if has_table_privilege('anon', 'public.badge_requests', 'select') or has_table_privilege('anon', 'public.badge_requests', 'insert')
     or has_table_privilege('authenticated', 'public.badge_requests', 'insert') then
    raise exception 'badge_requests is open to a client';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.badge_requests'::regclass) then
    raise exception 'badge_requests has no RLS';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261108210000', 'badge_requests')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;
