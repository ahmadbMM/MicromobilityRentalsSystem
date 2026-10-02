# MicroMobility Rentals — Complete Handoff Specification

This document tells a new implementation (the rentals section of the unified MicroMobility
website) everything it must know to reproduce the current app's functions, logic, sections,
and rules exactly. It is written for an AI/developer that has NOT seen the current codebase.

**Context for the new platform:** the new website will give each customer ONE account for
everything (workshop, rentals, store purchases). The rentals app already has a production
accounts system with real customers. **Strong recommendation: keep the existing Supabase
project as the single backend and build the new platform's other domains (workshop, store)
as new tables that reference `customers.id`.** Rebuilding accounts elsewhere would strand
live customers, bookings, and history. Everything below assumes that backend is reused; the
API contract in §4 is then exactly what the new frontend must call.

---

## 1. System snapshot (what exists today)

- **Live site:** https://micromobilityrentals.pages.dev (Cloudflare Pages, static, no build server).
- **Current frontend:** one vanilla-JS single-page app (`app.src.html`, minified to `index.html`).
  The new site may use any stack — this spec is behavioral, not technological.
- **Backend:** Supabase project `qpffkzmsfyilicwcsszz` (region eu-central-1, Frankfurt) since 2026-10-02; before that `amyqxovbnlreassrqihr` (ap-south-1).
  Postgres + RPCs + Realtime + Storage (public bucket `photos`, files under `p/`).
- **Trilingual:** English, Arabic (full RTL), Spanish. Every user-visible string exists in
  all three; language is a persistent user choice. EN/AR/ES key parity is a hard rule.
- **Theme:** dark by default, light ("sunlight") toggle. Brand green `#008f52`
  (`--green-rgb: 0,143,82`); community-event accent blue `#4aa8f8`.
- **Tests:** Playwright suite (318 tests) with all Supabase traffic stubbed; CI runs on push.

## 2. Roles and authentication

### Customers (custom auth, NOT Supabase Auth)
- Accounts live in the `customers` table. Passwords are bcrypt, verified server-side.
- Sign up / sign in / OAuth (Google, Apple) all go through SECURITY DEFINER RPCs
  (§4). A successful login returns the customer row plus a **`session_token`**.
- Every subsequent customer-owned write or private read passes `(p_id, p_token)` and the
  server validates via `_cust_token_ok(p_id, p_token)`. The token is the customer's proof
  of identity — the new site must store it with the session (currently `localStorage.cq_session`).
- Password rules: min 8 chars, at least one uppercase and one digit. Login is rate-limited.
- Phone numbers are stored with country code (default +966); heights in cm.
- **For the unified account:** reuse these RPCs and this token contract for workshop/store
  too, or wrap them; do not create a second account store.

### Staff (Supabase Auth)
- Staff sign in with email + password through Supabase Auth; a `staff` table maps
  `auth.uid()` → staff row; `is_staff()` (SQL) is the single authority used by RLS and triggers.
- First-time staff (admin-created temp password) are forced to change it before using the panel
  (`staff_mark_pwd_changed` RPC; `must_change_pwd` flag).
- Staff entry points: a subtle "Staff Access" button on the landing footer, or `/staff` URL
  (`?staff` query also works). If the device was previously unlocked (`localStorage.cq_staff='1'`)
  it opens the panel directly; otherwise the email+password prompt.
- **Roles (UX only, not a security boundary):** `admin` (everything) vs `frontdesk`
  (only Sales + Bookings tabs; no delete session, etc.). Stored in `localStorage.cq_role`.

## 3. Data model (tables and semantics)

All ids are text (client-generated `uid()` = base36 random+timestamp), timestamps mostly
ISO strings or ms epoch (noted). Source of truth files: `supabase_schema.sql` (base),
plus migrations: `security-migration.sql`, `tags-events-migration.sql`,
`saturday-members-gate.sql`, `temporary-tags-migration.sql`, `booking-price-integrity.sql`,
`add-customer-notes.sql`, `team-members-table.sql`, `staff-onboarding.sql`.

