import { test, expect, type Page, type Request } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';

// Each bike type capped on its own (the owner, 2026-11-11: "do it all"; staff round s10, second batch, "caps"; migration
// 20261111180600, _type_full_guard). A ride that counts a type's places in bike_slots holds that type to them: the rider's
// picker shows a full type as Full and it cannot be picked; with every type full the ride is its waitlist; a race the
// server refuses (TYPE_FULL) is said on the review. A staff add of a full type asks "Road is full (2 of 2). Add anyway?",
// Add anyway sends the request header the database lets staff past with and the Log keeps a line, Pick another type sends
// nothing. A ride that counts no type is unchanged. All Supabase traffic is stubbed; invented riders only.

const DAY = '2099-05-05';
const NOW = new Date(`${DAY}T18:00:00+03:00`);
const night = (id: string, slots: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, day: 'Tuesday', session_date: DAY, capacity: 20, spots: 20, status: 'open', created_at: 1,
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', ...slots }), ...extra,
});
const CAPPED = 'n-cap', ALLFULL = 'n-all', PLAIN = 'n-plain';
const sessions = [
  night(CAPPED, { Road: 2, Hybrid: 3 }),
  night(ALLFULL, { Road: 1, Hybrid: 1, Mountain: 1, Kids: 1, 'Road Carbon': 1 }),
  night(PLAIN, { _total: 20 }),
];
const booking = (id: string, sid: string, ty: string, status = 'waiting', qn = 1) => ({
  id, session_id: sid, session_day: 'Tuesday', session_date: DAY, queue_num: qn, name: `Rider ${id}`, phone: '', customer_id: null,
  status, paid: false, price: 75, walk_in: true, registered_at: `${DAY}T10:00:00Z`, height: 175, size: 'M', type_preference: ty,
});
const held = [
  booking('r1', CAPPED, 'Road', 'waiting', 1), booking('r2', CAPPED, 'Road', 'waitlist', 2), // the waitlist counts, as the server counts it
  booking('h1', CAPPED, 'Hybrid', 'waiting', 3), booking('x1', CAPPED, 'Road', 'cancelled', 4), // a cancelled one does not
  ...['Road', 'Hybrid', 'Mountain', 'Kids', 'Road Carbon'].map((ty, i) => booking(`a${i}`, ALLFULL, ty, 'waiting', i + 1)),
  ...[1, 2, 3, 4, 5].map((i) => booking(`p${i}`, PLAIN, 'Road', 'waiting', i)),
];
const pill = (page: Page, ty: string, slot = 0) => page.locator(`#tab-register [data-type-slot="${slot}"][data-type="${ty}"]`);
const atRiders = (sid: string, qty = 1) => `S.lastTickets=[];S.selEvent='jcc';S.selSession='${sid}';S.regQty=${qty};S.regStep=2;setCustTab('register')`;

