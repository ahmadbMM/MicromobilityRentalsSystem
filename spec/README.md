# /spec — MicroMobility Rentals, implementation-ready specification

A complete behavioural and visual specification of the current live system, written so a
designer and a developer who have never seen this codebase can recreate it exactly as the
"Rides" section of the new Next.js platform.

**Nothing here proposes changes.** It documents what exists as of **2026-08-26**, at commit
`6f2f8e0`.

## The documents

| File | What it answers | Size |
|---|---|---|
| [SCREENS.md](SCREENS.md) | What is on every screen and modal, what each control does, and the **exact copy in English and Arabic** (all 1,734 keys) | ~2,570 lines |
| [FLOWS.md](FLOWS.md) | Every user journey end to end, as numbered steps with branches, and every automatic behaviour | ~500 lines |
| [BUSINESS-RULES.md](BUSINESS-RULES.md) | Every rule the code enforces, with the file and function that owns it | ~745 lines |
| [DATA-MODEL.md](DATA-MODEL.md) | Every table, column, type, relationship, RPC, trigger, policy and Pages Function | ~520 lines |
| [DESIGN-SPEC.md](DESIGN-SPEC.md) | Colours, type, spacing, radii, shadows, motion, breakpoints, component states, RTL | ~470 lines |
| [INTEGRATIONS.md](INTEGRATIONS.md) | Supabase, realtime, offline/outbox, PWA, push, wallet, email, scanner, hosting | ~395 lines |
| [PARITY-CHECKLIST.md](PARITY-CHECKLIST.md) | 280 testable statements the new version must satisfy | ~360 lines |

## How they were produced

- **Schema, RPCs, triggers, policies and indexes** were read from the **live production
  database** (`amyqxovbnlreassrqihr`, production until the move to `qpffkzmsfyilicwcsszz` on 2026-10-02) via `information_schema` / `pg_proc` / `pg_policies` /
  `pg_indexes` / `pg_trigger` — not from migration files, which can lag.
- **Client behaviour** was read from [`app.src.html`](../app.src.html) (17,969 lines), the only
  editable source. `index.html` is a generated build artefact and was ignored.
- **Copy** was extracted programmatically from the `LANG` object and the built
  [`lang/ar.json`](../lang/ar.json) / [`lang/es.json`](../lang/es.json) packs, so it is verbatim.
- **Design tokens** were extracted from [`styles.css`](../styles.css) by parsing the rule blocks.
- **The parity checklist** was derived from the 87-file Playwright suite plus direct reading;
  each item is marked as test-backed **[T]** or read-only **[R]**.

All 223 `file:line` citations were validated against the current files.

## Conventions used throughout

- 🟢 client-only rule · 🔵 database-only rule · 🟣 enforced in both (they must agree)
- **[T]** already covered by an automated test · **[R]** derived by reading · **[⚠]** a known
  defect or inconsistency in the current system

## Three things to read first

1. **[BUSINESS-RULES.md §1](BUSINESS-RULES.md#1-ride-types--the-taxonomy-everything-else-keys-off)** —
   there are three ride types, distinguished by two columns, and five separate predicates ask
   five different questions about them. Almost every bug in this system's history came from
   conflating them.
2. **[DATA-MODEL.md §0](DATA-MODEL.md#0-conventions-that-apply-to-the-whole-schema)** — ids are
   client-generated text, timestamps use three different encodings, and several `text` columns
   hold JSON, comma lists or sentinel values.
3. **[DESIGN-SPEC.md §0](DESIGN-SPEC.md#0-the-single-most-important-thing-to-understand-first)** —
   three visual identities are layered in one stylesheet; what customers see and what staff see
   are different layers.

## Where the spec says "I don't know"

Ambiguities are flagged inline rather than guessed. The main ones:

- The **wallet pass** has no explicit community-ride branch, though community bookings are not
  supposed to get one (INTEGRATIONS.md §5).
- **Inventory and bike taxonomies** (categories, brands, flavours) live only in `localStorage`
  and never sync between devices; whether that is intended is not determinable from the code
  (DATA-MODEL.md §7).
- **`customer_shiftdown`** still renumbers server-side although the client's own shift is a
  deliberate no-op (BUSINESS-RULES.md §5.3).
- **Layer 1's motorsport visual identity** is largely overridden but not deleted; whether that is
  residue or an unfinished migration is unclear (DESIGN-SPEC.md §10).

## Defect status

The defects found while writing this spec were documented first, then fixed on 2026-08-26.
What changed, and what did not:

| Defect | Status |
|---|---|
| A place freed by a **removal** promoted nobody | **Fixed** — `doRemove` now promotes, as cancel and no-show already did |
| A place freed by the **customer's own cancellation** promotes nobody | **Open.** It cannot be fixed in the client: promotion writes `queue_entries.status`, which is `is_staff()`-only, so a customer's write affects zero rows and returns no error. Three server-side options are set out in BUSINESS-RULES.md §4.7 |
| **Staff stock writes were absolute**, so two tills overwrote each other | **Fixed** — now a delta under a compare-and-swap, retried against a fresh read when contended, with the on-screen count still moving immediately |
| The **customer stock RPC clamps at zero**, contradicting the deliberate-negative rule | **Open** — a one-line migration, not yet applied |
| A **bulk check-in stamped `checked_in_at`** on rows whose status write was refused | **Fixed** — only rows that actually checked in are stamped |
| Password reset failing with a dropped request, with no retry | **Hardened** — reset and login now retry once on a network-layer failure; signup deliberately does not, so a landed insert is never repeated. Root cause not established |
