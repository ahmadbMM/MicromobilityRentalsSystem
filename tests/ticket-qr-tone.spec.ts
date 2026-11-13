import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The owner, 2026-11-12: "change the qr code of the booking card to orange when its checked in but not paid
// and green when its paid". The code's own ink says where the money stands: green once paid, orange once a
// rider is checked in with money owed, the usual dark ink otherwise. Every ink still reads back as the code.
test.describe('@customer:ticket the code\'s colour says paid or owed', () => {
  const FUT = '2099-02-01';
  const sess = { id: 's-' + FUT, day: 'Sunday', session_date: FUT, capacity: 12, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":12}' };
  const base = { id: 'q1abcd', name: 'Spec Rider', customer_id: 'c1', session_id: 's-' + FUT, session_day: 'Sunday', session_date: FUT, queue_num: 3, price: 75, waiver_version: '2026-11-v4' };

  async function ticket(page: Page, row: Record<string, unknown>) {
    await stubSupabase(page, { sessions: [sess], 'rpc:list_sessions': [sess], queue_entries: [row], 'rpc:my_bookings': [row] });
    await loginCustomer(page, { id: 'c1' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`goCustomer('myrides')`);
    const box = page.locator('#tab-myrides .cu-qr-box').first();
    await expect(box).toHaveClass(/\bcv\b/);
    await box.scrollIntoViewIfNeeded();
    return box;
  }
  // The top-left finder's centre pixel on the painted canvas, and the code read back by jsQR as shown.
  async function look(page: Page, box: ReturnType<Page['locator']>) {
    const n = await page.evaluate(`QR.encode(document.querySelector('#tab-myrides .cu-qr-box').getAttribute('data-qr')).size`) as number;
    const cv = box.locator('canvas.qr-cv');
    const finder = await cv.evaluate((el: HTMLCanvasElement, n: number) => {
      const g = el.getContext('2d')!, w = el.getBoundingClientRect().width, k = el.width / w;
      const at = Math.round((6 + (4 + 3.5) * ((w - 12) / (n + 8))) * k);
      return Array.from(g.getImageData(at, at, 1, 1).data.slice(0, 3));
    }, n);
    await page.addScriptTag({ url: '/vendor/jsqr-1.4.0.min.js' });
    const read = await cv.evaluate((el: HTMLCanvasElement) => {
      const g = el.getContext('2d')!, d = g.getImageData(0, 0, el.width, el.height);
      const r = (window as unknown as { jsQR: (a: Uint8ClampedArray, w: number, h: number, o: unknown) => { data: string } | null })
        .jsQR(d.data, el.width, el.height, { inversionAttempts: 'dontInvert' });
      return r && r.data;
    });
    return { finder, read };
  }
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  test('booked, not paid: the usual dark ink', async ({ page }) => {
    const box = await ticket(page, { ...base, status: 'waiting', paid: false });
    await expect(box).not.toHaveAttribute('data-tone', /./);
    const { finder, read } = await look(page, box);
    expect(Math.max(...finder)).toBeLessThan(60);
    expect(read).toBe('MMC-3-q1abcd');
  });

  test('checked in, not paid: orange, and it still scans', async ({ page }) => {
    const box = await ticket(page, { ...base, status: 'active', paid: false });
    await expect(box).toHaveAttribute('data-tone', 'due');
    const { finder, read } = await look(page, box);
    expect(finder).toEqual(hex('#c2410c'));
    expect(read).toBe('MMC-3-q1abcd');
  });

  test('paid: green, checked in or not, and it still scans', async ({ page }) => {
    const box = await ticket(page, { ...base, status: 'active', paid: true });
    await expect(box).toHaveAttribute('data-tone', 'paid');
    const { finder, read } = await look(page, box);
    expect(finder).toEqual(hex('#077a4b'));
    expect(read).toBe('MMC-3-q1abcd');
    expect(await page.evaluate(`_qrTone(null,[{status:'waiting',paid:true,price:75}])`)).toBe('paid');
  });

  test('the rules: a party, a waitlist seat, a free ride, an on-the-house place', async ({ page }) => {
    await ticket(page, { ...base, status: 'waiting', paid: false });
    const tone = (rows: unknown[], s = 'null') => page.evaluate(`_qrTone(${s},${JSON.stringify(rows)})`);
    // one rider checked in and owing makes the party's code orange; one paid and one still to come stays dark
    expect(await tone([{ status: 'active', paid: false, price: 75 }, { status: 'waiting', paid: true, price: 75 }])).toBe('due');
    expect(await tone([{ status: 'active', paid: true, price: 75 }, { status: 'waiting', paid: false, price: 75 }])).toBe('');
    // a seat still on the waitlist owes nothing yet
    expect(await tone([{ status: 'active', paid: true, price: 75 }, { status: 'waitlist', paid: false, price: 75 }])).toBe('paid');
    // checked in on a ride that charges nothing: nothing owed, so never orange
    expect(await tone([{ status: 'active', paid: false, price: 0 }])).toBe('');
    expect(await tone([{ status: 'active', paid: false, price: 75 }], `{id:'x',event_kind:'community',ride_kind:'blood'}`)).toBe('');
    // a free Saturday ride: nothing owed; a paid one owes its fare
    expect(await tone([{ status: 'active', paid: false, price: 75 }], `{id:'x',event_kind:'community'}`)).toBe('');
    expect(await tone([{ status: 'active', paid: false, price: 75 }], `{id:'x',event_kind:'community',paid_ride:true}`)).toBe('due');
    // on the house is marked paid at 0
    expect(await tone([{ status: 'active', paid: true, price: 0 }])).toBe('paid');
    // the lazy placeholder (library not loaded yet) keeps the tone for when it is drawn
    expect(await page.evaluate(`(()=>{const q=window.qrcode;window.qrcode=undefined;try{return ticketQR('MMC-1',132,'due');}finally{window.qrcode=q;}})()`)).toContain('data-tone="due"');
  });
});
