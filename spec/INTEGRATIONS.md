# INTEGRATIONS.md — MicroMobility Rentals

Every external service, browser API and platform behaviour the app depends on, and the
exact patterns it uses. Companion to [DATA-MODEL.md](DATA-MODEL.md), which covers the SQL
contract itself.

---

## 1. Supabase

### 1.1 Client construction

```js
const SUPABASE_URL = 'https://qpffkzmsfyilicwcsszz.supabase.co';
const SUPABASE_KEY = '<anon key, shipped publicly in the bundle>';
sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
```
[app.src.html:1758](../app.src.html#L1758)

The library is **self-hosted** at `./vendor/supabase-js-2.110.0.min.js` with an SRI hash, not
loaded from a CDN, so that an ad-blocker or CDN outage cannot break boot. It is `defer`red, so
it is not available at parse time.

**`_sbReady` is the gate every consumer awaits** ([app.src.html:1762](../app.src.html#L1762)).
It polls for `window.supabase` every 15 ms, **resolves anyway after 7 seconds** so boot can
continue in degraded/offline mode, and keeps polling for up to 60 s so a late-arriving library
still reconnects. A new implementation must keep the "resolve on timeout" behaviour — without
it a blocked script hangs the app on a blank shell forever.

### 1.2 Two auth systems, deliberately

| | Customers | Staff |
|---|---|---|
| Mechanism | **Custom**: `customers` table + bcrypt + a `session_token` column | **Supabase Auth** (email + password) |
| Proof carried | `(p_id, p_token)` passed to every RPC | JWT in the Supabase client session |
| Server check | `_cust_token_ok()` | `is_staff()` → `staff` table by `auth.uid()` |
| Stored in | `localStorage.cq_session` (or sessionStorage if "remember me" is off) | supabase-js's own storage |

Customers are **not** Supabase Auth users. This is load-bearing: `is_staff()` returns false for
them, so every staff-only RLS policy already excludes customers without a second check.

Staff may sign in **by phone**: `_staffLoginEmail()` resolves a phone to an account email via a
hard-coded `STAFF_PHONE_MAP` first, then the `staff_email_for_phone` RPC (backed by the
`staff_phones` table), then does an ordinary email+password sign-in. This exists to avoid
Supabase's paid phone provider.

`SECURE_AUTH` ([app.src.html:1789](../app.src.html#L1789)) defaults **on**; `localStorage.cq_secure_auth`
(`'1'`/`'0'`) overrides it, which is how the Playwright suite pins open mode.

### 1.3 Read patterns

| Reader | Path |
|---|---|
| Signed-out visitor, availability | `queue_public` view (no PII) |
| Customer, own bookings | `my_bookings(p_id, p_token)` RPC |
| Customer, sessions | `list_sessions(p_id, p_token)` RPC — returns ungated sessions plus any whose required tag the caller actively holds |
| Staff, everything | direct table reads under `is_staff()` policies |

**Pagination is mandatory on five reads.** PostgREST caps every request at 1000 rows, and
`_pagedAll()` wraps the reads that grow without bound: `customers`, `customer_tags`,
`customer_notes`, `desk_waitlist`, `cashier_sales`, and the queue itself. Skipping this
silently truncates revenue reports and makes real customers look "not found"
([app.src.html:2003](../app.src.html#L2003) and the parallel block at
[app.src.html:2043](../app.src.html#L2043)).

**The queue read is windowed by date**, not fetched whole:
- `QUEUE_BOOT_DAYS = 60` on cold start,
- `QUEUE_WINDOW_DAYS = 365` streamed in shortly after boot (`S._fullWindow`),
- cutoff computed by `_qWindowCut()` ([app.src.html:1788](../app.src.html#L1788)).

**Customers are fetched only on staff devices** — gated on `localStorage.cq_staff === '1'`
([app.src.html:1997](../app.src.html#L1997)). A visitor never downloads the customer list.

**Staff PII is defended against a mid-shift downgrade**: if a later refresh comes back PII-free
(because the staff Auth session lapsed and the read fell back to `queue_public`), previously
known names/phones are merged back in rather than blanking every row to "—"
([app.src.html:2024](../app.src.html#L2024)).

### 1.4 Realtime

One channel, `mmcq-live`, with `postgres_changes` on **seven** tables:

`queue_entries`, `desk_waitlist`, `sessions`, `bikes`, `inventory`, `cashier_sales`, `customers`

([app.src.html:17763](../app.src.html#L17763))

- Events are **debounced 350 ms** into a single refresh (`_rtApply`).
- A change to `bikes`, `inventory` or `customers` requests a **full** reload; everything else
  uses the slim path (`loadDataLight`).
- **Nothing refreshes while the tab is hidden** — `document.hidden` short-circuits, and
  `visibilitychange` catches up on return.
- Reconnect uses capped exponential backoff: `min(30s, 1s * 2^n)` for n up to 5.
- A subtle bug the code guards explicitly: `removeChannel()` fires the *removed* channel's
  callback with `CLOSED`, so the handler ignores callbacks from a channel that is no longer
  `_rtChannel` — otherwise it teardown-loops forever.
- **A 30-second poll is the fallback** (`setInterval(_autoRefresh, 30000)`, paused while hidden,
  [app.src.html:17708](../app.src.html#L17708)).

### 1.5 Schema probing

`_probeSchema()` ([app.src.html:17790](../app.src.html#L17790)) selects `card_amount` from
`queue_entries` and `customer_id` from `cashier_sales` once at boot. If either column is absent
the matching UI is hidden (the rental **Split** payment option disappears rather than silently
recording a split as cash). This lets one bundle run against a database that predates a migration.

### 1.6 Storage

Profile photos go to the **public bucket `photos`**, path prefix `p/`:

```js
await sb.storage.from('photos').upload(path, blob, {contentType:'image/jpeg', upsert:true, cacheControl:'31536000'});
const {data} = sb.storage.from('photos').getPublicUrl(path);
```
[app.src.html:7086](../app.src.html#L7086)

Files are content-addressed by `uid()`, hence the 1-year cache. If the upload fails the client
falls back to storing a `data:` URL directly in `customers.photo`.

---

## 2. Offline behaviour

The booth runs on captive-portal wifi, so offline is a first-class state, not an error.

### 2.1 Two outboxes

| Outbox | Key | Holds | Flush |
|---|---|---|---|
| Bookings | `cq_book_outbox` | bookings created while offline, with **client-generated stable ids** so a replay cannot double-book | `_bookOutboxFlush()` ([app.src.html:14875](../app.src.html#L14875)) |
| Sales | `cq_sales_outbox` | POS sales and deletes | `_outboxFlush()` ([app.src.html:14837](../app.src.html#L14837)) |

Both flush on: `window.online`, a 15-second interval while non-empty
([app.src.html:17907](../app.src.html#L17907)), and after every `loadData()`.

**The booking outbox now flushes through `customer_create_booking`**, falling back to a direct
insert **only** when the RPC is absent. A duplicate-key error is treated as *already landed*,
not as a failure. This is the change that makes dropping the open INSERT policy safe.

**`_applyBookOutbox()`** merges un-flushed bookings into the in-memory queue after every load,
so a rider who booked offline still sees their booking.

### 2.2 The voided-sales guard

`cq_sales_voided` holds the ids of deleted sales. It exists because **a Supabase DELETE blocked
by RLS returns no error** — without the guard, a voided sale would reappear on the next refresh.
Applied on every load ([app.src.html:2049](../app.src.html#L2049)).

### 2.3 Cold-start snapshot

`cq_snapshot` caches the last successful load (**with photos stripped** to stay inside the
quota) so a cold start paints real data before the network answers. A **PII-free** load is
never snapshotted on a staff device — restoring it would show the panel with no names
([app.src.html:2059](../app.src.html#L2059)).

### 2.4 Offline detection is two-signal

```js
function _isOffline(){ return navigator.onLine === false || !!S._netDown; }
function _isUnreachable(){ return !!S._netDown && navigator.onLine !== false; }
```
[app.src.html:17640](../app.src.html#L17640)

`navigator.onLine` only says an interface is up; a captive portal is "online" but unreachable.
`S._netDown` is set when a write actually fails, and the UI distinguishes the two states.

---

## 3. PWA

### 3.1 Manifest ([manifest.json](../manifest.json))

`name` "MicroMobility Rentals", `short_name` "MM Rentals", `start_url` `./`, `scope` `./`,
`display` **standalone**, `orientation` **portrait**, `background_color` and `theme_color`
both `#08090b`, icons 192/512 plus a 512 `maskable`.

### 3.2 Service worker ([service-worker.js](../service-worker.js))

- Cache name `mmcq-<content hash>` (currently `mmcq-2883d49208`) — **rewritten by the build**,
  never by hand. A second cache `mmcq-img` holds Supabase photos and survives version bumps.
- **Precached shell**: `./`, `index.html`, `styles.css?v=<hash>`, `manifest.json`, `logo.png`,
  `logo-dark.png`, `jcc.png`, `jcc-white.png`, `brand.png`, `hero.webp`, `icon-192.png`, `icon-512.png`.
- `install` → `skipWaiting()`; `activate` → delete every other cache, then `clients.claim()`.
- **Only GET is handled**; anything else falls through to the network.
- **Navigations are stale-while-revalidate**, not network-first: the cached `index.html` is
  served instantly and refreshed behind it. Consequence, and it is a real operational fact:
  **a deploy takes effect on the second load, not the first.**
  - A **redirected** response is never cached or returned for a navigation (Safari refuses it).
  - `etag` comparison decides whether the page actually changed.
  - **OAuth returns navigate natively** (the URL carries params supabase-js must read).
- **Other same-origin assets are cache-first with no revalidation** — safe only because every
  such asset is version-pinned by filename or by the `?v=<hash>` the build stamps.
- Only successful responses are cached, so a 404 for an image that ships in a later deploy is
  never pinned.
- Supabase Storage photos use the separate `mmcq-img` cache, trimmed to a maximum by
  `trimCache()`.

### 3.3 iOS specifics

`apple-mobile-web-app-capable`, `default` status bar (dark icons on a light bar, the page
starts below it; `black-translucent` put white icons over the white header), and **11 per-device
`apple-touch-startup-image` splash screens** matched on device width/height/pixel-ratio, each
exactly the device's pixel size (iOS ignores any other size)
([app.src.html:89](../app.src.html#L89)–[99](../app.src.html#L99)).

---

## 4. Web Push

Dormant in production until four Cloudflare env vars exist; the code path is complete.

**Client** ([app.src.html:10916](../app.src.html#L10916)):
1. `Notification.requestPermission()` (skipped in silent mode);
2. `navigator.serviceWorker.ready` → `pushManager.subscribe({userVisibleOnly:true, applicationServerKey})`
   — `userVisibleOnly` is mandatory, a silent push gets the site's permission revoked;
3. register with `customer_push_subscribe(p_id, p_token, endpoint, p256dh, auth, ua)`.

`VAPID_PUBLIC_KEY` in the client is **deliberately empty** until the server vars are set.

**Server** ([functions/api/push-send.js](../functions/api/push-send.js)) implements RFC 8291
(aes128gcm) and RFC 8292 (VAPID ES256 JWT) **directly against WebCrypto**, because Workers
cannot run the Node `web-push` library:
- per-message throwaway ECDH pair → shared secret with the subscription's `p256dh` → HKDF with
  the `auth` secret and a random salt → AES-GCM;
- `TTL: 86400`, `Urgency: high`;
- **staff-only**: the caller's Supabase access token is checked against `is_staff()` before
  anything is sent;
- subscriptions returning **404/410 are deleted** from `push_subscriptions`.

**Service worker** handles `push` (falls back to a visible notification even on an undecodable
payload), `notificationclick` (focuses an existing window rather than opening a second copy of
an installed PWA), and `pushsubscriptionchange` (messages open tabs to re-subscribe).

Notifications are sent on **waitlist auto-promotion** — `pushNotify()` at
[app.src.html:11062](../app.src.html#L11062), because that happens with nobody watching.

---

## 5. Apple Wallet passes

[scripts/wallet/wallet-pass.src.js](../scripts/wallet/wallet-pass.src.js) → bundled to
[functions/api/wallet-pass.js](../functions/api/wallet-pass.js) (18,789 lines, includes
`node-forge` and `fflate`).

- **Dormant → HTTP 501** unless `APPLE_PASS_P12_BASE64`, `APPLE_PASS_TYPE_ID` and
  `APPLE_TEAM_ID` are set; the client hides the button on 501.
- Ownership is re-verified through `my_bookings`; `groupIds` are filtered to rows the caller
  actually owns.
- Bundle: `pass.json` + images → `manifest.json` (SHA-1 per file) → `signature` (PKCS#7 with the
  Pass Type cert and Apple's WWDR intermediate, fetched and cached) → `zipSync`.

**Pass design (exact values):**

| Property | Value |
|---|---|
| Style | `eventTicket` |
| `backgroundColor` | `rgb(7,9,11)` |
| `foregroundColor` | `rgb(242,245,242)` |
| `labelColor` | `rgb(0,229,133)` |
| `sharingProhibited` | `true` |
| Header field | `SESSION` → short date, e.g. `Sun 19 Jul` (the only field visible when collapsed) |
| Primary field | `QUEUE` / `QUEUE NUMBERS` → `#6`, `#6-#8` (consecutive) or `#6, #7, #9` |
| Secondary | `TIME`, then `RIDER`/`RIDERS` (name if solo, else "N riders") |
| Auxiliary | `BIKE` (or `Mixed`), `TOTAL` (`SAR n`, rentals + add-ons) |
| Back fields | Session, Venue, Directions (link), Riders list (groups only), Add-ons, Payment ("Pay at the booth — cash, mada or STC Pay."), Good to know, Reference |
| Barcode | QR, message = `MMC-<num>-<id6>`, `iso-8859-1`, altText = the numbers display. Legacy single-`barcode` field also written for older iOS |
| Location | lat `21.6266`, lon `39.1099`, relevantText "Your ride is nearby - the Circuit is just ahead" |
| Semantics | `eventName` "Jeddah Corniche Circuit ride", venue + coords, `PKEventTypeGeneric`, start/end dates |
| Relevance | `relevantDate` / `expirationDate` from the session window (Jeddah +03:00) |
| Filename | `booking-<queue_num>.pkpass`, `Cache-Control: no-store` |

> **Ambiguity flagged:** the pass is built for circuit bookings. A community booking's ref is
> number-free (`MMC-<id6>`) and the handoff notes say community rides never get a wallet pass,
> but `wallet-pass.src.js` contains no explicit community check — it would emit a pass with an
> empty `primaryFields` value. Whether the client simply never offers the button for those
> bookings, or this is an untested path, is **not determinable from the function alone**.

---

## 6. Email — Brevo

[functions/api/booking-confirm.js](../functions/api/booking-confirm.js). Dormant unless
`BREVO_API_KEY` and `BREVO_SENDER` are set (free tier, 300/day).

Never trusts a client-supplied address: it re-reads the booking through `my_bookings` with the
caller's own token and mails **the address stored on that booking**. Subject:
`Booking confirmed — #<queue_num>`. Body is a small inline-styled HTML block, English only.

---

## 7. Error alerting — Discord

[functions/api/log-error.js](../functions/api/log-error.js). Dormant unless `DISCORD_WEBHOOK`
is set. Errors always go to the `error_log` table regardless; this is only the ping.

Public endpoint, so: message truncated to 400 chars, `src` to 200, `ua` to 160, content to 1900,
and a module-scope timestamp throttles to **1 send per 30 s per isolate**. Client-side there is
a further **120-second** gate before posting ([app.src.html:17917](../app.src.html#L17917)).

---

## 8. Camera / QR scanning

Two decoders, in order of preference ([app.src.html:12200](../app.src.html#L12200)):
1. **`BarcodeDetector`** with `formats:['qr_code']` where the browser has it;
2. **`jsQR`** (vendored, `./vendor/jsqr-1.4.0.js`) drawing the video onto a canvas capped at
   480 px wide, with `willReadFrequently:true`.

Polling interval **150 ms**. Accepted payload regex:

```
/^MMC-(?:(\d+)-)?([0-9a-zA-Z][0-9a-zA-Z-]{3,7})$/
```

— i.e. both the numbered circuit form and the number-free community form. **The id prefix is
what matches**; the number is only a consistency check.

The modal offers a **continuous mode** toggle (`cq_scan_cont`) with a running tally, so a
staffer can scan a queue of riders without reopening it.

QR *generation* uses the vendored `qrcode-generator-1.4.4.js`, **loaded on demand** by
`_loadQrcode()` — it is only needed when a ticket renders ([app.src.html:2172](../app.src.html#L2172)).

`Permissions-Policy` allows `camera=(self)`; microphone and geolocation are denied outright.

---

## 9. Weather — Open-Meteo

Analytics correlates ride demand with temperature:

```
https://api.open-meteo.com/v1/forecast?latitude=21.6246&longitude=39.1068
  &daily=temperature_2m_max&timezone=auto&past_days=92&forecast_days=1
```
[app.src.html:16226](../app.src.html#L16226)

No API key. Cached in `localStorage.cq_weather` for **24 hours**. Both `api.open-meteo.com` and
`archive-api.open-meteo.com` are allowed in the CSP.

---

## 10. Hosting — Cloudflare Pages

- **Deploy = push to `main`.** Pages auto-builds; CI runs the Playwright suite but **does not
  gate the deploy** (a known, documented gap — OPERATIONS-TODO.md §1).
- Serves the **repo root**, which is why [functions/_middleware.js](../functions/_middleware.js)
  exists as a denylist (see DATA-MODEL.md §5).
- [_headers](../_headers) sets the security headers and cache policy. The **CSP** is the notable
  one:

```
default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com;
style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob: https:;
connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cloudflareinsights.com
  https://api.open-meteo.com https://archive-api.open-meteo.com;
media-src 'self' blob:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none';
base-uri 'self'; object-src 'none'; form-action 'self'; upgrade-insecure-requests
```

  `'unsafe-inline'` for scripts is required because the whole app is one inline `<script>`.
- Cache policy: `vendor/`, `fonts/`, `splash/`, `styles.css`, `lang/` → `immutable, max-age=31536000`;
  PNG/WebP → 7 days; **`index.html` → `max-age=0, must-revalidate`**.
- `[site.config.json](../site.config.json)` is the single source for the public origin
  (`__SITE_ORIGIN__`), substituted at build time into `index.html`, `sitemap.xml` and `robots.txt`.

---

## 11. Fonts

Self-hosted under `./fonts/` (`fonts.css?v=<content hash>`, stamped by `scripts/build-html.mjs` on every reference, the print windows' too), **no Google Fonts request**. Two weights are
preloaded to avoid a swap flash: `Barlow-500-latin.woff2` and `BarlowCond-800i-latin.woff2`.
Families: **Barlow**, **Barlow Condensed**, **IBM Plex Sans Arabic**, **Chakra Petch**.

---

## 12. Internationalisation delivery

- **English is inline** in the bundle; `ar` is **extracted to `lang/ar.json`** by
  [scripts/build-html.mjs](../scripts/build-html.mjs) and fetched at runtime.
- The build stamps a content hash into `LANG_PACKS` and `window.__LANG_V` for cache-busting.
- The `<head>` **starts the fetch before the app script parses** (`window.__langPack`), so a
  returning Arabic reader waits on nothing extra.
- `setLang()` never blocks first paint: it draws in English immediately and redraws when the
  pack lands.
- `?lang=en|ar` selects the language from the URL and is kept in sync with
  `history.replaceState` (no history entry per toggle), which is what gives Arabic a crawlable
  address.
- The middleware denylist has an explicit exemption for `/lang/<code>.json`.
- **CI gate**: [scripts/check-i18n.mjs](../scripts/check-i18n.mjs) enforces EN/AR key parity —
  currently **1,734 keys × 2 languages, zero missing**.

---

## 13. Analytics / third-party

`static.cloudflareinsights.com` is permitted in the CSP (Cloudflare Web Analytics). There is
**no** Google Analytics, Segment, Sentry, or any other third-party SDK. Error reporting is the
app's own `error_log` table plus the optional Discord webhook.
