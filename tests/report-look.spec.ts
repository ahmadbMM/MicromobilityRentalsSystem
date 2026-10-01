import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// How the printed reports read (the owner, 2026-10-01: "how can we improve the way the reports
// look" ... "do them all"): every sheet says which ride and which day it is for, money is
// "SAR 1,310.00" right-aligned in its column, the total is said once, the close-out is black with
// amber only for a pending sum, and from page 2 on the margins carry the title and "Page 2 of 3".

const D = '2099-02-08';
const sessions = [{
  id: 's0', day: 'Sunday', session_date: D, capacity: 12,
  status: 'open', created_at: 1, bike_slots: null, location: 'JCC', addons: null,
}];
const qe = (id: string, num: number, name: string, extra: Record<string, unknown>) => ({
  id, session_id: 's0', session_day: 'Sunday', session_date: D, queue_num: num, name,
  phone: `05000000${num}`, customer_id: null, type_preference: 'Hybrid',
  registered_at: '2099-01-01T10:00:00Z', status: 'done', ...extra,
});
const queue_entries = [
  qe('e1', 4, 'Card Rider', { paid: true, price: 1000, pay_method: 'card' }),
  qe('e2', 5, 'Cash Rider', { paid: true, price: 310, pay_method: 'cash' }),
];

async function grab(page: import('@playwright/test').Page, call: string) {
  return page.evaluate(`(() => {
    let cap = '';
    const orig = window.open;
    window.open = () => ({ document: { write: (h) => { cap = h; }, close() {} }, focus() {}, print() {} });
    try { ${call} } finally { window.open = orig; }
    return cap;
  })()`) as Promise<string>;
}

test.describe('the printed reports', () => {
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
  });

  test('the session report names its ride and day, groups money and says the total once', async ({ page }) => {
    const html = await grab(page, "S.sfSession='s0'; S._repOpts=_repDefaults(); printSessionReport();");
    const title = html.match(/<div class="mm-title"><strong>([^<]*)<\/strong>/);
    expect(title, 'a title line under the banner').not.toBeNull();
    expect(title![1]).toContain('Sunday');
    expect(html).toContain('<bdi>SAR 1,310.00</bdi>'); // Collected: grouped, two decimals
    expect(html).toContain('<bdi>SAR 1,000.00</bdi>'); // the Card tile, a tile of its own
    expect(html).toContain('<span class="rp-amt"><bdi>SAR 310.00</bdi></span>'); // a row's amount, aligned
    expect(html).toContain('#4'); // the booking number, apart from the 1, 2, 3 counter
    expect(html).not.toContain('mm-chip-row'); // the total is not repeated under the table
    expect(html).toContain('class="mm-note"'); // only the VAT inside it is
    expect(html).toContain('<bdi>Micromobility Co.</bdi>'); // its full stop stays at its end in Arabic
  });

  test('pages 2 on carry the title and the page number, in the reader\'s language', async ({ page }) => {
    const html = await grab(page, "S.sfSession='s0'; S._repOpts=_repDefaults(); printSessionReport();");
    const cssv = html.match(/<html[^>]*data-cssv="([^"]*)"/);
    expect(cssv).not.toBeNull();
    const vars = JSON.parse(cssv![1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
    expect(vars['--rp-pg']).toBe('"Page " counter(page) " of " counter(pages)');
    expect(vars['--rp-run']).toMatch(/^"Session Report · Sunday/);
    // The sheet is drawn with them on <html>, where the page margins read them.
    const p = await page.context().newPage();
    await p.goto('/robots.txt');
    await p.setContent(html, { waitUntil: 'networkidle' });
    await p.evaluate(`(()=>{const h=document.documentElement;const o=JSON.parse(h.getAttribute('data-cssv'));for(const k in o)h.style.setProperty(k,o[k]);})()`);
    expect(await p.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--rp-pg').trim()`)).toContain('counter(pages)');
    await p.close();
  });

  test('the close-out is black, amber only for money still owed, and says when nothing was sold', async ({ page }) => {
    const html = await grab(page, "S._ctSession='s0'; printCloseout();");
    expect(html).not.toMatch(/rp-(green|blue|violet)/);
    expect(html).not.toContain('rp-warn'); // nothing pending, so nothing amber
    expect(html).toContain('Nothing sold');
    expect(html).toContain('<div class="mm-title"><strong>Sunday'); // the day it closes
  });
});