async function rider(page: Page, fx: Fixtures = {}) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, 'rpc:list_sessions': sessions, queue_entries: held, bikes: [], ...fx }); // open mode (the stub's): a rider reads queue_entries, as queue_public in secure mode
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider', height: 175 });
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@customer:reserve a bike type whose places are all taken', () => {
  test('shows Full and cannot be picked; the other types stay bookable', async ({ page }) => {
    await rider(page);
    await page.evaluate(atRiders(CAPPED));
    await expect(pill(page, 'Road')).toBeDisabled();
    await expect(pill(page, 'Road')).toContainText('Full');
    await expect(pill(page, 'Road')).not.toContainText('75');
    await expect(pill(page, 'Hybrid')).toBeEnabled();         // 1 of 3 taken
    await expect(pill(page, 'Mountain')).toBeEnabled();       // not counted on this ride
    await page.evaluate(`setBikeType(0,'Road')`);
    expect(await page.evaluate('S.regBikeTypes[0]||null')).toBe(null);
    await page.evaluate(`setBikeType(0,'Hybrid')`);
    expect(await page.evaluate('S.regBikeTypes[0]')).toBe('Hybrid');
    expect(await page.evaluate(`_regWlNow(_sessDisp('${CAPPED}'),1)`)).toBe(false); // the ride still has places: no waitlist
  });

  test('a rider of the same booking who takes the last place makes it Full for the next', async ({ page }) => {
    await rider(page);
    await page.evaluate(atRiders(CAPPED, 2));
    await expect(pill(page, 'Hybrid', 0)).toBeEnabled();
    await page.evaluate(`setBikeType(0,'Hybrid');setBikeType(1,'Hybrid')`);   // 1 + 2 of 3
    await expect(pill(page, 'Hybrid', 1)).toBeEnabled();
    expect(await page.evaluate('S.regBikeTypes.slice(0,2)')).toEqual(['Hybrid', 'Hybrid']);
    await page.evaluate(`S.regQty=3;renderRegister()`);
    await expect(pill(page, 'Hybrid', 2)).toBeDisabled();
    await expect(pill(page, 'Hybrid', 2)).toContainText('Full');
  });

  test('with every type full the ride is its waitlist: the types are preferences again and Confirm says Join waitlist', async ({ page }) => {
    await rider(page);
    await page.evaluate(atRiders(ALLFULL));
    await expect(pill(page, 'Road')).toBeEnabled();
    await expect(pill(page, 'Road')).not.toContainText('Full');
    expect(await page.evaluate(`_regWlNow(_sessDisp('${ALLFULL}'),1)`)).toBe(true);
    await page.evaluate(`S.regBikeHeights=['175'];S.regBikeTypes=['Road'];S.regRiderNames=['Spec Rider'];S.regStep=3;renderRegister()`);
    await expect(page.locator('#tab-register .mm-reg-foot .btn-primary')).toHaveText('Join waitlist');
  });

  test('a ride that counts no type is unchanged', async ({ page }) => {
    await rider(page);
    await page.evaluate(atRiders(PLAIN));
    await expect(pill(page, 'Road')).toBeEnabled();
    await expect(pill(page, 'Road')).not.toContainText('Full');
    expect(await page.evaluate(`_capLeft(_sessDisp('${PLAIN}'),'Road')`)).toBe(null);
  });

  test('the server refusing a type another rider just filled is said on the review step, in words', async ({ page }) => {
    await rider(page, { 'rpc:customer_create_booking': { __rpcError: { status: 400, code: 'P0001', message: 'TYPE_FULL', details: 'Hybrid', hint: '3/3' } } });
    await page.evaluate(`S.selEvent='jcc';goCustomer('register');S.selSession='${CAPPED}';S.regQty=1;S.regBikeHeights=['175'];S.regBikeTypes=['Hybrid'];S.regRiderNames=['Spec Rider'];S.waiverOk=true;S.regStep=3;renderRegister()`);
    await page.evaluate('submitReg()');
    const msg = page.locator('#tab-register .cu-cap-err');
    await expect(msg).toHaveText('That bike type is full on this ride. Please choose another.');
    await expect(msg).toHaveAttribute('role', 'alert');
    await expect(page.locator('#toast-container')).not.toContainText('TYPE_FULL');
    expect(await page.evaluate('S.regStep')).toBe(3);
    await page.evaluate(`setBikeType(0,'Mountain');renderRegister()`);    // another type picked: the message goes
    await expect(msg).toHaveCount(0);
  });
});

