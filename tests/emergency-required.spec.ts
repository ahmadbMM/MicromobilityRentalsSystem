import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// The first emergency contact is required of every account (the owner, 2026-10-07: "make the emergency contact
// obligatory only the first one not the second and unskippable for all the customers and force them even add it in
// the sign up page"). Create account asks it (the second waits behind "Add a second contact") and saves both once the
// account exists; an account without one meets the check-up (the server's _customer_asks, 20261007230000) with its
// own words, no "I don't have one", and Log out as the only other way off. Every person and number here is made up.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];
const OK = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };

function rpcBodies(page: Page, fn: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new RegExp(`/rpc/${fn}(\\?|$)`).test(r.url())) out.push(r.postDataJSON()); });
  return out;
}

test.describe('@customer:auth the emergency contact on Create account', () => {
  async function signupPage(page: Page) {
    await stubSupabase(page, { sessions, queue_entries: [], 'rpc:my_bookings': [], 'rpc:customer_set_emergency': true, 'rpc:customer_set_emergency2': true });
    await page.route(/\/rest\/v1\/rpc\/customer_signup/, (r) => r.fulfill({ status: 200, headers: OK, body: JSON.stringify([{ session_token: 'tok-e' }]) }));
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('openAuthModal();switchAuthMode("signup")');
    await page.fill('#a-first', 'Faisal');
    await page.fill('#a-last', 'Haddad');
    await page.evaluate('setSignupGender("male")');
    await page.fill('#a-email', 'faisal.haddad@example.com');
    await page.fill('#a-phone', '0508566560');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.fill('#a-pwd2', 'Zq8xTselah');
    await page.fill('#a-height', '175');
  }
  const submit = (page: Page) => page.evaluate('S.signupAck=true;doSignup()');

  test('required: nothing is made without it, the own number is refused, then both calls carry it', async ({ page }) => {
    await signupPage(page);
    const made = rpcBodies(page, 'customer_signup'), saved = rpcBodies(page, 'customer_set_emergency'), saved2 = rpcBodies(page, 'customer_set_emergency2');
    await expect(page.locator('#su-em-t')).toContainText('Emergency contact');
    await expect(page.locator('#su-em2-name')).toHaveCount(0); // the second waits behind its button
    await submit(page);
    await expect(page.locator('#auth-err')).not.toBeEmpty();
    await page.fill('#su-em-name', 'Nora Haddad');
    await page.fill('#su-em-phone', '0508566560'); // the rider's own
    await page.selectOption('#su-em-rel', 'sibling');
    await submit(page);
    await expect(page.locator('#auth-err')).toHaveText('Your contact’s number can’t be your own.');
    expect(made).toHaveLength(0);
    await page.fill('#su-em-phone', '0551234567');
    await submit(page);
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(made).toHaveLength(1);
    await expect.poll(() => saved.length).toBe(1);
    expect(saved[0]).toEqual({ p_id: made[0].p_id, p_token: 'tok-e', p_name: 'Nora Haddad', p_phone: '+966551234567', p_relation: 'sibling' });
    expect(saved2).toHaveLength(0);
  });

  test('the second, once added: all three or none, not the first one’s number', async ({ page }) => {
    await signupPage(page);
    const saved = rpcBodies(page, 'customer_set_emergency'), saved2 = rpcBodies(page, 'customer_set_emergency2');
    await page.fill('#su-em-name', 'Nora Haddad');
    await page.fill('#su-em-phone', '0551234567');
    await page.selectOption('#su-em-rel', 'sibling');
    await page.click('#su-em2-add');
    await expect(page.locator('#su-em2-name')).toBeFocused();
    await expect(page.locator('#su-em-name')).toHaveValue('Nora Haddad'); // the repaint keeps what was typed
    await page.fill('#su-em2-name', 'Lina Saleh');
    await page.fill('#su-em2-phone', '0551234567');
    await page.selectOption('#su-em2-rel', 'friend');
    await submit(page);
    await expect(page.locator('#auth-err')).toHaveText('The two emergency contacts can’t have the same number.');
    await page.fill('#su-em2-phone', '0551230077');
    await submit(page);
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    await expect.poll(() => saved2.length).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved2[0]).toMatchObject({ p_token: 'tok-e', p_name: 'Lina Saleh', p_phone: '+966551230077', p_relation: 'friend' });
  });

  test('an added second left empty is not sent', async ({ page }) => {
    await signupPage(page);
    const saved2 = rpcBodies(page, 'customer_set_emergency2');
    await page.fill('#su-em-name', 'Nora Haddad');
    await page.fill('#su-em-phone', '0551234567');
    await page.selectOption('#su-em-rel', 'sibling');
    await page.click('#su-em2-add');
    await submit(page);
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(saved2).toHaveLength(0);
  });
});

test.describe('@customer:fix an account without an emergency contact', () => {
  test('the check-up opens at once, says why, has no "I don\'t have one", and saves the contact', async ({ page }) => {
    await stubSupabase(page, {
      sessions, queue_entries: [], 'rpc:my_bookings': [],
      'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001' }],
      'rpc:customer_emergency': [{ emergency_name: null, emergency_phone: null, emergency_relation: null, emergency2_name: null, emergency2_phone: null, emergency2_relation: null }],
      'rpc:customer_fix_fields': ['emergency'],
      'rpc:customer_fix_save': [],
    });
    const sent = rpcBodies(page, 'customer_fix_save');
    await loginCustomer(page, { id: 'c1', phone: '0500000001' });
    await page.goto('/');
    await waitForSb(page);
    await expect(page.locator('#fix-gate .fx-box')).toBeVisible(); // at sign-in, not at the next booking
    await expect(page.locator('#fx-title')).toHaveText('Add your emergency contact');
    await expect(page.locator('#fix-gate .fx-none')).toHaveCount(0);
    await expect(page.locator('#fix-gate .gate-out')).toBeVisible(); // Log out, the only other way off
    await page.keyboard.press('Escape');
    await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
    await page.click('#fx-save');
    await expect(page.locator('.fx-item[data-fx="emergency"].err')).toBeVisible();
    expect(sent).toHaveLength(0);
    await page.fill('#fx-em-name', 'Nora Haddad');
    await page.fill('#fx-em-phone', '0551234567');
    await page.selectOption('#fx-em-rel', 'parent');
    await page.click('#fx-save');
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0].p_values).toEqual({ emergency: { name: 'Nora Haddad', phone: '+966551234567', relation: 'parent' } });
    await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
  });

  test('the server’s refusal to clear the only contact is said in words', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [] });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`_emErrSay({message:'BAD_INPUT',details:'em_required'})`)).toBe('Your account needs an emergency contact. Change it instead of removing it.');
  });
});
