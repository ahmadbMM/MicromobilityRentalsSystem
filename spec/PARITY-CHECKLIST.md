# PARITY-CHECKLIST.md — MicroMobility Rentals

A flat checklist of every discrete behaviour the new version must reproduce, phrased as
testable statements.

**Sources**: the 87-file Playwright suite (`tests/*.spec.ts`, **~400 unique tests, run across
2 projects = 802 assertions per full run**), plus behaviour read directly from the code that no
test currently pins.

**How to read it**: items marked **[T]** are already encoded as an automated test in the current
system — the test name is given, so the new implementation can port it. Items marked **[R]** were
derived by reading the code and are *not* currently covered by a test. Items marked **[⚠]** are
known defects or inconsistencies in the current system: reproducing them is a deliberate choice.

---

## 1. Identity and authentication

- [ ] **[T]** A dropped request during password reset or login is retried once before giving up — `release-and-stock.spec.ts` *(added 2026-08-26)*.
- [ ] **[T]** A genuine refusal (bad password, locked account) is **not** retried — it is the answer.
- [ ] **[T]** Signup is deliberately **not** retried, so a landed insert is never repeated as a duplicate.

- [ ] **[R]** A customer signs up with first name, last name, email, phone, password, height, gender.
- [ ] **[R]** A password must be at least 8 characters with at least one uppercase letter and one digit.
- [ ] **[R]** Signing up with an email or phone that already exists is refused with a duplicate error.
- [ ] **[R]** A customer can sign in with **either** their email or their phone number.
- [ ] **[T]** A phone number is normalised to one canonical form before use — `norm-phone.spec.ts`.
- [ ] **[R]** Arabic-Indic digits, `00966`, `+966`, `0…` and bare forms all normalise to the same phone.
- [ ] **[R]** After 8 consecutive failed logins the identifier is locked for 15 minutes.
- [ ] **[R]** A successful login clears the failure counter.
- [ ] **[R]** A successful login **reuses** the existing session token, so other signed-in devices stay valid.
- [ ] **[R]** A legacy `sha256:` password hash is transparently upgraded to bcrypt on next login.
- [ ] **[R]** Password reset requires **both** the email and the phone to match, and refuses OAuth-only accounts.
- [ ] **[T]** The auth page renders and behaves correctly, including forgot-password — `auth-page.spec.ts`.
- [ ] **[T]** A password reset sends a normalised phone (leading zero stripped) and logs the user in — `auth-page.spec.ts`.
- [ ] **[R]** "Remember me" defaults **ON**; off stores the session in `sessionStorage` instead.
- [ ] **[R]** If storage throws (blocked cookies), the session falls back to memory and **never** surfaces as a connection error.
- [ ] **[R]** A stored session with no `session_token` is discarded and the customer must sign in again.
- [ ] **[R]** Google sign-in inside an in-app browser shows a specific explanation rather than failing silently.
- [ ] **[T]** Staff can sign in by phone number, resolved to their account email — `staff-phone.spec.ts`.
- [ ] **[T]** First-time staff are forced to change their password before using the panel — `staff-pwd.spec.ts`.
- [ ] **[R]** An unlocked staff device is only re-locked on a positive "not staff" verdict — never on a network error.
- [ ] **[R]** An expired staff access token is refreshed rather than treated as a sign-out.
- [ ] **[T]** Front desk sees only the Sales and Bookings tabs — `frontdesk.spec.ts`.
- [ ] **[R]** Staff role is UX scoping only — the database grants both roles identical rights.

## 2. Sessions and visibility

- [ ] **[R]** A session is visible to a signed-out visitor only when `required_tag_id` is null.
- [ ] **[R]** `list_sessions` returns ungated sessions plus those whose required tag the caller **actively** holds.
- [ ] **[R]** An invalid or absent token returns ungated sessions only, never an error.
- [ ] **[R]** Community sessions are created with `required_tag_id = null` — visible to all, bookable by members.
- [ ] **[R]** Only sessions with status `open` or `full` are offered for booking.
- [ ] **[R]** The session list shows only the sessions of the event chosen on the landing page.
- [ ] **[R]** Choosing "MicroMobility Experiences" lists **every** non-JCC session, both community ride kinds.
- [ ] **[T]** Session promo settings persist correctly — `sessions-promo.spec.ts`.
- [ ] **[R]** A session cannot be deleted while it has bookings; a deleted session is restorable.
- [ ] **[R]** A JCC session can repeat for 1–12 weeks.
- [ ] **[R]** Session times are stored as `"HH:MM - HH:MM"` inside `bike_slots._time`.
- [ ] **[R]** On an approval ride the same field means "gathering - start" and renders as two labelled times.

