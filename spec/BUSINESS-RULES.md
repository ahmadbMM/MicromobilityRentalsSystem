# BUSINESS-RULES.md — MicroMobility Rentals

Every rule the code actually enforces, with the file and function that owns it.

**Read this first:** many rules are enforced **twice** — once in the client (so the rider is
told *why*) and once in the database (so it is true regardless of client). Where that is the
case both are listed, and **the database is the boundary**. A new implementation may replace
the client half freely; replacing the server half changes the system's guarantees.

Legend: 🟢 client-only · 🔵 database-only · 🟣 both (client + DB, must agree)

---

## 1. Ride types — the taxonomy everything else keys off

There are **three** kinds of ride, distinguished by two columns.

| Ride | `event_kind` | `ride_kind` | `needs_approval` | `paid_ride` | Predicate |
|---|---|---|---|---|---|
| **JCC / Evening Circuit** | NULL or `jcc` | — | false | false | `!_isCommunity(s)` |
| **Saturday Social Ride** | `community` | `saturday` or NULL | **true** | false | `_rideKind(s)==='saturday'` |
| **Petromin's Wednesdays** | `community` | `petromin` | **false** | **true** | `_isGroupRide(s)` |
| **Triathlon Pool Session** | `community` | `swim` | **true** | false | `!_needsBike(s)` |
| **T100 Triathlon Prep** (was Micromobility Triathlon Workshop) | `community` | `workshop` | **true** | false | `_openToAll(s)` — `open_to_all=true` lifts the members gate; otherwise the Saturday shape, bike-free |

```js
function _isCommunity(s){return s&&s.event_kind==='community';}                    // app.src.html:3631
function _rideKind(s){return !_isCommunity(s)?'jcc':(s&&s.ride_kind==='petromin'?'petromin':'saturday');} // :3638
function _isFreeRide(s){return _isCommunity(s)&&!(s&&s.paid_ride);}                // :3641
function _isGroupRide(s){return _isCommunity(s)&&_rideKind(s)==='petromin';}       // :3643
function _isApprovalRide(s){return _isCommunity(s)&&(s.needs_approval!==false);}   // :3653
```

**The predicates are deliberately split by *question asked*, not by ride name.** A new
implementation must keep them separate or the Petromin ride breaks:

| Question | Predicate | Why it is its own test |
|---|---|---|
| Who may book? | `_isCommunity` minus `_openToAll` | the community rides share the members gate; the workshop's `open_to_all` lifts it (the DB trigger reads the same column) |
| Does it cost money? | `_isFreeRide` | Petromin is community **and** charges |
| Does it have an approval step? | `_isApprovalRide` | Petromin is community **and** has none |
| How many riders per booking? | `_isGroupRide` | Saturday is solo, Petromin takes 4 |
| Does this booking hold a place? | `_holdsSpot` | see §4 |
| Is there a bike at all? | `_needsBike` | a swim session has no size, no type and no bike to hand over |

