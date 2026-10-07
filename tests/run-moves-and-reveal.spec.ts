import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Two of the owner's decisions of 2026-10-07.
// - Asked "Moving a Saturday ride to another date keeps its old announce time, so if moved later the breakfast spot
//   shows at once - should the announce time move with the date?": "yes". A date move shifts sessions.reveal_at by the
//   same number of days at the same Riyadh time (as each ride of a repeat is told), the editor's box follows the Date,
//   a time typed in the edit is written as typed, Undo puts the old time back, and a ride with none keeps none.
// - Asked "Moving riders onto Run for Her: moving a party there from the group editor doesn't ask for a distance;
//   moving a booking there from the booking editor doesn't check age 18+ - should both ask?": "yes it should". The
//   group editor asks the distance (written on every member moved) and refuses a member whose account is under 18 on
//   race day; the booking editor refuses an account under 18, as Add rider does.

type W = { method: string; url: string; body: Record<string, unknown> };
function writesTo(page: Page, table: string) {
  const w: W[] = [];
  page.on('request', (r) => {
    if (['POST', 'PATCH'].includes(r.method()) && new RegExp(`/rest/v1/${table}(\\?|$)`).test(r.url())) {
      let body: Record<string, unknown> = {};
      try { const b = r.postDataJSON(); body = (Array.isArray(b) ? b[0] : b) || {}; } catch { /* not JSON */ }
      w.push({ method: r.method(), url: decodeURIComponent(r.url()), body });
    }
  });
  return w;
}
async function boot(page: Page, fixtures: Record<string, unknown>) {
  await stubSupabase(page, { bikes: [], queue_entries: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('allSessions().length>0');
}
// Every toast the page says (an error bar is gone again after 2.8 s, which a loaded machine can miss).
async function recordToasts(page: Page) {
  await page.evaluate(`(()=>{window.__said=[];const real=window.toast;window.toast=function(m){window.__said.push(String(m));return real.apply(this,arguments);};})()`);
}
const said = (page: Page) => page.evaluate('window.__said') as Promise<string[]>;
const revealPatch = (w: W[]) => w.find((x) => x.method === 'PATCH' && 'reveal_at' in x.body) || null;

const SAT = '2099-10-24'; // a Saturday
const FRI_8PM = '2099-10-23T17:00:00.000Z'; // Friday 23 October, 8 PM in Riyadh: the evening before the ride
const sat = (extra: Record<string, unknown> = {}) => ({
  id: SAT, session_date: SAT, day: 'Saturday', status: 'open', capacity: 20, spots: 20, created_at: '2099-01-01T00:00:00Z',
  event_kind: 'community', ride_kind: 'saturday', paid_ride: false, needs_approval: true, hide_queue: true,
  bike_slots: '{"_time":"06:00 - 06:30"}', meet_url: 'https://maps.app.goo.gl/meetHere123', breakfast_name: 'Harbour Cafe', ...extra,
});

test.describe('@staff:sessions a ride moved to another date takes its announce time along', () => {
  test('the box follows the Date, the move writes the time as many days on, and Undo puts the old one back', async ({ page }) => {
    await boot(page, { sessions: [sat({ reveal_at: FRI_8PM })] });
    const sw = writesTo(page, 'sessions');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    await expect(page.locator('#es-reveal')).toHaveValue('2099-10-23T20:00');
    await page.locator('#es-date').fill('2099-10-31');
    await expect(page.locator('#es-reveal')).toHaveValue('2099-10-30T20:00'); // a week on, the same Riyadh time
    await expect(page.locator('#es-reveal-note')).toContainText('Breakfast spot hidden until');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => revealPatch(sw))
      .toMatchObject({ url: expect.stringContaining('id=eq.2099-10-31'), body: { reveal_at: '2099-10-30T17:00:00.000Z' } });
    await page.waitForFunction('S.editSessionId===null&&S.undoStack.length>0');
    await page.evaluate('doUndo()');
    // the ride goes back onto its own date with its own time
    await expect.poll(() => sw.find((x) => x.method === 'POST' && x.body.id === SAT) || null)
      .toMatchObject({ body: { id: SAT, session_date: SAT, reveal_at: FRI_8PM } });
  });

  test('a move set without the box moves the time too, back as well as on; a time typed in the edit is written as typed', async ({ page }) => {
    await boot(page, { sessions: [sat({ reveal_at: FRI_8PM })] });
    const sw = writesTo(page, 'sessions');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}');S.editSessDate='2099-10-17';saveSessionEdit()`);
    await expect.poll(() => revealPatch(sw))
      .toMatchObject({ url: expect.stringContaining('id=eq.2099-10-17'), body: { reveal_at: '2099-10-16T17:00:00.000Z' } });
    await page.waitForFunction('S.editSessionId===null');
    sw.length = 0;
    await page.evaluate(`startEditSession('${SAT}')`);
    await page.locator('#es-reveal').fill('2099-10-29T18:00');
    await page.locator('#es-date').fill('2099-10-31');
    await expect(page.locator('#es-reveal')).toHaveValue('2099-10-29T18:00'); // the staffer's own time stays put
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => revealPatch(sw)).toMatchObject({ body: { reveal_at: '2099-10-29T15:00:00.000Z' } });
  });

  test('a ride with no announce time keeps none when it moves', async ({ page }) => {
    await boot(page, { sessions: [sat({ reveal_at: null })] });
    const sw = writesTo(page, 'sessions');
    await page.evaluate(`setStaffTab('sessions');startEditSession('${SAT}')`);
    await expect(page.locator('#es-reveal')).toHaveValue('');
    await page.locator('#es-date').fill('2099-10-31');
    await expect(page.locator('#es-reveal')).toHaveValue('');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => sw.find((x) => x.method === 'POST') || null).toMatchObject({ body: { id: '2099-10-31', reveal_at: null } });
    await page.waitForFunction('S.editSessionId===null');
    expect(revealPatch(sw)).toBeNull();
  });
});