## 3. Membership gating

- [ ] **[T]** A non-member cannot book a community ride — `members-gate.spec.ts`.
- [ ] **[T]** The members-only dialog appears with the WhatsApp and Instagram routes — `members-gate.spec.ts`.
- [ ] **[R]** The gate is applied at the event card, the session card, and again at submit.
- [ ] **[R]** The database trigger raises exactly `This ride is for community members only.`
- [ ] **[R]** Staff are exempt from the members gate.
- [ ] **[T]** A tag is active only within its start/expiry window — `temp-tags.spec.ts`.
- [ ] **[R]** `starts_at` is inclusive, `expires_at` is **exclusive**; null means unbounded.
- [ ] **[R]** Tag windows are milliseconds since epoch, and the client and server must agree.
- [ ] **[R]** Member counts show active holders only.
- [ ] **[R]** No customer-facing API ever reveals the tag system; `community_member` returns a bare boolean.
- [ ] **[R]** Every new account automatically receives all `auto_grant` tags.

## 4. Booking

- [ ] **[T]** A waiver step sits between the riders and the review, and cannot be walked past — `waiver.spec.ts` *(added 2026-08-26)*.
- [ ] **[T]** Going back from review lands on the waiver rather than skipping it — `waiver.spec.ts`.
- [ ] **[T]** The agreement does not survive into the next booking — `waiver.spec.ts`.
- [ ] **[T]** Every rider on a party booking carries the waiver version, not just the first — `waiver.spec.ts`.
- [ ] **[T]** The client sends a version (which wording), never a timestamp — `waiver.spec.ts`.
- [ ] **[R]** `waiver_at` is stamped server-side from `now()`; a caller-chosen time is not evidence.
- [ ] **[R]** The copy names who is covered: "on behalf of every rider on this booking".
- [ ] **[⚠]** A walk-in booked at the desk carries no waiver — coverage is customer-side only.

- [ ] **[T]** A booking is created through the `customer_create_booking` RPC — `booking-rpc.spec.ts`.
- [ ] **[T]** A booking carrying a promo code inserts correctly — `booking-promo-insert.spec.ts`.
- [ ] **[T]** The three-step wizard renders and advances correctly — `reg-flow-ui.spec.ts`.
- [ ] **[R]** The wizard shows a 1-2-3 stepper with passed steps ticked.
- [ ] **[R]** Continue is disabled until a session is selected.
- [ ] **[R]** Quantity is 1–10 on JCC, 1–4 on the Petromin ride, and locked to 1 on the Saturday ride.
- [ ] **[R]** Rider 1's name defaults to the account holder.
- [ ] **[R]** Height maps to size: ≤166 XS, 167–172 S, 173–178 M, ≥179 L.
- [ ] **[R]** A customer with an existing live booking on that session sees an "already booked" banner offering **Modify existing**, and is not double-booked.
- [ ] **[R]** The duplicate check re-fetches the queue first, so a second tab cannot slip through.
- [ ] **[R]** The duplicate match is by account id, falling back to phone for accountless bookings.
- [ ] **[R]** The server's returned `queue_num`, `status`, `waitlist_num` and `price` **override** the client's guesses.
- [ ] **[T]** A queue-number collision is retried with fresh numbers — `renumber.spec.ts`.
- [ ] **[R]** A collision rolls back partially inserted rows before retrying, up to 4 attempts.
- [ ] **[R]** The first rider's height is saved to the profile if it was missing.
- [ ] **[T]** A group booking creates one row per rider sharing a group id — `group-id-grouping.spec.ts`.
- [ ] **[T]** A JCC group booking works from the desk — `jcc-group.spec.ts`.
- [ ] **[T]** A group booking counts as one visit per customer, not one per rider — `analytics-growth.spec.ts`.
- [ ] **[T]** Cancelling a group cancels every rider in it — `cancel-group.spec.ts`.
- [ ] **[T]** A whole group booking can be edited in one place — `group-edit.spec.ts`.
- [ ] **[R]** `customer_create_booking` rejects a batch that is empty, longer than 10, or spans two sessions.

## 5. Pricing and money

