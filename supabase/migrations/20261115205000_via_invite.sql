-- ============================================================================
-- queue_entries.via takes 'invite' (found 2026-11-15 while building the Farmhouse page).
--
-- petromin_invite_book (20261112234500) and petromin_guest_book (20261113150000) mark the booking they make with
-- via = 'invite', but queue_entries_via_check (20261009230000) still allows only null and 'kiosk'. Every guest
-- booking at micromobility.sa/petromin has failed on that check since the merged page went live: on 2026-11-15 no
-- booking on production carried an invite_no, and the guest path was only ever tried on stubs and a scratch
-- database. The check now takes 'invite' too. Nothing else changes; every existing row is null or 'kiosk'.
--
-- Rollback: put back check (via is null or via = 'kiosk') once no row carries 'invite'.
-- ============================================================================
begin;
set local lock_timeout = '5s';

alter table public.queue_entries drop constraint if exists queue_entries_via_check;
alter table public.queue_entries add constraint queue_entries_via_check
  check (via is null or via in ('kiosk', 'invite'));

insert into supabase_migrations.schema_migrations (version, name)
values ('20261115205000', 'via_invite')
on conflict (version) do nothing;

commit;

-- Check (read only): the check names 'invite'; the ledger row.
select (select pg_get_constraintdef(oid) from pg_constraint where conname = 'queue_entries_via_check') as via_check,
       (select name from supabase_migrations.schema_migrations where version = '20261115205000') as ledger;
