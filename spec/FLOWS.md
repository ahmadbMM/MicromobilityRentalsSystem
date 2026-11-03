# FLOWS.md — MicroMobility Rentals

Every user journey, end to end, as numbered steps with decision branches. Automatic behaviours
(things that happen with nobody pressing anything) are called out as **[AUTO]**.

Rules referenced here are specified in [BUSINESS-RULES.md](BUSINESS-RULES.md); screens and copy
in [SCREENS.md](SCREENS.md).

---

## A. CUSTOMER FLOWS

### A1. First visit → account

1. Browser requests `/`. The `<head>` script sets `data-theme="dark"` (the one token set the
   site renders with) and clears any stored theme preference from earlier builds.
2. It also reads `?lang=` or `localStorage.cq_lang`; for `ar` it sets `dir="rtl"` immediately and
   **starts fetching `lang/ar.json`** before the app script parses.
3. `#loading-screen` shows the brand loading state: the `#1A1919` ground and a neon-green mark
   inside a rotating ring. No text — the chosen language only sets the container's `aria-label`.
   - **[AUTO]** If boot stalls, the loading screen force-hides after **5 seconds**.
   - It stays up for at least **250 ms** and fades out over **180 ms**, so a fast load does not flash.
4. `_sbReady` waits for supabase-js.
   - **Branch — library never loads** (ad-blocker, offline): resolves anyway after **7 s** and
     the app continues in degraded mode from the `cq_snapshot` cache. Polling continues for 60 s
     so a late arrival still reconnects.
5. `loadData()` fetches queue (60-day window), bikes, sessions in parallel.
   - **[AUTO]** The full 365-day window streams in shortly after.
6. **Branch — signed out** → the landing page with a sign-in CTA.
   **Branch — signed in** (a `cq_session` with a `session_token`) → the **event picker**.
   - Only a **same-tab reload** restores the previous in-app location (`cq_nav`); a fresh visit
     always lands on the picker.

**Sign up**

7. Tap sign-in → `#auth-modal`, tab `authSignup`.
8. Enter first/last name, email, phone (country picker, default `+966`), password ×2, height,
   gender.
   - Password must be **≥8 chars with at least one uppercase and one digit** (client).
9. Submit → `customer_exists(email, phone)` pre-check, then `customer_signup(...)`.
   - **Branch — duplicate**: the RPC raises `DUPLICATE`; the modal shows the duplicate error.
10. On success the RPC returns `{id, session_token}`.
    **[AUTO]** the `customers_auto_tags` trigger grants every `auto_grant` tag (today: `jcc`).
11. `setSession()` stores it in `localStorage` (or `sessionStorage` if "remember me" is off).
    - **Branch — storage throws** (Safari "Block All Cookies"): falls back to an in-memory
      session; the visit works, the customer is just not remembered. **Never surfaces as an error.**
12. → event picker.

**Sign in**

7'. Enter email **or phone** + password → `customer_login`.
   - **Branch — locked**: after **8 consecutive failures** the identifier is locked for
     **15 minutes**; the RPC raises `LOCKED` and the UI shows a wait message.
   - **Branch — legacy `sha256:` hash**: **[AUTO]** transparently re-hashed to bcrypt on success.
   - **[AUTO]** The **existing** `session_token` is reused, so other signed-in devices stay valid.

**OAuth (Google / Apple)**

7''. Tap `continueGoogle` / `continueApple`.
   - **Branch — in-app browser** (Instagram/Facebook webview): Google is blocked; the app detects
     it and shows `iabGoogleBlocked` rather than failing silently.
   - The OAuth return **navigates natively** — the service worker deliberately does not serve it
     from cache, because supabase-js must read the URL parameters.
8''. `customer_oauth_login(email)`.
   - **Branch — no account yet** → `openGoogleComplete`: phone, height, gender →
     `customer_oauth_signup(...)`.

---

### A2. Browsing sessions

1. On the picker, two cards always show: **Open Sports Day** and **Micromobility Experiences** (the T100 Triathlon Prep card was removed 2026-09-14; the event kind still exists for staff and direct links).
2. **Branch — Evening Circuit** → `S.selEvent='jcc'` → Reserve step 1.
3. **Branch — Micromobility Experiences** → the **members gate**:
   1. call `community_member(p_id, p_token)` (cached per customer id);
   2. **member** → `S.selEvent='community'` → Reserve step 1, listing **every non-JCC session**;
   3. **non-member** → the members-only dialog (WhatsApp **+966 53 442 3513**, Instagram,
      "Got it"). The journey stops here.
