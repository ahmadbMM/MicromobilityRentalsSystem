# Operations TODO — actions that need dashboard access (not code)

These are the items from the enhancement plan that can't be done in the repo.
Delete each section when done.

## 0. queue_entries PII — DONE (stage 1 2026-08-24, stage 2 2026-08-26)
Stage 1 dropped `public read` (verified as the anon role: `queue_entries` → 0 rows, `queue_public`
→ 2,743 rows, the app unaffected; reads had moved to that view plus the token-checked
`my_bookings()` RPC). Stage 2, `supabase/migrations/20260826130000_close_public_insert_booking.sql`,
dropped `public insert booking`, the last thing the anon key could do to the table directly:
customers book through `customer_create_booking` (SECURITY DEFINER), staff under `staff insert`.
Rollback and reasoning live in the two migration files.

## 1. CI gates deploys — DONE
The `deploy` job in `.github/workflows/ci.yml` is the only deployer: it runs after lint, the
build-freshness check and the full Playwright suite, uploads the `dist/` built alongside the tests,
and skips itself (saying so) when `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are absent.
Cloudflare Pages' own Git integration is disabled, so a red run ships nothing. AGENTS.md says the
same under Workflow.

## 2. Verify booking-confirmation emails are live
Cloudflare Pages → Settings → Environment variables: confirm `BREVO_API_KEY` and
`BREVO_SENDER` are set. If not, the confirm endpoint is a silent no-op and customers
get no email. Also confirm `SUPABASE_ANON_KEY` and `DISCORD_WEBHOOK` are set for
`functions/api/booking-confirm.js` and `functions/api/log-error.js`.

## 2b. Switch on push notifications — keys generated, dashboard steps left
A VAPID keypair has been generated in the exact formats this stack needs (raw-point public,
base64url **PKCS#8** private — what `crypto.subtle.importKey('pkcs8', …)` in
`functions/api/push-send.js` expects) and round-trip verified. `push_subscriptions` exists in
production (0 rows, as expected — nobody can subscribe yet).

The private key is NOT in the repo. It is in this session's scratchpad, readable only by you:
`vapid-keys.json` under `/private/tmp/claude-501/-Users-malik-micromobilityrentals/…/scratchpad/`.
Copy it somewhere durable (a password manager) before that directory is cleaned up; if it is
lost, generating a fresh pair is cheap — it only invalidates existing subscriptions, and there
are none.

Public key (not a secret, it ships in the bundle):
`BCWHRc5qLL-3AMO2DDbTo2ftJxKDOBhleOaNW0fzaPfUV4TW4CKTlzWYw1mv_2kQxl10qqR6xTE6ak06DQqNgBQ`

1. Cloudflare Pages → Settings → Environment variables:
   - `VAPID_PUBLIC_KEY` — the public key above
   - `VAPID_PRIVATE_KEY` — from the scratchpad file
   - `VAPID_SUBJECT` — `mailto:info@micromobility.sa`
   - `SUPABASE_SERVICE_KEY` — service-role key (`push_subscriptions` is not anon-readable)
2. Then ask me to set `VAPID_PUBLIC_KEY` in `app.src.html` and rebuild — one line. It is left
   EMPTY on purpose until the server half is in place: setting it first shows riders a
   subscribe toggle whose notifications would silently never arrive, which is worse than no
   toggle at all.
3. Send one real notification to a test account before relying on it. The encryption is checked
   against the RFC 8291 vector in `tests/push.spec.ts`, but nothing has gone through a live
   push service yet.

## 3. Custom domain
Attach the production domain (per the platform plan: micromobility.sa) to the Pages
project, then set `origin` in **`site.config.json`** and run `npm run build:html`. That one
value now feeds the canonical link, hreflang alternates, JSON-LD, the `og:`/`twitter:`
image URLs, `sitemap.xml` and `robots.txt` — there is nothing else to edit by hand.
Note: `micromobility.sa` currently resolves to an unrelated store, so the DNS has to move
before the domain is attached.

## 4. Supabase migration baseline (one-time)
Follow `supabase/migrations/README.md`: install the CLI, link the prod project, run the
baseline dump, commit it. From then on every schema change is a migration file.

## 5. Uptime monitoring (10 min, free)
Add an UptimeRobot (or Cloudflare Health Check) HTTPS monitor on the live URL with a
keyword check for "MicroMobility". Point alerts at the same channel as the Discord
error webhook.

## 6. Supabase hygiene (quarterly)
- Run the dashboard Advisors (security + performance) and fix findings.
- Consider enabling PITR once revenue justifies it (don't wait for a phase gate).
- Rotate the anon key if it ever leaks in a paste/screenshot; it's public by design
  but rotation invalidates scrapers' cached copies.
- Auth → enable leaked-password protection; consider MFA for staff accounts.

## 7. Accessibility backlog
CI now prints axe-core findings for the landing page (EN and AR/RTL) in the test job
log, report-only. Work the list down; when clean, set `STRICT = true` in
`tests/a11y.spec.ts` to lock it in, then extend the audit to the booking flow and
staff views.

## 8. NFC bike tags and bike assignments (JCC Open Sport Days)
Ship order, because the migration hides ten new `bikes` columns behind column grants and
the old client's `select('*')` on bikes fails the moment they land:
1. `supabase db push` on **staging**, then run `supabase/checks/bike-assignments-rpc.sql`
   (transactional, rolls back) and `supabase/checks/security-attributes.sql`.
2. Deploy the client (push main). It lists bike columns by name and talks to the RPCs,
   falling back to the classic check-in while the functions are absent.
3. `supabase db push` on **production**. Re-run the two checks.

**Provisioning a tag** (one per bike, once; Safari cannot write tags):
- iPhone, free "NFC Tools" app → Write → Add a record → URL/URI →
  `https://micromobility.sa/bikes/42` (the bike's number as the Fleet list saves it, no leading
  zeros; the bike's edit form shows this exact link with Copy link and Download QR) → Write →
  hold the tag to the top of the phone.