- [ ] **[T]** Money is calculated and displayed correctly throughout — `money.spec.ts`.
- [ ] **[T]** Prices round correctly — `round10.spec.ts`, `round11-chaos.spec.ts`.
- [ ] **[R]** Road 75, Hybrid 57.5, Mountain 57.5, Any 57.5, Road Carbon 250, Own 0 — and `ride_prices` must match the client.
- [ ] **[R]** `Any` displays as a range (SAR 57.5 – 75).
- [ ] **[R]** A client-sent price is **ignored** — the trigger writes the canonical price.
- [ ] **[R]** A promo can only reduce a price, never increase it.
- [ ] **[R]** A free community ride is priced 0 unconditionally.
- [ ] **[R]** Price is always clamped to 0…1000.
- [ ] **[R]** Once a bike is assigned or the row is paid, the price trigger stops interfering.
- [ ] **[R]** `Road Carbon` is never repriced from the assigned bike (250 must not become 75).
- [ ] **[T]** Staff can override a booking's price — `edit-price.spec.ts`.
- [ ] **[T]** A type-restricted "on the house" default applies only to the listed bike types — `walkin-group.spec.ts`.
- [ ] **[T]** The house/team payment markers behave correctly — `house-team.spec.ts`.
- [ ] **[R]** The house perk applies only to the first entry and only when the name matches the account holder.
- [ ] **[T]** A POS discount is recorded as a negative `__discount__` line — `pos-discount.spec.ts`.
- [ ] **[R]** A card/cash split writes a qty-0 `__cardmeta__` line.
- [ ] **[T]** A refund restocks the item — `refund-restock.spec.ts`.
- [ ] **[R]** Aggregations exclude `__cardmeta__` and qty-0 lines and reverse `refunded` ones.
- [ ] **[T]** Close-out totals are correct, including the card/cash split — `closeout.spec.ts`, `report-totals.spec.ts`.
- [ ] **[R]** Analytics offers a VAT inclusive/exclusive toggle; exclusive is value ÷ 1.15.

## 6. Promo codes

- [ ] **[T]** Promo usage limits are enforced — `promo-limits.spec.ts`.
- [ ] **[T]** Promo state stays in sync across devices — `promo-sync.spec.ts`.
- [ ] **[R]** A code matches case-insensitively.
- [ ] **[R]** A code is invalid when inactive, expired (Asia/Riyadh date), used up, or bound to another customer.
- [ ] **[R]** The customer is told **which** condition failed.
- [ ] **[R]** `uses` increments on booking, decrements on cancel/remove, and re-increments on restore.
- [ ] **[R]** Promo entry is offered on JCC bookings only.

## 7. Capacity, places and the waitlist

- [ ] **[T]** A place is held from booking right through the ride — `capacity-holds.spec.ts`.
- [ ] **[T]** Checking a rider in does **not** free a place — `capacity-holds.spec.ts`.
- [ ] **[T]** Finishing a ride does **not** free a place — `capacity-holds.spec.ts`.
- [ ] **[T]** A cancellation frees a place — `capacity-holds.spec.ts`.
- [ ] **[T]** A no-show frees a place — `capacity-holds.spec.ts`.
- [ ] **[T]** An own-bike rider never consumes a place — `own-bike-spots.spec.ts`.
- [ ] **[R]** Any number of own-bike riders can be seated on top of a full allocation.
- [ ] **[R]** The client and the database count places identically (`cancelled`/`removed`/`noshow` excluded, `Own` excluded).
- [ ] **[R]** Approval rides use `spots`; every other session uses `capacity`; the default is 12.
- [ ] **[R]** The capacity guard exempts approval rides entirely.
- [ ] **[R]** Two simultaneous bookings for the last place cannot both succeed (advisory lock).
- [ ] **[T]** The "expected" count is correct and excludes stale rows from past sessions — `expected-count.spec.ts`.
- [ ] **[T]** Waitlisted bookings are visible where they should be — `waitlist-visible.spec.ts`.
- [ ] **[T]** An auto-waitlisted booking appears on the Waitlist page — `waitlist-shows-bookings.spec.ts`.
- [ ] **[T]** A booking staff also parked by hand is listed once, not twice — `waitlist-shows-bookings.spec.ts`.
- [ ] **[T]** Folded-in waitlist rows carry the booking's controls, not the desk-row ones — `waitlist-shows-bookings.spec.ts`.
- [ ] **[T]** Reordering real waitlist rows never writes to a folded-in one — `waitlist-shows-bookings.spec.ts`.
- [ ] **[T]** Waitlist rows sort by W number, the order promotion takes them in — `waitlist-shows-bookings.spec.ts`.
- [ ] **[T]** A walk-up and a hand-picked rider share one list — `desk-waitlist.spec.ts`.
- [ ] **[T]** A device pointing at the removed waitlist view lands on the list, not a blank tab — `desk-waitlist.spec.ts`.
- [ ] **[T]** A waitlisted booking's W position is editable, because promotion follows it — `desk-waitlist.spec.ts`.
- [ ] **[T]** Handing a walk-up a bike books a real queue entry and clears them off the list — `desk-waitlist.spec.ts`.
- [ ] **[R]** A waitlist size cap can be set as a flat count or a percentage of capacity (minimum 1); absent or 0 means unlimited.
- [ ] **[R]** Joining is refused when the waitlist cap is reached.
- [ ] **[R]** Auto-promotion picks W1 by `waitlist_num` then registration time.
- [ ] **[R]** Auto-promotion is a conditional write, so a stale device cannot promote the same row twice.
- [ ] **[R]** Auto-promotion consumes the promoted booking's add-on stock.
- [ ] **[R]** Auto-promotion sends a push notification.
- [ ] **[R]** Approval rides **never** auto-promote.
- [ ] **[T]** A place freed by a **removal** promotes the next waitlisted rider — `release-and-stock.spec.ts` *(fixed 2026-08-26)*.
- [ ] **[⚠]** A place freed by the **customer's own cancellation** still promotes nobody — blocked by RLS, needs a server-side fix (BUSINESS-RULES.md §4.7).

