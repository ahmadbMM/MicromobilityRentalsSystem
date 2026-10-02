# Staging: a second Supabase project, the same code, generated data

Staging exists so a migration, a fleet import or a new section can be tried on a database that is not
tonight's. It is a separate Supabase project with the same schema, filled with GENERATED data - never a
copy of production, whose names, phones, birth dates and nationalities are under the privacy notice.

## 1. The database

It exists: Supabase project `jkfhiszcnuvoftvkzaye` (MicromobilityStaging, Frankfurt, in the same account as
production `qpffkzmsfyilicwcsszz`), made 2026-10-02 for the website's staging (staging.micromobility.sa).

Build or rebuild it from the website repo: `bash scripts/staging-database.sh` in mm-platform (its
STAGING.md has the steps). It copies production's structure, migration history, buckets and rules and
the website's content (pages, catalogue, prices, badges, tags, shop items), then fills it with made-up
people from this repo's `scripts/seed-staging.mjs` (`--riders 500 --weeks 8 --seed 7` via SEED_ARGS).
No real customer data is copied. The seed refuses to run where staff accounts on the company domain
exist, so a slip onto production fails at its first statement.

Staff accounts: in the staging project's Auth, add each staffer's email with a password, then
`insert into public.staff (user_id, role) select id, 'admin' from auth.users where email = '<email>';`
(`admin` or `frontdesk`). Sign-in URL configuration and Google/Apple callbacks are in mm-platform's
STAGING.md.

A free project pauses after a week without use; restore it from the dashboard.

## 2. The booking app on staging

**Not set up yet** (2026-10-03): only the website has a staging copy. What it would take:

Cloudflare's Git integration is off (CI is the only deployer), so this needs a CI job of its own. Point a preview (or a second
Pages project) at staging with its environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the
functions read them), and the app's own client config - `app.src.html` reads the project from
`site.config.json`/its constants, so a staging build sets them there or the deploy sets
`localStorage.cq_secure_auth` for tests. Wallet passes: `APPLE_PASS_*` and `GOOGLE_WALLET_*` may stay
unset; the app hides both buttons on a 501.

## 3. The website on staging

Live since 2026-10-02 at staging.micromobility.sa: mm-platform's `staging` branch deploys it against
this staging database (mm-platform STAGING.md). Coming Soon there is whatever the copied content says
(`site.coming_soon`); flip it in the staging project's SQL editor:
`update public.site_content set value = 'false'::jsonb where key = 'site.coming_soon';`

## 4. Testing on staging

Whoever tests signs in to the staging staff app with their real account and works as on a night. Nothing
done there reaches production. To reset, drop and re-run the seed (it uses `on conflict do nothing`, so
re-running only adds what is missing; to start over, truncate `queue_entries, sessions, customer_tags,
customers, bikes` in that order and seed again).
