-- Read only. After migration 20261125170000_wednesday_community_ride: what the server says of the wed kind.
-- Expect: the four functions SECURITY DEFINER with a search_path and naming 'wed'; the promo constraint naming it;
-- eleven kind:wed push words; the ledger row; and, once supabase/checks/wednesday-community-ride-sessions.sql has run,
-- each Wednesday session's kind 'wed', its certificate name, and the fare a booking on it gets (57.5 Hybrid, 75 Road,
-- null for an own bike, as on a Petromin night's website booking).
select p.proname, p.prosecdef, p.proconfig, p.prosrc like '%''wed''%' as knows_wed
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('_session_kind', '_vol_sess_name', 'booking_late', 'calendar_feed')
 order by p.proname;
select pg_get_constraintdef(c.oid) like '%''wed''%' as promo_knows_wed
  from pg_constraint c where c.conname = 'promo_codes_ride_kind_known';
select count(*) as push_words_wed from public.push_words where key = 'kind:wed';
select version, name from supabase_migrations.schema_migrations where version = '20261125170000';
select s.id, public._session_kind(s.id) as kind, public._vol_sess_name(s.id) as cert_name,
       public._fare_now(s.id, null, 'Hybrid') as hybrid, public._fare_now(s.id, null, 'Road') as road,
       public._fare_now(s.id, null, 'Own') as own
  from public.sessions s where s.id like '%-wc' order by s.id limit 3;
