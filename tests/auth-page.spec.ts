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
    await page.fill('#a-pwd2', 'Zq8xTselah');
    await page.fill('#a-height', '175');
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
    expect(await errAfter()).toBeTruthy();                       // weak password
    await page.fill('#a-pwd', 'Zq8xTselah');
    await page.fill('#a-pwd2', 'Zq8xOther');
    expect(await errAfter()).toBeTruthy();                       // mismatch
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

test.describe('forgot password', () => {
  test('reset sends a normalized phone (leading 0 stripped) and logs in', async ({ page }) => {
    await boot(page);
    const calls = await captureRpc(page, 'customer_reset', [customer]);
    await page.evaluate('switchAuthMode("forgot")');
    await page.fill('#a-forgot-email', 'x@y.com');
    await page.fill('#a-forgot-phone', '0508727012');
    await page.press('#a-forgot-phone', 'Enter'); // Enter advances step 1
    await expect(page.locator('#a-reset-pwd')).toBeVisible();
    await page.fill('#a-reset-pwd', 'Zq8xTselah');
    await page.fill('#a-reset-pwd2', 'Zq8xTselah');
    await page.press('#a-reset-pwd2', 'Enter'); // Enter submits step 2
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(calls[0].p_phone).toBe('+966508727012'); // was "+9660508727012" → could never match
    expect(await page.evaluate('S.loggedIn.id')).toBe('c9');
  });

  // Post-lockdown, step 1 only CAPTURES the email/phone — the real check runs server-side in
  // customer_reset when the button is pressed. So step 2 must NOT claim "Identity verified":
  // it once did, unconditionally, producing a green checkmark over a red "no such account".
  test('step 2 says it is resetting, not that identity was verified, until it actually is', async ({ page }) => {
    await boot(page);
    await page.evaluate('switchAuthMode("forgot")');
    await page.fill('#a-forgot-email', 'nobody@x.com');
    await page.fill('#a-forgot-phone', '0508727012');
    await page.press('#a-forgot-phone', 'Enter');
    const chip = page.locator('#auth-modal').locator('div', { hasText: /Resetting the password for|Identity verified/ }).first();
    await expect(chip).toContainText('Resetting the password for');
    await expect(page.locator('#auth-modal')).not.toContainText('Identity verified');
    await expect(page.locator('#auth-modal')).not.toContainText('✓ Identity');
  });

  // A failed match returns to step 1 to fix the details, not stranding the user on a password
  // form that cannot succeed — and never under a stale "verified" chip.
  test('a non-matching reset bounces back to step 1 with the error', async ({ page }) => {
    await boot(page);
    await captureRpc(page, 'customer_reset', []); // RPC returns no row → no match
    await page.evaluate('switchAuthMode("forgot")');
    await page.fill('#a-forgot-email', 'nobody@x.com');
    await page.fill('#a-forgot-phone', '0508727012');
    await page.press('#a-forgot-phone', 'Enter');
    await page.fill('#a-reset-pwd', 'Zq8xTselah');
    await page.fill('#a-reset-pwd2', 'Zq8xTselah');
    await page.press('#a-reset-pwd2', 'Enter');
    await page.waitForFunction('S.forgotStep===1'); // bounced back
    await expect(page.locator('#a-forgot-email')).toBeVisible(); // step 1 fields are shown again
    await expect(page.locator('#auth-err')).toContainText(/do not match|match an account/i);
    await expect(page.locator('#auth-modal')).not.toContainText('Identity verified');
  });
});

