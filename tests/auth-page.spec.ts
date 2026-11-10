import { test, expect } from '@playwright/test';
import { stubSupabase, waitForSb, loadStaffHalf } from './helpers/supabase';

// Deep coverage of the customer sign-in / sign-up modal: validation, Enter-to-submit,
// phone normalization into the RPCs, double-submit guards, and Google/Apple being sign-in only.

const customer = { id: 'c9', name: 'Test User', email: 'x@y.com', phone: '+966508727012', height: 170, type_preference: 'Any', created_at: '2026-01-01', session_token: 'tok9' };

async function boot(page: import('@playwright/test').Page, fixtures = {}) {
  await stubSupabase(page, fixtures);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate('openAuthModal()');
}

// Capture RPC bodies for a given function name (registered after stubSupabase → takes precedence).
async function captureRpc(page: import('@playwright/test').Page, fn: string, result: unknown) {
  const calls: Record<string, unknown>[] = [];
  await page.route(new RegExp(`/rest/v1/rpc/${fn}`), async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(result) });
  });
  return calls;
}

test.describe('login', () => {
  test('validates inputs, then Enter submits and logs in', async ({ page }) => {
    await boot(page, { 'rpc:customer_login': [customer] });
    await page.evaluate('doLogin()');
    await expect(page.locator('#auth-err')).toContainText(/email|phone|البريد/i);
    await page.fill('#a-identifier', 'x@y.com');
    await page.evaluate('doLogin()');
    await expect(page.locator('#auth-err')).not.toBeEmpty(); // password required
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.press('#a-pwd', 'Enter'); // Enter must submit
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(await page.evaluate('S.loggedIn && S.loggedIn.session_token')).toBe('tok9');
  });

  test('a local-format phone (05…) is normalized to +966 for the RPC', async ({ page }) => {
    await boot(page);
    const calls = await captureRpc(page, 'customer_login', [customer]);
    await page.fill('#a-identifier', '0508 727 012');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(calls[0].p_identifier).toBe('+966508727012'); // exact-digit SQL match requires this
  });

  test('a LOCKED throttle error shows the lockout message, not invalid-credentials', async ({ page }) => {
    await boot(page);
    await page.route(/\/rest\/v1\/rpc\/customer_login/, (r) => r.fulfill({
      status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'P0001', message: 'LOCKED' }),
    }));
    await page.fill('#a-identifier', 'x@y.com');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    const err = await page.locator('#auth-err').textContent();
    expect(err).toMatch(/too many|محاولات|wait|دقيقة|minutes/i);
  });
});