- **customers** — id, name, email, phone, password_hash (bcrypt), height, gender,
  birth_date, country, city, type_preference (favourite bike type), photo, created_at.
  PII is NEVER readable with the anon key (RLS staff-only; customers reach their own row
  through token RPCs).
- **sessions** — id (usually the date string), day, session_date, capacity, bike_slots
  (JSON: per-type/size allocation and `_time` start–end), status: `open | full | closed | deleted`,
  location, plus event fields: `event_kind` (`jcc` | `community`), `title`,
  `required_tag_id` (null = publicly visible), `needs_approval`, `hide_queue`,
  `spots` (community hard cap), `meet_url`, `breakfast_name`, `breakfast_url`.
- **queue_entries** (bookings) — id, name/email/phone (denormalized for staff views),
  size, type_preference, paid, price, assigned_bike_id, session_id/day/date, queue_num,
  status: `waiting | active | done | noshow | cancelled | removed | waitlist`,
  registered_at, walk_in, customer_id, height, ride_duration, rating_bike, rating_exp,
  feedback, checked_in_at, checked_out_at, promo_code, addons (JSON), pay_method
  (`cash|card|split`), card_amount, `approval` (null/'pending'/'approved'/'rejected';
  null MUST be treated as pending for community rows).
- **bikes** — id, name, size (XS/S/M/L), type (Road/Hybrid/Mountain), brand, model,
  colors (array), status (`available | in-use | maintenance | retired`), location,
  frame/serial, service dates, photo, rental_price.
- **inventory** — add-ons & shop items: id, name, category, brand, qty, price, cost,
  low_threshold, flavour, photo, supplement flags. Low-stock badges + reorder suggestions
  derive from qty vs low_threshold.
- **cashier_sales** — POS lines: id, item name/category, qty, price, pay
  (`cash | card | team | refunded | house`), team_name, receipt/session refs, created_at.
  **Modeling rules (no extra columns):** a discount is a NEGATIVE line with
  `category='__discount__'`; a product-sale card/cash split is a qty-0 meta line
  `category='__cardmeta__'` carrying the card portion; refunds are `pay='refunded'`;
  filter meta/refund lines out of top-seller and revenue aggregations.
- **promo_codes** — code, percent/amount, active window, usage rules. Validated at booking;
  discount is stamped into entry price (server trigger `booking-price-integrity` re-checks
  the price so a tampered client cannot cheapen a booking; `ride_prices` table backs it).
- **tags** — id, slug, name, color, description, auto_grant, locked. Seeded: `tag_jcc`
  (slug `jcc`, auto-granted to every account by trigger `customers_auto_tags`) and
  `tag_saturday` (slug `saturday`, invite-only membership for the Saturday Social Ride).
- **customer_tags** — (customer_id, tag_id) PK, added_by, added_at, note, plus
  **`starts_at` / `expires_at` (ms epoch, null = unbounded)** for temporary tags. A row is
  ACTIVE only while now ∈ [starts_at, expires_at); `_ctag_active()` in SQL, `_tagActive()`
  client-side. RLS: staff-only — customers can never read tags.
- **customer_notes** — staff notes per customer (staff-only RLS).
- **breakfast_spots** — reusable Saturday-ride breakfast venues (name + maps URL, staff-only).
- **team_members** — MM Team roster for POS `pay='team'` sales.
- **staff** — Supabase-Auth-linked staff registry (user_id, email, name, must_change_pwd).
- **error_log / staff_actions** — client error reports (insert-open) and staff audit trail.

## 4. API surface (the contract the new frontend must call)

