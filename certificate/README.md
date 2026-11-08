# The volunteer certificate

The certificate MicroMobility gives volunteers, as a design signed off on 2026-11-08. **This folder
is the only place it is drawn.** The booking app and the volunteer portal both print this file; if
you restyle a certificate anywhere else, the two stop matching.

## What is here

| Path | What it is |
|---|---|
| `template.html` | The markup, with `{{placeholders}}`. The source. |
| `certificate.css` | Every rule the page uses. The source. |
| `SPEC.md` | The approved design: the page, the fields, the business rules, the brand rules, the acceptance checklist. Read it before changing anything. |
| `assets/*.svg` | The brand vectors the page carries: the logo, the corner icon, the founder's e-signature. |
| `reference/` | What a filled certificate looks like today, one PNG per sample. **Generated** by `npm run build:cert:reference`, with `rendered-from.json` recording what it was made from — the suite fails when that no longer matches, so a design change cannot ship with stale pictures. |
| `sample-data.json` | The three records the acceptance checklist is written against: a male volunteer with an Arabic name, a female volunteer without one, and a 40-character name. The reference and `tests/certificate-template.spec.ts` both read it. |

## What the owner changed since it was signed off

**2026-11-08.** Taken off the page, by the owner, after the design was approved:

- the slogan "Power your path" and the address beside it (the whole tagline row);
- the line that named where a certificate's code is answered;
- the green tick above the logo (`.top-tick`).

The slogan was the only thing Sacramento was for, so that font is gone from the kit too: the page
is now Space Grotesk and IBM Plex Sans Arabic, both of which each app already serves. `SPEC.md`
still reads as it was signed off and still governs everything else; the check code itself stays,
as a second line under the certificate's number.

`reference/` was re-rendered after these removals, so the pictures are the certificate as it is
printed now. `SPEC.md` keeps its signed-off text and carries all of this in an **Amendments**
section at its foot, including the two the code never matched: a certificate's number is
`MMV-YYYY-NNNNN` (the serial `volunteer_certs` has given since 20261107131000), not `MM-VOL-NNNN`,
and the recognition line names the gender rather than always reading *their*.

## The wording is said by gender, and stored

The three lines in the body — the one above the name, the one above the green box and the Arabic
thank-you — are **fields**, not fixed text. Each certificate is stamped with the lines it was issued
with (`volunteer_certs.words`), so a reprint years later says exactly what it said on the day.

They come from the gender on the certificate: *his* / *her* in English, the male or female form in
Arabic, and a wording that names neither when the gender is not known (the owner, 2026-11-08). The
same three sets live in three places, and they must agree:

| Where | What for |
|---|---|
| `_vol_cert_words()` in migration `20261108220000` | what every issued certificate is stamped with |
| `VC_WORDS` in `app.src.html` | prefills the form staff write one with; prints an older row |
| `CERT_WORDS` in mm-platform `apps/volunteers/src/client/main.ts` | the portal's own fallback |

`tests/certificate-template.spec.ts` holds the first two together. The third is in the other repo,
so it is on whoever changes the wording to carry it over.

A certificate for a period covers a stretch of days or a single one: picking "One day" sends the
same date as both ends, and the green box then prints that day once rather than twice.

Staff can also write a certificate themselves (`staff_volunteer_cert_issue_custom`): a typed name,
with or without an account, their own line in the green box, and any of the three lines rewritten.
The titles, the signatory and the layout stay the design's.

## What is built from it

`npm run build:cert` (which `npm run build:html` runs first) writes two files, both committed, both
served, neither to be edited by hand:

- `certificate.css` at the repo root — the stylesheet.
- `assets/certificate.html` — the markup with the three vectors inlined as data URIs.

`tests/certificate-template.spec.ts` fails when either is stale, and renders the three samples
against the acceptance checklist.

## How the two apps use it

Both fetch `assets/certificate.html`, fill it with the same Mustache subset (`{{key}}` escaped,
`{{#key}}…{{/key}}` kept while the key is truthy), open it in a window and print it:

- **The booking app**: `_vcPrint` in `app.src.html` (the Volunteers part). Staff make a certificate
  from a volunteer's Manage dialog: for a period, or for one event they worked.
- **The volunteer portal** (mm-platform `apps/volunteers`): the same file, synced by its own
  `npm run sync:cert` and committed there. Re-sync it whenever this folder changes, or the portal
  keeps printing the old design.

Two of the placeholders are each app's own: `{{css}}` is this stylesheet on that app's origin, and
`{{fonts}}` a sheet of that origin's carrying Space Grotesk and IBM Plex Sans Arabic.

## Two things the page cannot do itself

The window a certificate is printed from runs under the app's Content-Security-Policy, which allows
no inline `<script>` and no inline `<style>`. So:

- **The styles are a file**, never a `<style>` block.
- **The name is fitted by whoever opened the window**, not by a script in the page: the size comes
  from the name's length, then shrinks 1px at a time to 32px until it is on one line (SPEC.md,
  "Name size"). `_vcFit` in the booking app, `fitCert` in the portal. The same pass scales the whole
  sheet down on a phone, which the stylesheet reads as `--fit`.
- **Every script is taken out of the template before it is written.** Cloudflare adds its Web
  Analytics beacon to HTML it serves, and in production `assets/certificate.html` comes back with
  one before `</body>` — a third-party script that would load beside a volunteer's name and report
  every print. `_vcNoScripts` in the booking app and `stripScripts` in the portal remove any script,
  whoever added it. Keep the template itself script-free; the stripping is for what the host adds.