4. Step 1 lists sessions of the chosen event with status `open` or `full`, date-sorted, each
   colour-coded by ride (`ev-jcc` blue / `ev-saturday` green / `ev-petromin` red).
5. Card status:
   - session `full` → `waitlistLabel`;
   - otherwise `availLabel`, tinted `spots-low` when **≤3** places remain;
   - **an approval ride never shows the low hint** — computed fullness is never surfaced to
     customers on those rides.
6. **[AUTO]** While the customer sits on this screen, realtime + a 30-second poll keep spot counts
   and statuses moving.

---

### A3. Booking (the main flow)

**Step 1 — Session**

1. Tap a session card → `selectSessCard(id)`.
   - **Branch — community ride and not a member** → members dialog, stop.
2. `regContinueBtn` (disabled until a session is chosen) → step 2.

**Step 2 — Riders**

3. Choose quantity.
   - JCC: **1–10**.
   - Petromin: **1–4** (`groupCapHint`).
   - Saturday: **forced to 1** — the control is locked.
4. Per rider: name (rider 1 defaults to the account holder), height → **[AUTO]** size via
   `heightToSize()`, and bike type.
   - **[AUTO]** On any community ride a carried-over `Road Carbon` choice is coerced to `Road`
     (and to `Any` in a second guard); the option is not offered.
   - **[AUTO]** Types listed in `customers.hidden_types` are removed from this customer's picker.
5. Optional add-ons (stock-capped; sold out becomes a backorder up to 10).
6. Optional promo code (**JCC only**) → `applyPromoCode()` validates locally and reports
   `promoInvalidMsg` / `promoExpiredMsg` / `promoUsedUpMsg` / `promoNotYoursMsg`.
7. Price preview: per-type prices, a range for `Any`, `freeLabel` on a free ride,
   `onTheHouseLabel` when the house perk applies **and rider 1 is the account holder**.
8. `regReviewBtn` → step 3.

**Step 3 — Review & confirm**

9. Summary: session, booked-by, per-rider rows, add-ons, total.
10. `regConfirmBtn` → `submitReg()`.