### Customer RPCs (all take/return per current definitions; anon-callable)
| RPC | Purpose |
|---|---|
| `customer_signup(...)` | create account (bcrypt server-side), returns row + session_token |
| `customer_login(p_identifier, p_pwd)` | email-or-phone login, rate-limited |
| `customer_exists(p_email, p_phone)` | pre-signup duplicate check |
| `customer_reset(p_email, p_phone, p_new_pwd)` | password reset (identity = email+phone pair) |
| `customer_oauth_login(p_email)` / `customer_oauth_signup(...)` | Google/Apple flows |
| `customer_update_profile(p_id, p_token, ...)` | edit own profile |
| `customer_set_own_password(p_id, p_token, p_new_pwd)` | replace a temporary password (only while `customer_pwd_state` says one is waiting); returns the new session token |
| `customer_reset(p_email, p_phone, p_new_pwd)` | forgot password: proof by email + phone. (`customer_change_password`, token-only, was dropped 2026-09-22: a stolen token could take an account over. A "change password" screen needs the current password.) |
| `customer_set_photo(p_id, p_token, p_photo)` | profile photo |
| `my_bookings(p_id, p_token)` | ALL of this customer's queue_entries (their private read) |
| `customer_booking_update(p_id, p_token, p_entry_id, p_patch)` | whitelist-patch OWN booking (cancel, edit); the whitelist NEVER includes `approval` |
| `customer_shiftdown(p_id, p_token, p_session_id, p_from_num)` | close queue-number gap after own cancel |
| `customer_addon_stock(p_id, p_token, p_items)` | consume/restock add-on stock for own booking |
| `list_sessions(p_id, p_token)` | THE session read for customers: public rows + tag-gated rows the ACTIVE tags allow; bad/absent token → public only |
| `community_member(p_id, p_token)` | boolean: does this customer hold an ACTIVE `saturday` tag (drives the members gate UI) |
| `staff_email_for_phone(p_phone)` | staff-login helper (phone → email) |

### Views / direct table access
- `queue_public` (view, anon-readable): bookings with **NO name/email/phone/customer_id/feedback**
  — used for availability counts by signed-out visitors.
- Anon may read: sessions (ungated only), bikes, inventory, promo_codes (read), queue_public.
- Anon may INSERT queue_entries (bookings) and update/delete by id (guarded by obscurity of
  ids + server triggers); staff have full access via `is_staff()` policies.
- Writes to bikes/sessions/inventory/promo_codes/cashier_sales are staff-only.

### Server triggers (behavior the DB enforces regardless of client)
- `queue_entries_assign_qnum` — assigns the final queue number atomically on insert
  (client sends a guess; server wins; unique partial index on (session_id, queue_num)
  exempting cancelled/removed).
- `queue_entries_community_gate` — rejects a community-session booking INSERT unless the
  customer holds an ACTIVE `saturday` tag (staff exempt via `is_staff()`); message:
  "This ride is for community members only."
- `customers_auto_tags` — every new account gets all `auto_grant` tags (the `jcc` tag).
- Price integrity trigger — recomputes/validates entry price vs `ride_prices` and promo.

### Realtime
Postgres-changes subscriptions on: queue_entries, sessions, bikes, inventory, cashier_sales.
Plus polling fallback (`loadDataLight`), Page-Visibility pause, and a 365-day window on queue
reads (`session_date >= today-365`).

## 5. Customer-facing spec (sections, flows, exact rules)

