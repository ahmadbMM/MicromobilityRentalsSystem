import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The staff review's leftovers, marked Build now on 2026-10-28 and built 2026-11-04, desk part:
// S01-core1-05 the database's desk refusals are said in the desk's language;
// S01-core1-06 one no-show chip in words, which a free ride closed without attendance does not feed;
// S03-core3-07 the open check-in panel is written only when its markup changes, and keeps the focus;
// S03-core3-12 the status and payment filters stay on one day's ride and do not follow the staffer.

const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const NEXT = '2099-01-20';
const sessions = [
  { id: today, day: 'Today', session_date: today, capacity: 20, status: 'open', created_at: 1 },
  { id: NEXT, day: 'Tuesday', session_date: NEXT, capacity: 20, status: 'open', created_at: 2 },
];
const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, session_id: today, session_day: 'Today', session_date: today, queue_num: 1, name: 'Spec Rider', phone: '0500000001', customer_id: 'c1',
  type_preference: 'Road', height: 175, size: 'M', status: 'waiting', paid: false, price: 75, registered_at: '2026-01-01T10:00:00Z', ...over,
});

async function desk(page: Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [row('a')], bikes: [], ...fixtures });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
  await page.waitForFunction('S.dataLoaded&&!!_qGet("a")');
}

test.describe('@staff:bookings the desk\'s words', () => {
  test('a desk refusal is said in the desk\'s language, and any other code keeps its sentence', async ({ page }) => {
    await desk(page);
    const say = (m: string) => page.evaluate(`_rpcMessage({message:${JSON.stringify(m)}})`);
    expect(await say('BAD_BOOKING_STATE: #12 is active, not waiting')).toBe(await page.evaluate(`t('errChangedElsewhere')`));
    expect(await say('BIKE_UNAVAILABLE: bike 7 is in-use')).toBe('Bike no longer available. 7');
    expect(await say('BIKE_NEEDS_CHECK: bike 7 needs a check before it goes out')).toBe(await page.evaluate(`t('chkBanner')`));
    expect(await say('BIKE_UNAVAILABLE: bike 42 is in-use (with Other Rider)')).toBe('Bike no longer available. 42 · Other Rider');
    expect(await say('BIKE_NOT_FOUND: no bike B-77')).toBe('No bike matches "B-77".');
    expect(await say('BOOKING_NOT_FOUND')).toBe(await page.evaluate(`t('vndErrNotLive')`));
    expect(await say('SOMETHING_ELSE: a sentence for staff')).toBe('a sentence for staff');
    expect(await say('')).toBe(await page.evaluate(`t('errConnection')`));
  });

  test('the staff\'s Arabic reaches a desk refusal', async ({ page }) => {
    await desk(page);
    await page.evaluate(`setLang('ar')`);
    await page.waitForFunction(`t('chkBanner')!==LANG.en.chkBanner`);
    const said = String(await page.evaluate(`_rpcMessage({message:'BIKE_NEEDS_CHECK: bike 7 needs a check before it goes out'})`));
    expect(said).toMatch(/[؀-ۿ]/);
    expect(said).not.toContain('bike 7');
  });
});

test.describe('@staff:bookings the no-show chip', () => {
  const noshow = (id: string, sid: string) => row(id, { session_id: sid, session_date: sid, status: 'noshow', registered_at: `${sid}T10:00:00Z` });
  const past = [{ id: '2026-01-05', day: 'Monday', session_date: '2026-01-05', capacity: 20, status: 'closed', created_at: 3 },
    { id: '2026-01-06', day: 'Tuesday', session_date: '2026-01-06', capacity: 20, status: 'closed', created_at: 4 }];

  test('two no-shows in the last five read in words, once, with no bare number', async ({ page }) => {
    await desk(page, { sessions: [...sessions, ...past], queue_entries: [row('a'), noshow('n1', '2026-01-05'), noshow('n2', '2026-01-06')] });
    const chip = page.locator('#tab-queue .rq-nsflag');
    await expect(chip.first()).toHaveText('2/2 no-shows');
    await expect(chip).toHaveCount(1);
    await expect(page.locator('.rq-nschip')).toHaveCount(0);
  });

  test('one no-show says nothing yet', async ({ page }) => {
    await desk(page, { sessions: [...sessions, ...past], queue_entries: [row('a'), noshow('n1', '2026-01-05')] });
    await expect(page.locator('#tab-queue .rq-nsflag')).toHaveCount(0);
  });

  test('a free ride closed with nobody checked in does not count; one that took attendance does', async ({ page }) => {
    const free = past.map(s => ({ ...s, event_kind: 'community', status: 'closed' }));
    await desk(page, { sessions: [...sessions, ...free], queue_entries: [row('a'), noshow('n1', '2026-01-05'), noshow('n2', '2026-01-06')] });
    expect(await page.evaluate(`[_isFreeRide(_sessGet('2026-01-05')),noShowFlag(_qGet('a'))]`)).toEqual([true, '']);
    // somebody was checked in on each: attendance was taken, so these two mean something
    await page.evaluate(`S.queue=[...S.queue,entryFromDB({id:'d1',session_id:'2026-01-05',session_date:'2026-01-05',status:'done',name:'Other',phone:'0500000002',queue_num:2}),entryFromDB({id:'d2',session_id:'2026-01-06',session_date:'2026-01-06',status:'done',name:'Other',phone:'0500000002',queue_num:2})]`);
    expect(await page.evaluate(`noShowFlag(_qGet('a'))`)).toContain('2/2');
  });
});

