// Re-renders certificate/reference/ from the certificate as it is built today, so the pictures in
// the kit are what the two apps actually print.
//
//   node scripts/render-certificate-reference.mjs        (npm run build:cert first)
//
// One PNG per record in certificate/sample-data.json, at the page's own 1123 x 794. It fills
// assets/certificate.html exactly as the apps do - the same Mustache subset, the same wording by
// gender, the same fit of the name to one line - and reads the stylesheet and the fonts off the
// disk, so nothing needs serving.
//
// Run it after any change to certificate/, and commit what it writes. SPEC.md's acceptance
// checklist is written against these three: a male volunteer with an Arabic name, a female
// volunteer without one, and a 40-character name.
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = join(root, 'certificate', 'reference');
// What these pictures were rendered from. reference/rendered-from.json keeps the three hashes, and
// tests/certificate-template.spec.ts fails when any of them has moved on: comparing the PNGs
// themselves would only tell us which machine drew them.
const SOURCES = ['assets/certificate.html', 'certificate.css', 'certificate/sample-data.json'];
const hash = (p) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex').slice(0, 16);

// The three lines the certificate prints, by gender: _vol_cert_words in the migration and VC_WORDS
// in app.src.html say the same, and tests/certificate-template.spec.ts holds those two together.
const WORDS = {
  male: { lead: 'This certificate is proudly presented to', recognition: 'in recognition of his time, energy and commitment as a volunteer in', arabic_line: 'تقديرًا لعطائه ومشاركته التطوعية في المبادرة' },
  female: { lead: 'This certificate is proudly presented to', recognition: 'in recognition of her time, energy and commitment as a volunteer in', arabic_line: 'تقديرًا لعطائها ومشاركتها التطوعية في المبادرة' },
  '': { lead: 'This certificate is proudly presented to', recognition: 'in recognition of their time, energy and commitment as a volunteer in', arabic_line: 'تقديرًا للعطاء والمشاركة التطوعية في المبادرة' },
};
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fill = (tpl, v) =>
  tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, k, body) => (v[k] ? body : ''))
     .replace(/\{\{(\w+)\}\}/g, (_m, k) => esc(v[k]));

// _vcFit in app.src.html, fitCert in the portal: the size from the name's length, then 1px at a
// time down to 32 until it is on one line.
const FIT = `(() => {
  const el = document.querySelector('.name');
  const n = String(el.textContent || '').trim().length;
  let px = n <= 16 ? 66 : n <= 22 ? 56 : n <= 28 ? 48 : 40;
  el.style.fontSize = px + 'px';
  while (el.scrollWidth > el.clientWidth && px > 32) { px -= 1; el.style.fontSize = px + 'px'; }
  if (el.scrollWidth > el.clientWidth) el.classList.add('wrap');
  document.querySelector('.rep-print').remove();
  document.documentElement.style.setProperty('--fit', '1');
})()`;

const safe = (s) => s.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase();
const tpl = readFileSync(join(root, 'assets', 'certificate.html'), 'utf8');
const samples = JSON.parse(readFileSync(join(root, 'certificate', 'sample-data.json'), 'utf8'));

mkdirSync(out, { recursive: true });
const made = [];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1123, height: 794 } });
// The filled page is written at the repo root so "certificate.css" and "fonts/fonts.css" beside it
// resolve as file:// URLs; the brand pictures and nothing else travel inside the template.
const tmp = join(root, `.certificate-reference-${process.pid}.html`);
try {
  for (const [i, s] of samples.entries()) {
    const w = WORDS[s.gender] ?? WORDS[''];
    writeFileSync(tmp, fill(tpl, {
      css: 'certificate.css', fonts: 'fonts/fonts.css',
      doc_title: 'Certificate of Volunteering', print_label: 'Print',
      volunteer_name: s.volunteer_name, volunteer_name_ar: s.volunteer_name_ar,
      lead: w.lead, recognition: w.recognition, arabic_line: w.arabic_line,
      initiative_name: s.initiative_name, event_date: s.event_date, certificate_no: s.certificate_no,
      hours: s.hours ?? '', check_code: s.check_code ?? '',
    }));
    await page.goto(pathToFileURL(tmp).href);
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(FIT);
    const name = `sample-${i + 1}-${safe(s.volunteer_name)}.png`;
    await page.locator('.page').screenshot({ path: join(out, name) });
    made.push(name);
    console.log('✔', name);
  }
} finally {
  rmSync(tmp, { force: true });
  await browser.close();
}

writeFileSync(join(out, 'rendered-from.json'), `${JSON.stringify({
  note: 'Generated by scripts/render-certificate-reference.mjs. The suite fails when these no longer match: npm run build:cert:reference.',
  files: made,
  sources: Object.fromEntries(SOURCES.map((p) => [p, hash(p)])),
}, null, 2)}\n`);
console.log('✔ rendered-from.json');