## 8. Queue numbers

- [ ] **[T]** Queue numbers are assigned by the server and never reused — `renumber.spec.ts`.
- [ ] **[R]** The client's `queue_num` is always overwritten on insert.
- [ ] **[R]** `(session_id, queue_num)` is unique except for cancelled, removed and no-show rows.
- [ ] **[R]** Numbers never shift down — gaps are correct and expected.
- [ ] **[R]** An undone booking gets its old number back if still free, else a fresh one.
- [ ] **[R]** A queue-number update that would collide takes a fresh number instead of failing.
- [ ] **[T]** A community booking never exposes a queue number — `comm-no-number.spec.ts`.
- [ ] **[R]** A community QR payload is `MMC-<id6>`; a circuit one is `MMC-<num>-<id6>`.
- [ ] **[T]** Staff can edit a queue number where allowed — covered via `staff.spec.ts`.

## 9. Check-in, bikes and the ride

- [ ] **[T]** Two devices cannot check the same rider in twice — `checkin-race.spec.ts`.
- [ ] **[T]** The quick check-in modal works from the queue and the waitlist — `checkin-quick.spec.ts`, `quick-checkin.spec.ts`.
- [ ] **[T]** A reserved bike is claimed atomically on check-in — `reserve-bike.spec.ts`.
- [ ] **[R]** A bike claim is a compare-and-swap on `status='available'`; a lost race releases what was claimed and warns.
- [ ] **[R]** Retired and maintenance bikes never appear in the picker.
- [ ] **[R]** A `Road Carbon` booking is matched against **Road** bikes.
- [ ] **[R]** Bike size is a sort preference, not a hard filter.
- [ ] **[R]** Check-in accepts both `waiting` and `waitlist` rows.
- [ ] **[R]** Checking in a waitlisted rider is where their add-on stock is finally reserved.
- [ ] **[R]** A payment chosen in the quick modal is carried over into the bike picker, not discarded.
- [ ] **[R]** `checked_in_at` / `checked_out_at` / `ride_duration` are recorded.
- [ ] **[T]** A bulk check-in stamps `checked_in_at` only on rows whose status write landed — `release-and-stock.spec.ts` *(fixed 2026-08-26)*.
- [ ] **[T]** Bike editing works, including colours and identifiers — `bike-edit.spec.ts`.
- [ ] **[R]** Bikes move `available → in-use` on check-in and back on return, cancel, no-show or removal.
- [ ] **[R]** Orphan bikes (in-use with no live booking) are reset to available at boot.
- [ ] **[R]** One booking row can hold several bikes via a JSON array in `assigned_bike_id`.

## 10. Add-on stock