test.describe('signup', () => {
  async function fillSignup(page: import('@playwright/test').Page) {
    await page.evaluate('switchAuthMode("signup")');
    await page.fill('#a-first', 'Faisal');
    await page.fill('#a-last', 'Babalghoum');
    await page.evaluate('setSignupGender("male")');
    await page.fill('#a-email', 'faisal@example.com');
    await page.fill('#a-phone', '0508566560');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.fill('#a-height', '175');
    await page.fill('#su-em-name', 'Sara Ahmed'); await page.fill('#su-em-phone', '511122233'); await page.selectOption('#su-em-rel', 'sibling'); // the required emergency contact
    await page.locator('#su-ack-box').click(); // the Privacy Notice confirmation is required
  }

  test('validation cascade fires in order', async ({ page }) => {
    await boot(page);
    await page.evaluate('switchAuthMode("signup")');
    const errAfter = async () => { await page.evaluate('S.signupAck=true;doSignup()'); return (await page.locator('#auth-err').textContent()) || ''; };
    expect(await errAfter()).toBeTruthy();                       // name
    await page.fill('#a-first', 'One');                          // first name only → still name error (last required)
    expect(await errAfter()).toBeTruthy();
    await page.fill('#a-first', 'Faisal');
    await page.fill('#a-last', 'Babalghoum');
    expect(await errAfter()).toBeTruthy();                       // gender
    await page.evaluate('setSignupGender("male")');
    expect(await errAfter()).toBeTruthy();                       // email
    await page.fill('#a-email', 'bad-email');
    expect(await errAfter()).toBeTruthy();                       // email format
    await page.fill('#a-email', 'faisal@example.com');
    expect(await errAfter()).toBeTruthy();                       // phone
    await page.fill('#a-phone', '0508566560');
    expect(await errAfter()).toContain('Use at least 8 characters.'); // password
    // The rider password rule (2026-11-11): 8 or more characters and not a common one, no upper-case letter
    // or digit asked, and one box with show/hide (no second box to type it again).
    await expect(page.locator('#a-pwd2')).toHaveCount(0);
    await page.fill('#a-pwd', 'Password1');
    expect(await errAfter()).toContain('This password is too easy to guess. Choose another.'); // common, whatever its capitals
    await page.fill('#a-pwd', 'aaaaaaaaaa');
    expect(await errAfter()).toContain('too easy to guess');      // one character over and over
    await page.fill('#a-pwd', 'corniche ride');
    expect(await errAfter()).not.toMatch(/password|characters/i); // on to the emergency contact
    const eye = page.locator('.auth-field .pw-wrap .pw-eye');
    await eye.click();
    await expect(page.locator('#a-pwd')).toHaveAttribute('type', 'text');
    await eye.click();
    await expect(page.locator('#a-pwd')).toHaveAttribute('type', 'password');
  });

  test('a password the server still refuses says why', async ({ page }) => {
    // A database without 20261111130000 keeps the old rule (an upper-case letter and a digit); one with it
    // refuses a common password the app does not know of. Either answers WEAK_PASSWORD.
    await boot(page);
    await page.route(/\/rest\/v1\/rpc\/customer_signup/, (route) => route.fulfill({ status: 400, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: '22023', message: 'WEAK_PASSWORD', details: null, hint: null }) }));
    await fillSignup(page);
    await page.fill('#a-pwd', 'corniche ride');
    await page.locator('.auth-submit').click();
    await expect(page.locator('#auth-err')).toContainText('Use at least 8 characters, with an upper-case letter and a number.');
    await page.fill('#a-pwd', 'Corniche ride 9');
    await page.locator('.auth-submit').click();
    await expect(page.locator('#auth-err')).toContainText('This password is too easy to guess. Choose another.');
  });

  test('successful signup sends a normalized phone and keeps the session token', async ({ page }) => {
    await boot(page);
    const calls = await captureRpc(page, 'customer_signup', [{ session_token: 'tok-new' }]);
    await fillSignup(page);
    await page.press('#a-height', 'Enter'); // Enter submits signup too
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(calls.length).toBe(1);
    expect(calls[0].p_phone).toBe('+966508566560');
    expect(calls[0].p_gender).toBe('male');
    expect(calls[0]).not.toHaveProperty('p_heard_from'); // the app's sign-up no longer asks how they heard of us (2026-09-28)
    expect(await page.evaluate('S.loggedIn.session_token')).toBe('tok-new');
  });

  test('double-submit fires exactly one signup RPC', async ({ page }) => {
    await boot(page);
    const calls = await captureRpc(page, 'customer_signup', [{ session_token: 't' }]);
    await fillSignup(page);
    await page.evaluate('S.signupAck=true;doSignup();doSignup();doSignup()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(calls.length).toBe(1);
  });

  test('a duplicate email maps to the email-exists error', async ({ page }) => {
    await boot(page);
    await page.route(/\/rest\/v1\/rpc\/customer_signup/, (r) => r.fulfill({
      status: 409, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint' }),
    }));
    await fillSignup(page);
    await page.evaluate('S.signupAck=true;doSignup()');
    const err = await page.locator('#auth-err').textContent();
    expect(err).toMatch(/already|مسجل|exists/i);
  });
});

// No self-service reset (the owner, 2026-10-07): an email and a phone number were enough to take an
// account over. Forgot password sends the rider to WhatsApp; staff send a temporary password.
test.describe('forgot password', () => {
  test('sends the rider to WhatsApp for a temporary password, and asks the server nothing', async ({ page }) => {
    await boot(page);
    const calls = await captureRpc(page, 'customer_reset', [customer]);
    await page.evaluate('switchAuthMode("forgot")');
    const wa = page.locator('#auth-modal a[href^="https://wa.me/966579543997?"]');
    await expect(wa).toBeVisible();
    expect(decodeURIComponent((await wa.getAttribute('href'))!)).toContain('forgot my password');
    await expect(page.locator('#auth-modal')).toContainText('temporary password');
    await expect(page.locator('#a-forgot-email, #a-forgot-phone, #a-reset-pwd')).toHaveCount(0);
    expect(calls).toHaveLength(0);
    expect(await page.evaluate('typeof doResetPassword')).toBe('undefined');
  });
});

