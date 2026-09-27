# Staging: a second Supabase project, the same code, generated data

Staging exists so a migration, a fleet import or a new section can be tried on a database that is not
tonight's. It is a separate Supabase project with the same schema, filled with GENERATED data - never a
copy of production, whose names, phones, birth dates and nationalities are under the privacy notice.

## 1. The database

1. Create a project in Supabase (any region; production is `amyqxovbnlreassrqihr`). Note its URL and
   anon key.
2. Apply every migration to it, oldest first: `supabase link --project-ref <staging ref>` then
   `supabase db push` (or paste the files in `supabase/migrations/` in order into its SQL editor).
   Then `supabase/checks/security-attributes.sql` must print nothing.
3. Fill it: `node scripts/seed-staging.mjs > /tmp/seed.sql` and run that file in the staging project's
   SQL editor (the script refuses to run where staff accounts on the company domain exist, so a slip
   onto production fails at its first statement). Options: `--riders 500 --weeks 8 --seed 7`.
4. Staff accounts: in the staging project's Auth, add each staffer's email with a password, then
   `insert into public.staff (user_id, role) values ('<auth user id>', 'admin');`. Real staff emails are
   fine here - staff data is their own. Riders sign up on staging like anyone.
5. Sign-in providers: Google works once the staging URL is added to the Google OAuth client's
   redirect list (Supabase Auth > Providers > Google, and Google Cloud console). Apple waits on the
   owner's Apple Developer account.

## 2. The booking app on staging

Cloudflare Pages already builds a preview for every branch of this repo. Point a preview (or a second
Pages project) at staging with its environment variables: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (the
functions read them), and the app's own client config - `app.src.html` reads the project from
`site.config.json`/its constants, so a staging build sets them there or the deploy sets
`localStorage.cq_secure_auth` for tests. Wallet passes: `APPLE_PASS_*` and `GOOGLE_WALLET_*` may stay
unset; the app hides both buttons on a 501.

## 3. The website on staging

mm-platform has a preview Worker (`micromobility-web-preview`). Give it `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` of the staging project (`wrangler secret put` / the dashboard) and its
booking-app link (`site.links.booking` in site_content, or the env the forms read). Coming Soon on
staging is whatever the seed left (`site.coming_soon` true); flip it from the staff app on staging.

## 4. Testing on staging

Whoever tests signs in to the staging staff app with their real account and works as on a night. Nothing
done there reaches production. To reset, drop and re-run the seed (it uses `on conflict do nothing`, so
re-running only adds what is missing; to start over, truncate `queue_entries, sessions, customer_tags,
customers, bikes` in that order and seed again).
