# DESIGN-SPEC.md — MicroMobility Rentals

The visual specification, extracted from [styles.css](../styles.css) (3,285 rules, 235 KB) and
the inline styles in [app.src.html](../app.src.html).

## 0. The single most important thing to understand first

**There are three visual identities layered on top of each other in one stylesheet, in this
order. Later layers deliberately override earlier ones.**

| Layer | Selector prefix | What it is |
|---|---|---|
| **1. Base + motorsport identity** | `:root`, bare classes | The original design: condensed-italic display type, **chevron-cut** primary buttons (`clip-path`), uppercase "pit-board" tabs, a green "start-light" top border on raised surfaces. |
| **2. Customer reskin** | `body .btn-primary`, `body .toggle-btn`, … | **Neutralises the motorsport identity for customer pages** — `clip-path:none`, body font, no italic, no uppercase, 6 px radii, white surfaces. |
| **3. Staff ERP reskin** | `body.view-staff …` (+ `html[data-staff-theme="dark"]`) | A completely different, denser "ERP" look with its own `--sf-*` token set: paper-white cards, hairline borders, pill filters, zebra tables. |

A rebuild must decide which layer it is reproducing. **What a customer sees today is layer 2;
what staff see is layer 3.** Layer 1 survives only where 2 and 3 do not override it. The
`body`-prefixed selectors exist purely to win specificity against layer 1 — that is not
accidental style, it is the override mechanism.

---

## 1. Design tokens

Declared on `:root` (light) and overridden on `:root[data-theme="dark"]`. **Dark is the
default** — the `<head>` sets `data-theme="dark"` unless the stored theme is `light`.

### 1.1 Colour

| Token | Light | Dark | Role |
|---|---|---|---|
| `--bg` | `#f0f2f3` | `#08090b` | page |
| `--s1` | `#ffffff` | `#101318` | surface 1 (topbar, cards) |
| `--s2` | `#e5e9ea` | `#161a21` | surface 2 (modals, toasts) |
| `--s3` | `#eceff0` | `#1d222b` | surface 3 (controls) |
| `--in-bg` | `#ffffff` | `#161a21` | input background |
| `--green` | `#008f52` | `#00e585` | **brand** |
| `--green-h` | `#007d48` | `#2eeb99` | brand hover |
| `--green-d` | `#00713f` | `#00e585` | brand deep |
| `--ac-fill` | `#00b467` | `#00cf78` | primary-button fill |
| `--ac-fill-h` | `#00a25d` | `#0adf85` | …hover |
| `--acink` | `#04140c` | `#04140c` | ink **on** the primary fill (same in both themes) |
| `--acsoft` | `rgba(0,143,82,.1)` | `rgba(0,229,133,.1)` | focus ring wash |
| `--red` | `#a33b2e` | `#d4705f` | destructive / no-show |
| `--orange` | `#8a5c14` | `#d4a04c` | pending / warning |
| `--blue` | `#2f63ad` | `#4aa8f8` | **JCC ride identity** |
| `--purple` | `#7a46c2` | `#a06af0` | on-the-house |
| `--text` | `#0f1215` | `#f2f5f2` | body text |
| `--muted` | `#4f565c` | `#8b939b` | secondary text |
| `--muted-l` | `#767e85` | `#626a72` | tertiary text |
| `--border` | `rgba(15,18,21,.15)` | `#232830` | hairline |
| `--line2` | `rgba(15,18,21,.35)` | `rgba(242,245,242,.32)` | input underline |
| `--photo-bg` | `#ffffff` | `var(--s3)` | image placeholder |
| `--foot` / `--footink` / `--footmut` | `#0f1215` / `#f2f5f2` / `#9aa1a7` | `#060708` / `#f2f5f2` / `#8b939b` | footer |