> **Rows written before the migration carry `ride_kind = NULL` and must read as Saturday**
> ([app.src.html:3638](../app.src.html#L3638)). Same for `event_kind`: NULL and `jcc` both mean circuit.

---

## 2. Eligibility and membership gating

### 2.1 The gate itself 🟣

**Membership = holding an ACTIVE `customer_tags` row whose tag slug is `saturday`.**

- **Client (UX)**: `community_member(p_id, p_token)` RPC, cached per customer id. A non-member
  who taps a community ride gets the "Community members only" dialog
  (`showCommMembersModal()`, [app.src.html:3749](../app.src.html#L3749)).
- **Database (boundary)**: the `_community_booking_gate` trigger on INSERT **and** UPDATE raises
  `This ride is for community members only.` unless the row's `customer_id` holds an active
  `saturday` tag. **Staff are exempt** via `is_staff()`.

The gate must be applied at **three** client points — the event card, the session card in the
booking wizard, and again at submit — but the trigger is what actually enforces it.

### 2.2 "Active" is window-aware 🟣

A tag row counts only while `now ∈ [starts_at, expires_at)` — **start inclusive, expiry
exclusive**, NULL on either side = unbounded.

- SQL: `_ctag_active(p_starts, p_expires)` — compares against `extract(epoch from now())*1000`.
- Client: `_tagActive()`.

Both use **milliseconds since epoch**, not timestamps.

### 2.3 Tags are invisible to customers 🔵

`customer_tags` and `tags` are staff-only under RLS, and **not** in the realtime publication.
No customer-facing API returns tag data — `community_member` returns a bare boolean. A new
implementation must not leak the existence of the tag system to riders.

### 2.4 Auto-granted tags 🔵

`_grant_auto_tags` fires on `customers` INSERT and grants every tag with `auto_grant = true`.
Today that is `tag_jcc` only. `tag_saturday` is `auto_grant = false` — invite-only.

### 2.5 Session *visibility* is a separate gate from booking 🔵

`sessions.required_tag_id` gates **visibility**:
- RLS policy `public read ungated`: `USING (required_tag_id IS NULL)`;
- `list_sessions(p_id, p_token)` returns ungated rows **plus** rows whose required tag the
  caller actively holds; a bad or absent token returns ungated only.

**Community sessions are created with `required_tag_id = NULL`** — they are *visible* to
everyone and *bookable* only by members. That is deliberate: the ride is advertised, the
booking is gated.

### 2.6 Per-customer type hiding 🟢

`customers.hidden_types` (comma list) removes those bike types from **that customer's** picker
only. Staff pickers are never filtered. `_hiddenTypes()` ([app.src.html:1900](../app.src.html#L1900)).

---

## 3. Pricing

### 3.1 The price table 🟣

Client constants ([app.src.html:2247](../app.src.html#L2247)):

```js
const DEFAULT_PRICE = 57.5;
const RIDE_PRICES     = {Road:75, Mountain:57.5, Hybrid:57.5, Any:57.5,  'Road Carbon':250, Own:0};
const RIDE_PRICES_MAX = {Road:75, Mountain:57.5, Hybrid:57.5, Any:75,    'Road Carbon':250, Own:0};
const PREMIUM_TIERS   = {'Road Carbon':'Road'};   // tier -> fleet type that fulfils it
```

Server table `ride_prices` holds the same numbers (verified identical in production). **There is
no `Own` row in `ride_prices`** — that is what lets an own-bike booking stay at 0.

- `Any` displays as a **range** `SAR 57.5 - 75`, because the bike actually handed out decides it
  (`priceDisplay()`, [app.src.html:2258](../app.src.html#L2258)).
- **`Road Carbon` is a price tier, not a fleet type.** It is fulfilled with a `Road` bike.
  Repricing from the assigned bike would silently drop 250 → 75, so both `_entryFallbackPrice()`
  ([app.src.html:2268](../app.src.html#L2268)) and the bike-assign path check `PREMIUM_TIERS` first.

### 3.2 Server price enforcement 🔵 — `_enforce_booking_price`

Fires on INSERT and UPDATE of `queue_entries`:

1. **staff UPDATE → return unchanged** (staff may price anything);
2. **community && !paid_ride → `price := 0`**, unconditionally;
3. if **no bike assigned**, **not paid**, and status ∈ (`waiting`,`waitlist`):
   - canonical = `ride_prices[type_preference]`;
   - with a **valid promo** → `price := least(greatest(sent, 0), canonical)` — a discount is
     allowed, a markup is not;
   - without a promo → `price := canonical` (**the client's number is ignored**);
   - no canonical row → `price := clamp(sent, 0, 1000)`;
4. always finally `price := clamp(price, 0, 1000)`.

**A tampered client cannot cheapen a booking.** Once a bike is assigned or the row is paid, the
trigger stops interfering so staff pricing sticks.

### 3.3 Free rides 🟣

A community ride with `paid_ride = false` is free everywhere: no price, no pay toggle, no
add-ons in the UI (`_isFreeRide` / `_freeSessIds`), and `price := 0` in the trigger.

### 3.4 "On the house" 🟣

`customers.default_pay` is either `house` (all types) or `house:Road,Hybrid` (listed types).
Applied when a **new** booking row is created:

- **Client**: `_custHouseFor()`, `_regHouseFor()`, `_regHouseSelf()`
  ([app.src.html:1883](../app.src.html#L1883)–[1898](../app.src.html#L1893)).
- **Server**: `customer_create_booking` applies it to the **first entry only**, and only when
  that entry's name matches the account holder's name case-insensitively.

**Co-riders booked under the same account still pay.** The price preview must not promise a comp
when a friend's name is typed into rider 1 — that is exactly what `_regHouseSelf()` guards.

### 3.5 Bike-derived pricing 🟢

`priceForBike()` ([app.src.html:2262](../app.src.html#L2262)): `Road`/`Mountain`/`Hybrid` use the
type price; anything else falls back to `bikes.rental_price`, then the type price.

### 3.6 VAT 🟢

Analytics shows revenue **VAT-inclusive by default** with an exclusive toggle; exclusive is
`value / 1.15` (15%). `excVAT()` / `sarBoth()` ([app.src.html:16453](../app.src.html#L16453)).
VAT is never stored — it is a display transform only.

---

## 4. Capacity, places and the waitlist

### 4.1 What holds a place 🟣

```js
function _holdsSpot(e){
  return !!e && e.status!=='cancelled' && e.status!=='removed' && e.status!=='noshow' && !_isOwnBike(e);
}
```
[app.src.html:2327](../app.src.html#L2327)

The SQL guard counts the identical set:
`status NOT IN ('cancelled','removed','noshow') AND type_preference <> 'Own'`.

**The two must agree or the form and the server disagree about who is next.**

Rationale, and it is the whole point of the rule: a place is taken when booked and **held right
through the ride**. Checking in does not release it; finishing does not release it. It is
released only when the booking ends *without a bike going out* — cancelled, removed, or a
no-show. (Before 2026‑08‑25 the guard counted only `waiting`/`active`, so places quietly
reappeared as the evening went on and a 40-bike evening could serve more than 40 people —
[supabase/migrations/20260825120000_capacity_counts_every_place_taken.sql](../supabase/migrations/20260825120000_capacity_counts_every_place_taken.sql).)

### 4.2 Own-bike riders never consume a place — except on the Petromin ride 🟣

`type_preference = 'Own'` is outside the count on both sides. Places allocate **Micromobility
bikes**, and a rider on their own bike takes none. Staff can therefore seat any number of bike
owners on top of a "full" allocation.

**The Petromin ride is the one exception.** Its places are the track's, not the rack's: the
venue admits N riders and an owner is one of them, so `Own` rows count against capacity there,
in the client (`_ownTakesPlace` / `_holdsSpot(e, sess)`) and in both triggers. The fill rule
also writes `closed` rather than `full` on that ride and leaves an `_ac` marker in `bike_slots`
so it can undo its own close; staff see such a session as **Fully Booked**, and re-opening it
by hand only lasts until the next booking write —
[supabase/migrations/20260916190000_petromin_owners_take_a_place.sql](../supabase/migrations/20260916190000_petromin_owners_take_a_place.sql).

### 4.3 Which number is the cap 🟣

```js
function spotsLeft(sid){
  const sess = S.sessions.find(s=>s.id===sid);
  if(_isApprovalRide(sess)){
    const cap = (sess&&sess.spots) || (sess&&sess.capacity) || 12;   // approval rides prefer `spots`
    return Math.max(0, cap - getQueue().filter(e=>e.sessionId===sid && _holdsSpot(e)).length);
  }
  const cap = (sess&&sess.capacity) || 12;                            // everything else uses `capacity`
  return Math.max(0, cap - getQueue().filter(e=>e.sessionId===sid && _holdsSpot(e)).length);
}
```
[app.src.html:2330](../app.src.html#L2330)

The DB guard reads **`capacity` only** and **exempts approval rides entirely**
(`WHERE coalesce(s.needs_approval,false) = false`). The two never disagree, but only because
the guard skips precisely the case where the client prefers `spots`.

Default when neither is set: **12**.

### 4.4 Overflow to the waitlist 🔵

`_capacity_guard` (BEFORE INSERT and UPDATE): if `status='waiting'`, type ≠ `Own`, caller is not
staff, and the session is not an approval ride — take `pg_advisory_xact_lock(hashtext('cap:'||session_id))`,
count live places, and if `count >= capacity` **rewrite `status` to `waitlist`**.

The advisory lock is what makes two simultaneous bookings safe.

`customer_create_booking` additionally sets `waitlist` outright when the **session status is
`full`** — a staff-set flag, independent of the count.

### 4.5 Waitlist size cap 🟢

Stored inside `bike_slots` as `_wl:{m:'count'|'pct', v:N}` — no schema change
([app.src.html:2354](../app.src.html#L2354)).

- `m='count'` → cap is `floor(v)` riders;
- `m='pct'` → cap is `round((spots||capacity) * v/100)`, **minimum 1**;
- missing, or `v <= 0` → **unlimited**.

`waitlistRoom(sid)` returns `Infinity` when uncapped. **This is client-only** — nothing in the
database enforces a waitlist size.

### 4.6 Waitlist ordering 🟣

- `waitlist_num` is assigned by `_wl_num_assign` (BEFORE INSERT/UPDATE) as `max+1` for the
  session, under `pg_advisory_xact_lock(hashtext('wlnum:'||session_id))`, unless a valid unique
  one is already set.
- Staff may reorder; every move renumbers the session's waitlist `1..n`
  (`_wlApplyOrder()`, [app.src.html:4795](../app.src.html#L4795)).
- Ordering comparator: `waitlist_num` ascending, then `registered_at`
  (`_wlCmp`, [app.src.html:4791](../app.src.html#L4791)).

### 4.7 Auto-promotion 🟢

`_autoPromoteOldestWaitlist(sessionId)` ([app.src.html:11004](../app.src.html#L11004)):

1. **returns false immediately for approval rides** — the Saturday ride never auto-promotes;
2. picks W1 by `_wlCmp`;
3. writes `status='waiting'` with a **conditional update** `.eq('status','waitlist').select('id')`
   — if the row was already promoted by another device, it claims nothing;
4. retires any linked Waitlist-screen row;
5. **consumes the booking's add-on stock** (a waitlisted booking held none);
6. sends a **push notification** to the rider.

**It is wired to four events**: staff cancel (two code paths, `staffCancelEntry`), no-show
(`doNoShow`), and — since 2026-08-26 — **removal** (`doRemove`), which frees a place on exactly
the same terms and previously handed it to nobody.

> **⚠ One gap remains, and it cannot be closed in the client.** The customer's own
> `cancelBooking()` frees a place and promotes nobody. It is not an oversight that this was
> never wired: `_autoPromoteOldestWaitlist` promotes by writing `queue_entries.status`, and that
> table's UPDATE policy is `is_staff()`. A customer's write matches no policy, affects zero rows
> and returns **no error** — so calling it there would look fixed and silently do nothing.
> Closing it properly needs one of:
> 1. a `SECURITY DEFINER` RPC that promotes and consumes the add-on stock server-side, called
>    from the customer path (no double-promotion risk, staff paths unchanged); or
> 2. a reconciliation sweep on staff devices — promote whenever an open session has free places
>    and waiting riders — which self-heals every release path, including capacity increases; or
> 3. a database trigger, which must then be exempted for `is_staff()` or it will double-promote
>    against the client-side call that staff paths already make.
> Option 1 is the narrowest. None is shipped.

---

## 5. Queue numbers

### 5.1 Assignment 🔵

`assign_queue_num` (BEFORE INSERT) sets

```sql
last_qnum := greatest(coalesce(last_qnum,0), coalesce(max(queue_num),0)) + 1
```

on the session row and stamps it. **The client's `queue_num` is always overwritten** — it sends
a guess only so the optimistic ticket has something to show.

### 5.2 Uniqueness 🔵

```sql
CREATE UNIQUE INDEX queue_entries_session_qnum_uniq
  ON queue_entries (session_id, queue_num)
  WHERE status NOT IN ('cancelled','removed','noshow');
```

Cancelled, removed and no-show rows keep their number but do not block it.

### 5.3 Numbers never shift 🟢

```js
async function _shiftDownAfter(sessionId, fromNum){ /* intentionally does nothing - numbers never shift */ }
```
[app.src.html:2471](../app.src.html#L2471)

This is a **deliberate no-op**. It used to renumber rows down, which contradicted the "a #6
ticket stays #6" guarantee and was a fragile non-atomic multi-row rewrite. Call sites are left
in place so the intent stays readable. **Gaps in the numbering are correct and expected.**

> Note the tension: the RPC `customer_shiftdown` still exists and *does* renumber. Whether it is
> still reachable from the client is **not** determinable from the SQL alone; the client's own
> shift is disabled.

### 5.4 Restoring a number 🟢

`_restoreNum()` ([app.src.html:2473](../app.src.html#L2473)) gives an undone booking its old
number back **if still free among live rows** (`waiting`,`active`,`done`,`waitlist`), else a
fresh one.

### 5.5 Update collisions 🔵

`queue_num_update_guard` (BEFORE UPDATE): if a `queue_num` change would collide with a live row,
it mints a fresh number from `last_qnum` instead of failing.

### 5.6 Community numbers are private 🟣

`bookingRef()` ([app.src.html:2202](../app.src.html#L2202)) omits the number for approval rides:

```
circuit   : MMC-<queue_num>-<id[0:6]>
community : MMC-<id[0:6]>
```

The QR payload is customer-visible (any camera decodes it), so a community payload must never
carry the queue number. The staff scanner accepts **both** forms.

---

## 6. Bike size and type matching

### 6.1 Height → size 🟢

```js
function heightToSize(h){ if(h<=166)return'XS'; if(h<=172)return'S'; if(h<=178)return'M'; return'L'; }
```
[app.src.html:2568](../app.src.html#L2568)

Labels: `XS (166 cm & under)`, `S (167-172 cm)`, `M (173-178 cm)`, `L (179 cm & up)`.

### 6.2 The bike picker 🟢

`renderModal()` ([app.src.html:12431](../app.src.html#L12431)):

- **excludes** `retired` and `maintenance` bikes entirely;
- `prefType = PREMIUM_TIERS[rider.typePreference] || rider.typePreference` — a Road Carbon
  booking is matched against **Road** bikes;
- bikes are split into **preferred type** and **other types** (empty when the rider chose `Any`);
- default sort ranks: available first → matching size → in this session's fleet → then name;
- a bike belongs to the session's fleet per `bike_slots` — `total` format accepts any bike,
  `counts` format requires `slots[type] > 0`, per-size format requires `slots[type][size] > 0`;
- filters: size, brand, model; search covers name, brand, model, type, size, groupset.

**Size is a sort preference, not a hard filter** — staff can hand out any size.

### 6.3 Bike claiming is atomic 🟢

```js
sb.from('bikes').update({status:'in-use'}).eq('id',bid).eq('status','available').select('id')
```
`_reclaimBikes()` ([app.src.html:12346](../app.src.html#L12346)) — a compare-and-swap. If the
row comes back empty another device won, and the caller releases whatever it did claim. The
same pattern guards `_claimReservedBikes()` on check-in.

### 6.4 Bike status transitions 🟢

`available → in-use` on check-in; `in-use → available` on return, cancel, no-show or removal.
`maintenance` and `retired` are staff-set only. Orphan cleanup on boot sets any bike with no
live booking pointing at it back to `available` ([app.src.html:2557](../app.src.html#L2557)).

### 6.5 Multiple bikes per row 🟢

`assigned_bike_id` may hold a **JSON array string** when one booking row takes several bikes;
`getAssignedBikeIds()` handles both shapes.

---

## 7. Bike type availability by ride

```js
const CUST_TYPES = ['Any','Road','Hybrid','Mountain','Road Carbon','Own'];
function bikeTypeOpts(allowOwn, noCarbon){
  return CUST_TYPES.filter(ty => (ty!=='Own'||allowOwn) && (ty!=='Road Carbon'||!noCarbon));
}
```
[app.src.html:2596](../app.src.html#L2596)

| Context | Call | Result |
|---|---|---|
| JCC | `bikeTypeOpts(false,false)` | Any, Road, Hybrid, Mountain, Road Carbon |
| Any community ride | `bikeTypeOpts(true,true)` | Any, Road, Hybrid, Mountain, **Own** |

**`Own` is exclusive to community rides and always free** (`RIDE_PRICES.Own = 0`), including on
the paid Petromin ride. **`Road Carbon` is withdrawn from every community ride**, paid or not —
and the DB backs this up: `_comm_no_carbon` silently rewrites `Road Carbon` → `Road` on insert
into any community session.

---

## 8. Party size

| Ride | Max riders per booking | Enforced by |
|---|---|---|
| JCC | **10** | `_maxRiders()` 🟢, plus `customer_create_booking` rejects a `p_entries` array longer than 10 🔵 |
| Saturday Social Ride | **1** (solo) | `_isGroupRide` is false → the quantity control is locked 🟢 |
| Petromin Wednesday | **2** | `GROUP_RIDE_MAX = 2` 🟢 **and** `_group_ride_cap` trigger 🔵 |

`_group_ride_cap` counts **live rows for the same `customer_id` on the same session**
(`status NOT IN ('cancelled','removed','noshow')`), so **booking twice cannot get around it** —
it is a per-account-per-session cap, not a per-submission one. Message:
`Up to 2 riders per booking on this ride.` Staff exempt.

---

## 9. Approval (Saturday Social Ride only)

### 9.1 Values and the NULL rule 🟣

`approval ∈ {pending, approved, rejected, NULL}`.

```js
function _apprOf(e){ return (e && e.approval) || 'pending'; }
```
[app.src.html:3687](../app.src.html#L3687)

**A NULL `approval` on a community booking MUST read as `pending`.** Rows predating the workflow
carry NULL and staff still have to select those riders.

### 9.2 Customers can never self-approve 🔵

`_approval_guard` (BEFORE INSERT/UPDATE): a non-staff caller inserting anything other than
`pending` has it forced to `pending`; a non-staff caller changing `approval` on update has the
change reverted to the old value.

Belt and braces: `customer_booking_update`'s patch whitelist **does not include `approval`** at
all, and `customer_create_booking` sets it from `needs_approval`, never from client input.

### 9.3 Results stay private until published 🟢

Community sessions are created with `hide_queue = true`. While set, riders see only "under
review" — never an approved/pending verdict, never a queue number. Publishing clears it.

### 9.4 Approval does not renumber 🟢

Approving keeps the booking's original queue number. Numbers are stable and hidden on these
rides anyway.

---

## 10. Promo codes

### 10.1 Validity 🟣

Server `_promo_valid(p_code, p_customer)`:

```sql
active = true
AND (expires_at IS NULL OR expires_at >= (now() at time zone 'Asia/Riyadh')::date)
AND (max_uses  IS NULL OR coalesce(uses,0) < max_uses)
AND (customer_id IS NULL OR customer_id = p_customer)
```

Matching is **case-insensitive** (`lower(code) = lower(p_code)`).

Client `applyPromoCode()` ([app.src.html:5791](../app.src.html#L5791)) checks the same three
conditions **only so the customer is told which one failed** — expired / used up / not yours —
rather than watching the discount silently fail to stick.

### 10.2 Usage counting 🔵

`_promo_count` on `queue_entries`:
- INSERT with a code → `uses += 1`;
- status moves **into** `cancelled`/`removed` → `uses -= 1` (floored at 0);
- status moves **out of** `cancelled`/`removed` → `uses += 1`.

So a cancelled booking gives its use back, and restoring it takes one again.

### 10.3 Where promos apply 🟢

Promo entry is offered on **JCC bookings only** — community rides are either free or fixed-fare.

### 10.4 A promo can only reduce 🔵

See §3.2: with a valid promo the price is clamped to `[0, canonical]`.

---

## 11. Booking creation

### 11.1 Status at creation 🟣

| Condition | Resulting status |
|---|---|
| session status = `full` | `waitlist` (set by `customer_create_booking`) |
| capacity reached | `waitlist` (rewritten by `_capacity_guard`) |
| otherwise | `waiting` |

### 11.2 Duplicate-booking guard 🟢

```js
const activeStatuses = ['waiting','active','waitlist'];
const existingActive = cust.id
  ? queue.find(e=>e.customerId===cust.id && e.sessionId===S.selSession && activeStatuses.includes(e.status))
  : (phone ? queue.find(e=>e.phone===phone && e.sessionId===S.selSession && activeStatuses.includes(e.status)) : null);
```
[app.src.html:5996](../app.src.html#L5996)

Matched **by account id, falling back to phone** for accountless bookings. On a hit the wizard
shows an "already booked" banner (scrolled into view) offering **Modify existing** instead of
double-booking. **This is client-only** — nothing in the database prevents a duplicate.

### 11.3 Queue-number race handling 🟢

On a unique-index collision the client resyncs and retries with fresh numbers, **up to 4
attempts**, rolling back partial group inserts before each retry.

### 11.4 Offline 🟢

A failed or offline insert is queued in `cq_book_outbox` with **stable client-generated ids**
so a replay cannot double-book; an optimistic ticket is shown. See INTEGRATIONS.md §2.

### 11.5 What the server ignores from the client 🔵

`customer_create_booking` overrides or forces: `queue_num` (trigger), `status`, `approval`,
`paid`, `price` (trigger), `assigned_bike_id` (always NULL), `walk_in` (always false),
`customer_id` (always the token holder). Name/phone/email are truncated to 60/30/120.

---

## 12. Check-in, return, and the booking lifecycle

### 12.1 Status machine 🟢

```
                 ┌── cancelled ──┐
waiting ──┬─────►│               │◄─── (restore) ──┐
          │      └── removed ────┘                 │
          ├─► active ──► done ──► (reopen) ──► active
          └─► noshow ──► (customer showed) ──► waiting
waitlist ──► waiting  (auto-promotion, or check-in direct)
```

- **`waitlist` → `active` directly**: since the Promote button was removed, *checking a
  waitlisted rider in* is how they leave the waitlist (`_checkinMany` accepts both `waiting`
  and `waitlist`, [app.src.html:10158](../app.src.html#L10158)).
- Check-in is a **conditional update** `.in('status',['waiting','waitlist']).select('id')`, so
  two devices cannot both check the same rider in.
- **A bike handover is one transaction.** With a bike in the Bike field, check-in goes through
  `staff_checkin(p_booking_id, p_bike_id)`: booking waiting/waitlist → active, bike available →
  in-use, `assigned_bike_id` and `checked_in_at` written, and one `bike_assignments` row opened —
  all under the existing triggers. Idempotent for the same booking + bike; a bike that is out is
  refused by name. `staff_return` closes the assignment (active → done; damaged → maintenance),
  `staff_swap_bike` closes it as `swapped` and opens another. `bike_assignments` is history, never
  read by the roster; `assigned_bike_id` stays the live pointer. Where the RPC is absent the
  classic status-guarded write runs unchanged (migration 20260911120000).
- **Paid is not checked in.** Marking a rider or a party paid never changes status; only a
  check-in (per rider, party **Check in (N)**, Staff List party, bulk bar, or scan) moves a
  rider to `active`. The On Bike count, "Bikes out" and every ride report count `active`/`done`
  rows only — a rider paid at the booth and handed a bike without a check-in is invisible to
  all of them (2026-09-08: 17 such riders on a session of ~100).

### 12.2 Add-on stock invariant 🟢

**A booking holds its add-on stock exactly while it is CONFIRMED (`waiting` or `active`); it
holds none while `waitlist`, `cancelled`, `noshow` or `removed`.**

Every transition must consume or restock; the pairing is spread across ~20 call sites
(`_consumeAddonsOnEnter` / `_restockAddonsOnExit` / `_addonsOnLeaveWaitlist`,
[app.src.html:7402](../app.src.html#L7402)–[7385](../app.src.html#L7409)).

Stock **may go negative** — that is deliberate (oversell/backorder). Clamping at 0 while refunds
add the full quantity back would mint phantom stock.

**Staff stock writes are a compare-and-swap** (`_invApplyDelta`): the movement is applied as a
delta conditional on the row still holding the value this device last saw, retried up to four
times against a fresh read when another till moved it first. The on-screen count still updates
immediately and is put back if the write is refused. Until 2026-08-26 this was an **absolute**
write from local state, so two tills selling the same item overwrote each other and stock
drifted upward — invisible until stock-take.

> **⚠ One inconsistency remains.** The customer path's `customer_addon_stock` RPC applies
> `qty = greatest(qty + delta, 0)` — atomic, but it **clamps at zero**, which contradicts the
> deliberate-negative rule above: a refund then adds the full quantity back onto a floor and
> mints stock that never existed. Closing it is a one-line migration (drop the `greatest`), not
> yet applied.

### 12.3 Payment 🟢

Methods: `cash`, `card`, `split` (with `card_amount`), plus the non-money markers `house`
(on the house) and `team`. The **Split** option is hidden entirely if the schema probe finds no
`card_amount` column, so a split can never be silently recorded as cash.

Close-out card/cash split: `card_amount ?? (pay_method === 'card' ? price : 0)`.

### 12.4 Return 🟢

Records `checked_out_at` and `ride_duration` (minutes), frees the bike(s), and offers a payment
prompt if still unpaid.

---

## 13. Cancellation

| Actor | Path | Rules |
|---|---|---|
| **Customer** | `cancelBooking(id, reason)` → `customer_booking_update` | may set `status` to `cancelled`, `waiting` or `waitlist` **only** (whitelist check in the RPC); cancels the **whole party**; restocks add-ons for rows that were `waiting`; **does not auto-promote** (see §4.7) |
| **Staff** | `staffCancelEntry(id)` | a `waitlist` row is cancelled immediately; a `waiting`/`active` row goes through a confirm dialog; anything else refuses with "cannot cancel"; frees bikes, restocks add-ons, **auto-promotes**, pushes an Undo |

**There is no time-based cancellation window anywhere in the code** — no cutoff, no fee, no
"cannot cancel within N hours" rule. A rider can cancel at any point while the booking is live.

**Cancelled bookings are restorable** by staff (with an over-capacity confirm; own-bike community
restores skip it), which is why `_restoreNum()` exists.

---

## 14. No-show

- Sets `status='noshow'`, frees the bike, restocks add-ons, **auto-promotes** the next waitlisted
  rider ([app.src.html:11030](../app.src.html#L11030)).
- **A no-show releases its place** (`_holdsSpot` excludes it) — the rider never took a bike out
  and should not hold one hostage.
- **The queue number stays reserved** — the unique index exempts `noshow`, but nothing hands the
  number to anyone else.
- Reversible: "Customer showed" → back to `waiting`, re-reserving add-on stock.

---

## 15. Session lifecycle

### 15.1 States 🟢

`open → full → closed`, plus `deleted` (soft). Staff may move between them freely.
- `full` is a **staff-set flag**, independent of the computed count. Customers see "Waitlist" on
  a full session.
- **Deleting is blocked while the session has bookings**; deleted sessions are restorable.
- Both `open` and `full` sessions accept bookings (`customer_create_booking` requires
  `status IN ('open','full')`).

### 15.2 Creation 🟢

- **JCC**: date, repeat 1–12 weeks, time range, capacity as either per-type/size counts or an
  explicit bike assignment (busy bikes excluded).
- **Community (both)**: title, spots or bike composition, `required_tag_id` stays NULL.
  - Saturday: `needs_approval=true`, `hide_queue=true`, `spots` set, gathering+start times,
    meeting point URL, breakfast spot.
  - Petromin: `needs_approval=false`, `hide_queue=false`, `spots=null`, bike composition drives
    `capacity`, **meeting point and breakfast fields are explicitly nulled**, plain start–end times.
- `ride_kind` and `paid_ride` are written in a **second, tolerant update** so an older database
  missing those columns cannot cost a Saturday ride its gate fields
  ([app.src.html:8276](../app.src.html#L8276)).

### 15.3 Time storage 🟢

Times live in `bike_slots._time` as `"21:00 - 23:00"`. For an **approval ride** the same field
means `"gathering - start"` and is rendered as two labelled times rather than a range
(`sessionTime()`, [app.src.html:2303](../app.src.html#L2303)).

---

## 16. Rate limits and abuse guards

| Guard | Limit | Where |
|---|---|---|
| Customer login | **8 failures → 15-minute lock** per identifier; success clears | `customer_login` + `login_throttle` 🔵 |
| Staff PIN | escalating lockouts: **1, 2, 5, 10, 15, 30, 45, 60, 120 minutes** | `PIN_LOCKOUT_MINS` ([app.src.html:1358](../app.src.html#L1358)) 🟢 |
| Push subscriptions | **max 20 per customer** | `customer_push_subscribe` 🔵 |
| Add-on stock delta | each item clamped to **±20** | `customer_addon_stock` 🔵 |
| Booking batch | **1–10 entries**, all same session | `customer_create_booking` 🔵 |
| Error webhook | **1 per 30 s** per isolate (server) + **120 s** client gate | `log-error.js` / [app.src.html:17917](../app.src.html#L17917) |
| Price | clamped to **0…1000** always | `_enforce_booking_price` 🔵 |
| Password | **minimum 8 characters** (reset and staff-set); client also requires one uppercase and one digit | RPCs 🔵 + client 🟢 |
| Field lengths | name 60, phone 30, email 120 | `customer_create_booking` 🔵 |

---

## 17. Roles

`staff.role ∈ {admin, frontdesk}`, mirrored to `localStorage.cq_role`.

**This is UX scoping, not a security boundary** — `is_staff()` makes no distinction, so a
front-desk user retains full database rights. Front desk sees only **Sales** and **Bookings**;
`isAdmin()` ([app.src.html:1360](../app.src.html#L1360)) gates the rest, including session
deletion and **account deletion**.

First-time staff carry `must_change_pwd = true` and are forced through a password change
(`staff_mark_pwd_changed`).

---

## 18. Account deletion (Admin only) 🟢

`deleteCustomerAccount(id)`:
1. **refuses while the rider has a live booking**;
2. **unlinks `queue_entries.customer_id` BEFORE deleting the customer** — this is a real FK and
   Postgres would otherwise refuse, leaving a half-deleted account;
3. deletes `customer_tags`, `customer_notes`, `push_subscriptions`;
4. **never deletes the booking rows** — the riding record and the name stay, so rosters,
   close-outs and analytics read exactly as before;
5. offers a full Undo that recreates the account and re-links the bookings.

---

## 19. Search behaviour (queue and waitlist screens) 🟢

One shared predicate ([app.src.html:2746](../app.src.html#L2746)):

- an **all-digit** query (optionally prefixed `#`) matches a booking number **from its first
  digit** (`42` is found by typing `4`), or any part of a phone, or — at 4+ digits — a raw
  booking-id prefix;
- a query prefixed **`W`** aims at the waitlist position instead;
- otherwise: name, phone, email, or the scanned `MMC-` reference (`_matchesRef`);
- **whatever matches is then widened to the whole party** (`_withParty`), keyed on
  `group_id` or, failing that, `customer_id + session_id` (`_partyKey`).

Party widening happens **inside the already-filtered set**, so an explicit status/pay/size filter
still means what it says.

---

## 20. Roster display limits 🟢

The Bookings list slices to **150 rows** with a "Show N more" button (+200) **only when viewing
All Sessions**. A **specific session lists in full** — it is bounded (the busiest ride so far ran
to 202 riders) and a truncated roster hid real people standing at the desk
([app.src.html:9960](../app.src.html#L9960)).

Cancelled and removed bookings are excluded from the Bookings list base set entirely
([app.src.html:9448](../app.src.html#L9448)).

---

## 20a. Rider profile gate 🟢

From a rider's **first booking** the **nationality**, and from the **fourth** the **birth date**
(the owner, 2026-10-09; both were after the eighth) — every row on the account counts, ridden, on the
bike, no-show, upcoming or waitlisted, except a cancelled one — the site opening on the account and
the next event pick (`selectEvent`, and the session card as a second guard) show one page before the
session list asking only what is due and missing, required, no close / later / back; Log out is the
only other way off. The server asks the same (`_customer_asks`, 20261009120000), so
`customer_create_booking` refuses the second booking without a nationality and the fifth without a
birth date (FIX_FIRST), and a rider who leaves by Log out meets the page again at the next sign-in. Saved through `customer_update_profile` with the rest of the
profile carried through, then the picked event opens. Never shown once the account carries
what is due; the page never mentions the count. Nationality is fetched once through
`customer_profile` before deciding — if that answer never comes (offline) the rider is not held
up. Birth dates in the future or implying an age under five are refused client-side.

## 21. Invariants that must survive any rewrite

1. Queue numbers are **stable, never reused, never shifted**; gaps are correct.
2. Customers never see community queue numbers or order — not in the UI, QR payloads, wallet
   passes, or calendar text.
3. The spots meter counts **rental bikes only**; own-bike riders are unlimited and invisible to it (the Petromin ride excepted — §4.2).
4. Community seats exist only through approval on the Saturday ride; customers cannot self-approve.
5. Membership = an **active** `saturday` tag, enforced in the RPC (UI), the insert trigger
   (security), and gated-session visibility.
6. Tags are invisible to customers.
7. **PII floor**: the anon key can never read `customers` or named bookings; public availability
   uses `queue_public` only.
8. Prices are server-validated; community free rides are always free; Road Carbon never appears
   on a community ride.
9. All money flows are representable in `cashier_sales` without schema changes (negative
   `__discount__` lines, `__cardmeta__` splits, `refunded`/`team`/`house` markers) — and
   aggregations must filter the meta lines.
10. Every string ships in EN + AR with full RTL; key parity is a CI gate.
11. Offline-first: two outboxes with stable-id dedup, the voided-sale guard, the cold-start
    snapshot.
12. Anything staff-destructive gets an **Undo**.
