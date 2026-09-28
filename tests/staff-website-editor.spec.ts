import zlib from 'node:zlib';
import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Website section's content editor: built from the pages micromobility.sa declares at
// /api/site-schema, saving each section to site_content, putting fields back to the design's
// words, editing lists, uploading photos, and opening the staff preview.

const bi = (en: string, ar: string) => ({ en, ar });
const SCHEMA = {
  version: 1,
  pages: [
    { page: 'site', label: bi('Whole site', 'الموقع كاملاً'), sections: [
      { id: 'contact', label: bi('Contact and hours', 'التواصل والمواعيد'), fields: [
        { id: 'phone', type: 'text', max: 24, label: bi('Phone', 'الجوال'), def: bi('+966566668818', '+966566668818') },
      ] },
    ] },
    { page: 'home', label: bi('Home', 'الرئيسية'), sections: [
      { id: 'hero', label: bi('Hero', 'الواجهة'), fields: [
        { id: 'title', type: 'text', max: 70, label: bi('Title', 'العنوان'), def: bi('Carbon speed, built for Jeddah.', 'سرعة الكربون، صُنعت لجدة.') },
        { id: 'text', type: 'longtext', max: 220, label: bi('Text', 'النص'), def: bi('Hand-built.', 'تُبنى يدوياً.') },
        { id: 'image', type: 'image', label: bi('Bike photo', 'صورة الدراجة'), def: '/site/home/hero-bike.webp' },
        { id: 'badges', type: 'list', maxItems: 2, label: bi('Promises', 'الوعود'),
          item: [{ id: 'title', type: 'text', max: 40, label: bi('Title', 'العنوان'), def: bi('', '') }],
          def: [{ title: bi('Hand-built', 'مبنية يدوياً') }] },
      ] },
      { id: 'visit', label: bi('Find us', 'موقعنا'), fields: [
        { id: 'rating', type: 'number', min: 0, max: 5, step: 0.1, label: bi('Google rating', 'تقييم قوقل'), def: 0 },
        { id: 'reviewsHref', type: 'link', label: bi('Reviews link', 'رابط التقييمات'), def: 'https://maps.app.goo.gl/x' },
        { id: 'showMap', type: 'toggle', label: bi('Show the map', 'إظهار الخريطة'), def: true },
      ] },
    ] },
  ],
};

type Write = { method: string; url: string; body: unknown };
async function open(page: Page, rows: unknown[] = [], schema: unknown = SCHEMA) {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], site_content: rows, site_content_history: [] });
  await page.route('https://micromobility.sa/api/site-schema', r => schema === null
    ? r.fulfill({ status: 503, body: 'down' })
    : r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(schema) }));
  await page.route('https://micromobility.sa/site/**', r => r.fulfill({ status: 200, contentType: 'image/webp', body: '' }));
  await unlockStaff(page);
  const writes: Write[] = [];
  page.on('request', r => {
    if (/\/rest\/v1\/site_content(\?|$)/.test(r.url()) && !['GET', 'OPTIONS', 'HEAD'].includes(r.method())) {
      let body: unknown = null; try { body = r.postDataJSON(); } catch { /* none */ }
      writes.push({ method: r.method(), url: decodeURIComponent(r.url()), body });
    }
  });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('website')`);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  return writes;
}
const field = (page: Page, sel: string) => page.locator(`#tab-website ${sel}`);

test('the editor lists the pages the website declares, first section open', async ({ page }) => {
  await open(page);
  await expect(page.locator('#tab-website')).toContainText('Page content');
  await expect(page.getByRole('button', { name: 'Whole site' })).toBeVisible();
  await expect(field(page, '#we-home-hero-title')).toHaveValue('Carbon speed, built for Jeddah.');
  await expect(field(page, '#we-home-hero-title-ar')).toHaveValue('سرعة الكربون، صُنعت لجدة.');
  await expect(page.locator('[data-web-save="home.hero"]')).toBeDisabled();
});

