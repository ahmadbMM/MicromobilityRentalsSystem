import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Members book first (the user, 2026-11-18: "Members book first: featured or limited sessions open to community members a
// few hours before everyone else. It isn't worth money, and it makes membership mean something now that sessions sell
// out"). sessions.public_at: until then only active Community members may book (the database refuses anyone else with
// MEMBERS_FIRST, 20261118210800). Staff switch it on a session everyone may book, for 3 to 48 hours (bike_slots._mfh).

const NOW = new Date('2099-11-10T09:00:00+03:00');
const AT = '2099-11-10T09:00:00.000Z'; // 12:00 in Riyadh, three hours on
const JCC = '2099-11-17';
const JCC2 = '2099-11-19';
const WS = '2099-11-18-ws';
const jcc = { id: JCC, session_date: '2099-11-17', day: 'Tuesday', status: 'open', capacity: 40, created_at: 1, public_at: AT, bike_slots: '{"_time":"21:00 - 23:00","_total":40,"_mfh":3}' };
const jcc2 = { ...jcc, id: JCC2, session_date: '2099-11-19', day: 'Thursday', public_at: null, bike_slots: '{"_time":"21:00 - 23:00","_total":40}' };
const workshop = {
  id: WS, session_date: '2099-11-18', day: 'Wednesday', status: 'open', capacity: 20, created_at: 1, event_kind: 'community', ride_kind: 'workshop',
  open_to_all: true, needs_approval: true, hide_queue: true, spots: 20, paid_ride: false, public_at: AT, bike_slots: '{"_time":"18:00 - 20:00","_mfh":3}',
};

async function custBoot(page: Page, member: boolean, lang = '', sessions: Record<string, unknown>[] = [jcc, jcc2]) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions, queue_entries: [], 'rpc:my_bookings': [], 'rpc:community_member': member });
  await loginCustomer(page, { id: 'c1', name: 'Sara Haddad', email: 'sara@example.com', birth_date: '1995-05-05' });
  await page.goto('/' + (lang ? `?lang=${lang}` : ''));
  await waitForSb(page);
  await page.evaluate('goLanding()');
}
const card = (page: Page, id: string) => page.locator(`#tab-register [data-session="${id}"]`);
const radio = (page: Page, id: string) => page.locator(`#tab-register [id="sc-${id}"]`);

test.describe('@customer:reserve members book first', () => {
  test('anyone else sees the date held: Members book first, when everyone may, nothing to pick, no Book in Details', async ({ page }) => {
    await custBoot(page, false);
    await page.evaluate(`selectEvent('jcc')`);
    const c = card(page, JCC);
    await expect(c).toHaveClass(/sess-card-mf/);
    await expect(c).toHaveAttribute('aria-disabled', 'true');
    await expect(c.locator('.spots-soon')).toHaveText('Members book first');
    await expect(c.locator('.sess-mf-l')).toHaveText('Everyone from Today · 12 PM');
    await expect(radio(page, JCC)).toHaveCount(0);
    await c.click({ force: true });
    expect(await page.evaluate('S.selSession')).toBe(null);
    // the date beside it books as before
    await expect(radio(page, JCC2)).toHaveAttribute('tabindex', '0');
    // Details says it, and offers no date to choose
    await page.evaluate(`showSessInfo('${JCC}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('Members book first');
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('Everyone from Today · 12 PM');
    await expect(page.locator('#bike-info-modal').getByRole('button', { name: 'Choose this date' })).toHaveCount(0);
    await page.evaluate('closeEventInfo()');
    // once the moment passes, the next paint is the usual one
    await page.clock.setFixedTime(new Date('2099-11-10T12:00:01+03:00'));
    await page.evaluate('renderRegister()');
    await expect(radio(page, JCC)).toBeVisible();
    await expect(page.locator('#tab-register')).not.toContainText('Members book first');
    await expect(page.locator('#tab-register .spots-mf')).toHaveCount(0);
  });

  test('a member sees Members first and picks the date as usual', async ({ page }) => {
    await custBoot(page, true);
    await page.evaluate(`selectEvent('jcc')`);
    await expect(radio(page, JCC)).toBeVisible();
    await expect(radio(page, JCC).locator('.spots-mf')).toHaveText('Members first');
    await expect(page.locator('#tab-register .sess-card-mf')).toHaveCount(0);
    await page.evaluate(`selectSessCard('${JCC}')`);
    await expect.poll(() => page.evaluate('S.selSession')).toBe(JCC);
    // the window is ahead, so Details says it to members too
    await page.evaluate(`showSessInfo('${JCC}')`);
    await expect(page.locator('#bike-info-modal .ev-info-facts')).toContainText('Members book first');
  });

  test('in Arabic', async ({ page }) => {
    await custBoot(page, false, 'ar');
    await page.evaluate(`selectEvent('jcc')`);
    await expect(card(page, JCC).locator('.spots-soon')).toHaveText('الحجز للأعضاء أولًا');
    await expect(card(page, JCC).locator('.sess-mf-l')).toContainText('للجميع من');
  });

  test('the server\'s refusal (a page painted before the window) is said in words with when everyone may book', async ({ page }) => {
    await custBoot(page, false, '', [{ ...jcc, public_at: null }, jcc2]);
    await page.evaluate(`selectEvent('jcc')`);
    await expect(radio(page, JCC)).toBeVisible();
    const err = `{code:'P0001',message:'MEMBERS_FIRST',details:'${AT.replace('.000', '')}'}`;
    expect(await page.evaluate(`_errMessage(${err})`)).toBe('Members book first on this date. Everyone can book from Today · 12 PM.');
    await page.evaluate(`_bookRefused(${err},_sessGet('${JCC}'))`);
    await expect(page.locator('.toast').filter({ hasText: 'Members book first on this date.' })).toBeVisible();
    // a refusal with no time still says who books first; any other error is left alone
    expect(await page.evaluate(`_mfErrOf({message:'MEMBERS_FIRST'})`)).toBe('Members book first');
    expect(await page.evaluate(`_mfErrOf({message:'SESSION_CLOSED'})`)).toBe('');
  });

  test('the Featured card says it too: the status to anyone else, the mark to a member', async ({ page }) => {
    await custBoot(page, false);
    const feat = { ...workshop, ride_kind: 'yoga', open_to_all: true, id: '2099-11-18-yg' };
    expect(await page.evaluate(`_featCardHtml(${JSON.stringify(feat)})`)).toContain('Members book first');
    await page.evaluate(`S._commAccess={custId:'c1',ok:true}`);
    const html = (await page.evaluate(`_featCardHtml(${JSON.stringify(feat)})`)) as string;
    expect(html).toContain('Members first');
    expect(html).not.toContain('Members book first');
  });
});

test.describe('@customer:members members book first in the Community tab', () => {
  test('Coming up and the next session wear the mark, and a member is offered Book', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    const feed = { ok: true, today: '2099-11-10', me: null, club: null, goals: [], numbers: null, post: null, announce: [], volunteer: null, birthday: false, awarded: [], year: null };
    await stubSupabase(page, { sessions: [workshop], customers: [], queue_entries: [], bikes: [], 'rpc:community_member': true, 'rpc:hub_feed': feed });
    await loginCustomer(page, { id: 'c1', name: 'Lina Haddad', gender: 'male' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('members')`);
    const hero = page.locator('#hub-body .hub-hero');
    await expect(hero).toBeVisible();
    await expect(hero.locator('.hub-mf')).toHaveText('Members first');
    await expect(hero.getByRole('button', { name: 'Book' })).toBeVisible();
  });
});