**RGB triplets** (for `rgba()` composition — a rebuild needs these, every translucent surface
uses them): `--green-rgb` `0,143,82` / `0,229,133`; `--tint-rgb` `15,18,21` / `242,245,242`;
`--red-rgb` `163,59,46` / `212,112,95`; `--warn-rgb` `138,92,20` / `212,160,76`;
`--purple-rgb` `122,70,194` / `160,106,240`; `--blue-rgb` `47,99,173` / `74,168,248`.

> `--tint-rgb` **inverts between themes** — it is "the ink colour", so `rgba(var(--tint-rgb),.08)`
> is a subtle dark wash in light mode and a subtle light wash in dark mode. This single trick
> carries most of the theme switching.

### 1.2 Spacing scale

`--sp-1: 4px` · `--sp-2: 8px` · `--sp-3: 12px` · `--sp-4: 16px` · `--sp-5: 20px` ·
`--sp-6: 24px` · `--sp-8: 32px`

### 1.3 Radii

`--r-xs: 2px` · `--r-sm: 3px` · `--r-md: 4px` · `--r-lg: 6px` · `--r-xl: 7px` · `--r-pill: 999px`

Actual usage after the reskins: **customer 6–8 px**, **staff 7–10 px**, badges/chips 2–3 px.

### 1.4 Type scale

`--fs-xs: 12px` · `--fs-sm: 13px` · `--fs-base: 14px` · `--fs-md: 16px` · `--fs-lg: 20px` ·
`--fs-xl: 26px` · `--fs-2xl: 34px`

### 1.5 Shadows

| Token | Light | Dark |
|---|---|---|
| `--sh-1` | `0 1px 2px rgba(16,19,18,.06)` | same |
| `--sh-2` | `0 3px 10px rgba(16,19,18,.09)` | `0 4px 14px rgba(16,19,18,.08)` |
| `--sh-3` | `0 10px 30px rgba(16,19,18,.15)` | `0 14px 44px rgba(16,19,18,.14)` |

Dark mode leans on the **elevation ladder** (`bg < s1 < s2`) rather than shadows, since shadows
are near-invisible on `#08090b`.

### 1.6 Motion

`--dur: .18s` · `--ease: cubic-bezier(.2,.8,.2,1)`

Named animations: `modalFadeIn .22s ease`, `modalSlideUp .28s cubic-bezier(.2,.8,.2,1)`,
`toastIn .28s cubic-bezier(.2,.8,.2,1)`.

**`@media (prefers-reduced-motion: reduce)` appears 3×** and must be honoured.

### 1.7 Fonts

```
--font-body:    'Barlow', sans-serif
--font-display: 'Barlow Condensed', 'Barlow', sans-serif
--font-mono:    'Chakra Petch', 'Barlow', sans-serif
```

Arabic swaps **everything** to `'IBM Plex Sans Arabic', sans-serif` (see §7). All fonts are
self-hosted under `./fonts/`; two weights are preloaded (`Barlow-500-latin.woff2`,
`BarlowCond-800i-latin.woff2`).

### 1.8 Staff ERP tokens (`body.view-staff` only)

| Token | Staff light | Staff dark (`html[data-staff-theme="dark"]`) |
|---|---|---|
| `--sf-card` | `#ffffff` | `#101318` |
| `--sf-line` | `#e2e2d8` | `rgba(255,255,255,.09)` |
| `--sf-line2` | `#dfe4e6` | `rgba(255,255,255,.09)` |
| `--sf-ctl` | `#cfd6d9` | `rgba(255,255,255,.16)` |
| `--sf-ctl-h` | `#b7c0c4` | `rgba(255,255,255,.3)` |
| `--sf-head` | `#f7f7f2` | `rgba(255,255,255,.05)` |
| `--sf-zebra` | `#fafcfa` | `rgba(255,255,255,.02)` |
| `--sf-hover` | `#f4f6f3` | `rgba(255,255,255,.06)` |
| `--sf-hover2` | `#f7f9f9` | `rgba(255,255,255,.08)` |
| `--sf-sep` | `#eef1ec` | `rgba(255,255,255,.06)` |
| `--sf-chip` | `#f2f2ec` | `rgba(255,255,255,.06)` |
| `--sf-green-ink` | `#0c7a3d` | `#25d184` |

