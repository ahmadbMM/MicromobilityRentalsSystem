# DATA-MODEL.md — MicroMobility Rentals

Every table, column, type and relationship actually used by the app, how each field is
populated and consumed, plus every RPC, trigger, policy and Pages Function.

Schema facts in this document were read from the **live production database**
(Supabase project `qpffkzmsfyilicwcsszz`, region `eu-central-1` (Frankfurt) since 2026-10-02 - before that `amyqxovbnlreassrqihr` in `ap-south-1`; Postgres 17.6) via
`information_schema`, `pg_proc`, `pg_policies`, `pg_indexes` and `pg_trigger`, not from
the migration files. Where a migration file disagrees with production, production wins and
the difference is called out.

Client-side mapping is in [`app.src.html`](../app.src.html); the two functions that own the
DB↔client shape are `entryFromDB()` ([app.src.html:1803](../app.src.html#L1803)) and
`entryToDB()` ([app.src.html:1855](../app.src.html#L1855)).

---

## 0. Conventions that apply to the whole schema

These are unusual enough that a fresh implementation will get them wrong unless it copies
them deliberately.

| Convention | Detail |
|---|---|
| **Primary keys are `text`, not uuid** | Generated **client-side** by `uid()` = `Math.random().toString(36).slice(2,9) + Date.now().toString(36)` ([app.src.html:1800](../app.src.html#L1800)). Example: `k3n8q2rm9f4v1z`. Server-side RPCs that mint ids instead use `encode(gen_random_bytes(12),'hex')` (24 hex chars). **Both forms coexist in the same column.** |
| **A booking's "reference" is a prefix of its id** | `bookingRef()` ([app.src.html:2202](../app.src.html#L2202)) takes `id.slice(0,6)`. There is no separate reference column. |
| **Timestamps are inconsistent by table** | Three different encodings are live at once — see §0.1. Do not normalise them without migrating data. |
| **Several columns are `text` but semantically structured** | JSON-in-text, comma lists, enums. See §0.2. |
| **No foreign keys on most relationships** | `queue_entries.session_id` → `sessions.id`, `cashier_sales.item_id` → `inventory.id` etc. are **not** declared FKs. The one real FK is `queue_entries.customer_id` → `customers.id` (which is why account deletion must unlink bookings first — [app.src.html](../app.src.html), `deleteCustomerAccount`). |
| **Money is `numeric`** | Every price column is `numeric`; `bikes.rental_price` is the exception at `real`. Verified: no price column is `text`. |
| **Currency is always SAR** | Never stored; hard-coded in the UI. |

### 0.1 Timestamp encodings actually in use

| Encoding | Columns | Exact format | Example |
|---|---|---|---|
| **ISO-8601 string in a `text` column** | `queue_entries.registered_at`, `.checked_in_at`, `.checked_out_at`, `customers.created_at`, `sessions.created_at`, `inventory.updated_at`, `cashier_sales.created_at`, `promo_codes.created_at`, `error_log.at`, `staff_actions.at` | `YYYY-MM-DDTHH:MM:SSZ` (UTC) when written by SQL (`to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS"Z"')`); JS writers use `new Date().toISOString()` which adds milliseconds (`YYYY-MM-DDTHH:MM:SS.sssZ`). **Both forms are present in the same column.** | `2026-08-25T18:03:11Z` |
| **Milliseconds since epoch in a `bigint`** | `customer_tags.added_at`, `.starts_at`, `.expires_at`, `tags.created_at`, `breakfast_spots.created_at` | integer ms | `1787923200000` |
| **Real `timestamptz`** | `customer_notes.created_at`, `desk_waitlist.created_at`, `.resolved_at`, `push_subscriptions.created_at`, `.last_ok_at`, `staff.added_at`, `team_members.created_at`, `login_throttle.locked_until` | Postgres native, default `now()` | — |
| **Calendar date in a `text` column** | `sessions.session_date`, `queue_entries.session_date`, `customers.birth_date`, `bikes.in_service_date`, `bikes.retired_date` | `YYYY-MM-DD` | `2026-08-25` |
| **Real `date`** | `promo_codes.expires_at` | Postgres native | — |

> **The calendar day is Asia/Riyadh, not UTC.** `todayStr()` ([app.src.html:2289](../app.src.html#L2289)) is
> `new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Riyadh'})`. `_promo_valid()` in SQL
> likewise compares against `(now() at time zone 'Asia/Riyadh')::date`. A new implementation
> that uses UTC dates will mis-date every session created between 00:00 and 03:00 local.

### 0.2 Columns that are `text` but hold structured data

| Column | Real type | Exact format | Parsed by |
|---|---|---|---|
| `sessions.bike_slots` | JSON object | `{"Road":{"XS":0,"S":2,...},"Hybrid":{...},"Mountain":{...},"_time":"21:00 - 23:00","_total":40,"_wl":{"m":"count"\|"pct","v":N}}` — per-type/size bike allocation plus reserved keys prefixed `_` | `parseSlots()` |
| `sessions.addons` | JSON array | inventory item ids offered on this session | — |
| `queue_entries.addons` | JSON array | `[{"id":"<inventory id>","qty":N,...}]`; `entryFromDB` tolerates both a JSON string and an already-parsed array | `entryFromDB()` ([app.src.html:1818](../app.src.html#L1818)) |
| `queue_entries.purchases` | JSON array | same tolerance as `addons` | `entryFromDB()` |
| `customers.default_pay` | enum-ish string | `house` (all types free) or `house:Road,Hybrid` (listed types free). Prefix `house` is significant. | `_housePayTypes()` ([app.src.html:1876](../app.src.html#L1876)) |
| `customers.hidden_types` | comma list | `Road,Road Carbon` — bike types hidden from THAT customer's picker | `_hiddenTypes()` ([app.src.html:1900](../app.src.html#L1900)) |
| `bikes.colors` | `jsonb` array | hex strings, e.g. `["#6ee89a","#000000"]` | — |
| `bikes.color_names` | `jsonb` array | parallel array of names | — |
| `inventory.nutrition` | JSON object | per-item nutrition facts | `showNutrition()` |
| `cashier_sales.category` | enum + **2 sentinels** | a real category, or `__discount__` (negative-value line), or `__cardmeta__` (qty-0 meta line carrying the card portion of a split) | `_salesTotals()` ([app.src.html:14546](../app.src.html#L14546)) |

### 0.3 Enumerations (all stored as bare `text`, no CHECK constraints, no PG enums)

| Concept | Values | Notes |
|---|---|---|
| `sessions.status` | `open`, `full`, `closed`, `deleted` | **Observed in production: only `open` and `closed`.** `full` and `deleted` are written by the app and must be supported. |
| `queue_entries.status` | `waiting`, `active`, `done`, `noshow`, `cancelled`, `removed`, `waitlist` | **Observed in production: `waiting`, `active`, `done`, `noshow`, `cancelled`, `removed` — no `waitlist` rows exist right now.** `waitlist` is fully implemented and reachable. |
| `queue_entries.approval` | `pending`, `approved`, `rejected`, **NULL** | NULL on a community booking **must be read as `pending`** — `_apprOf()` ([app.src.html:3687](../app.src.html#L3687)). |
| `queue_entries.type_preference` | `Any`, `Road`, `Hybrid`, `Mountain`, `Road Carbon`, `Own` | All six observed in production. |
| `queue_entries.pay_method` | `cash`, `card`, `split`, NULL | |
| `sessions.event_kind` | `community`, `jcc`, NULL | NULL and `jcc` both mean "circuit session"; only `community` is tested for (`_isCommunity`). |
| `sessions.ride_kind` | `saturday`, `petromin`, NULL | NULL = Saturday (rows predating the migration) — `_rideKind()` ([app.src.html:3638](../app.src.html#L3638)). |
| `bikes.status` | `available`, `in-use`, `maintenance`, `retired` | **Observed: only `available`** (nothing out at read time). |
| `bikes.size` | `XS`, `S`, `M`, `L` | |
| `bikes.type` | `Road`, `Hybrid`, `Mountain` | Note `Road Carbon` is a **price tier, not a fleet type** — see PREMIUM_TIERS in BUSINESS-RULES.md. |
| `cashier_sales.pay` | `paid`, `card`, `team`, `refunded`, `house`, `pending` | `cashier_sales` is empty in production at time of writing, so these come from the code, not observation. |
| `desk_waitlist.status` | `waiting`, `done`, `removed` | |
| `desk_waitlist.kind` | `walkup`, `managed` | `walkup` = person at the desk with no booking; `managed` = staff-picked row. |
| `staff.role` | `admin`, `frontdesk` | UX scoping only, **not** a security boundary. |
| `promo_codes.kind` | `percent`, `amount` | |
| `inventory.category` | `Helmet`, `ProteinSnacks`, `ElectrolyteSachets`, `EnergyGels`, `Drinks`, `ProteinBars`, `ProteinCookies`, `ProteinGummies`, `ProteinMuffins`, plus staff-created ones | Base lists are `EQUIP_CATS`/`SUPP_CATS` ([app.src.html:14204](../app.src.html#L14204)); staff additions live in **localStorage**, not the DB (see §7). |

---

## 1. Tables

### 1.1 `customers` — the identity table

| # | Column | Type | Null | Default | Populated by | Consumed by |
|---|---|---|---|---|---|---|
| 1 | `id` | text | NO | — | client `uid()` at signup, passed as `p_id` to `customer_signup` | everything |
| 2 | `name` | text | NO | — | signup / profile edit | rosters, tickets, receipts |
| 3 | `email` | text | YES | — | signup | login identifier, booking confirmation email |
| 4 | `phone` | text | YES | — | signup, stored **with country code** (`+9665…`) | login identifier, WhatsApp links |
| 5 | `password_hash` | text | NO | — | `crypt(p_pwd, gen_salt('bf'))` (bcrypt) server-side | `_cust_pwd_ok()` |
| 6 | `created_at` | text | NO | — | `to_char(now() at utc,…)` in `customer_signup` | analytics cohorts |
| 7 | `height` | integer | YES | — | signup / profile; **centimetres** | prefills booking, drives `heightToSize()` |
| 8 | `type_preference` | text | YES | `'Any'` | profile | prefills the booking wizard |
| 9 | `gender` | text | YES | — | signup | analytics |
| 10 | `birth_date` | text | YES | — | profile; `YYYY-MM-DD` | analytics |
| 11 | `country` | text | YES | — | profile | analytics |
| 12 | `city` | text | YES | — | profile | analytics |
| 13 | `photo` | text | YES | — | `customer_set_photo`; a **Supabase Storage public URL** (`/storage/v1/object/public/photos/p/…`) or a `data:` URL fallback | avatars |
| 14 | `session_token` | text | YES | — | 24 random bytes hex, minted at signup/login/reset; **reused across devices** (login only mints when absent) | `_cust_token_ok()` on every customer RPC |
| 15 | `default_pay` | text | YES | — | staff | "on the house" rule, see §0.2 |
| 16 | `hidden_types` | text | YES | — | staff | hides bike types from that customer's picker |
| 17 | `nationality` | text | YES | — | profile (My Account) or staff form; **never asked at signup**; an English name from `NATIONALITIES` (every country, Saudi Arabia first, then alphabetical in the rider's language) | account report |
| 18 | `socials` | jsonb | YES | — | profile (My Account, via `customer_set_socials`) or staff form; **never asked at signup**; `{instagram,x,tiktok,linkedin}` bare handles, never URLs; null when none | staff-only: Community row icons, account report |

**Password hash formats accepted** (`_cust_pwd_ok`): bcrypt (`$2…`), legacy salted SHA-256
(`sha256:<salt>:<hex>`, transparently re-hashed to bcrypt on next successful login), and
`oauth:google` which can never password-login.

**Unique index**: `customers_email_lower_uniq` on `lower(trim(email))` where email is non-empty.
There is **no** unique index on phone — duplicate-phone prevention is only in `customer_signup`'s
explicit check, so a phone duplicate is possible via direct insert.

### 1.2 `sessions` — a ride on a date

| # | Column | Type | Null | Default | Notes |
|---|---|---|---|---|---|
| 1 | `id` | text | NO | — | **usually the date string** (`2026-08-25`), but not guaranteed — clones/moves mint a `uid()` |
| 2 | `day` | text | NO | — | English day name (`Sunday`…); localised only at render (`dayLabel()`) |
| 3 | `session_date` | text | NO | — | `YYYY-MM-DD` |
| 4 | `capacity` | integer | NO | `12` | **the number the capacity guard enforces**; for bike-composition sessions it is the sum of `bike_slots` |
| 5 | `status` | text | NO | `'closed'` | see §0.3 |
| 6 | `created_at` | text | NO | — | ISO |
| 7 | `bike_slots` | text | YES | — | JSON, see §0.2 — also carries `_time` and the waitlist cap `_wl` |
| 8 | `location` | text | YES | — | branch label |
| 9 | `addons` | text | YES | — | JSON array of inventory ids |
| 10 | `required_tag_id` | text | YES | — | **NULL = publicly visible.** Non-null gates *visibility* via `list_sessions` and the `public read ungated` policy |
| 11 | `needs_approval` | boolean | NO | `false` | true = the Saturday shape (staff pick riders, hidden queue, allocation) |
| 12 | `hide_queue` | boolean | NO | `false` | true = results not published; riders see "under review" |
| 13 | `spots` | integer | YES | — | **approval rides only** — a hard allocation. Explicitly set NULL for paid community rides |
| 14 | `title` | text | YES | — | staff-chosen ride name; falls back to `evSatName`/`evPetroName` |
| 15 | `event_kind` | text | YES | — | `community` \| `jcc` \| NULL |
| 16 | `meet_url` | text | YES | — | meeting-point maps link (**Saturday only**; nulled for Petromin) |
| 17 | `breakfast_name` | text | YES | — | (**Saturday only**) |
| 18 | `breakfast_url` | text | YES | — | (**Saturday only**) |
| 19 | `last_qnum` | integer | YES | — | **monotonic queue-number counter**, owned by `assign_queue_num` |
| 20 | `ride_kind` | text | YES | — | `saturday` \| `petromin` \| NULL |
| 21 | `paid_ride` | boolean | NO | `false` | true = community ride that charges JCC prices |

> **`capacity` vs `spots` is a real distinction.** The DB capacity guard reads **`capacity` only**
> and exempts approval rides entirely. The client's `spotsLeft()` prefers `spots` **for approval
> rides** and `capacity` otherwise ([app.src.html:2330](../app.src.html#L2330)). They therefore never
> disagree — but only because the guard skips exactly the case where `spots` is used.

### 1.3 `queue_entries` — a booking (one row per **rider**, not per party)

| # | Column | Type | Null | Default | Notes |
|---|---|---|---|---|---|
| 1 | `id` | text | NO | — | client `uid()` or server hex |
| 2 | `name` | text | NO | — | **denormalised** from the customer, capped at 60 chars by the RPC |
| 3 | `email` | text | YES | — | denormalised, capped 120 |
| 4 | `phone` | text | YES | — | denormalised, capped 30 |
| 5 | `size` | text | NO | — | `XS`/`S`/`M`/`L`, derived from height |
| 6 | `type_preference` | text | NO | — | see §0.3 |
| 7 | `paid` | boolean | NO | `false` | |
| 8 | `price` | numeric | NO | `30` | **the default `30` is stale** — the app's `DEFAULT_PRICE` is `57.5`. The column default is never used in practice because every writer sets a price |
| 9 | `assigned_bike_id` | text | YES | — | a bike id, **or a JSON array string** when several bikes serve one row (`getAssignedBikeIds()`) |
| 10 | `session_id` | text | NO | — | → `sessions.id` (not an FK) |
| 11 | `session_day` | text | NO | — | denormalised |
| 12 | `session_date` | text | NO | — | denormalised; indexed, used for the 60/365-day window |
| 13 | `queue_num` | integer | NO | — | **assigned by the server**, never trusted from the client |
| 14 | `status` | text | NO | `'waiting'` | see §0.3 |
| 15 | `registered_at` | text | NO | — | ISO |
| 16 | `walk_in` | boolean | NO | `false` | true = booked at the desk with no account |
| 17 | `customer_id` | text | YES | — | **the only real FK** → `customers.id` |
| 18 | `height` | integer | YES | — | cm |
| 19 | `ride_duration` | integer | YES | — | minutes, written on return |
| 20 | `rating_bike` | integer | YES | — | 1–10 |
| 21 | `rating_exp` | integer | YES | — | 1–10 |
| 22 | `feedback` | text | YES | — | free text |
| 23 | `addons` | text | YES | — | JSON, see §0.2 |
| 24 | `purchases` | text | YES | — | JSON |
| 25 | `pay_method` | text | YES | — | `cash`/`card`/`split` |
| 26 | `card_amount` | numeric | YES | — | the card half of a split |
| 27 | `checked_in_at` | text | YES | — | ISO |
| 28 | `checked_out_at` | text | YES | — | ISO |
| 29 | `promo_code` | text | YES | — | the code as typed; matched case-insensitively |
| 30 | `approval` | text | YES | — | see §0.3 — **NULL reads as pending** |
| 31 | `group_id` | text | YES | — | ties riders into one party regardless of account |
| 32 | `group_name` | text | YES | — | party display name |
| 33 | `group_contact` | text | YES | — | responsible person |
| 34 | `group_phone` | text | YES | — | their number |
| 35 | `waitlist_num` | integer | YES | — | staff-visible waitlist position, assigned by `_wl_num_assign` |
| 36 | `to_reserve` | boolean | NO | `false` | staff mark from the row's ⋯ menu: hold a bike for this booking; cleared when one is reserved | staff queue: To be reserved badge / filter |

**Critical index**: `queue_entries_session_qnum_uniq` — `UNIQUE (session_id, queue_num) WHERE
status NOT IN ('cancelled','removed','noshow')`. This is the backstop that makes queue numbers
unique per session while allowing cancelled/removed/no-show rows to keep (and free) theirs.

### 1.4 `desk_waitlist` — people waiting at the booth

Separate from `queue_entries.status='waitlist'`. A row here is either a **walk-up** (no
booking at all) or a **managed** row (staff parked an existing booking onto the list).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | text | NO | — | |
| `name` | text | NO | — | |
| `phone` | text | YES | — | |
| `bike_type` | text | YES | — | walk-up's wanted type; for a linked booking the **booking** owns the type |
| `status` | text | NO | `'waiting'` | `waiting`/`done`/`removed` |
| `author` | text | YES | — | staff operator name |
| `created_at` | timestamptz | NO | `now()` | |
| `resolved_at` | timestamptz | YES | — | |
| `paid` | boolean | NO | `false` | |
| `price` | numeric | YES | — | |
| `pay_method` | text | YES | — | |
| `card_amount` | numeric | YES | — | |
| `kind` | text | NO | `'walkup'` | `walkup` \| `managed` |
| `sort_order` | integer | YES | — | staff hand-ordering |
| `booking_id` | text | YES | — | → `queue_entries.id` when this row represents a real booking |

> **The Waitlist screen shows more than this table.** Since 2026‑08‑26 the screen also folds in
> every `queue_entries` row with `status='waitlist'` that has no `desk_waitlist` row pointing at
> it, as synthetic rows with `id = 'wlb:' + booking id` and `_virtual: true`
> (`_wlVirtualRows()`, [app.src.html:4218](../app.src.html#L4218)). Those synthetic rows are
> **never persisted** — a new implementation must reproduce the union, not add a table.

### 1.5 `bikes` — the fleet

`id`, `name`, `size`, `type`, `colors` (jsonb), `status` (default `available`), `brand`,
`model`, `groupset`, `speeds` (int), `color_names` (jsonb), `rental_price` (**real**, the only
non-numeric money column), `location`, `frame_type`, `bike_number` (int, unique where non-null),
`in_service_date` (text `YYYY-MM-DD`), `retired_date` (text), `photo`.

Status is driven automatically by check-in (`available`→`in-use`) and return
(`in-use`→`available`); `maintenance`/`retired` are set by staff.

### 1.6 `inventory` — add-ons and shop stock

`id`, `name`, `category` (default `'Other'`), `qty` (int, default 0, **may go negative** —
oversell/backorder is deliberate), `low_threshold` (int, default 0), `updated_at` (text ISO),
`brand`, `photo`, `price` (numeric), `flavour`, `volume_ml` (int), `nutrition` (JSON text),
`cost` (numeric).

### 1.7 `cashier_sales` — POS lines

`id`, `session_id`, `customer_name`, `item_id`, `name`, `category`, `qty` (int, default 1),
`price` (numeric, default 0), `pay` (text, default `'paid'`), `created_at` (text ISO),
`customer_id`, `receipt_id`, `team_name`.

**The three modelling tricks** (no extra columns exist for these):
1. A **discount** is a line with `category='__discount__'` and a **negative** value.
2. A **card/cash split** on a product sale is a **qty-0** line with `category='__cardmeta__'`
   carrying the card portion.
3. A **refund** is `pay='refunded'` (the original line is not deleted).

Any aggregation must filter `__cardmeta__` and `qty=0`, and reverse `refunded`
(`_salesTotals()`, [app.src.html:14546](../app.src.html#L14546)).

### 1.8 `tags` and `customer_tags` — membership

`tags`: `id`, `slug` (unique on `lower(slug)`), `name`, `color`, `description`,
`auto_grant` (bool), `locked` (bool), `created_at` (bigint ms).

**Seeded rows in production (exact values):**

| id | slug | name | auto_grant | locked | color |
|---|---|---|---|---|---|
| `tag_jcc` | `jcc` | `Jeddah Corniche Circuit` | **true** | true | `#00e585` |
| `tag_saturday` | `saturday` | `Community` | false | true | `#4aa8f8` |

> The tag whose **slug** is `saturday` is the community membership gate. Its **display name was
> renamed to "Community"**; the slug is what every rule tests. Do not rename the slug.

`customer_tags`: PK `(customer_id, tag_id)`, plus `added_by`, `added_at` (bigint ms),
`note`, `starts_at` (bigint ms, nullable), `expires_at` (bigint ms, nullable).

**A tag row is ACTIVE only while `now ∈ [starts_at, expires_at)`** — `starts_at` inclusive,
`expires_at` **exclusive**. NULL on either side means unbounded. Server: `_ctag_active()`.
Client: `_tagActive()`. Both must agree.

### 1.9 Smaller tables

| Table | Purpose | Columns |
|---|---|---|
| `customer_notes` | staff notes per customer | `id`, `customer_id`, `customer_name`, `phone`, `note`, `author`, `created_at` (timestamptz), `booking_id`, `note_type` |
| `breakfast_spots` | reusable Saturday breakfast venues | `id`, `name`, `url`, `created_at` (bigint ms) |
| `team_members` | MM Team roster for `pay='team'` sales | `name` (**PK**), `created_at` |
| `staff` | Supabase-Auth-linked staff registry | `user_id` (uuid PK → auth.users), `role` (default `admin`), `added_at`, `must_change_pwd` (default **true**) |
| `staff_phones` | phone → staff email, so staff can sign in by phone without a paid SMS provider | `phone` (PK), `email` |
| `promo_codes` | discount codes | `id`, `code`, `kind` (`percent`/`amount`), `value`, `active`, `created_at`, `applies_to`, `expires_at` (**real `date`**), `max_uses`, `uses`, `customer_id` |
| `ride_prices` | **server-side price authority** | `type` (PK), `price` |
| `push_subscriptions` | Web Push endpoints | `id`, `customer_id`, `endpoint` (**unique**), `p256dh`, `auth`, `user_agent`, `created_at`, `last_ok_at`, `fail_count` |
| `login_throttle` | customer login rate limiting | `identifier` (PK, lowercased), `fails`, `locked_until` |
| `error_log` | client error reports | `id` (bigint), `at`, `msg`, `src`, `ua` — **insert-open to anyone** |
| `staff_actions` | staff audit trail | `id` (bigint), `at`, `action`, `who`, `device`, `view` — **insert-open to anyone**, staff-read |

**`ride_prices` in production (the values the price trigger enforces):**

| type | price |
|---|---|
| Road | 75 |
| Hybrid | 57.5 |
| Mountain | 57.5 |
| Any | 57.5 |
| Road Carbon | 250 |

There is **no `Own` row** — so the trigger's `canonical is null` branch keeps whatever the
client sent (clamped 0…1000), which is how a bike-owner booking stays free.

### 1.10 View: `queue_public`

```sql
SELECT id, session_id, session_day, session_date, queue_num, status, size,
       type_preference, paid, price, assigned_bike_id, walk_in, ride_duration
FROM queue_entries;
```

**No `name`, `email`, `phone`, `customer_id`, `feedback`, or ratings.** This is the only
booking read available to a signed-out visitor, and it exists so availability counts work
without exposing riders.

---

## 2. Row-level security (as deployed)

RLS is on for every table below. `is_staff()` = `exists(select 1 from staff where user_id = auth.uid())`.

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `customers` | staff | staff | staff | staff |
| `queue_entries` | **staff only** | **`true` (anyone)** | staff | staff |
| `sessions` | `required_tag_id IS NULL` (ungated only) | staff | staff | staff |
| `bikes` | `true` | staff | staff | staff |
| `inventory` | `true` | staff | staff | staff |
| `promo_codes` | `true` | staff | staff | staff |
| `ride_prices` | `true` | — | — | — |
| `cashier_sales` | staff | staff | staff | staff |
| `customer_tags`, `tags`, `customer_notes`, `desk_waitlist`, `breakfast_spots` | staff (ALL) | | | |
| `team_members` | staff | staff | staff | staff |
| `push_subscriptions` | staff | *(none — writes only via RPC)* | — | — |
| `staff` | `auth.uid() = user_id` (own row) | — | — | — |
| `error_log` | staff | **`true`** | — | — |
| `staff_actions` | staff | **`true`** | — | — |

**Two deliberate holes, both documented in the repo:**

1. `queue_entries` INSERT is open to anon. It is *not* a PII leak (price, paid and status are
   all trigger-enforced), and it exists so an **offline booking made on a client older than
   2026‑08‑24** can still flush. It is scheduled for removal —
   [`supabase/migrations/20260820120000_close_queue_entries_public_read.sql`](../supabase/migrations/20260820120000_close_queue_entries_public_read.sql)
   carries the exact statement and rollback.
2. `error_log` / `staff_actions` INSERT are open so an unauthenticated client can still report
   a crash.

The former world-readable `queue_entries` SELECT policy **was dropped on 2026‑08‑24** (stage 1
of that migration). A new implementation must therefore read bookings via `my_bookings` (own)
or `queue_public` (anonymous availability) — never the table.

---

## 3. Triggers on `queue_entries` (all of them, and why order matters)

| Trigger | Function | Fires | What it does |
|---|---|---|---|
| `queue_entries_assign_qnum` | `assign_queue_num` | INSERT | Bumps `sessions.last_qnum` to `max(last_qnum, max(queue_num))+1` and stamps it on the row. **The client's queue_num is always overwritten.** Numbers only ever climb — they are never reused. |
| `queue_entries_capacity` / `_upd` | `_capacity_guard` | INSERT / UPDATE | If `status='waiting'`, type ≠ `Own`, and not staff: takes an advisory lock on the session, counts rows whose status is **not** in `('cancelled','removed','noshow')` and type ≠ `Own`; if that count ≥ `capacity`, **rewrites status to `waitlist`**. Skips sessions with `needs_approval=true`. |
| `queue_entries_community_gate` / `_upd` | `_community_booking_gate` | INSERT / UPDATE | On a `event_kind='community'` session, raises `This ride is for community members only.` unless the row has a `customer_id` holding an **active** tag with slug `saturday`. Staff exempt. |
| `queue_entries_group_cap` / `_upd` | `_group_ride_cap` | INSERT / UPDATE | On a community session with `needs_approval=false`, raises `Up to 4 riders per booking on this ride.` if the same `customer_id` already has ≥ 4 live rows on that session. Staff exempt. |
| `queue_entries_comm_no_carbon` | `_comm_no_carbon` | INSERT | On any community session, silently rewrites `type_preference='Road Carbon'` → `'Road'`. |
| `trg_approval_guard` | `_approval_guard` | INSERT / UPDATE | A non-staff caller can never set `approval` to anything but `pending` on insert, and can never change it on update. **This is what stops a customer self-approving.** |
| `trg_enforce_booking_price` / `_upd` | `_enforce_booking_price` | INSERT / UPDATE | See §4. |
| `trg_promo_count_ins` / `_upd` | `_promo_count` | INSERT / UPDATE | Increments `promo_codes.uses` on insert; decrements when a booking moves **into** cancelled/removed; re-increments when it moves back out. |
| `wl_num_assign_ins` / `_upd` | `_wl_num_assign` | INSERT / UPDATE | When status is `waitlist`, assigns `waitlist_num = max+1` for the session under an advisory lock, unless a valid one is already set. |
| `queue_entries_qnum_update_guard` | `queue_num_update_guard` | UPDATE | If a `queue_num` change would collide with a live row, mints a fresh number from `last_qnum` instead. |

### 3.1 The price trigger in detail (`_enforce_booking_price`)

```
if UPDATE and is_staff() -> return unchanged        (staff may price anything)
look up the session's event_kind and paid_ride
if community AND NOT paid_ride -> price := 0        (free ride, unconditionally)
if no bike assigned AND not paid AND status in ('waiting','waitlist'):
    canonical := ride_prices[type_preference]
    if canonical found:
        if a valid promo is attached -> price := clamp(price, 0, canonical)   (discount allowed, markup not)
        else                          -> price := canonical                   (client price ignored)
    else -> price := clamp(price, 0, 1000)
finally: price := clamp(price, 0, 1000)
```

Consequences a new implementation must preserve: a client cannot cheapen a booking; a promo
can only ever *reduce*; a free community ride is free no matter what was sent; and once a bike
is assigned or the row is paid, staff pricing is left alone.

Triggers on other tables: `customers` has `_grant_auto_tags` on INSERT, which grants every
tag with `auto_grant=true` (today: `tag_jcc`) to the new account.

---


### `staff_options` (added 2026-09-15)

| Column | Type | Notes |
|---|---|---|
| `key` | text PK | `bike_brands`, `bike_groupsets`, `bike_frames`, `bike_wheels`, `bike_brakes` |
| `items` | jsonb | `bike_brands`: `[{"name","models":[...]}]` — models hang off brands; the others: `["..."]`. Empty `bike_frames` = the app's four defaults |
| `updated_at` | timestamptz | — |

Staff-only (`is_staff()` for all), loaded with the reference tables into `S.staffOptions`, written by `_optWrite` (upsert). Edited from the ✎ beside each list-backed field on the bike form (`showOptListModal`). Seeded from the fleet's existing brand/model/groupset values. Bike type `Kids` was added to `CUST_TYPES` the same day (priced like Hybrid, SAR 57.5). `bikes.weight_kg` (numeric, migration 20260915140000) joined the fleet columns with `wheel_size` and `brake_type`, which were granted to anon/authenticated the same day; the form's Wheel size and Brakes draw on `bike_wheels` / `bike_brakes`.

## 4. RPCs — the customer API contract

All are `SECURITY DEFINER` and callable by the anon key. Every customer-owned operation takes
`(p_id, p_token)` and calls `_cust_token_ok(p_id, p_token)` first, which is simply
`exists(select 1 from customers where id=p_id and session_token=p_token and p_token is not null)`.

| RPC | Inputs | Returns | Side effects | Auth |
|---|---|---|---|---|
| `customer_signup` | `p_id, p_name, p_email, p_phone, p_pwd, p_height, p_type_preference, p_gender` | `TABLE(id, session_token)` | inserts the customer (bcrypt), mints a token; **raises `DUPLICATE` (unique_violation)** if the email or phone already exists | none |
| `customer_login` | `p_identifier, p_pwd` | `TABLE(id,name,email,phone,height,type_preference,created_at,birth_date,country,city,photo,session_token)` | throttles (see §4.1); **reuses the existing token** rather than minting; upgrades a legacy sha256 hash to bcrypt | none |
| `customer_exists` | `p_email, p_phone` | boolean | — | none |
| `customer_reset` | `p_email, p_phone, p_new_pwd` | same row as login | identity = **email + phone must both match** (digits compared with suffix tolerance, ≥7 digits); refuses `oauth:google` accounts; requires ≥8 chars; **mints a new token** | none |
| `customer_oauth_login` | `p_email` | login row | — | none |
| `customer_oauth_signup` | `p_id,p_name,p_email,p_phone,p_height,p_type_preference,p_gender,p_photo` | `TABLE(id, session_token)` | — | none |
| `customer_update_profile` | `p_id,p_token,p_name,p_email,p_phone,p_height,p_type_preference,p_birth_date,p_country,p_city` | boolean | — | token |
| `customer_update_profile` (11-arg) | same + `p_nationality` | boolean | the 10-arg overload stays for older clients | token |
| `customer_profile` | `p_id,p_token` | `TABLE(id,name,email,phone,height,type_preference,created_at,birth_date,country,city,photo,gender,nationality,socials)` | the login/reset RPCs return a fixed column list without `nationality`; the app asks this once per page life | token |
| `customer_set_socials` | `p_id,p_token,p_socials jsonb` | boolean | keeps only the four known keys, trims `@`/slashes, 100 chars each; null when empty | token |
| `customer_pwd_state` | `p_id,p_token` | boolean | true while the password is a temporary one from a community approval (`must_change_pwd`) | token |
| `customer_set_own_password` | `p_id,p_token,p_new_pwd` | text (new session token) | only while `must_change_pwd`; 8+ chars, an upper-case letter and a digit, not the temporary one; raises NO_CHANGE_DUE / WEAK_PASSWORD / SAME_PASSWORD. (`customer_change_password`, token-only, was dropped 2026-09-22.) | token |
| `customer_set_photo` | `p_id,p_token,p_photo` | boolean | — | token |
| `my_bookings` | `p_id,p_token` | `SETOF queue_entries` | **the customer's private read** — all their rows, full PII | token |
| `list_sessions` | `p_id,p_token` | `SETOF sessions` | ungated sessions **plus** any whose `required_tag_id` the caller holds **actively**; a bad/absent token returns ungated only | token optional |
| `community_member` | `p_id,p_token` | boolean | does the caller hold an **active** tag with slug `saturday` | token |
| `customer_create_booking` | `p_id,p_token,p_entries jsonb` | `TABLE(id, queue_num, status, waitlist_num, price)` | **the booking path** — see §4.2 | token |
| `customer_booking_update` | `p_id,p_token,p_entry_id,p_patch jsonb` | boolean | whitelist patch of the caller's own booking | token + ownership |
| `customer_shiftdown` | `p_id,p_token,p_session_id,p_from_num` | boolean | closes queue-number gaps after the caller's own cancel | token |
| `customer_addon_stock` | `p_id,p_token,p_items jsonb` | boolean | applies **relative** `qty = greatest(qty + delta, 0)` per item; each delta clamped to ±20 | token |
| `customer_push_subscribe` | `p_id,p_token,p_endpoint,p_p256dh,p_auth,p_ua` | boolean | upsert on endpoint; refuses past 20 subscriptions per customer | token |
| `customer_push_unsubscribe` | `p_id,p_token,p_endpoint` | boolean | — | token |
| `staff_email_for_phone` | `p_phone` | text | staff-login helper | none |
| `staff_mark_pwd_changed` | — | void | clears `must_change_pwd` | Supabase Auth |
| `staff_set_customer_password` | `p_customer_id,p_new_pwd` | boolean | resets a customer's password (≥8 chars) **and rotates their session token** | `is_staff()` |
| `is_staff` | — | boolean | — | Supabase Auth |
| `customer_token_ok` | `p_id,p_token` | boolean | public wrapper over `_cust_token_ok` | none |

### 4.1 Login throttle (exact numbers)

`customer_login` locks an identifier for **15 minutes after 8 consecutive failures**
(`nfails >= 8 → locked_until = now() + interval '15 minutes'`) and raises `LOCKED` (SQLSTATE
`P0001`) while locked. A success deletes the row. A just-expired lock resets the counter to 0.

### 4.2 `customer_create_booking` — the rules it enforces itself

- token must be valid and the customer must exist;
- `p_entries` must be a **JSON array of 1…10** items, all with the **same `session_id`**;
- the session must exist with status `open` or `full` — otherwise nothing is inserted;
- status is set to `waitlist` **iff the session status is `full`**, else `waiting`
  (the capacity guard may then still flip `waiting`→`waitlist`);
- `approval` is set to `'pending'` iff `needs_approval`, else NULL;
- **the "on the house" perk** is applied to the **first entry only**, and only when its name
  matches the account holder's name case-insensitively and the type is covered by
  `customers.default_pay`;
- name/phone/email are truncated (60/30/120);
- `assigned_bike_id` is always NULL;
- `walk_in` is always false.

The client wrapper `_createBookings()` ([app.src.html:1836](../app.src.html#L1836)) calls this RPC
and **falls back to a direct insert only when the function itself is missing** (PGRST202 /
42883 / "could not find" / "does not exist"); any real refusal is surfaced.

---

## 5. Cloudflare Pages Functions

| Route | File | Method | Inputs | Output | Auth | Dormant unless |
|---|---|---|---|---|---|---|
| `/api/booking-confirm` | [functions/api/booking-confirm.js](../functions/api/booking-confirm.js) | POST | `{customerId, token, bookingId}` | `{ok}` | re-reads the booking through `my_bookings` with the caller's own token — **never trusts a client-supplied email** | `BREVO_API_KEY` + `BREVO_SENDER` |
| `/api/push-send` | [functions/api/push-send.js](../functions/api/push-send.js) | POST | `{staffToken, customerId, title, message, url, tag}` | `{ok, sent, total, removed}` | verifies `staffToken` against `is_staff()` **before sending**; reads `push_subscriptions` with the service key | `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` + `SUPABASE_SERVICE_KEY` |
| `/api/wallet-pass` | [functions/api/wallet-pass.js](../functions/api/wallet-pass.js) (built from [scripts/wallet/wallet-pass.src.js](../scripts/wallet/wallet-pass.src.js)) | POST | `{customerId, token, bookingId, addons[], groupIds[]}` | `.pkpass` binary, or **501** when unconfigured | re-reads via `my_bookings`; `groupIds` are filtered to rows the caller owns | `APPLE_PASS_P12_BASE64`, `APPLE_PASS_P12_PASSWORD`, `APPLE_PASS_TYPE_ID`, `APPLE_TEAM_ID` |
| `/api/log-error` | [functions/api/log-error.js](../functions/api/log-error.js) | POST | `{msg, src, ua}` | `{ok}` | public; truncates to 400/200/160 chars and throttles to **1 per 30 s per isolate** | `DISCORD_WEBHOOK` |
| *(all paths)* | [functions/_middleware.js](../functions/_middleware.js) | any | — | 404 for blocked paths | — | always on |

**Every one of these is a no-op when its env vars are absent**, which is why they are safe to
deploy before the credentials exist. `push-send` and `wallet-pass` are currently **dormant in
production** (VAPID and Apple certs not yet set).

The middleware denylist blocks: `.sql .md .ts .mjs .lock .yml .yaml .toml .map .cjs .env .sh`,
any `.json` except `/manifest.json` and `/lang/<code>.json`, `app.src.html`, `/tests/`,
`/scripts/`, `/functions/`, `/design_handoff_erp_reskin/`, `/.github/`, `/.claude/`, and all
dotfiles. It matches on the **fully decoded, lowercased** path to defeat `%2E` tricks.

---

## 6. Realtime

Postgres-changes subscriptions are enabled on exactly these tables (publication
`supabase_realtime`):

`bikes`, `cashier_sales`, `inventory`, `queue_entries`, `sessions`, `desk_waitlist`

Note `desk_waitlist` **is** in the publication (the older handoff document predates it).
`customers`, `customer_tags` and `tags` are deliberately **not** — they are staff-only PII.

---

## 7. Client-side storage (part of the data model in practice)

40 `localStorage` keys, all prefixed `cq_`. Several hold data that has **no server counterpart**
— a new implementation that ignores them will lose behaviour.

| Key | Holds | Server counterpart? |
|---|---|---|
| `cq_session` / (sessionStorage) `cq_session` | the customer session `{id,…,session_token}`; localStorage when "remember me" is on, sessionStorage otherwise | — |
| `cq_book_outbox` | **bookings made offline**, awaiting flush | none — pure client durability |
| `cq_book_outbox_bad` | bookings the server refused | none |
| `cq_sales_outbox` | POS sales made offline | none |
| `cq_sales_voided` | ids of deleted sales, so an RLS-blocked DELETE (which returns no error) can never resurrect a void | none |
| `cq_snapshot` | cold-start data cache (photos stripped) | — |
| `cq_staff` | `'1'` = this device is unlocked for staff | — |
| `cq_role` | `admin` \| `frontdesk` | mirrors `staff.role` |
| `cq_secure_auth` | `'1'`/`'0'` override for SECURE_AUTH | — |
| `cq_lang`, `cq_density`, `cq_rail`, `cq_inv_view` | UI preferences (`cq_theme` / `cq_staff_theme` are cleared at boot: the site is light only) | — |
| `cq_inv_cats_eq`, `cq_inv_cats_supp`, `cq_inv_brands_eq`, `cq_inv_brands_supp`, `cq_inv_flavs_by_brand`, `cq_protein_subtypes` | **staff-created inventory categories, brands and flavours** | **none — these exist only on the device that created them** |
| `cq_bk_locations`, `cq_bk_brands`, `cq_bk_models`, `cq_bk_groupsets` | same, for bikes | **none** |
| `cq_team` | team roster cache | `team_members` |
| `cq_pin_until`, `cq_pin_lockouts`, `cq_pin_attempts` | staff PIN lockout state | — |
| `cq_nav`, `cq_nav_ctab`, `cq_nav_stab` | last location, restored only on a same-tab reload | — |
| `cq_errors`, `cq_full_log`, `cq_cancellations` | local logs | `error_log`, `staff_actions` |
| `cq_op_name` | operator name for the audit trail | — |
| `cq_device_id` | device id for the audit trail | — |
| `cq_push` | push subscription state | `push_subscriptions` |
| `cq_weather`, `cq_rep_opts`, `cq_an_rev_target`, `cq_scan_cont`, `cq_upd_reload`, `cq_staff_entry`, `cq_ct_*` | misc UI state | — |

> **Ambiguity flagged:** the inventory/bike taxonomy keys (`cq_inv_cats_*`, `cq_bk_*`) are
> device-local. Two staff tablets can therefore offer different category lists for the same
> fleet. The code contains no sync path for them. Whether this is intended or an accepted
> limitation is **not determinable from the code** — a new implementation should decide
> explicitly and, if it moves them server-side, must seed from `EQUIP_CATS`/`SUPP_CATS`
> ([app.src.html:14204](../app.src.html#L14204)).