test.describe('@staff:bookings the open check-in panel', () => {
  test('a repaint that changes nothing leaves its nodes and the focus', async ({ page }) => {
    await desk(page);
    await page.evaluate(`showCheckinModal('a')`);
    await expect(page.locator('#ci-confirm')).toBeVisible();
    await page.waitForTimeout(200); // the first paint's focus has had its turn
    await page.evaluate(`window.__n=document.getElementById('ci-confirm');window.__n.focus();renderStaffQueue();renderCheckinModal()`);
    expect(await page.evaluate(`[document.getElementById('ci-confirm')===window.__n,document.activeElement===window.__n]`)).toEqual([true, true]);
  });

  test('a change rewrites it and the focus goes back to the same control', async ({ page }) => {
    await desk(page);
    await page.evaluate(`showCheckinModal('a')`);
    await expect(page.locator('#ci-confirm')).toBeVisible();
    await page.waitForTimeout(200);
    await page.evaluate(`window.__n=document.getElementById('ci-confirm');window.__n.focus();_qGet('a').height=188;renderCheckinModal()`);
    await expect(page.locator('#checkin-modal .ci-height')).toContainText('188');
    expect(await page.evaluate(`[document.getElementById('ci-confirm')===window.__n,document.activeElement&&document.activeElement.id]`)).toEqual([false, 'ci-confirm']);
  });

  test('a partial paint does not leave the old copy standing: a bike taken back goes off the panel', async ({ page }) => {
    await desk(page);
    await page.evaluate(`showCheckinModal('a')`);
    await expect(page.locator('#ci-confirm')).toBeVisible();
    await page.evaluate(`S._ciBikeMsg='Bike Nine';_ciRenderBikeSpec()`);
    await expect(page.locator('#ci-bike-spec')).toContainText('Bike Nine');
    await page.evaluate(`S._ciBikeMsg=null;renderCheckinModal()`); // the markup is what it was before the partial paint
    await expect(page.locator('#ci-bike-spec')).not.toContainText('Bike Nine');
  });

  test('closed and opened again, the panel draws afresh', async ({ page }) => {
    await desk(page);
    await page.evaluate(`showCheckinModal('a')`);
    await expect(page.locator('#ci-confirm')).toBeVisible();
    await page.evaluate(`closeCheckinModal(true)`);
    await expect(page.locator('#ci-confirm')).toHaveCount(0);
    await page.evaluate(`showCheckinModal('a')`);
    await expect(page.locator('#ci-confirm')).toBeVisible();
  });
});

test.describe('@staff:bookings filters for the work in hand', () => {
  test('moving to another day\'s ride clears status and payment; size and sort stay', async ({ page }) => {
    await desk(page);
    await page.evaluate(`setSfStatus('waiting');setSfPay('paid');S.sfSize='M';setSfSession('${NEXT}')`);
    expect(await page.evaluate('[S.sfStatus,S.sfPay,S.sfSize]')).toEqual(['all', 'all', 'M']);
  });

  test('another ride on the same day keeps them', async ({ page }) => {
    const twin = { id: `${today}-b`, day: 'Today', session_date: today, capacity: 20, status: 'open', created_at: 5 };
    await desk(page, { sessions: [...sessions, twin] });
    await page.evaluate(`setSfStatus('waiting');setSfSession('${twin.id}')`);
    expect(await page.evaluate('S.sfStatus')).toBe('waiting');
  });

  test('a refresh the same day keeps them; a tab left open since yesterday starts on the whole list', async ({ page }) => {
    await desk(page);
    await page.evaluate(`setSfStatus('waiting');setSfPay('paid');renderStaffQueue()`);
    await page.reload();
    await waitForSb(page);
    await page.evaluate(`setStaffTab('queue');renderStaffQueue()`);
    expect(await page.evaluate('[S.sfStatus,S.sfPay]')).toEqual(['waiting', 'paid']);

    await page.evaluate(`(()=>{const v=JSON.parse(sessionStorage.getItem('cq_queue_view'));v.on='2020-01-01';sessionStorage.setItem('cq_queue_view',JSON.stringify(v));S.sfStatus='all';S.sfPay='all';_restoreQueueView();})()`);
    expect(await page.evaluate('[S.sfStatus,S.sfPay]')).toEqual(['all', 'all']);
  });

  test('another device opens on the whole list, though the account\'s saved filters name a status', async ({ page }) => {
    await desk(page);
    await page.evaluate(`S._prefSrv={...(S._prefSrv||{}),'state.queue':{sfStatus:'done',sfPay:'paid',sfSort:'name'}};sessionStorage.removeItem('cq_queue_view');delete S._stDef;_stLoad('queue')`);
    expect(await page.evaluate('[S.sfStatus,S.sfPay]')).toEqual(['all', 'all']);
  });

  test('leaving the page saves no status or payment filter, and Reset filters still clears them', async ({ page }) => {
    await desk(page);
    await page.evaluate(`setSfStatus('waiting');setSfPay('paid');S.sfSort='name';_stLoad('queue');_stSave('queue')`);
    const saved = await page.evaluate(`_pref('state.queue',null)`);
    expect(saved).not.toHaveProperty('sfStatus');
    expect(saved).not.toHaveProperty('sfPay');
    await page.evaluate(`_stReset('queue')`);
    expect(await page.evaluate('[S.sfStatus,S.sfPay,S.sfSort]')).toEqual(['all', 'all', 'queue']);
  });
});
