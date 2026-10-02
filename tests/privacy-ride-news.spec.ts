import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// The Privacy Notice, its required confirmation, and ride news (Personal Data Protection Law,
// Arts. 12-13 and 25). The notice is readable wherever we collect data: the footer, the
// sign-up forms and /?privacy. Sign-up needs "I have read the Privacy Notice" ticked; ride
// news - promotional and awareness messages - is a separate, optional box that starts empty.
// Accounts from before either existed answer both, once, in a popup only an answer closes.
// Staff can switch ride news OFF (a rider's STOP), never on.

const JSON_HDR = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
const VERSION = '2026-10-02';

/** Answers an RPC and records every body sent to it. */
async function captureRpc(page: Page, fn: string, answer: (body: Record<string, unknown>) => unknown) {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}`), async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    calls.push(body);
    await route.fulfill({ status: 200, headers: JSON_HDR, body: JSON.stringify(answer(body)) });
  });
  return calls;
}

/** A stand-in for customer_consents: keeps the two answers and stamps them like the server. */
function consentsServer(start: { privacy_version?: string | null; ride_news?: boolean; ride_news_at?: string | null } = {}) {
  const st = { privacy_version: null as string | null, privacy_at: null as string | null, ride_news: false, ride_news_at: null as string | null, ...start };
  return (b: Record<string, unknown>) => {
    if (typeof b.p_privacy === 'string') { st.privacy_version = b.p_privacy; st.privacy_at = '2026-09-22T10:00:00Z'; }
    if (b.p_ride_news === true || b.p_ride_news === false) { st.ride_news = b.p_ride_news; st.ride_news_at = st.ride_news_at || '2026-09-22T10:00:00Z'; }
    return { ...st };
  };
}

test.describe('the Privacy Notice', () => {
  test('the footer opens it, with what we collect and where it goes', async ({ page }) => {
    await stubSupabase(page, {});
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('showPrivacyNotice()');
    const box = page.locator('#privacy-backdrop .pv-box');
    await expect(box).toBeVisible();
    await expect(box.locator('#pv-title')).toHaveText('Privacy Notice');
    await expect(box).toContainText('What we collect, and whether you must give it');
    await expect(box).toContainText('Frankfurt, Germany');
    await expect(box).toContainText('We will reply within 30 days');
    // Birth date and nationality: optional until the eighth booking, and before any booking for community members
    const nat = box.locator('tr', { hasText: 'Nationality' });
    await expect(nat).toContainText('Community members: required before booking');
    await expect(nat).toContainText('Which nationality you give never decides who can book.');
    await expect(box.locator('tr', { hasText: 'Date of birth' })).toContainText('Optional for your first eight bookings, then required.');
    await expect(box).toContainText('Community members can’t book until they add them.');
    await expect(box.locator('.pv-note')).toHaveCount(0); // English is a full version
    await page.keyboard.press('Escape');
    await expect(page.locator('#privacy-backdrop')).toHaveCount(0);
    await expect(page.locator('#mf-privacy')).toHaveText('Privacy Notice');
  });

  test('/?privacy opens it on arrival', async ({ page }) => {
    await stubSupabase(page, {});
    await page.goto('/?privacy');
    await waitForSb(page);
    await expect(page.locator('#privacy-backdrop .pv-box')).toBeVisible();
  });

  test('Arabic reads the Arabic text; other languages read the English under a note', async ({ page }) => {
    await stubSupabase(page, {});
    await page.goto('/?lang=ar');
    await waitForSb(page);
    await page.evaluate('showPrivacyNotice()');
    await expect(page.locator('#pv-title')).toHaveText('إشعار الخصوصية');
    await expect(page.locator('.pv-body')).toContainText('من نحن');
    await expect(page.locator('.pv-body')).toContainText('فرانكفورت، ألمانيا');
    await expect(page.locator('.pv-body')).toContainText('أعضاء المجتمع: إلزامي قبل الحجز');
    await page.evaluate('closePrivacyNotice()');

    await page.goto('/?lang=fr');
    await waitForSb(page);
    await page.evaluate('showPrivacyNotice()');
    await expect(page.locator('#pv-title')).toHaveText('Avis de confidentialité');
    await expect(page.locator('.pv-note')).toHaveText('Cet avis est disponible en anglais et en arabe.');
    await expect(page.locator('.pv-body')).toHaveAttribute('dir', 'ltr');
    await expect(page.locator('.pv-body')).toContainText('Who we are');
  });
});

test.describe('sign-up: the confirmation is required, ride news is not', () => {
  async function fillSignup(page: Page) {
    await page.evaluate('openAuthModal();switchAuthMode("signup")');
    await page.fill('#a-first', 'Faisal');
    await page.fill('#a-last', 'Babalghoum');
    await page.evaluate('setSignupGender("male");S.signupHeard="invited"');
    await page.fill('#a-email', 'faisal@example.com');
    await page.fill('#a-phone', '0508566560');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.fill('#a-pwd2', 'Zq8xTselah');
    await page.fill('#a-height', '175');
  }

  test('both boxes start empty; the notice link opens the notice without ticking the box', async ({ page }) => {
    await stubSupabase(page, {});
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate('openAuthModal();switchAuthMode("signup")');
    await expect(page.locator('#su-ack')).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('#su-ack')).toHaveAttribute('aria-required', 'true');
    await expect(page.locator('#su-news')).toHaveAttribute('aria-checked', 'false');
    await page.locator('#su-ack .pv-link').click();
    await expect(page.locator('#privacy-backdrop .pv-box')).toBeVisible(); // above the form
    await page.keyboard.press('Escape');
    await expect(page.locator('#su-ack')).toHaveAttribute('aria-checked', 'false');
  });

  test('without the confirmation nothing is sent, and the rider is told why', async ({ page }) => {
    await stubSupabase(page, {});
    const signup = await captureRpc(page, 'customer_signup', () => [{ session_token: 'tok-new' }]);
    await page.goto('/');
    await waitForSb(page);
    await fillSignup(page);
    await page.evaluate('doSignup()');
    await expect(page.locator('#auth-err')).toHaveText('Please confirm you’ve read the Privacy Notice.');
    expect(signup.length).toBe(0);
  });

  test('confirmed and ride news ticked: both are recorded the moment the account exists', async ({ page }) => {
    await stubSupabase(page, {});
    const signup = await captureRpc(page, 'customer_signup', () => [{ session_token: 'tok-new' }]);
    const consents = await captureRpc(page, 'customer_consents', consentsServer());
    await page.goto('/');
    await waitForSb(page);
    await fillSignup(page);
    await page.locator('#su-ack-box').click();
    await page.locator('#su-news').click();
    await page.evaluate('doSignup()');
    await expect.poll(() => consents.length).toBe(1);
    expect(signup.length).toBe(1);
    expect(consents[0]).toMatchObject({ p_id: signup[0].p_id, p_token: 'tok-new', p_privacy: VERSION, p_ride_news: true });
  });

  test('confirmed, ride news left empty: a recorded no, and the new account is never asked', async ({ page }) => {
    await stubSupabase(page, {});
    const signup = await captureRpc(page, 'customer_signup', () => [{ session_token: 'tok-new' }]);
    const consents = await captureRpc(page, 'customer_consents', consentsServer());
    await page.goto('/');
    await waitForSb(page);
    await fillSignup(page);
    await page.locator('#su-ack-box').click();
    await page.evaluate('doSignup()');
    await expect.poll(() => consents.length).toBe(1);
    expect(consents[0]).toMatchObject({ p_id: signup[0].p_id, p_privacy: VERSION, p_ride_news: false });
    await page.waitForTimeout(300);
    await expect(page.locator('#rn-ask')).toHaveCount(0);
  });
});

test.describe('ride news in the profile', () => {
  test('the rider switches it on and off, and each change is sent', async ({ page }) => {
    await stubSupabase(page, {});
    const consents = await captureRpc(page, 'customer_consents', consentsServer({ privacy_version: VERSION, ride_news_at: '2026-09-01T10:00:00Z' }));
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    const card = page.locator('#acc-ride-news');
    await expect(card).toContainText('You’re not getting ride news.');
    await card.locator('#acc-rn-btn').click();
    await expect(page.locator('#acc-rn-state')).toHaveText('You’re getting ride news.');
    await page.locator('#acc-rn-btn').click();
    await expect(page.locator('#acc-rn-state')).toHaveText('You’re not getting ride news.');
    expect(consents.map((b) => b.p_ride_news)).toEqual([null, true, false]);
    expect(consents.every((b) => b.p_privacy === null && b.p_token === 'tok-spec')).toBe(true);
  });

  test('before the migration the card is not shown at all', async ({ page }) => {
    await stubSupabase(page, { 'rpc:customer_consents': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function' } } });
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await page.waitForFunction('S._rnUnavailable==="c1"');
    await expect(page.locator('#acc-ride-news')).toHaveCount(0);
    await expect(page.locator('#rn-ask')).toHaveCount(0);
  });
});

// Every account made before the notice and ride news existed answers both on its next
// visit, in a popup only an answer closes; "No ride news" is as easy as yes.
test.describe('the popup for existing accounts', () => {
  async function arrive(page: Page, answer: (b: Record<string, unknown>) => unknown) {
    await stubSupabase(page, {});
    const calls = await captureRpc(page, 'customer_consents', answer);
    await loginCustomer(page);
    await page.goto('/');
    await waitForSb(page);
    return calls;
  }

  test('never asked: the confirmation and ride news together, and nothing but an answer closes it', async ({ page }) => {
    const calls = await arrive(page, consentsServer());
    const ask = page.locator('#rn-ask');
    await expect(ask.locator('#rn-ask-title')).toHaveText('Before you continue');
    await page.keyboard.press('Escape');
    await page.mouse.click(5, 5); // the backdrop
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'No ride news' }).click(); // not confirmed yet
    // the reminder sits right under the box, which is outlined - not at the foot of the sheet
    await expect(page.locator('#rn-ask-ackerr')).toHaveText('Please confirm you’ve read the Privacy Notice.');
    expect(await page.evaluate(`document.getElementById('cs-ack').nextElementSibling.id`)).toBe('rn-ask-ackerr');
    await expect(page.locator('#cs-ack')).toHaveCSS('outline-style', 'solid');
    expect(calls.length).toBe(1); // only the read
    // the words tick it too: the label holds no link, so a tap on them never opens the notice
    await expect(page.locator('#cs-ack .pv-link')).toHaveCount(0);
    await page.locator('#cs-ack-lbl').click();
    await expect(page.locator('#cs-ack')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#rn-ask-ackerr')).toHaveText('');
    await expect(page.locator('#privacy-backdrop')).toHaveCount(0);
    await ask.getByRole('button', { name: 'No ride news' }).click();
    await expect(ask).toHaveCount(0);
    expect(calls[1]).toMatchObject({ p_privacy: VERSION, p_ride_news: false });

    await page.reload(); // answered: never asked again
    await waitForSb(page);
    await expect.poll(() => calls.length).toBe(3);
    await page.waitForTimeout(300);
    await expect(page.locator('#rn-ask')).toHaveCount(0);
  });

  test('yes is saved as yes', async ({ page }) => {
    const calls = await arrive(page, consentsServer());
    await page.locator('#cs-ack-box').click();
    await page.locator('#rn-ask').getByRole('button', { name: 'Yes, send me ride news' }).click();
    await expect(page.locator('#rn-ask')).toHaveCount(0);
    expect(calls[1]).toMatchObject({ p_privacy: VERSION, p_ride_news: true });
    expect(await page.evaluate('S.loggedIn.ride_news')).toBe(true);
  });

  test('a newer notice asks only for the confirmation, with Continue', async ({ page }) => {
    const calls = await arrive(page, consentsServer({ privacy_version: '2026-01-01', ride_news_at: '2026-09-01T10:00:00Z' }));
    const ask = page.locator('#rn-ask');
    await expect(ask.getByRole('button', { name: 'No ride news' })).toHaveCount(0);
    await page.locator('#cs-ack-box').click();
    await ask.getByRole('button', { name: 'Continue' }).click();
    await expect(ask).toHaveCount(0);
    expect(calls[1]).toMatchObject({ p_privacy: VERSION, p_ride_news: null });
  });

  test('confirmed but never asked about ride news: only that question', async ({ page }) => {
    const calls = await arrive(page, consentsServer({ privacy_version: VERSION }));
    const ask = page.locator('#rn-ask');
    await expect(ask.locator('#rn-ask-title')).toHaveText('Ride news?');
    await expect(page.locator('#cs-ack')).toHaveCount(0);
    await ask.getByRole('button', { name: 'No ride news' }).click();
    await expect(ask).toHaveCount(0);
    expect(calls[1]).toMatchObject({ p_privacy: null, p_ride_news: false });
  });

  test('both answered: not asked', async ({ page }) => {
    await arrive(page, consentsServer({ privacy_version: VERSION, ride_news_at: '2026-09-01T10:00:00Z' }));
    await page.waitForFunction('S._rnFetchedFor==="c1"&&S.loggedIn.ride_news===false');
    await page.waitForTimeout(300);
    await expect(page.locator('#rn-ask')).toHaveCount(0);
  });

  test('the notice opens over it without ticking the box, and closing it leaves the question', async ({ page }) => {
    await arrive(page, consentsServer());
    await page.locator('#rn-ask .pv-link').click(); // the link in the sentence above the box
    await expect(page.locator('#privacy-backdrop .pv-box')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#privacy-backdrop')).toHaveCount(0);
    await expect(page.locator('#rn-ask')).toBeVisible();
    await expect(page.locator('#cs-ack')).toHaveAttribute('aria-checked', 'false');
  });

  test('a save that keeps failing does not lock the site', async ({ page }) => {
    await arrive(page, (b) => (b.p_ride_news === null && b.p_privacy === null ? { privacy_version: null, privacy_at: null, ride_news: false, ride_news_at: null } : null));
    const ask = page.locator('#rn-ask');
    await page.locator('#cs-ack-box').click();
    await ask.getByRole('button', { name: 'No ride news' }).click();
    await expect(page.locator('#rn-ask-err')).not.toBeEmpty(); // first failure: asked to try again
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'No ride news' }).click();
    await expect(ask).toHaveCount(0); // second: let through, asked again next visit
  });
});

test.describe('ride news for staff', () => {
  const customers = [
    { id: 'y1', name: 'Yes One', email: 'y1@x.com', phone: '+966500000011', created_at: '2026-09-01', gender: 'male', ride_news: true, ride_news_at: '2026-09-20T09:00:00Z' },
    { id: 'n1', name: 'No One', email: 'n1@x.com', phone: '+966500000012', created_at: '2026-09-02', gender: 'female', ride_news: false, ride_news_at: null },
    { id: 'n2', name: 'Never Asked', email: 'n2@x.com', phone: '+966500000013', created_at: '2026-09-03', gender: 'male' },
  ];

  test('the Accounts report lists only riders who said yes, when asked to', async ({ page }) => {
    await stubSupabase(page, { customers });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getCustomers().length===3');
    const counts = await page.evaluate(`(() => {
      const o = _accOpts(), n = {};
      for (const f of ['all', 'yes', 'no']) { o.fRideNews = f; n[f] = _accRows().map(r => r.c.id).sort().join(','); }
      o.fRideNews = 'all';
      return n;
    })()`);
    expect(counts).toEqual({ all: 'n1,n2,y1', yes: 'y1', no: 'n1,n2' });
  });

  test('staff can turn it off for a rider who replied STOP, and cannot turn it on', async ({ page }) => {
    await stubSupabase(page, { customers });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction('getCustomers().length===3');
    const patches: Record<string, unknown>[] = [];
    page.on('request', (r) => {
      if (r.method() === 'PATCH' && /\/rest\/v1\/customers/.test(r.url())) patches.push(r.postDataJSON());
    });
    await page.evaluate(`showEditCustomerModal('y1')`);
    const row = page.locator('#cf-rn');
    await expect(row).toContainText('Agreed on');
    await row.getByRole('button', { name: 'Turn off' }).click();
    await expect(row).toContainText('Not agreed');
    await expect(row.getByRole('button')).toHaveCount(0);
    expect(patches.length).toBe(1);
    expect(patches[0]).toMatchObject({ ride_news: false });

    await page.evaluate(`showEditCustomerModal('n1')`);
    await expect(page.locator('#cf-rn')).toContainText('Not agreed');
    await expect(page.locator('#cf-rn').getByRole('button')).toHaveCount(0);
  });
});