// Google and Apple no longer make accounts (the owner, 2026-09-30): Create account has neither
// button, and a Google or Apple sign-in that finds no account lands on Create account instead of a
// Google-only profile form.
test.describe('Google and Apple: sign-in only', () => {
  test('Create account has no Google or Apple button; Sign in keeps both', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#auth-modal .btn-google:not(.btn-apple)')).toHaveCount(1);
    await expect(page.locator('#auth-modal .btn-apple')).toHaveCount(1);
    await page.evaluate('switchAuthMode("signup")');
    await expect(page.locator('#a-email')).toBeVisible();
    await expect(page.locator('#auth-modal .btn-google')).toHaveCount(0);
    await expect(page.locator('#auth-modal .btn-apple')).toHaveCount(0);
    await expect(page.locator('#auth-modal .auth-or')).toHaveCount(0);
    await expect(page.locator('#auth-modal')).not.toContainText(/Continue with (Google|Apple)/);
  });

  test('a sign-in with no account lands on Create account with its name and email, says why, and makes nothing', async ({ page }) => {
    await boot(page);
    const made = await captureRpc(page, 'customer_oauth_signup', [{ session_token: 'gtok' }]);
    const signup = await captureRpc(page, 'customer_signup', [{ id: 'n1', session_token: 'ntok' }]);
    await page.evaluate('S._pendingGoogle={email:"gee.user@gmail.com",name:"Gee User",photo:""};_oauthNoAccount()');
    await expect(page.locator('.auth-title')).toHaveText('Create account');
    await expect(page.locator('#auth-modal .auth-note')).toHaveText('No account is linked to this Google or Apple sign-in, and new accounts are no longer made with Google or Apple. Create your account below with your email and a password.');
    await expect(page.locator('#a-first')).toHaveValue('Gee');
    await expect(page.locator('#a-last')).toHaveValue('User');
    await expect(page.locator('#a-email')).toHaveValue('gee.user@gmail.com');
    await expect(page.locator('#a-pwd')).toBeVisible();
    expect(await page.evaluate('S._pendingGoogle')).toBeNull();
    // the sign-up is the ordinary one, with a password
    await page.evaluate('setSignupGender("female")');
    await page.fill('#a-phone', '0508727012');
    await page.fill('#a-pwd', 'Ride2Work');
    await page.fill('#a-pwd2', 'Ride2Work');
    await page.fill('#a-height', '156');
    await page.evaluate('S.signupAck=true;doSignup()');
    await page.waitForFunction('document.getElementById("auth-modal").style.display==="none"');
    expect(made).toEqual([]);
    expect(signup).toHaveLength(1);
    expect(signup[0]).toMatchObject({ p_email: 'gee.user@gmail.com', p_name: 'Gee User', p_pwd: 'Ride2Work', p_phone: '+966508727012' });
    expect(await page.evaluate('S._oauthMiss')).toBeNull();
  });

  test('the details show even when Create account is already open', async ({ page }) => {
    await boot(page);
    await page.evaluate('switchAuthMode("signup")');
    await page.evaluate('S._pendingGoogle={email:"gee.user@gmail.com",name:"Gee User"};_oauthNoAccount()');
    await expect(page.locator('#a-first')).toHaveValue('Gee');
    await expect(page.locator('#a-email')).toHaveValue('gee.user@gmail.com');
  });

  test('a hidden Apple address is not put in the email box; going to Sign in forgets the details', async ({ page }) => {
    await boot(page);
    await page.evaluate('S._pendingGoogle={email:"abc123@privaterelay.appleid.com",name:"Apple Rider"};_oauthNoAccount()');
    await expect(page.locator('#auth-modal .auth-note')).toBeVisible();
    await expect(page.locator('#a-email')).toHaveValue('');
    await expect(page.locator('#a-first')).toHaveValue('Apple');
    await page.evaluate('switchAuthMode("login")');
    await page.evaluate('switchAuthMode("signup")');
    await expect(page.locator('#auth-modal .auth-note')).toHaveCount(0);
    await expect(page.locator('#a-first')).toHaveValue('');
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
    S._pendingGoogle={email:'g@x.com',name:'Gee'}; _oauthNoAccount(); S.signupAck=true; renderAuthModal();
  `);
  expect(errs, errs.join('\n')).toEqual([]);
});

test.describe('in-app browsers (Instagram/WhatsApp webviews)', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Instagram 300.0.0.0' });

  test('the Google button is replaced with guidance (Google blocks these webviews)', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#auth-modal .btn-google')).toHaveCount(0);
    await expect(page.locator('#auth-modal')).toContainText(/Open in browser|الفتح في المتصفح/);
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
    await page.fill('#a-pwd2', 'Zq8xTselah');
    await page.fill('#a-height', '175');
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
    await page.fill('#a-pwd2', 'Zq8xTselah');
    await page.fill('#a-height', '175');
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
    // Bike shortcut to My Bookings sits in the topbar beside the customer avatar.
    await expect(page.locator('#topbar-right').getByRole('button', { name: 'My Bookings' })).toBeVisible();
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
    await page.fill('#a-pwd2', 'Zq8xTselah');
    await page.fill('#a-height', '175');
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

// Sign in with Apple is a black button on the white box. A "dark theme" variant painted it
// white with a white border, and it always won because the head script sets data-theme="dark"
// on every load: the button was an outline-less white box with a line of text in it.
test('the Apple button is black on the white sign-in box', async ({ page }) => {
  await boot(page);
  const apple = page.locator('#auth-modal .btn-apple');
  await expect(apple).toBeVisible();
  const look = await apple.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, ink: cs.color };
  });
  expect(look).toEqual({ bg: 'rgb(0, 0, 0)', ink: 'rgb(255, 255, 255)' });
});
