import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// The volunteer certificate's template: that the two served files are what certificate/ builds, and
// that the approved design still behaves on the three records in certificate/sample-data.json
// (certificate/SPEC.md, "Acceptance checklist"). The same file is filled by the volunteer portal.
const ROOT = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// The wording by gender, as the database stamps it and both apps carry it (see the test below).
const WORDS: Record<string, { lead: string; recognition: string; arabic_line: string }> = {
  male: { lead: 'This certificate is proudly presented to', recognition: 'in recognition of his time, energy and commitment as a volunteer in', arabic_line: 'تقديرًا لعطائه ومشاركته التطوعية في المبادرة' },
  female: { lead: 'This certificate is proudly presented to', recognition: 'in recognition of her time, energy and commitment as a volunteer in', arabic_line: 'تقديرًا لعطائها ومشاركتها التطوعية في المبادرة' },
  '': { lead: 'This certificate is proudly presented to', recognition: 'in recognition of their time, energy and commitment as a volunteer in', arabic_line: 'تقديرًا للعطاء والمشاركة التطوعية في المبادرة' },
};
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The same Mustache subset both apps fill with (_vcFill in app.src.html, fill() in the portal).
const fill = (tpl: string, v: Record<string, string>) =>
  tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, k: string, body: string) => (v[k] ? body : ''))
     .replace(/\{\{(\w+)\}\}/g, (_m, k: string) => esc(v[k]));

type Sample = { volunteer_name: string; volunteer_name_ar: string; gender: string; initiative_name: string; event_date: string;
  certificate_no: string; hours?: string; check_code?: string;
  role?: string; skills?: string; skills_ar?: string; partner?: string; partner_ar?: string; issued?: string };
// {{qr}} is a PNG data URL the caller draws on a canvas (QR.paint); any PNG stands in for it here.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
// Amendment 7's fields, as a sample carries them (the reference renders the same).
const extra = (s: Sample) => ({ role: s.role ?? '', skills: s.skills ?? '', skills_ar: s.skills_ar ?? '', partner: s.partner ?? '',
  partner_ar: s.partner_ar ?? '', issued: s.issued ?? '', qr: s.check_code ? PNG : '' });
const samples = JSON.parse(read('certificate/sample-data.json')) as Sample[];

// What the apps do to the window once its fonts are in: _vcFit in app.src.html, fitCert in the portal.
const FIT = `(() => {
  const el = document.querySelector('.name');
  const n = String(el.textContent || '').trim().length;
  let px = n <= 16 ? 66 : n <= 22 ? 56 : n <= 28 ? 48 : 40;
  el.style.fontSize = px + 'px';
  while (el.scrollWidth > el.clientWidth && px > 32) { px -= 1; el.style.fontSize = px + 'px'; }
  if (el.scrollWidth > el.clientWidth) el.classList.add('wrap');
  const body = document.querySelector('.body'), foot = document.querySelector('.footer'), sk = [...document.querySelectorAll('.skills')];
  let fs = 14;
  while (sk.length && foot.getBoundingClientRect().top - body.getBoundingClientRect().bottom < 16 && fs > 11) { fs -= 0.5; sk.forEach((e) => { e.style.fontSize = fs + 'px'; }); }
  return { px, wrapped: el.classList.contains('wrap'), fs };
})()`;

test('certificate.css and assets/certificate.html are what certificate/ builds', () => {
  const before = [read('certificate.css'), read('assets/certificate.html')];
  execFileSync(process.execPath, [resolve(ROOT, 'scripts/build-certificate.mjs')], { cwd: ROOT });
  const after = [read('certificate.css'), read('assets/certificate.html')];
  expect(after[0], 'certificate.css is stale — run `npm run build:cert` and commit it').toBe(before[0]);
  expect(after[1], 'assets/certificate.html is stale — run `npm run build:cert` and commit it').toBe(before[1]);
});

