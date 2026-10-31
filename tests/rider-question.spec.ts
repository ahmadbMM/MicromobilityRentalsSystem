import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb } from './helpers/supabase';

// A question staff put on one rider's account (rider_questions, 20261101030000): the rider is asked it in a
// centred pop-up with a box for the answer. Send saves it once; Later lets this visit through.

const Q = 'What did the duck tell the cat when they met each other?';
const answered = { privacy_version: '2099-01-01', privacy_at: '2026-09-22T10:00:00Z', ride_news: false, ride_news_at: '2026-09-22T10:00:00Z' };

/** Every call to customer_question_answer, answered with `reply` (an object with status for a failure). */
async function captureAnswers(page: Page, reply: unknown = true) {
  const calls: Record<string, unknown>[] = [];
  await page.route(/\/rest\/v1\/rpc\/customer_question_answer/, async (route) => {
    if (route.request().method() === 'OPTIONS') return route.fallback();
    calls.push(JSON.parse(route.request().postData() || '{}'));
    if (reply && typeof reply === 'object' && 'status' in reply) return route.fulfill({ status: (reply as { status: number }).status, body: '{"message":"down"}', headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(reply) });
  });
  return calls;
}

async function boot(page: Page, questions: unknown, reply: unknown = true) {
  await stubSupabase(page, { 'rpc:customer_consents': answered, 'rpc:customer_questions': questions });
  const calls = await captureAnswers(page, reply); // after the stub: the newest route answers first
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  return calls;
}

test.describe('@customer a question for one rider', () => {
  test('pops up with the question and a box; Send saves the typed answer and closes it', async ({ page }) => {
    const calls = await boot(page, [{ id: 7, question: Q }]);
    const box = page.locator('#rider-q .rdq-box');
    await expect(box).toBeVisible();
    await expect(box.locator('#rdq-title')).toHaveText('A question for you');
    await expect(box.locator('#rdq-q')).toHaveText(Q);
    const a = box.locator('#rdq-a');
    await expect(a).toBeFocused();
    // an empty answer is not sent
    await box.locator('.pg-btn').click();
    await expect(box.locator('#rdq-err')).toHaveText('Type your answer first.');
    await expect(a).toHaveAttribute('aria-invalid', 'true');
    expect(calls).toHaveLength(0);
    await a.fill('  Quack, nice to meet you  ');
    await expect(box.locator('#rdq-err')).toHaveCount(0);
    await box.locator('.pg-btn').click();
    await expect(page.locator('#rider-q')).toBeHidden();
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_qid: 7, p_answer: 'Quack, nice to meet you' }]);
    await expect(page.locator('.toast').last()).toContainText('Thank you, your answer is sent.');
    // answered: not asked again on this visit
    await page.evaluate('_forceRatingPrompt()');
    await expect(page.locator('#rider-q')).toBeHidden();
  });

  test('Later closes it without sending; it is not asked again on the same visit', async ({ page }) => {
    const calls = await boot(page, [{ id: 7, question: Q }]);
    const box = page.locator('#rider-q .rdq-box');
    await expect(box).toBeVisible();
    await box.locator('.gate-out').click();
    await expect(page.locator('#rider-q')).toBeHidden();
    await page.evaluate('_forceRatingPrompt()');
    await expect(page.locator('#rider-q')).toBeHidden();
    expect(calls).toHaveLength(0);
  });

  test('a failed save keeps the pop-up and the typed answer, and says so', async ({ page }) => {
    await boot(page, [{ id: 7, question: Q }], { status: 500 });
    const box = page.locator('#rider-q .rdq-box');
    await box.locator('#rdq-a').fill('Quack');
    await box.locator('.pg-btn').click();
    await expect(box.locator('.pg-net')).toBeVisible();
    await expect(box.locator('#rdq-a')).toHaveValue('Quack');
    await expect(box.locator('.pg-btn')).toBeEnabled();
  });

  test('no open question, or a database without the function: no pop-up', async ({ page }) => {
    await boot(page, []);
    await page.waitForTimeout(300);
    await expect(page.locator('#rider-q')).toBeHidden();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await boot(page, { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function' } });
    await page.waitForTimeout(300);
    await expect(page.locator('#rider-q')).toBeHidden();
  });
});