// ── Staff ──────────────────────────────────────────────────────────────────────────────────────────
async function desk(page: Page) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, queue_entries: held.slice(), bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');setSfSession('${CAPPED}')`);
}
function inserts(page: Page) {
  const sent: { body: unknown; cap: string | undefined }[] = [];
  page.on('request', (r: Request) => {
    if (r.method() === 'POST' && /\/rest\/v1\/queue_entries/.test(r.url())) sent.push({ body: r.postDataJSON(), cap: r.headers()['x-mm-type-cap'] });
  });
  return sent;
}
function logLines(page: Page) {
  const sent: Record<string, unknown>[] = [];
  page.on('request', (r: Request) => {
    if (r.method() === 'POST' && /\/rest\/v1\/staff_actions/.test(r.url())) sent.push(r.postDataJSON() as Record<string, unknown>);
  });
  return sent;
}
async function walkIn(page: Page, sid: string, ty: string) {
  await page.evaluate('showWalkinModal()');
  await page.locator('#wi-name').fill('Walk Up');
  await page.locator('#wi-sess').selectOption(sid);
  await page.locator(`#walkin-modal [data-wi-type="${ty}"]`).click();
  await page.locator('#walkin-modal .modal-footer .btn-secondary', { hasText: 'Add Walk-in' }).click();
}

test.describe('@staff:walk-in a bike type whose places are all taken', () => {
  test('asks "Road is full (2 of 2). Add anyway?"; Add anyway sends the override and the Log keeps a line', async ({ page }) => {
    await desk(page);
    const sent = inserts(page), log = logLines(page);
    await walkIn(page, CAPPED, 'Road');
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box).toContainText('Road is full (2 of 2). Add anyway?');
    await expect(box.getByRole('button', { name: 'Pick another type' })).toBeVisible();
    expect(sent.length).toBe(0);                                              // nothing sent before the answer
    await box.getByRole('button', { name: 'Add anyway' }).click();
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].cap).toBe('ok');
    expect((sent[0].body as Record<string, unknown>[])[0].type_preference).toBe('Road');
    await expect.poll(() => log.some((l) => /Added over the Road limit: Walk Up/.test(String(l.action)) && l.kind === 'typecap')).toBe(true);
  });

  test('Pick another type sends nothing and keeps the form', async ({ page }) => {
    await desk(page);
    const sent = inserts(page);
    await walkIn(page, CAPPED, 'Road');
    await page.locator('#confirm-modal').getByRole('button', { name: 'Pick another type' }).click();
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
    await expect(page.locator('#walkin-modal #wi-name')).toHaveValue('Walk Up');
    await expect(page.locator('#err-bar-el')).not.toBeVisible();
    expect(sent.length).toBe(0);
  });

  test('a refusal the desk did not see coming asks the same, and Add anyway sends it again with the override', async ({ page }) => {
    await desk(page);
    const sent = inserts(page);
    let first = true;
    await page.route(/\/rest\/v1\/queue_entries/, async (r) => {
      if (r.request().method() !== 'POST') return r.fallback();
      if (first) {
        first = false;
        return r.fulfill({ status: 400, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
          body: JSON.stringify({ code: 'P0001', message: 'TYPE_FULL', details: 'Hybrid', hint: '3/3' }) });
      }
      return r.fallback();
    });
    await walkIn(page, CAPPED, 'Hybrid');                                    // this desk counts 1 of 3 Hybrid taken
    const box = page.locator('#confirm-modal .confirm-box');
    await expect(box).toContainText('Hybrid is full (3 of 3). Add anyway?');
    await box.getByRole('button', { name: 'Add anyway' }).click();
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[0].cap).toBeUndefined();
    expect(sent[1].cap).toBe('ok');
  });

  test('a ride that counts no type adds with no question and no override', async ({ page }) => {
    await desk(page);
    const sent = inserts(page);
    await walkIn(page, PLAIN, 'Road');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].cap).toBeUndefined();
    await expect(page.locator('#confirm-modal .confirm-box')).toHaveCount(0);
  });

  test('the kiosk leaves a full type out', async ({ page }) => {
    await desk(page);
    expect(await page.evaluate(`_koTypes(_sessGet('${CAPPED}'))`)).not.toContain('Road');
    expect(await page.evaluate(`_koTypes(_sessGet('${CAPPED}'))`)).toContain('Hybrid');
    expect(await page.evaluate(`_koTypes(_sessGet('${PLAIN}'))`)).toContain('Road');
  });
});
