import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-07 (desk core: close-out, the Log's Undo, the price editor).
const OLD = '2020-01-01';
const FREE = '2020-01-04-c';
const sessions = [
  { id: OLD, session_date: OLD, day: 'Wednesday', status: 'closed', capacity: 10, created_at: 1 },
  // the Saturday social ride: members only, free, no approval needed for this spec
  { id: FREE, session_date: '2020-01-04', day: 'Saturday', status: 'closed', capacity: 40, created_at: 2,
    event_kind: 'community', ride_kind: 'saturday', needs_approval: false, paid_ride: false },
];
const e = (id: string, sid: string, st: string, x: Record<string, unknown> = {}) => ({
  id, session_id: sid, session_day: 'Sunday', session_date: sid.slice(0, 10), queue_num: 1, name: 'Rider ' + id,
  phone: '0550000001', type_preference: 'Road', size: 'M', status: st, paid: false, price: 75,
  registered_at: '2020-01-01T10:00:00Z', ...x });

async function boot(page: Page, queue_entries: Record<string, unknown>[], fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries, bikes: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
}

test.describe('@staff:bookings bug hunt oct 7 (s09)', () => {
  test('close-out on a free ride says nobody owes; a paid ride still names what is owed', async ({ page }) => {
    await boot(page, [
      e('f1', FREE, 'active', { price: 0, checked_in_at: '2020-01-04T05:00:00Z' }),
      e('f2', FREE, 'waiting', { price: 0, queue_num: 2, checked_in_at: '2020-01-04T05:01:00Z' }),
      e('p1', OLD, 'active', { checked_in_at: '2020-01-01T21:00:00Z' }),
    ]);
    await page.evaluate(`closeOutSession('${FREE}')`);
    await expect(page.locator('#confirm-modal .confirm-box')).toBeVisible();
    await expect(page.locator('#confirm-modal .confirm-box')).not.toContainText(/still owe/i);
    await page.evaluate('closeConfirm()');
    await page.evaluate(`closeOutSession('${OLD}')`);
    await expect(page.locator('#confirm-modal .confirm-box')).toContainText(/1 of them still owe/i);
  });

  test('a refused Log undo stays on the topbar Undo, in its place', async ({ page }) => {
    await boot(page, [e('q1', OLD, 'done')]);
    await page.evaluate(`pushUndo('First action',async()=>false);pushUndo('Second action',async()=>{})`);
    await page.evaluate(`confirmDialog=(o)=>o.onConfirm&&o.onConfirm();confirmLogUndo(S.actionLog.find(a=>a.label==='First action').id)`);
    await expect(page.locator('#toast-container .toast', { hasText: /undo/i }).first()).toBeAttached();
    await expect.poll(() => page.evaluate(`S.undoStack.map(u=>u.label).join('|')`)).toBe('First action|Second action');
    expect(await page.evaluate(`S.actionLog.find(a=>a.label==='First action').undone`)).toBe(false);
    // the topbar was repainted: its Undo names the action a tap on it reverses
    await expect(page.locator('#topbar-right .undo-btn')).toHaveAttribute('title', 'Second action');
  });

  test('a reschedule sends only the riders the database holds; an outbox rider is retargeted locally', async ({ page }) => {
    const D1 = '2099-02-08', D2 = '2099-02-15';
    const ss = [D1, D2].map((d, i) => ({ id: 's' + i, day: 'Sunday', session_date: d, capacity: 9, status: 'open', created_at: 1,
      bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 9 }), location: 'JCC' }));
    const live = { id: 'e1', customer_id: 'c1', session_id: 's0', session_day: 'Sunday', session_date: D1, queue_num: 3,
      name: 'Spec Rider', type_preference: 'Hybrid', size: 'M', status: 'waiting', paid: false, price: 57.5,
      registered_at: '2099-01-01T10:00:00Z' };
    await stubSupabase(page, { sessions: ss, bikes: [], customers: [{ id: 'c1', name: 'Spec Rider' }], queue_entries: [live],
      'rpc:customer_booking_update': true });
    await loginCustomer(page, { id: 'c1', name: 'Spec Rider', session_token: 'tok' });
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.dataLoaded===true&&getQueue().some(e=>e.id==='e1')`);
    // a second rider of the booking, added offline: still in the outbox, on this device only
    await page.evaluate(`(()=>{const q=getQueue().find(e=>e.id==='e1');
      localStorage.setItem('cq_book_outbox',JSON.stringify([{id:'e2',customer_id:'c1',session_id:'s0',session_day:'Sunday',session_date:'${D1}',queue_num:4,name:'Spec Friend',type_preference:'Hybrid',status:'waiting',paid:false,price:57.5,registered_at:new Date().toISOString()}]));
      S.queue=getQueue().concat([{...q,id:'e2',name:'Spec Friend',queueNum:4}]);})()`);
    const sent: string[] = [];
    page.on('request', (r) => { if (/rpc\/customer_booking_update/.test(r.url())) sent.push(String(r.postDataJSON().p_entry_id)); });
    await page.evaluate(`rescheduleBooking('s0','s1')`);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent).toEqual(['e1']);
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
  });

  test('a typed price is saved in halalas, without float noise', async ({ page }) => {
    await boot(page, [e('q1', '2099-09-09', 'waiting', { session_date: '2099-09-09' })], {
      sessions: [...sessions, { id: '2099-09-09', session_date: '2099-09-09', day: 'Wednesday', status: 'open', capacity: 10, created_at: 3 }],
      'rpc:staff_set_price': { ok: true, id: 'q1', price: 100.1 },
    });
    const bodies: Record<string, unknown>[] = [];
    page.on('request', (r) => { if (/\/rpc\/staff_set_price/.test(r.url())) bodies.push(r.postDataJSON()); });
    await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');S._opPins=[{name:'Spec Staff',has_pin:false}];S._opPinsAt=Date.now();saveEditedPrice('q1',110.2-10.1)`);
    await expect.poll(() => bodies.length).toBe(1);
    expect(bodies[0].p_price).toBe(100.1);
  });
});