const JCC = '2099-03-01', RACE = '2099-03-07', RUN = '2099-03-07-rh';
const jcc = { id: JCC, session_date: JCC, day: 'Sunday', status: 'open', capacity: 12, created_at: 1, location: 'JCC',
  bike_slots: JSON.stringify({ _time: '21:00 - 23:00', _total: 12 }) };
const run = { id: RUN, session_date: RACE, day: 'Saturday', status: 'open', capacity: 80, created_at: 1,
  event_kind: 'community', ride_kind: 'runher', needs_approval: false, hide_queue: true, spots: 80, open_to_all: false,
  paid_ride: false, location: 'JYC', bike_slots: '{"_time":"06:00 - 06:30"}' };
const adult = { id: 'c1', name: 'Omar Saleh', email: 'omar@example.com', phone: '+966500000011', birth_date: '1990-04-04', created_at: '2099-01-01T00:00:00Z' };
const minor = { id: 'c2', name: 'Lina Haddad', email: 'lina@example.com', phone: '+966500000012', birth_date: '2083-06-01', created_at: '2099-01-01T00:00:00Z' }; // 15 on race day
const bk = (id: string, n: number, x: Record<string, unknown> = {}) => ({
  id, session_id: JCC, session_day: 'Sunday', session_date: JCC, queue_num: n, name: 'Rider ' + id, phone: '0550000000',
  type_preference: 'Hybrid', size: 'M', height: 170, status: 'waiting', paid: false, price: 57.5, registered_at: '2099-02-01T10:00:00Z', ...x,
});
const party = (cid: string) => [bk('e1', 1, { customer_id: cid, group_id: 'g1', group_name: 'Falcons' }), bk('e2', 2, { customer_id: null, group_id: 'g1', group_name: 'Falcons' })];
const patchesOf = (w: W[], id: string) => w.filter((x) => x.method === 'PATCH' && x.url.includes(`id=eq.${id}`)).map((x) => x.body);