**Submit — the sequence that matters** ([app.src.html:6010](../app.src.html#L6010))

11. **Re-fetch the queue** — the duplicate check must not run on stale data (a second tab or a
    lost-response retry could otherwise book the same customer twice).
12. **Duplicate guard**: an existing `waiting`/`active`/`waitlist` booking for this
    customer+session (by account id, else by phone) →  the already-booked banner with
    **Modify existing**. Stop.
13. **Re-decide waiting vs waitlist** against the just-fetched queue:
    `session.status === 'full'` **or** (non-community and `spotsLeft < needed`) → `waitlist`.
14. **Branch — waitlist has no room** (`waitlistRoom < qty`) → toast `errWaitlistFull`. Stop.
15. Build the entry rows: client-generated ids, a guessed `queueNum` base, `waitlistNum` base,
    `approval='pending'` on an approval ride.
16. **Branch — offline** → queue into `cq_book_outbox`, show an optimistic ticket, done.
17. Online → `_createBookings()` → **`customer_create_booking` RPC**.
    - **Branch — RPC absent** (older database) → falls back to direct inserts. Any *real*
      refusal is surfaced instead.
18. **[AUTO] Reconcile from the returned rows** — this is essential:
    - the server's `queue_num` replaces the guess (`assign_queue_num` always wins);
    - the server's `status` replaces the guess — **`_capacity_guard` may have coerced `waiting`
      into `waitlist`** when two devices raced for the last place;
    - `waitlist_num` and `price` likewise.
    The toast, the add-on stock and the ticket all follow the **server's** answer.
19. **Branch — unique-index collision on `queue_num`**: roll back any rows that did insert,
    re-fetch, take fresh numbers, retry — **up to 4 attempts**.
20. **[AUTO] Post-insert clash sweep**: after a `waiting` booking, reload and check no other live
    row holds the same number; if so, renumber to fresh ones.
21. **[AUTO]** If the account had no height stored, the first rider's height is saved to the profile.
22. **[AUTO]** Add-on stock is consumed (a `waitlist` booking consumes none).
23. **[AUTO]** `booking-confirm` email fires if Brevo is configured.
24. → **Ticket(s)** (step 4).

**Server-side, on every insert — [AUTO], in trigger order**

- `assign_queue_num` stamps the real number;
- `_community_booking_gate` raises *"This ride is for community members only."* unless an active
  `saturday` tag is held;
- `_group_ride_cap` raises *"Up to 2 riders per booking on this ride."* past 2 live rows for that
  account on a paid community session;
- `_comm_no_carbon` rewrites `Road Carbon` → `Road` on community sessions;
- `_approval_guard` forces `approval` to `pending` for non-staff;
- `_enforce_booking_price` sets the canonical price (0 on a free community ride);
- `_capacity_guard` may rewrite `waiting` → `waitlist`;
- `_wl_num_assign` assigns `waitlist_num` if waitlisted;
- `_promo_count` increments the code's `uses`.

---

### A4. Group booking (JCC ≤10, Petromin ≤4)

Same as A3 with:
- quantity > 1, one row per rider, each with their own name / height / type;
- **[AUTO]** all rows share a `group_id` when created together at the desk; a customer-side group
  is keyed by `customer_id + session_id`;
- one queue number **per rider**, consecutive where possible;
- the ticket labels each "Bike i / n";
- the wallet pass shows `#6-#8` (consecutive) or `#6, #7, #9`, and a riders list on the back;
- cancelling cancels **the whole party**.

---

### A5. Waitlist (customer side)

1. A booking lands on the waitlist when the session is `full` or capacity is reached (A3 step 13,
   or the server's coercion at step 18).
2. The ticket shows `waitlistLabel` and, if known, `· W<n>` — **not** a queue number.
3. **[AUTO] Promotion** happens when a place frees up (see B6): the row flips to `waiting`,
   add-on stock is consumed, and a **push notification** is sent.
4. The rider sees the change on their next load / realtime tick.

> **Gap, verified**: promotion runs on staff-cancel and no-show only. A place freed by a
> **removal** or by the **customer's own cancellation** does not promote anyone.

---

### A6. Approval-required community ride (Saturday Social Ride)

1. Book as in A3. **[AUTO]** the booking is created with `approval='pending'` and `price=0`.
2. The ticket shows the **ride title**, no number, no QR, and `commCuePending`.
3. **[AUTO]** While `hide_queue` is set, the rider sees only "under review" — never a verdict.
4. Staff approve or reject (B7).
5. On publish, the rider sees **confirmed** (green) or **waitlist**.
6. The rider can **cancel only** — no edit, no reschedule, no add-ons.
7. **[AUTO]** A customer can never change `approval`: the RPC whitelist excludes it and
   `_approval_guard` reverts any attempt.

---

### A7. Check-in (rider's view)

1. Arrive at the booth and give a **booking number** ("I'm forty-two") or show the QR.
2. Staff scan or search (B4/B5).
3. Payment is taken if outstanding.
4. A bike is handed over; the rider's status becomes `active`.
5. **[AUTO]** `checked_in_at` is stamped; the bike goes `available → in-use`.

---

### A8. Ride, return, rating

1. Staff mark the return (B8): status `done`, `checked_out_at` and `ride_duration` recorded, the
   bike freed.
2. **[AUTO]** On the rider's next visit to any customer tab, a **mandatory** rating modal appears
   for the unrated ride.
3. Two 1–10 scales (service, bike; the Saturday ride asks its own longer form) plus optional free-text
   feedback → `customer_booking_update` writes `rating_detail`, `rating_bike`, `rating_exp` (the service
   score, a Saturday's overall), `feedback`.
4. Past rides offer **Book again**, which prefills the wizard.

---

### A9. Cancellation (customer)

1. My Rides → Cancel → `#cancel-reason-modal` → pick a reason → confirm.
2. `cancelBooking(id, reason)` → `customer_booking_update` with `status='cancelled'` for **every
   row in the party**.
   - The RPC accepts only `cancelled`, `waiting` or `waitlist` as a customer-set status.
3. **[AUTO]** Add-on stock is restocked for rows that were `waiting`.
4. **[AUTO]** `_promo_count` gives the promo use back.
5. **[AUTO]** The place is freed (`_holdsSpot` excludes cancelled) — **but no auto-promotion runs
   on this path**.
6. There is **no time window and no fee** — cancellation is allowed at any point while live.

---

### A10. Reschedule (customer, JCC only)

1. My Rides → Reschedule → pick another open session.
2. The booking moves; **[AUTO]** a fresh queue number is assigned for the new session, and
   `queue_num_update_guard` resolves any collision.
3. Not offered for community bookings.

---

## B. STAFF FLOWS

### B1. Getting in

1. Landing → **Staff Access** (or `/staff`, or `?staff`).
2. **Branch — device already unlocked** (`localStorage.cq_staff==='1'`):
   **[AUTO]** `staffAuthRestore()` checks for a live Supabase Auth session mapping to a `staff` row.
   - session present and staff → straight into the panel;
   - access token lapsed → **[AUTO]** `refreshSession()` first (a phone that has been asleep is
     ordinary, not a sign-out);
   - **only a positive "this account is not staff" verdict** drops the unlock. A network error
     never does — a booth on bad wifi must not lose its session.
3. **Branch — not unlocked** → the PIN gate / credential prompt.
   - Sign in by **email or phone**; a phone resolves via `STAFF_PHONE_MAP` then
     `staff_email_for_phone`, then an ordinary email+password sign-in.
   - Wrong PIN → escalating lockout **1, 2, 5, 10, 15, 30, 45, 60, 120 min** with a countdown.
   - **Branch — the staff-row lookup times out**: the session is trusted rather than freezing
     (the database still enforces `is_staff()` on every write).
   - **Branch — lookup succeeds with no row**: signed out, `errStaffNotAuthorized`.
4. **Branch — `must_change_pwd`** → forced password change → `staff_mark_pwd_changed`.
5. Role from `staff.role` → **admin** (everything) or **frontdesk** (Sales + Bookings only).
6. **[AUTO]** `showOpGate()` asks the operator's name once, for the audit trail.

---

### B2. Creating sessions

1. Bookings → **Sessions** view → Add session.
2. Choose the event: **JCC**, **Saturday**, or **Petromin**.
3. **JCC**: date, repeat **1–12 weeks**, start/end time, then capacity as either
   - per-type/size counts (`Road/Hybrid/Mountain` × `XS/S/M/L`), or
   - an explicit bike assignment (busy bikes excluded).
4. **Saturday**: title (default `evSatName`), **spots 1–500**, gathering + start times,
   meeting-point URL, breakfast spot (from a reusable list).
   **[AUTO]** written with `needs_approval=true`, `hide_queue=true`, `required_tag_id=null`.
5. **Petromin**: title (default `evPetroName`), **bike composition** (capacity = the sum),
   plain start–end times. **[AUTO]** `needs_approval=false`, `hide_queue=false`, `spots=null`,
   and meeting-point/breakfast explicitly **nulled**.
6. Optional waitlist cap: flat count or % of capacity → stored as `_wl` inside `bike_slots`.
7. **[AUTO]** `ride_kind` and `paid_ride` are written in a **second, tolerant update**, so an
   older database missing those columns cannot cost the ride its gate fields.
8. Session opens as `closed`; staff set it `open`.

**Session state changes**: open ⇄ full ⇄ closed; delete is **blocked while bookings exist**;
deleted sessions are restorable.

---

### B3. Live queue management

1. Bookings tab → session summary chips (waiting / on-bike / done + fill bar).
2. Filter by session, status, payment, bike type, size; search; sort; density toggle.
3. **[AUTO]** Realtime pushes every change from other devices, debounced 350 ms; a 30-second poll
   backs it up; **nothing refreshes while the tab is hidden**.
4. Row actions by status — see SCREENS.md §6.1.
5. Bulk: select-all → mark paid, or bulk check-in.
6. **[AUTO]** Every destructive action pushes an **Undo** with a countdown.

---

### B4. QR scanning

1. Tap **Scan** → `#scan-modal` asks for the camera.
2. **[AUTO]** Decoder: `BarcodeDetector` where available, else the vendored `jsQR` on a canvas
   capped at 480 px. Polled every **150 ms**.
3. Payload must match `^MMC-(?:(\d+)-)?([0-9a-zA-Z][0-9a-zA-Z-]{3,7})$` — both the numbered
   circuit form and the **number-free community** form.
4. **[AUTO]** The **id prefix** is what matches; the number is only a consistency check.
5. **Branch — rider is `waiting`** → the quick check-in modal opens.
   **Branch — any other status** → the full booking modal opens instead.
6. **Continuous mode**: after check-in the camera is handed straight back, with a running tally.

---

### B5. Check-in and bike assignment

1. Find the rider — scan, search by booking number, or the Waitlist screen.
2. Quick check-in modal: payment (`pending` / paid·cash / paid·card / split / on the house) and
   bike type. Payment row is hidden entirely on a free ride.
3. **Branch — "Assign specific bike…"** → the bike picker.
   **[AUTO]** the payment choice already made is **carried over** (`_ciCarryPay`) rather than
   discarded.
4. Bike picker: retired and maintenance bikes excluded; the rider's preferred type first
   (a `Road Carbon` booking matches **Road** bikes); default sort = available → matching size →
   in this session's fleet → name. Size is a **preference, not a filter**.
5. Confirm → status `active`.
   - **[AUTO]** The status write is conditional (`.in('status',['waiting','waitlist'])`) so two
     devices cannot both check the same rider in.
   - **[AUTO]** The bike is claimed with a compare-and-swap (`.eq('status','available')`).
     **Branch — another device won**: the claim is released and `errBikeUnavailable` warns.
   - **[AUTO]** A **waitlisted** rider checked in this way leaves the waitlist here, and this is
     where their add-on stock is finally reserved.
   - **[AUTO]** Any linked Waitlist-screen row is retired.
   - **[AUTO]** `checked_in_at` is stamped.

**Reassignment**: an `active` rider can be moved to another bike — the old one is freed, the new
one claimed atomically.

---

### B6. Waitlist management

1. Bookings → **Waitlist** view.
2. The list is a **union**: `desk_waitlist` walk-ups, staff-parked bookings, **and every
   waitlisted booking** not already on it.
3. Ordering: hand-ordered rows first (`sort_order`), then by **W number**, then arrival.
4. Staff can: edit a W position, change bike type, take payment, add a rider to the party, check
   the party in, remove a row (real desk rows only), or hand a walk-up a bike.
5. **[AUTO] Auto-promotion** fires when a place frees up via **staff cancel** or **no-show**:
   1. approval rides are exempt — they never auto-promote;
   2. W1 is chosen by `waitlist_num`, then registration time;
   3. the write is conditional on the row still being `waitlist` (a stale device cannot promote
      twice);
   4. add-on stock is consumed;
   5. a **push notification** goes to the rider — this happens with nobody watching, which is
      exactly why the push exists;
   6. a WhatsApp nudge bar appears for the staffer.

---

### B7. Approving a community ride

1. Bookings → select the Saturday session → status filter Pending.
2. Per row: **Approve** / **Reject** / move to **Waitlist**.
   - **[AUTO]** A missing (`NULL`) approval value counts as **pending**.
3. Approving keeps the original queue number.
4. **[AUTO]** Undo is offered.
5. Publish (clear `hide_queue`) to reveal the verdicts to riders.
6. **[AUTO]** Community stats row shows Riders / Approved / Pending / Waitlist / **Bike owners**,
   with the spots meter counting **rentals only**.

---

### B8. Return and close-out

1. `active` row → **Return bike**.
2. **[AUTO]** `checked_out_at` and `ride_duration` (minutes) recorded; bike → `available`.
3. **Branch — unpaid** → `#return-pay-modal` prompts for payment.
4. Add POS sales against the booking at any point.
5. **Day close-out**: totals with a card/cash split, computed as
   `card_amount ?? (pay_method === 'card' ? price : 0)`.
6. Print a session report (bilingual, reference `MM-RPT-YYMMDD`).
7. Set the session `closed`.

---

### B9. Walk-in at the desk

1. Bookings → **+ Walk-in**.
   - **Branch — no session loaded yet** → toasts `noSessionsAvail` and **the modal never opens**.
2. Enter name (a datalist offers saved customers), phone, height, bike type, session; add more
   riders inline.
3. **[AUTO]** A saved customer's "on the house" default applies when the name matches.
4. Confirm → a `queue_entries` row with `walk_in=true` and no `customer_id`.
5. **Group walk-in** (`#jcc-group-modal`): group name, contact, phone, and per-rider rows —
   **[AUTO]** all share one `group_id`.

---

### B10. Adding a rider to a community ride

1. Community session → **Add rider** (`#comm-add-modal`).
2. Search any customer; a chip shows whether they hold an **active** community tag.
3. Choose the destination: **final list** (pre-approved) or **waitlist**.
4. Optional **"rider brings their own bike (does not use a spot)"**.
5. **[AUTO]** Staff-added riders on a community event are pre-approved and, on a free ride, ride
   free. Staff may exceed the spot count freely — the gate and the cap both exempt `is_staff()`.

---

### B11. Tag / membership management

1. Community → Accounts & tags → pick a customer → Edit tags.
2. Add a tag → the **grant dialog**:
   - **Permanent**, or
   - **Temporary** with either a duration preset (1d / 3d / 1w / 2w / 1m / 3m / 6m / 1y) or
     explicit start and end dates, with a **"Today"** checkbox under the start (pre-checked, locks
     start to today).
   - **The end date is inclusive.** Stored as ms-epoch `starts_at` / `expires_at`.
3. Removing a tag is one click.
4. **[AUTO]** Chips show validity ("until 12 Aug 2026" / "from 10 Aug 2026" / dimmed "expired");
   member counts show **active holders only**.
5. Tag CRUD (name / colour / description); **system tags are locked**.

---

### B12. Deleting a customer account (Admin only)

1. Community → customer → **Delete account**.
2. **Branch — the rider has a live booking** → refused with a toast, **nothing is written**.
3. Confirm → in order:
   1. `queue_entries.customer_id` **unlinked first** (a real FK — Postgres would otherwise refuse
      and leave a half-deleted account);
   2. `customer_tags`, `customer_notes`, `push_subscriptions` deleted;
   3. the `customers` row deleted.
4. **The booking rows are never deleted** — the riding record and name stay, so rosters,
   close-outs and analytics are unchanged.
5. **[AUTO]** A full Undo recreates the account and re-links the bookings.

---

### B13. POS sale

1. Sales tab → add inventory items and/or custom lines to the cart, set quantities.
2. Optional discount (% or SAR) → **[AUTO]** written as a **negative `__discount__` line**.
3. Payment: cash / card / **split** (→ **[AUTO]** a qty-0 `__cardmeta__` line records the card
   portion) / MM Team / on the house.
4. Optionally link the sale to a booking or customer.
5. Confirm → receipt (shareable, editable).
6. **[AUTO]** Stock decrements.
7. **Refund** → `pay='refunded'` and **[AUTO]** stock restocks. The original line is kept.
8. **Branch — offline** → the sale queues in `cq_sales_outbox` and flushes on reconnect.
9. **[AUTO]** A deleted sale's id is remembered in `cq_sales_voided` — an RLS-blocked DELETE
   returns no error, and without this the void would silently reappear.

---

## C. SYSTEM / AUTOMATIC BEHAVIOURS

A checklist of everything that happens without a user action.

| # | Behaviour | Trigger |
|---|---|---|
| 1 | Queue number assigned (client's guess overwritten) | every insert |
| 2 | `waiting` → `waitlist` when capacity is reached | capacity guard, insert/update |
| 3 | `waitlist_num` assigned | when a row becomes waitlisted |
| 4 | Price forced to the canonical / zero | price trigger |
| 5 | `Road Carbon` → `Road` on community sessions | insert trigger |
| 6 | `approval` forced to `pending` for non-staff | approval guard |
| 7 | Community gate rejection | insert/update on a community session |
| 8 | 4-rider cap rejection | insert/update on a paid community session |
| 9 | Promo `uses` ±1 | insert, and status crossing into/out of cancelled/removed |
| 10 | Auto-granted tags on a new account | `customers` insert |
| 11 | **Waitlist auto-promotion** + push | staff cancel, no-show |
| 12 | Add-on stock consume/restock | every status transition |
| 13 | Bike freed | return, cancel, no-show, remove |
| 14 | Orphan bikes reset to `available` | boot |
| 15 | Realtime refresh (debounced 350 ms) | 7 tables |
| 16 | 30-second poll | while the tab is visible |
| 17 | Outbox flush | `online` event, every 15 s while non-empty, after every load |
| 18 | Full 365-day queue window | shortly after boot |
| 19 | Snapshot cache written | after every successful full load |
| 20 | Staff keep-alive | every 10 minutes |
| 21 | Connection UI refresh | every 5 seconds |
| 22 | Language pack fetched and re-render | on language switch |
| 23 | Service worker revalidates the shell | every navigation (applies on the **next** load) |
| 24 | Forced rating prompt | unrated past ride, on any customer tab |
| 25 | "You're next" cue | rider is next in the queue |
| 26 | Loading screen force-hide | 5 s after boot starts |
