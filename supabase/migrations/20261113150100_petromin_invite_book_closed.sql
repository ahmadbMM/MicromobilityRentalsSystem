-- Run this one AFTER the merged micromobility.sa/petromin page is live (the user, 2026-11-13: a guest makes an account
-- on the page and books through it; micromobility.sa/petromin-invite is turned off).
--
-- petromin_invite_book made a booking with a name and a phone and no account. Nothing calls it any more: the merged
-- page books a guest with petromin_guest_book (20261113150000). It is closed to every client so a booking without an
-- account cannot be made around the page (the desk adds a walk-in its own way and never called it); the bookings it
-- made stay, found and cancelled as before (petromin_invite_lookup, petromin_invite_cancel).
-- Safe to run again. Rollback: grant execute on it to anon, authenticated.

begin;

revoke execute on function public.petromin_invite_book(text, text, text, text, text, text, text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261113150100', 'petromin_invite_book_closed')
on conflict (version) do nothing;

commit;