test('a text can be written in the website\'s other languages; an empty one is not saved', async ({ page }) => {
  const writes = await open(page);
  const more = page.locator('#tab-website .web-ed-field').filter({ has: page.locator('#we-home-hero-title') }).locator('details.web-ed-more');
  await expect(more.locator('summary')).toHaveText('Other languages (0 of 14)');
  await expect(page.locator('#tab-website .web-ed-field').filter({ has: page.locator('#we-home-hero-image') }).locator('details.web-ed-more')).toHaveCount(0); // a photo has no words
  await more.locator('summary').click();
  await field(page, '#we-home-hero-title-de').fill('Carbon-Tempo, gebaut für Dschidda.');
  await field(page, '#we-home-hero-title-ja').fill('x');
  await field(page, '#we-home-hero-title-ja').fill('');
  await page.locator('[data-web-save="home.hero"]').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual([{ key: 'home.hero.title', value: { en: 'Carbon speed, built for Jeddah.', ar: 'سرعة الكربون، صُنعت لجدة.', de: 'Carbon-Tempo, gebaut für Dschidda.' }, updated_by: 'Spec Staff' }]);
});

test('a field that is one value everywhere, or English and Arabic only, offers no other languages', async ({ page }) => {
  const schema = JSON.parse(JSON.stringify(SCHEMA));
  schema.pages[1].sections[0].fields.push(
    { id: 'code', type: 'text', max: 10, mono: true, label: bi('Code', 'الرمز'), def: bi('X1', 'X1') },
    { id: 'legal', type: 'longtext', max: 400, enArOnly: true, label: bi('Legal', 'قانوني'), def: bi('Terms.', 'الشروط.') },
  );
  await open(page, [], schema);
  for (const id of ['code', 'legal']) {
    await expect(page.locator('#tab-website .web-ed-field').filter({ has: page.locator(`#we-home-hero-${id}`) }).locator('details.web-ed-more')).toHaveCount(0);
  }
});

test('a text edit saves as one row, signed, and undo removes it again', async ({ page }) => {
  const writes = await open(page);
  await field(page, '#we-home-hero-title').fill('Built for the corniche.');
  await expect(page.locator('[data-web-save="home.hero"]')).toBeEnabled();
  await page.locator('[data-web-save="home.hero"]').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('POST');
  expect(writes[0].body).toEqual([{ key: 'home.hero.title', value: { en: 'Built for the corniche.', ar: 'سرعة الكربون، صُنعت لجدة.' }, updated_by: 'Spec Staff' }]);
  await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', /Website: changed/); // the topbar's Undo names it
  await page.evaluate(`doUndo()`);
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].method).toBe('DELETE');
  expect(writes[1].url).toContain('key=in.(home.hero.title)');
});

test('Original puts a saved field back to the design wording', async ({ page }) => {
  const writes = await open(page, [{ key: 'home.hero.title', value: { en: 'Old words', ar: 'قديم' } }]);
  await expect(field(page, '#we-home-hero-title')).toHaveValue('Old words');
  await page.locator('#tab-website .web-ed-row', { has: page.locator('#we-home-hero-title') }).getByRole('button', { name: 'Original' }).click();
  await expect(field(page, '#we-home-hero-title')).toHaveValue('Carbon speed, built for Jeddah.');
  await page.locator('[data-web-save="home.hero"]').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].method).toBe('DELETE');
  expect(writes[0].url).toContain('key=in.(home.hero.title)');
});

test('lists: add, fill and save; the limit is respected', async ({ page }) => {
  const writes = await open(page);
  const list = page.locator('#tab-website .web-ed-list');
  await expect(list).toContainText('1 / 2');
  await list.getByRole('button', { name: '+ Add' }).click();
  await expect(list).toContainText('2 / 2');
  await expect(list.getByRole('button', { name: '+ Add' })).toBeDisabled();
  await field(page, '#we-home-hero-badges-1-title').fill('Always supported');
  await field(page, '#we-home-hero-badges-1-title-ar').fill('دعم دائم');
  await page.locator('[data-web-save="home.hero"]').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual([{ key: 'home.hero.badges', value: [{ title: bi('Hand-built', 'مبنية يدوياً') }, { title: bi('Always supported', 'دعم دائم') }], updated_by: 'Spec Staff' }]);
});

