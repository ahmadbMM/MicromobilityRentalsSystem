import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// A second emergency contact, always optional (the owner, 2026-10-07: "add a second optional emergency contact field,
// show it in the customer My Account, and allow the staff to flag it"). My Account offers it under the first, in the
// same card, once the database has it (customer_emergency answers the emergency2_* columns, 20261007150000) and there
// is a first to back up; it is saved, changed and removed (saved blank) through customer_set_emergency2. On the
// correction page a flagged second contact is answered like the first, "I don't have one" clears it, and the two
// contacts may not share a number. Every person and number here is made up.

const S1 = '2099-01-01';
const sessions = [{ id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 20, created_at: 1, event_kind: 'jcc' }];
const first = { emergency_name: 'Nora Haddad', emergency_phone: '+966551234567', emergency_relation: 'sibling' };
const noFirst = { emergency_name: null, emergency_phone: null, emergency_relation: null };
const noSecond = { emergency2_name: null, emergency2_phone: null, emergency2_relation: null };
const second = { emergency2_name: 'Lina Saleh', emergency2_phone: '+966551230077', emergency2_relation: 'friend' };

function rpcBodies(page: Page, fn: string) {
  const out: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && new RegExp(`/rpc/${fn}(\\?|$)`).test(r.url())) out.push(r.postDataJSON()); });
  return out;
}

