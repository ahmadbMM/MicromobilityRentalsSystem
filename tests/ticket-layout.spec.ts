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
// The start corner (right in Arabic), the white-lettered logo on the dark card, clear of the QR code.
for (const lang of ['en', 'ar']) {
  test(`the booking card wears the MicroMobility logo in its top start corner (${lang})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1400 });
    await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: [], bikes: [] });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
    await page.goto('/?lang=' + lang);
    await waitForSb(page);
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${S1}';
      S.lastTickets=[{id:'t1',queueNum:7,sessionId:'${S1}',sessionDay:'Sunday',sessionDate:'${S1}',name:'Spec Rider',status:'waiting',paid:false,price:75}];renderRegister();`);
    const card = page.locator('#tab-register .ticket-card');
    await expect(card.locator('.tk-logo-d')).toBeVisible(); // a live ticket is dark: white lettering
    await expect(card.locator('.tk-logo-l')).toBeHidden();
    const m = await card.evaluate((c) => {
      const box = c.getBoundingClientRect(), l = c.querySelector('.tk-logo-d')!.getBoundingClientRect();
      const q = c.querySelector('.ticket-qr-wrap, .cu-qr-box')?.getBoundingClientRect();
      return { top: l.top - box.top, start: document.dir === 'rtl' ? box.right - l.right : l.left - box.left, h: l.height, clear: !q || l.bottom <= q.top || l.right <= q.left || l.left >= q.right };
    });
    expect(m.top).toBeLessThan(20);
    expect(m.start).toBeLessThan(20);
    expect(Math.round(m.h)).toBe(44);
    expect(m.clear).toBe(true);
  });
}
