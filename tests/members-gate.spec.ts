import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// Saturday Social Ride members gate: the community session is visible to every
// signed-in customer, but only members (community_member() RPC answers true)
// may continue into the booking flow; everyone else gets the members-only
// dialog. The stub answers [] for unknown RPCs, so a spec without an explicit
// 'rpc:community_member' fixture behaves as a NON-member.

const jcc = { id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1, location: 'JCC' };
const sat = {
  id: 'comm1', day: 'Saturday', session_date: '2099-01-10', capacity: 20, status: 'open', created_at: 1, location: 'JCC',
  event_kind: 'community', needs_approval: true, hide_queue: true, spots: 20, title: 'Saturday Social Ride',
};
const fixtures = {
  sessions: [jcc, sat],
  bikes: [{ id: 'b1', name: 'B1', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
  queue_entries: [],
};

test('non-member clicking the Saturday card in Reserve gets the members-only dialog', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  // The Reserve list shows only the chosen event; enter the community view directly
  // (a non-member can still land here with stale state - the card click must gate).
  await page.evaluate(`S.selEvent='community';setCustTab('register')`);

  await page.locator('.sess-card-comm').click();
  const modal = page.locator('#confirm-modal');
  await expect(modal).toContainText('Community members only');
  // the ride itself is never named to somebody who is not a member
  await expect(modal).not.toContainText('Saturday Social Ride');
  await expect(modal.locator('.ev-name')).toHaveCount(0);
  // One way on: Apply (the owner, 2026-09-30); no WhatsApp number, no Instagram, no "Got it"
  await expect(modal.locator('.cm-actions button')).toHaveText(['Apply for MicroMobility’s Community Membership']);
  await expect(modal.locator('.cmy-cm-msg')).toHaveText('Our community rides are for our community members. Apply for membership, and our team will review your application.');
  await expect(modal.locator('a')).toHaveCount(0);
  await expect(modal).not.toContainText(/WhatsApp|Instagram|534423513/);
  // the session was NOT selected
  expect(await page.evaluate('S.selSession')).toBeNull();

  // the × still dismisses it
  await modal.locator('.chrome-xt').click();
  await expect(modal).toBeHidden();
});

// Apply takes the signed-in rider to the community application's second step on the website: a
// one-time code (customer_handoff_create) signs them in there, so the account step is skipped.
const FORM = 'https://micromobility.sa/community/registration';
async function formStub(page: import('@playwright/test').Page) {
  await page.route(FORM + '**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>form</title>' }));
}
test('Apply hands the signed-in rider to the application form with a one-time code', async ({ page }) => {
  const code = 'c0de'.repeat(12);
  await stubSupabase(page, { ...fixtures, 'rpc:customer_handoff_create': code });
  const asked: unknown[] = [];
  page.on('request', (r) => { if (/rpc\/customer_handoff_create/.test(r.url())) asked.push(r.postDataJSON()); });
  await formStub(page);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
  await page.locator('#land-events .landing-event-card.community').click();
  await page.locator('#confirm-modal .cm-apply').click();
  await page.waitForURL(FORM + '**');
  expect(page.url()).toBe(`${FORM}?lang=en&code=${code}`);
  expect(asked).toEqual([{ p_id: 'c1', p_token: 'tok-spec' }]);
});

test('without a code (a database from before it), Apply opens the form at its first step', async ({ page }) => {
  await stubSupabase(page, { ...fixtures, 'rpc:customer_handoff_create': null });
  await formStub(page);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');
  await page.locator('#land-events .landing-event-card.community').click();
  await page.locator('#confirm-modal .cm-apply').click();
  await page.waitForURL(FORM + '**');
  expect(page.url()).toBe(`${FORM}?lang=ar`);
});

// The form's "Already have an account? Sign in" comes here with ?handoff=community: once signed in,
// the rider goes back to the form's second step.
test('?handoff=community sends a signed-in rider back to the form, signed in there', async ({ page }) => {
  const code = 'ab12'.repeat(12);
  await stubSupabase(page, { ...fixtures, 'rpc:customer_handoff_create': code });
  await formStub(page);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/?handoff=community&lang=en');
  await page.waitForURL(FORM + '**');
  expect(page.url()).toBe(`${FORM}?lang=en&code=${code}`);
});

test('non-member clicking the landing Saturday event card gets the dialog and stays on landing', async ({ page }) => {
  await stubSupabase(page, fixtures);
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()'); // a signed-in customer boots into Reserve; the event cards live on landing

  await page.locator('#land-events .landing-event-card.community').click();
  await expect(page.locator('#confirm-modal')).toContainText('Community members only');
  expect(await page.evaluate('S.view')).toBe('landing');
});

test('member continues into the booking flow with no dialog', async ({ page }) => {
  await stubSupabase(page, { ...fixtures, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`S.selEvent='community';setCustTab('register')`);

  await page.locator('.sess-card-comm').click();
  await expect(page.locator('.sess-card-comm.sess-selected')).toBeVisible();
  expect(await page.evaluate('S.selSession')).toBe('comm1');
  await expect(page.locator('#confirm-modal')).toBeHidden();
});

test('signed-in landing shows only the three event cards; Reserve lists only the chosen event', async ({ page }) => {
  await stubSupabase(page, { ...fixtures, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');

  await expect(page.locator('#land-events .landing-event-card:not(.ev-snd96)')).toHaveCount(2);
  await expect(page.locator('.landing-hero-grid')).toBeHidden();     // hero removed for signed-in
  await expect(page.locator('#land-avail-strip')).toBeEmpty();       // availability strip removed

  // the Staff Access entry is back and asks for credentials on a locked device
  await expect(page.locator('#land-staff-btn')).toBeVisible();
  await page.locator('#land-staff-btn').click();
  await expect(page.locator('#pin-modal .pin-box')).toBeVisible();
  await expect(page.locator('#staff-auth-email')).toBeVisible();     // email+password prompt
  await page.locator('#pin-modal .pin-cancel').click();              // close before the card assertions
  await expect(page.locator('#pin-modal .pin-box')).toBeHidden();

  // picking the JCC event lists ONLY the JCC session (no Saturday card mixed in)
  await page.locator('#land-events .landing-event-card.ev-jcc').click();
  await page.waitForFunction(`S.view==='customer'`);
  await expect(page.locator('.sess-card')).toHaveCount(1);
  await expect(page.locator('.sess-card-comm')).toHaveCount(0);
});

test('member landing card click opens the community Reserve flow', async ({ page }) => {
  await stubSupabase(page, { ...fixtures, 'rpc:community_member': true });
  await loginCustomer(page, { id: 'c1', name: 'Spec Rider' });
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('goLanding()');

  await page.locator('#land-events .landing-event-card.community').click();
  await page.waitForFunction(`S.view==='customer'`);
  expect(await page.evaluate('S.selEvent')).toBe('community');
  await expect(page.locator('#confirm-modal')).toBeHidden();
});
