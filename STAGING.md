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
exist: its check comes straight after `begin;`, so a slip onto production stops there and nothing is committed.
It lays its calendar around today in Riyadh; `--today YYYY-MM-DD` pins it.

Staff accounts: in the staging project's Auth, add each staffer's email with a password, then
`insert into public.staff (user_id, role) select id, 'admin' from auth.users where email = '<email>';`
(`admin` or `frontdesk`). Sign-in URL configuration and Google/Apple callbacks are in mm-platform's
STAGING.md.

A free project pauses after a week without use; restore it from the dashboard.

## 2. The booking and staff app on staging

**Built, waiting for the one-time steps below** (2026-11-10). `scripts/staging-build.mjs` copies the tree to a temporary
folder, points the copy at the staging database and website, builds it with the ordinary build and checks that no
production name is left in it:

- `SUPABASE_URL`, the preconnect link and every other mention of `qpffkzmsfyilicwcsszz` (the Pages Functions' fallbacks
  too) name `jkfhiszcnuvoftvkzaye`; `SUPABASE_KEY` is the staging anon key (`STAGING_SUPABASE_ANON_KEY`; a production or
  service key is refused);
- `site.config.json` `origin` is the staging address (`https://micromobility-staff-staging.pages.dev`, or `--origin`),
  with no former addresses; `STAFF_ORIGIN` (the app and `functions/_middleware.js`) is the same address, so staff paths
  stay on it;
- `https://micromobility.sa` is `https://staging.micromobility.sa` everywhere: the website editor, the links, and
  `PAY_WEB`, the website whose server sends a card refund (`/api/pay/refund`), which the build names in the policy's
  `connect-src` and `frame-src`;
- every title starts "[Staging]", every answer is `noindex`, robots.txt shuts every crawler out.

Locally: `STAGING_SUPABASE_ANON_KEY=<anon key> node scripts/staging-build.mjs --out dist-staging` (dist-staging/ is
ignored). In CI the `staging` job runs it after the production deploy has succeeded and uploads the result with wrangler
to its own Pages project. It does nothing until the steps below are done.

**One-time steps (the user):**

1. **Cloudflare:** Workers & Pages > Create > Pages > Direct Upload, project name **`micromobility-staff-staging`** (no Git
   connection; CI uploads to it with the same `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets as production, so
   the token must cover this account's Pages). Its address is https://micromobility-staff-staging.pages.dev. Optional, in
   its Settings > Variables: `SUPABASE_URL=https://jkfhiszcnuvoftvkzaye.supabase.co` and the staging service key under the
   same names the production project uses, for the Functions that need one (push, error log); without them those answer as
   "not configured", which is fine for testing the store.
2. **GitHub:** the repository's Settings > Secrets and variables > Actions > **Variables**: `STAGING_SUPABASE_ANON_KEY` =
   the staging project's anon key (Supabase > staging project > Project Settings > API keys; it is public, a variable is
   enough), then `STAFF_STAGING` = `on`. The next push to main deploys the copy; to deploy at once, re-run CI from the
   Actions tab (workflow_dispatch) on main.
3. **Supabase (staging project only):** Authentication > URL Configuration: add
   `https://micromobility-staff-staging.pages.dev` and `https://micromobility-staff-staging.pages.dev/**` to the Redirect
   URLs (the Site URL stays the staging website's).
4. **Staff logins on staging:** as in section 1 (an Auth user with a password, then the `insert into public.staff ...`
   line), in the staging project. Production accounts do not exist there.
5. **The website on staging** (mm-platform `staging` branch) must answer `POST /api/pay/refund` from this address: its CORS
   must allow the origin `https://micromobility-staff-staging.pages.dev` with the `authorization` and `content-type`
   headers (production's `/api/pay/refund` the same for `https://staff.micromobility.sa`).

The copy serves both halves (riders and staff) on one address; staff open it at `/?staff` or any staff address
(`/bookings`, `/store`, `/payments`). Links to the volunteer and vendor portals still lead to production's portals, which
have no staging copy.

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
