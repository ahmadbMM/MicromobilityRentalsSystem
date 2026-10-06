import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The booking ticket (the owner, 2026-09-30: "why is it out of frame"). Where made it five
// fields in a four-column grid, so Name sat alone on a second row, and the pay and helmet
// lines had no side padding, touching the card's edge while everything else was inset.

const S1 = '2099-02-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 10, created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":10}' }];

for (const width of [390, 800]) {
  test(`the ticket's fields and lines sit inside the card at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1400 });
    await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';
      S.lastTickets=[{id:'t1',queueNum:7,sessionId:'${S1}',sessionDay:'Sunday',sessionDate:'${S1}',name:'Spec Rider',status:'waiting',paid:false,price:75}];renderRegister();`);
    const card = page.locator('#tab-register .ticket-card');
    await expect(card.locator('.tk-owe')).toBeVisible();
    const m = await card.evaluate((c) => {
      const box = c.getBoundingClientRect();
      const notes = [...c.querySelectorAll(':scope>.price-note')].map((n) => {
        const r = document.createRange();
        r.selectNodeContents(n);
        const t = r.getBoundingClientRect();
        return { left: t.left - box.left, right: box.right - t.right };
      });
      const tops = [...c.querySelectorAll('.ticket-col')].map((e) => Math.round(e.getBoundingClientRect().top));
      const rows = [...new Set(tops)].map((t) => tops.filter((x) => x === t).length);
      return { notes, rows };
    });
    expect(m.notes.length).toBe(2);
    for (const n of m.notes) {
      expect(n.left).toBeGreaterThanOrEqual(20);
      expect(n.right).toBeGreaterThanOrEqual(20);
    }
    // Five fields: three then two on a desk, two, two and one across on a phone; never one alone beside empty columns.
    expect(m.rows).toEqual(width < 560 ? [2, 2, 1] : [3, 2]);
  });
}

// The owner, 2026-09-30: "make the booking card include micromobility's logo in the top corner".
// The start corner (right in Arabic), clear of the QR code. Since 2026-10-06 ("make all booking cards themed
// the same way the event card is themed") the mark is the event card's own: the circuit's white JCC mark.
for (const lang of ['en', 'ar']) {
  test(`the booking card wears its event's mark in its top start corner (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1400 });
    await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/?lang=' + lang);
    await waitForSb(page);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';
      S.lastTickets=[{id:'t1',queueNum:7,sessionId:'${S1}',sessionDay:'Sunday',sessionDate:'${S1}',name:'Spec Rider',status:'waiting',paid:false,price:75}];renderRegister();`);
    const card = page.locator('#tab-register .ticket-card');
    await expect(card).toHaveClass(/\bth-jcc\b/);
    await expect(card.locator('.tk-logo-ev .tk-logo-jcc')).toBeVisible(); // the circuit card's white JCC mark
    await expect(card.locator('.tk-logo-l, .tk-logo-d')).toHaveCount(0);
    const m = await card.evaluate((c) => {
      const box = c.getBoundingClientRect(), l = c.querySelector('.tk-logo-ev img')!.getBoundingClientRect();
      const q = c.querySelector('.ticket-qr-wrap, .cu-qr-box')?.getBoundingClientRect();
      return { top: l.top - box.top, start: document.dir === 'rtl' ? box.right - l.right : l.left - box.left, h: l.height, clear: !q || l.bottom <= q.top || l.right <= q.left || l.left >= q.right };
    });
    expect(m.top).toBeLessThan(20);
    expect(m.start).toBeLessThan(20);
    expect(Math.round(m.h)).toBe(40);
    expect(m.clear).toBe(true);
  });
}

// The owner, 2026-09-30: the logo lay over "Queue number" on older bookings. On My Bookings it heads
// the number's column in the flow; on the card after booking the top line starts below it. Past,
// waitlist and live cards, in English and Arabic: the logo meets no text.
for (const lang of ['en', 'ar']) {
  test(`the logo covers no text on any booking card (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 3000 });
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
    const off = (n: number) => { const [y, m, d] = today.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
    const jcc = (id: string, date: string, o: Record<string, unknown> = {}) => ({ id, day: 'Sunday', session_date: date, capacity: 20, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":20}', ...o });
    const bk = (o: Record<string, unknown>) => ({ name: 'Spec Rider', customer_id: 'c1', session_day: 'Sunday', queue_num: 7, status: 'waiting', paid: false, price: 75, type_preference: 'Road', registered_at: '2099-01-01T10:00:00Z', ...o });
    const s = [jcc('fut', off(3)), jcc('old', off(-10), { status: 'closed' }), jcc('wl', off(5))];
    await stubSupabase(page, { sessions: s, 'rpc:list_sessions': s, bikes: [], 'rpc:community_member': true, queue_entries: [
      bk({ id: 'b1', session_id: 'fut', session_date: off(3) }),
      bk({ id: 'b3', session_id: 'old', session_date: off(-10), status: 'done', paid: true, queue_num: 12 }),
      bk({ id: 'b4', session_id: 'wl', session_date: off(5), status: 'waitlist', waitlist_num: 2 })] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/?lang=' + lang);
    await waitForSb(page);
    await page.evaluate("goCustomer('myrides')");
    await expect(page.locator('#tab-myrides .ticket-card.tk-past')).toBeVisible();
    await expect(page.locator('#tab-myrides .ticket-card.tk-wl')).toBeVisible();
    const hits = async () => page.evaluate(() => [...document.querySelectorAll('.ticket-card')].filter((c) => (c as HTMLElement).offsetParent).flatMap((c) => {
      const logo = [...c.querySelectorAll('.tk-logo img')].find((i) => (i as HTMLElement).offsetParent);
      if (!logo) return ['no logo: ' + c.className];
      const l = logo.getBoundingClientRect();
      return [...c.querySelectorAll('.ticket-num-label, .ticket-num, .wl-loud, .cu-tk-label, .ticket-right, .cu-qr-box')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width && !(r.bottom <= l.top || r.top >= l.bottom || r.right <= l.left || r.left >= l.right);
      }).map((e) => c.className + ' ✕ ' + e.className);
    }));
    expect(await hits()).toEqual([]);
    // and the card after booking, on the waitlist
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='wl';
      S.lastTickets=[{id:'t1',queueNum:7,sessionId:'wl',sessionDay:'Sunday',sessionDate:'${off(5)}',name:'Spec Rider',status:'waitlist',waitlistNum:2,paid:false,price:75}];renderRegister();`);
    await expect(page.locator('#tab-register .ticket-card')).toBeVisible();
    expect(await hits()).toEqual([]);
  });
}
