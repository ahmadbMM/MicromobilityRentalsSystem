# SCREENS.md — MicroMobility Rentals

Every screen and modal in the customer app and the staff panel: purpose, how it is reached,
every element on it, and what each control does.

**Copy**: the exact user-facing strings for every screen are in **§13, the copy appendix**,
generated from the `LANG` object — 1,734 keys × 2 languages (EN / AR), full parity
enforced by CI. Inline below, strings are referenced by key (e.g. `regStep1Title`) and quoted in
English; look the key up in §13 for the Arabic.

**Architecture**: one single-page app. There is no routing library — a `showView()` call swaps
which of `#view-landing`, `#view-customer`, `#view-staff` is visible, and `body` carries
`view-landing` / `view-picker` / `view-customer` / `view-staff` which the CSS keys off. Every
modal is a **pre-declared empty `<div>`** at the end of `<body>` ([app.src.html:304](../app.src.html#L304)–[332](../app.src.html#L332))
that its render function fills with `innerHTML` and shows with `style.display='flex'`.

---

## 0. Persistent chrome (present on every screen)

### 0.1 Top bar — `#topbar`

| Element | Behaviour |
|---|---|
| Logo button (`.topbar-logo`, `#topbar-logo-img`) | `goLanding()`. `aria-label="MicroMobility home"`. Image swaps `logo.png` ⇄ `logo-dark.png` by theme |
| Language dropdown `#lang-btn` | A native `<select class="lang-toggle">` inside `.lang-wrap` listing all nine languages by their own name (English, العربية, Français, Español, Português, اردو, हिन्दी, Tagalog, नेपाली); `onchange` → `setLang(code)`. Shows the language being read. Boot order: `?lang` → the language this device picked by hand (`cq_lang` + `cq_lang_pick`) → the device language (`navigator.languages`, `pt-BR`→pt, `fil`→tl) → English. Arabic and Urdu flip `dir=rtl` |
| `#topbar-right` | Rendered by `renderTopbarRight()` — signed-out: a **Sign in** affordance; signed-in customer: name + email (`.cust-topbar-name`, `.cust-topbar-email`, forced LTR); staff: operator name, role segmented control, staff theme toggle, **Lock** |

### 0.2 Customer navigation

- **Desktop**: `#customer-tab-nav` — three `.tab-btn`s: `tabReserve`, `tabMyRides`, `tabAccount`.
- **Mobile**: `#cust-bottom-nav`, a fixed bottom bar with three icon buttons (bicycle, calendar,
  person) and labels `#bnav-reserve-lbl` / `-myrides-lbl` / `-account-lbl`.
- **Back**: `#cust-back-btn` (`custBack()`) — visible on all customer tabs, label
  `‹ regBackBtn`. The chevron carries `.mirror-rtl` so it flips in Arabic. It walks the wizard
  back a step, else returns to the event picker.

### 0.3 Staff navigation — `#staff-tab-nav`

A left rail, grouped by `.snav-group` headers: **Rides** (`snavRides`) · **Commerce**
(`snavCommerce`) · **People** (`snavPeople`) · **Insights** (`snavInsights`) · **System**
(`snavSystem`), over seven tabs:

| Tab | `data-stab` | Copy key | Front-desk sees it? |
|---|---|---|---|
| Bookings | `queue` | `tabQueue` | ✅ |
| Sales | `cashier` | `tabCashier` | ✅ |
| Inventory | `inventory` | `tabInventory` | ❌ |
| Community | `community` | `tabCommunity` | ❌ |
| Analytics | `analytics` | `tabAnalytics` | ❌ |
| History | `history` | `tabHistory` | ❌ |
| Notes | `notes` | `tabNotes` | ❌ |

`#rail-pin` toggles pinned vs hover-expand (`aria-pressed`, `localStorage.cq_rail`).
The **Inventory** tab carries a `.tab-badge` with the count of items at or below their low
threshold, `title`/`aria-label` = `invLowAlert` ("{0} low stock").

### 0.4 Footer — `#app-footer`

Four `.footer-social-link` icons: **Instagram** (`instagram.com/MicroMobilitySA`), **WhatsApp**
(`wa.me/966566668818`), **Email** (`info@micromobility.sa`), **Phone** (`tel:+966566668818`).
Each has a `title` and an `aria-label` ending "(opens in a new tab)".
`#footer-copy` = `footerCopy` → "© 2026 MicroMobility. All Rights Reserved".

### 0.5 Global overlays

| Element | Purpose |
|---|---|
| `#loading-screen` | The brand loading state (`.mm-loading`): `#1A1919` ground, neon `#03FF89` mark in a rotating ring. Textless; `aria-label` ("Loading" / "جارٍ التحميل" / "Cargando" …) is set **before the app script parses**. Min 250 ms on screen, 180 ms fade. Auto-hides after **5 s** even if boot stalls. `window.mmLoading.show()/.hide()` drives every other full-screen wait |
| `#toast-container` | `role="status" aria-live="polite"`. `toast(msg, kind)` — kinds: default (green edge), `error` (red), `warning` (grey) |
| Undo bar (`#undo-bar-btn`) | `showUndoBar()` — appears after every destructive staff action with a countdown; copy `undoBtn`, `undoneMsg`, `undoFailed` |
| `#confirm-modal` | Generic confirm dialog (`confirmDialog({title, body, confirmLabel, confirmClass, onConfirm})`). **`z-index:300`** so it outranks whatever raised it |
| `#booth-popup` | Kiosk/booth announcement — title, message, an extra info panel, and a × close |
| Error bar | `errorBar(msg, retry, detail)` — a persistent bar for write failures, unlike a toast |

---

## 1. Landing / event picker — `#view-landing`

**Purpose**: the front door, and the signed-in event chooser.
**Reached**: app entry; the logo; `goLanding()`; browser Back from a customer tab.

### 1.1 Hero

| Element | Content |
|---|---|
| `.landing-ghost` | Huge outlined watermark "MICROMOBILITY", `aria-hidden` |
| `#land-eyebrow` | `landEyebrow` — "Rides & Events" |
| `#land-main-title` | "Reserve Your **Bicycle Now!**" — hard-coded per language: AR "احجز **دراجتك الآن!**", ES "¡Reserva tu **bicicleta ahora!**" |
| `#land-sub` | `landingSub` |
| `#land-auth-cta` | Sign-in / sign-up call to action (signed-out only) |
| `.landing-hero-card` | `hero.webp`, `landHeroClick()`, `aria-label="Jeddah Corniche Circuit"`, with a circular arrow `#land-cta-arrow` (`→`, flipped to `←` in Arabic) |
| `.sector-stripes` | Three decorative angled bars, `aria-hidden` |

### 1.2 Event cards — `#land-events`

**Exactly two cards, always both shown**, whatever the session list holds:

1. **Open Sports Day** — `landJccCardTitle` / `landJccTitle`, meta `landJccMeta`
   ("Sun & Tue · 9-11pm"), JCC logo (`jcc.png`, `jcc-white.png` on dark).
2. **Micromobility Experiences** — `landCommTitle`. **Logo only, no description** (this was changed
   deliberately). Umbrella over *every* non-JCC ride.

Clicking sets `S.selEvent` and enters the Reserve wizard. The community card runs the **members
gate** first (§1.4).

### 1.3 Availability strip — `#land-avail-strip`

`renderLandingAvail()` ([app.src.html:3807](../app.src.html#L3807)). One `.landing-avail-row`
per upcoming open session: a status dot, `.landing-avail-date`, `.landing-avail-time`, and
`.landing-avail-spots`.

- **Empty state**: `noSessions`.
- **All full**: `sessAllFull`.
- **A full session**: `statusFull`; otherwise `availLabel`.
- **`landChooseEvent`** prompts the choice.

> **Community sessions never show a computed spot count here** — only the staff-set full flag.

### 1.4 Members-only dialog — `showCommMembersModal()`

**Reached**: a non-member taps a community ride (event card, session card, or submit).

| Element | Key |
|---|---|
| Title | `commMembersTitle` — "Community members only" |
| Body | `commMembersMsg` |
| WhatsApp button | `wa.me/966534423513` — **+966 53 442 3513** (note: a *different* number from the footer's) |
| Instagram button | `commMembersIg` → `instagram.com/MicroMobilitySA` |
| Dismiss | `commMembersOk` ("Got it"), `closeBtn` |

Links carry `opensNewTab` for screen readers.

### 1.5 Staff access — `.landing-footer`

`#land-staff-btn` (`staffAccessClick()`), label `staffAccess`. Deliberately subtle. Also
reachable at `/staff` or `?staff`.

---

## 2. Authentication — `#auth-modal`

`renderAuthModal()` ([app.src.html:2889](../app.src.html#L2889)) — **42 copy keys**, five modes
in one modal, switched by `S.authMode` / `S.forgotStep`.

### 2.1 Sign in (`authMode='login'`)

`.auth-tabs` with `authLogin` / `authSignup`; `.auth-logo`; title `authWelcome`; sub `authSub`.

| Field | Key | Notes |
|---|---|---|
| Identifier | `authIdentifier` | **email or phone**; placeholder `enterEmailOrPhone` |
| Password | `authPassword` | |
| Remember me | `rememberMe` | **defaults ON** — session-only storage evaporates on iOS, logging customers out on every app switch |
| Submit | `authLoginBtn` | |
| Forgot | `forgotPwLink` | |
| OAuth | `continueGoogle`, `continueApple`, separator `authOr` | |

### 2.2 Sign up (`authMode='signup'`)

`firstName` + `lastName` (placeholders `phFirstName`, `phLastName`), `authEmail`, `authPhone`
with a **country-code picker** (`.auth-cc-row`, default `+966`, ~200 countries), `authPassword` +
`authConfirmPassword` with `authPasswordHint`, `heightLabel` (`heightPlaceholder`), `genderLabel`
(`genderMale` / `genderFemale`), submit `authSignupBtn`.

### 2.3 Forgot password (two steps)

- Step 1 — `forgotStep1Title`, `forgotStep1Sub`: email (`enterEmail`) **and** phone
  (`enterPhone`), verified together via `customer_reset`. Button `forgotVerifyBtn`.
- Step 2 — `forgotStep2Title`, confirmation `forgotVerifiedMsg`, new password, `resetBtn`.
- `backToLogin` returns.

### 2.4 Google completion (`openGoogleComplete`)

Shown when a Google account has no profile yet: `gCompleteTitle`, `gCompleteSub`, then phone,
height, gender; `finishBtn`.

### 2.5 Error states

`authErr()` renders into `.auth-err`. Notable: **`iabGoogleBlocked`** — Google sign-in is
blocked inside in-app browsers (Instagram, Facebook), which the app detects and explains.
`errNoInternet` vs `errConnection` are distinguished ([app.src.html:3188](../app.src.html#L3188)).

### 2.6 Staff sign-in — `#pin-modal`

`renderPinModal()` ([app.src.html:5132](../app.src.html#L5132)) — the numeric PIN pad
(`.pin-numpad`, `.pin-key`, `.pin-dots`) plus the Supabase Auth email/password path.
`openStaffPwdModal()` forces a password change when `must_change_pwd` is set.
Lockout escalates **1, 2, 5, 10, 15, 30, 45, 60, 120 minutes** and shows a live countdown
(`_fmtLock()` → "45s", "2m 10s", "1h 30m").

---

## 3. Reserve — `#tab-register`

`renderRegister()` ([app.src.html:5289](../app.src.html#L5289)) — **436 lines, 69 copy keys**.
A **three-step wizard** with a `.reg-stepper` (`regProg1` Session · `regProg2` Riders ·
`regProg3` Confirm; `role="group"`, `aria-label="<n> / 3"`), passed steps ticked. A fourth
implicit state shows tickets.

### 3.1 Step 1 — Session

Header `regStep1Title` / `regStep1Msg`.

**Session list** — only sessions matching the chosen event (`_evMatch`), status `open` or
`full`, sorted by date. Each `.sess-card` carries `_evClass(s)` (blue/green/red) and shows:

- a `.sess-card-dot` (filled when selected),
- `.sess-card-date` — `dayLabel(day) · shortDate(date)`,
- `.sess-comm-chip` with `_evName(s)` (community only),
- `.sess-card-time` — `sessionTime(s)`; an **approval ride shows "gathering · start"**, everything
  else a plain range,
- `.sess-card-spots` — `waitlistLabel` when the session is `full`, else `availLabel`, coloured
  `spots-red` / `spots-low` (≤3 left) / `spots-green`.

> **An approval ride never shows the low-spots hint** — customers only ever see "waitlist" once
> staff explicitly mark the session full.

**Empty state**: `noSessionsAvail` + `noSessionsSocial` + an Instagram button (`@MicroMobilitySA`).

**Full-session notice**: `commFullWaitlistMsg`.

**"Book my usual"** — `bookUsualBtn`, shown only to a returning customer when an open session
exists. One tap re-books with remembered height/type/time-of-day. **Never picks a community
session.**

**Footer**: `regContinueBtn`, disabled (opacity .4, `cursor:not-allowed`) until a session is chosen.

### 3.2 Step 2 — Riders

Header `regStep2Title` / `regStep2Msg`.

| Control | Behaviour |
|---|---|
| Quantity stepper | `numBikes`, `.qty-stepper` with `qtyDecLabel` / `qtyIncLabel`. Range **1–10** (JCC), **1–4** on the Petromin ride (hint `groupCapHint` = "Up to {0} riders"), **locked to 1** on the Saturday ride |
| Per rider: name | `riderName` / `riderNamePlaceholder`. Rider 1 defaults to the account holder |
| Per rider: height | `heightLabel` + `heightHint`, `heightPlaceholder`, min 100 max 250 cm → **auto-size** XS/S/M/L |
| Per rider: bike type | `bikeTypePref` — `bikeTypeOpts()`: JCC gets Any/Road/Hybrid/Mountain/Road Carbon; community gets Any/Road/Hybrid/Mountain/**Own** |
| Add-ons | `addonsLabel` — inventory items with photos and quantity steppers, stock-capped; sold-out becomes a backorder up to 10 |
| Promo code | `.reg-promo` + `applyPromoCode()`. **JCC only.** Messages: `promoInvalidMsg`, `promoExpiredMsg`, `promoUsedUpMsg`, `promoNotYoursMsg` |
| Price preview | Per bike: `pricePerBike`, or per-rider `priceDisplay(ty)`; **`onTheHouseLabel`** when the house perk applies; `freeLabel` on a free ride |
| Account block | Name / email / phone read-only, with `needToUpdate` → link to `tabAccount` |
| Footer | `regBackBtn` · `regReviewBtn` |

**Modify mode**: if the customer already has a `waiting`/`waitlist` booking on the selected
session, the wizard switches to editing it — a green banner (`modifyBookingBtn`,
`queueNumLabel`, per-bike chips, `modifyBanner`) and the confirm button becomes
`modifyBookingBtn`. **Community approval rides are never editable this way** — a Saturday
booking is managed only from My Rides, cancel-only.

### 3.3 Step 3 — Review & confirm

Header `regStep3Title` / `regStep3Msg`. `.reg-summary-panel` with `reviewSessionLabel`,
`bookedByLabel`, `reviewRidersLabel (n)`, a per-rider row (name, `typeBadge`, height in
`cmUnit`, price), add-ons, and `.reg-summary-total` = `reviewTotalLabel`.

Footer: `regBackBtn` · `regConfirmBtn` (or `modifyBookingBtn`). While submitting the button is
disabled and shows an ellipsis.

**Already-booked banner** (`#already-booked-banner`): `errAlreadyBooked` + `errAlreadyBookedSub`
and a `modifyExistingBtn` button; scrolled into view on trigger.

### 3.4 Step 4 — Ticket(s)

`renderBookingTicket()` ([app.src.html:6268](../app.src.html#L6268)) — **31 copy keys**. One
`.ticket-card` per rider; multi-rider bookings label each "Bike i / n".

| Ride | Ticket shows |
|---|---|
| **Circuit** | `.ticket-num` — the big **queue number**, label `queueNumLabel`; QR of `MMC-<num>-<id6>` |
| **Circuit, waitlisted** | `.ticket-num-label.wl-loud` — `waitlistLabel` + `· W<n>` |
| **Community** | The **ride title** instead of a number (`landCommTitle` fallback), plus an orange cue: `commCuePending` or `commCueWaitlist`. **No number, no QR** |

Detail columns: `colSession`, `timeLabel`, `nameLabel`.

Actions:
- `ticketAddCal` → `downloadBookingICS()`;
- `ticketDirections` → the circuit pin, **or** `meetPointLbl` → the ride's meeting point on a
  community ticket;
- `addToWallet` (`.btn-wallet`) — **circuit bookings only**, and only when `_hasWallet()`;
- `ticketNotice` — the pay-at-the-booth note.

---

## 4. My Rides — `#tab-myrides`

`renderMyRides()` ([app.src.html:6813](../app.src.html#L6813)).

Bookings are grouped by customer+session, soonest first, split into upcoming and past.

**Circuit card**: queue number(s) large, status badge, live cue (`youreNextMsg` / position),
per-rider rows (#num, name, type, assigned bike once known, price, paid/pending), add-ons with
an edit affordance, and actions **Edit** (jumps to wizard step 2), **Reschedule**, **Cancel**.
QR with the numbered reference.

**Community card**: the ride **title** instead of numbers, an approval cue —
pending (orange) / confirmed (green) / waitlist — meeting point and breakfast links, and
**Cancel only** (no edit, no reschedule, no add-ons). QR uses the **number-free** ref.

**Past rides**: `bookAgainBtn` (prefills the wizard) and ratings.

**Empty state**: `.rides-empty` / `.rides-zero`.

### 4.1 Rating modal — `#rate-modal`

`renderRateModal()` ([app.src.html:6618](../app.src.html#L6618)). Two 1–10 scales — bike and
experience — plus free-text feedback. A pending post-ride rating is **prompted on any customer
tab** and is mandatory (`tests/forced-rating.spec.ts`).

### 4.2 Cancel — `#cancel-reason-modal`

`showCancelReasonModal()` ([app.src.html:10427](../app.src.html#L10427)) — reason picker before
confirming. Cancels the **whole party**.

### 4.3 Reschedule — `#reschedule-modal`

`showRescheduleModal()` ([app.src.html:10480](../app.src.html#L10480)) — move to another open
session, renumbering safely. Not offered for community bookings.

---

## 5. My Account — `#tab-account`

`renderAccount()` ([app.src.html:6863](../app.src.html#L6863)) — **37 copy keys**.

Profile: first / middle / last name, email, phone with country picker, height, gender, birth
date, country, city, favourite bike type, **profile photo** (Supabase Storage upload with a
data-URL fallback), and a **profile-completeness percentage**. Plus change password, and log out.

Height and bike type **prefill the booking wizard every time**.

---

## 6. Staff — Bookings (`#tab-queue`)

The densest screen. `renderStaffQueue()` ([app.src.html:9448](../app.src.html#L9448)) dispatches
to **three views** via `S.queueView`, chosen by `.filter-pill`s:

| View | Value | Renderer |
|---|---|---|
| Sessions | `sessions` | `renderSessions()` |
| Bookings | `bookings` | the roster (table on desktop, `.q-card`s on mobile) |
| **Waitlist** | `managed` | `renderManagedWl()` |

> A device still pointing at the removed `'waitlist'` view is **redirected to `managed`**, not
> left on a blank tab.

### 6.1 Bookings view

**Session summary chips** — one `.sess-summary-chip` per open session with waiting / on-bike /
done counts and a fill bar.

**Stat strip** (2026-09-13) — the six stat cards became one line of `.stat-chip`s (riders,
expected, waitlist when any, on bike, completed, SAR due), the clickable ones still applying
their filter. On phones the strip scrolls sideways; the four narrowing filters (status, pay,
bike type, size) fold behind a **Filters (n)** button (`sfFiltersBtn`, `S.sfFiltersOpen`), the
Scan button is icon-only, Walk-in floats bottom-right (`.walkin-fab`, hidden while any dialog
is open via `body.has-modal`), and the density and reset tools are hidden. The desktop table
lost its Position, Height and Colour columns: position shows under the booking number while
waiting, height beside the rider's name, colour swatches beside the bike. Each row carries one
green action (Check In, or Return Bike when out), a real checkbox for bulk selection, and the
⋯ menu with everything else (No-Show, Change bike, Booking number…, Party details…, Edit,
Customer, Cancel). The check-in modal leads with the Bike field; the bike-type row shows only
until a bike is in, and the type follows the bike (a premium tier keeps its fare). Community chips carry the ride colour (customer side) or plain
green/ink (staff layer).

**Filter bar**:

| Control | Options |
|---|---|
| Session | `allSessions` + every session |
| Status | `filterStatus`: all / Expected / On Bike / Completed / No-show / Cancelled; on a community session: Approved / Pending / Waitlist / Rejected |
| Payment | `filterPay`: all / paid / pending |
| Bike | `bikeTypeLabel`: All / **Bike owner** / **Rental bike** / Road / Mountain / Hybrid |
| Size | `filterSize`: all / XS / S / M / L |
| Search | `#sf-search-input`, placeholder **`searchPlaceholder`** = "Number, name or phone" |
| Scan | `scanBtn` → `openScanModal()` |
| Density | `.density-btn` — compact / comfortable |
| Result count | `#q-result-count` — "N `resultOf` M `resultRiders`", shown only when filtered |

Search behaviour is specified in BUSINESS-RULES.md §19 — number from the first digit, `W`
prefix for waitlist position, and **party widening**.

**Rows** — `renderQRow()` ([app.src.html:9639](../app.src.html#L9639)), **480 lines, 78 copy
keys**. Per row: queue number, name, contact (call + WhatsApp circles), type badge, size,
payment cell (`.pay-toggle`), status badge, and an actions cell that varies by status:

| Status | Actions |
|---|---|
| `waiting` | **Check in** (opens the quick modal), No-show, Edit booking, Note, Cancel |
| `waitlist` | same, plus an editable **W** position box |
| `active` | Change bike, **Return bike**, add POS sale, Undo check-in, Cancel |
| `done` | Reopen, Remove |
| `noshow` | "Customer showed", Remove |
| `cancelled` | Restore (with an over-capacity confirm), Remove |
| community `pending` | **Approve** / **Reject** / move to Waitlist |
| community `approved` | chip + Undo approval |

**Party rows** (two or more riders booked together) add two one-tap buttons for the whole
party: **Check in (N)** (`groupCheckin` → `_checkinMany`; N counts the members still
expected, never a community request awaiting Approve) and **Mark paid** (`groupMarkPaid`).
Payment and check-in stay separate taps — marking a party paid does not check it in.

**Check-in modal, Bike field** (`#ci-bike`, `inputmode="numeric"`): one input, four ways in — a
bike number on the keypad, the NFC tab (`micromobility.sa/bikes/42`, which sends a staff phone on to
`staff.micromobility.sa/?bike=42`), a QR sticker through the in-app scanner (same URL; `/b/42` and
`/?bike=042` too), or a tag UID typed by a Bluetooth HID reader. Resolved through `staff_resolve_bike`
(or the loaded fleet where the RPC is absent) into the spec line `042 · Road · Carbon · M · Black ·
Shimano 105` plus status; a bike that is out (`ciBikeRented`, naming the rider) or in maintenance
disables Confirm. An unknown UID typed right after a bike number offers **Link this tag to bike
042** (`staff_link_tag`). Confirm with a bike calls `staff_checkin`; a refusal stays in the modal
(`#ci-error`). Opening the modal publishes `mm_active_checkin` (localStorage, 15 min) so the tab
iOS opens for a tag finds it; tabs sync over the `mm-staff` BroadcastChannel. See
BUSINESS-RULES.md §12.1 and OPERATIONS-TODO §8.

**Check-in modal, party steps and outcomes**: a rider booked with others gets a numbered step
row (`ciPartyLabel`, one button per member: ✓ already in, ✕ out, a number for pending, the
current one highlighted) and "Rider n of N" in the title; a pending step is tappable. Confirm,
**No-Show** (one tap, undoable) and **Cancel booking** (its usual confirm) each deal with the
rider and move the modal to the next member still expected, or close it. The footer's dismiss
is **Close**. The one-tap bike suggestion is gone; the bike comes from the Bike field.

**Return modal** (`#return-modal`, `renderReturnModal`): every return passes through it —
condition as a three-way toggle (OK / needs a check / damaged, the last with the
`retDamagedHint` line) and a notes textarea — then `staff_return(p_booking_id,
p_return_condition, p_notes)`; where the RPC is absent the classic writes run, honouring a
damaged condition. Bike-free sessions skip it. The bike card offers **Return bike · #n name**
while the bike is out.

**Bulk bar**: select-all checkbox, mark paid, bulk check-in.
**Keyboard**: `N` checks in the next waiting rider.
**Roster limit**: 150 rows with "Show N more" **only on All Sessions**; a chosen session lists
in full (BUSINESS-RULES.md §20).

### 6.2 Waitlist view — `renderManagedWl()`

Title `wlTitle`, sub `mwSub`.

| Control | Purpose |
|---|---|
| `#mw-sess` | Session filter (`allSessions` + sessions) |
| `#mw-name` | Search — placeholder `mwSearchPh` "Booking number, name or phone…" |
| `#mw-phone` | Phone for a new walk-up |
| `#mw-browse` | `mwBrowseBtn` / `mwHideBtn` — browse all addable bookings (`aria-expanded`) |
| `+ mwAddBtn` | Add the typed person to the list |
| `wlAddBtn` | Open the multi-rider walk-up modal |
| `#mw-suggest` | Picker: `mwFromBookings` / `mwFromCustomers` headers, `.mw-sug` rows showing `#num` or `W<n>`, name (with `+N` for a party), and meta; empty → `mwNoMatches` |

**Rows** are one `.q-card` per party. Each carries a position box, the rider's name, an orange
`#num · W<n>` chip, an editable **W** box, `_mwTypeCell` (bike type), the pay cell, contact
buttons, `beAddRiderBtn` (+ add rider), the booking's own actions, and `wlRemoveBtn`.
Party cards add a header with the group name, a `.mw-party-chip` ("N riders"), `bulkPaidBtn`
and `bulkCheckinBtn`.

**The list is a union** of `desk_waitlist` rows and *every waitlisted booking* not already on it
(DATA-MODEL.md §1.4). Folded-in rows **hide** the position box, the list Remove and dragging,
because they have no `desk_waitlist` row to write to.

Empty states: `wlEmpty`, or `mwEmptyForSess` when a session filter hides everything.

### 6.3 Sessions view — `renderSessions()`

**486 lines, 80 copy keys.** A two-pane browser (list + detail with riders).

Create / edit / clone / open / close / mark-full / delete (**blocked while booked**; deleted are
restorable). Fields differ by event:

- **JCC**: date, repeat 1–12 weeks, time range, capacity by per-type/size counts (`.type-count-box`)
  or explicit bike assignment.
- **Saturday**: title, **spots (1–500)**, gathering + start times, meeting-point URL, breakfast
  spot picker, `needs_approval` and `hide_queue` true.
- **Petromin**: title, **bike composition** (like JCC), plain start–end times, **no meeting point
  or breakfast fields**, `needs_approval` false, `paid_ride` true.

Waitlist cap control (`wlCapLabel`, `wlCapCount` / `wlCapPct`) writes `_wl` into `bike_slots`.

### 6.4 Booking modals

| Modal | Function | Purpose |
|---|---|---|
| `#checkin-modal` | `renderCheckinModal()` | **Quick check-in** — payment row (`pendingLabel`, paid·cash, paid·card, `splitWord`…, `onTheHouseLabel`), bike type row, a link to the full bike picker, `confirmCheckin`. The payment row is hidden on a free ride |
| `#bike-modal` | `renderModal()` (273 lines, 50 keys) | **Bike picker** — search, size/brand/model filters, sort, preferred-type group then others, availability, add-a-bike inline |
| `#walkin-modal` | `showWalkinModal()` | Walk-in booking with no account: name (datalist of customers), phone, height, type, session, multi-rider rows. **Bails with a toast if no session is loaded** |
| `#jcc-group-modal` | `showJccGroupModal()` | Group booking at the desk: group name, contact, phone, per-rider rows |
| `#comm-add-modal` | `renderCommAddModal()` | Add a rider to a community ride — customer search with a members chip, destination (final list / waitlist), **"rider brings their own bike"** checkbox |
| `#group-edit-modal` | `showGroupEditModal()` | Edit a whole party: group name/contact/phone, move the party to another session, per-member fields |
| `#booking-edit-modal` | `showBookingEditModal()` | Edit one booking |
| `#booking-note-modal` | `showBookingNoteModal()` | Staff note against a booking |
| `#edit-price-modal` | `showEditPriceModal()` | Override the price |
| `#qnum-edit-modal` | `showEditQNumModal()` | Change a queue number |
| `#return-pay-modal` | `showReturnPayModal()` | Payment prompt on bike return |
| `#scan-modal` | `openScanModal()` | QR scanner — `scanTitle`, `scanHint`, live video, `#scan-msg`, **continuous mode** (`scanContBtn`) and a tally (`scanTally`) |
| `#op-gate-modal` | `showOpGate()` | Asks the operator's name for the audit trail |

---

## 7. Staff — Sales / POS (`#tab-cashier`)

`renderCashier()` ([app.src.html:15098](../app.src.html#L15098)) — **57 copy keys** — plus
`renderCashierModal()` (20 keys), `showReceipt()` (16), `renderReceiptEdit()` (10),
`renderTeamManager()` (7).

Cart of inventory items plus custom lines; quantities; **discounts** (% or SAR → a negative
`__discount__` line); payment **cash / card / split** (split writes a `__cardmeta__` meta line);
**MM Team** (`pay='team'` with an editable roster); **on the house**. Multi-item branded
receipts, shareable; edit receipt; **refunds** (`pay='refunded'`, restocks); mark-paid; link a
sale to a booking or customer. Offline outbox plus the voided-ids guard.

---

## 8. Staff — Inventory (`#tab-inventory`)

`renderInventory()` ([app.src.html:15362](../app.src.html#L15362)) — **65 copy keys** — and
`renderBikes()` ([app.src.html:12945](../app.src.html#L12945)) — **71 copy keys** — share the
tab via `S.invSection`.

- **Inventory**: equipment and supplements, brands / categories / flavours / subcategories,
  photos, cost and price, **low-stock badges**, reorder suggestions, a nutrition panel
  (`showNutrition()`), grid ⇄ table view.
- **Bikes**: fleet CRUD — name, size, type, brand, model, groupset, speeds, colours (a colour
  builder with named slots), location, frame type, bike number, in-service / retired dates,
  photo, status. Filters by type / status / size, search, sort, show-retired toggle.
  `openBikeProfile()` (23 keys) shows one bike's history.

---

## 9. Staff — Community (`#tab-community`)

`renderCommunity()` ([app.src.html:15951](../app.src.html#L15951)) — **39 copy keys**.

- **Leaderboard**: rider ranking with scope (owner / all), window, branch, metric; a KPI strip;
  a #1 spotlight with tier progress; milestone watch; a shareable image; upcoming rides.
- **Accounts & tags**: customer list with search and tag filter; per-customer tag chips showing
  validity ("until 12 Aug 2026" / "from 10 Aug 2026" / dimmed "expired"); tag editor.
  - **`renderTagGrantModal()`** — grant a tag as **Permanent**, or **Temporary** with either a
    duration preset (1d / 3d / 1w / 2w / 1m / 3m / 6m / 1y) or explicit start and end dates, with
    a **"Today"** checkbox under the start date (pre-checked, locks start to today). **End date
    is inclusive.**
  - Tag CRUD (name / colour / description), system tags locked, member counts show **active**
    holders only.
- **Customer admin**: `renderCustFormModal()` (34 keys) — create an account, edit the full
  profile, set a password, and **Delete account** (Admin only — see BUSINESS-RULES.md §18);
  `openCustomerProfile()` (10 keys); per-customer notes.

---

## 10. Staff — Analytics (`#tab-analytics`)

`renderAnalytics()` ([app.src.html:16356](../app.src.html#L16356)) — **1,131 lines, 254 copy
keys**, the largest single screen. Sub-views via `S.anView` (`.an-subnav`): overview, growth,
and more.

Revenue with a **VAT inclusive/exclusive toggle**, ratings, retention, top sellers (excluding
meta and refunded lines), demand fill-rates, growth (funnel, demand heatmap, retail attach,
run-rate forecast, RFM, market basket, LTV by cohort, gross margin, Pearson correlation,
sparklines), height distribution, weather correlation, a date-range bar and CSV export.

**Unique-approved-riders card**: counts *distinct people* approved for the Saturday ride — a
rider approved on six Saturdays is one customer. Only appears when a social ride exists.

---

## 11. Staff — History (`#tab-history`) and Notes (`#tab-notes`)

- `renderHistory()` ([app.src.html:13873](../app.src.html#L13873)) — **66 copy keys**. All past
  bookings with status / payment / session / range / type / size filters, search, sort, a 60-row
  page size, bulk selection, CSV-safe export (injection-hardened) and bilingual print reports
  (`showPrintReportOptions()`, 22 keys). Includes the **audit log** view (`renderLogs()`, 14 keys)
  over `staff_actions`.
- `renderNotes()` ([app.src.html:4154](../app.src.html#L4154)) — **14 copy keys**. Staff notes:
  search (`noteSearchPh`), customer (`noteCustomerPh`), phone (`notePhonePh`), note type, text
  (`noteTextPh`), add and delete; a booking chip links a note to a booking. Empty: `notesEmpty`.

---

## 12. Edge-case screens

Screens a rebuild will miss because they only appear in unusual states:

| Situation | What appears |
|---|---|
| **Session full** | Session card shows `waitlistLabel` instead of `availLabel`; `commFullWaitlistMsg` notice; the ticket shows `waitlistLabel · W<n>` |
| **Waitlist full** (cap reached) | `waitlistRoom()` hits 0 — the join path is refused (client-side only) |
| **Session closed while booking** | `customer_create_booking` returns no rows → "booking refused" |
| **Already booked** | The already-booked banner with `modifyExistingBtn` |
| **Unpaid at check-in** | Payment row defaults to `pendingLabel`; a rider can still be checked in — payment is a separate concern |
| **Walk-in** | `#walkin-modal`; if no session is loaded it toasts `noSessionsAvail` and never opens |
| **No sessions at all** | `noSessionsAvail` + `noSessionsSocial` + the Instagram button |
| **Non-member on a community ride** | The members-only dialog (§1.4) |
| **Community results not yet published** (`hide_queue`) | "Under review" only — never a verdict or a number |
| **Offline** | Connection UI (`_updateConnUI`), `syncOfflineToast`, optimistic tickets, outbox badges |
| **Write failure** | `errorBar()` with a retry, distinguishing an expired staff session from a dropped connection |
| **Stale data** | `toastConnStale` |
| **Staff session expired** | The PIN gate returns **only** on a positive "not staff" verdict — never on a network blip |
| **Low stock** | `.tab-badge` on Inventory, `invLowAlert` |
| **Bike taken by another device** | `errBikeUnavailable` warning; the claim is released |
| **Force-rating** | A mandatory rating modal on any customer tab after an unrated ride |
| **Factory reset** | `showFactoryReset()` (17 keys) — a destructive admin tool |

---

## 13. Copy appendix — every user-facing string, EN / AR / ES

Generated from the `LANG` object in [app.src.html:352](../app.src.html#L352) (English) and the
extracted pack [lang/ar.json](../lang/ar.json).

**1,734 keys, full parity across both languages** (enforced by
[scripts/check-i18n.mjs](../scripts/check-i18n.mjs)).

`{0}`, `{1}` … are runtime placeholders substituted with `.replace('{0}', value)`.


**1734 keys.** Grouped by key prefix for navigation.


### `add*` — 14 keys

| key | English | العربية |
|---|---|---|
| `addBike` | + Add Bike | + إضافة دراجة |
| `addBikeBtn` | Add Bike | إضافة دراجة |
| `addBikeTitle` | Add New Bike | إضافة دراجة جديدة |
| `addBikeToFleetBtn` | Add New Bike to Fleet | إضافة دراجة جديدة للأسطول |
| `addCustomBrandLabel` | Add brand... | إضافة علامة... |
| `addCustomCatLabel` | Add custom category... | إضافة فئة مخصصة... |
| `addCustomFlavLabel` | Add flavour... | إضافة نكهة... |
| `addCustomTypeLabel` | Add type... | إضافة نوع... |
| `addLocationLabel` | Add new location... | إضافة موقع جديد... |
| `addNewOption` | Add new... | إضافة جديد... |
| `addToCalendarBtn` | Add to Calendar | أضف إلى التقويم |
| `addToWallet` | Add to Apple Wallet | أضف إلى Apple Wallet |
| `addWalkin` | + Walk-in | + زيارة مباشرة |
| `addWalkinBtn` | Add Walk-in | إضافة زيارة |

### `am*` — 20 keys

| key | English | العربية |
|---|---|---|
| `amAutoTag` | Auto-granted | تُمنح تلقائيًا |
| `amCustomersTitle` | Customers | العملاء |
| `amEditTag` | Edit tag | تعديل الوسم |
| `amEditTags` | Tags | الوسوم |
| `amFilterAll` | All | الكل |
| `amHolders` | {0} holders | {0} حاملًا |
| `amNewTag` | New tag | وسم جديد |
| `amNoCustomers` | No customer accounts yet. | لا توجد حسابات عملاء بعد. |
| `amNoTags` | No tags | لا وسوم |
| `amSearchPh` | Search name, email or phone | ابحث بالاسم أو البريد أو الهاتف |
| `amTagColor` | Colour | اللون |
| `amTagDeleted` | Tag deleted | تم حذف الوسم |
| `amTagDesc` | Description | الوصف |
| `amTagDescPh` | Who is this tag for? | لمن هذا الوسم؟ |
| `amTagName` | Tag name | اسم الوسم |
| `amTagNamePh` | e.g. Saturday Social Ride | مثال: جولة السبت الاجتماعية |
| `amTagNameReq` | Enter a tag name. | أدخل اسم الوسم. |
| `amTagSaved` | Tag saved | تم حفظ الوسم |
| `amTagsSub` | Tags gate access to private events. Customers never see tags or that they exist. | تتحكم الوسوم في الوصول إلى الفعاليات الخاصة. لا يرى العملاء الوسوم ولا يعلمون بوجودها. |
| `amTagsTitle` | Tags | الوسوم |

### `an*` — 286 keys

| key | English | العربية |
|---|---|---|
| `anAddCapacityHint` | Consider adding capacity |  فكّر في زيادة السعة |
| `anAddonRevRide` | Add-on SAR / ride | ريال إضافات / رحلة |
| `anAddonsSub` | Most-selected booking extras (this range) | أكثر الإضافات اختياراً (هذا النطاق) |
| `anAddonsTitle` | Add-on sales | مبيعات الإضافات |
| `anAllRatings` | All ratings | كل التقييمات |
| `anAllRatingsSub` | {0} rated rides, most recent first | {0} رحلة مقيّمة، الأحدث أولاً |
| `anAllTime` | All Time | كل الوقت |
| `anAnomalyDown` | Latest session down {0}% vs your usual {1} riders — check timing, weather or run a promo. | آخر جلسة أقل بـ {0}% من معدّلك المعتاد {1} راكب — راجع التوقيت أو الطقس أو أطلق عرضاً. |
| `anAnomalyTitle` | Trend alert | تنبيه اتجاه |
| `anAnomalyUp` | Latest session up {0}% vs your usual {1} riders — ride the momentum. | آخر جلسة أعلى بـ {0}% من معدّلك المعتاد {1} راكب — استثمر هذا الزخم. |
| `anApprovedAvg` | Rides per rider | جولات لكل راكب |
| `anApprovedTotal` | Approvals given | عدد الموافقات |
| `anApprovedUnique` | Riders approved (unique) | الراكبون المعتمدون (فريدون) |
| `anAttachRate` | Attach rate | نسبة الإرفاق |
| `anAttachRateSub` | rides that added a product | رحلات أضافت منتجاً |
| `anAttachTitle` | Retail attach | المبيعات المرافقة |
| `anAttempts` | attempts | محاولة |
| `anAttnHeavyUse` | Heavy use | استخدام كثيف |
| `anAttnLowRated` | Low rating | تقييم منخفض |
| `anAvgBikeRating` | Avg bike rating | متوسط تقييم الدراجة |
| `anAvgDuration` | Avg Duration | متوسط المدة |
| `anAvgExpRating` | Avg experience | متوسط التجربة |
| `anAvgFill` | Avg fill rate | متوسط نسبة الإشغال |
| `anAvgOccupancy` | Avg Occupancy | متوسط الإشغال |
| `anAvgPerPiece` | Avg Rides per Piece | متوسط الرحلات لكل قطعة |
| `anAvgPerPieceSub` | Total model rides divided by number of bikes of that model | إجمالي رحلات الموديل ÷ عدد دراجات هذا الموديل |
| `anAvgPerSession` | Avg / Session | متوسط الجلسة |
| `anAvgSpend` | avg spend | متوسط الإنفاق |
| `anBasketNone` | Not enough multi-item receipts yet. | لا توجد فواتير متعددة العناصر بعد. |
| `anBasketSub` | Products that share a receipt — good bundle candidates | منتجات تشترك في نفس الفاتورة — مرشّحة للعروض المجمّعة |
| `anBasketTitle` | Bought together | تُشترى معاً |
| `anBestSession` | Best Session by Revenue | أفضل جلسة من حيث الإيرادات |
| `anBikeUtilSub` | Completed rides per bike, and bikes sitting idle | عدد الرحلات المكتملة لكل دراجة والدراجات غير المستخدمة |
| `anBikeUtilTitle` | Bike Utilization | استخدام الدراجات |
| `anBusiestDayLabel` | Busiest Day of Week | أكثر يوم في الأسبوع نشاطاً |
| `anByBrand` | Rentals by Brand | الإيجارات حسب الماركة |
| `anByBrandSub` | Total completed rides per brand | إجمالي الرحلات المكتملة لكل ماركة |
| `anByDay` | Rides by Day of Week | الرحلات حسب يوم الأسبوع |
| `anByModel` | Rentals by Model | الإيجارات حسب الموديل |
| `anByModelSub` | Total completed rides per model | إجمالي الرحلات المكتملة لكل موديل |
| `anByRevType` | Revenue by Bike Type | الإيرادات حسب نوع الدراجة |
| `anBySize` | Rides by Frame Size | الرحلات حسب مقاس الإطار |
| `anByType` | Rides by Bike Type | الرحلات حسب نوع الدراجة |
| `anCancellationRate` | Cancellation Rate | معدل الإلغاء |
| `anCancellations` | cancellations | إلغاء |
| `anCapacity` | Capacity | الطاقة |
| `anCardCollected` | Card collected | المحصّل بالبطاقة |
| `anCardShare` | card share | نسبة البطاقة |
| `anCashCollected` | Cash collected | المحصّل نقداً |
| `anChartCumRev` | Cumulative Revenue | الإيرادات التراكمية |
| `anChartCumSub` | Running total of collected revenue over time | المجموع التراكمي للإيرادات المحصّلة مع الوقت |
| `anChartDaySub` | Busiest days drive scheduling decisions | أكثر الأيام ازدحاماً يوجّه قرارات الجدولة |
| `anChartFrameSub` | Distribution across XS · S · M · L | التوزيع عبر XS · S · M · L |
| `anChartOccSub` | % of capacity filled per session | نسبة الطاقة المستخدمة لكل جلسة |
| `anChartOccupancy` | Session Occupancy | إشغال الجلسة |
| `anChartPaySplit` | Payment Split | توزيع المدفوعات |
| `anChartPaySub` | Collected vs pending across all rides | المحصّل مقابل المعلق عبر كل الرحلات |
| `anChartRevPerSession` | Revenue per Session | الإيرادات لكل جلسة |
| `anChartRevSub` | Green = collected · dashed = total billed | أخضر = محصّل · منقط = إجمالي الفاتورة |
| `anChartRidersPerSession` | Riders per Session | الراكبون لكل جلسة |
| `anChartRidersSub` | Blue = riders · dashed = capacity | أخضر = راكبون · منقط = الطاقة |
| `anChartTypeDistrib` | Bike Type Distribution | توزيع أنواع الدراجات |
| `anChartTypeSubtext` | Share of rides by type preference | حصة كل نوع من إجمالي الرحلات |
| `anCntRiders` | Number of Riders | عدد الراكبين |
| `anCntRidersSub` | unique riders across counted rides | راكبون فريدون ضمن الرحلات المحتسبة |
| `anCntRides` | Number of Rides | عدد الرحلات |
| `anCogs` | Cost of goods | تكلفة البضاعة |
| `anCohortColMonth` | Month | الشهر |
| `anCohortColNew` | New | جدد |
| `anCohortColRepeat` | Repeat | متكرر |
| `anCohortColRode` | Rode | ركبوا |
| `anCohortSub` | new signups who became riders | المسجلون الجدد الذين أصبحوا ركاباً |
| `anCohortTitle` | Signup cohorts | مجموعات التسجيل |
| `anColDate` | Date | التاريخ |
| `anColDay2` | Day | اليوم |
| `anColNoShows` | No-Shows | الغياب |
| `anColOccupancy` | Occupancy | الإشغال |
| `anColPending` | Pending | المعلق |
| `anColRevenue` | Revenue | الإيرادات |
| `anColRiders` | Riders | الراكبون |
| `anColTopType` | Top Type | النوع الأكثر |
| `anColTopType2` | Top Type | النوع الأكثر |
| `anCollRateLabel` | collection rate | معدل التحصيل |
| `anCollected` | Collected | المحصّل |
| `anCollectedOnly` | Collected only | المحصّل فقط |
| `anCollectionRate` | Collection Rate | معدل التحصيل |
| `anCompletionRate` | Completion Rate | معدل الإتمام |
| `anCompletionSub` | Riders who completed the session | الراكبون الذين أكملوا الجلسة |
| `anCsvEmpty` | Nothing to export in this range. | لا يوجد ما يُصدَّر في هذا النطاق. |
| `anCustRetention` | Customer Retention | نسبة عودة العملاء |
| `anCustom` | Custom | مخصص |
| `anDateRange` | Date Range | نطاق تاريخ |
| `anDaysInServiceShort` | {0}d in service | {0} يوم بالخدمة |
| `anDemandTitle` | Demand | الطلب |
| `anDigestShare` | Share digest | مشاركة الملخص |
| `anDiscountsGiven` | Discounts given | الخصومات الممنوحة |
| `anDurByModel` | Avg Duration by Model | متوسط المدة حسب الموديل |
| `anDurByModelSub` | Which bikes see the longest rides | الدراجات ذات الرحلات الأطول |
| `anDurBySession` | Avg Duration by Session | متوسط المدة حسب الجلسة |
| `anDurBySessionSub` | How ride times vary across sessions | تفاوت الرحلات عبر الجلسات |
| `anDurByType` | Avg Duration by Type | متوسط المدة حسب النوع |
| `anDurByTypeSub` | Average minutes per ride by bike type | متوسط الدقائق لكل رحلة حسب نوع الدراجة |
| `anDurDistrib` | Ride Length Distribution | توزيع مدة الركوب |
| `anDurDistribSub` | How long riders typically stay on the bike | كم من الوقت يمضي الراكبون على الدراجة |
| `anDurRidesTracked` | rides tracked | رحلات مرصودة |
| `anDurationSection` | Ride Duration | مدة الركوب |
| `anExportCsv` | Export CSV | تصدير CSV |
| `anFillBySession` | Fill rate by session | نسبة الإشغال لكل جلسة |
| `anFillBySessionSub` | Booked vs capacity (busiest first) | المحجوز مقابل السعة (الأكثر ازدحاماً أولاً) |
| `anFleetSection` | Fleet Analytics | تحليلات الأسطول |
| `anForecastSoFar` | so far | حتى الآن |
| `anForecastSub` | Projected from the pace so far ({0} of {1} days) | متوقّع من الوتيرة حتى الآن ({0} من {1} يوم) |
| `anForecastTitle` | This-month forecast | توقّع هذا الشهر |
| `anFromDate` | From | من |
| `anFunnelBooked` | Booked | محجوز |
| `anFunnelCheckedIn` | Checked in | تم الحضور |
| `anFunnelCompleted` | Completed | مكتمل |
| `anFunnelSub` | Where riders drop off between booking and finishing | أين يتسرّب الركاب بين الحجز وإنهاء الرحلة |
| `anFunnelTitle` | Booking funnel | مسار الحجز |
| `anGrossProfit` | Gross profit | إجمالي الربح |
| `anHeatSub` | Rides by day & time of day — schedule sessions around the hot spots | الرحلات حسب اليوم ووقت اليوم — جدول الجلسات حول أوقات الذروة |
| `anHeatTitle` | Demand heatmap | خريطة الطلب الحرارية |
| `anHeightAvg` | avg | المتوسط |
| `anHeightReport` | Height & Bike report | تقرير الأطوال والدراجات |
| `anHeightReportSub` | Per session: rider heights + bikes rented by type | لكل جلسة: أطوال الركّاب + الدراجات المؤجّرة حسب النوع |
| `anHeightSub` | Height distribution of riders in range | توزيع أطوال الركّاب في النطاق |
| `anHeightTitle` | Rider Heights | أطوال الركّاب |
| `anHighlights` | Highlights | أبرز المؤشرات |
| `anIdleBikesTitle` | Idle bikes | دراجات غير مستخدمة |
| `anInsightGoodCollection` | Collection rate is strong - revenue is being captured effectively. | معدل التحصيل ممتاز - الإيرادات تُحصَّل بكفاءة. |
| `anInsightHighOcc` | Sessions are filling well. Consider adding more sessions to meet demand. | الجلسات تمتلئ بشكل جيد. فكر في إضافة جلسات لتلبية الطلب. |
| `anInsightLowCollection` | Collection rate is below 70%. Follow up on SAR {0} in pending payments. | معدل التحصيل أقل من 70%. تابع {0} ريال مستحقة الدفع. |
| `anInsightLowOcc` | Average occupancy is low. Try marketing or reducing session frequency. | متوسط الإشغال منخفض. حاول تسويق الخدمة أو تقليل تكرار الجلسات. |
| `anInsightPeakTime` | Busiest slot: {0} ({1} rides). Add capacity or open more sessions at this time. | أكثر الأوقات ازدحاماً: {0} ({1} رحلة). فكّر في زيادة السعة أو فتح جلسات إضافية في هذا الوقت. |
| `anInsightPendingHigh` | SAR {0} is outstanding ({1}% of billed). Prompt collection recommended. | {0} ريال مستحقة ({1}% من المفوتر). يُنصح بالمتابعة الفورية. |
| `anInsightRetention` | Strong repeat rider rate ({0}%). Loyalty program could further boost returns. | معدل عودة العملاء مرتفع ({0}%). برنامج ولاء يمكن أن يعزز العودة أكثر. |
| `anInsightTopDay` | Busiest day: {0}. Prioritize sessions on this day to maximize revenue. | أكثر الأيام نشاطاً: {0}. أولوية إضافة الجلسات هذا اليوم. |
| `anInsightTopType` | Most-requested type: {0}. Ensure fleet stock matches demand. | الأكثر طلباً: {0}. تأكد من توافر الأسطول بما يتناسب مع الطلب. |
| `anInsights` | Business Insights | رؤى تجارية |
| `anLapsedColLast` | Last ride | آخر رحلة |
| `anLapsedColRider` | Rider | الراكب |
| `anLapsedColRides` | Rides | الرحلات |
| `anLapsedSub` | no ride in 30+ days | لم يركبوا منذ أكثر من 30 يوماً |
| `anLapsedTitle` | Lapsed riders | عملاء متوقفون |
| `anLast10` | Last 10 Sessions | آخر 10 جلسات |
| `anLast5` | Last 5 Sessions | آخر 5 جلسات |
| `anLiveActive` | On bikes now | على الدراجات الآن |
| `anLiveFill` | Booked / capacity | المحجوز / السعة |
| `anLiveRev` | Revenue today | إيراد اليوم |
| `anLiveRides` | Rides today | رحلات اليوم |
| `anLiveSub` | Live — today's sessions | مباشر — جلسات اليوم |
| `anLiveTitle` | Today | اليوم |
| `anLongestRide` | Longest Ride | أطول رحلة |
| `anLtvAvg` | Avg LTV | متوسط القيمة |
| `anLtvCohort` | Cohort | المجموعة |
| `anLtvRiders` | Riders | الركاب |
| `anLtvSub` | Average total spend per rider, grouped by their first-ride month | متوسط إجمالي الإنفاق لكل راكب، مجمّعاً حسب شهر أول رحلة |
| `anLtvTitle` | Lifetime value by cohort | القيمة الدائمة حسب المجموعة |
| `anMargin` | Margin | الهامش |
| `anMarginSub` | Product revenue minus cost of goods, for items that have a cost set | إيراد المنتجات ناقص تكلفة البضاعة، للعناصر التي لها تكلفة محددة |
| `anMarginTitle` | Gross margin | هامش الربح |
| `anMeasuredRides` | rides with measured time | رحلة بوقت مُقاس |
| `anMostPopFrame` | Most Common Frame Size | المقاس الأكثر شيوعاً |
| `anMostPopType` | Most Popular Bike Type | النوع الأكثر طلباً |
| `anNavCustomers` | Customers | العملاء |
| `anNavGrowth` | Growth | النمو |
| `anNavOverview` | Overview | نظرة عامة |
| `anNeedsAttention` | Bikes needing attention | دراجات تحتاج انتباهاً |
| `anNeverUsed` | Never used | لم تُستخدم |
| `anNoAddons` | No add-ons sold in this range. | لا توجد إضافات مباعة في هذا النطاق. |
| `anNoAttention` | All bikes look healthy. | كل الدراجات بحالة جيدة. |
| `anNoBikesData` | No bike data yet. | لا توجد بيانات للدراجات بعد. |
| `anNoData` | No completed rides yet. Data will appear here once sessions are done. | لا توجد رحلات مكتملة بعد. ستظهر البيانات هنا عند اكتمال الجلسات. |
| `anNoData2` | No data | لا بيانات |
| `anNoDataTrend` | No sessions with completed rides yet. | لا توجد جلسات مكتملة بعد. |
| `anNoPrev` | no prior period | لا توجد فترة سابقة |
| `anNoPromo` | No promo codes used in this range. | لم تُستخدم أي رموز خصم في هذا النطاق. |
| `anNoShowByDay` | No-shows by day | حالات الغياب حسب اليوم |
| `anNoShowByDaySub` | Which days lose the most riders | الأيام التي تفقد أكبر عدد من الركّاب |
| `anNoShowLost` | est. revenue lost | إيراد مفقود تقريباً |
| `anNoShowRate` | No-Show Rate | معدل الغياب |
| `anOf` | of | من |
| `anOperations` | Operations | العمليات |
| `anOutOf10` | /10 | /10 |
| `anPageSub` | Business performance · live data from all completed sessions. | لوحة أداء الأعمال · بيانات مباشرة من جميع الجلسات المكتملة. |
| `anPayTitle` | Payments | المدفوعات |
| `anPeakTimeLabel` | Peak Time of Day | وقت الذروة |
| `anPerRide` | per ride | لكل رحلة |
| `anProjRev` | Projected revenue | الإيراد المتوقع |
| `anProjRides` | Projected rides | الرحلات المتوقعة |
| `anPromoCol` | Code | الرمز |
| `anPromoSub` | Bookings that used a promo code (this range) | الحجوزات التي استخدمت رمز خصم (هذا النطاق) |
| `anPromoTitle` | Promo redemptions | استخدام رموز الخصم |
| `anPromoUses` | Bookings | الحجوزات |
| `anRatedRidesUnit` | rated rides | رحلات مقيّمة |
| `anRatingByModel` | Bike Rating by Model | تقييم الدراجة حسب الموديل |
| `anRatingByModelSub` | Average bike rating per model — guides purchasing & retirement | متوسط تقييم الدراجة لكل موديل — يوجّه قرارات الشراء والتقاعد |
| `anRatingsSection` | Ratings & Bike Health | التقييمات وصحة الدراجات |
| `anRepeatRate` | Repeat rate (all-time) | نسبة العملاء المتكررين (الإجمالي) |
| `anRepeatRateSub` | riders with 2+ rides | راكب لديه رحلتان فأكثر |
| `anRepeatRiders` | Repeat Riders | الراكبون المتكررون |
| `anRetCurveSub` | Share of first-time riders who came back within… | نسبة الركاب الجدد الذين عادوا خلال… |
| `anRetCurveTitle` | Retention curve | منحنى الاحتفاظ |
| `anRetElig` | {0} of {1} riders | {0} من {1} راكب |
| `anRetWindow` | {0} days | {0} يوم |
| `anRetentionTitle` | Retention | الاحتفاظ بالعملاء |
| `anReturned` | returned | عاد |
| `anRevByDay` | Revenue by Day of Week | الإيرادات حسب اليوم |
| `anRevByDaySub` | Average collected SAR per day - guides scheduling | متوسط الإيرادات المحصّلة يومياً - يُفيد في جدولة الجلسات |
| `anRevByModel` | Revenue by Model | الإيرادات حسب الموديل |
| `anRevByModelSub` | Collected revenue per bike model | الإيرادات المحصّلة لكل موديل |
| `anRevCollected` | Revenue Collected | الإيرادات المحصلة |
| `anRevPAS` | Revenue Per Seat | الإيراد لكل مقعد |
| `anRevPASSub` | Collected ÷ total seats offered | المحصّل ÷ إجمالي المقاعد المتاحة |
| `anRevPending` | Revenue Pending | الإيرادات المعلقة |
| `anRevPerCust` | Revenue per Unique Customer | الإيراد لكل عميل |
| `anRevPerRide` | Revenue per Ride | الإيراد لكل رحلة |
| `anRevTotal` | Total Revenue | إجمالي الإيرادات |
| `anRevenue` | Revenue | الإيرادات |
| `anRfmAtRisk` | At risk | معرّضون للفقد |
| `anRfmAtRiskD` | slipping away — win them back | يبتعدون — استعِدهم |
| `anRfmChampions` | Champions | الأبطال |
| `anRfmChampionsD` | frequent & recent | متكررون وحديثون |
| `anRfmLost` | Lost | مفقودون |
| `anRfmLostD` | no ride in 60+ days | لا رحلة منذ 60+ يوماً |
| `anRfmLoyal` | Loyal | الأوفياء |
| `anRfmLoyalD` | 2+ rides, still active | رحلتان أو أكثر، نشطون |
| `anRfmMore` | +{0} more | +{0} آخرون |
| `anRfmMsg` | Hi {0}! It's MicroMobility 🚲 — hope to see you on a ride soon! | مرحباً {0}! نحن مايكروموبيليتي 🚲 — نتطلع لرؤيتك في رحلة قريباً! |
| `anRfmNew` | New | جدد |
| `anRfmNewD` | first ride, recent | أول رحلة، حديثاً |
| `anRfmNone` | No riders here yet. | لا يوجد ركاب هنا بعد. |
| `anRfmSub` | Recency · Frequency · Money — tap a rider to message them | الحداثة · التكرار · الإنفاق — اضغط على راكب لمراسلته |
| `anRfmTitle` | Rider segments (RFM) | شرائح الركاب (RFM) |
| `anRideDefSub` | paid = ride before 12 Aug 2026 · checked-in only from then on | قبل 12 أغسطس 2026: المدفوع يُحتسب رحلة · بعده: تسجيل الدخول فقط |
| `anRideMinutes` | Actual Riding Minutes | دقائق الركوب الفعلية |
| `anRiders` | Riders | الراكبون |
| `anRidersCapacity` | Riders ÷ capacity | الراكبون ÷ الطاقة |
| `anRidership` | Ridership | الراكبون |
| `anRidesFromReturning` | rides from returning customers | رحلة من عملاء عائدين |
| `anRidesLabel` | rides | رحلة |
| `anRidesShortN` | {0} rides | {0} رحلة |
| `anRidesUnit` | rides | رحلات |
| `anSeatsFilled` | seats sold | مقعد محجوز |
| `anSessPerformTable` | Session Performance Table | جدول أداء الجلسات |
| `anSessionAll` | All sessions | كل الجلسات |
| `anSessionLabel` | Session | الجلسة |
| `anSessionTrend` | Session-by-Session Performance | أداء الجلسات |
| `anSessionsHeld` | Sessions Held | الجلسات المنعقدة |
| `anShortestRide` | Shortest Ride | أقصر رحلة |
| `anShowing` | Showing: | عرض: |
| `anSoldOut` | Sold-out sessions | جلسات ممتلئة |
| `anSoldOutNone` | No sessions sold out | لا توجد جلسات ممتلئة |
| `anSpentCol` | Spent | الإنفاق |
| `anTargetBehind` | Behind pace | دون الوتيرة |
| `anTargetNone` | Set a monthly revenue target to track your pace. | عيّن هدف إيراد شهري لتتبّع وتيرتك. |
| `anTargetOnPace` | On pace ✓ | ضمن الوتيرة ✓ |
| `anTargetProjEnd` | Projected month-end: SAR {0} | المتوقع نهاية الشهر: SAR {0} |
| `anTargetPrompt` | Monthly revenue target (SAR)? | هدف الإيراد الشهري (ريال)؟ |
| `anTargetSet` | Set target | تعيين الهدف |
| `anTargetTitle` | Monthly revenue target | هدف الإيراد الشهري |
| `anTeamConsumption` | Team account by member | حساب الفريق حسب العضو |
| `anTeamConsumptionSub` | Products taken on the MM Team account (this range) | منتجات مأخوذة على حساب فريق MM (هذا النطاق) |
| `anThisMonth` | This Month | هذا الشهر |
| `anThisYear` | This Year | هذه السنة |
| `anToDate` | To | إلى |
| `anTopCustomers` | Top customers | أفضل العملاء |
| `anTopCustomersSub` | By spend in this range | حسب الإنفاق في هذا النطاق |
| `anTopSellers` | Top sellers | الأكثر مبيعاً |
| `anTopSellersSub` | Most-sold products (this range) | المنتجات الأكثر مبيعاً (هذا النطاق) |
| `anTotal` | Total | الإجمالي |
| `anTotalCreated` | total created | منشأة إجمالاً |
| `anTotalRides` | Completed Rides | الرحلات المكتملة |
| `anTotalSeats` | Total Seats Offered | إجمالي المقاعد المتاحة |
| `anTrendsSub` | Recent sessions, oldest → newest | الجلسات الأخيرة، من الأقدم إلى الأحدث |
| `anTrendsTitle` | Trends | الاتجاهات |
| `anTypeRevPerRide` | Avg Revenue per Ride by Type | متوسط الإيراد لكل رحلة حسب النوع |
| `anTypeRevPerRideSub` | How much each bike type earns per completed ride | كم تحقق كل فئة دراجات لكل رحلة مكتملة |
| `anUniqueCustomers` | Unique Customers | العملاء الفريدون |
| `anUnpaidRides` | unpaid rides | رحلة غير مدفوعة |
| `anVsPrev` | vs prev period | مقارنة بالفترة السابقة |
| `anWeatherFlat` | Weather has little effect on rides. | للطقس تأثير ضئيل على الرحلات. |
| `anWeatherSub` | Rides vs daily-high temperature (Jeddah, Open-Meteo) | الرحلات مقابل درجة الحرارة العظمى (جدة، Open-Meteo) |
| `anWeatherTitle` | Weather & demand | الطقس والطلب |
| `anWeatherWarmLess` | Cooler days bring more rides. | الأيام الأبرد تجلب رحلات أكثر. |
| `anWeatherWarmMore` | Warmer days bring more rides. | الأيام الأدفأ تجلب رحلات أكثر. |

### `appr*` — 8 keys

| key | English | العربية |
|---|---|---|
| `apprApproveBtn` | Approve | موافقة |
| `apprApprovedChip` | Approved | مقبول |
| `apprApprovedToast` | {0} approved | تمت الموافقة على {0} |
| `apprPendingChip` | Pending approval | بانتظار الموافقة |
| `apprRejectBtn` | Reject | رفض |
| `apprRejectedToast` | {0} rejected | تم رفض {0} |
| `apprSelectBtn` | Select | اختيار |
| `apprUndoBtn` | Undo approval | تراجع عن الموافقة |

### `auth*` — 17 keys

| key | English | العربية |
|---|---|---|
| `authCancel` | Cancel - Go Home | إلغاء - الرئيسية |
| `authConfirmPassword` | Confirm Password | تأكيد كلمة المرور |
| `authEmail` | Email Address | البريد الإلكتروني |
| `authEmailOpt` | (optional if using phone) | (اختياري إذا استخدمت الهاتف) |
| `authFullName` | Full Name | الاسم الكامل |
| `authIdentifier` | Email or Phone | البريد الإلكتروني أو الهاتف |
| `authLogin` | Log In | تسجيل الدخول |
| `authLoginBtn` | Log In | تسجيل الدخول |
| `authOr` | or | أو |
| `authPassword` | Password | كلمة المرور |
| `authPasswordHint` | Min 8 chars, 1 uppercase, 1 number | 8 أحرف كحد أدنى، حرف كبير ورقم |
| `authPhone` | Phone Number | رقم الهاتف |
| `authPhoneOpt` | (optional if using email) | (اختياري إذا استخدمت البريد) |
| `authSignup` | Sign Up | إنشاء حساب |
| `authSignupBtn` | Create Account | إنشاء الحساب |
| `authSub` | Sign in or create an account to track your rides. | سجل دخولك أو أنشئ حساباً لتتبع رحلاتك. |
| `authWelcome` | Welcome to MicroMobility | مرحباً بك في مايكرو موبيليتي |

### `bd*` — 20 keys

| key | English | العربية |
|---|---|---|
| `bd25` | Corniche 25 | كورنيش ٢٥ |
| `bd25D` | 25 rides on the corniche | ٢٥ رحلة على الكورنيش |
| `bdCarbon` | Carbon Club | نادي الكربون |
| `bdCarbonD` | Rode the Road Carbon | ركبت درّاجة الرود كاربون |
| `bdEarned` | Earned | حصلت عليه |
| `bdFirstLap` | First Lap | اللفة الأولى |
| `bdFirstLapD` | Completed your first circuit ride | أكملت أول رحلة لك في الحلبة |
| `bdFrontRow` | Front Row | الصف الأول |
| `bdFrontRowD` | Held booking #1 in a session | حصلت على الحجز رقم ١ في جلسة |
| `bdFuel` | Fuel Stop | محطة تزوّد |
| `bdFuelD` | Added extras to a booking | أضفت إضافات إلى حجزك |
| `bdHowTo` | How to earn | كيف تحصل عليه |
| `bdPodium` | Podium Pace | إيقاع المنصة |
| `bdPodiumD` | 10 rides strong | ١٠ رحلات |
| `bdRegular` | Grid Regular | منتظم الحلبة |
| `bdRegularD` | 5 rides on the grid | ٥ رحلات في الحلبة |
| `bdSquad` | Squad Captain | قائد المجموعة |
| `bdSquadD` | Booked for 3+ riders at once | حجزت لـ٣ رُكّاب أو أكثر دفعة واحدة |
| `bdStreak` | Hot Streak | حماس متواصل |
| `bdStreakD` | Rode 3 weeks in a row | ركبت ٣ أسابيع متتالية |

### `bike*` — 22 keys

| key | English | العربية |
|---|---|---|
| `bike` | Bike | دراجة |
| `bikeAutoName` | Auto Name | الاسم التلقائي |
| `bikeBrand` | Brand | الماركة |
| `bikeColorsLabel` | Bike Color(s) | لون الدراجة |
| `bikeCustomPrice` | Custom Rental Price | سعر إيجار مخصص |
| `bikeEndDate` | Retired Date | تاريخ التقاعد |
| `bikeFleetComp` | Bike Fleet Composition | تركيبة أسطول الدراجات |
| `bikeFrameTypeLabel` | Frame Type | نوع الإطار |
| `bikeGroupset` | Groupset | منظومة التروس |
| `bikeLocationLabel` | Location | الموقع |
| `bikeModel` | Model | الموديل |
| `bikeNameAuto` | Auto | تلقائي |
| `bikeNameHint` | (edit to rename) | (عدّل لإعادة التسمية) |
| `bikeNameLabel` | Bike Name | اسم الدراجة |
| `bikeNumberLabel` | Bike Number | رقم الدراجة |
| `bikeRentalPrice` | Rental Price | سعر الإيجار |
| `bikeReserveCleared` | Reservation cleared | تم إلغاء الحجز |
| `bikeReservedToast` | {0} reserved | تم حجز {0} |
| `bikeSpeeds` | Speeds | عدد السرعات |
| `bikeStartDate` | In-Service Date | تاريخ بدء الاستخدام |
| `bikeTypeLabel` | Bike Type | نوع الدراجة |
| `bikeTypePref` | Bike Type Preference | تفضيل نوع الدراجة |

### `bk*` — 15 keys

| key | English | العربية |
|---|---|---|
| `bkBulkExport` | Export CSV | تصدير CSV |
| `bkBulkLocPh` | Location… | الموقع… |
| `bkBulkMaint` | Maintenance | صيانة |
| `bkBulkMaintConfirm` | Move {0} selected bike(s) to maintenance? In-use bikes are skipped. | نقل {0} دراجة محددة إلى الصيانة؟ يتم تخطّي الدراجات قيد الاستخدام. |
| `bkBulkMove` | Move | نقل |
| `bkBulkNoneEligible` | No eligible bikes in selection. | لا توجد دراجات مؤهلة ضمن التحديد. |
| `bkBulkPickLoc` | Choose a location first. | اختر موقعاً أولاً. |
| `bkBulkPickPrice` | Enter a valid price. | أدخل سعراً صحيحاً. |
| `bkBulkPricePh` | SAR | ريال |
| `bkBulkRetire` | Retire | تقاعد |
| `bkBulkRetireConfirm` | Retire {0} selected bike(s)? In-use bikes are skipped. | تقاعد {0} دراجة محددة؟ يتم تخطّي الدراجات قيد الاستخدام. |
| `bkBulkSetPrice` | Set price | تحديد السعر |
| `bkBulkUpdated` | {0} bike(s) updated | تم تحديث {0} دراجة |
| `bkSelectAll` | Select all | تحديد الكل |
| `bkSelectedN` | {0} selected | {0} محدد |

### `bp*` — 12 keys

| key | English | العربية |
|---|---|---|
| `bpAvgRating` | Avg rating | متوسط التقييم |
| `bpColorsLabel` | Colors | الألوان |
| `bpFeedbackTitle` | Rider feedback | ملاحظات الركّاب |
| `bpHistoryTitle` | Recent rides | أحدث الرحلات |
| `bpInServiceLabel` | In service | في الخدمة |
| `bpLastUsed` | Last used | آخر استخدام |
| `bpNever` | Never | لم تُستخدم |
| `bpNoRides` | No completed rides yet. | لا توجد رحلات مكتملة بعد. |
| `bpRevenue` | Revenue | الإيرادات |
| `bpRides` | Rides | الرحلات |
| `bpSpecsTitle` | Specifications | المواصفات |
| `bpUtilLabel` | Utilization | الاستخدام |

### `cancel*` — 10 keys

| key | English | العربية |
|---|---|---|
| `cancelBooking` | Cancel | إلغاء |
| `cancelBookingLabel` | Cancel booking | إلغاء الحجز |
| `cancelBtn` | Cancel | إلغاء |
| `cancelConfirmBtn` | Confirm Cancellation | تأكيد الإلغاء |
| `cancelEntryBody` | This will release any assigned bike and mark the entry as cancelled. | سيؤدي هذا إلى تحرير أي دراجة معيّنة ووضع الحجز كملغى. |
| `cancelOtherPlaceholder` | Please describe your reason... | يرجى وصف سببك... |
| `cancelReason1` | Change of plans | تغيير في الخطط |
| `cancelReason2` | Found a better price elsewhere | وجدت سعراً أفضل في مكان آخر |
| `cancelReason3` | Other | سبب آخر |
| `cancelReasonTitle` | Why are you cancelling? | ما سبب الإلغاء؟ |

### `cash*` — 49 keys

| key | English | العربية |
|---|---|---|
| `cashAcctLinked` | Linked to account | مرتبط بالحساب |
| `cashAddItemBtn` | Add item | إضافة عنصر |
| `cashAddedToast` | Sale recorded | تم تسجيل البيع |
| `cashAllItems` | All items | كل العناصر |
| `cashAmtLabel` | Unit price (SAR) | سعر الوحدة (ريال) |
| `cashAmtRequired` | Enter a valid amount | أدخل مبلغاً صحيحاً |
| `cashCard` | Card | بطاقة |
| `cashCartEmpty` | Add at least one item | أضف عنصراً واحداً على الأقل |
| `cashCartTitle` | Receipt items | عناصر الفاتورة |
| `cashCash` | Cash | نقدًا |
| `cashCustomOpt` | Custom item… | عنصر مخصص… |
| `cashCustomerLabel` | Customer (optional) | العميل (اختياري) |
| `cashCustomerPh` | Search name, phone, email - or type a name | ابحث بالاسم أو الجوال أو البريد - أو اكتب اسماً |
| `cashDiscount` | Discount | خصم |
| `cashDone` | Done | تم |
| `cashEditBtn` | Edit | تعديل |
| `cashItemsWord` | items | عناصر |
| `cashLedgerTitle` | Sales | المبيعات |
| `cashMarkPaid` | Mark paid | تحديد مدفوع |
| `cashNameLabel` | Item name | اسم العنصر |
| `cashNewSale` | New sale | عملية بيع جديدة |
| `cashNoSales` | No purchases yet. | لا توجد مشتريات بعد. |
| `cashNoSalesSession` | No sales recorded for this session yet. | لا توجد مبيعات مسجلة لهذه الجلسة بعد. |
| `cashNoSessions` | No sessions yet. Create a session first. | لا توجد جلسات بعد. أنشئ جلسة أولاً. |
| `cashPayLabel` | Payment | الدفع |
| `cashPendingSync` | {0} pending sync | {0} بانتظار المزامنة |
| `cashQtyCol` | Qty sold | الكمية المباعة |
| `cashQtyLabel` | Qty | الكمية |
| `cashReceiptRecorded` | Receipt recorded | تم تسجيل الفاتورة |
| `cashReceiptWord` | Receipt | فاتورة |
| `cashRecordBtn` | Record sale | تسجيل البيع |
| `cashRecordReceiptBtn` | Record receipt | تسجيل الفاتورة |
| `cashRefund` | Refund | استرداد |
| `cashRefundConfirm` | Refund this receipt? The items go back to stock and the sale is reversed (kept as a record). | استرداد هذه الفاتورة؟ تعود العناصر إلى المخزون ويُعكس البيع (يبقى كسجل). |
| `cashRefunded` | Refunded | مُسترد |
| `cashRefundedToast` | Receipt refunded | تم استرداد الفاتورة |
| `cashRefunds` | Refunds | المستردات |
| `cashRentalTag` | rental | إيجار |
| `cashRingUp` | Add to sale | إضافة للبيع |
| `cashSalesTitle` | Sales | المبيعات |
| `cashSavedToast` | Receipt updated | تم تحديث الفاتورة |
| `cashSelectItem` | Choose an item | اختر عنصراً |
| `cashShare` | Share | مشاركة |
| `cashSplitLabel` | Card payment | الدفع بالبطاقة |
| `cashTabSub` | Sell items and track sales for a session | بيع العناصر وتتبع المبيعات لكل جلسة |
| `cashValue` | Sales value | قيمة المبيعات |
| `cashVoid` | Void | إلغاء |
| `cashVoidedToast` | Purchase voided | تم إلغاء العملية |
| `cashWalkup` | Walk-up | زبون عابر |

### `cat*` — 12 keys

| key | English | العربية |
|---|---|---|
| `catAccessory` | Accessory | إكسسوار |
| `catApparel` | Apparel | ملابس |
| `catElectrolyteSachets` | Electrolytes | إلكتروليت |
| `catEnergyGels` | Energy Gels | جل طاقة |
| `catHelmet` | Helmet | خوذة |
| `catOther` | Other | أخرى |
| `catProteinBars` | Protein Bars | ألواح بروتين |
| `catProteinCookies` | Protein Cookies | كوكيز بروتين |
| `catProteinGummies` | Protein Gummies | علكة بروتين |
| `catProteinMuffins` | Protein Muffins | مافن بروتين |
| `catProteinSnacks` | Protein Snacks | سناك بروتين |
| `catSparePart` | Spare part | قطعة غيار |

### `col*` — 26 keys

| key | English | العربية |
|---|---|---|
| `colActions` | Actions | الإجراءات |
| `colBike` | Bike | الدراجة |
| `colBookingNum` | Booking # | رقم الحجز |
| `colBookings` | Bookings | الحجوزات |
| `colCapacity` | Capacity | الطاقة |
| `colColor` | Bike Color | لون الدراجة |
| `colContact` | Contact | تواصل |
| `colDate` | Date | التاريخ |
| `colDay` | Day | اليوم |
| `colDuration` | Duration | المدة |
| `colHeight` | Height | الطول |
| `colManageBike` | Manage Bike | إدارة الدراجة |
| `colManageBooking` | Manage Booking | إدارة الحجز |
| `colManageRecord` | Manage Record | إدارة السجل |
| `colManageSession` | Manage Session | إدارة الجلسة |
| `colMember` | Membership | العضوية |
| `colPayment` | Payment | الدفع |
| `colPosition` | Position | الموضع |
| `colPrice` | Price | السعر |
| `colQueueNum` | # | # |
| `colRevenue` | Revenue | الإيرادات |
| `colRider` | Rider | الراكب |
| `colSession` | Session | الجلسة |
| `colSizeType` | Size / Type | المقاس / النوع |
| `colStatus` | Status | الحالة |
| `colWants` | Wants | الطلب |

### `comm*` — 56 keys

| key | English | العربية |
|---|---|---|
| `commAddBtn` | Add rider | إضافة مشارك |
| `commAddDestLbl` | Add to | إضافة إلى |
| `commAddDestList` | Final list | القائمة النهائية |
| `commAddDup` | Already booked in this session. | محجوز في هذه الجلسة بالفعل. |
| `commAddGroupBtn` | Add group | إضافة مجموعة |
| `commAddGroupHint` | Pick two or more riders — they stay grouped together on the roster. | اختر مشاركَين أو أكثر — سيظهرون كمجموعة واحدة في القائمة. |
| `commAddGroupMin` | Select at least 2 riders. | اختر مشاركَين على الأقل. |
| `commAddGroupTitle` | Add group to a JCC session | إضافة مجموعة إلى جلسة JCC |
| `commAddNoMatch` | No matching customers. | لا يوجد عملاء مطابقون. |
| `commAddOwnBike` | Rider brings their own bike (does not use a spot) | الراكب لديه دراجته الخاصة (لا يشغل مقعداً) |
| `commAddRiderBtn` | Add rider | إضافة مشارك |
| `commAddSearchLbl` | Customer | العميل |
| `commAddSearchPh` | Search name, email or phone… | ابحث بالاسم أو البريد أو الجوال… |
| `commAddTitle` | Add rider to the social ride | إضافة مشارك إلى الجولة الاجتماعية |
| `commAddedToast` | {0} added | تمت إضافة {0} |
| `commCopied` | Leaderboard copied | تم نسخ لوحة المتصدرين |
| `commCueConfirmed` | Your spot is confirmed! | تم تأكيد مقعدك! |
| `commCuePending` | Reserved - awaiting confirmation | تم الحجز - بانتظار التأكيد |
| `commCueUnderReview` | Reserved - the rider list is being finalised | تم الحجز - يجري إعداد قائمة المشاركين |
| `commCueWaitlist` | On the waitlist - we will notify you if a spot opens | في قائمة الانتظار - سنعلمك إذا توفر مقعد |
| `commEvents` | Upcoming rides | الرحلات القادمة |
| `commFullWaitlistMsg` | This ride is full. You can still reserve - you will join the waitlist, and if a spot opens the staff may select you. | هذه الجولة مكتملة. لا يزال بإمكانك الحجز - ستنضم إلى قائمة الانتظار، وإذا توفر مقعد فقد يختارك الموظفون. |
| `commGatherShort` | Gathering | التجمع |
| `commGroupAddedToast` | {0} added as a group | تمت إضافة {0} كمجموعة |
| `commLeaderboard` | Leaderboard | المتصدرون |
| `commMaxTier` | Top tier reached | بلغ أعلى فئة |
| `commMembersIg` | Message us on Instagram | راسلنا على إنستغرام |
| `commMembersMsg` | Our community rides are invite-only, for our community members. Keep riding with us at the Corniche Circuit, and if you would like to join the community, ask our team at the booth or message us on WhatsApp or Instagram. | جولات مجتمعنا بدعوة خاصة لأعضاء المجتمع. واصل الركوب معنا في حلبة الكورنيش، وإذا رغبت في الانضمام إلى المجتمع فاسأل فريقنا في الكشك أو راسلنا عبر واتساب أو إنستغرام. |
| `commMembersOk` | Got it | حسناً |
| `commMembersTitle` | Community members only | لأعضاء المجتمع فقط |
| `commMileAway` | {0} away | تبقّى {0} |
| `commMilestones` | Milestone watch | على وشك الإنجاز |
| `commMilestonesSub` | Riders close to their next milestone | ركّاب قريبون من إنجازهم القادم |
| `commNoEvents` | No upcoming sessions scheduled. | لا توجد جلسات قادمة. |
| `commNoLeaders` | No completed rides yet. | لا توجد رحلات مكتملة بعد. |
| `commNoMatch` | No rider matches. | لا يوجد راكب مطابق. |
| `commRank` | Rank | الترتيب |
| `commRider` | Rider | الراكب |
| `commRides` | rides | رحلات |
| `commSearchPh` | Search rider… | ابحث عن راكب… |
| `commShareBtn` | Share | مشاركة |
| `commSoloOnly` | Saturday ride bookings are one rider per customer — extra riders cannot be added. | حجز جولة السبت لراكب واحد فقط لكل عميل — لا يمكن إضافة ركاب آخرين. |
| `commSpotlight` | Top rider | الراكب الأبرز |
| `commSpotsLeft` | {0} spots left | {0} مقاعد متبقية |
| `commStartShort` | Start | الانطلاق |
| `commStatAvg` | Avg / rider | متوسط/راكب |
| `commStatMinutes` | Minutes ridden | دقائق الركوب |
| `commStatRiders` | Active riders | الركّاب النشطون |
| `commStatRides` | Rides | الرحلات |
| `commSub` | Rider leaderboard and upcoming rides. | لوحة متصدّري الركّاب والرحلات القادمة. |
| `commTabAccounts` | Accounts | الحسابات |
| `commTabLeaderboard` | Leaderboard | المتصدرون |
| `commTabStats` | Statistics | الإحصائيات |
| `commTitle` | Community | المجتمع |
| `commToNext` | {0} rides to {1} | {0} رحلات حتى {1} |
| `commTopRiders` | Top riders by completed rides | أفضل الركّاب حسب الرحلات المكتملة |

### `confirm*` — 8 keys

| key | English | العربية |
|---|---|---|
| `confirmBikeChange` | Confirm Change | تأكيد التغيير |
| `confirmBtn` | Confirm | تأكيد |
| `confirmCheckin` | Confirm & Check In | تأكيد وتسجيل الدخول |
| `confirmDeleteBikeTitle` | Delete Bike? | حذف الدراجة؟ |
| `confirmNoShowTitle` | Mark as No-Show? | تسجيل كغائب؟ |
| `confirmRemoveTitle` | Remove Rider? | حذف الراكب؟ |
| `confirmUndoTitle` | Undo action? | التراجع عن الإجراء؟ |
| `confirmUndoYes` | Yes, undo it | نعم، تراجع |

### `cust*` — 11 keys

| key | English | العربية |
|---|---|---|
| `custAvgRating` | Avg rating | متوسط التقييم |
| `custBookingsLabel` | Booking history | سجل الحجوزات |
| `custBtn` | Customer | العميل |
| `custFavType` | Favorite type | النوع المفضل |
| `custMemberSince` | First seen | أول ظهور |
| `custNoBookings` | No bookings. | لا حجوزات. |
| `custProfileTitle` | Customer profile | ملف العميل |
| `custPurchTitle` | Purchases | المشتريات |
| `custTotalRides` | Completed rides | الرحلات المكتملة |
| `custTotalSpent` | Total spent | إجمالي الإنفاق |
| `custWalkIn` | Walk-in (no account) | زائر (بدون حساب) |

### `dash*` — 12 keys

| key | English | العربية |
|---|---|---|
| `dashAddonsToday` | Add-ons today | إضافات اليوم |
| `dashAlerts` | Alerts | التنبيهات |
| `dashAllClear` | All clear - nothing needs attention. | كل شيء على ما يرام - لا شيء يحتاج انتباهاً. |
| `dashAvailBikes` | Available bikes | الدراجات المتاحة |
| `dashLowBikes` | Only {0} bikes available | تبقّى {0} دراجات متاحة فقط |
| `dashMaintAlert` | {0} bike(s) in maintenance | {0} دراجة في الصيانة |
| `dashOnBikes` | On bikes now | على الدراجات الآن |
| `dashOpenSessions` | Open sessions | الجلسات المفتوحة |
| `dashOverdueSub` | Ride running long | الرحلة تطول |
| `dashSub` | Live overview of the booth right now. | نظرة حية على الكشك الآن. |
| `dashTitle` | Dashboard | لوحة القيادة |
| `dashWaiting` | Waiting | في الانتظار |

### `edit*` — 12 keys

| key | English | العربية |
|---|---|---|
| `editBikeTitle` | Edit Bike | تعديل الدراجة |
| `editBookingBtn` | Edit | تعديل |
| `editBookingSub` | Change the rider details or move the booking, the same fields the customer can edit. | عدّل بيانات الراكب أو انقل الحجز، نفس الحقول التي يمكن للعميل تعديلها. |
| `editBookingTitle` | Edit Booking | تعديل الحجز |
| `editBtn` | Edit | تعديل |
| `editBtn2` | Edit | تعديل |
| `editPriceBtn` | Edit Price | تعديل السعر |
| `editPriceCustom` | Custom Amount | مبلغ مخصص |
| `editPriceTip` | Edit price | تعديل السعر |
| `editPriceTitle` | Edit Payment Amount | تعديل مبلغ الدفع |
| `editQNumTip` | Edit booking number | تعديل رقم الحجز |
| `editSessionTitle` | Edit Session | تعديل الجلسة |

### `err*` — 74 keys

| key | English | العربية |
|---|---|---|
| `errAccountName` | Please enter your name. | الرجاء إدخال اسمك. |
| `errAccountNotFound` | No account found with that email. | لا يوجد حساب بهذا البريد الإلكتروني. |
| `errAddBikeToSession` | Please add at least one bike to the session. | الرجاء إضافة دراجة واحدة على الأقل للجلسة. |
| `errAdminOnly` | Admin accounts only. | للمسؤولين فقط. |
| `errAlreadyBooked` | You already have a booking for this session. | لديك حجز مسبق في هذه الجلسة. |
| `errAlreadyBookedSub` | Would you like to modify your existing booking instead? | هل تريد تعديل حجزك الحالي؟ |
| `errBikeFrameReq` | Please select a frame type. | الرجاء اختيار نوع الإطار. |
| `errBikeInUse` | Cannot change status while in use. | لا يمكن التغيير والدراجة قيد الاستخدام. |
| `errBikeLocationReq` | Please select a location. | الرجاء اختيار الموقع. |
| `errBikeName` | Please enter a bike name. | الرجاء إدخال اسم الدراجة. |
| `errBikeNumberDup` | That bike number is already in use. | رقم الدراجة مستخدم بالفعل. |
| `errBikeNumberReq` | Please enter a bike number. | الرجاء إدخال رقم الدراجة. |
| `errBikeTypeReq` | Please select a bike type. | الرجاء اختيار نوع الدراجة. |
| `errBikeUnavailable` | Bike no longer available. | الدراجة غير متاحة حالياً. |
| `errCancelWaiting` | Only waiting bookings can be cancelled. | يمكن إلغاء حجوزات الانتظار فقط. |
| `errCheckinRejected` | Check-in could not be saved. The server rejected the change, sign out and sign back in as staff, then try again. | تعذّر حفظ تسجيل الدخول. رفض الخادم التغيير، سجّل الخروج ثم الدخول كموظف وحاول مجدداً. |
| `errCommSessGate` | Could not create the community event - run tags-events-migration.sql first. | تعذّر إنشاء الفعالية المجتمعية - شغّل ملف tags-events-migration.sql أولًا. |
| `errConnection` | Connection error. Check your network. | خطأ في الاتصال. تحقق من شبكتك. |
| `errCreateSession` | Error creating session. | حدث خطأ في إنشاء الجلسة. |
| `errDateExists` | A session for that date already exists. | توجد جلسة بهذا التاريخ مسبقاً. |
| `errDeleteSession` | Error deleting session. | حدث خطأ في حذف الجلسة. |
| `errEmailExists` | An account with this email already exists. | يوجد حساب بهذا البريد الإلكتروني مسبقاً. |
| `errEmailOrPhone` | Please enter at least an email or phone number. | الرجاء إدخال بريد إلكتروني أو رقم هاتف على الأقل. |
| `errEmailRequired` | Please enter your email address. | الرجاء إدخال بريدك الإلكتروني. |
| `errEnterName` | Please enter your full name (first and last name). | الرجاء إدخال اسمك الكامل (الاسم الأول والأخير). |
| `errFieldRequired` | This field is required. | هذا الحقل مطلوب. |
| `errGoogleNoPw` | This account uses Google or Apple sign-in. Use that button to log in. | هذا الحساب يستخدم تسجيل الدخول عبر Google أو Apple. استخدم ذلك الزر للدخول. |
| `errGroupCap` | Up to {0} riders per booking on this ride. | حتى {0} راكبين لكل حجز في هذه الجولة. |
| `errHasBookings` | Cannot delete a session with existing bookings. | لا يمكن حذف جلسة تحتوي على حجوزات. |
| `errHasSales` | Cannot delete a session that has recorded sales. Refund or move them first. | لا يمكن حذف جلسة تحتوي على مبيعات مسجلة. استردها أو انقلها أولاً. |
| `errHeightReq` | Please enter your height in cm. | الرجاء إدخال طولك بالسنتيمتر. |
| `errInvalidCredentials` | Incorrect credentials. Please try again. | بيانات الدخول غير صحيحة. حاول مجدداً. |
| `errLoginFirst` | Please log in first. | الرجاء تسجيل الدخول أولاً. |
| `errLoginLocked` | Too many failed attempts. Please wait about 15 minutes and try again, or reset your password. | محاولات كثيرة فاشلة. انتظر حوالي ١٥ دقيقة ثم حاول مجدداً، أو أعد تعيين كلمة المرور. |
| `errMaxOneBike` | A rider can only have one bike. | لا يمكن تخصيص أكثر من دراجة واحدة للراكب. |
| `errNoInternet` | You appear to be offline — check your connection and try again. | يبدو أنك غير متصل بالإنترنت — تحقق من الاتصال وحاول مجدداً. |
| `errNotEnoughSpots` | Not enough spots available. | لا توجد مقاعد كافية. |
| `errNoteCustomer` | Who is this note about? | عن مَن هذه الملاحظة؟ |
| `errNoteRequired` | Write a note first. | اكتب الملاحظة أولاً. |
| `errPasswordLen` | Password must be at least 8 characters and include an uppercase letter and a number. | يجب أن تكون كلمة المرور 8 أحرف على الأقل وتحتوي على حرف كبير ورقم. |
| `errPasswordMatch` | Passwords do not match. | كلمتا المرور غير متطابقتين. |
| `errPasswordRequired` | Please enter your password. | الرجاء إدخال كلمة المرور. |
| `errPhoneExists` | An account with this phone number already exists. | يوجد حساب بهذا الرقم مسبقاً. |
| `errPhoneInSession` | This phone number is already registered for that session. | رقم الهاتف مسجّل في هذه الجلسة مسبقاً. |
| `errPhoneRegistered` | Phone already registered. | رقم الهاتف مسجّل مسبقاً. |
| `errPhoneRequired` | Please enter your phone number. | الرجاء إدخال رقم هاتفك. |
| `errPickDate` | Please pick a date. | الرجاء اختيار تاريخ. |
| `errPinWrong` | Incorrect PIN. Try again. | رمز PIN غير صحيح. حاول مجدداً. |
| `errQNumTaken` | That number is already taken by another booking. | هذا الرقم مستخدم بالفعل لحجز آخر. |
| `errResetNoMatch` | That email and phone number do not match an account. | البريد الإلكتروني ورقم الهاتف لا يطابقان أي حساب. |
| `errRiderName` | Please enter rider name. | الرجاء إدخال اسم الراكب. |
| `errRiderPhone` | Please enter phone number. | الرجاء إدخال رقم الهاتف. |
| `errSaveAccount` | Error saving changes. Please try again. | حدث خطأ في الحفظ. حاول مجدداً. |
| `errSelectBike` | Please select a bike. | الرجاء اختيار دراجة. |
| `errSelectGender` | Please select your gender. | الرجاء اختيار جنسك. |
| `errSelectSession` | Please select a session above. | الرجاء اختيار جلسة من الأعلى. |
| `errSelectSizeGeneric` | Please select a frame size. | الرجاء اختيار مقاس الإطار. |
| `errSelectTypeGeneric` | Please select a bike type. | الرجاء اختيار نوع الدراجة. |
| `errServerError` | Server error. | خطأ في الخادم. |
| `errSessionClosed` | That session is no longer open. | هذه الجلسة لم تعد مفتوحة. |
| `errSessionFull` | Session is full. | الجلسة ممتلئة. |
| `errSessionStale` | Your session has expired — please sign in again. | انتهت صلاحية جلستك — يرجى تسجيل الدخول من جديد. |
| `errSomethingWrong` | Something went wrong - it was logged. | حدث خطأ ما - تم تسجيله. |
| `errStaffAuthExpired` | Your staff sign-in has expired. Sign in again, then retry. | انتهت صلاحية تسجيل دخول الموظف. سجّل الدخول مجددًا ثم أعد المحاولة. |
| `errStaffNotAuthorized` | This account is not on the staff list. | هذا الحساب ليس ضمن قائمة الموظفين. |
| `errStockWrite` | Stock for {0} was not saved — the count on screen has been put back. | لم يتم حفظ مخزون {0} — تمت إعادة العدد الظاهر على الشاشة. |
| `errStorageFull` | Device storage is full — free some space; unsynced sales/bookings may not be saved. | ذاكرة الجهاز ممتلئة — أفرغ بعض المساحة؛ قد لا تُحفظ المبيعات/الحجوزات غير المتزامنة. |
| `errValidEmail` | Please enter a valid email address. | الرجاء إدخال بريد إلكتروني صحيح. |
| `errValidHeightCm` | Enter a height between 100 and 250 cm. | أدخل طولاً بين 100 و250 سم. |
| `errValidPhone` | Please enter a valid phone number (at least 8 digits). | الرجاء إدخال رقم هاتف صحيح (٨ أرقام على الأقل). |
| `errValidPrice` | Please enter a valid price (0 or above). | الرجاء إدخال سعر صحيح (صفر أو أكثر). |
| `errWaitlistFull` | The waitlist for this session is full. | قائمة الانتظار لهذه الجلسة ممتلئة. |
| `errWriteDup` | That booking number was just taken by another device. Reload and try again. | تم أخذ رقم الحجز للتو من جهاز آخر. أعد التحميل وحاول مجددًا. |
| `errWritePerm` | That did not save - your staff session may have expired. Unlock again and retry. | لم يتم الحفظ - ربما انتهت جلسة الموظف. أعد فتح القفل ثم حاول مجددًا. |

### `filter*` — 14 keys

| key | English | العربية |
|---|---|---|
| `filterAll` | All | الكل |
| `filterCancelled` | Cancelled | ملغي |
| `filterDone` | Done | منتهي |
| `filterNoshow` | No-Show | لم يحضر |
| `filterOnBike` | On Bike | على الدراجة |
| `filterPaid` | Paid | مدفوع |
| `filterPay` | Pay | الدفع |
| `filterRejected` | Rejected | مرفوض |
| `filterRentalBike` | Rental bike | دراجة مستأجرة |
| `filterSize` | Size | المقاس |
| `filterStatus` | Status | الحالة |
| `filterType` | Type | النوع |
| `filterUnpaid` | Unpaid | غير مدفوع |
| `filterWaiting` | Waiting | بانتظار |

### `fr*` — 16 keys

| key | English | العربية |
|---|---|---|
| `frBikes` | Fleet (Bikes) | الأسطول (الدراجات) |
| `frBikesSub` | All bikes in the fleet | جميع الدراجات في الأسطول |
| `frBookings` | Bookings & Queue | الحجوزات والطابور |
| `frBookingsSub` | All queue entries and ride history | جميع إدخالات الطابور وسجل الرحلات |
| `frChoose` | Choose what to reset: | اختر ما تريد إعادة ضبطه: |
| `frCustomers` | Customers | العملاء |
| `frCustomersSub` | All customer accounts and login data | جميع حسابات العملاء وبيانات الدخول |
| `frDeleteBtn` | Delete Selected Data | حذف البيانات المحددة |
| `frSessions` | Sessions | الجلسات |
| `frSessionsSub` | All created sessions | جميع الجلسات المُنشأة |
| `frTitle` | Factory Reset | إعادة ضبط المصنع |
| `frTypeAfter` | to confirm: | للتأكيد: |
| `frTypeBefore` | Type | اكتب |
| `frWarn1` | This will permanently delete | سيؤدي هذا إلى حذف |
| `frWarn2` | data — bookings, sessions, bikes, and customers. | البيانات نهائياً — الحجوزات والجلسات والدراجات والعملاء. |
| `frWarnAll` | ALL | كل |

### `hist*` — 12 keys

| key | English | العربية |
|---|---|---|
| `histInLabel` | Check-in | الدخول |
| `histLogBtn` | Log | السجل |
| `histMarkSelPaid` | Mark {0} paid | تحديد {0} كمدفوع |
| `histOutLabel` | Check-out | الخروج |
| `histRange30` | Last 30 days | آخر 30 يومًا |
| `histRange7` | Last 7 days | آخر 7 أيام |
| `histRangeLabel` | Range | المدة |
| `histRangeToday` | Today | اليوم |
| `histRemoved` | Removed | محذوف |
| `histRestored` | Restored | مستعاد |
| `histTabRides` | Rides | الرحلات |
| `histWindowNote` | Showing the last 12 months | يعرض آخر 12 شهرًا |

### `inv*` — 33 keys

| key | English | العربية |
|---|---|---|
| `invAddBtn` | + Add item | + إضافة عنصر |
| `invBikesTotal` | Fleet | الأسطول |
| `invBrand` | Brand | العلامة التجارية |
| `invCategory` | Category | الفئة |
| `invCost` | Cost (SAR) | التكلفة (ريال) |
| `invCostHint` | (what you pay — powers margin) | (ما تدفعه — يُحسب منه الربح) |
| `invFlavour` | Flavour | النكهة |
| `invFree` | Free | مجاني |
| `invInStock` | In stock | متوفر |
| `invItemName` | Item | العنصر |
| `invLowAlert` | {0} item(s) need restocking | {0} عنصر بحاجة لإعادة تخزين |
| `invLowAt` | Low-stock at | تنبيه عند |
| `invLowStock` | Low stock | مخزون منخفض |
| `invManageBikes` | Manage in Bikes tab | الإدارة في تبويب الدراجات |
| `invNoBrand` | No brand | بدون علامة |
| `invNoFlavour` | No flavour | بدون نكهة |
| `invNoItems` | No inventory items yet. Add helmets, locks, accessories or spare parts. | لا توجد عناصر بعد. أضف الخوذ والأقفال والإكسسوارات أو قطع الغيار. |
| `invOutStock` | Out of stock | نفد المخزون |
| `invPrice` | Price (SAR) | السعر (ريال) |
| `invProteinType` | Type | النوع |
| `invQty` | In stock | المتوفر |
| `invSaved` | Inventory updated | تم تحديث المخزون |
| `invSearchPh` | Search items… | ابحث عن العناصر… |
| `invSecBikes` | Bikes | الدراجات |
| `invSecEquipment` | Equipment | المعدات |
| `invSecSupplements` | Supplements & Beverages | المكمّلات والمشروبات |
| `invSortCat` | By category | حسب الفئة |
| `invSortSales` | Best sellers | الأكثر مبيعاً |
| `invSortStock` | Lowest stock | الأقل مخزوناً |
| `invSub` | Helmets, accessories and spare-part stock. | الخوذ والإكسسوارات وقطع الغيار. |
| `invTitle` | Inventory | المخزون |
| `invVolumeMl` | Volume (ml) | الحجم (مل) |
| `invVolumeMlPh` | e.g. 500 | مثال: 500 |

### `kb*` — 8 keys

| key | English | العربية |
|---|---|---|
| `kbCheckin` | Check in next rider | تسجيل دخول الراكب التالي |
| `kbCommunity` | Community | المجتمع |
| `kbInventory` | Inventory | المخزون |
| `kbNoWaiting` | No riders waiting | لا يوجد ركاب في الانتظار |
| `kbRefresh` | Refresh now | تحديث الآن |
| `kbSearch` | Search / find a booking | بحث / إيجاد حجز |
| `kbTitle` | Keyboard shortcuts | اختصارات لوحة المفاتيح |
| `kbToggle` | Toggle this help | إظهار/إخفاء المساعدة |

### `land*` — 10 keys

| key | English | العربية |
|---|---|---|
| `landChooseEvent` | Pick your event | اختر فعاليتك |
| `landCommSoon` | Details coming soon | التفاصيل قريبًا |
| `landCommTitle` | Micromobility Experiences | جولات مايكروموبيليتي |
| `landEventCommunity` | Community event | فعالية مجتمعية |
| `landEventRide` | Circuit ride | جولة الحلبة |
| `landEyebrow` | Rides & Events | جولات وفعاليات |
| `landJccCardTitle` | Open Sports Day | يوم الرياضة المفتوح |
| `landJccMeta` | Sun & Tue · 9-11pm | الأحد والثلاثاء · 9-11 مساءً |
| `landJccTitle` | Jeddah Corniche Circuit | حلبة كورنيش جدة |
| `landSessionsOpen` | {0} sessions open | {0} جلسات متاحة |

### `lb*` — 13 keys

| key | English | العربية |
|---|---|---|
| `lbMinutes` | Minutes | الدقائق |
| `lbNewLabel` | new | جديد |
| `lbRankByLabel` | Rank by | الترتيب حسب |
| `lbRidersBooked` | Riders booked | الركّاب المحجوزون |
| `lbScopeOwner` | Booking owners | أصحاب الحجوزات |
| `lbScopeOwnerSub` | Credited for every rider in their bookings | يُحتسب لكل راكب في حجوزاتهم |
| `lbScopeRider` | Riders | الركّاب |
| `lbScopeRiderSub` | Each individual rider | كل راكب على حدة |
| `lbSpent` | Spent | الإنفاق |
| `lbStreakTip` | {0}-week streak | {0} أسابيع متتالية |
| `lbWindowAll` | All-time | كل الأوقات |
| `lbWindowMonth` | This month | هذا الشهر |
| `lbWindowWeek` | This week | هذا الأسبوع |

### `log*` — 29 keys

| key | English | العربية |
|---|---|---|
| `logAcctCreated` | Account created:  | تم إنشاء حساب:  |
| `logAcctCreatedGoogle` | Account created (Google):  | تم إنشاء حساب (جوجل):  |
| `logBookedWord` | Booked | تم الحجز |
| `logBulkCheckin` | Bulk checked in {0} | تسجيل دخول {0} (جماعي) |
| `logBulkPaid` | Bulk marked {0} paid | تعليم {0} كمدفوع (جماعي) |
| `logCatAuth` | Access | الوصول |
| `logCatBike` | Bikes | الدراجات |
| `logCatBook` | Bookings | الحجوزات |
| `logCatInv` | Inventory | المخزون |
| `logCatOther` | Other | أخرى |
| `logCatPay` | Payment | الدفع |
| `logExportedBackup` | Exported data backup | تصدير نسخة احتياطية |
| `logLoggedIn` | Logged in:  | تسجيل الدخول:  |
| `logLoggedOut` | Logged out:  | تسجيل الخروج:  |
| `logOperatorSet` | Operator changed: {0} | تغيير المشغّل: {0} |
| `logOut` | Log Out | تسجيل الخروج |
| `logPrintedReport` | Printed session report | طُبع تقرير الجلسة |
| `logPromotedFromWaitlist` | Promoted #{0} {1} from waitlist | ترقية #{0} {1} من قائمة الانتظار |
| `logPwdResetSelf` | Password reset (self-service):  | إعادة تعيين كلمة المرور (ذاتي):  |
| `logRestoredBooking` | Restored booking | استعادة الحجز |
| `logStaffResetPwd` | Staff reset password for  | الموظف أعاد تعيين كلمة المرور لـ  |
| `logStaffUnlocked` | Staff panel unlocked | تم فتح لوحة الموظفين |
| `logStockAdj` | Stock {0}: {1} | المخزون {0}: {1} |
| `logStockTake` | Stock-take {0}: {1} → {2} | جرد {0}: {1} → {2} |
| `logSwitchedAdmin` | Switched to Admin role | التحويل إلى دور المدير |
| `logToday` | Today | اليوم |
| `logUpdatedBooking` | Updated booking | تحديث الحجز |
| `logWaitlistedWord` | Waitlisted | قائمة الانتظار |
| `logYesterday` | Yesterday | أمس |

### `logs*` — 11 keys

| key | English | العربية |
|---|---|---|
| `logsActivity` | Activity Log | سجل النشاط |
| `logsColAction` | Action | الإجراء |
| `logsColBy` | By | بواسطة |
| `logsColTime` | Time | الوقت |
| `logsEmpty` | No actions logged yet. | لم يتم تسجيل أي إجراءات بعد. |
| `logsExportBtn` | Export CSV | تصدير CSV |
| `logsOperator` | Operator | الموظف |
| `logsOperatorPh` | Your name (tags the audit log) | اسمك (يوسم سجل التدقيق) |
| `logsPermanentNote` | Shared audit trail - actions from every staff device, synced to the database. | سجل تدقيق مشترك - إجراءات كل أجهزة الموظفين، متزامنة مع قاعدة البيانات. |
| `logsSearchPh` | Search actions… | ابحث في الإجراءات… |
| `logsTitle` | Action Log | سجل الإجراءات |

### `mw*` — 17 keys

| key | English | العربية |
|---|---|---|
| `mwAddBtn` | Add | إضافة |
| `mwBrowseBtn` | From bookings | من الحجوزات |
| `mwCustTag` | Customer | عميل |
| `mwEmptyForSess` | Nobody on the list for this session — pick All Sessions to see the rest. | لا أحد في القائمة لهذه الجلسة — اختر كل الجلسات لعرض البقية. |
| `mwFromBookings` | Bookings & waitlist | الحجوزات وقائمة الانتظار |
| `mwFromCustomers` | Saved customers | العملاء المحفوظون |
| `mwHideBtn` | Hide list | إخفاء القائمة |
| `mwMoveBtn` | To staff list | إلى قائمة الموظفين |
| `mwMovedToast` | {0} moved to the staff list | تم نقل {0} إلى قائمة الموظفين |
| `mwNoMatches` | Nobody left to add matches that. | لا يوجد من يمكن إضافته يطابق ذلك. |
| `mwOnlyOpenMsg` | Only a booking that has not ridden yet can go on the staff list. | يمكن إضافة الحجوزات التي لم تبدأ ركوبها فقط إلى قائمة الموظفين. |
| `mwPartyMovedToast` | {0} riders moved to the staff list | تم نقل {0} راكبين إلى قائمة الموظفين |
| `mwRemovePartyBody` | This takes all {0} riders off the staff list. Their bookings are not touched. | سيؤدي هذا إلى إزالة {0} راكبين من قائمة الموظفين. لن تتأثر حجوزاتهم. |
| `mwRidersN` | {0} riders | {0} راكبين |
| `mwSearchPh` | Booking number, name or phone… | رقم الحجز أو الاسم أو الهاتف… |
| `mwSub` | Hand-picked and hand-ordered by staff — drag or use the arrows. | يضيفها ويرتبها الموظفون يدوياً — بالسحب أو بالأسهم. |
| `mwTitle` | Staff Managed Waitlist | قائمة انتظار يديرها الموظفون |

### `na*` — 11 keys

| key | English | العربية |
|---|---|---|
| `naBtn` | New account | حساب جديد |
| `naCreateBtn` | Create account | إنشاء الحساب |
| `naDelBody` | The login, tags, notes and any push subscriptions are removed. {0} past booking(s) stay on record with the rider’s name, so rosters and reports are unchanged. This can be undone from the bar at the top. | سيُحذف تسجيل الدخول والوسوم والملاحظات واشتراكات الإشعارات. تبقى {0} حجوزات سابقة باسم الراكب، فلا تتأثر الكشوف والتقارير. ويمكن التراجع من الشريط في الأعلى. |
| `naDelBtn` | Delete account | حذف الحساب |
| `naDelDone` | {0}’s account deleted | تم حذف حساب {0} |
| `naDelLiveMsg` | This rider has {0} live booking(s). Finish or cancel those first — deleting the account under them leaves a booking nobody can look up. | لدى هذا الراكب {0} حجز/حجوزات قائمة. أنهِها أو ألغِها أولاً — حذف الحساب يترك حجزاً لا يمكن لأحد الوصول إليه. |
| `naDelTitle` | Delete this account | حذف هذا الحساب |
| `naEditTitle` | Edit customer | تعديل العميل |
| `naPwdKeepHint` | leave blank to keep | اتركه فارغًا للإبقاء عليها |
| `naSaveBtn` | Save changes | حفظ التغييرات |
| `naTitle` | Create customer account | إنشاء حساب عميل |

### `no*` — 19 keys

| key | English | العربية |
|---|---|---|
| `noBikes` | No bikes found. Add your first bike above. | لا توجد دراجات. أضف أول دراجة أعلاه. |
| `noBikesForType` | No {0} bikes in the fleet. | لا توجد دراجات من نوع {0} في الأسطول. |
| `noBikesMatchFleet` | No bikes match this session's fleet. | لا توجد دراجات مطابقة لأسطول هذه الجلسة. |
| `noCurrentRides` | No upcoming bookings. Reserve a ride to get started. | لا حجوزات قادمة. احجز رحلة للبدء. |
| `noEmailLabel` | no email | لا بريد إلكتروني |
| `noHistory` | No riders match the current filters. | لا يوجد راكبون يطابقون الفلتر الحالي. |
| `noOtherTypes` | No other types available either. | لا توجد أنواع أخرى متاحة. |
| `noPastRides` | No completed rides yet. | لا توجد رحلات مكتملة بعد. |
| `noRatingsYet` | No ratings collected yet. | لا توجد تقييمات بعد. |
| `noResultsLabel` | No bikes match your search. | لا توجد دراجات تطابق بحثك. |
| `noRiderAssigned` | No rider assigned | لا يوجد راكب |
| `noRides` | No bookings yet. | لا توجد حجوزات بعد. |
| `noSessions` | No sessions are currently open for reservation. Check back soon or contact the team. | لا توجد جلسات مفتوحة للحجز حالياً. تحقق لاحقاً أو تواصل مع الفريق. |
| `noSessionsAvail` | No sessions are available right now. | لا توجد جلسات متاحة الآن. |
| `noSessionsSocial` | Follow us on social media for updates on upcoming sessions! | تابعنا على وسائل التواصل الاجتماعي للاطلاع على الجلسات القادمة! |
| `noSessionsYet` | No sessions yet. Create one above. | لا توجد جلسات بعد. أنشئ واحدة أعلاه. |
| `noShowBtn` | No-Show | لم يحضر |
| `noShowCustomerMsg` | The staff marked you as a No-Show for this session. | تم تسجيلك كغائب في هذه الجلسة من قِبَل الموظفين. |
| `noShowFlagTip` | {0} past no-shows | {0} حالات عدم حضور سابقة |

### `note*` — 19 keys

| key | English | العربية |
|---|---|---|
| `noteAddBtn` | Add note | إضافة ملاحظة |
| `noteBookingChip` | Booking #{0} | حجز #{0} |
| `noteBtn` | Note | ملاحظة |
| `noteCustomerLabel` | Customer | العميل |
| `noteCustomerPh` | Type or pick a name… | اكتب أو اختر اسماً… |
| `noteDeleteBtn` | Delete | حذف |
| `noteDeletedToast` | Note deleted | تم حذف الملاحظة |
| `noteForBooking` | Note · #{0} {1} | ملاحظة · #{0} {1} |
| `notePhonePh` | Phone (optional) | الجوال (اختياري) |
| `noteRecentTitle` | Previous notes for this customer | ملاحظات سابقة لهذا العميل |
| `noteSavedToast` | Note saved | تم حفظ الملاحظة |
| `noteSearchPh` | Search notes by name, phone or text… | ابحث بالاسم أو الجوال أو النص… |
| `noteTextLabel` | Note | الملاحظة |
| `noteTextPh` | e.g. Prefers a low saddle, paid deposit in cash… | مثال: يفضّل مقعداً منخفضاً، دفع العربون نقداً… |
| `noteTypeComment` | Comment | تعليق |
| `noteTypeCustComplaint` | Customer complaint | شكوى من عميل |
| `noteTypeFeedback` | Feedback | ملاحظات وتقييم |
| `noteTypeLabel` | Note type | نوع الملاحظة |
| `noteTypeStaffComplaint` | Staff complaint | شكوى من الموظفين |

### `nu*` — 20 keys

| key | English | العربية |
|---|---|---|
| `nuAddMicro` | Add vitamin / mineral | إضافة فيتامين / معدن |
| `nuButton` | Nutrition | القيمة الغذائية |
| `nuCaffeine` | Caffeine | الكافيين |
| `nuCalories` | Calories | السعرات |
| `nuCarbs` | Carbs | الكربوهيدرات |
| `nuFat` | Fat | الدهون |
| `nuFibre` | Fibre | الألياف |
| `nuIngredients` | Ingredients | المكونات |
| `nuMicroName` | Vitamin / mineral | فيتامين / معدن |
| `nuMicros` | Vitamins & minerals | الفيتامينات والمعادن |
| `nuNrv` | NRV% | NRV% |
| `nuOptional` | optional | اختياري |
| `nuPrefill` | Prefill | تعبئة مسبقة |
| `nuProtein` | Protein | البروتين |
| `nuSalt` | Salt | الملح |
| `nuSatFat` | Saturated fat | الدهون المشبعة |
| `nuServingPh` | e.g. 1 bottle | مثال: زجاجة واحدة |
| `nuSodium` | Sodium | الصوديوم |
| `nuSugar` | Sugars | السكريات |
| `nuTitle` | Nutrition Facts | القيمة الغذائية |

### `ph*` — 8 keys

| key | English | العربية |
|---|---|---|
| `phBikeSearch` | Name, brand, model… | الاسم، العلامة، الطراز… |
| `phCustEmail` | customer@email.com | customer@email.com |
| `phFirstName` | Your first name | اسمك الأول |
| `phFullName` | Your full name | اسمك الكامل |
| `phHeightEg` | e.g. 120 | مثال: 120 |
| `phInvName` | e.g. Medium helmet | مثال: خوذة متوسطة |
| `phLastName` | Your last name | اسم عائلتك |
| `phMiddleName` | Your middle name | اسمك الأوسط |

### `promo*` — 38 keys

| key | English | العربية |
|---|---|---|
| `promoActiveLabel` | Active | مفعّل |
| `promoAddBtn` | + Add code | + إضافة رمز |
| `promoAddedOnly` | Applies to the riders you add in this edit | يُطبَّق على الراكبين الذين تضيفهم في هذا التعديل |
| `promoAllTypes` | All bike types | جميع أنواع الدراجات |
| `promoAnyone` | Anyone | أي شخص |
| `promoAppliedMsg` | {0} applied | تم تطبيق {0} |
| `promoAppliesLabel` | Applies to | يسري على |
| `promoApplyBtn` | Apply | تطبيق |
| `promoCodeLabel` | Code | الرمز |
| `promoCustomerLabel` | One customer only | لعميل واحد فقط |
| `promoDiscountLabel` | Discount | الخصم |
| `promoExpiredLabel` | Expired | منتهٍ |
| `promoExpiredMsg` | That code has expired. | انتهت صلاحية هذا الرمز. |
| `promoExpiresLabel` | Expires | ينتهي في |
| `promoFlatOpt` | Flat (SAR) | مبلغ ثابت (ريال) |
| `promoInactiveLabel` | Inactive | غير مفعّل |
| `promoInvalidMsg` | Invalid or inactive code | رمز غير صالح أو غير مفعّل |
| `promoKindLabel` | Type | النوع |
| `promoLabel` | Promo code | رمز الخصم |
| `promoLimitsLabel` | Limits | الحدود |
| `promoLimitsMissing` | Limit columns missing - run 20260816120000_promo_limits.sql; the code was saved without limits. | أعمدة الحدود غير موجودة - شغّل 20260816120000_promo_limits.sql؛ تم حفظ الرمز بدون حدود. |
| `promoMaxUsesLabel` | Max uses | أقصى عدد استخدامات |
| `promoMgrTitle` | Promo Codes | رموز الخصم |
| `promoNoCodes` | No promo codes yet. | لا توجد رموز خصم بعد. |
| `promoNoSuchCustomer` | No customer with that name. | لا يوجد عميل بهذا الاسم. |
| `promoNotYoursMsg` | That code belongs to another account. | هذا الرمز يخص حسابًا آخر. |
| `promoNudgeMsg` | {0} is next — send them a WhatsApp | {0} هو التالي — أرسل له رسالة واتساب |
| `promoOneCustomer` | One customer | عميل واحد |
| `promoPercentOpt` | Percent (%) | نسبة (%) |
| `promoRemoveBtn` | Remove | إزالة |
| `promoSavedToast` | Promo code saved | تم حفظ رمز الخصم |
| `promoSyncedToast` | {0} live bookings repriced | تم تحديث أسعار {0} من الحجوزات النشطة |
| `promoTypeOnlyMsg` | This code applies only to {0} bookings. | هذا الرمز يسري فقط على حجوزات {0}. |
| `promoUnlimited` | Unlimited | غير محدود |
| `promoUntil` | until {0} | حتى {0} |
| `promoUsedUpLabel` | Used up | استُنفد |
| `promoUsedUpMsg` | That code has been fully used. | تم استخدام هذا الرمز بالكامل. |
| `promoValueLabel` | Value | القيمة |

### `push*` — 10 keys

| key | English | العربية |
|---|---|---|
| `pushBlockedMsg` | Notifications are blocked for this site in your browser settings. | الإشعارات محظورة لهذا الموقع في إعدادات متصفحك. |
| `pushDisableBtn` | Turn off notifications | إيقاف الإشعارات |
| `pushEnableBtn` | Turn on notifications | تفعيل الإشعارات |
| `pushFailedMsg` | Could not turn notifications on. | تعذّر تفعيل الإشعارات. |
| `pushOffToast` | Notifications are off. | تم إيقاف الإشعارات. |
| `pushOnToast` | Notifications are on. | تم تفعيل الإشعارات. |
| `pushPromotedBody` | You are off the waitlist - booking #{0} is confirmed. See you at the booth. | خرجت من قائمة الانتظار - تم تأكيد الحجز رقم {0}. نراك في الكشك. |
| `pushPromotedTitle` | A spot opened up | توفّر مكان |
| `pushSub` | Get told the moment a spot opens up for you, even when this page is closed. | نُعلمك فور توفّر مكان لك، حتى لو كانت الصفحة مغلقة. |
| `pushTitle` | Notifications | الإشعارات |

### `rate*` — 13 keys

| key | English | العربية |
|---|---|---|
| `rateBikeLabel` | Bike | الدراجة |
| `rateExpLabel` | Experience | التجربة |
| `rateForcedHint` | Please rate your ride to help us improve. | يرجى تقييم رحلتك لمساعدتنا على التحسين. |
| `rateLaterBtn` | Later | لاحقاً |
| `rateNoteLabel` | Comments (optional) | ملاحظات (اختياري) |
| `rateReasonHint` | You rated below 10 - please tell us why. | قيّمت أقل من 10 - يرجى إخبارنا بالسبب. |
| `rateReasonLabel` | What could be better? | ما الذي يمكن تحسينه؟ |
| `rateReasonRequired` | Please tell us what could be better before submitting. | يرجى إخبارنا بما يمكن تحسينه قبل الإرسال. |
| `rateRequiredScore` | Please give a rating before submitting. | يرجى إعطاء تقييم قبل الإرسال. |
| `rateRideBtn` | Rate your ride | قيّم رحلتك |
| `rateSubmitBtn` | Submit rating | إرسال التقييم |
| `rateThanks` | Thanks for the feedback! | شكراً لتقييمك! |
| `rateTitle` | How was your ride? | كيف كانت رحلتك؟ |

### `receipt*` — 10 keys

| key | English | العربية |
|---|---|---|
| `receiptBtn` | Receipt | الإيصال |
| `receiptDateLabel` | Issued | تاريخ الإصدار |
| `receiptDear` | Dear | عزيزي |
| `receiptEditTitle` | Edit receipt | تعديل الفاتورة |
| `receiptPaidLabel` | Payment | الدفع |
| `receiptPrintBtn` | Print / Save as PDF | طباعة / حفظ PDF |
| `receiptRefLabel` | Booking ref | رقم الحجز |
| `receiptSeeYou` | We hope to see you at the Corniche Circuit again soon! | نأمل رؤيتك في حلبة الكورنيش مجدداً! |
| `receiptThankYou` | Thank you for riding with us at the Jeddah Corniche Circuit! | شكراً لركوبك معنا في حلبة كورنيش جدة! |
| `receiptTitle` | Ride Receipt | إيصال الرحلة |

### `reg*` — 16 keys

| key | English | العربية |
|---|---|---|
| `regBackBtn` | Back | رجوع |
| `regBookAnotherBtn` | Book another ride | حجز رحلة أخرى |
| `regConfirmBtn` | Confirm booking | تأكيد الحجز |
| `regContinueBtn` | Continue | متابعة |
| `regProg1` | Session | الجلسة |
| `regProg2` | Riders | الركّاب |
| `regProg3` | Confirm | التأكيد |
| `regReviewBtn` | Review booking | مراجعة الحجز |
| `regStep1Msg` | Pick the day you would like to ride. | اختر اليوم الذي ترغب بالركوب فيه. |
| `regStep1Title` | Choose your session | اختر جلستك |
| `regStep2Msg` | Tell us who is riding and their bike preference. | أخبرنا من سيركب وتفضيل الدراجة. |
| `regStep2Title` | Rider details | بيانات الراكب |
| `regStep3Msg` | Check everything below, then confirm your booking. | تحقق من التفاصيل أدناه ثم أكّد حجزك. |
| `regStep3Title` | Review & confirm | المراجعة والتأكيد |
| `regSub` | Pick an available session, fill in your details, and join the queue. | اختر جلسة متاحة، أدخل بياناتك، وانضم إلى الطابور. |
| `regTitle` | Reserve Your Spot | احجز دراجتك |

### `rep*` — 34 keys

| key | English | العربية |
|---|---|---|
| `repAddon` | Add-on | الإضافة |
| `repAddonValue` | Add-on value | قيمة الإضافات |
| `repAddonsSold` | Add-ons sold | الإضافات المُباعة |
| `repBikesRented` | Bikes rented by type | الدراجات المؤجّرة حسب النوع |
| `repBookings` | Bookings | الحجوزات |
| `repBrand` | Brand | العلامة التجارية |
| `repColEmail` | Email | البريد الإلكتروني |
| `repColPhone` | Phone | الهاتف |
| `repColType` | Type | النوع |
| `repGeneratedAt` | Generated | أُنشئ |
| `repHeightCol` | Height (cm) | الطول (سم) |
| `repHeightIndividual` | Individually | فرديًّا |
| `repHeightRanges` | Ranges | النطاقات |
| `repHeightSummary` | Summary | ملخّص |
| `repMax` | Tallest | الأطول |
| `repMin` | Shortest | الأقصر |
| `repNo` | No | لا |
| `repNoHeight` | No heights recorded | لا توجد أطوال مسجّلة |
| `repOptCols` | Columns | الأعمدة |
| `repOptFilters` | Filters | عوامل التصفية |
| `repOptNone` | Pick at least one column. | اختر عموداً واحداً على الأقل. |
| `repOptReset` | Reset | إعادة تعيين |
| `repOptSections` | Sections | الأقسام |
| `repOptSummary` | Summary tiles | بطاقات الملخص |
| `repPayPartial` | Partial | مدفوع جزئياً |
| `repPreparedBy` | Prepared by | أعدّه |
| `repPriceSar` | Price (SAR) | السعر (SAR) |
| `repPrintNow` | Print | طباعة |
| `repReviewedBy` | Reviewed by | راجعه |
| `repRiderHeights` | Rider heights | أطوال الركّاب |
| `repTotal` | Total | الإجمالي |
| `repValueSar` | Value (SAR) | القيمة (SAR) |
| `repVatIncl` | VAT (15%) incl. | شامل ضريبة القيمة المضافة (15%) |
| `repYes` | Yes | نعم |

### `scan*` — 13 keys

| key | English | العربية |
|---|---|---|
| `scanAlreadyActive` | #{0} {1} is already on a bike. | #{0} {1} على الدراجة بالفعل. |
| `scanBtn` | Scan ticket | مسح التذكرة |
| `scanCamDenied` | Camera access was denied. Allow camera permission and try again. | تم رفض الوصول إلى الكاميرا. اسمح باستخدام الكاميرا وحاول مجدداً. |
| `scanCamError` | Could not start the camera on this device. | تعذر تشغيل الكاميرا على هذا الجهاز. |
| `scanCancelled` | This booking was cancelled. | تم إلغاء هذا الحجز. |
| `scanContBtn` | Keep scanning | متابعة المسح |
| `scanDone` | #{0} {1} already completed this ride. | #{0} {1} أنهى الرحلة بالفعل. |
| `scanFound` | Found #{0} {1} - opening check-in. | تم العثور على #{0} {1} - جارٍ فتح تسجيل الدخول. |
| `scanHint` | Point the camera at the QR code on the customer's ticket. | وجّه الكاميرا نحو رمز QR في تذكرة العميل. |
| `scanNoshow` | This booking was marked as a no-show. | هذا الحجز مسجل كغياب. |
| `scanNotFound` | No booking matches this code. | لا يوجد حجز مطابق لهذا الرمز. |
| `scanTally` | {0} checked in | تم تسجيل {0} |
| `scanTitle` | Scan booking QR | مسح رمز الحجز |

### `sess*` — 28 keys

| key | English | العربية |
|---|---|---|
| `sessAllFull` | All sessions are fully booked right now. Check back soon or follow us for new dates. | جميع الجلسات محجوزة بالكامل حالياً. تحقق لاحقاً أو تابعنا لمعرفة المواعيد الجديدة. |
| `sessBackList` | All sessions | كل الجلسات |
| `sessBfMapLabel` | Breakfast location (Google Maps link) | موقع الفطور (رابط خرائط جوجل) |
| `sessBfNameLabel` | Breakfast spot | مكان الفطور |
| `sessBfNamePh` | e.g. Brew92 | مثال: Brew92 |
| `sessClosed` | Session closed. | تم إغلاق الجلسة. |
| `sessDeleted` | Session deleted. | تم حذف الجلسة. |
| `sessDeletedGroup` | Deleted Sessions | الجلسات المحذوفة |
| `sessEventCommHint` | Private event: only tagged riders can see or book it. Reservations need staff approval, and queue order stays staff-only. | فعالية خاصة: يراها ويحجزها الحاصلون على الوسم فقط. تحتاج الحجوزات موافقة الموظفين، ويبقى ترتيب الطابور للموظفين فقط. |
| `sessEventLabel` | Event | الفعالية |
| `sessEventPaidHint` | Bike rental for community members only. A circuit session in every other way: same bike composition, same prices, same waitlist once the bikes run out — and no approval step. | تأجير دراجات لأعضاء المجتمع فقط. وهي في كل ما عداه جلسة حلبة: نفس تشكيلة الدراجات ونفس الأسعار ونفس قائمة الانتظار عند نفادها، وبلا موافقة مسبقة. |
| `sessGatherTime` | Gathering time | وقت التجمع |
| `sessMapLabel` | Meeting point (Google Maps link) | نقطة التجمع (رابط خرائط جوجل) |
| `sessMapPh` | Paste a Google Maps link | الصق رابط خرائط جوجل |
| `sessModeCounts` | Bike Counts | أعداد الدراجات |
| `sessModeFleet` | From Fleet | من الأسطول |
| `sessModeTotal` | Total Bikes | إجمالي الدراجات |
| `sessNoRiders` | No bookings in this session yet. | لا توجد حجوزات في هذه الجلسة بعد. |
| `sessOpened` | Session opened. | تم فتح الجلسة. |
| `sessRestored` | Session restored. | تم استعادة الجلسة. |
| `sessRideNameHint` | riders see this on the session card | يظهر للراكبين على بطاقة الجلسة |
| `sessRideNameLabel` | Ride name | اسم الجولة |
| `sessRidersTitle` | Bookings | الحجوزات |
| `sessSelectMsg` | Select a session to see its details and bookings. | اختر جلسة لعرض تفاصيلها وحجوزاتها. |
| `sessShowLess` | Show less | عرض أقل |
| `sessShowMore` | Show {0} more | عرض {0} أخرى |
| `sessSpotsLabel` | Spots | المقاعد |
| `sessStartTime` | Start time | وقت الانطلاق |

### `sort*` — 11 keys

| key | English | العربية |
|---|---|---|
| `sortBy` | Sort by | ترتيب حسب |
| `sortDateAsc` | Date ↑ | التاريخ ↑ |
| `sortDateDesc` | Date ↓ | التاريخ ↓ |
| `sortName` | Name | الاسم |
| `sortNewest` | Newest | الأحدث |
| `sortOldest` | Oldest | الأقدم |
| `sortSARHi` | SAR High | الأعلى سعراً |
| `sortSARLo` | SAR Low | الأقل سعراً |
| `sortSize` | Size | المقاس |
| `sortStatus` | Status | الحالة |
| `sortType` | Type | النوع |

### `staff*` — 20 keys

| key | English | العربية |
|---|---|---|
| `staffAccess` | Staff Access | دخول الموظفين |
| `staffAuthBtn` | Sign in | تسجيل الدخول |
| `staffAuthEmailPh` | Email or phone number | البريد الإلكتروني أو رقم الهاتف |
| `staffAuthHint` | Sign in with your staff account to unlock the panel | سجّل الدخول بحساب الموظف لفتح اللوحة |
| `staffAuthPwdPh` | Password | كلمة المرور |
| `staffAuthTitle` | Staff sign-in | تسجيل دخول الموظفين |
| `staffBadge` | Staff Panel | لوحة الموظفين |
| `staffPwdDone` | Password updated ✓ | تم تحديث كلمة المرور ✓ |
| `staffPwdHint` | Set a new password for your staff account. | عيّن كلمة مرور جديدة لحساب الموظف. |
| `staffPwdLog` | Changed own staff password | غيّر كلمة مرور حسابه |
| `staffPwdMustHint` | Welcome! For security, set your own password before using the panel. | مرحباً! للأمان، عيّن كلمة المرور الخاصة بك قبل استخدام اللوحة. |
| `staffPwdTitle` | Change my password | تغيير كلمة المرور |
| `staffQueueTitle` | Staff Panel | لوحة الموظفين |
| `staffResetDesc` | Set a new password for a customer who is locked out. | عيّن كلمة مرور جديدة لعميل لا يستطيع الدخول. |
| `staffResetDone` | Password reset for {0}. | تمت إعادة تعيين كلمة المرور لـ {0}. |
| `staffResetEmailLabel` | Customer Email | بريد العميل الإلكتروني |
| `staffResetGiveMsg` | Give them this temporary password: | أعطه كلمة المرور المؤقتة هذه: |
| `staffResetNewPw` | New Password | كلمة المرور الجديدة |
| `staffResetSet` | Set Password | تعيين كلمة المرور |
| `staffResetTool` | Reset Customer Password | إعادة تعيين كلمة مرور العميل |

### `stat*` — 9 keys

| key | English | العربية |
|---|---|---|
| `statCompleted` | Completed | مكتمل |
| `statExpected` | Expected | متوقّع |
| `statFavType` | Favourite Type | النوع المفضل |
| `statMemberSince` | Member Since | عضو منذ |
| `statNextRide` | Next Ride | الرحلة القادمة |
| `statNumRiders` | # of Riders | عدد الركّاب |
| `statStreak` | Week Streak | أسابيع متتالية |
| `statTotalRides` | Total Rides | مجموع الرحلات |
| `statTotalSpent` | Total Spent | إجمالي الإنفاق |

### `status*` — 9 keys

| key | English | العربية |
|---|---|---|
| `statusActive` | On Bike | على الدراجة |
| `statusCancelled` | Cancelled by Customer | ملغي من قِبَل العميل |
| `statusClosed` | Closed | مغلق |
| `statusDone` | Complete | مكتمل |
| `statusFull` | Fully Booked | محجوز بالكامل |
| `statusNoshow` | No-Show | لم يحضر |
| `statusOpen` | Open | مفتوح |
| `statusWaiting` | Waiting | بانتظار |
| `statusWaitlist` | Waitlist | قائمة الانتظار |

### `tab*` — 14 keys

| key | English | العربية |
|---|---|---|
| `tabAccount` | My Account | حسابي |
| `tabAnalytics` | Analytics | التحليلات |
| `tabBikes` | Bikes | الدراجات |
| `tabCashier` | Sales | المبيعات |
| `tabCommunity` | Community | المجتمع |
| `tabDashboard` | Dashboard | لوحة القيادة |
| `tabHistory` | History | السجل |
| `tabInventory` | Inventory | المخزون |
| `tabLogs` | Logs | السجلات |
| `tabMyRides` | My Bookings | حجوزاتي |
| `tabNotes` | Notes | ملاحظات |
| `tabQueue` | Queue | الطابور |
| `tabReserve` | Reserve | حجز |
| `tabSessions` | Sessions | الجلسات |

### `tag*` — 21 keys

| key | English | العربية |
|---|---|---|
| `tagAddTitle` | Add tag | إضافة وسم |
| `tagDatesLabel` | Start & end date | تاريخ البداية والنهاية |
| `tagDur1d` | 1 day | يوم واحد |
| `tagDur1m` | 1 month | شهر |
| `tagDur1w` | 1 week | أسبوع |
| `tagDur1y` | 1 year | سنة |
| `tagDur2w` | 2 weeks | أسبوعان |
| `tagDur3d` | 3 days | 3 أيام |
| `tagDur3m` | 3 months | 3 أشهر |
| `tagDur6m` | 6 months | 6 أشهر |
| `tagDurationLabel` | Duration | المدة |
| `tagEndAfterStart` | The end date must be after the start date. | يجب أن يكون تاريخ النهاية بعد تاريخ البداية. |
| `tagEndDate` | End date | تاريخ النهاية |
| `tagEndRequired` | Choose an end date. | اختر تاريخ النهاية. |
| `tagExpired` | expired | منتهٍ |
| `tagFrom` | from {0} | من {0} |
| `tagPermLabel` | Permanent | دائم |
| `tagStartDate` | Start date | تاريخ البداية |
| `tagTempLabel` | Temporary | مؤقت |
| `tagTodayLabel` | Today | اليوم |
| `tagUntil` | until {0} | حتى {0} |

### `toast*` — 40 keys

| key | English | العربية |
|---|---|---|
| `toastAccountCreated` | Account created. | تم إنشاء الحساب. |
| `toastActionUndone` | Action undone:  | تم التراجع عن الإجراء:  |
| `toastAddedToFleet` | added to fleet. | أُضيفت للأسطول. |
| `toastAssignedChecked` | assigned. Rider checked in! | تم تخصيصها. دخول الراكب مسجَّل! |
| `toastBikeChanged` | Bike changed successfully. | تم تغيير الدراجة بنجاح. |
| `toastBikeRemoved` | removed. | تم إزالتها. |
| `toastBikeReturned` | Bike returned. Ride complete. | الدراجة مُعادة. اكتملت الرحلة. |
| `toastBikeReturnedPaid` | Bike returned and marked as paid. | الدراجة مُعادة وتم تسجيل الدفع. |
| `toastBikeUpdated` | Bike updated. | تم تحديث الدراجة. |
| `toastBookingCancelled` | Booking cancelled. Your spot has been freed. | تم إلغاء الحجز. أُفرج عن دراجتك. |
| `toastBookingCancelledSpot` | Booking cancelled. Your spot has been freed. | تم إلغاء الحجز. أُفرج عن دراجتك. |
| `toastBookingRestored` | Booking restored | تمت استعادة الحجز |
| `toastBookingUpdated` | Your booking has been updated. | تم تحديث حجزك بنجاح. |
| `toastCannotCancel` | Cannot cancel this entry. | لا يمكن إلغاء هذا الحجز. |
| `toastConnStale` | Connection error — data may be stale | خطأ في الاتصال — قد تكون البيانات قديمة |
| `toastLoggedOut` | Logged out successfully. | تم تسجيل الخروج بنجاح. |
| `toastNoExport` | No bookings to export | لا توجد حجوزات للتصدير |
| `toastNoShow` | Marked as No-Show. | تم تسجيله كغائب. |
| `toastNothingUndo` | Nothing to undo | لا شيء للتراجع عنه |
| `toastPriceSet` | Price set to SAR {0} | تم تعيين السعر على {0} ريال |
| `toastPromoted` | Promoted from waitlist | تمت الترقية من قائمة الانتظار |
| `toastPwReset` | Password reset successfully! | تم إعادة تعيين كلمة المرور بنجاح! |
| `toastRecurringCreated` | {0} sessions created | تم إنشاء {0} جلسات |
| `toastRegistered` | Registered! Queue number | مُسجَّل! رقم الطابور |
| `toastRegisteredRange` | Registered! Queue numbers | مُسجَّل! أرقام الطابور |
| `toastReopened` | Booking re-opened - rider moved back to active. | تم إعادة فتح الحجز - الراكب عاد إلى الحالة النشطة. |
| `toastRescheduled` | Booking moved to the new session ✓ | تم نقل الحجز إلى الجلسة الجديدة ✓ |
| `toastResetComplete` | Reset complete. | اكتملت إعادة الضبط. |
| `toastResetFailed` | Reset failed:  | فشلت إعادة الضبط:  |
| `toastRiderRemoved` | Rider removed. | تم حذف الراكب. |
| `toastSessionReady` | Open it when ready. | افتحها عند الاستعداد. |
| `toastSessionUpdated` | Session {0} updated. | تم تحديث جلسة {0}. |
| `toastStaffPanel` | Welcome to the Staff Panel. | مرحباً بك في لوحة الموظفين. |
| `toastStatusChanged` | Status updated: | تم تحديث الحالة: |
| `toastUndoCheckin` | Check-in reversed - rider moved back to waiting. | تم التراجع عن تسجيل الدخول - الراكب عاد إلى قائمة الانتظار. |
| `toastUndoFailedData` | Undo failed. Data may have changed. | فشل التراجع. ربما تغيّرت البيانات. |
| `toastUndoNoShow` | Restored to waiting queue. | تمت إعادته لقائمة الانتظار. |
| `toastWaitlisted` | Added to the waitlist | تمت إضافتك إلى قائمة الانتظار |
| `toastWalkInAdded` | Walk-in added | تمت إضافة زيارة مباشرة |
| `toastWelcomeBack` | Welcome back | مرحباً بعودتك |

### `type*` — 11 keys

| key | English | العربية |
|---|---|---|
| `typeAny` | Any | أي نوع |
| `typeGravel` | Gravel | حصى |
| `typeHybrid` | Hybrid | هجين |
| `typeMountain` | Mountain | جبلي |
| `typeNewLabel` | Type new value... | اكتب قيمة جديدة... |
| `typeOwn` | Bike owner | صاحب دراجة |
| `typeOwnPref` | I have my own bike | لدي دراجتي الخاصة |
| `typePrefHint` | We'll pre-select this each time you book. | سيتم اختياره تلقائياً عند كل حجز. |
| `typePrefSaved` | Type preference saved. | تم حفظ تفضيل النوع. |
| `typeRoad` | Road | طريق |
| `typeRoadCarbon` | Road Carbon | طريق كربون |

### `undo*` — 30 keys

| key | English | العربية |
|---|---|---|
| `undoAddBike` | Add bike | إضافة دراجة |
| `undoBarMsg` | Action undone in | تم التراجع خلال |
| `undoBtn` | Undo | تراجع |
| `undoCancelBooking` | Cancel booking | إلغاء الحجز |
| `undoChangeBike` | Change bike | تغيير الدراجة |
| `undoCheckin` | Check-in | تسجيل دخول |
| `undoCheckinBtn` | Undo Check-in | تراجع عن تسجيل الدخول |
| `undoDeleteBike` | Delete bike | حذف دراجة |
| `undoDeleteNote` | Delete note | حذف ملاحظة |
| `undoEditBike` | Edit bike | تعديل دراجة |
| `undoEditBooking` | Edit booking | تعديل الحجز |
| `undoEditPrice` | Edit price | تعديل السعر |
| `undoEditSession` | Edit session | تعديل الجلسة |
| `undoFailed` | Undo failed. | فشل التراجع. |
| `undoNoShow` | No-show | عدم حضور |
| `undoPayment` | Payment | الدفع |
| `undoPromote` | Promote | الترقية |
| `undoRelease` | Release | تحرير |
| `undoRenumber` | Renumber | إعادة ترقيم |
| `undoReopen` | Re-open | إعادة فتح |
| `undoRestoreBike` | Restore | استعادة |
| `undoRetire` | Retire | سحب |
| `undoReturn` | Return | إرجاع |
| `undoRevBody` | This will reverse the action. Some operations may not be fully reversible if data has changed since. | سيؤدي هذا إلى عكس الإجراء. قد لا تكون بعض العمليات قابلة للعكس بالكامل إذا تغيّرت البيانات. |
| `undoSeconds` | s | ث |
| `undoSessionStatus` | Session | الجلسة |
| `undoStaffCancel` | Staff cancel | إلغاء بواسطة الموظف |
| `undoUndoCheckin` | Undo check-in | تراجع عن تسجيل الدخول |
| `undoUndoNoShow` | Undo no-show | تراجع عن عدم الحضور |
| `undoWl` | Back on the waitlist | إعادة إلى قائمة الانتظار |

### `wl*` — 18 keys

| key | English | العربية |
|---|---|---|
| `wlAddBtn` | Add to waitlist | إضافة إلى القائمة |
| `wlAddedToast` | {0} added to the waitlist | تمت إضافة {0} إلى قائمة الانتظار |
| `wlAvailNow` | {0} available now | {0} متاحة الآن |
| `wlCapCount` | Number | عدد |
| `wlCapHint` | How many riders may wait for a spot once the session is full. Leave blank or 0 for no limit; a percentage is taken from the session capacity. | عدد المشاركين المسموح لهم بالانتظار بعد اكتمال الجلسة. اتركه فارغاً أو 0 لعدم وضع حد؛ تُحتسب النسبة من سعة الجلسة. |
| `wlCapLabel` | Waitlist limit | حد قائمة الانتظار |
| `wlCapNone` | Unlimited | بلا حد |
| `wlCapPct` | Percent | نسبة |
| `wlEmpty` | Nobody is waiting. | لا يوجد أحد في الانتظار. |
| `wlGivenBtn` | Bike given | تم تسليم الدراجة |
| `wlGivenToast` | Bike given to {0} | تم تسليم الدراجة إلى {0} |
| `wlHistTitle` | Waitlist history | سجل قائمة الانتظار |
| `wlPosMsg` | You are W{0} in line for a spot. We will let you know if one frees up — you can still come and ask at the booth. | أنت رقم W{0} في انتظار مقعد. سنخبرك إذا توفّر مقعد، ويمكنك أيضاً السؤال في الكشك. |
| `wlPosNoNumMsg` | You are in line for a spot. We will let you know if one frees up — you can still come and ask at the booth. | أنت في انتظار مقعد. سنخبرك إذا توفّر مقعد، ويمكنك أيضاً السؤال في الكشك. |
| `wlRemoveBtn` | Remove | إزالة |
| `wlRemovedToast` | Removed from the waitlist | تمت الإزالة من قائمة الانتظار |
| `wlTitle` | Waitlist | قائمة الانتظار |
| `wlWaitingFor` | waiting {0} | في الانتظار منذ {0} |

### Other — 465 keys

| key | English | العربية |
|---|---|---|
| `accountSaved` | Profile updated successfully. | تم تحديث الملف الشخصي. |
| `accountSub` | Update your profile information and preferences. | تحديث معلومات ملفك الشخصي. |
| `accountTitle` | Account Settings | إعدادات الحساب |
| `activeSessChip` | on bike | على الدراجة |
| `addonAddBtn` | Add-ons | الإضافات |
| `addonEditTitle` | Edit add-ons | تعديل الإضافات |
| `addonNone` | No add-ons available for this session. | لا توجد إضافات متاحة لهذه الجلسة. |
| `addonStepSub` | Optional extras available for this session | إضافات اختيارية متاحة لهذه الجلسة |
| `addonStepTitle` | Add on your booking | أضف إلى حجزك |
| `addonsLabel` | Add-ons | الإضافات |
| `addonsSelectedToast` | Add-ons saved with your booking | تم حفظ الإضافات مع حجزك |
| `adminOnlyMsg` | Admin only. | للمدير فقط. |
| `aheadOfYou` | {0} ahead of you | {0} أمامك |
| `allBranchesLabel` | All branches | كل الفروع |
| `allSessions` | All Sessions | جميع الجلسات |
| `allSizes` | All sizes | كل المقاسات |
| `altBadge` | Alt | بديل |
| `appSub` | Rental and Inventory System | نظام التأجير والمخزون |
| `assignBikeCheckin` | Assign Bike & Check In | تخصيص دراجة وتسجيل الدخول |
| `assignBikeTitle` | Assign Bike | تخصيص دراجة |
| `assignedBikeLabel` | Assigned Bike | الدراجة المخصصة |
| `autoLabel` | auto | تلقائي |
| `availLabel` | Available | متاح |
| `availSessions` | Available Sessions | الجلسات المتاحة |
| `available2` | available | متاح |
| `backToLogin` | Back to login | العودة لتسجيل الدخول |
| `beAddRiderBtn` | Add rider | إضافة راكب |
| `beAddRidersLabel` | Add riders | إضافة رُكّاب |
| `beRemoveRider` | Remove rider | إزالة الراكب |
| `beRiderPh` | Rider name | اسم الراكب |
| `beRidersAdded` | rider(s) added | رُكّاب أُضيفوا |
| `bfNewOpt` | + New breakfast spot… | + موقع فطور جديد… |
| `bfNoneOpt` | - none - | - بدون - |
| `bikesTitle` | Fleet | الأسطول |
| `bikesWord` | bikes | دراجات |
| `birthDateLabel` | Birth date | تاريخ الميلاد |
| `bookAgainBtn` | Book again | احجز مجدداً |
| `bookUsualBtn` | Book my usual | احجز المعتاد |
| `bookUsualToast` | Pre-filled your usual booking - just confirm. | تم تجهيز حجزك المعتاد - أكّد فقط. |
| `bookedByLabel` | Booked by | حجز بواسطة |
| `branchLabel` | Branch | الفرع |
| `breakfastLbl` | Breakfast | الفطور |
| `breakfastSpotLbl` | Breakfast spot | موقع الفطور |
| `bulkCheckinBtn` | Check in | تسجيل الدخول |
| `bulkClearSel` | Clear | مسح |
| `bulkPaidBtn` | Mark paid | تحديد كمدفوع |
| `bulkSelectedLabel` | selected | محدد |
| `byGuest` | Guest | زائر |
| `byStaff` | Staff | موظف |
| `callLabel` | Call | اتصال |
| `cancelledAdminNote` | Cancelled by customer | ملغى من قِبَل العميل |
| `capacityLabel` | Capacity (spots) | الطاقة الاستيعابية |
| `cashierAddBtn` | Add purchase | إضافة عملية بيع |
| `cashierSub` | Items sold with this rental | العناصر المباعة مع هذا الإيجار |
| `cashierTitle` | Sales | المبيعات |
| `changeBikeBtn` | Change Bike | تغيير الدراجة |
| `changeBikeTitle` | Change Assigned Bike | تغيير الدراجة المخصصة |
| `changeInAccount` | Change in Account | تغيير في الحساب |
| `checkInBtn` | Check In | تسجيل الدخول |
| `cityLabel` | City | المدينة |
| `clearWord` | Clear | مسح |
| `cloneSessBtn` | Clone | نسخ |
| `closeBtn` | Close | إغلاق |
| `closeWord` | Close | إغلاق |
| `closeoutBtn` | Close-out | إغلاق اليوم |
| `closeoutTitle` | Day close-out | تقرير إغلاق اليوم |
| `cmUnit` | cm | سم |
| `coGrand` | Grand total | الإجمالي الكلي |
| `coReconOff` | Unaccounted | غير محتسب |
| `coReconOk` | Card + cash balances | البطاقة + النقد متوازنان |
| `coRentals` | Bike rentals | تأجير الدراجات |
| `coSales` | Product sales | مبيعات المنتجات |
| `colorNameLabel` | Color Name | اسم اللون |
| `colorWord` | Color | اللون |
| `colorsHint` | 1 required - up to 4 | مطلوب 1 - حتى 4 |
| `comfortableTip` | Comfortable | مريح |
| `compactTip` | Compact | مدمج |
| `completedLabel` | Completed | مكتملة |
| `contactNameLabel` | Contact name | اسم جهة الاتصال |
| `continueApple` | Continue with Apple | المتابعة عبر Apple |
| `continueGoogle` | Continue with Google | المتابعة عبر جوجل |
| `countryLabel` | Country | الدولة |
| `createSession` | Create Session | إنشاء جلسة |
| `customWord` | Custom | مخصص |
| `customerBadge` | Customer | عميل |
| `customerShowedBtn` | Customer Showed | العميل حضر |
| `dateLabel` | Date | التاريخ |
| `dateWarning` | Changing the date will update all existing bookings for this session. | تغيير التاريخ سيحدّث جميع الحجوزات الموجودة لهذه الجلسة. |
| `daysLabel` | days | يوم |
| `defPayNormal` | Normal | عادي |
| `defaultPayLabel` | Default payment | الدفع الافتراضي |
| `deleteBtn` | Delete | حذف |
| `doneBtn` | Done | تم |
| `doneSessChip` | done | منتهٍ |
| `doneStat` | Done | منتهٍ |
| `dueWord` | due | مستحق |
| `emailAddr` | Email Address | البريد الإلكتروني |
| `enterEmail` | Enter your email address | أدخل بريدك الإلكتروني |
| `enterEmailOrPhone` | Enter your email or phone number | أدخل بريدك الإلكتروني أو رقم هاتفك |
| `enterHeightAbove` | Enter height above | أدخل الطول أعلاه |
| `enterPhone` | Enter your phone number | أدخل رقم هاتفك |
| `eqnGroup` | Group of {0} bikes | مجموعة من {0} دراجات |
| `eqnNewNum` | New Booking Number | رقم الحجز الجديد |
| `eqnTitle` | Edit Booking Number | تعديل رقم الحجز |
| `evJccName` | Jeddah Corniche Circuit | حلبة كورنيش جدة |
| `evPetroName` | Petromin's Wednesdays | أربعاء بترومين |
| `evSatName` | Saturday Social Ride | جولة السبت الاجتماعية |
| `expChoose` | Choose a format | اختر الصيغة |
| `expExcel` | Excel (CSV) | إكسل (CSV) |
| `expPdf` | PDF / Print | PDF / طباعة |
| `expTitle` | Export Report | تصدير التقرير |
| `exportBackupBtn` | Export backup | تصدير نسخة احتياطية |
| `exportBtn` | Export CSV | تصدير CSV |
| `exportedToast` | Backup downloaded | تم تنزيل النسخة الاحتياطية |
| `finishBtn` | Finish | إنهاء |
| `firstName` | First Name | الاسم الأول |
| `fixDupBody` | Found {0} duplicate booking number(s). Each duplicate will get a fresh unique number (the earliest booking keeps its number). Continue? | تم العثور على {0} رقم حجز مكرر. سيحصل كل مكرر على رقم فريد جديد (يحتفظ الحجز الأقدم برقمه). متابعة؟ |
| `fixDupBtn` | Fix duplicate numbers | إصلاح الأرقام المكررة |
| `fixDupConfirm` | Renumber duplicates | إعادة ترقيم المكررات |
| `fixDupDone` | Renumbered {0} booking(s). | تمت إعادة ترقيم {0} حجز. |
| `fixDupLog` | Fixed {0} duplicate booking number(s) | إصلاح {0} رقم حجز مكرر |
| `fixDupNone` | No duplicate booking numbers found. | لا توجد أرقام حجوزات مكررة. |
| `fixDupTitle` | Fix duplicate booking numbers | إصلاح أرقام الحجوزات المكررة |
| `fleetBadge` | Fleet | الأسطول |
| `footerCopy` | © 2026 MicroMobility. All Rights Reserved | © 2026 مايكروموبيليتي. جميع الحقوق محفوظة |
| `forgotContactStaffMsg` | To reset your password, please visit a staff member at the Corniche Circuit booth. They will reset it for you. | لإعادة تعيين كلمة المرور، يرجى زيارة أحد الموظفين في كشك حلبة الكورنيش. سيقوم بإعادة تعيينها لك. |
| `forgotPwLink` | Forgot password? | نسيت كلمة المرور؟ |
| `forgotStep1Sub` | Verify your identity with your registered email and phone number, then set a new password. | تحقق من هويتك ببريدك الإلكتروني ورقم هاتفك المسجّلين، ثم عيّن كلمة مرور جديدة. |
| `forgotStep1Title` | Reset Your Password | إعادة تعيين كلمة المرور |
| `forgotStep2Title` | Set a New Password | تعيين كلمة مرور جديدة |
| `forgotVerifiedMsg` | Identity verified for | تم التحقق من الهوية لـ |
| `forgotVerifyBtn` | Verify Identity | تحقق من الهوية |
| `frameAluminum` | Aluminum | ألمنيوم |
| `frameCarbon` | Carbon | كربون |
| `frameSizeLabel` | Frame Size | مقاس الإطار |
| `frameSteel` | Steel | فولاذ |
| `frameTitanium` | Titanium | تيتانيوم |
| `freeLabel` | Complimentary | ضيافة |
| `fullName` | Full Name | الاسم الكامل |
| `gCompleteSub` | Just a couple more details to finish signing up. | تفاصيل قليلة لإتمام إنشاء الحساب. |
| `gCompleteTitle` | Complete your profile | أكمل ملفك الشخصي |
| `genderFemale` | Female | أنثى |
| `genderLabel` | Gender | الجنس |
| `genderMale` | Male | ذكر |
| `gridViewBtn` | Grid | شبكة |
| `groupCapHint` | up to {0} riders | حتى {0} راكبين |
| `groupEditTitle` | Edit group booking | تعديل حجز المجموعة |
| `groupNameLabel` | Group name | اسم المجموعة |
| `groupNamePh` | e.g. Tamer Group | مثال: مجموعة تامر |
| `hasBookingsTitle` | Has bookings | لديه حجوزات |
| `heightHint` | - frame size auto-selected | - يتم اختيار المقاس تلقائياً |
| `heightLabel` | Height | الطول |
| `heightOptional` | (optional - auto-selects your bike size) | (اختياري - يحدد مقاس الدراجة تلقائياً) |
| `heightPlaceholder` | Enter your height (cm) | أدخل طولك (سم) |
| `helpBody` | Open a session so customers can book it (Sessions tab).<br>When a rider arrives, check them in from the Bookings tab and assign a bike.<br>Mark payment with the Paid toggle; use On the House for free rides.<br>In Sessions you can open, close, mark full, clone, or delete sessions.<br>Print or export a session report from the Bookings tab toolbar.<br>A  on a rider means they have repeat no-shows.<br>Use Lock (top bar) when you step away. | افتح جلسة ليتمكن العملاء من الحجز (تبويب الجلسات).<br>عند وصول الراكب، سجّل دخوله من تبويب الحجوزات وخصّص دراجة.<br>حدّد الدفع بزر مدفوع؛ استخدم "على الحساب" للرحلات المجانية.<br>في الجلسات يمكنك الفتح والإغلاق والتعليم كممتلئة والنسخ والحذف.<br>اطبع أو صدّر تقرير الجلسة من شريط أدوات الحجوزات.<br>علامة  على الراكب تعني تكرار عدم الحضور.<br>استخدم القفل (الشريط العلوي) عند الابتعاد. |
| `helpBtn` | Help | مساعدة |
| `helpTitle` | Staff quick guide | دليل سريع للموظفين |
| `hiddenTypesLabel` | Hidden bike types | أنواع الدراجات المخفية |
| `hideOtherTypes` | ↑ Hide other types | ↑ إخفاء الأنواع الأخرى |
| `historySub` | Log of all completed and no-show rides. Send receipts directly to customers. | سجل جميع الرحلات المكتملة والغيابات. |
| `historyTitle` | Ride History | سجل الرحلات |
| `homeBtn` | Home | الرئيسية |
| `housePayTypesLabel` | On the house for these bike types | على حساب المحل لهذه الأنواع |
| `iabGoogleBlocked` | Google sign-in is blocked inside this app's browser (Instagram/WhatsApp). Tap ⋯ and choose "Open in browser", or sign up with email below. | تسجيل الدخول عبر Google محظور داخل متصفح هذا التطبيق (إنستغرام/واتساب). اضغط ⋯ واختر "الفتح في المتصفح"، أو أنشئ حساباً بالبريد أدناه. |
| `inLine` | in line | في الطابور |
| `inQueueMsg` | You're in the queue | أنت في قائمة الانتظار |
| `inUseElse` | In use elsewhere | قيد الاستخدام في مكان آخر |
| `inUseLabel` | In Use | قيد الاستخدام |
| `joinQueue` | Join Queue | انضم للطابور |
| `joinWaitlistBtn` | Join waitlist | انضم لقائمة الانتظار |
| `justNow` | just now | الآن |
| `keepNumberMsg` | Keep this number - you will need it to check your status. | احتفظ بهذا الرقم - ستحتاجه للتحقق من حالتك. |
| `landingSub` | Bicycle rentals & community rides in Jeddah | تأجير الدراجات وجولات مجتمعية في جدة |
| `landingTitle` | MicroMobility Rentals | مايكرو موبيليتي للتأجير |
| `lastName` | Last Name | اسم العائلة |
| `lecKickerComm` | Micromobility | مايكرو موبيليتي |
| `lifespanLabel` | Lifespan | مدة الخدمة |
| `liveLabel` | Live | مباشر |
| `lockBtn` | Lock | قفل |
| `maintBtn` | Maintenance | صيانة |
| `maintLabel` | Maintenance | صيانة |
| `markFullBtn` | Mark Full | تعيين كمكتمل |
| `meetPointLbl` | Meeting point | نقطة التجمع |
| `memberCardTitle` | Member card | بطاقة العضوية |
| `memberNo` | Non-member | غير عضو |
| `memberYes` | Member | عضو |
| `mfBrand` | Brand: | العلامة: |
| `mfModel` | Model: | الطراز: |
| `mfSize` | Size: | المقاس: |
| `middleName` | Middle Name | الاسم الأوسط |
| `minutesAgo` | m ago | د مضت |
| `modifyBanner` | You already have a booking in this session. Update your size or bike type preference below. | لديك حجز قائم في هذه الجلسة. يمكنك تعديل المقاس أو نوع الدراجة أدناه. |
| `modifyBookingBtn` | Update Booking | تعديل الحجز |
| `modifyExistingBtn` | Modify My Booking | تعديل حجزي |
| `moveDownLabel` | Move down | تحريك لأسفل |
| `moveDownLbl` | Move down | تحريك لأسفل |
| `moveUpLabel` | Move up | تحريك لأعلى |
| `moveUpLbl` | Move up | تحريك لأعلى |
| `mrBadgesTitle` | Badges | الأوسمة |
| `mrBookNext` | Book your next ride | احجز رحلتك القادمة |
| `mrInDays` | in {0} days | بعد {0} أيام |
| `mrShareBtn` | Share my season | شارك موسمي |
| `mrShareText` | My season at the Jeddah Corniche Circuit 🚴 | موسمي في حلبة كورنيش جدة 🚴 |
| `mrToday` | Today! | اليوم! |
| `mrTomorrow` | Tomorrow | غداً |
| `myCurrentRides` | Current & upcoming | الحالية والقادمة |
| `myPastRides` | Past rides | الرحلات السابقة |
| `myRidesSub` | Your complete rental history. | سجلك الكامل للإيجار. |
| `myRidesTitle` | My Bookings | حجوزاتي |
| `nameLabel` | Name | الاسم |
| `navReserve` | Reserve | احجز |
| `needToUpdate` | Need to update? | تريد التحديث؟ |
| `newSession` | + New Session | + جلسة جديدة |
| `newSessionTitle` | New Session | جلسة جديدة |
| `nextUpLabel` | Next Up | التالي |
| `notSetOpt` | Not set | غير محدد |
| `notesEmpty` | No notes yet. Add the first one above. | لا توجد ملاحظات بعد. أضف الأولى أعلاه. |
| `notesSub` | Private staff notes - customers never see these. | ملاحظات خاصة بالموظفين - لا يراها العملاء أبداً. |
| `notesTitle` | Customer Notes | ملاحظات العملاء |
| `nsClear` | Clear | مسح |
| `nsSelectAll` | Select all | تحديد الكل |
| `nsSelectAllBikes` | Select all bikes | تحديد كل الدراجات |
| `numBikes` | Number of Bikes | عدد الدراجات |
| `offlineBanner` | You are offline - changes are saved and will sync when the connection returns. | أنت غير متصل - يتم حفظ التغييرات وستتم المزامنة عند عودة الاتصال. |
| `offlineLabel` | Offline | غير متصل |
| `onBikeNow` | On the bike now | على الدراجة الآن |
| `onBikeStat` | On Bike | على الدراجة |
| `onTheHouseLabel` | On the house | على حساب المحل |
| `opGateBtn` | Continue | متابعة |
| `opGateMsg` | Pick your name — every action is recorded in the log under whoever did it. | اختر اسمك — يُسجَّل كل إجراء في السجل باسم من قام به. |
| `opGateTitle` | Who is working? | من يعمل الآن؟ |
| `openBtn` | Open | فتح |
| `openEmailApp` | Open in Email App | فتح في تطبيق البريد |
| `openMapsLbl` | Open in Maps | افتح في الخرائط |
| `opensNewTab` |  (opens in a new tab) |  (يفتح في تبويب جديد) |
| `optionalLabel` | optional | اختياري |
| `outOfStock` | Out of stock | نفد المخزون |
| `paidLabel` | Paid | مدفوع |
| `payAtBooth` |  Payment is collected at the booth at the Corniche Circuit. Please have your queue number ready. |  الدفع يتم عند الكشك في دوار الكورنيش. يرجى إحضار رقم طابورك. |
| `payAtBoothFCFS` | Bikes are assigned on a First Come, First Serve basis. Come early to get the bike type you chose. | يتم توزيع الدراجات على أساس الأول فالأول. تعال مبكراً للحصول على نوع الدراجة الذي اخترته. |
| `payAtBoothMsg` | Payment is collected at the booth at the Corniche Circuit. Please have your queue number ready when you arrive. | يتم الدفع عند الكشك في حلبة الكورنيش. يرجى إحضار رقم طابورك عند وصولك. |
| `payAtBoothTitle` | Payment Info | معلومات الدفع |
| `payPendingWarning` | Unpaid | غير مدفوع |
| `payTeam` | MM Team | فريق MM |
| `pendingLabel` | Pending | معلق |
| `pendingPayment` | Pending Payment | مستحق الدفع |
| `phoneNum` | Phone Number | رقم الهاتف |
| `photoErrToast` | Could not read that image. | تعذّرت قراءة الصورة. |
| `photoSavedToast` | Photo updated | تم تحديث الصورة |
| `pinAttemptsWarn` | {0} attempts remaining before lockout | تبقّت {0} محاولات قبل القفل |
| `pinLocked` | Too many wrong attempts. Try again in {0}. | محاولات خاطئة كثيرة. حاول مجدداً بعد {0}. |
| `pinSub` | Enter the 4-digit PIN to access the staff panel. | أدخل الرقم السري المكون من 4 أرقام للدخول إلى لوحة الموظفين. |
| `pinTitle` | Staff Access | دخول الموظفين |
| `posLabel` | Pos. | مركز |
| `preferenceLabel` | Preference | التفضيل |
| `priceCustomOpt` | Custom... | مخصص... |
| `pricePerBike` | Price per bike | السعر للدراجة |
| `priceVipDiscount` | VIP & Guests Discount | خصم كبار الشخصيات والضيوف |
| `printCollected` | Collected | المبلغ المحصل |
| `printPending` | Pending | المبلغ المعلق |
| `printReportBtn` | Print Report | طباعة التقرير |
| `printReportTitle` | Session Report | تقرير الجلسة |
| `printTotalRiders` | Total Riders | إجمالي الركاب |
| `profileCompleteLabel` | Profile {0}% complete | اكتمال الملف {0}% |
| `profileInfo` | Profile Information | معلومات الملف الشخصي |
| `profilePhotoLabel` | Profile Photo | صورة الملف |
| `promoteBtn` | Promote | ترقية |
| `publishBtn` | Publish | نشر |
| `publishConfirmBody` | {0} approved rider(s) will immediately see that they are confirmed. This cannot be undone from here. | سيرى {0} مشارك مقبول تأكيد مشاركته فوراً. لا يمكن التراجع عن ذلك من هنا. |
| `publishConfirmTitle` | Publish the rider list? | نشر قائمة المشاركين؟ |
| `publishedAlready` | Results are already published for this ride. | تم نشر نتائج هذه الجولة بالفعل. |
| `publishedChip` | Published | تم النشر |
| `publishedToast` | Results published - {0} rider(s) confirmed | تم نشر النتائج - تأكيد {0} مشارك |
| `qtyDecLabel` | Decrease number of bikes | إنقاص عدد الدراجات |
| `qtyIncLabel` | Increase number of bikes | زيادة عدد الدراجات |
| `queueNumLabel` | Queue Number | رقم الطابور |
| `quickAddBikeSubmit` | Add & Select | إضافة وتحديد |
| `quickAddBikeTitle` | Quick Add Bike | إضافة دراجة سريعة |
| `railHoverTip` | Collapse sidebar | طيّ القائمة |
| `railPinTip` | Keep sidebar open | تثبيت القائمة الجانبية |
| `ratedLabel` | Rated | تم التقييم |
| `registeredLabel` | Registered | مُسجَّل |
| `releaseBikeBtn` | Release | تحرير |
| `releaseBikeToast` | released back to available | تم تحريره وأصبح متاحاً |
| `rememberMe` | Remember me | تذكرني |
| `removeBtn` | Remove | حذف |
| `removePhotoBtn` | Remove | إزالة |
| `removedLabel` | Removed | محذوف |
| `rentDiscountLabel` | Discount % | خصم % |
| `reopenBookingBtn` | Re-open | إعادة فتح |
| `reopenBtn` | Re-open | إعادة فتح |
| `reorderNone` | Nothing needs reordering right now. | لا شيء يحتاج إعادة طلب الآن. |
| `reorderShareBtn` | Share list | مشاركة القائمة |
| `reorderShareTitle` | Reorder list - MicroMobility | قائمة إعادة الطلب - مايكروموبيليتي |
| `reorderSold` | sold | مُباع |
| `reorderSuggest` | reorder | أعد الطلب |
| `reorderTitle` | Reorder suggestions | اقتراحات إعادة الطلب |
| `repeatOnceOpt` | Just this date | هذا التاريخ فقط |
| `repeatWeeksHint` | creates the same session for the next weeks | ينشئ نفس الجلسة للأسابيع القادمة |
| `repeatWeeksLabel` | Repeat weekly | تكرار أسبوعي |
| `repeatWeeksOpt` | {0} weeks | {0} أسابيع |
| `rescheduleBtn` | Reschedule | إعادة جدولة |
| `rescheduleFull` | Not enough room in that session. | لا توجد مساحة كافية في تلك الجلسة. |
| `rescheduleNoSessions` | No other open sessions available. | لا توجد جلسات مفتوحة أخرى متاحة. |
| `rescheduleSub` | Pick another session to move all your riders to. | اختر جلسة أخرى لنقل جميع ركابك إليها. |
| `rescheduleTitle` | Move your booking | نقل حجزك |
| `reserveBikeBtn` | Reserve bike | حجز الدراجة |
| `reserveDesc` | Register for an available session and join the queue. | سجل في جلسة متاحة وانضم إلى الطابور. |
| `reserveTakenConfirm` | Reserved for {0} — assign anyway? | محجوزة لـ {0} — هل تريد المتابعة؟ |
| `reserveTitle` | Reserve Your Spot | احجز دراجتك |
| `reservedAtLabel` | Reserved at | وقت الحجز |
| `reservedChip` | Reserved | محجوزة |
| `resetBtn` | Set New Password | تعيين كلمة مرور جديدة |
| `resetCodeLabel` | 6-Digit Code | الرمز المكوّن من 6 أرقام |
| `resetConfirmPwd` | Confirm New Password | تأكيد كلمة المرور |
| `resetFiltersBtn` | Reset | إعادة تعيين |
| `resetNewPwd` | New Password | كلمة المرور الجديدة |
| `restoreBookingBtn` | Restore | استعادة |
| `restoreBtn` | Restore | استعادة |
| `restoreEntryBtn` | Restore | استعادة |
| `restoreFullBody` | This session is already at capacity. Restore this booking anyway? | هذه الجلسة ممتلئة بالفعل. هل تريد استعادة هذا الحجز على أي حال؟ |
| `restoreFullTitle` | Session is full | الجلسة ممتلئة |
| `resultBikes` | bikes | دراجة |
| `resultOf` | of | من |
| `resultRecords` | records | سجل |
| `resultRiders` | riders | راكباً |
| `resultRides` | rides | رحلات |
| `resultSessions` | sessions | جلسات |
| `retireBtn` | Retire | تقاعد |
| `retiredLabel` | Retired | متقاعد |
| `retryBtn` | Try again | إعادة المحاولة |
| `returnBikeBtn` | Return Bike | إرجاع الدراجة |
| `returnMarkPaidBtn` | Mark Paid & Return | تسجيل الدفع وإعادة الدراجة |
| `returnPayMsg` | This rider has not paid yet. The bike will be returned and payment will be marked as pending. | لم يدفع هذا الراكب بعد. سيتم إرجاع الدراجة وسيُسجَّل الدفع كمعلق. |
| `returnPayTitle` | Payment Pending | الدفع معلق |
| `returnPendingBtn` | Return - Pending Payment | إرجاع الدراجة - دفع معلق |
| `reviewRentalLabel` | Rental | الإيجار |
| `reviewRidersLabel` | Riders | الركّاب |
| `reviewSessionLabel` | Session | الجلسة |
| `reviewTotalLabel` | Total | الإجمالي |
| `rideHistory` | Ride History | سجل الرحلات |
| `rideTierLabel` | Rider tier | مستوى الراكب |
| `riderDetails` | Rider Details | بيانات الراكب |
| `riderLabel` | Rider | الراكب |
| `riderName` | Rider's Full Name | الاسم الكامل للراكب |
| `riderNamePlaceholder` | Enter rider's full name | أدخل الاسم الكامل |
| `ridersStat` | Riders | الراكبون |
| `ridesToNext` | {0} more rides to {1} | {0} رحلات للوصول إلى {1} |
| `roleAdmin` | Admin | مدير |
| `roleFrontDesk` | Front Desk | موظف استقبال |
| `rowLabel` | Row | الإجمالي |
| `saveAccountBtn` | Save Changes | حفظ التغييرات |
| `saveBikeBtn` | Save Changes | حفظ التغييرات |
| `saveBtn` | Save | حفظ |
| `saveChangesBtn` | Save Changes | حفظ التغييرات |
| `saveSessionBtn` | Save Changes | حفظ التغييرات |
| `searchLabel` | Search bikes... | ابحث عن دراجة... |
| `searchPlaceholder` | Booking number, name or phone… | رقم الحجز أو الاسم أو الهاتف… |
| `searchWord` | Search | بحث |
| `secondsAgo` | s ago | ث مضت |
| `selectCityOpt` | Select city | اختر المدينة |
| `selectCountryFirst` | Select a country first | اختر الدولة أولاً |
| `selectCountryOpt` | Select country | اختر الدولة |
| `selectRowTip` | Select | تحديد |
| `selectSessionPrompt` | Select a session above | اختر جلسة من الأعلى |
| `selectSessionSub` | Click a session chip to view and manage its queue independently. | انقر على إحدى الجلسات لعرض طابورها وإدارته بشكل مستقل. |
| `sendCodeBtn` | Send Code | إرسال الرمز |
| `sendReceipt` | Receipt | إيصال |
| `servingSize` | Serving size | حجم الحصة |
| `sessionAddonsHint` | inventory items customers can add to a booking | عناصر من المخزون يمكن للعملاء إضافتها إلى الحجز |
| `sessionAddonsLabel` | Add-ons offered | الإضافات المتاحة |
| `sessionBranchLabel` | Location / Branch | الموقع / الفرع |
| `sessionFleetLabel` | Session fleet | أسطول الجلسة |
| `sessionFullWaitlistMsg` | This session is full. You can join the waitlist and we will promote you if a spot opens. | هذه الجلسة ممتلئة. يمكنك الانضمام لقائمة الانتظار وسنرقّيك عند توفر مكان. |
| `sessionsSub` | Create sessions and open them to accept reservations. Closed by default. | أنشئ الجلسات وافتحها لقبول الحجوزات. مغلقة بشكل افتراضي. |
| `sessionsTitle` | Sessions | الجلسات |
| `setBtnShort` | Set | تعيين |
| `setPriceBtn` | Set Price | تحديد السعر |
| `settledLabel` | Settled | مسوّى |
| `showOtherTypes` | ↓ Show other types | ↓ عرض أنواع أخرى |
| `sizeMatchLabel` | Size match | مقاس مناسب |
| `sizeWord` | Size | المقاس |
| `snavCommerce` | Commerce | التجارة |
| `snavInsights` | Insights | الرؤى |
| `snavPeople` | People | الأشخاص |
| `snavRides` | Rides | الرحلات |
| `snavSystem` | System | النظام |
| `someDatesSkipped` | {0} created, {1} already existed | تم إنشاء {0}، {1} موجودة مسبقاً |
| `splitCardPrompt` | Amount paid by CARD (SAR)? The rest is cash. | المبلغ المدفوع بالبطاقة (ريال)؟ والباقي نقدًا. |
| `splitWord` | Split | تقسيم |
| `spotsLeft` | left | متبقٍ |
| `stApplyBtn` | Apply {0} correction(s) | تطبيق {0} تصحيح |
| `stCancelBtn` | Exit stock-take | إنهاء الجرد |
| `stHint` | Type the counted quantity for each item - differences are highlighted. | اكتب الكمية المعدودة لكل عنصر - تُبرز الفروقات. |
| `stNoChanges` | No corrections to apply. | لا توجد تصحيحات للتطبيق. |
| `stStartBtn` | Stock-take | جرد المخزون |
| `stepConfirm` | Confirmation | تأكيد |
| `stockLeft` | left | متبقٍ |
| `switchLangTip` | Switch language | تغيير اللغة |
| `switchToAdmin` | Admin | مدير |
| `switchToFrontDesk` | Front Desk mode | وضع الاستقبال |
| `syncDiscardBtn` | Discard | تجاهل |
| `syncDiscardedToast` | Pending sales discarded. | تم تجاهل المبيعات المعلقة. |
| `syncOfflineToast` | Still offline - they will sync when the connection returns. | لا يزال دون اتصال - ستتم المزامنة عند عودة الاتصال. |
| `syncStuckBody` | {0} sale(s) could not sync. They may reference data that was changed or removed. Discard them? This cannot be undone. | {0} عملية بيع تعذّرت مزامنتها. قد تشير إلى بيانات تم تغييرها أو حذفها. تجاهلها؟ لا يمكن التراجع. |
| `syncStuckTitle` | Sales stuck syncing | مبيعات عالقة في المزامنة |
| `tableViewBtn` | Table | جدول |
| `tblScrollLabel` | Table — scroll sideways | جدول — مرّر أفقياً |
| `teamAddMember` | Add member | إضافة عضو |
| `teamChoose` | Choose team member | اختر عضو الفريق |
| `teamCustom` | Custom name | اسم مخصص |
| `teamCustomPrompt` | Team member name | اسم عضو الفريق |
| `teamEmpty` | No team members yet. | لا يوجد أعضاء فريق بعد. |
| `teamManage` | Manage team | إدارة الفريق |
| `teamMgrTitle` | MM Team members | أعضاء فريق MM |
| `themeDark` | Night mode | الوضع الليلي |
| `themeLight` | Sunlight mode | وضع النهار |
| `ticketAddCal` | Add to Calendar | أضف إلى التقويم |
| `ticketDirections` | Get Directions | الاتجاهات |
| `ticketLocation` | Location | الموقع |
| `ticketScanGate` | Scan on arrival | امسح عند الوصول |
| `tierElite` | Elite | نخبة |
| `tierLegend` | Legend | أسطورة |
| `tierNewcomer` | Newcomer | مبتدئ |
| `tierPro` | Pro | محترف |
| `tierRegular` | Regular | منتظم |
| `timeLabel` | Time | الوقت |
| `todayBikesOut` | Bikes out | دراجات بالخارج |
| `todayLabel` | Today | اليوم |
| `todayNoShows` | No-shows | لم يحضروا |
| `todayRevenue` | Revenue today | إيرادات اليوم |
| `todayServed` | Riders served | الركّاب المخدومون |
| `totalBikesSession` | Total bikes in session | إجمالي الدراجات في الجلسة |
| `totalBookings` | Total Bookings | إجمالي الحجوزات |
| `totalPaid` | Total Paid | إجمالي المدفوع |
| `totalStat` | Total | الكل |
| `totalWord` | Total | الإجمالي |
| `undoneMsg` | Undone. | تم التراجع. |
| `undoneTag` | undone | تم التراجع |
| `unitHour` | h | س |
| `unitMin` | min | د |
| `unreachableBanner` | Connected to wifi but the server is not reachable - you may need to sign in to this network. | متصل بالشبكة لكن تعذّر الوصول إلى الخادم - قد تحتاج إلى تسجيل الدخول إلى هذه الشبكة. |
| `updReloadBtn` | Refresh | تحديث |
| `updateReadyToast` | A new version is ready — refresh the page to update. | يتوفر إصدار جديد — حدّث الصفحة للتحديث. |
| `uploadPhotoBtn` | Upload photo | رفع صورة |
| `vatExcl` | excl. | غير شامل |
| `vatExclusive` | V.A.T. Exclusive | غير شامل الضريبة |
| `vatInclusive` | V.A.T. Inclusive | شامل الضريبة |
| `verifying` | Verifying... | جارٍ التحقق... |
| `waMissYouMsg` | We miss you at MicroMobility! Come ride the Corniche Circuit with us again - reserve your next ride anytime.<br><br>اشتقنا لك في مايكروموبيليتي! تعال واركب في حلبة الكورنيش معنا مجدداً - احجز رحلتك القادمة في أي وقت. | We miss you at MicroMobility! Come ride the Corniche Circuit with us again - reserve your next ride anytime.<br><br>اشتقنا لك في مايكروموبيليتي! تعال واركب في حلبة الكورنيش معنا مجدداً - احجز رحلتك القادمة في أي وقت. |
| `waRateMsg` | Thanks for riding with MicroMobility! How was your ride? Rate it here:<br><br>شكراً لركوبك مع مايكروموبيليتي! كيف كانت رحلتك؟ قيّمها هنا: | Thanks for riding with MicroMobility! How was your ride? Rate it here:<br><br>شكراً لركوبك مع مايكروموبيليتي! كيف كانت رحلتك؟ قيّمها هنا: |
| `waYourTurnMsg` | Hello! Your turn at MicroMobility is coming up soon. Please head to the booth.<br><br>مرحباً! اقترب دورك في مايكروموبيليتي. يرجى التوجه إلى الكشك. | Hello! Your turn at MicroMobility is coming up soon. Please head to the booth.<br><br>مرحباً! اقترب دورك في مايكروموبيليتي. يرجى التوجه إلى الكشك. |
| `waitingRidersStat` | Waiting Riders | في الانتظار |
| `waitingStat` | Waiting | بانتظار |
| `waitlistLabel` | Waitlist | قائمة الانتظار |
| `walkinName` | Full Name | الاسم الكامل |
| `walkinPhone` | Phone Number | رقم الهاتف |
| `walkinSession` | Session | الجلسة |
| `walkinSize` | Frame Size | مقاس الإطار |
| `walkinTitle` | Walk-in Registration | تسجيل زيارة مباشرة |
| `walkinType` | Bike Type Preference | تفضيل نوع الدراجة |
| `walletAdding` | Preparing pass… | جارٍ تجهيز البطاقة… |
| `walletErr` | Could not create the Wallet pass. | تعذّر إنشاء بطاقة Wallet. |
| `wiPickCustPh` | Type a name or pick a saved customer | اكتب اسمًا أو اختر عميلًا محفوظًا |
| `youreNext` | You're next! | أنت التالي! |