// No Google or Apple sign-in (the owner, 2026-11-09: "i don't want to have any google or apple sign in
// anymore"): neither page offers them, and what drove them is gone.
test.describe('No Google or Apple sign-in', () => {
  test('neither Sign in nor Create account offers Google or Apple', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#a-identifier')).toBeVisible();
    for (const mode of ['login', 'signup']) {
      await page.evaluate(`switchAuthMode(${JSON.stringify(mode)})`);
      await expect(page.locator('#auth-modal')).not.toContainText(/Continue with|Google or Apple|Google and Apple/);
      await expect(page.locator('#auth-modal .auth-or, #auth-modal .cu-iab-note, #auth-modal svg[viewBox="0 0 18 18"]')).toHaveCount(0);
    }
    expect(await page.evaluate('[typeof signInGoogle, typeof signInApple, typeof handleGoogleReturn, typeof _oauthNoAccount]'))
      .toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  });
});

test('the auth modal renders every mode in Arabic with zero console errors', async ({ page }) => {
  const errs: string[] = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await stubSupabase(page);
  await page.addInitScript(() => localStorage.setItem('cq_lang', 'ar'));
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`
    openAuthModal();
    switchAuthMode('signup');
    switchAuthMode('forgot');
    S.forgotStep=2; renderAuthModal();
    switchAuthMode('signup'); S.signupAck=true; renderAuthModal();
  `);
  expect(errs, errs.join('\n')).toEqual([]);
});

test.describe('in-app browsers (Instagram/WhatsApp webviews)', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 300.0.0.0' });

  test('the sign-in page is the ordinary one: no Google guidance to open a browser', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#a-identifier')).toBeVisible();
    await expect(page.locator('#auth-modal')).not.toContainText(/Open in browser|الفتح في المتصفح/);
    // email signup stays fully available
    await page.evaluate('switchAuthMode("signup")');
    await expect(page.locator('#a-email')).toBeVisible();
  });
});

test.describe('remaining hardening', () => {
  test('a stray trunk zero after the country code is dropped (+9660… → +966…)', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`_normPhone('+9660508727012','+966')`)).toBe('+966508727012');
    expect(await page.evaluate(`_normPhone('+966508727012','+966')`)).toBe('+966508727012'); // untouched
  });

  test('signing up with a TAKEN PHONE says phone-exists, before any signup call', async ({ page }) => {
    await boot(page);
    const signupCalls = await captureRpc(page, 'customer_signup', [{ session_token: 't' }]);
    await page.route(/\/rest\/v1\/rpc\/customer_exists/, async (route) => {
      const body = route.request().postDataJSON() as { p_phone?: string };
      await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(!!body.p_phone) }); // taken only when checking phone
    });
    await page.evaluate('switchAuthMode("signup")');
    await page.fill('#a-first', 'Faisal');
    await page.fill('#a-last', 'Babalghoum');
    await page.evaluate('setSignupGender("male")');
    await page.fill('#a-email', 'new@example.com');
    await page.fill('#a-phone', '0508566560');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.fill('#a-height', '175');
    await page.fill('#su-em-name', 'Sara Ahmed'); await page.fill('#su-em-phone', '511122233'); await page.selectOption('#su-em-rel', 'sibling'); // the required emergency contact
    await page.evaluate('S.signupAck=true;doSignup()');
    const err = await page.locator('#auth-err').textContent();
    expect(err).toMatch(/phone|هاتف|جوال/i);
    expect(signupCalls.length).toBe(0);
  });

  test('a successful email signup turns rememberMe on (survives browser close)', async ({ page }) => {
    await boot(page);
    await captureRpc(page, 'customer_signup', [{ session_token: 'tok-new' }]);
    await page.evaluate('switchAuthMode("signup")');
    await page.fill('#a-first', 'Faisal');
    await page.fill('#a-last', 'Babalghoum');
    await page.evaluate('setSignupGender("male")');
    await page.fill('#a-email', 'new@example.com');
    await page.fill('#a-phone', '0508566560');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.fill('#a-height', '175');
    await page.fill('#su-em-name', 'Sara Ahmed'); await page.fill('#su-em-phone', '511122233'); await page.selectOption('#su-em-rel', 'sibling'); // the required emergency contact
    await page.evaluate('S.signupAck=true;doSignup()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(await page.evaluate('S.rememberMe')).toBe(true);
    expect(await page.evaluate(`(localStorage.getItem('cq_session')||'').includes('tok-new')`)).toBe(true);
  });

  test('an offline auth failure says offline, not a generic connection error', async ({ page }) => {
    await boot(page);
    await page.evaluate(`Object.defineProperty(navigator,'onLine',{get:()=>false});_authFail('probe',{message:'x'})`);
    const err = await page.locator('#auth-err').textContent();
    expect(err).toMatch(/offline|غير متصل/i);
  });
});