test('certificate/reference/ is a picture of the certificate as it is built now', () => {
  // Not a pixel comparison: two machines draw the same page differently enough to fail one, and a
  // baseline per platform is more upkeep than it is worth. The render records what it was made
  // from instead, so a design change that nobody re-rendered is the thing that fails here.
  const stamp = JSON.parse(read('certificate/reference/rendered-from.json')) as
    { files: string[]; sources: Record<string, string> };
  const sha = (p: string) => createHash('sha256').update(readFileSync(resolve(ROOT, p))).digest('hex').slice(0, 16);
  for (const [path, was] of Object.entries(stamp.sources)) {
    expect(sha(path), `${path} changed since certificate/reference/ was made — run \`npm run build:cert:reference\` and commit it`).toBe(was);
  }
  // One picture per sample, and nothing else left behind by an older set.
  expect(stamp.files.length).toBe(samples.length);
  const onDisk = readdirSync(resolve(ROOT, 'certificate/reference')).filter((f) => f.endsWith('.png')).sort();
  expect(onDisk).toEqual([...stamp.files].sort());
  for (const f of stamp.files) expect(statSync(resolve(ROOT, 'certificate/reference', f)).size).toBeGreaterThan(1000);
});

test('the template carries its own pictures, and names no font but the app\'s own sheet', () => {
  const html = read('assets/certificate.html');
  const css = read('certificate.css');
  // Three brand vectors, inlined: the apps are on two origins and neither needs a copy of them.
  expect(html.match(/src="data:image\/svg\+xml;base64,/g)?.length).toBe(3);
  expect(html).not.toContain('<script'); // the window's policy would refuse it; both apps fit the name themselves
  expect(html).not.toContain('<style'); // and refuse this too: the styles are {{css}}
  // The two families the page uses are each app's to serve, through {{fonts}}: no face is declared
  // here, and none is fetched from anywhere else.
  expect(css).not.toMatch(/@font-face\s*\{/);
  expect(css).not.toContain('fonts.googleapis.com');
  expect(css).toContain('size: 297mm 210mm'); // A4 landscape, no margin
  // Taken off the design by the owner (2026-11-08): the slogan, the address, the line that answers
  // the check code, and the green tick above the logo.
  for (const gone of ['Power your path', 'micromobility.com.sa', 'tagline', 'top-tick', 'Sacramento']) {
    expect(html, gone).not.toContain(gone);
    expect(css, gone).not.toContain(gone);
  }
});

test.describe('the three approved samples', () => {
  for (const [i, s] of samples.entries()) {
    test(`sample ${i + 1}: ${s.volunteer_name}`, async ({ page, baseURL }) => {
      const html = fill(read('assets/certificate.html'), {
        css: `${baseURL}/certificate.css`, fonts: `${baseURL}/fonts/fonts.css`,
        doc_title: 'Certificate of Volunteering', print_label: 'Print',
        volunteer_name: s.volunteer_name, volunteer_name_ar: s.volunteer_name_ar,
        lead: WORDS[s.gender].lead, recognition: WORDS[s.gender].recognition, arabic_line: WORDS[s.gender].arabic_line,
        initiative_name: s.initiative_name, event_date: s.event_date, certificate_no: s.certificate_no,
        // What the sample carries, so this and certificate/reference/ show the same sheet.
        hours: s.hours ?? '', check_code: s.check_code ?? '', ...extra(s),
      });
      expect(html).not.toContain('{{');
      await page.route('**/__certificate-under-test', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
      await page.goto('/__certificate-under-test');
      await page.evaluate(() => document.fonts.ready);
      const fit = await page.evaluate(FIT) as { px: number; wrapped: boolean };

      // One A4 landscape page, at the size the design is drawn at.
      const page_ = page.locator('.page');
      expect(await page_.evaluate((el: HTMLElement) => [el.offsetWidth, el.offsetHeight])).toEqual([1123, 794]);
      // The name is on one line, and clear of the corner graphic (SPEC.md: up to 979px).
      expect(fit.wrapped).toBe(false);
      expect(fit.px).toBeGreaterThanOrEqual(32);
      const name = await page_.locator('.name').evaluate((el: HTMLElement) => ({ w: el.scrollWidth, max: el.clientWidth }));
      expect(name.w).toBeLessThanOrEqual(979);
      expect(name.w).toBeLessThanOrEqual(name.max);
      // An empty Arabic name leaves no gap: the line itself is gone.
      expect(await page.locator('.name-ar').count()).toBe(s.volunteer_name_ar ? 1 : 0);
      // The hours are a line of their own under the thank-you, and only when there are some (the owner,
      // 2026-11-10); the date's column holds the date alone.
      if (s.hours) {
        await expect(page.locator('.hours-n')).toHaveText(s.hours);
        await expect(page.locator('.hours-label')).toHaveText('Volunteer hours · ساعات التطوع');
      } else expect(await page.locator('.hours').count()).toBe(0);
      expect(await page.locator('.meta-item').first().locator('.meta-sub').count()).toBe(0);
      // Both languages follow the gender (the owner, 2026-11-08).
      await expect(page.locator('.thanks-ar')).toHaveText(WORDS[s.gender].arabic_line);
      await expect(page.locator('.recognition')).toHaveText(WORDS[s.gender].recognition);
      await expect(page.locator('.thanks-ar')).toHaveAttribute('dir', 'rtl');
      // No text runs under the corner graphic (SPEC.md: "It must not overlap any text"). The
      // graphic's own box is where it sits, and the words are measured as ranges, not as the
      // boxes that hold them: a stretched column is 640px wide whatever its line is.
      const clash = await page.evaluate(() => {
        const g = document.querySelector('.supergraphic')!.getBoundingClientRect();
        const hit = (r: DOMRect) => r.right > g.left && r.left < g.right && r.bottom > g.top && r.top < g.bottom;
        return [...document.querySelectorAll('.content .lead, .content .name, .content .name-ar, .content .recognition, .content .initiative, .content .thanks-ar, .content .hours-n, .content .hours-label, .content .title-ar, .content .title-en, .meta-item, .meta-sub, .signer-name, .signer-role span, .fact-label, .role-v, .skills-v, .cohost-line, .check-label, .check-value, .qr')]
          .filter((el) => { const r = document.createRange(); r.selectNodeContents(el); return hit(r.getBoundingClientRect()); })
          .map((el) => el.className || el.tagName);
      });
      expect(clash, 'text under the corner graphic').toEqual([]);
      // Amendment 7 (2026-11-11): every new field is optional and an empty one leaves no line; the partner hangs
      // under the title and the check block (QR, issue date) in the right-hand column, both clear of the name;
      // the skills never push the footer off its place, even at the longest the database allows (sample 3).
      expect(await page.locator('.role').count()).toBe(s.role ? 1 : 0);
      expect(await page.locator('.skills').count()).toBe((s.skills ? 1 : 0) + (s.skills_ar ? 1 : 0));
      expect(await page.locator('.cohost-line').count()).toBe((s.partner ? 1 : 0) + (s.partner_ar ? 1 : 0));
      expect(await page.locator('.qr').count()).toBe(s.check_code ? 1 : 0);
      expect(await page.locator('.check-value').count()).toBe(s.issued ? 1 : 0);
      if (s.role) await expect(page.locator('.role-v')).toHaveText(s.role);
      if (s.partner_ar) await expect(page.locator('.cohost-line.ar')).toHaveAttribute('dir', 'rtl');
      if (s.skills_ar) await expect(page.locator('.skills.ar')).toHaveAttribute('dir', 'rtl');
      const place = await page.evaluate(() => {
        const box = (sel: string) => { const el = document.querySelector(sel); if (!el) return null; const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
        const name = box('.name')!, over = (a: DOMRect | null, b: DOMRect) => !!a && a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
        const foot = document.querySelector('.footer')!.getBoundingClientRect(), body = document.querySelector('.body')!.getBoundingClientRect();
        const top = document.querySelector('.page')!.getBoundingClientRect().top;
        return { cohost: over(box('.cohost'), name), check: over(box('.check'), name), footBottom: Math.round(foot.bottom - top), gap: Math.round(foot.top - body.bottom) };
      });
      expect(place.cohost, 'the partner touches the name').toBe(false);
      expect(place.check, 'the QR code touches the name').toBe(false);
      expect(place.gap, 'the body runs into the footer').toBeGreaterThanOrEqual(0);
      expect(place.footBottom, 'the footer was pushed off its place').toBeLessThanOrEqual(794 - 52 + 1);
      // The brand's three colours, and no other (SPEC.md, "Brand rules").
      expect(await page.locator('.initiative').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(3, 255, 137)');
      expect(await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(251, 249, 244)');
      expect(await page_.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(26, 25, 25)');
      // The faces the design names, from this origin.
      expect(await page_.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Space Grotesk');
      expect(await page.locator('.title-ar').evaluate((el) => getComputedStyle(el).fontFamily)).toContain('IBM Plex Sans Arabic');
    });
  }
});

test('a name with < & and quotes in it is text, never markup', async ({ page, baseURL }) => {
  const nasty = `A<b>&"'x`;
  const html = fill(read('assets/certificate.html'), {
    css: `${baseURL}/certificate.css`, fonts: `${baseURL}/fonts/fonts.css`, doc_title: 'C', print_label: 'Print',
    volunteer_name: nasty, volunteer_name_ar: '', lead: WORDS.male.lead, recognition: WORDS.male.recognition,
    arabic_line: WORDS.male.arabic_line, initiative_name: 'Test', event_date: '8 November 2026',
    certificate_no: 'MMV-2026-00001', hours: '', check_code: '',
  });
  await page.route('**/__certificate-under-test', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('/__certificate-under-test');
  await expect(page.locator('.name')).toHaveText(nasty);
  expect(await page.locator('.name b').count()).toBe(0);
});

test('the migration says what it promises, and leaves the certificates that exist alone', () => {
  const sql = read('supabase/migrations/20261108220000_volunteer_cert_template.sql');
  // The kind is what tells a period certificate from an event one, and every row that existed is a period one.
  expect(sql).toContain("add column if not exists kind       text not null default 'period'");
  expect(sql).toContain("check (kind in ('period', 'session', 'custom'))");
  for (const col of ['session_id', 'initiative', 'event_date', 'name_ar', 'gender', 'words']) {
    expect(sql, `volunteer_certs.${col}`).toContain(`add column if not exists ${col}`);
  }
  expect(sql).toContain('alter table public.customers add column if not exists name_ar');
  // One live certificate per person per event: the bulk call is a button staff can press twice.
  expect(sql).toContain('create unique index if not exists volunteer_certs_one_per_session');
  expect(sql).toMatch(/where kind = 'session' and revoked_at is null/);
  // Every function the two apps call, and every one of them a definer with a fixed search_path.
  for (const fn of ['_vol_cert_make_session', 'staff_volunteer_cert_issue_session', 'staff_volunteer_cert_issue_session_many',
                    'volunteer_cert_issue_session', 'volunteer_name_ar_save', 'volunteer_cert_check', 'volunteer_profile', '_vol_cert_make',
                    '_vol_cert_words', '_vol_gender', 'staff_volunteer_cert_issue', 'staff_volunteer_cert_issue_custom', 'volunteer_cert_issue']) {
    expect(sql, fn).toContain(`create or replace function public.${fn}(`);
  }
  const made = sql.match(/create or replace function/g)?.length ?? 0;
  // Every one of them fixes its search_path; the two that only return text are plain, not definers.
  expect(sql.match(/set search_path to 'public'/g)?.length).toBe(made);
  expect(sql.match(/security definer/g)?.length).toBe(made - 2);
  // The old four- and three-argument ones go, rather than becoming overloads of the new ones.
  expect(sql).toContain('drop function if exists public._vol_cert_make(text, date, date, text);');
  expect(sql).toContain('drop function if exists public.staff_volunteer_cert_issue(text, date, date);');
  // The portal's own calls check the token before anything else; the staff ones check the section.
  for (const fn of ['volunteer_cert_issue_session', 'volunteer_name_ar_save']) {
    const body = sql.slice(sql.indexOf(`function public.${fn}(`));
    expect(body.slice(0, body.indexOf('end $function$')), fn).toContain('_cust_token_ok(p_id, p_token)');
  }
  for (const fn of ['staff_volunteer_cert_issue_session', 'staff_volunteer_cert_issue_session_many']) {
    const body = sql.slice(sql.indexOf(`function public.${fn}(`));
    expect(body.slice(0, body.indexOf('end $function$')), fn).toContain("_staff_mod('volunteers', true)");
  }
  // The helpers stay the server's own.
  expect(sql).toContain('revoke all on function public._vol_cert_make_session(text, text, text, text, text) from public, anon, authenticated');
});

test('the wording by gender says the same thing in the database and in the app', () => {
  const sql = read('supabase/migrations/20261108220000_volunteer_cert_template.sql');
  const app = read('app.src.html');
  // _vol_cert_words in the migration is what every issued certificate carries; VC_WORDS in the app
  // prefills the form staff write one with, and prints a row from before the words were stored.
  // The volunteer portal has the third copy (CERT_WORDS in apps/volunteers/src/client/main.ts),
  // which this repo's suite cannot see - certificate/README.md says to keep it with these two.
  const fn = sql.slice(sql.indexOf('function public._vol_cert_words('), sql.indexOf('/* -- 4a.'));
  const table = app.slice(app.indexOf('const VC_WORDS={'), app.indexOf('function _vcWords('));
  for (const line of Object.values(WORDS).flatMap((w) => [w.lead, w.recognition, w.arabic_line])) {
    expect(fn, `the database is missing: ${line}`).toContain(line);
    expect(table, `the app is missing: ${line}`).toContain(line);
  }
  // And no other wording hiding in either of them.
  expect((fn.match(/in recognition of/g) ?? []).length).toBe(3);
  expect((table.match(/in recognition of/g) ?? []).length).toBe(3);
});

test('a certificate staff write themselves is a certificate like any other', () => {
  const sql = read('supabase/migrations/20261108220000_volunteer_cert_template.sql');
  expect(sql).toContain("check (kind in ('period', 'session', 'custom'))");
  expect(sql).toContain('create or replace function public.staff_volunteer_cert_issue_custom(');
  // It is the one kind that may have no account behind it, and the only one.
  expect(sql).toContain("check (customer_id is not null or kind = 'custom')");
  const body = sql.slice(sql.indexOf('function public.staff_volunteer_cert_issue_custom('));
  const head = body.slice(0, body.indexOf('end $function$'));
  expect(head).toContain("_staff_mod('volunteers', true)"); // staff only
  expect(head).toContain('BAD_INPUT'); // a name and what it is for are both required
  expect(head).toContain('_vol_cert_words(_g)'); // the gender's wording underneath whatever staff wrote
  expect(head).toContain("'pending-' || _code"); // a serial and a check code, like the rest
});

test('the widest footer there can be still clears the corner graphic', async ({ page, baseURL }) => {
  // The serial is always MMV-YYYY-NNNNN and the check code always twelve characters, so this is as
  // wide as the No. column ever gets (the hours are in the body since 2026-11-10, no longer under the date).
  const html = fill(read('assets/certificate.html'), {
    css: `${baseURL}/certificate.css`, fonts: `${baseURL}/fonts/fonts.css`, doc_title: 'C', print_label: 'Print',
    volunteer_name: 'Sara Abdulrahman Al-Qahtani', volunteer_name_ar: 'سارة عبدالرحمن القحطاني',
    lead: WORDS.female.lead, recognition: WORDS.female.recognition, arabic_line: WORDS.female.arabic_line,
    initiative_name: 'Corniche Community Ride', event_date: '15 November 2026', hours: '12.5',
    certificate_no: 'MMV-2026-99999', check_code: 'WWWWWWWWWWWW',
  });
  await page.route('**/__certificate-under-test', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('/__certificate-under-test');
  await page.evaluate(() => document.fonts.ready);
  const gap = await page.evaluate(() => {
    const g = document.querySelector('.supergraphic')!.getBoundingClientRect();
    const right = Math.max(...[...document.querySelectorAll('.meta-item')].map((el) => {
      const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().right;
    }));
    return Math.round(g.left - right);
  });
  // Generous on purpose: Linux and macOS measure the Arabic in the labels differently, and the kit's
  // own 36px gap and 270px signature block left this at nothing on one and under the graphic on the other.
  expect(gap, `the footer has ${gap}px before the corner graphic, which is not enough to hold on every machine`).toBeGreaterThanOrEqual(12);
});