Plus literal colours used only in the staff layer: selected-state fill `#123019` with neon text
`#03ff89`; primary button `#0c7a3d` (hover `#0a6a35`); destructive `#a33b2e`; staff-dark
warning `#f2b43f`, danger `#ff6f66`, success `#25d184`.

### 1.9 Ride identity colours

```css
.ev-jcc      { --ev: var(--blue);  --ev-rgb: var(--blue-rgb);  }   /* Evening Circuit  — blue  */
.ev-saturday { --ev: var(--green); --ev-rgb: var(--green-rgb); }   /* Saturday Social  — green */
.ev-petromin { --ev: var(--red);   --ev-rgb: var(--red-rgb);   }   /* Petromin Wed     — red   */
```
[styles.css:3197](../styles.css#L3197)

Applied by `_evClass(s)` = `'ev-' + _rideKind(s)`. Everything ride-tinted then reads `var(--ev)`:
`.ev-chip`, `.ev-name`, `.sess-chip-event`, `.sess-summary-chip.community`,
`.sess-card.sess-card-comm` (start border), `.sess-card-dot`, and `.toggle-btn.ev-pick.active`.

> **In the staff ERP layer the ride identity is suppressed** — `body.view-staff .sess-chip-event`,
> `.sess-comm-chip` and `.sess-card-comm` are repainted green/ink only. Colour-coding the rides
> is a **customer-side** device.

---

## 2. Breakpoints

| Query | Count | Meaning |
|---|---|---|
| `max-width: 767px` | 31 | **the main mobile breakpoint** |
| `min-width: 1024px` | 5 | desktop |
| `max-width: 1023px` | 5 | tablet-and-below |
| `max-width: 560px` | 5 | small phone |
| `max-width: 480px` | 4 | |
| `max-width: 640px` | 3 | |
| `prefers-reduced-motion: reduce` | 3 | |
| `max-width: 400/390/380/340px` | 7 | very small phones |
| `min-width:768px and max-width:1023px` | 1 | tablet only |
| `max-width: 1100/900/820/520/430px` | 5 | one-off fixes |
| `display-mode: standalone` | 2 | installed-PWA adjustments |

The layout swaps at **767 px**: desktop shows a **table** (`.queue-table`), mobile shows
**cards** (`.q-card` inside `.queue-mobile-view`).

Two mobile rules that matter:
- `input, select, textarea { font-size: 16px !important; }` — below 16 px iOS zooms the page on
  focus.
- `.btn-primary, .btn-secondary { min-height: 46px }`, `.actions-cell .btn-sm { min-height: 44px }`
  — Apple HIG 44 pt targets.

---

## 3. Component inventory

**551 distinct classes.** The families that matter, with their states.

### 3.1 Buttons

| Class | Default | Hover | Active | Disabled |
|---|---|---|---|---|
| `.btn-primary` (layer 1) | `--ac-fill` bg, `--acink` text, **`clip-path: polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%)`** (chevron), display font, italic, uppercase, 16px/800, letter-spacing 1px, glow `0 4px 18px rgba(var(--green-rgb),.22)` | `--ac-fill-h`, `translateY(-1px)`, `--sh-2` | `translateY(0)`, `scale(.97)` | — |
| `.btn-primary` (layer 2, customer) | **`clip-path:none`**, body font, upright, no uppercase, `border-radius:6px`, `min-height:48px`, 15px/700 | `--ac-fill-h` | `scale(.98)` | — |
| `.btn-primary` (layer 3, staff) | `#0c7a3d` bg, white text, `border-radius:8px`, `min-height:44px`, 13px/600, no shadow | `#0a6a35`, **no transform** | — | — |
| `.btn-secondary` | transparent, `--muted` text, 1px `--border`, radius 4px | border `rgba(var(--tint-rgb),.25)`, text `--text` | `scale(.97)` | — |
| `.btn-secondary` (customer) | `#ffffff`, `--text`, `1px rgba(26,25,25,.25)`, radius 6, min-height 44 | | | |
| `.btn-secondary` (staff) | `--sf-card`, `1px --sf-ctl`, radius 8, min-height 40, 12.5px/600 | `--sf-ctl-h` border, `--sf-hover2` bg | | |
| `.btn-sm` | 6×13px, 12px/700, radius 3 | `opacity:.88`, `translateY(-1px)` | `translateY(0)` | **`opacity:.3 !important; cursor:not-allowed; transform:none`** |
| `.btn-green` | `rgba(green,.12)` bg, `--green` text, `1px rgba(green,.3)` | `.22` / `.5` | | |
| `.btn-red` | `rgba(red,.12)` / `--red` / `.3` | `.22` / `.5` | | |
| `.btn-red` (staff) | **white bg, red text, hairline** — red fill only on hover | `#a33b2e` bg, white text | | |
| `.btn-muted` | `rgba(tint,.04)` / `--muted` / `rgba(tint,.08)` | `rgba(tint,.1)` | | |
| `.btn-google` | full width, 12px pad, radius 4, `rgba(tint,.04)`, 1px border, gap 10 | `rgba(tint,.08)` | | |
| `.btn-apple` | **`#000` bg, `#fff` text** (Apple HIG) — **inverted in dark theme** to `#fff`/`#000` | `#1a1a1a` (dark: `#e8e8e8`) | | |
| `.btn-wallet` | `linear-gradient(180deg,#141619,#050607)`, `#f4f7f4` text, `1px rgba(0,229,133,.32)`, **radius 13px**, ::before green sheen line. **Identical in both themes** — it mirrors the pass it generates | border `rgba(0,229,133,.6)`, inset highlight + `0 8px 22px rgba(0,229,133,.16)` | `scale(.985)` | `opacity:.6` |

**Focus:** global `:focus-visible` → `outline: 2px solid var(--green); outline-offset: 2px`.
`.btn-primary` cannot use an outline (the `clip-path` clips it), so it gets
`box-shadow: inset 0 0 0 2.5px var(--acink)` instead. `.btn-wallet` gets a `#00e585` outline.

### 3.2 Chips / toggles / pills

| Class | Default | Active |
|---|---|---|
| `.toggle-btn` (layer 1) | `--s3` bg, 1px `--border`, radius 5, 13px/700, `--muted` | `rgba(green,.08)` bg, `--green` border + text |
| `.toggle-btn` (customer) | `#ffffff`, `1px rgba(26,25,25,.16)`, radius 6, **min-height 44**, weight 500 | **`#123019` bg, `#fbf9f4` text**, plus a **`::before` 6px `#03FF89` dot** |
| `.toggle-btn` (staff) | `--sf-card`, `1px --sf-ctl`, radius 7, min-height 40 | `#123019` / `#03ff89`, **dot removed** (`content:none`) |
| `.filter-pill` | transparent, 1px `--border`, radius 3, 12.5px/700 | `--ac-fill` bg, `--acink` text |
| `.filter-pill` (staff) | `--sf-card`, `1px --sf-ctl`, **radius 999px**, 12px/600, min-height 34 | `#123019` / `#03ff89` |
| `.tab-btn` | 15×20px, min-height 48, `border-bottom: 2px solid transparent`, `--muted`, **uppercase, letter-spacing 1.2px** | `--green` text **and** green bottom border |
| `.tab-btn` (staff sidebar) | flex row, gap 10, radius 9, 11.5px/700 uppercase, `#7d868d`, full width | `#123019` bg, `#03ff89` text, icon `#03ff89` |
| `.tab-badge` | inline-flex, min-width 16, height 16, radius 3, **`--orange` bg**, `#1a1200` text, 10px/700 | staff: white bg, hairline, ink text |

### 3.3 Status badges

`.badge-waiting` `--muted` · `.badge-active` `--green-d` · `.badge-done` `--muted-l` ·
`.badge-noshow` `--red` · `.badge-waitlist` (added with the waitlist feature).

`.badge-open` / `.badge-full` / `.badge-closed` are **filled pills** in layer 1
(`rgba(...,.12)` bg + `.3` border, 4×12px, radius 3, 11px/700, letter-spacing .3px) — but in the
**staff layer they become a 7px dot + 700 text with no fill**
(`body.view-staff .badge-open::before { content:''; width:7px; height:7px; border-radius:50% }`).

Staff-dark overrides the print-weight inks that are unreadable on `#08090b`:
waiting/full → `#f2b43f`, no-show → `#ff6f66`, open → `#25d184`.

### 3.4 Payment cell

`.pay-toggle` — inline-flex, gap 5, 6×12px, min-height 26, radius 3, `1.5px solid transparent`:

| State | Colour |
|---|---|
| `.paid` | `--green-d` text, no border, no background |
| `.pending` | `--orange` text, `rgba(var(--warn-rgb),.5)` border; hover fills `rgba(warn,.1)` |
| `.house` | `--purple` text, `rgba(purple,.4)` border, `rgba(purple,.09)` bg |

In `.queue-table.compact` it shrinks to 10px / 3×8px. Staff layer: radius 7, min-height 36,
pending becomes `#fdf9ef` on `#e6d3a8`.

### 3.5 Cards

- `.q-card` — `--s2` bg, `1px rgba(tint,.08)`, radius 6, 12×14px, margin-bottom 8.
  Row states: `.row-active` (green wash `rgba(green,.04)` + `rgba(green,.15)` border),
  `.row-done-paid` (`rgba(green,.015)`), `.row-done` (`opacity:.85`),
  **`.row-noshow-cancel` (`opacity:.5`)**.
- Staff: `.q-card` → `--sf-card`, `1px --sf-line2`, radius 10; buttons inside get `min-height:40px`.
- `.sess-card` (59 `sess-*` classes total), `.bike-card` / `.bike-grid-card`,
  `.analytics-kpi-card`, `.dash-kpi`, `.chart-card`, `.member-card`, `.ticket-card`.

### 3.6 Tables (the staff heart — 3.5 of the ERP layer)

`.queue-table`, `.sess-admin-table`, `.analytics-trend-table`:
- header `--sf-head` background, sticky;
- **zebra striping on odd rows** (`--sf-zebra`);
- row hover `--sf-hover`;
- sorted column marked `.an-sort-active`;
- `.sess-group-hdr` group rows; `.row-done-paid` tinted.
- Wrapped in `.table-wrapper` for horizontal overflow.

Density: `.queue-table.compact` (default, `cq_density`) vs comfortable, toggled by `.density-btn`.

### 3.7 Modals

- `.modal-backdrop` — `animation: modalFadeIn .22s ease both`; dark theme `rgba(0,0,0,.85)`;
  staff `rgba(15,18,21,.45)` **with `backdrop-filter: blur(3px)`**.
- `.modal-box` — `animation: modalSlideUp .28s cubic-bezier(.2,.8,.2,1) both`; `--s2` in dark;
  layer 1 gives it **`border-top: 3px solid var(--green)`** (the "start light"); customer layer
  repaints it white with `0 12px 32px rgba(26,25,25,.10)`; staff layer gives radius 10 and
  removes the green top edge.
- Parts: `.modal-title`, `.modal-sub`, `.modal-footer` (buttons full-width on mobile, 13px pad).
- **Z-index:** every backdrop is `z-index:200`, so stacking fell to DOM order; `#confirm-modal`
  is declared early in the markup, so it carries an explicit **`z-index:300`** override —
  without it a confirmation renders *behind* the modal that raised it.

### 3.8 Toasts

`.toast` — `--s2` bg, 1px `--border`, **`border-inline-start: 3px solid var(--green)`**
(logical, so it flips in RTL), radius 6, 12×22px, 13px/700, `white-space:nowrap`,
`box-shadow: 0 4px 24px rgba(16,19,18,.14)`, backdrop blur, `animation: toastIn .28s`.
Variants: `.error` → red start border, `.warning` → `--muted-l`.
Staff: `#0f1215` bg, `#e9edee` text, radius 8, `#03ff89` / `#ff6f66` / `#f2b43f` edges.
Container `#toast-container` is `role="status" aria-live="polite"`.

### 3.9 Forms

- Global: `input, select, textarea { -webkit-appearance:none }`;
  focus → `border-color: var(--green); box-shadow: 0 0 0 3px var(--acsoft)`.
- `.field-invalid` → `border-color: var(--red) !important`; **a focused invalid field keeps a red
  ring** (`0 0 0 3px rgba(var(--red-rgb),.15)`) rather than showing a green ring around a red
  border.
- Auth fields are **borderless with a hairline underline** (`border-bottom: 1px solid var(--line2)`),
  turning green on focus — but the **customer reskin replaces them with boxed white fields**
  (radius 8, min-height 46, 16px).
- `input.has-clear` reserves `padding-inline-end: 34px` for the generic **× clear button** that is
  mounted after every render rather than duplicated into nine templates
  ([app.src.html:2733](../app.src.html#L2733)).

### 3.10 PIN pad

`.pin-backdrop`, `.pin-box` (green top border), `.pin-title`, `.pin-sub`, `.pin-logo`,
`.pin-dots` / `.pin-dot`, `.pin-numpad` / `.pin-key`, `.pin-error`, `.pin-cancel`.

### 3.11 QR / scanner

- **Ticket QR**: `.ticket-qr`, `.ticket-qr-wrap`, `.ticket-qr-cell`, `.ticket-qr-caption`.
  Generated as an SVG matrix by the vendored `qrcode-generator` at error-correction level **M**,
  loaded on demand.
- **Scanner modal** (`#scan-modal`) reuses the PIN chrome: `.pin-backdrop.scan-backdrop` +
  `.pin-box` at `max-width:380px; width:92vw`, containing
  `<video id="scan-video" playsinline muted style="width:100%;height:100%;object-fit:cover">`,
  a status line `#scan-msg` (12px, `--muted`), a **continuous-mode `.toggle-btn`** (full width),
  and a tally line `#scan-tally` (11px/700).

### 3.12 Booth popup (kiosk mode)

`#booth-popup` with `.booth-popup-box` (green top border), `.booth-popup-close` (×),
`.booth-popup-icon`, `.booth-popup-title`, `.booth-popup-msg`, and an extra panel styled
`background: rgba(var(--tint-rgb),.04); border-radius:4px; padding:10px 14px; text-align:left;
font-size:12px; font-weight:700; color:var(--muted); line-height:1.6`.

### 3.13 Empty and loading states

- `.empty-state` — centred, `52px 24px` padding, `--muted`, 14px/600, letter-spacing .1px.
- `.empty-illustration` with `.empty-illus-icon` / `-title` / `-sub` / `-action`.
- In-panel wait: `skeletonList()` renders `.mm-loading--inline` (the riding light at 44px, no ground, in the panel's `--green`),
  gated on `S.dataLoaded` so it shows before the first load. It replaced the `.sk-row` shimmer bars.
- `.rides-empty`, `.rides-zero`, `.no-sessions-msg`.

### 3.14 Landing

23 `landing-*` classes: `.landing-ghost` (huge outlined "MICROMOBILITY" watermark),
`.landing-hero-grid` / `-copy` / `.landing-hero-card` (photo card with `.landing-hero-card-cta`
and a circular `.landing-hero-cta-btn` arrow), `.landing-eyebrow`, `.landing-main-title`,
`.landing-subtitle`, `.landing-auth-cta`, `.sector-stripes` (three angled `<i>` bars),
`.landing-events-grid` / `.landing-event-card`, `.landing-avail-rows` / `-row` / `-dot` /
`-date` / `-time` / `-spots` / `-info` / `-empty`, `.landing-footer`, `.staff-access-btn`.

> The topbar once carried a 3 px × 180 px green "start-light" segment under the logo
> (`#topbar::after`, six rules). **All six were removed on 2026‑08‑25** — the topbar is now a
> plain `border-bottom: 1px solid var(--border)`. Do not reintroduce it.

---

## 4. Layout

- **Customer**: top bar (logo · language · theme · account) → `<main>` → `.tab-nav` on desktop,
  a fixed bottom `#cust-bottom-nav` with three SVG-icon buttons on mobile → footer with four
  social links.
- **Staff**: a **left sidebar rail** (`#staff-tab-nav`) grouped by `.snav-group` labels —
  **Rides · Commerce · People · Insights · System** — over the tabs Bookings, Sales, Inventory,
  Community, Analytics, History, Notes. The rail can be **pinned or hover-expand**
  (`.rail-hover`, `#rail-pin`, `localStorage.cq_rail`); collapsed it shows icons only, and the
  inventory low-stock badge is pinned to the icon corner.
- `body` classes drive everything: `view-landing` / `view-customer` / `view-picker` / `view-staff`.

---

## 5. Iconography

Inline SVG only, `stroke-width: 1.8`, `stroke-linecap: round`, `viewBox="0 0 24 24"`, using
`currentColor`. No icon font, no sprite sheet. Bottom-nav icons are hand-drawn: a **bicycle**
(two circles + frame path), a **calendar**, and a **person**. The staff rail uses `.snav-ico`
spans. Brand marks: `logo.png` (dark bg), `logo-dark.png` (light bg), `brand.png`,
`jcc.png` / `jcc-white.png`, `hero.webp`, `social-ride.jpg`.

---

## 6. Accessibility

- `:focus-visible` ring on every interactive element (§3.1).
- `role="dialog" aria-modal="true"` on every modal; `aria-label` from the translated title.
- `#toast-container` is `role="status" aria-live="polite" aria-atomic="false"`.
- `aria-haspopup="listbox"` / `role="listbox"` / `role="option"` / `aria-selected` on the
  language menu; `aria-pressed` on toggles; `aria-expanded` + `aria-controls` on the browse picker.
- `aria-label` on icon-only buttons; external links carry "(opens in a new tab)".
- **`tests/a11y.spec.ts` is a hard CI gate**: every audited view (landing, auth, booking, my
  rides, and each staff tab, in EN and AR) must report **zero axe-core violations**.
  "Needs review" items are printed but do not fail.

---

## 7. RTL and Arabic

**252 rules** are scoped to `html[dir="rtl"]` or `html[lang="ar"]`.

### 7.1 Direction

`setLang()` sets `document.documentElement.dir = 'rtl'` for Arabic (and `lang`).

Handled by a **mix** of logical properties and explicit RTL rules — a rebuild using pure logical
properties will still need the explicit ones:

- Logical, so they flip automatically: `border-inline-start` (16 uses — the toast edge, session
  card edge), `inset-inline-end`, `padding-inline-*`, `margin-inline-*`, `text-align: start`.
- Explicit `html[dir="rtl"]` rules: `.phone-row`, `.auth-cc-row`, `.height-row`, `.toggle-group`
  → `flex-direction: row-reverse`; `.form-row`, `.tab-nav`, `.filter-row`, `.modal-box`
  → `direction: rtl`; `input`, `select`, `th`, `td` → `text-align: right`; `.topbar-logo`
  → `row-reverse`.
- **`.mirror-rtl { transform: scaleX(-1) }`** — the mechanism for flipping glyph arrows (the
  back chevron `‹`, the hero arrow `→`).
- Hero/arrow hovers translate the opposite way (`translateX(-3px)`).
- **Numbers and identifiers stay LTR inside RTL text**: `.cust-topbar-name`,
  `.cust-topbar-email` are forced `direction: ltr; text-align: right`, and phone numbers are
  wrapped in `<bdi>`.

### 7.2 Typography

`html[lang="ar"]` swaps the family to `'IBM Plex Sans Arabic'` for inputs, selects, buttons,
`.btn-primary/.btn-secondary/.btn-sm`, `.toggle-btn`, toasts, `.empty-state`, and the wallet
button — and **cancels the motorsport type treatment**:

```css
html[lang="ar"] .landing-main-title, .page-title, .auth-title, .modal-title, … {
  font-family:'IBM Plex Sans Arabic',sans-serif; font-style:normal; text-transform:none;
}
html[lang="ar"] .tab-btn, .auth-tab, .status-badge, .type-badge, .walk-in-badge, … {
  text-transform:none;
}
```

**No italics, no uppercase, no letter-spacing games in Arabic** — those are Latin-only devices.
Sizes are nudged up for legibility: `.btn-primary` 15px, `.btn-secondary` 13px, `.btn-sm` 12px,
`.toggle-btn` 13px, `.auth-field input` 15px, `.toast` 14.5px, `.empty-state` 14.5px.
The staff rail drops letter-spacing and uses 13px.

### 7.3 Dates, numbers, times

- Dates: `ar-u-ca-gregory-nu-latn` — **Gregorian calendar with Latin digits**, deliberately not
  Hijri and not Arabic-Indic numerals ([app.src.html:2284](../app.src.html#L2284)).
- Day names: a hand-written `DAY_NAMES_AR` map (الأحد, الاثنين, …).
- Times: `fmt12h()` renders `ص` / `م` instead of AM/PM in Arabic.
- Countries and cities have their own `COUNTRY_AR` / `CITY_AR` maps.

---

## 8. Theming mechanics

- The site has **one look**. The `<head>` inline script sets `data-theme="dark"` unconditionally
  — the token block the look is built on; the name is history — and clears any stored
  `cq_theme` / `cq_staff_theme` from earlier builds. The `:root:not([data-theme="dark"])` rules
  (the retired "sunlight" alternate with the asphalt topbar) and the staff `data-staff-theme`
  night mode never apply.
- `data-staff-theme="dark"` is a **separate, per-device** toggle for the staff panel only.
- `cq_rail` = `hover` adds `.rail-hover` on DOMContentLoaded.
- `theme-color` meta is `#08090b`.

---

## 9. Print

Session reports and receipts have print styles (`showPrintReportOptions`,
`printReportOptions` in `cq_rep_opts`), bilingual, with a generated reference
`MM-RPT-YYMMDD` ([app.src.html:11536](../app.src.html#L11536)).

---

## 10. Ambiguities a designer must resolve

1. **Which layer is canonical.** Layers 1–3 coexist; a class like `.btn-primary` has three
   different definitions. The *rendered* result is what matters, and it differs between customer
   and staff pages. A rebuild should pick the rendered result, not the CSS text.
2. **Layer 1's motorsport identity is mostly dead** but not deleted — chevron CTAs, condensed
   italic display type and the "start light" borders still apply anywhere layers 2–3 don't
   override. Whether that is intentional residue or an unfinished migration is **not
   determinable from the code**.
3. **`--r-*` radius tokens are largely unused** after the reskins, which hard-code 6/7/8/10 px.
4. Two `.btn-primary` `min-height` values (46 px mobile rule vs 48 px customer rule) are both
   live; the cascade resolves it, but the intended figure is unclear.