- [ ] **[T]** A confirmed booking holds its add-on stock — `addon-stock-invariant.spec.ts`.
- [ ] **[T]** Checking a waitlisted rider in reserves it — `addon-stock-invariant.spec.ts`.
- [ ] **[T]** A rider who never left the waitlist releases nothing when cancelled — `addon-stock-invariant.spec.ts`.
- [ ] **[T]** A confirmed rider marked no-show gives the unit back — `addon-stock-invariant.spec.ts`.
- [ ] **[T]** A rider cancelled after checking in gives back exactly one — `addon-stock-invariant.spec.ts`.
- [ ] **[T]** No-show handling and add-ons stay consistent — `noshow-addons.spec.ts`.
- [ ] **[R]** Stock may go negative (oversell/backorder) on the staff path — clamping would mint phantom stock on refund.
- [ ] **[T]** Staff stock writes are a delta under a compare-and-swap, so two tills cannot overwrite each other — `release-and-stock.spec.ts` *(fixed 2026-08-26)*.
- [ ] **[⚠]** The customer stock RPC still clamps at zero, contradicting the deliberate-negative rule — one-line migration, not applied.

## 11. Approval workflow

- [ ] **[T]** Unique approved riders are counted once however many times they were approved — `analytics-approved.spec.ts`.
- [ ] **[T]** Pending, rejected and cancelled riders are not approved riders — `analytics-approved.spec.ts`.
- [ ] **[T]** A walk-in with no account still counts as one person — `analytics-approved.spec.ts`.
- [ ] **[T]** JCC bookings never reach the approval card — `analytics-approved.spec.ts`.
- [ ] **[R]** A NULL `approval` on a community booking reads as **pending**.
- [ ] **[R]** A customer can never set or change `approval` — the whitelist excludes it and the guard reverts it.
- [ ] **[R]** Approving keeps the original queue number.
- [ ] **[R]** While `hide_queue` is set, riders see only "under review".

## 11b. The Thursday swim session (bike-free community)

- [ ] **[T]** A swim session is `event_kind='community'`, `ride_kind='swim'` and reports `_needsBike` false — `swim-session.spec.ts` *(added 2026-08-26)*.
- [ ] **[T]** It keeps the Saturday shape: members-only, staff-approved, solo, free, hidden queue.
- [ ] **[T]** Choosing it skips the riders step entirely — no height, no size, no bike type.
- [ ] **[T]** Back from the waiver returns to the session list, not to an empty step.
- [ ] **[T]** The booking carries `type_preference='None'` (a sentinel, not `'Any'`) and an empty size.
- [ ] **[T]** The swimmer agrees to a **swim** waiver — title, body and the "on behalf of everyone" line all name the activity — stamped `swim-2026-08-v1`.
- [ ] **[T]** Staff checking a swimmer in are offered no bike picker.
- [ ] **[T]** It carries its own identity colour (`ev-swim` teal), not the circuit blue.
- [ ] **[R]** Thursday is just the session's date; no code enforces a weekday.
- [ ] **[R]** Adding another bike-free activity costs one entry in `BIKELESS_KINDS`.

## 11c. T100 Triathlon Prep, formerly the MicroMobility Triathlon Workshop (open community, bike-free)

- [ ] **[T]** `event_kind='community'`, `ride_kind='workshop'`, `open_to_all=true`; approval, hidden queue, solo, free, no bike — `workshop-session.spec.ts` *(added 2026-09-07)*.
- [ ] **[T]** The signed-in landing shows a THIRD card for it, beside the circuit and the Experiences umbrella, with the federation mark and "In partnership with Saudi Triathlon Federation" in a smaller line.
- [ ] **[T]** It lists under its own card only: never under Experiences, and no other ride lists under it.
- [ ] **[T]** No tag needed: a customer the members RPC says no to still reaches the waiver; the Saturday card still shows them the members dialog.
- [ ] **[T]** One place per person: the booking carries exactly one rider whatever the stepper held, and a second reservation on the same session is refused (client banner; `_solo_ride_cap` in the DB, staff exempt).
- [ ] **[T]** No waiver: the wizard is two steps (day, confirm), Back from the review returns to the day list, and the booking carries no `waiver_version`. Nothing about cycling appears on the review or the ticket: no bike type, no height, "Participants" not "Riders".
- [ ] **[T]** The booking carries `type_preference='None'`, an empty size and price 0.
- [ ] **[T]** Staff creating one get a session name, a spot cap, a meeting point — no breakfast, no gathering — and the row is stamped `-tw`, `open_to_all` load-bearing.
- [ ] **[R]** It carries its own identity colour (`ev-workshop` burnt orange).