### 5.1 Entry & landing
- Signed-out visitor → full-page auth (sign in / sign up / Google / Apple). No app content.
- Signed-in visitor (fresh visit, including remembered logins) → **PICK YOUR EVENT** page:
  exactly two cards — "Evening Circuit Session" (JCC; sub "Sun & Tue · 9-11pm · Road, Hybrid
  & Mountain"; JCC logo `jcc.png`, white-text variant `jcc-white.png` for dark theme) and
  "Saturday Social Ride" (sub "Every Saturday · 2 levels · Complimentary from Micromobility";
  micromobility logo, `logo-dark.png` on light / `logo.png` on dark). Both cards ALWAYS show.
  Only a same-tab reload restores the previous in-app location.
- Landing footer: subtle "Staff Access" button → staff credential prompt (or panel if unlocked).

### 5.2 Members gate (Saturday Social Ride)
- The ride is VISIBLE to every signed-in customer, but continuing requires membership:
  on click call `community_member(p_id, p_token)`; cache per customer id.
- Non-members get a dialog: title "Community members only", the ride name, explanation text,
  a WhatsApp button **+966 53 442 3513** (`wa.me/966534423513`), an Instagram button
  (instagram.com/MicroMobilitySA), and "Got it". Members proceed normally.
- Gate every path: event card click, session-card click in Reserve, and once more at submit.
  The DB trigger is the real boundary; the UI gate is UX.

### 5.3 Reserve wizard (3 steps, sticky footer, stepper 1-2-3)
- **Step 1 — Session.** Cards for open/full sessions OF THE CHOSEN EVENT ONLY (JCC list
  never mixes in Saturday rides and vice versa). Card shows day/date/time + status pill:
  JCC: "Available" (green), "low spots" hint when ≤3 left, "Waitlist" when full (by status
  OR computed capacity). Community: ALWAYS "Available" until staff explicitly mark the
  session full — computed spots must never surface to customers.
- **Step 2 — Riders.** Quantity 1–10 for JCC (community is hard-locked solo). Per rider:
  name, height (cm → auto size: ≤166 XS, 167–172 S, 173–178 M, ≥179 L), bike type.
  Bike types: Any/Road/Hybrid/Mountain/Road Carbon for JCC; community offers
  Any/Road/Hybrid/Mountain/**Own** ("I have my own bike") and **never Road Carbon**
  (coerce a saved Road Carbon preference to Road in community context).
  Add-ons (inventory items with photos and quantity, stock-capped, sold-out = backorder
  max 10). Price preview: per-type prices — Road 75, Hybrid/Mountain/Any 57.5,
  Road Carbon 250, Own 0 SAR (default 57.5); ranges when "Any"; community rides show FREE
  and never a price. Promo code entry (JCC only).
- **Step 3 — Review & confirm.** Rider summary, total, pay-at-booth note ("bikes assigned
  first-come, first-served"). Confirm inserts the entries.
- **Booking status decision:** JCC → `waitlist` if session marked full OR remaining
  capacity < qty, else `waiting`. Community → `waiting` (approval pending) ALWAYS, unless
  staff marked the session full → `waitlist`. Community entries insert with
  `approval='pending'`, price 0.
- Duplicate guard: an existing active booking for the same customer+session shows an
  "already booked" banner instead of double-booking.
- Offline: failed/offline inserts queue in a localStorage outbox (`cq_book_outbox`) with
  stable ids for dedup, flushed on reconnect; optimistic ticket shown.
- Queue-number races: on unique-index collision, resync + retry with fresh numbers (up to 4
  tries); rollback partial group inserts before retrying.
- Confirmation tickets: JCC — big queue number + QR of booking ref `MMC-<num>-<id6>`,
  add-to-calendar, directions, wallet pass. Community — NO number, NO QR; shows ride title,
  "reservation pending" state, meeting point link, breakfast spot; never a wallet pass.

### 5.4 My Rides
- Groups bookings (same customer+session), soonest first; sections for upcoming and past.
- JCC card: queue number(s) large, status badge, live cue ("You're next!" / position),
  per-rider rows (#num, name, type, bike once assigned, price, paid/pending), add-ons with
  edit, actions: Edit (jumps to wizard step 2), Reschedule (move to another open session,
  renumbering safely), Cancel (reason modal). QR with numbered ref.
- Community card: ride title instead of numbers (queue order is staff-only), approval cue —
  pending (orange) / confirmed (green) / waitlist — meeting point + breakfast spot links,
  Cancel only (no edit/reschedule; no add-ons; free). QR uses the NUMBER-FREE ref
  `MMC-<id6>` (payload must never contain the queue number).
- Past rides: Book again (prefills the wizard), ratings (bike + experience 1–10, feedback);
  a pending post-ride rating is prompted (mandatory modal) on any customer tab.
- "Book my usual": one-tap rebook using remembered height/type/favourite time-of-day;
  NEVER auto-picks a community session.
- Back navigation: a visible "‹ Back" button on all customer tabs (wizard step back, else
  event picker); browser Back must walk wizard steps and views correctly (history states
  deduped; step + chosen event carried in history state).

### 5.5 My Account
- Profile: first/middle/last name, email, phone (country code picker), height, gender,
  birth date, country/city, favourite bike type, profile photo (Supabase Storage, data-URL
  fallback), profile-completeness %; change password; log out. Height and type prefill the
  wizard every time.

## 6. Staff panel spec (tabs and every feature)

Tabs: **Sales (POS) · Bookings · Inventory · Community · Analytics · History** (Sessions is
inside Bookings; Logs merged into History). Front-desk role sees only Sales + Bookings.

### 6.1 Bookings (queue)
- Session summary chips (per open session: waiting/on-bike/done counts, fill bar — community
  fill = RENTERS only vs `spots`), session filter, status filter (Expected/On Bike/Completed/
  No-show/Cancelled), payment filter, **bike filter (All / Bike owner / Rental bike)**,
  search (name/phone/#), sort, live position map, density toggle, desktop table + mobile cards.
- Community stats row (when one community session selected): Riders / Approved / Pending /
  Waitlist / **Bike owners** (spots meter rentals only; own-bike riders are unlimited).
- Row actions by status: waiting → Check in (assign bike modal: filtered by size/type,
  busy bikes blocked), No-show, Edit booking, Note, Cancel; active → Change bike, Return
  bike (records duration, frees bike), add POS sale, Undo check-in, Cancel; done → Reopen,
  Remove; noshow → "Customer showed", Remove; cancelled → Restore (with over-capacity
  confirm; own-bike community restores skip it), Remove.
- Community rows: pending → Approve / Reject / move to Waitlist chip set (a missing
  `approval` value = pending); approved → chip + Undo approval; waitlist → hand-picked
  Promote (community NEVER auto-promotes; JCC auto-promotes oldest waitlisted rider when a
  spot frees). Approvals keep the original queue number (numbers are stable & hidden).
- Walk-in modal (JCC): instant booking without account. **Community "Add rider" modal:**
  pick any customer (search, Saturday-tag chip shown for ACTIVE tags), destination final
  list (pre-approved) or waitlist, **"Rider brings their own bike (does not use a spot)"
  checkbox**, spots-left label counts renters only; staff can exceed spots freely.
- QR scanner: accepts `MMC-<num>-<id6>` and number-free `MMC-<id6>`; matches by id prefix,
  number only as consistency check; opens check-in for waiting riders.
- Bulk select: mark paid, bulk check-in. Payments: cash / card / split (card_amount).
  Undo bar for destructive actions. Keyboard shortcut N = check in next waiting rider.
- Print session report; day close-out with card/cash split (card via
  `card_amount ?? (pay_method=='card' ? price : 0)`).

### 6.2 Sessions (inside Bookings)
- Create/edit/clone/open/close/mark-full/delete (delete blocked while booked; deleted are
  restorable). JCC: date, repeat-weeks (1–12), time range, capacity via per-type/size counts
  or explicit bike assignment (busy bikes excluded). Community: gathering + start times,
  spots (1–500), title (default "Saturday Social Ride"), meeting-point URL, breakfast spot
  picker (reusable list), `required_tag_id` stays null (visible to all; booking gated by
  membership), needs_approval + hide_queue true.
- Two-pane browser (list + detail with riders); fullness derives from renters only for
  community (cap = spots).

### 6.3 Sales (POS)
- Cart of inventory items + custom lines; quantities; discounts (% or SAR → negative
  `__discount__` line); pay cash/card/split (split meta line `__cardmeta__`), MM Team
  (`pay='team'` + editable roster), on-the-house; multi-item branded receipts (shareable),
  edit receipt, refunds (`pay='refunded'`, restocks), mark-paid; links a sale to a booking
  or customer; offline outbox (`cq_sales_outbox`) + persistent voided-ids guard
  (`cq_sales_voided` — a Supabase DELETE blocked by RLS returns no error, so voids must
  never resurrect); stock decrements/restocks are symmetric.

### 6.4 Inventory & Bikes
- Inventory: equipment + supplements, brands/categories/flavours, photos, cost + price,
  low-stock badges, reorder suggestions, subcategories.
- Bikes: fleet CRUD (size/type/brand/model/colors/location/frame/serial/service dates/
  photo/status). Status flows with check-ins/returns automatically.

### 6.5 Community tab
- **Leaderboard:** rider ranking with scope (owner/all), window (all/month/…), branch,
  metric (ride count/…); KPI strip; #1 spotlight with tier progress; milestone watch;
  shareable image; upcoming-rides card.
- **Accounts & tags:** customer list (search, tag filter), per-customer tag chips showing
  validity ("until 12 Aug 2026" / "from 10 Aug 2026" / dimmed "expired"), Edit tags picker.
  **Adding a tag opens a grant dialog: Permanent, or Temporary with either a duration
  preset (1d/3d/1w/2w/1m/3m/6m/1y) or explicit start & end dates — with a "Today" checkbox
  under the start date (pre-checked, locks start to today).** End date is inclusive.
  Removing a tag is one click. Tag CRUD (name/color/description) with locked system tags;
  member counts show ACTIVE holders only. Staff can create accounts and edit customer
  profiles (full field set), set customer passwords, and keep per-customer notes.

### 6.6 Analytics & History
- Analytics: revenue (VAT inclusive/exclusive toggle), ratings, retention, top sellers
  (excluding meta/refund lines), demand fill-rates, growth, height distribution, date-range.
- History: all past bookings with filters + audit log view (staff_actions), CSV-safe
  exports (CSV-injection hardened), bilingual print/export reports.

## 7. Non-negotiable invariants (the rules that must survive any rewrite)

1. **Queue numbers are stable and never reused or shifted.** Cancel/remove frees a number
   for renumbering-down only via the safe shift algorithm; no-show numbers stay reserved.
   DB unique index (session_id, queue_num) exempting cancelled/removed rows is the backstop.
2. **Customers never see community queue numbers or order** — not in UI, not in QR payloads,
   not in wallet passes, not in calendar text.
3. **Community spots meter RENTAL BIKES only**: own-bike riders never consume a spot and are
   unlimited; customers never see computed fullness — only a staff-set "full" status.
4. **Community seats exist only through approval** (pending until staff approve; customers
   cannot self-approve — the booking-update whitelist excludes `approval`).
5. **Membership = ACTIVE `saturday` tag** (window-aware). Enforced in the RPC (UI), the
   insert trigger (security), and gated-session visibility.
6. **Tags are invisible to customers** — no API may reveal the tag system's existence.
7. **PII floor:** anon key can never read customers or named bookings; public availability
   uses `queue_public` only; staff views use fields denormalized onto queue_entries.
8. **Prices are server-validated** (price-integrity trigger + ride_prices); community rides
   are always free; Road Carbon is not offered on community rides.
9. **All money flows are representable in cashier_sales without schema changes** (negative
   discount lines, `__cardmeta__` splits, refunded/team/house pay markers) — aggregations
   must filter meta lines.
10. **Every string ships in EN + AR + ES with full RTL support**; key parity is mandatory.
11. **Offline-first:** booking and sales outboxes with stable-id dedup; voided-sale guard;
    cold-start snapshot cache (photos stripped); optimistic UI with server reconciliation.
12. **Anything staff-destructive gets an Undo** (approve, cancel, delete tag, …).

## 8. Brand, contacts, assets

- Logos: `logo.png` (green M + white wordmark, dark bg), `logo-dark.png` (dark wordmark,
  light bg), `brand.png` (wordmark), `jcc.png` / `jcc-white.png` (JCC logo light/dark),
  `hero.webp` (circuit photo), `social-ride.jpg`.
- Colors: green `#008f52`, community blue `#4aa8f8`, dark theme default `#08090b` base.
- Fonts: Barlow / Barlow Condensed (latin), IBM Plex Sans Arabic (RTL), Chakra Petch accents.
- Contacts: members-dialog WhatsApp **+966 53 442 3513**; site footer WhatsApp/phone
  **+966 56 666 8818**; Instagram **@MicroMobilitySA**; location: Jeddah Corniche Circuit.
- Ops: rides Sun & Tue 9–11pm (JCC), Saturday morning social ride (gathering ~6:30,
  start ~7:00); staff mapping `+966566668818 → mohammad.alhosni@micromobility.sa`.

## 9. Integration notes for the unified platform

- **One account everywhere:** treat `customers` as the platform-wide identity table. Add
  workshop/store tables with `customer_id` FKs. Reuse `customer_login`/`customer_signup`
  and the `(p_id, p_token)` pattern for any new customer-owned endpoint (copy the
  `customer_booking_update` implementation style: token check → whitelist → write).
- **Keep RLS philosophy:** new tables default to staff-only; expose customer access ONLY
  through token-checked SECURITY DEFINER RPCs; public reads only via no-PII views.
- **Don't fork the schema:** apply new SQL as additive migrations in the same project so the
  existing rentals app keeps working during the transition.
- Cloudflare Pages notes if reused: `_headers` (security headers), `functions/_middleware.js`
  blocks non-asset files (.sql/.md/src/tests) from being served publicly; service worker
  versioning (`mmcq-vN` + `styles.css?v=N`).

## 10. Connecting the new website to the live database (zero-migration transfer)

There is NO data migration. The new website connects to the SAME Supabase project the
current app uses, so every customer account, tag (with validity windows), ride/booking,
session, sale, inventory item, and photo is already there the moment the new frontend
goes live. Both sites can run side by side during the transition.

```js
// Supabase JS v2 client - same credentials the current app ships publicly
const SUPABASE_URL = 'https://qpffkzmsfyilicwcsszz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFwZmZrem1zZnlpbGljd2Nzc3p6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAyNDQwODAsImV4cCI6MjEwNTgyMDA4MH0.K6qZpK0oR4MXIaFk4DRJGy-H_m6BYnJ-S31swTiHMhQ';
const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

- This is the PUBLIC anon key (safe in frontend code; RLS + RPCs are the security boundary).
  Never put the service-role key in any frontend.
- Customers sign in on the new domain with their existing email/phone + password via
  `customer_login` — same accounts, rides, and tags appear immediately. Browser sessions
  do NOT carry across domains, so each customer signs in once on the new site; nothing else
  changes for them.
- Storage photos are public URLs under the same project (`/storage/v1/object/public/photos/p/...`)
  and keep working as-is.
- Realtime channels (queue_entries, sessions, bikes, inventory, cashier_sales) are already
  enabled on this project.
- Rules for the transition: additive SQL migrations only (new tables for workshop/store with
  `customer_id` FKs); never drop or rename existing tables/columns/RPCs while the current
  app is still deployed; test schema changes on the staging project first
  (`ariyvnxeywozmwxmylhb`, a data copy) per the house rule.
- Once the new site fully replaces the old one, the old Cloudflare Pages deployment can be
  retired with zero data work - the database never moved.

## 11. Files worth giving the implementing AI alongside this document

1. `app.src.html` — the complete current implementation (UI, logic, i18n dictionaries).
2. `supabase_schema.sql` + `security-migration.sql` + `tags-events-migration.sql` +
   `saturday-members-gate.sql` + `temporary-tags-migration.sql` +
   `booking-price-integrity.sql` — the full backend contract.
3. `styles.css` — current design tokens and components (if visual reference is wanted).
4. `AGENTS.md`, `SECURITY-RUNBOOK.md` — workflow and security model.
5. `tests/` — 318 Playwright specs encoding expected behavior (excellent acceptance tests).
