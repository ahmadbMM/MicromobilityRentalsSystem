# MicroMobility Volunteer Certificate: Implementation Spec

This kit contains the approved design for the certificate MicroMobility gives volunteers after its events. It is ready to implement in any stack. `template.html` is the source of truth for the layout. `render.js` is a tested reference implementation that turns a JSON list of volunteers into print-ready PDFs.

> **Read "Amendments" at the foot of this file first.** The text below is the design as it was signed off on 2026-11-08 and is left as it was written; six things have changed since, and where they disagree the amendments win.

## What's in the kit

| Path | What it is |
|---|---|
| `template.html` | The certificate as one HTML page with Mustache placeholders. All styling is in the `<style>` block. |
| `render.js` | Reference renderer (Node + Playwright). Fills the template and prints one PDF per volunteer. |
| `sample-data.json` | Three test records: a male volunteer with an Arabic name, a female volunteer with no Arabic name, and a 40-character name. |
| `assets/logo-light.svg` | Official logo (green icon, black wordmark), from the brand guideline vectors. |
| `assets/logo-dark.svg` | Same logo with an off-white wordmark, for dark backgrounds (not used on this certificate). |
| `assets/icon-green.svg` | The M route icon alone, used as the corner supergraphic. |
| `assets/signature-ahmad.svg` | Founder's e-signature ("Ahmad K. B."), black, transparent background. |
| `assets/signature-ahmad-white.svg` | Same signature in off-white, for dark backgrounds. |
| `fonts/` | Space Grotesk, IBM Plex Sans Arabic (300/400/500/700) and Sacramento, with their OFL licenses. Bundled so rendering never depends on the network. |
| `reference/` | Approved renders (PNG + PDF) to compare your output against. |

## Page

- A4 landscape: 297 × 210 mm, designed at **1123 × 794 CSS px** (96 dpi). Keep this fixed size and scale only at export time.
- Zero print margins. The background colour and the corner graphic run to the edge.
- The PDF must contain exactly **one page** per certificate. Print backgrounds must be on (`printBackground: true`, or `print-color-adjust: exact` in CSS).

## Data fields

| Field | Required | Example | Notes |
|---|---|---|---|
| `volunteer_name` | yes | Malik Anas AlNajjar | English or Latin-script name. |
| `volunteer_name_ar` | no | مالك أنس النجار | When empty, remove the whole Arabic name line, not just its text. |
| `gender` | no (default `male`) | male / female | Only changes the Arabic thank-you line. |
| `initiative_name` | yes | MicroMobility Donation Event | Shown in the green highlight box. Keep it to one line, around 40 characters at most. |
| `event_date` | yes | 8 November 2026 | Display string. Format: `D Month YYYY`. |
| `certificate_no` | yes | MM-VOL-0001 | Format `MM-VOL-NNNN`. Must be unique and never reused. |

## Derived values (business rules)

1. **Name size**, in two steps:
   - Starting size from the character count of `volunteer_name`: up to 16 characters is 66 px, 17 to 22 is 56 px, 23 to 28 is 48 px, 29 or more is 40 px.
   - Fit to one line: the name may use up to 979 px of width (the full content width, clear of the corner graphic). The small script at the end of `template.html` shrinks it 1 px at a time, down to 32 px, until it fits. Only if it still doesn't fit is it allowed to wrap. When the script finishes it sets `body[data-ready="1"]`, so wait for that before printing. Keep the script, or reproduce the same logic in your renderer.
2. **Arabic thank-you line**, from `gender`:
   - male: `تقديرًا لعطائه ومشاركته التطوعية في المبادرة`
   - female: `تقديرًا لعطائها ومشاركتها التطوعية في المبادرة`
3. **HTML-escape** every field before inserting it.
4. **Arabic text** must keep `dir="rtl"` and `lang="ar"` exactly as in the template, so it shapes and joins correctly.

## Fixed content (do not make editable)

- Titles: `شهادة تطوع` / `CERTIFICATE OF VOLUNTEERING`
- Lead line: "This certificate is proudly presented to"
- Recognition line: "in recognition of their time, energy and commitment as a volunteer in"
- Signatory: signature image, then **Ahmad Babalghoum**, "Founder, MicroMobility", `المؤسس`
- Footer: "Power your path" (Sacramento script) and `micromobility.com.sa`

## Brand rules (from the MicroMobility guideline by Watad, June 2025)