## 11d. The account report builder (Community → Accounts)

- [ ] **[T]** The Accounts panel has an "Account report" button that opens the same builder shape as the Bookings page: column picks, sections, filters, PDF / CSV, Reset — `account-report.spec.ts` *(added 2026-09-07)*.
- [ ] **[T]** Columns cover everything an account carries: profile (name, email, phone, gender, age, birth date, country, city, height, bike type, joined), tags (names, since, until), riding history aggregated from the queue (bookings, rides completed, community rides, upcoming, no-shows, cancelled, last ride, minutes, spent), default payment, hidden types.
- [ ] **[T]** Filters: tag (all / any / none / a specific tag — the Community tag among them), gender, age band, country, city, bike type, joined window, rides, last active, upcoming booking, default payment; plus a sort.
- [ ] **[T]** Opening the builder from a tag pill on the list seeds the tag filter with that pill.
- [ ] **[R]** Choices persist per device under `cq_acc_rep_opts`, separately from the session report's.
- [ ] **[T]** Summaries: nine breakdowns of the listed accounts (tags, gender, age bands, city, country, bike preference, sign-ups by month, rides per account, last active), each switchable and drawn as columns / bars / donut / line / table-only. The PDF renders them as inline SVG with a value table beside each; the CSV appends them as blocks.

## 12. The Petromin (paid group community) ride

- [ ] **[T]** The paid community ride behaves as specified — `petromin-ride.spec.ts`.
- [ ] **[R]** It is a community ride (members gate applies) that **charges JCC prices**.
- [ ] **[R]** It has **no approval step**: real queue numbers, seats overflowing to the waitlist, auto-promotion.
- [ ] **[R]** It is capped at **2 riders per account per session** (the member and one guest), enforced client-side and by trigger.
- [ ] **[R]** Booking twice cannot get around the 4-rider cap.
- [ ] **[R]** It offers the **Own bike** option, free, and hides **Road Carbon**.
- [ ] **[R]** It uses bike composition, not a seat count; `spots` is explicitly null.
- [ ] **[R]** It has no meeting-point or breakfast fields.
- [ ] **[R]** Its session times are plain start–end, not gathering/start.
- [ ] **[R]** It is themed red; the Saturday ride green; JCC blue.

## 13. Cancellation, no-show, removal

- [ ] **[R]** A customer may set only `cancelled`, `waiting` or `waitlist` on their own booking.
- [ ] **[R]** A customer cancel cancels the whole party.
- [ ] **[R]** There is **no** time-based cancellation window and no fee.
- [ ] **[R]** Staff cancel of a `waiting`/`active` row requires a confirm; a `waitlist` row cancels immediately; anything else refuses.
- [ ] **[R]** A no-show frees its place but keeps its queue number reserved.
- [ ] **[R]** "Customer showed" reverses a no-show and re-reserves add-on stock.
- [ ] **[R]** A cancelled booking is restorable, with an over-capacity confirm (skipped for own-bike community rows).
- [ ] **[R]** A removed booking is restored to `done` if there is ride evidence, else `waiting`.
- [ ] **[T]** Every destructive staff action offers an Undo — `log-undo.spec.ts`, `undo-double.spec.ts`.
- [ ] **[T]** An Undo cannot be applied twice — `undo-double.spec.ts`.
- [ ] **[T]** A rescheduled booking respects the gate rules — `reschedule-gate.spec.ts`.

## 14. Account deletion

- [ ] **[T]** Deleting an account unlinks the bookings first so the foreign key holds — `delete-account.spec.ts`.
- [ ] **[T]** Deletion is refused while the rider has a live booking, writing nothing — `delete-account.spec.ts`.
- [ ] **[T]** Tags, notes and push subscriptions go with the account — `delete-account.spec.ts`.
- [ ] **[T]** The booking rows themselves are never deleted — `delete-account.spec.ts`.
- [ ] **[T]** An undo restores the account and re-links the bookings — `delete-account.spec.ts`.
- [ ] **[T]** Front desk never sees the delete button — `delete-account.spec.ts`.

## 15. Search and rosters