test.describe('@staff:sessions members book first', () => {
  async function staffBoot(page: Page, sessions: Record<string, unknown>[]) {
    await page.clock.setFixedTime(NOW);
    await page.setViewportSize({ width: 1280, height: 900 });
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], promo_codes: [] });
    await page.route(/\/rest\/v1\/sessions\?/, async (r) => {
      if (r.request().method() !== 'PATCH') return r.fallback();
      return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'x' }]) });
    });
    const writes: { m: string; b: Record<string, unknown> }[] = [];
    page.on('request', (r) => {
      if (!['PATCH', 'POST'].includes(r.method()) || !/\/rest\/v1\/sessions(\?|$)/.test(r.url())) return;
      try { const b = r.postDataJSON(); writes.push({ m: r.method(), b: Array.isArray(b) ? b[0] : b }); } catch { /* none */ }
    });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`S.dataLoaded&&allSessions().length===${sessions.length}`);
    await page.evaluate(`setStaffTab('sessions')`);
    return writes;
  }
  const slotsOf = (p: Record<string, unknown>) => JSON.parse(String(p.bike_slots)) as Record<string, unknown>;
  const hoursOn = (iso: unknown) => Math.round((Date.parse(String(iso)) - NOW.getTime()) / 36e5);
  const plain = { ...jcc2, id: '2099-11-21', session_date: '2099-11-21', day: 'Saturday' };
  const sat = { ...jcc2, id: '2099-11-21-2', session_date: '2099-11-21', day: 'Saturday', event_kind: 'community', ride_kind: 'saturday', open_to_all: false, needs_approval: true, spots: 40 };

  test('the edit form: switched on for 12 hours, the window starts now and the hours ride in the slots', async ({ page }) => {
    const w = await staffBoot(page, [plain]);
    await page.evaluate(`startEditSession('${plain.id}')`);
    await expect(page.locator('#es-mf')).not.toBeChecked();
    await expect(page.locator('#es-mf-for')).toBeHidden();
    await page.locator('#es-mf').check();
    await expect(page.locator('#es-mf-for')).toBeVisible();
    await page.getByLabel('Members only for').selectOption('12');
    await expect(page.locator('#es-mf-until')).toHaveText('Members only until Today · 9 PM');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => w.length).toBe(1);
    expect(hoursOn(w[0].b.public_at)).toBe(12);
    expect(slotsOf(w[0].b)).toMatchObject({ _time: '21:00 - 23:00', _mfh: 12 });
  });

  test('a session that has it opens on it, keeps it through an untouched save, moves with the hours, and loses it switched off', async ({ page }) => {
    const w = await staffBoot(page, [jcc, plain]);
    await page.evaluate(`startEditSession('${JCC}')`);
    await expect(page.locator('#es-mf')).toBeChecked();
    await expect(page.locator('#es-mf-h')).toHaveValue('3');
    await expect(page.locator('#es-mf-until')).toHaveText('Members only until Today · 12 PM');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => w.length).toBe(1);
    expect('public_at' in w[0].b).toBe(false); // nothing changed: not sent
    expect(slotsOf(w[0].b)._mfh).toBe(3);
    // 6 hours from the same opening
    await page.evaluate(`startEditSession('${JCC}')`);
    await page.locator('#es-mf-h').selectOption('6');
    await expect(page.locator('#es-mf-until')).toHaveText('Members only until Today · 3 PM');
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => w.length).toBe(2);
    expect(hoursOn(w[1].b.public_at)).toBe(6);
    // switched off
    await page.evaluate(`startEditSession('${JCC}')`);
    await page.locator('#es-mf').uncheck();
    await page.evaluate('_saveSessionEdit()');
    await expect.poll(() => w.length).toBe(3);
    expect(w[2].b.public_at).toBe(null);
    expect('_mfh' in slotsOf(w[2].b)).toBe(false);
  });

  test('a members-only session has no switch', async ({ page }) => {
    await staffBoot(page, [sat, plain]);
    await page.evaluate(`startEditSession('${sat.id}')`);
    await expect(page.locator('#sess-edit-form')).toBeVisible();
    await expect(page.locator('#es-mf')).toHaveCount(0);
  });

  test('the new form: off at first; Open now writes the window, a Draft only the hours; a clone starts without it', async ({ page }) => {
    const w = await staffBoot(page, [jcc, plain]);
    await page.evaluate(`S.showAddSession=true;S.newSessEvent='jcc';S.newSessMode='total';S.newSessTotal=6;S.newSessDate='2099-11-24';_n6sFormReset();S.n6sPub='open';renderSessions()`);
    await expect(page.locator('#ns-mf')).not.toBeChecked();
    await page.locator('#ns-mf').check();
    await page.locator('#ns-mf-h').selectOption('24');
    await page.locator('#tab-sessions').getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => w.filter((x) => x.m === 'POST').length).toBe(1);
    const row = w.find((x) => x.m === 'POST')!.b;
    expect(row.status).toBe('open');
    expect(hoursOn(row.public_at)).toBe(24);
    expect(slotsOf(row)._mfh).toBe(24);
    // a draft: the hours only, the server starts the window when it opens
    await page.waitForFunction(`!_busyKeys.has('addSession')&&!S.showAddSession`);
    await page.evaluate(`S.showAddSession=true;S.newSessEvent='jcc';S.newSessMode='total';S.newSessTotal=6;S.newSessDate='2099-11-26';S.n6sPub='draft';S.newSessMf=true;S.newSessMfH=6;renderSessions()`);
    await page.locator('#tab-sessions').getByRole('button', { name: 'Create session' }).click();
    await expect.poll(() => w.filter((x) => x.m === 'POST').length).toBe(2);
    const d = w.filter((x) => x.m === 'POST')[1].b;
    expect(d.status).toBe('closed');
    expect('public_at' in d).toBe(false);
    expect(slotsOf(d)._mfh).toBe(6);
    // a members-only kind offers no switch; a clone of a session that has it starts without
    await page.evaluate(`S.showAddSession=true;S.newSessEvent='community';renderSessions()`);
    await expect(page.locator('#ns-mf')).toHaveCount(0);
    await page.evaluate(`cloneSession('${JCC}')`);
    await expect(page.locator('#ns-mf')).not.toBeChecked();
  });

  test('the list marks it while the window runs; a copied week starts without it', async ({ page }) => {
    await staffBoot(page, [jcc, plain]);
    expect(await page.evaluate(`_ssStatusBadge(_sessGet('${JCC}'))`)).toContain('Members first');
    expect(await page.evaluate(`_ssStatusBadge(_sessGet('${plain.id}'))`)).not.toContain('Members first');
    await page.evaluate(`S.sessView='list';renderSessions()`);
    await expect(page.locator('#tab-sessions .ssx-mf')).toHaveText('Members first');
    const row = (await page.evaluate(`_n6sCopyRow(_sessGet('${JCC}'),7)`)) as Record<string, unknown>;
    expect('public_at' in row).toBe(false);
    expect(slotsOf(row)._mfh).toBeUndefined();
    await page.clock.setFixedTime(new Date('2099-11-10T12:00:01+03:00'));
    expect(await page.evaluate(`_ssStatusBadge(_sessGet('${JCC}'))`)).not.toContain('Members first');
  });
});