test.describe('round 3: storage, Arabic keyboards, paste, error visibility', () => {
  test('login still completes when storage is blocked (Safari Block-All-Cookies)', async ({ page }) => {
    await boot(page, { 'rpc:customer_login': [customer] });
    await page.evaluate(`Storage.prototype.setItem=function(){throw new DOMException('denied','SecurityError');}`);
    await page.fill('#a-identifier', 'x@y.com');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(await page.evaluate('S.loggedIn && S.loggedIn.session_token')).toBe('tok9'); // in-memory session survives
  });

  test('Arabic-Indic digits are accepted in the phone mask and normalizer', async ({ page }) => {
    await boot(page);
    const out = await page.evaluate(`(()=>{
      const el=document.createElement('input');el.value='٠٥٠٨٧٢٧٠١٢';fmtPhoneInput(el);
      return { masked: el.value, norm: _normPhone('٠٥٠٨٧٢٧٠١٢','+966'), eastern: _normPhone('۰۵۰۸۷۲۷۰۱۲','+966') };
    })()`) as { masked: string; norm: string; eastern: string };
    expect(out.masked).toBe('050 872 7012'); // was silently wiped as the user typed
    expect(out.norm).toBe('+966508727012');
    expect(out.eastern).toBe('+966508727012');
  });

  test('pasting a full international number keeps every digit (no corrupt truncation)', async ({ page }) => {
    await boot(page);
    const out = await page.evaluate(`(()=>{
      const el=document.createElement('input');
      el.value='+966 508 727 012'; fmtPhoneInput(el); const a=el.value;
      el.value='00966508727012'; fmtPhoneInput(el); const b=el.value;
      return { a, b, norm: _normPhone(a.replace(/\\D/g,''),'+966') };
    })()`) as { a: string; b: string; norm: string };
    expect(out.a).toBe('050 872 7012'); // was "966 508 7270" — a corrupt number
    expect(out.b).toBe('050 872 7012');
    expect(out.norm).toBe('+966508727012');
  });

  test('the error message scrolls into view when set', async ({ page }) => {
    await boot(page);
    await page.evaluate('doLogin()'); // triggers a validation error
    const vis = await page.evaluate(`(()=>{
      const r=document.getElementById('auth-err').getBoundingClientRect();
      return r.top>=0 && r.bottom<=window.innerHeight && document.getElementById('auth-err').textContent.length>0;
    })()`);
    expect(vis).toBe(true);
  });
});