- Colours: Green `#03FF89` (Pantone 3395 C), Black `#1A1919` (Pantone Black C), Off-white `#FBF9F4` (Pantone Cool Gray 1 C). No other colours, no gradients, no shadows.
- Fonts: Space Grotesk for English, IBM Plex Sans Arabic for Arabic. The script font is used only for the slogan.
- Logo: use the SVG as supplied. Never rotate, stretch, recolour, outline or add shadow, and keep clear space around it.
- Never put green text on the off-white background, because the contrast is too low. Green is used only for shapes and for the highlight behind black text.
- The corner supergraphic is the logo icon placed flush with the bottom-right corner (`right: -3px; bottom: -3px; width: 420px`; the -3 px hides the anti-aliasing seam). It must not overlap any text.

## Signature

`assets/signature-ahmad.svg` is the approved e-signature. Embed it only on certificates MicroMobility issues itself. Do not expose the raw signature file publicly, for example in a public web folder or an open API response.

## Implementation notes

- **Rendering engine:** any headless Chromium (Playwright or Puppeteer) gives the same output as the reference. Wait for `document.fonts.ready` and then `body[data-ready="1"]` before printing. Otherwise Arabic may fall back to a system font, or the name may not be fitted yet.
- **Paths:** the template uses relative paths (`fonts/`, `assets/`). Either render the filled HTML from the kit folder (as `render.js` does) or inline the assets as data URIs.
- **File naming:** `{certificate_no}-{Volunteer-Name}.pdf`, for example `MM-VOL-0001-Malik-Anas-AlNajjar.pdf`.
- **Certificate numbers:** allocate them sequentially from a persistent store (database or counter), never from row position in an upload.
- **Optional:** a small web form or CSV upload for event staff, producing a ZIP of PDFs. A verification page or QR code is not in this design. If you add one, put it in the footer area without moving existing elements.

## Acceptance checklist

- [ ] Rendering `sample-data.json` gives output that matches the three samples in `reference/` visually.
- [ ] Each PDF is exactly one A4 landscape page with no white border.
- [ ] Arabic renders in IBM Plex Sans Arabic with letters joined, right to left.
- [ ] An empty `volunteer_name_ar` leaves no blank gap.
- [ ] A 40-character name (sample 3) stays on one line and doesn't touch the corner graphic.
- [ ] `gender: female` switches the Arabic line.
- [ ] Names containing `<`, `&` or quotes render as text, not HTML.

`tests/certificate-template.spec.ts` in this repo runs every line of this checklist against the built
template, plus the amendments below.

## Amendments

Everything above is the design as signed off. These six changes came after it, and they win where
they disagree. `certificate/README.md` says how each reaches the two apps.

**1. The slogan row is gone** (the owner, 2026-11-08). "Power your path", `micromobility.com.sa`
and the line naming where a code is answered are off the page, and so is the green tick above the
logo. Sacramento went with the slogan: the page is Space Grotesk and IBM Plex Sans Arabic only.
This supersedes the footer line of **Fixed content**.

**2. A certificate's number is `MMV-YYYY-NNNNN`**, not `MM-VOL-NNNN` — the serial
`volunteer_certs` has given since migration `20261107131000`, allocated from the row's own id, which
**Data fields** and **Implementation notes** still write the old way. The check code beside it is
twelve characters.

**3. The recognition line names the gender** (the owner, 2026-11-08): *his* or *her* instead of
*their*, with *their* kept for a person whose gender nobody recorded. The Arabic line does the same
and gains a third form that names neither. So the line above the green box is a **field**, like the
Arabic one, not fixed content; **Derived values** covers only the Arabic one.

**4. Three lines are fields, and are stored.** `{{lead}}`, `{{recognition}}` and `{{arabic_line}}`
are filled per certificate and written onto the row (`volunteer_certs.words`), so a reprint says
what it said on the day. Staff may write all three themselves on a certificate of their own
(`staff_volunteer_cert_issue_custom`). The titles, the signatory and the layout stay fixed.

**5. The footer carries two more values, and the row is tighter.** The hours and the check code are
second lines under Date and No. — the only place **Implementation notes** allows an addition — and
the meta row's gap is 28px rather than 36px, because a twelve-character code left the No. column
touching the corner graphic. Nothing above the footer moved.

**6. The hours are a line of their own in the body** (the owner, 2026-11-10: "mention the number of
hours on certificates"). Under the Arabic thank-you: the number at the green box's 28px weight, then
the footer's label style, `VOLUNTEER HOURS · ساعات التطوع`. A label beside a number, so the Arabic
needs no plural that changes with the count. The line is not there when no hours are known. It
replaces the small second line under Date that amendment 5 added; that column holds the date alone
again, and the check code under No. is unchanged.