test.describe('@customer:account second emergency contact', () => {
  test.describe('on My Account', () => {
    async function account(page: Page, em: Record<string, unknown>[], fx: Record<string, unknown> = {}) {
      await stubSupabase(page, { sessions, queue_entries: [], 'rpc:my_bookings': [], 'rpc:customer_emergency': em, 'rpc:customer_set_emergency2': true, ...fx });
      await loginCustomer(page);
      await page.goto('/');
      await waitForSb(page);
      await page.evaluate(`setCustTab('account')`);
      await expect(page.locator('#acc-em')).toBeVisible();
    }

    test('offered under the first once there is one, and out of the way while the first is changed', async ({ page }) => {
      await account(page, [{ ...first, ...noSecond }]);
      const box = page.locator('#acc-em'), sec = box.locator('#acc-em2');
      await expect(page.locator('#acc-em > .run-em-card')).toContainText('Nora Haddad');
      await expect(sec.locator('#acc-em2-t')).toHaveText('Second emergency contact (optional)');
      await expect(sec).toContainText('Someone else we can call if we can’t reach your first contact.');
      await expect(sec.getByRole('button', { name: 'Add a second contact' })).toBeVisible();
      await expect(sec).toHaveAttribute('aria-labelledby', 'acc-em2-t');
      await expect(sec.locator('input, select')).toHaveCount(0);
      await box.getByRole('button', { name: 'Change' }).click();
      await expect(page.locator('#acc-em-name')).toHaveValue('Nora Haddad');
      await expect(box.locator('#acc-em2')).toHaveCount(0);
      await box.getByRole('button', { name: 'Cancel' }).click();
      await expect(box.locator('#acc-em2-add')).toBeVisible();
    });

    test('no first contact: only the first is asked', async ({ page }) => {
      await account(page, [{ ...noFirst, ...noSecond }]);
      await expect(page.locator('#acc-em-name')).toBeVisible();
      await expect(page.locator('#acc-em2')).toHaveCount(0);
    });

    test('a database from before the second contact (three columns) offers none', async ({ page }) => {
      await account(page, [first]);
      await expect(page.locator('#acc-em > .run-em-card')).toContainText('Nora Haddad');
      await expect(page.locator('#acc-em2')).toHaveCount(0);
      await expect(page.locator('#acc-em')).not.toContainText('Second emergency contact');
    });

    test('adding one: the first contact’s number and the rider’s own are refused before any request; Save sends the three', async ({ page }) => {
      const sent = rpcBodies(page, 'customer_set_emergency2');
      await account(page, [{ ...first, ...noSecond }]);
      await page.locator('#acc-em2-add').click();
      await expect(page.locator('#acc-em2-name')).toBeFocused();
      await expect(page.locator('#acc-em2-name')).toHaveValue('');
      await page.fill('#acc-em2-name', 'Lina Saleh');
      await page.fill('#acc-em2-phone', '0551234567'); // the first contact's number
      await page.selectOption('#acc-em2-rel', 'friend');
      await page.locator('#acc-em2-save').click();
      await expect(page.locator('#acc-em2-phone-err')).toContainText('The two emergency contacts can’t have the same number.');
      await expect(page.locator('#acc-em2-err')).toHaveText('The two emergency contacts can’t have the same number.');
      await page.fill('#acc-em2-phone', '0500000001'); // the rider's own
      await page.locator('#acc-em2-save').click();
      await expect(page.locator('#acc-em2-phone-err')).toContainText('can’t be your own');
      expect(sent).toHaveLength(0);
      await page.fill('#acc-em2-phone', '0551230077');
      await page.locator('#acc-em2-save').click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_name: 'Lina Saleh', p_phone: '+966551230077', p_relation: 'friend' });
      const card = page.locator('#acc-em2 .run-em-card');
      await expect(card).toContainText('Lina Saleh');
      await expect(card).toContainText('Friend');
      await expect(card.locator('bdi[dir="ltr"]')).toHaveText('+966551230077');
      await expect(card.getByRole('button', { name: 'Change' })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Remove' })).toBeVisible();
      await expect(page.locator('#acc-em > .run-em-card')).toContainText('Nora Haddad'); // the first is as it was
      expect(await page.evaluate(`[S._em.v.name,S._em.v.name2,S._em.v.phone2,S._em.v.rel2].join('|')`)).toBe('Nora Haddad|Lina Saleh|+966551230077|friend');
    });

    test('a saved one: Change keeps it in the boxes, Cancel leaves it, Remove saves it blank', async ({ page }) => {
      const sent = rpcBodies(page, 'customer_set_emergency2');
      await account(page, [{ ...first, ...second }]);
      const sec = page.locator('#acc-em2');
      await expect(sec.locator('.run-em-card')).toContainText('Lina Saleh');
      await expect(sec.locator('#acc-em2-add')).toHaveCount(0);
      await sec.getByRole('button', { name: 'Change' }).click();
      await expect(page.locator('#acc-em2-name')).toHaveValue('Lina Saleh');
      await expect(page.locator('#acc-em2-rel')).toHaveValue('friend');
      await sec.getByRole('button', { name: 'Cancel' }).click();
      await expect(sec.locator('.run-em-card')).toContainText('Lina Saleh');
      await expect(page.locator('#acc-em2-change')).toBeFocused();
      await sec.getByRole('button', { name: 'Change' }).click();
      await expect(page.locator('#acc-em2-name')).toBeFocused();
      await page.selectOption('#acc-em2-rel', 'colleague');
      await page.locator('#acc-em2-save').click();
      await expect.poll(() => sent.length).toBe(1);
      expect(sent[0]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_name: 'Lina Saleh', p_phone: '+966551230077', p_relation: 'colleague' });
      await expect(sec.locator('.run-em-card')).toContainText('Colleague');
      await sec.getByRole('button', { name: 'Remove' }).click();
      await expect.poll(() => sent.length).toBe(2);
      expect(sent[1]).toEqual({ p_id: 'c1', p_token: 'tok-spec', p_name: '', p_phone: '', p_relation: '' });
      await expect(sec.locator('.run-em-card')).toHaveCount(0);
      await expect(page.locator('#acc-em2-add')).toBeVisible();
      await expect(page.locator('#acc-em > .run-em-card')).toContainText('Nora Haddad');
    });

    test('the server’s refusal is said under the second contact, on the box it names', async ({ page }) => {
      await account(page, [{ ...first, ...noSecond }], {
        'rpc:customer_set_emergency2': { __rpcError: { status: 400, code: 'P0001', message: 'BAD_INPUT', details: 'em_same' } } });
      await page.locator('#acc-em2-add').click();
      await expect(page.locator('#acc-em2-name')).toBeFocused();
      await page.fill('#acc-em2-name', 'Lina Saleh');
      await page.fill('#acc-em2-phone', '0551230077');
      await page.selectOption('#acc-em2-rel', 'friend');
      await page.locator('#acc-em2-save').click();
      await expect(page.locator('#acc-em2-err')).toHaveText('The two emergency contacts can’t have the same number.');
      await expect(page.locator('#acc-em2-phone-err')).toBeVisible();
      await expect(page.locator('#acc-em2-save')).toBeEnabled();
      await expect(page.locator('#acc-em2 .run-em-card')).toHaveCount(0);
    });
  });

  // The correction page: grep @customer:fix runs these alone, @customer:account the whole file.
  test.describe('@customer:fix on the correction page', () => {
    async function rider(page: Page, flags: string[], em: Record<string, unknown>) {
      await stubSupabase(page, {
        sessions, queue_entries: [], 'rpc:my_bookings': [],
        'rpc:customer_profile': [{ id: 'c1', name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001' }],
        'rpc:customer_emergency': [em],
        'rpc:customer_fix_fields': flags,
        'rpc:customer_fix_save': [],
      });
      await loginCustomer(page, { id: 'c1', phone: '0500000001' });
      await page.goto('/');
      await waitForSb(page);
      await page.evaluate(`S.selEvent='none';selectEvent('jcc')`);
      await expect(page.locator('#fix-gate .fx-box')).toBeVisible();
    }
    const vals = (b: Record<string, unknown>[]) => b.map((x) => x.p_values);

    test('flagged: what the account holds, the first contact’s number refused, and the answer sent', async ({ page }) => {
      const sent = rpcBodies(page, 'customer_fix_save');
      await rider(page, ['emergency2'], { ...first, ...second });
      const it = page.locator('.fx-item[data-fx="emergency2"]');
      await expect(it.locator('.fx-lbl')).toHaveText('Second emergency contact');
      await expect(it.locator('.fx-was')).toContainText('Lina Saleh');
      await expect(it.locator('.fx-was')).toContainText('Friend');
      await expect(it.locator('.fx-none')).toBeVisible();
      await expect(page.locator('#fx-em2-name')).toHaveValue('');
      await page.fill('#fx-em2-name', 'Omar Saleh');
      await page.fill('#fx-em2-phone', '0551234567'); // the first contact's, on the account
      await page.selectOption('#fx-em2-rel', 'colleague');
      await page.click('#fx-save');
      await expect(it.locator('.pg-msg')).toHaveText('The two emergency contacts can’t have the same number.');
      await expect(page.locator('#fx-em2-name')).toBeFocused(); // the page's own move to the refused item, 80 ms on (_fixFocusErr): type after it
      expect(sent).toHaveLength(0);
      await page.fill('#fx-em2-phone', '0551230088');
      await page.click('#fx-save');
      await expect.poll(() => sent.length).toBe(1);
      expect(vals(sent)[0]).toEqual({ emergency2: { name: 'Omar Saleh', phone: '+966551230088', relation: 'colleague' } });
      await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
    });

    test('"I don\'t have one" clears it, and the page reads the contacts again', async ({ page }) => {
      const sent = rpcBodies(page, 'customer_fix_save');
      await rider(page, ['emergency2'], { ...first, ...second });
      await page.evaluate(`S._em={id:'c1',busy:false,v:{name:'Nora Haddad',phone:'+966551234567',rel:'sibling',name2:'Lina Saleh',phone2:'+966551230077',rel2:'friend',two:true},err:false,gone:false}`);
      const it = page.locator('.fx-item[data-fx="emergency2"]');
      await it.locator('.fx-none').click();
      await expect(it.locator('.fx-em')).toHaveClass(/\boff\b/);
      await expect(it.locator('.fx-none')).toHaveAttribute('aria-pressed', 'true');
      await page.click('#fx-save');
      await expect.poll(() => sent.length).toBe(1);
      expect(vals(sent)[0]).toEqual({ none: ['emergency2'] });
      await expect(page.locator('#fix-gate .fx-box')).toHaveCount(0);
      expect(await page.evaluate('S._em')).toBeNull();
    });

    test('both flagged and the first answered "I don\'t have one": the second is checked against no first number', async ({ page }) => {
      const sent = rpcBodies(page, 'customer_fix_save');
      await rider(page, ['emergency', 'emergency2'], { ...first, ...second });
      await expect(page.locator('.fx-item[data-fx="emergency"] .fx-was')).toContainText('Nora Haddad');
      await page.locator('.fx-item[data-fx="emergency"] .fx-none').click();
      await page.fill('#fx-em2-name', 'Nora Haddad');
      await page.fill('#fx-em2-phone', '0551234567'); // the number the first holds now: the first is going
      await page.selectOption('#fx-em2-rel', 'sibling');
      await page.click('#fx-save');
      await expect.poll(() => sent.length).toBe(1);
      expect(vals(sent)[0]).toEqual({ emergency2: { name: 'Nora Haddad', phone: '+966551234567', relation: 'sibling' }, none: ['emergency'] });
    });

    test('both flagged and answered: each is checked against the other as typed, not against what they replace', async ({ page }) => {
      const sent = rpcBodies(page, 'customer_fix_save');
      await rider(page, ['emergency', 'emergency2'], { ...first, ...second });
      await expect(page.locator('.fx-item[data-fx="emergency2"] .fx-was')).toContainText('Lina Saleh');
      await page.fill('#fx-em-name', 'Lina Saleh');
      await page.fill('#fx-em-phone', '0551230077'); // the second's number now: the second is answered again
      await page.selectOption('#fx-em-rel', 'friend');
      await page.fill('#fx-em2-name', 'Omar Saleh');
      await page.fill('#fx-em2-phone', '0551230077'); // the first as typed
      await page.selectOption('#fx-em2-rel', 'colleague');
      await page.click('#fx-save');
      await expect(page.locator('.fx-item[data-fx="emergency2"] .pg-msg')).toHaveText('The two emergency contacts can’t have the same number.');
      await expect(page.locator('.fx-item[data-fx="emergency"] .pg-msg')).toHaveCount(0);
      await expect(page.locator('#fx-em2-name')).toBeFocused();
      expect(sent).toHaveLength(0);
      await page.fill('#fx-em2-phone', '0551234567'); // the first's old number: it is being replaced
      await page.click('#fx-save');
      await expect.poll(() => sent.length).toBe(1);
      expect(vals(sent)[0]).toEqual({
        emergency: { name: 'Lina Saleh', phone: '+966551230077', relation: 'friend' },
        emergency2: { name: 'Omar Saleh', phone: '+966551234567', relation: 'colleague' },
      });
    });

    test('only the first flagged: it may not take the second contact’s number', async ({ page }) => {
      const sent = rpcBodies(page, 'customer_fix_save');
      await rider(page, ['emergency'], { ...first, ...second });
      await expect(page.locator('.fx-item[data-fx="emergency"] .fx-was')).toContainText('Nora Haddad');
      await expect(page.locator('.fx-item[data-fx="emergency2"]')).toHaveCount(0);
      await page.fill('#fx-em-name', 'Omar Saleh');
      await page.fill('#fx-em-phone', '0551230077'); // the second contact's
      await page.selectOption('#fx-em-rel', 'colleague');
      await page.click('#fx-save');
      await expect(page.locator('.fx-item[data-fx="emergency"] .pg-msg')).toHaveText('The two emergency contacts can’t have the same number.');
      await expect(page.locator('#fx-em-name')).toBeFocused();
      expect(sent).toHaveLength(0);
      await page.fill('#fx-em-phone', '0551230099');
      await page.click('#fx-save');
      await expect.poll(() => sent.length).toBe(1);
      expect(vals(sent)[0]).toEqual({ emergency: { name: 'Omar Saleh', phone: '+966551230099', relation: 'colleague' } });
    });
  });
});