test.describe('@staff:bookings moving riders onto Run for Her asks what adding them asks', () => {
  test('a party moved onto the run is asked one distance, every member carries it, and Undo takes it back', async ({ page }) => {
    await boot(page, { sessions: [jcc, run], queue_entries: party('c1'), customers: [adult] });
    await recordToasts(page);
    const qw = writesTo(page, 'queue_entries');
    await page.evaluate(`showGroupEditModal('e1')`);
    const modal = page.locator('#group-edit-modal');
    await expect(modal.locator('#ge-sess')).toBeVisible();
    await expect(modal.locator('.run-km-field')).toHaveCount(0); // a circuit night asks no distance
    // the focus manager moves focus into a new popup 40 ms after it appears: let it land before typing
    await page.waitForFunction(`(()=>{const m=document.getElementById('group-edit-modal');return !!m&&m.contains(document.activeElement);})()`);
    await modal.locator('#ge-r-name-1').fill('Nora Saleh');
    await modal.locator('#ge-sess').selectOption(RUN);
    await expect(modal.locator('.run-km-field')).toBeVisible();
    await expect(modal.locator('#ge-r-name-1')).toHaveValue('Nora Saleh'); // what was typed stays
    await modal.getByRole('button', { name: 'Save Changes' }).click();
    await expect(modal.locator('.run-km-field .field-err')).toBeVisible();
    await expect.poll(() => said(page)).toContain('Pick 3 km or 5 km.');
    expect(qw).toHaveLength(0);
    await modal.locator('.run-km-field [data-km="3"]').click();
    await expect(modal.locator('.run-km-field [data-km="3"]')).toHaveAttribute('aria-pressed', 'true');
    await modal.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => qw.filter((x) => x.method === 'PATCH').length).toBe(2);
    for (const id of ['e1', 'e2']) expect(patchesOf(qw, id)[0]).toMatchObject({ session_id: RUN, run_km: 3, type_preference: 'None' });
    expect(patchesOf(qw, 'e2')[0]).toMatchObject({ name: 'Nora Saleh' });
    await page.waitForFunction('S.undoStack.length>0');
    await page.evaluate('doUndo()');
    await expect.poll(() => qw.filter((x) => x.method === 'PATCH').length).toBe(4);
    for (const id of ['e1', 'e2']) expect(patchesOf(qw, id)[1]).toMatchObject({ session_id: JCC, run_km: null });
  });

  test('a member whose account is under 18 on race day keeps the party off the run', async ({ page }) => {
    await boot(page, { sessions: [jcc, run], queue_entries: party('c2'), customers: [minor] });
    await recordToasts(page);
    const qw = writesTo(page, 'queue_entries');
    await page.evaluate(`showGroupEditModal('e1')`);
    const modal = page.locator('#group-edit-modal');
    await modal.locator('#ge-sess').selectOption(RUN);
    await modal.locator('.run-km-field [data-km="5"]').click();
    await modal.getByRole('button', { name: 'Save Changes' }).click();
    await expect.poll(() => said(page)).toContain('For runners 18 and over: Lina Haddad');
    await expect(modal.locator('#ge-sess')).toBeVisible(); // the dialog stays open on the refusal
    expect(qw).toHaveLength(0);
  });

  test('a booking moved onto the run from the booking editor is refused for an account under 18, and an adult moves', async ({ page }) => {
    await boot(page, { sessions: [jcc, run], customers: [minor, adult],
      queue_entries: [bk('b1', 1, { customer_id: 'c2', name: 'Lina Haddad' }), bk('b2', 2, { customer_id: 'c1', name: 'Omar Saleh' })] });
    await recordToasts(page);
    const qw = writesTo(page, 'queue_entries');
    const modal = page.locator('#booking-edit-modal [role="dialog"]');
    for (const id of ['b1', 'b2']) {
      await page.evaluate(`showBookingEditModal('${id}')`);
      await modal.locator('#be-sess').selectOption(RUN);
      await modal.locator('.run-km-field [data-km="5"]').click();
      await modal.getByRole('button', { name: 'Save Changes' }).click();
      if (id === 'b1') {
        await expect.poll(() => said(page)).toContain('For runners 18 and over: Lina Haddad');
        await expect(modal).toBeVisible();
        expect(qw).toHaveLength(0);
        await page.evaluate('closeBookingEditModal()');
      }
    }
    await expect.poll(() => patchesOf(qw, 'b2')[0] || null).toMatchObject({ session_id: RUN, run_km: 5 });
    expect(patchesOf(qw, 'b1')).toHaveLength(0);
  });
});