test('a bad link or number is refused before anything is sent', async ({ page }) => {
  const writes = await open(page);
  await page.getByRole('button', { name: 'Find us' }).click();
  await field(page, '#we-home-visit-reviewsHref').fill('javascript:alert(1)');
  await page.locator('[data-web-save="home.visit"]').click();
  await expect(page.locator('.toast').last()).toContainText('must start with https://');
  await field(page, '#we-home-visit-reviewsHref').fill('https://maps.app.goo.gl/y');
  await field(page, '#we-home-visit-rating').fill('9');
  await page.locator('[data-web-save="home.visit"]').click();
  await expect(page.locator('.toast').last()).toContainText('not a valid number');
  expect(writes).toHaveLength(0);
  await field(page, '#we-home-visit-rating').fill('4.8');
  await page.locator('[data-web-save="home.visit"]').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].body).toEqual([
    { key: 'home.visit.rating', value: 4.8, updated_by: 'Spec Staff' },
    { key: 'home.visit.reviewsHref', value: { href: 'https://maps.app.goo.gl/y' }, updated_by: 'Spec Staff' },
  ]);
});

test('a photo is shrunk, uploaded to the site bucket and used by path', async ({ page }) => {
  const writes = await open(page);
  let uploaded = '';
  await page.route(/\/storage\/v1\/object\/site\//, r => { uploaded = decodeURIComponent(r.request().url()); return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ Key: 'site/x', Id: '1' }) }); });
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#tab-website .web-ed-img').getByRole('button', { name: 'Upload photo' }).click();
  // a 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await (await chooser).setFiles({ name: 'bike.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.toast').last()).toContainText('Photo uploaded');
  expect(uploaded).toMatch(/\/storage\/v1\/object\/site\/home\/[a-z0-9]+-[a-z0-9]+\.png$/);
  await page.locator('[data-web-save="home.hero"]').click();
  await expect.poll(() => writes.length).toBe(1);
  const b = writes[0].body as { key: string; value: { url: string } }[];
  expect(b[0].key).toBe('home.hero.image');
  expect(b[0].value.url).toMatch(/^\/media\/home\/[a-z0-9]+-[a-z0-9]+\.png$/);
});

// A plain PNG of any size, for uploads larger than the website's smaller copies.
function solidPng(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([len, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0x55)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('a large photo also gets the 640 and 1280 px WebP copies the website asks for', async ({ page }) => {
  await open(page);
  const uploads: { url: string }[] = [];
  await page.route(/\/storage\/v1\/object\/site\//, r => {
    uploads.push({ url: decodeURIComponent(r.request().url()) });
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ Key: 'site/x', Id: '1' }) });
  });
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#tab-website .web-ed-img').getByRole('button', { name: 'Upload photo' }).click();
  await (await chooser).setFiles({ name: 'wide.png', mimeType: 'image/png', buffer: solidPng(1500, 800) });
  await expect(page.locator('.toast').last()).toContainText('Photo uploaded');
  const main = uploads[0].url.match(/site\/(home\/[a-z0-9]+-[a-z0-9]+)\.png$/);
  expect(main).not.toBeNull();
  expect(uploads.slice(1).map(u => u.url.replace(/^.*\/object\/site\//, ''))).toEqual([`${main![1]}.w640.webp`, `${main![1]}.w1280.webp`]);
});

test('when micromobility.sa cannot be reached it says so, with a retry', async ({ page }) => {
  await stubSupabase(page, { sessions: [], queue_entries: [], bikes: [], site_content: [], site_content_history: [] });
  await page.route('https://micromobility.sa/api/site-schema', r => r.fulfill({ status: 503, body: 'down' }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('website')`);
  await expect(page.locator('#tab-website')).toContainText('Could not reach micromobility.sa');
  await expect(page.locator('#tab-website').getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('Preview opens the site with the staff token in the fragment, never the address', async ({ page }) => {
  await open(page);
  await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(u);return null;};sb.auth.getSession=async()=>({data:{session:{access_token:'aaa.bbb.ccc'}}});`);
  await page.locator('#tab-website').getByRole('button', { name: 'Preview website' }).click();
  await expect.poll(() => page.evaluate('window.__opened.length')).toBe(1);
  expect(await page.evaluate('window.__opened[0]')).toBe('https://micromobility.sa/en/preview#t=aaa.bbb.ccc');
});

test('without a staff session, Preview asks to sign in again', async ({ page }) => {
  await open(page);
  await page.evaluate(`sb.auth.getSession=async()=>({data:{session:null}})`);
  await page.locator('#tab-website').getByRole('button', { name: 'Preview website' }).click();
  await expect(page.locator('.toast').last()).toContainText('Sign in again');
});