- [ ] **[T]** A booking number finds a rider from its first digit — `search-groups.spec.ts`.
- [ ] **[T]** Finding one rider by number brings their whole party — `search-groups.spec.ts`.
- [ ] **[T]** A party tied by the account, not a group id, widens too — `search-groups.spec.ts`.
- [ ] **[T]** A name match widens to the party as well — `search-groups.spec.ts`.
- [ ] **[T]** A solo rider stays solo — `search-groups.spec.ts`.
- [ ] **[T]** A raw booking id still matches when it happens to be all digits — `search-groups.spec.ts`.
- [ ] **[T]** The waitlist picker offers a party as one line, found by number — `search-groups.spec.ts`.
- [ ] **[R]** A `W` prefix aims at the waitlist position instead of the booking number.
- [ ] **[R]** Party widening happens inside the already-filtered set, so status/pay/size filters still mean what they say.
- [ ] **[T]** A chosen session lists every rider, past 159 and past 189 — `queue-full-roster.spec.ts`.
- [ ] **[T]** Cancelled bookings stay out of the roster — `queue-full-roster.spec.ts`.
- [ ] **[T]** No "Show more" is left dangling once a session lists in full — `queue-full-roster.spec.ts`.
- [ ] **[T]** The all-sessions view keeps its cap and names how many are held back — `queue-full-roster.spec.ts`.
- [ ] **[T]** Status filter labels are correct per ride type — `status-filter-labels.spec.ts`.
- [ ] **[T]** The staff list supports session filtering and multi-rider parties — `staff-list.spec.ts`.
- [ ] **[T]** A walk-up row belongs to no session and never hides behind the session filter — `staff-list.spec.ts`.

## 16. Offline and resilience

- [ ] **[T]** The app boots when the network is unavailable — `boot-resilience.spec.ts`, `offline.spec.ts`.
- [ ] **[T]** Bookings made offline flush on reconnect — `outbox-flush.spec.ts`.
- [ ] **[T]** The outbox flushes through the RPC, not a raw insert — `outbox-rpc.spec.ts`.
- [ ] **[R]** A duplicate-key error on flush is treated as already-landed, not as a failure.
- [ ] **[R]** Outbox rows carry stable client-generated ids so a replay cannot double-book.
- [ ] **[T]** Sales made offline are queued and flushed — `sales-back.spec.ts`.
- [ ] **[R]** A deleted sale can never resurrect, because an RLS-blocked DELETE returns no error.
- [ ] **[T]** Storage quota exhaustion is handled without breaking the app — `storage-quota.spec.ts`.
- [ ] **[R]** The cold-start snapshot strips photos and is never written from a PII-free load on a staff device.
- [ ] **[R]** Offline detection uses both `navigator.onLine` and an observed write failure.
- [ ] **[T]** Failed writes are surfaced, never silently swallowed — `write-failures.spec.ts`.
- [ ] **[T]** A date move that cannot create the new session leaves the old one alone — `write-failures.spec.ts`.
- [ ] **[T]** Photos are cached separately and survive app updates — `cache-photos.spec.ts`.

## 17. Realtime and performance

- [ ] **[R]** Seven tables are subscribed on one channel, debounced 350 ms.
- [ ] **[R]** Nothing refreshes while the tab is hidden; `visibilitychange` catches up.
- [ ] **[R]** Reconnect uses capped exponential backoff and ignores callbacks from a removed channel.
- [ ] **[R]** A 30-second poll backs realtime up.
- [ ] **[T]** The queue renders performantly with many rows — `queue-perf.spec.ts`, `perf-smooth.spec.ts`.
- [ ] **[R]** Reads that grow unbounded are paged (PostgREST caps at 1000 rows).
- [ ] **[R]** The queue loads a 60-day window at boot and widens to 365 days shortly after.
- [ ] **[R]** Customers are fetched only on staff devices.

## 18. Security and privacy

- [ ] **[T]** The security model holds — `secure.spec.ts`.
- [ ] **[R]** The anon key can never read `customers` or named bookings.
- [ ] **[R]** Public availability comes from the no-PII `queue_public` view only.
- [ ] **[R]** Staff views read the denormalised name/phone/email on each booking row.
- [ ] **[R]** Known rider details are preserved if a later refresh comes back PII-free.
- [ ] **[T]** CSV exports are hardened against formula injection — `csv-injection.spec.ts`.
- [ ] **[T]** Printed reports escape user content — `report-xss.spec.ts`.
- [ ] **[T]** User content is escaped everywhere it is rendered — `esc-guard.spec.ts`.
- [ ] **[R]** Internal files (`.sql`, `.md`, source, tests, scripts, functions, dotfiles) are 404ed by middleware, matched on the fully decoded path.
- [ ] **[R]** The wallet, push and email endpoints all re-verify ownership through a token-checked RPC and never trust client-supplied data.
- [ ] **[R]** The push endpoint verifies the caller is staff before sending anything.