- A rider's phone opens the bike's page. A staff phone - one that has opened the staff app in
  Safari in the last 7 days - is sent on to `staff.micromobility.sa/?bike=42` instead: the
  staff app writes an `mm_staff_tap` cookie for micromobility.sa each time its panel opens
  (Safari keeps it 7 days at most) and removes it on sign-out; the website's proxy reads it.
  Tags already written with `/b/42` or `/?bike=042` still work.
- Tap it once to check: on a staff phone with no check-in open, the bike's card opens; on a
  rider's phone, the bike's page.
- Place the tag on the head tube or top tube under a clear sticker, away from the frame's
  metal where the phone can rest flat; the QR sticker (same URL) goes beside it for iPads.
- Only URL records trigger iOS; a text record does nothing.

**At the desk:** run the app in **Safari**, not from a Home Screen icon. A Home Screen app
has its own storage, so the tab iOS opens for a tag would see neither the login nor the
open check-in. Flow: Scan the booking QR (or tap the booking) → the check-in modal opens →
tap the bike's tag with the same phone → the new tab shows the modal with the bike filled
and Confirm focused → Confirm in either tab (the second is a harmless no-op). At the return,
tap the bike's tag: a bike out with a rider on the ride opens that rider's Return sheet -
condition (OK / Needs a check / Damaged), notes, the payment for a rider who still owes, and
Return bike. The open
check-in expires after 15 minutes or on sign-out. Bluetooth HID readers type the tag UID
into the Bike field; an unknown UID typed right after a bike number offers "Link this tag".

Returns: every Return (roster, bike card, the payment gate) asks for the condition (OK /
needs a check / damaged, which sends the bike to maintenance) and notes, then calls
`staff_return`; the classic writes run where the RPC is absent. Still to build: the
register's CSV import for the initial fleet and editing of the private columns.
