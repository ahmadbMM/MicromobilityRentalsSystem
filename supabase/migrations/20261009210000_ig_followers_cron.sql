-- Instagram follower counts refresh on their own every hour (the owner, 2026-10-09: "let's do the
-- instagram followers automatic counter").
--
-- Until now the counts (customer_ig_followers, 20261003220000) were only refreshed when a staffer
-- opened Community > Accounts. pg_cron now posts to the Edge Function ig-followers-cron
-- (supabase/functions/ig-followers-cron) at :17 every hour; it counts up to 25 accounts that are due,
-- with the same rules and the same 20-minute gap as functions/api/ig-followers.js.
--
-- The function is deployed with verify_jwt off and checks its own secret: a random value kept in the
-- vault as ig_cron_secret, sent by the job as x-cron-secret and compared by ig_cron_secret_ok(),
-- which only service_role may call.
--
-- Rollback:
--   select cron.unschedule('mm-ig-followers');
--   drop function if exists public.ig_cron_secret_ok(text);
--   delete from vault.secrets where name = 'ig_cron_secret';
-- Idempotent.

create extension if not exists pg_net;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'ig_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'ig_cron_secret',
      'x-cron-secret for the ig-followers-cron Edge Function');
  end if;
end $$;

create or replace function public.ig_cron_secret_ok(p text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p, '') <> ''
     and exists (select 1 from vault.decrypted_secrets where name = 'ig_cron_secret' and decrypted_secret = p);
$$;

revoke all on function public.ig_cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.ig_cron_secret_ok(text) to service_role;

select cron.schedule('mm-ig-followers', '17 * * * *', $job$
  select net.http_post(
    url := 'https://qpffkzmsfyilicwcsszz.supabase.co/functions/v1/ig-followers-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ig_cron_secret')),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000)
$job$);
