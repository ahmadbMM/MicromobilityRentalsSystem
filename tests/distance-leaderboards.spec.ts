import { test, expect, type Page, type Route } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, type Fixtures } from './helpers/supabase';
import { hubPart } from './helpers/hub';

// The distance leaderboards (the user, 2026-11-27; migration 20261127180000, distance-board.js). Four boards (Longest ride,
// This month, Lifetime, This year), men and women apart, members only, a name only for a rider who switched it on; the
// signed-in rider's own place, the switch, Share (badge-share.js draws the picture) and Add a distance: one ride or a total
// over dates, with a picture or a PDF as proof, for staff to approve. Gold, Silver and Bronze (lr_gold / lr_silver /
// lr_bronze) move in the database. Staff: Analytics > Leaderboard > Distance leaderboards. All Supabase traffic is stubbed.


const EMOJI = /\p{Extended_Pictographic}/u;
const sat = (id: string) => ({ id, day: 'Saturday', session_date: id, capacity: 40, status: 'open', created_at: 1, event_kind: 'community', ride_kind: 'saturday', paid_ride: false, bike_slots: '{"_time":"06:00 - 06:30","_total":40}' });
const feed = { ok: true, today: '2026-11-27', me: null, club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
const board = (o: Record<string, unknown> = {}) => ({
  ok: true, board: 'longest', gender: 'female',
  rows: [
    { r: 1, km: 120, name: 'Lina O.', medal: 1, mine: false },
    { r: 2, km: 90, name: null, medal: 2, mine: true },
    { r: 3, km: 40, name: null, medal: null, mine: false },
    { r: 3, km: 40, name: 'Nada K.', medal: null, mine: false },
  ],
  me: { r: 2, km: 90, public: false, member: true, gender: 'female' }, ...o,
});
const mine = (o: Record<string, unknown> = {}) => ({ ok: true, best: 90, at: '2026-11-01', lifetime: 410, year: 300, public: false, member: true, medal: 2,
  claims: [{ id: 7, kind: 'total', km: 3000, d: '2026-11-20', from: '2026-01-01', status: 'declined', source: 'claim', reply: 'Overlaps your rides', at: '2026-11-21T10:00:00Z' }], ...o });

type Call = { name: string; body: Record<string, unknown> };
// Every RPC of the boards answered here and kept, so a spec reads what the page sent.
async function boards(page: Page, answers: Record<string, unknown | ((b: Record<string, unknown>) => unknown)>, calls: Call[]) {
  await page.route(/\/rest\/v1\/rpc\/(distance_board|customer_distances|customer_distance_claim|customer_distance_withdraw|customer_board_public|staff_distance_board|staff_distance_answer|staff_distance_add|staff_distance_remove)$/, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fallback();
    const name = new URL(req.url()).pathname.split('/').pop() || '';
    let body: Record<string, unknown> = {};
    try { body = req.postDataJSON() || {}; } catch { /* none */ }
    calls.push({ name, body });
    const a = answers[name], out = typeof a === 'function' ? (a as (b: Record<string, unknown>) => unknown)(body) : a;
    return route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'content-type': 'application/json' }, body: JSON.stringify(out === undefined ? null : out) });
  });
}
const page$ = (page: Page) => page.locator('#dbd-page');

