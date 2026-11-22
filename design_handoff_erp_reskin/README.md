# Handoff: ERP-style reskin of the staff system (MicromobilityRentalsSystem)

**Repo:** `WebDevMicromobility/MicromobilityRentalsSystem` (branch `main`)
**Goal:** Rebuild the LOOK of the existing staff area (check-in, queue, POS, inventory, customers, analytics, settings) to match the MicroMobility ERP design in this bundle. **Keep every current function, section, flow, and piece of logic exactly as it is** — same features, same data calls, same handlers. Only the layout and design change.

## About the design files

- `Micromobility-ERP-reference.html` — self-contained reference of the full ERP design (open directly in a browser; a few small icons may not render offline — ignore). It shows the design system across 7 suites: Site, Rides, Commerce, People & CRM, Finance, Insights, System.
- `Report Template B - Green Banner.dc.html` (+ `support.js`, `doc-page.js`) — the print/report family (session report, receipts, invoices) already specified in detail in the earlier `design_handoff_session_report` bundle; included here as the print reference.

These are **design references created in HTML** — prototypes to copy values from, not code to ship. Recreate the design inside the repo's existing vanilla-JS architecture (`app.src.html` + `styles.css`), reusing the existing markup/handlers wherever possible and only re-clothing them.

The reference ERP has more suites than the repo has features. **Do not build new features to fill the shells.** Map only what exists today; the reference tells you how each kind of screen should look, not what to add.

## Fidelity

**High-fidelity.** Colors, type, spacing, table density, and component states are final. Where the repo has a widget the reference lacks, style it by analogy using the tokens below.

## Repo ground rules (do not violate)

- `index.html` is GENERATED — edit `app.src.html`, then `npm run build:html`. Commit both.
- `onclick="fn()"` global function names are load-bearing — never rename. Keep all `id`/`data-*` hooks and i18n `LANG` keys (CI enforces EN/AR/ES parity).
- Don't touch `sql/`, `functions/`, Supabase RPC calls, SECURE_AUTH paths, service worker, or test logic. Update test selectors only where they assert changed styling.
- Before committing: `npm run build:html && npm run lint && npm test`.
- New served assets (fonts) go into the `_redirects` allowlist.

## The ERP design language (staff back-office — professional, not "vibe coded")

Tokens
- Background (desk): `#f2f2ec` · Cards/panels: `#ffffff` · Hairlines: `#e2e2d8`
- Ink: `#111512` · Muted: `#5a635c` · Faint: `#8a938c`
- Brand green accent: `#0c7a3d` (active nav, links, primary numbers) · Dark green surface: `#123019` (sidebar highlights, print banners) with neon `#03FF89` strictly as small accents on that dark surface
- Primary button: `#0c7a3d` fill, white text · Secondary: white, `1px solid #e2e2d8`, ink text · Destructive: `#a33b2e`
- Status = small dots + 700 text (never glowing pills): ok `#0c7a3d`, pending/warn `#8a5c14`, negative `#a33b2e`, neutral `#8a938c`
- Radii: 6–10px. Shadows: none or `0 1px 3px rgba(16,19,18,.06)`. No emoji anywhere.

Type
- EN **Barlow** (400/500/600/700/800), AR **IBM Plex Sans Arabic** (repo already ships both font families).
- Table body 12.5–13.5px; section titles 15–17px/700; page titles 20–22px/800; KPI numbers 22–26px/800; uppercase micro-labels 10–11px/800, letter-spacing 1–1.6px (EN only — never letter-space Arabic).

Layout skeleton (see any suite in the reference)
1. **Left sidebar** (~232px, `#ffffff`, hairline right): logo top; nav grouped by suite with 10–11px/800 uppercase group labels; active item = `#123019` bar with `#03FF89` text/icon accent; collapses to icon rail on tablet.
2. **Topbar** (56px, white, hairline bottom): page title + breadcrumb, global search, staff identity + role chip, notifications.
3. **Content**: `#f2f2ec` desk, 20–24px padding; KPI stat tiles row (white cards, 10px radius, value 22px/800 + 10px uppercase label); then dense tables/panels in white cards with 16–18px padding.

Tables (the heart of the system)
- Head row: 10px/800 uppercase `#5a635c` on `#f7f7f2`, hairline bottom (dark `#123019` head is reserved for PRINTED documents).
- Cells: 8–10px vertical padding, hairline row separators, zebra `#fafcfa` on odd rows optional; row hover `#f4f6f3`.
- Row actions: compact 28–32px secondary buttons or kebab; bulk-select checkboxes accent `#0c7a3d`.
- Numbers right-aligned (LTR always), SAR amounts 700 weight.

Key screens to mirror from the reference
- **Rides suite** → repo check-in/queue/sessions: session filter chips, live queue table (queue #, rider, bike tag, payment, status dot), one-scan check-in panel, group rows, session-close summary card, "Session report" print action (uses the Green Banner report family).
- **Commerce suite** → repo POS/inventory: product table with stock counts, cash-sale panel, Z-report print.
- **People & CRM** → repo customers: customer table + notes drawer.
- **Insights** → repo analytics: KPI tiles + simple bar/line panels (keep existing chart code, restyle containers).
- **System** → repo settings/staff: settings forms in white cards, staff table with role chips.

Print documents
- Every staff print job (session report, receipts, Z-report) follows the Green Banner family: dark `#123019` banner with white logo + neon doc-type label, 4px `#03FF89→#0C7A3D` gradient rule, stat tiles, dark table head, signature row, footer. Full spec lives in the `design_handoff_session_report` bundle (README there); `Report Template B - Green Banner.dc.html` here is the visual truth. Company name: **MicroMobility Co.**
- Keep `-webkit-print-color-adjust: exact` for dark banners/table heads.

## Bilingual / RTL

Staff UI follows the app language exactly as today: `dir="rtl"` for Arabic, layout mirrors via logical properties, numbers/amounts/refs stay LTR Latin digits, Arabic line-height ~1.7, no letter-spacing on Arabic. Keep every existing `LANG` key; only visual classes change.

## What must NOT change

All staff functionality and behavior: auth/roles, queue and check-in logic (incl. race guards), waitlist, POS math, inventory writes, promo sync, wallet/QR flows, analytics queries, keyboard/scanner shortcuts, offline outbox, audit logging, routes/anchors, i18n keys, tests' logic.

## Suggested order of work

1. Add the token set as CSS variables in `styles.css`; map the staff area's existing selectors onto them.
2. Build the sidebar + topbar skeleton around the existing section markup (pure re-clothing — same sections, same show/hide logic).
3. Restyle primitives: tables, stat tiles, buttons, form fields, status dots, modals (right-side drawers or centered panels are fine on desktop staff screens).
4. Screen-by-screen pass against the reference suites, EN then AR.
5. Restyle print templates last against the Green Banner reference.
6. `npm run build:html && npm run lint && npm test`; visual pass at desktop + tablet widths in both languages.