test.describe('round 4: invisible characters & post-login flow', () => {
  test('an invisible RTL mark in the email is stripped before login and signup', async ({ page }) => {
    await boot(page);
    const loginCalls = await captureRpc(page, 'customer_login', [customer]);
    await page.evaluate(`document.getElementById('a-identifier').value='\u200F x@y.com\u200F '`);
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(loginCalls[0].p_identifier).toBe('x@y.com'); // was "x@y.com\u200F" → invalid credentials forever
  });

  test('email login lands the customer on the event picker with the sections bar', async ({ page }) => {
    await boot(page, { 'rpc:customer_login': [customer] });
    expect(await page.evaluate('S.view')).toBe('landing');
    await page.fill('#a-identifier', 'x@y.com');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    // The link opens on PICK YOUR EVENT, so that is where signing in lands too — the three
    // event cards, with the sections bar ready for My Rides / Account.
    expect(await page.evaluate('S.view')).toBe('landing');
    await expect(page.locator('#land-events .landing-event-card:not(.ev-snd96)')).toHaveCount(2);
    const nav = await page.evaluate(() => {
      const bn = document.querySelector('.cust-bnav-btn');
      const tn = document.querySelector('#customer-tab-nav');
      const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null;
      return vis(bn) || vis(tn);
    });
    expect(nav).toBe(true);
    // Bike shortcut to Bookings sits in the topbar beside the customer avatar.
    await expect(page.locator('#topbar-right').getByRole('button', { name: 'Bookings' })).toBeVisible();
  });

  test('signup with a bidi-marked email stores the clean address', async ({ page }) => {
    await boot(page);
    const calls = await captureRpc(page, 'customer_signup', [{ session_token: 't' }]);
    await page.evaluate('switchAuthMode("signup")');
    await page.fill('#a-first', 'Faisal');
    await page.fill('#a-last', 'Babalghoum');
    await page.evaluate('setSignupGender("male")');
    await page.evaluate(`document.getElementById('a-email').value='Faisal\u200F@Example.com\u200E'`);
    await page.fill('#a-phone', '0508566560');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.fill('#a-height', '175');
    await page.fill('#su-em-name', 'Sara Ahmed'); await page.fill('#su-em-phone', '511122233'); await page.selectOption('#su-em-rel', 'sibling'); // the required emergency contact
    await page.evaluate('S.signupAck=true;doSignup()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(calls[0].p_email).toBe('faisal@example.com');
  });
});

test.describe('round 5: staff phone formats & remember-me default', () => {
  test('staff phone login accepts every format incl. Arabic numerals', async ({ page }) => {
    await boot(page);
    await loadStaffHalf(page); // a staff helper on a customer's page: the staff half is fetched first (2026-10-04)
    const out = await page.evaluate(`({
      local: _staffPhoneE164('0551230077'),
      arabic: _staffPhoneE164('٠٥٥١٢٣٠٠٧٧'),
      intlZero: _staffPhoneE164('+966 0551230077'),
      zeros: _staffPhoneE164('00966551230077'),
      bare: _staffPhoneE164('551230077'),
    })`) as Record<string, string>;
    expect(out.local).toBe('+966551230077');
    expect(out.arabic).toBe('+966551230077'); // was '+' + empty — Arabic keyboards couldn't staff-login by phone
    expect(out.intlZero).toBe('+966551230077'); // was '+9660…'
    expect(out.zeros).toBe('+966551230077');
    expect(out.bare).toBe('+966551230077');
  });

  test('remember-me defaults ON so logins persist across app restarts', async ({ page }) => {
    await boot(page, { 'rpc:customer_login': [customer] });
    expect(await page.evaluate('S.rememberMe')).toBe(true); // checkbox pre-checked
    await page.fill('#a-identifier', 'x@y.com');
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.evaluate('doLogin()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(await page.evaluate(`(localStorage.getItem('cq_session')||'').includes('tok9')`)).toBe(true); // localStorage, not session-only
  });
});

// Signed out, the sign-in page is the first page: header on top, the box on a plain ground
// below it, nothing of the landing or the footer showing through.
test('the auth page is a clean page under the header', async ({ page }) => {
  await stubSupabase(page, {});
  await page.goto('/');
  await waitForSb(page);
  await expect(page.locator('#auth-modal.as-page .auth-backdrop')).toBeVisible();
  const bg = await page.locator('#auth-modal .auth-backdrop').evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).not.toMatch(/rgba\(\d+, \d+, \d+, 0\)|transparent/);
  await expect(page.locator('#app-footer')).toBeHidden();
  const topbar = await page.locator('#topbar').boundingBox();
  const box = await page.locator('#auth-modal .auth-box').boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(topbar!.y + topbar!.height - 1);
  await expect(page.locator('#topbar')).toBeVisible();
});
