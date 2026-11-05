-- ============================================================================
-- The volunteer panel (the owner, 2026-11-05: accepted volunteers see a staff-style panel of their session on the portal:
-- the whole booking list, the counts, mobile numbers and booking details). Still no staff access: volunteer_list stays
-- behind _vol_gate, one accepted session, inside its window, and every read is logged.
--
--  1. Two new per-session capabilities, on top of 'list': 'phone' and 'details'. Every session open today gets both as
--     false, so this changes nothing until staff tick them. The privacy notice was changed for them (PRIVACY_NOTICE).
--  2. volunteer_list adds the mobile number under 'phone'; status, bike type, size and height (not on a blood session), and
--     blood type, donor or visitor and club (only on one) under 'details'. Never email, payments or birth date.
--  3. staff_volunteer_session_save keeps the two: an older staff page that does not send them leaves them as they are.
--
-- Rollback: put back volunteer_list from 20261105140000 and take the two lines out of staff_volunteer_session_save; the
-- extra keys in caps are then ignored.
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if position(b in def) > 0 then return def; end if;
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

alter table public.volunteer_sessions
  alter column caps set default '{"checkin":true,"undo":true,"donated":true,"list":false,"counts":true,"phone":false,"details":false}'::jsonb;
update public.volunteer_sessions set caps = '{"phone":false,"details":false}'::jsonb || caps where not (caps ? 'phone' and caps ? 'details');

create or replace function public.volunteer_list(p_id text, p_token text, p_session text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare w volunteer_sessions%rowtype; s sessions%rowtype; _phone boolean; _details boolean; _blood boolean;
begin
  w := _vol_gate(p_id, p_token, p_session, 'list');
  perform _vol_log(p_id, p_session, 'list');
  select * into s from sessions where id = p_session;
  _phone := coalesce((w.caps ->> 'phone')::boolean, false);
  _details := coalesce((w.caps ->> 'details')::boolean, false);
  _blood := coalesce(s.ride_kind, '') = 'blood';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', r.id, 'name', r.name, 'number', r.queue_num,
             'checked_in', r.status in ('active', 'done'),
             'donated', r.donated_at is not null,
             'visitor', coalesce(r.blood_role, '') = 'visitor',
             'own', r.customer_id is not distinct from p_id,
             'desk', _vol_desk_reason(r, s),
             'mine_in', _vol_mine(p_id, r.id, 'checkin', 'uncheckin', r.checked_in_at::text),
             'mine_donated', _vol_mine(p_id, r.id, 'donated', 'undonated', r.donated_at::text))
           || case when _phone then jsonb_build_object('phone', coalesce(nullif(btrim(r.phone), ''), nullif(btrim(c.phone), ''))) else '{}'::jsonb end
           || case when _details then jsonb_build_object('status', r.status) || case when _blood
                then jsonb_build_object('blood_type', nullif(btrim(coalesce(c.blood_type, '')), ''), 'club', nullif(btrim(coalesce(r.blood_club, '')), ''))
                else jsonb_build_object('bike', nullif(btrim(coalesce(r.type_preference, '')), ''), 'size', nullif(btrim(coalesce(r.size, '')), ''), 'height', nullif(btrim(coalesce(r.height::text, '')), ''))
              end else '{}'::jsonb end
           order by r.queue_num)
      from (select q.* from queue_entries q where q.session_id = p_session
              and q.status in ('waiting', 'waitlist', 'active', 'done') order by q.queue_num limit 1000) r
      left join customers c on c.id = r.customer_id), '[]'::jsonb);
end $function$;

do $do$
declare v text;
begin
  select pg_get_functiondef('public.staff_volunteer_session_save'::regproc) into v;
  execute pg_temp._once(v,
    $a$'counts', coalesce((p_caps ->> 'counts')::boolean, true));$a$,
    $b$'counts', coalesce((p_caps ->> 'counts')::boolean, true),
    'phone', coalesce((p_caps ->> 'phone')::boolean, (select (x.caps ->> 'phone')::boolean from volunteer_sessions x where x.session_id = p_session), false),
    'details', coalesce((p_caps ->> 'details')::boolean, (select (x.caps ->> 'details')::boolean from volunteer_sessions x where x.session_id = p_session), false));$b$);
end $do$;

insert into supabase_migrations.schema_migrations (version, name) values ('20261105180000', 'volunteer_panel') on conflict do nothing;

commit;

-- Check: expect true, true, and no session without the two keys.
select p.prosecdef, p.proconfig is not null,
       (select count(*) from public.volunteer_sessions where not (caps ? 'phone' and caps ? 'details')) as sessions_missing_keys
  from pg_proc p where p.oid = 'public.volunteer_list(text,text,text)'::regprocedure;
