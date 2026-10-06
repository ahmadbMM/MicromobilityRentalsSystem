-- ============================================================================
-- A community application from someone with their own bike is saved (2026-10-06: an applicant's
-- Membership step kept saying "Could not reach the server. Please try again.").
--
-- 20261002180000 let customer_community_apply take a bike type of Own ("Bike owner"), which the form
-- picks when the applicant says they have their own bike. The table's own check was left at Road,
-- Hybrid and Mountain, so every such application failed the insert (23514, HTTP 400) and the form
-- read the refusal as a lost connection. The check now takes Own as well; the functions are unchanged.
-- community_apply (the retired one-page form) and community_fix_submit still offer their three types.
-- ============================================================================

begin;

alter table public.community_applications drop constraint if exists community_applications_bike_type_check;
alter table public.community_applications add constraint community_applications_bike_type_check
  check (bike_type in ('Road','Hybrid','Mountain','Own'));

do $chk$
begin
  if pg_get_constraintdef((select oid from pg_constraint
                            where conname = 'community_applications_bike_type_check'
                              and conrelid = 'public.community_applications'::regclass)) not like '%''Own''%' then
    raise exception 'community_applications_bike_type_check does not take Own';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261006120000', 'community_bike_owner_check')
on conflict (version) do nothing;

commit;
