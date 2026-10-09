import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Ride reminders (2026-10-09, R7): a Reminders sheet on a ride's Bookings, one WhatsApp per rider in the
// rider's language with a "Can't come?" link to My Bookings, the run of Next / Skip like the segment
// messages, and the booking marked (queue_entries.reminded_at / reminded_kind, 20261009225000).
const sessions = [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, bike_slots: JSON.stringify({ _time: '19:00 - 21:00' }) }];
const qe = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  id, name: 'Rider ' + ['One', 'Two', 'Three', 'Four', 'Five'][n - 1], phone: '05000000' + n + n, session_id: 's1', session_day: 'Friday', session_date: '2099-01-09',
  queue_num: n, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-08T10:00:00Z', ...extra,
});
const customers = [{ id: 'c1', name: 'Rider One', phone: '0500000011', nationality: 'PK' }, { id: 'c2', name: 'Rider Two', phone: '0500000022', nationality: 'SA' }];

async function open(page: Page, withCol = true) {
  const col = withCol ? { reminded_at: null, reminded_kind: null } : {};
  const queue_entries = [
    qe('e1', 1, { customer_id: 'c1', ...col }), qe('e2', 2, { customer_id: 'c2', ...col }), qe('e3', 3, col),
    qe('e4', 4, { status: 'waitlist', waitlist_num: 1, ...col }), qe('e5', 5, { status: 'cancelled', ...col }),
  ];
  await stubSupabase(page, { sessions, queue_entries, bikes: [], customers, staff_options: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0&&typeof _r7Bell==='function'`);
  await page.evaluate(`window.__opened=[];window.open=(u)=>{window.__opened.push(String(u));return null;};S.customers=${JSON.stringify(customers)};`);
}
function patches(page: Page) {
  const out: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes('queue_entries')) out.push(decodeURIComponent(r.url()) + ' ' + (r.postData() || '')); });
  return out;
}

test.describe('@staff:bookings ride reminders', () => {
  test('the Reminders button opens a sheet of the riders holding a place, each in their language', async ({ page }) => {
    await open(page);
    await page.evaluate(`setStaffTab('queue');S.queueView='bookings';setSfSession('s1')`);
    await page.locator('.rem-open').click();
    const dlg = page.locator('[role="dialog"][aria-labelledby="rem-title"]');
    await expect(dlg).toBeVisible();
    await expect(dlg.locator('.rem-row')).toHaveCount(3); // the waitlisted and the cancelled rider get no reminder
    await expect(dlg.locator('.rem-lang').nth(0)).toHaveValue('ur'); // Pakistan
    await expect(dlg.locator('.rem-lang').nth(1)).toHaveValue('ar'); // Saudi Arabia
    await expect(dlg.locator('.rem-lang').nth(2)).toHaveValue('en'); // no account
  });

  test('Send opens WhatsApp with the reminder and the cancel link, and marks the booking', async ({ page }) => {
    await open(page);
    const w = patches(page);
    await page.evaluate(`openRemindSheet('s1','24h')`);
    await page.locator('.rem-row').nth(1).locator('.rem-send').click();
    await expect.poll(() => page.evaluate('window.__opened.length')).toBe(1);
    const url = (await page.evaluate('window.__opened[0]')) as string;
    expect(url).toContain('https://wa.me/966500000022');
    const text = decodeURIComponent(url.split('text=')[1]);
    expect(text).toContain('مرحباً Rider');
    expect(text).toContain('/my-bookings?lang=ar');
    await expect.poll(() => w.find((x) => /reminded_at/.test(x))).toBeTruthy();
    const p = w.find((x) => /reminded_at/.test(x))!;
    expect(p).toContain('id=in.(e2)');
    expect(p).toContain('"reminded_kind":"24h"');
    await expect(page.locator('.rem-row').nth(1)).toHaveClass(/done/);
  });

  test('the language picker changes the message; the 2 hour reminder says today', async ({ page }) => {
    await open(page);
    await page.evaluate(`openRemindSheet('s1','2h')`);
    await page.locator('.rem-row').nth(2).locator('.rem-lang').selectOption('fr');
    await page.locator('.rem-row').nth(2).locator('.rem-send').click();
    await expect.poll(() => page.evaluate('window.__opened.length')).toBe(1);
    const text = decodeURIComponent(((await page.evaluate('window.__opened[0]')) as string).split('text=')[1]);
    expect(text).toContain("aujourd'hui");
    expect(text).toContain('/my-bookings?lang=fr');
  });

  test('the run goes rider by rider with Next and Skip, then says what was sent', async ({ page }) => {
    await open(page);
    await page.evaluate(`openRemindSheet('s1','24h')`);
    await page.getByRole('button', { name: /Send to the 3 not reminded/ }).click();
    await expect(page.locator('.seg-pn')).toHaveText(/1.*3/);
    await page.locator('.seg-prog .btn-green').click();
    await expect(page.locator('.seg-pn')).toHaveText(/2.*3/);
    await page.locator('.seg-prog .btn-secondary').first().click(); // Skip
    await page.locator('.seg-prog .btn-green').click();
    await expect(page.locator('.seg-prog b')).toBeVisible();
    await expect(page.locator('.seg-prog .am-meta')).toContainText('2');
    expect(await page.evaluate('window.__opened.length')).toBe(2);
  });

  test('before the database has the columns, nothing is written and the sheet says so', async ({ page }) => {
    await open(page, false);
    const w = patches(page);
    await page.evaluate(`openRemindSheet('s1','24h')`);
    await expect(page.locator('.rem-local')).toBeVisible();
    await page.locator('.rem-row').first().locator('.rem-send').click();
    await expect(page.locator('.rem-row').first()).toHaveClass(/done/);
    await page.waitForTimeout(300);
    expect(w.filter((x) => /reminded_at/.test(x))).toHaveLength(0);
  });

  test('the templates carry the three messages in all ten languages', async ({ page }) => {
    await open(page);
    const r = await page.evaluate(`(()=>{const ids=['remind_24h','remind_2h','wl_offer'];return{rows:ids.map(id=>!!_tplDef(id)),
      all:LANGS.every(l=>ids.every(id=>{const v=_tplDefault(id,l.code);return v&&/\\{first_name\\}/.test(v)&&(id==='wl_offer'?/\\{claim_link\\}/.test(v):/\\{cancel_link\\}/.test(v));})),
      hi:_tplDefault('remind_24h','hi').startsWith('नमस्ते {first_name}')}})()`);
    expect(r).toEqual({ rows: [true, true, true], all: true, hi: true });
  });
});

test.describe('@staff:bookings reminder bell', () => {
  test('from 14:00 the day before, tomorrow\'s ride with riders not reminded is in the bell', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2099-01-08T12:00:00Z')); // 15:00 KSA, the day before the ride
    await open(page);
    const items = await page.evaluate(`(()=>{const out=[];_r7Bell((k,items)=>out.push([k,items.map(i=>i.id)]),{queue:true});return out;})()`);
    expect(items).toEqual([['remind', ['rm:s1']], ['wlfree', []]]); // Automatic (the default): a free place is never left waiting
    expect(await page.evaluate(`NT_KINDS.map(k=>k[0]).includes('remind')&&NT_KINDS.map(k=>k[0]).includes('wlfree')`)).toBe(true);
  });

  test('before 14:00 the day before, the bell does not ask yet', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2099-01-08T08:00:00Z')); // 11:00 KSA
    await open(page);
    expect(await page.evaluate(`_remDue().length`)).toBe(0);
  });
});
