import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, waitForSb } from './helpers/supabase';

// The birthday week's confetti (the user, 2026-11-15: "in birthday week of the customer make the screen throw
// confetti from the top to the bottom of the page everytime he opens the website"; their picks: the three days
// before the birthday, the day and the three after, Saudi dates; a "Happy birthday, {name}!" line with it).
// _bdfx stays off under webdriver unless window.__bdfx asks for it, so the rest of the suite's riders never
// see it whatever the date. All traffic stubbed; invented data.

const NOW = new Date('2026-11-15T12:00:00+03:00'); // a Sunday in Riyadh
const rider = (birth: string | null) => ({ id: 'c1', name: 'Rana Rider', email: 'rana@example.test', phone: '+966500000021', height: 170, birth_date: birth, session_token: 'tok' });

async function open(page: Page, birth: string | null) {
  await page.clock.setFixedTime(NOW);
  await stubSupabase(page, { sessions: [], queue_entries: [] });
  await page.addInitScript((c) => {
    (window as unknown as { __bdfx: boolean }).__bdfx = true;
    localStorage.setItem('cq_session', JSON.stringify(c));
  }, rider(birth));
  await page.goto('/');
  await waitForSb(page);
}

test.describe('@customer:birthday the birthday week', () => {
  test('the week is the three days either side of the birthday, across a year end and on 29 February', async ({ page }) => {
    await open(page, null);
    const on = (birth: string, today: string) => page.evaluate(([b, d]) => (window as unknown as { _bdfxOn: (b: string, d: string) => boolean })._bdfxOn(b, d), [birth, today]);
    expect(await on('1990-11-18', '2026-11-15')).toBe(true); // three days before
    expect(await on('1990-11-19', '2026-11-15')).toBe(false); // four days before
    expect(await on('1990-11-12', '2026-11-15')).toBe(true); // three days after
    expect(await on('1990-11-11', '2026-11-15')).toBe(false); // four days after
    expect(await on('1990-11-15', '2026-11-15')).toBe(true); // the day
    expect(await on('1990-01-02', '2026-12-30')).toBe(true); // next year's birthday
    expect(await on('1990-12-30', '2027-01-02')).toBe(true); // last year's birthday
    expect(await on('2000-02-29', '2027-03-03')).toBe(true); // kept on 28 February in a common year
    expect(await on('2000-02-29', '2027-03-04')).toBe(false);
    expect(await on('', '2026-11-15')).toBe(false);
  });

  test('opening the app in the week: confetti from the top and the line, gone in seconds, taps go through', async ({ page }) => {
    await open(page, '1994-11-17');
    const hi = page.locator('.bdfx-hi');
    await expect(hi).toHaveText('Happy birthday, Rana!');
    await expect(hi).toHaveAttribute('role', 'status');
    const cv = page.locator('canvas.bdfx-cv');
    await expect(cv).toHaveCount(1);
    expect(await cv.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    expect(await cv.evaluate((el) => { const r = el.getBoundingClientRect(); return r.top === 0 && r.height === innerHeight && r.width === innerWidth; })).toBe(true);
    expect(await hi.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
    // a second call on the same open plays nothing more
    await page.evaluate('_bdfx()');
    await expect(page.locator('.bdfx-hi')).toHaveCount(1);
    await expect(cv).toHaveCount(0, { timeout: 12000 });
    await expect(hi).toHaveCount(0, { timeout: 4000 });
  });

  test('in Arabic, the line is the team\'s greeting', async ({ page }) => {
    await open(page, '1994-11-15');
    await page.evaluate("setLang('ar')");
    await expect.poll(() => page.evaluate("t('bdfxHi')"), { timeout: 10000 }).toBe('كل عام وأنت بخير يا {0}!');
    await page.evaluate("_bdfxFor='';document.querySelectorAll('.bdfx-hi,.bdfx-cv').forEach(e=>e.remove());_bdfx()");
    await expect(page.locator('.bdfx-hi')).toHaveText('كل عام وأنت بخير يا Rana!');
  });

  test('outside the week, without a birth date and on a staff device: nothing', async ({ page }) => {
    await open(page, '1994-11-19');
    await page.waitForTimeout(400);
    await expect(page.locator('.bdfx-hi, .bdfx-cv')).toHaveCount(0);
    await page.evaluate("_bdfxFor='';S.loggedIn={...S.loggedIn,birth_date:null};_bdfx()");
    await expect(page.locator('.bdfx-hi, .bdfx-cv')).toHaveCount(0);
    await page.evaluate("_bdfxFor='';S.loggedIn={...S.loggedIn,birth_date:'1994-11-15'};localStorage.setItem('cq_staff','1');_bdfx()");
    await expect(page.locator('.bdfx-hi, .bdfx-cv')).toHaveCount(0);
  });

  test('with reduced motion: the line alone, standing still, then gone', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page, '1994-11-14');
    const hi = page.locator('.bdfx-hi');
    await expect(hi).toHaveText('Happy birthday, Rana!');
    await expect(page.locator('.bdfx-cv')).toHaveCount(0);
    await page.waitForTimeout(1000);
    await expect(hi).toBeVisible();
    expect(await hi.evaluate((el) => getComputedStyle(el).opacity)).toBe('1');
    await expect(hi).toHaveCount(0, { timeout: 6000 });
  });

  test('signing in on the page in the week plays it', async ({ page }) => {
    await page.clock.setFixedTime(NOW);
    await stubSupabase(page, { sessions: [], queue_entries: [], 'rpc:customer_login': [rider('1994-11-16')] });
    await page.addInitScript(() => { (window as unknown as { __bdfx: boolean }).__bdfx = true; });
    await page.goto('/');
    await waitForSb(page);
    await expect(page.locator('.bdfx-hi')).toHaveCount(0);
    await page.evaluate('openAuthModal()');
    await page.fill('#a-identifier', 'rana@example.test');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    await expect(page.locator('.bdfx-hi')).toHaveText('Happy birthday, Rana!');
  });

  test('brought back after half an hour away, it plays again', async ({ page }) => {
    await open(page, '1994-11-15');
    await expect(page.locator('.bdfx-hi')).toHaveCount(1);
    await page.evaluate("document.querySelectorAll('.bdfx-hi,.bdfx-cv').forEach(e=>e.remove())");
    await page.evaluate('_bdfxAway=Date.now()-31*60*1000;document.dispatchEvent(new Event("visibilitychange"))');
    await expect(page.locator('.bdfx-hi')).toHaveCount(1);
    await page.evaluate("document.querySelectorAll('.bdfx-hi,.bdfx-cv').forEach(e=>e.remove())");
    await page.evaluate('_bdfxAway=Date.now()-5*60*1000;document.dispatchEvent(new Event("visibilitychange"))');
    await page.waitForTimeout(300);
    await expect(page.locator('.bdfx-hi')).toHaveCount(0);
  });
});