## 19. Internationalisation

- [ ] **[T]** Language packs load and apply correctly — `lang-packs.spec.ts`.
- [ ] **[R]** English is inline; Arabic is fetched as a versioned JSON pack.
- [ ] **[R]** A language switch never blocks first paint — it draws in English and redraws when the pack lands.
- [ ] **[R]** `?lang=` selects the language and is kept in sync without adding history entries.
- [ ] **[R]** EN/AR key parity is a build-breaking gate (currently 1,734 keys). *(Spanish was dropped 2026-08-26.)*
- [ ] **[R]** Arabic sets `dir="rtl"`, swaps to IBM Plex Sans Arabic, and drops italics, uppercase and letter-spacing.
- [ ] **[R]** Arabic dates use the Gregorian calendar with Latin digits, not Hijri and not Arabic-Indic numerals.
- [ ] **[R]** Arabic times use `ص`/`م` rather than AM/PM.
- [ ] **[R]** Names, emails and phone numbers stay LTR inside RTL text.

## 20. Accessibility and UI polish

- [ ] **[T]** Every audited view reports zero axe-core violations, in English and Arabic — `a11y.spec.ts` (**a hard gate**).
- [ ] **[T]** All staff tabs render without console errors — `staff-tabs-render.spec.ts`, `smoke-console.spec.ts`.
- [ ] **[T]** Every modal opens and closes cleanly — `modal-smoke.spec.ts`.
- [ ] **[T]** Deep navigation works without errors — `deep-smoke.spec.ts`.
- [ ] **[T]** Back navigation behaves correctly through wizard steps and views — `customer-back.spec.ts`.
- [ ] **[T]** UI polish details hold — `uiux-polish.spec.ts`.
- [ ] **[R]** A confirmation dialog always renders above the modal that raised it.
- [ ] **[R]** Every interactive element has a visible focus ring.
- [ ] **[R]** Touch targets are at least 44 px; inputs are 16 px so iOS does not zoom.
- [ ] **[R]** `prefers-reduced-motion` is honoured.
- [ ] **[T]** SEO metadata and the static no-JS intro are present — `seo.spec.ts`.
- [ ] **[T]** The landing page renders correctly — `landing.spec.ts`.

## 21. Staff tools

- [ ] **[T]** The staff panel works end to end — `staff.spec.ts`.
- [ ] **[T]** Inventory subcategories behave — `subcategories.spec.ts`.
- [ ] **[T]** The nutrition library renders — `nutrition-library.spec.ts`.
- [ ] **[T]** The team roster is shared and editable — `team-roster.spec.ts`.
- [ ] **[T]** Ticket extras (calendar, directions, wallet) render — `ticket-extras.spec.ts`.
- [ ] **[T]** A customer can be created from a queue entry — `customer-from-queue.spec.ts`.
- [ ] **[T]** Analytics views compute correctly — `analytics-growth.spec.ts`, `analytics-rides.spec.ts`, `analytics-height.spec.ts`.
- [ ] **[T]** Push subscription and delivery work — `push.spec.ts`.
- [ ] **[T]** Forced post-ride rating appears — `forced-rating.spec.ts`.
- [ ] **[R]** The operator's name is asked once per device and attached to the audit trail.
- [ ] **[R]** The inventory tab badge counts items at or below their low threshold.

## 22. Deliberate quirks worth preserving (or consciously fixing)

- [ ] **[⚠]** Queue-number gaps are permanent — `_shiftDownAfter` is an intentional no-op.
- [ ] **[⚠]** Inventory categories, brands, flavours and bike taxonomies live in **localStorage only** and do not sync between devices.
- [ ] **[⚠]** The `queue_entries` INSERT policy is still open to anon, pending the offline-client rollover.
- [ ] **[⚠]** `queue_entries.price` still has a stale column default of `30` while the app's default is `57.5`.
- [ ] **[⚠]** `customer_shiftdown` still renumbers server-side although the client's own shift is disabled.
- [ ] **[R]** A deploy takes effect on the **second** load, because navigations are stale-while-revalidate.