test.describe('riders', () => {
  test('/leaderboard opens the boards over the start page for anyone: names only where switched on, the medals, no counts', async ({ page }) => {
    const calls: Call[] = [];
    await stubSupabase(page, { sessions: [sat('2099-01-03')], customers: [], queue_entries: [], bikes: [] });
    await boards(page, { distance_board: (b: Record<string, unknown>) => board({ me: undefined, gender: b.p_gender, rows: board().rows.map((r) => ({ ...r, mine: false })) }) }, calls);
    await page.goto('/leaderboard');
    await waitForSb(page);
    const p = page$(page);
    await expect(p.getByRole('dialog', { name: 'Leaderboards' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/'); // the address goes back to the start page
    const rows = p.locator('.dbd-row');
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText('Lina O.');
    await expect(rows.nth(0)).toContainText('120 km · 74.6 mi');
    await expect(rows.nth(1)).toContainText('Member'); // no name without the switch
    await expect(rows.nth(0).locator('svg.bdg-race')).toHaveCount(1); // Gold
    await expect(rows.nth(2).locator('.dbd-r')).toHaveText('3');
    await expect(rows.nth(3).locator('.dbd-r')).toHaveText('3'); // equal distances share the place
    await expect(p.locator('.dbd-me')).toHaveCount(0); // signed out: no own card, no Add a distance
    const first = calls.find((c) => c.name === 'distance_board')!;
    expect(first.body).toMatchObject({ p_board: 'longest', p_id: null, p_token: null });
    // the other boards and the other gender ask again
    await p.getByRole('button', { name: 'Lifetime' }).click();
    await expect.poll(() => calls.filter((c) => c.name === 'distance_board').some((c) => c.body.p_board === 'lifetime')).toBe(true);
    await expect(p.locator('.dbd-sub')).toHaveText('Kilometres ridden');
    await p.getByRole('button', { name: 'Women', exact: true }).click();
    await expect.poll(() => calls.some((c) => c.name === 'distance_board' && c.body.p_board === 'lifetime' && c.body.p_gender === 'female')).toBe(true);
    expect(EMOJI.test(await p.innerText())).toBe(false);
    expect(await p.innerText()).not.toMatch(/\d+\s*(riders|members)/i);
    await p.getByRole('button', { name: 'Close' }).click();
    await expect(p).toHaveCount(0);
  });

  test('a member opens a board from the Community tab: their place, the name switch, Share and their distances', async ({ page }) => {
    const calls: Call[] = [];
    await stubSupabase(page, { sessions: [sat('2099-01-03')], customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed });
    await boards(page, { distance_board: () => board(), customer_distances: () => mine(), customer_board_public: (b: Record<string, unknown>) => ({ ok: true, public: b.p_on }) }, calls);
    await loginCustomer(page, { id: 'c1', name: 'Sara Ahmed', gender: 'female' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('members')`);
    await hubPart(page, 'board');
    await page.locator('#hub-pane-board').getByRole('button', { name: 'Longest ride' }).click();
    const p = page$(page);
    await expect(p.locator('.dbd-me-r')).toHaveText('#2');
    await expect(p.locator('.dbd-me-km')).toHaveText('90 km · 55.9 mi'); // in kilometres and miles (2026-11-28)
    await expect(p.locator('.dbd-row.mine')).toContainText('You');
    await expect(p.getByRole('button', { name: 'Women', exact: true })).toHaveAttribute('aria-pressed', 'true'); // the rider's own gender first
    expect(calls.find((c) => c.name === 'distance_board')!.body).toMatchObject({ p_board: 'longest', p_gender: 'female', p_id: 'c1', p_token: 'tok-spec' });
    // their distances: a declined total with the team's reply
    await expect(p.locator('.dbd-ci')).toContainText('3000 km · 1864.1 mi');
    await expect(p.locator('.dbd-ci')).toContainText('Declined');
    await expect(p.locator('.dbd-ci')).toContainText('Overlaps your rides');
    // Lifetime shows their own total
    await p.getByRole('button', { name: 'Lifetime' }).click();
    await expect(p.locator('.dbd-me-km')).toHaveText('90 km · 55.9 mi'); // ranked: the board's own figure for them
    await p.getByRole('button', { name: 'Longest ride' }).click();
    // the switch
    await p.getByRole('switch', { name: /Show my name/ }).check({ force: true }); // the switch's box is drawn over the hidden input
    await expect.poll(() => calls.find((c) => c.name === 'customer_board_public')?.body).toMatchObject({ p_id: 'c1', p_on: true });
    // Share: the picture of their place, with the leaderboard's address
    await page.evaluate(`navigator.canShare=(d)=>!!(d&&d.files&&d.files.length);navigator.share=(d)=>{window._shared=d;return Promise.resolve();}`);
    await p.getByRole('button', { name: 'Share' }).click();
    const img = page.locator('#badge-pop #shr-img');
    await expect(img).toBeVisible();
    const alt = await img.getAttribute('alt');
    expect(alt).toContain('Longest ride');
    expect(alt).toContain('90 km · 55.9 mi');
    expect(alt).toContain('#2 · Women');
    await page.locator('#badge-pop #shr-go').click();
    await expect.poll(() => page.evaluate('window._shared && window._shared.files && window._shared.files[0].name')).toBe('micromobility-longest.png');
  });

  test('Add a distance: one ride or a total, a proof required, the checks said, then sent for approval', async ({ page }) => {
    const calls: Call[] = [];
    await stubSupabase(page, { sessions: [sat('2099-01-03')], customers: [], queue_entries: [], bikes: [] });
    await boards(page, { distance_board: () => board(), customer_distances: () => mine({ claims: [] }), customer_distance_claim: () => ({ ok: true, id: 9 }) }, calls);
    await loginCustomer(page, { id: 'c1', name: 'Sara Ahmed', gender: 'female' });
    await page.goto('/leaderboard');
    await waitForSb(page);
    const p = page$(page);
    await p.getByRole('button', { name: 'Add a distance' }).click();
    const d = page.locator('#confirm-modal .dbd-c');
    await expect(d.getByRole('dialog', { name: 'Add a distance' }).or(d)).toBeVisible();
    await d.locator('#dbd-c-km').fill('301');
    await d.getByRole('button', { name: 'Send for approval' }).click();
    await expect(d.getByRole('alert')).toContainText('1 to 300 km');
    await d.locator('#dbd-c-km').fill('142,5');
    await d.getByRole('button', { name: 'Send for approval' }).click();
    await expect(d.getByRole('alert')).toContainText('picture or a PDF');
    expect(calls.some((c) => c.name === 'customer_distance_claim')).toBe(false);
    // a total over dates
    await d.getByRole('button', { name: 'A total over dates' }).click();
    await expect(d.locator('#dbd-c-from')).toBeVisible();
    await d.locator('#dbd-c-km').fill('2400');
    await d.locator('#dbd-c-from').fill('2026-01-01');
    await d.locator('#dbd-c-d').fill('2026-11-20');
    await d.locator('#dbd-c-file').setInputFiles({ name: 'strava-year.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 a year of rides') });
    await expect(d.locator('.bdr-fname')).toHaveText('strava-year.pdf');
    await d.locator('#dbd-c-note').fill('Strava year summary');
    await d.getByRole('button', { name: 'Send for approval' }).click();
    await expect(page.locator('#confirm-modal .dbd-c')).toHaveCount(0);
    const sent = calls.find((c) => c.name === 'customer_distance_claim')!.body;
    expect(sent).toMatchObject({ p_id: 'c1', p_token: 'tok-spec', p_kind: 'total', p_km: 2400, p_from: '2026-01-01', p_date: '2026-11-20', p_note: 'Strava year summary', p_proof_name: 'strava-year.pdf' });
    expect(String(sent.p_proof)).toMatch(/^data:application\/pdf;base64,JVBER/);
  });

  test('a signed-in rider who is not a member is told only members are ranked', async ({ page }) => {
    const calls: Call[] = [];
    await stubSupabase(page, { sessions: [sat('2099-01-03')], customers: [], queue_entries: [], bikes: [] });
    await boards(page, { distance_board: () => board({ me: { public: false, member: false, gender: 'male' }, rows: [] }), customer_distances: () => mine({ member: false, medal: null, claims: [] }) }, calls);
    await loginCustomer(page, { id: 'c1', name: 'Omar Saleh', gender: 'male' });
    await page.goto('/leaderboard');
    await waitForSb(page);
    const p = page$(page);
    await expect(p.locator('.dbd-note')).toHaveText('Only community members are ranked.');
    await expect(p.getByRole('button', { name: 'Share' })).toHaveCount(0); // no place to share
    await expect(p.getByRole('button', { name: 'Men', exact: true })).toHaveAttribute('aria-pressed', 'true');
  });

  test('the medals are drawn as the app draws a race medal', async ({ page }) => {
    await stubSupabase(page, { sessions: [], customers: [], queue_entries: [], bikes: [] });
    await page.goto('/');
    await waitForSb(page);
    const out = await page.evaluate(`[_bdgMedal('lr1','gold'),_bdgMedal('lr2','silver'),_bdgMedal('lr3','orange')].map(s=>s.includes('bdg-race')&&s.includes('>#'+'')).join(',')`);
    expect(out).toBe('true,true,true');
  });
});

test.describe('staff', () => {
  const customers = [{ id: 'c1', name: 'Sara Ahmed', phone: '0551112222', created_at: '2026-01-01' }, { id: 'c2', name: 'Lina Omar', phone: '0553334444', created_at: '2026-01-02' }];
  const rows = [
    { id: 11, customer_id: 'c2', kind: 'ride', km: 142.5, date_from: null, ride_date: '2026-11-22', source: 'claim', status: 'pending', note: 'Garmin ride', proof_kind: 'image', created_at: '2026-11-23T08:00:00Z', created_by: 'rider', decided_at: null, decided_by: null, reply: null },
    { id: 10, customer_id: 'c1', kind: 'ride', km: 90, date_from: null, ride_date: '2026-11-01', source: 'staff', status: 'approved', note: null, proof_kind: null, created_at: '2026-11-02T08:00:00Z', created_by: 'Desk One', decided_at: '2026-11-02T08:00:00Z', decided_by: 'Desk One', reply: null },
  ];
  async function staff(page: Page, calls: Call[], fx: Fixtures = {}) {
    await stubSupabase(page, { sessions: [], queue_entries: [], customers, ride_distances: rows, ...fx });
    await boards(page, {
      staff_distance_board: () => [{ r: 1, id: 'c1', name: 'Sara Ahmed', km: 90, d: '2026-11-01', src: 'entry', public: false, member: true }],
      staff_distance_answer: () => ({ ok: true }), staff_distance_add: () => ({ ok: true, id: 12 }), staff_distance_remove: () => ({ ok: true }),
    }, calls);
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`S.anView='leaderboard';setStaffTab('analytics')`);
  }

  test('Analytics > Leaderboard: the board with full names, a claim approved with the km staff read, one added for an account', async ({ page }) => {
    const calls: Call[] = [];
    await staff(page, calls);
    const h = page.locator('#an-dist-host');
    await expect(h.locator('.dbd-st-title')).toContainText('Distance leaderboards');
    await expect(h.locator('.dbd-st-t').first()).toContainText('Sara Ahmed');
    expect(calls.find((c) => c.name === 'staff_distance_board')!.body).toMatchObject({ p_board: 'longest', p_gender: 'female', p_members: true });
    // the claim waiting
    const c = h.locator('.dbd-st-c');
    await expect(c).toContainText('Lina Omar');
    await expect(c).toContainText('142.5 km · 88.5 mi');
    await expect(c).toContainText('Garmin ride');
    await c.locator('input[inputmode="decimal"]').fill('140');
    await c.getByRole('textbox', { name: /Reply/ }).fill('Counted to the last full km');
    await c.getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => calls.find((x) => x.name === 'staff_distance_answer')?.body).toEqual({ p_id: 11, p_ok: true, p_km: 140, p_reply: 'Counted to the last full km' });
    // Add a distance
    await h.getByRole('button', { name: 'Add a distance' }).click();
    const d = page.locator('#confirm-modal .dbd-c');
    await d.locator('#dbd-a-q').fill('Lina');
    await d.locator('.dbd-hit', { hasText: 'Lina Omar' }).click();
    await d.locator('#dbd-a-km').fill('165');
    await d.locator('#dbd-a-d').fill('2026-11-25');
    await d.locator('#dbd-a-note').fill('Ride lead GPS');
    await d.getByRole('button', { name: 'Add a distance' }).click();
    await expect.poll(() => calls.find((x) => x.name === 'staff_distance_add')?.body).toMatchObject({ p_customer: 'c2', p_kind: 'ride', p_km: 165, p_date: '2026-11-25', p_from: null, p_note: 'Ride lead GPS' });
    // the entry staff made can be removed, after a confirm
    await h.locator('.dbd-st-t').last().getByRole('button', { name: 'Remove' }).click();
    await page.locator('#confirm-modal').getByRole('button', { name: 'Remove' }).last().click();
    await expect.poll(() => calls.find((x) => x.name === 'staff_distance_remove')?.body).toEqual({ p_id: 10 });
    // the podium moves by itself: staff cannot give Gold, Silver or Bronze by hand
    expect(await page.evaluate(`[_bdgCanGive({slug:'lr_gold'}),_bdgCanGive({slug:'lr_bronze'}),_bdgCanGive({slug:'km100'})].join(',')`)).toBe('false,false,true');
  });
});
