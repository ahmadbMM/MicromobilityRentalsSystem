import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { stubSupabase, staffReady, loginCustomer, waitForSb } from './helpers/supabase';

// Accessibility audit — now a GATE. The backlog it was written to work down is clear:
// every audited view (landing, auth, booking, my rides, and each staff screen) reports
// zero axe-core violations, so a new one is a regression and fails the build here.
//
// "Needs review" items are still only printed. Those are the checks axe cannot decide on
// its own — colour contrast over gradients and images, mostly — and failing on them would
// make the gate noise rather than signal. They stay in the log for a human to skim.
const STRICT = true;

// The audit used to run the instant page.goto() resolved — while #loading-screen was still
// up — so axe was inspecting a spinner and reported "clean". Wait for the app to actually
// paint before looking at it.
async function settle(page: import('@playwright/test').Page) {
  await page.waitForFunction(
    () => {
      const ld = document.getElementById('loading-screen');
      return !ld || getComputedStyle(ld).display === 'none' || ld.getClientRects().length === 0;
    },
    null,
    { timeout: 15000 },
  ).catch(() => {});
  await page.waitForTimeout(400);
}

async function audit(page: import('@playwright/test').Page, label: string) {
  await settle(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  // axe files anything it could not decide (notably colour-contrast over gradients/opacity)
  // under `incomplete`. Reading only `violations` is how a real contrast defect stayed hidden.
  const incomplete = results.incomplete ?? [];
  if (results.violations.length === 0 && incomplete.length === 0) {
    console.log(`[a11y] ${label}: clean`);
    return 0;
  }
  console.log(`[a11y] ${label}: ${results.violations.length} violation type(s), ${incomplete.length} needing review`);
  for (const v of results.violations) {
    console.log(`  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
    for (const n of v.nodes.slice(0, 3)) {
      const d = (n.any || [])[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined;
      console.log(`      ${n.target.join(' ')}${d && d.contrastRatio ? ` (${d.fgColor} on ${d.bgColor}: ${d.contrastRatio})` : ''}`);
    }
  }
  for (const v of incomplete) {
    console.log(`  ? [review] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
    for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target.join(' ')}`);
  }
  return results.violations.length;
}

test.describe('accessibility gate (any violation fails the build)', () => {
  // axe over a section with about twenty rows per list takes several seconds on a loaded machine (round s10)
  test.describe.configure({ timeout: 90_000 });
  test.beforeEach(async ({ page }) => {
    await stubSupabase(page);
  });

  test('landing page (EN, dark)', async ({ page }) => {
    await page.goto('/');
    const count = await audit(page, 'landing EN dark');
    if (STRICT && count > 0) throw new Error(`${count} a11y violation type(s)`);
  });

  test('landing page (AR, RTL)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#lang-btn').selectOption('ar');   // the header control is a dropdown
    await page.locator('html[dir="rtl"]').waitFor();
    const count = await audit(page, 'landing AR rtl');
    if (STRICT && count > 0) throw new Error(`${count} a11y violation type(s)`);
  });

  // The staff back office is the app's actual product. Every section of STAFF_PATHS (2026-10-09; it was
  // five), in English and again in Arabic, right to left, with the rules of WCAG 2.1 and 2.2 AA too.
  // The seven sections added since October (Waitlist, Sessions, Lockers, Badge requests, Volunteers, Store, Payments) too
  // (staff round s10, item 43), and every list holds about twenty rows (officeFixtures), so the gate reads real tables.
  const STAFF_TABS = ['queue', 'dashboard', 'cashier', 'inventory', 'workshop', 'customers', 'community', 'ambassadors',
    'vendors', 'website', 'catalog', 'messages', 'analytics', 'history', 'team', 'settings',
    'waitlist', 'sessions', 'lockers', 'badgereq', 'volunteers', 'store', 'payments', 'ask'] as const; // Ask: 2026-11-13 (its page views are audited in tests/ask.spec.ts)
  for (const lang of ['en', 'ar'] as const) {
    for (const tab of STAFF_TABS) {
      test(`staff: ${tab} (${lang})`, async ({ page }) => {
        await stubSupabase(page, { ...staffFixtures(), ...officeFixtures() });
        await page.addInitScript((l) => {
          localStorage.setItem('cq_staff', '1');
          localStorage.setItem('cq_op_name', 'A11y Spec');
          localStorage.setItem('cq_lang', l);
        }, lang);
        await page.goto('/');
        await staffReady(page);
        await waitForSb(page);
        if (lang === 'ar') await page.locator('html[dir="rtl"]').waitFor();
        await page.evaluate((t) => (window as unknown as { setStaffTab: (x: string) => void }).setStaffTab(t), tab);
        const count = await audit(page, `staff ${tab} ${lang}`);
        if (STRICT && count > 0) throw new Error(`${count} a11y violation type(s)`);
      });
    }
  }

  // The staff dark theme is a choice again (Settings > This device > Theme, 2026-10-09): its contrast is held too.
  for (const tab of ['queue', 'dashboard', 'cashier', 'inventory', 'customers', 'analytics', 'history', 'settings'] as const) {
    test(`staff dark: ${tab}`, async ({ page }) => {
      await stubSupabase(page, staffFixtures());
      await page.addInitScript(() => {
        localStorage.setItem('cq_staff', '1');
        localStorage.setItem('cq_op_name', 'A11y Spec');
        localStorage.setItem('cq_staff_theme', 'dark');
      });
      await page.goto('/');
      await staffReady(page);
      await waitForSb(page);
      await expect(page.locator('html')).toHaveAttribute('data-staff-theme', 'dark');
      await page.evaluate((t) => (window as unknown as { setStaffTab: (x: string) => void }).setStaffTab(t), tab);
      const count = await audit(page, `staff dark ${tab}`);
      if (STRICT && count > 0) throw new Error(`${count} a11y violation type(s)`);
    });
  }

  // The dialogs the desk lives in: check-in, the booking editor, a customer, a bike, a sale. And where the office works
  // (staff round s10, item 43): the account window, the Team page's access card, the Ctrl+K palette with results, the bell.
  const DIALOGS: [string, string, string, string?][] = [
    ['check-in', `showCheckinModal('q1')`, '#checkin-modal [role="dialog"]'],
    ['booking editor', `showBookingEditModal('q1')`, '[role="dialog"]'],
    ['customer', `showEditCustomerModal('c1')`, '[role="dialog"]'],
    ['bike', `openBikeProfile('b1')`, '#bike-profile-modal [role="dialog"], #bike-profile-modal .modal-backdrop'],
    ['sale', `showCashierModal('q1')`, '#cashier-modal [role="dialog"], #cashier-modal .modal-backdrop'],
    ['account window', `openAccountHistory('c1')`, '#cust-modal [role="dialog"]'],
    ['team access card', `setStaffTab('team')`, '#tab-team .tm-acct[data-acct="22222222-2222-2222-2222-222222222222"] .tm-chip'],
    ['palette', `_gsOpen()`, '#gs-panel [role="dialog"]', 'Lina'],
    ['bell', `_ntOpen()`, '#nt-panel .nt-box[role="dialog"]'],
  ];
  const TEAM = {
    'rpc:staff_team_list': [
      { user_id: '11111111-1111-1111-1111-111111111111', email: 'admin@example.com', role: 'admin', modules_view: null, modules_edit: null, is_me: true },
      { user_id: '22222222-2222-2222-2222-222222222222', email: 'desk@example.com', role: 'frontdesk', modules_view: ['queue', 'cashier'], modules_edit: ['queue'], is_me: false },
      { user_id: '33333333-3333-3333-3333-333333333333', email: 'manager@example.com', role: 'manager', modules_view: null, modules_edit: null, is_me: false },
    ],
    'rpc:staff_team_more': [],
    'rpc:staff_operator_list': [{ name: 'A11y Spec', has_pin: false }, { name: 'Desk A', has_pin: true }],
  };
  for (const [name, open, sel, typed] of DIALOGS) {
    test(`staff dialog: ${name}`, async ({ page }) => {
      await stubSupabase(page, { ...staffFixtures(), ...officeFixtures(), ...TEAM });
      await page.addInitScript(() => {
        localStorage.setItem('cq_staff', '1');
        localStorage.setItem('cq_op_name', 'A11y Spec');
      });
      await page.goto('/');
      await staffReady(page);
      await waitForSb(page);
      await page.waitForFunction(`getQueue().length>0`);
      await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${DAY}';renderStaffQueue()`);
      await page.evaluate(open);
      await page.locator(sel).first().waitFor();
      if (typed) {
        await page.locator('#gs-input').fill(typed);
        await page.locator('#gs-results [role="option"]').first().waitFor();
      }
      const count = await audit(page, `staff dialog ${name}`);
      if (STRICT && count > 0) throw new Error(`${count} a11y violation type(s)`);
    });
  }
});

// Tomorrow in Riyadh: a "live" ride for the fixtures (a today-dated one turns into yesterday after 23:00 KSA).
const DAY = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
function staffFixtures() {
  return {
    sessions: [{ id: DAY, session_date: DAY, day: 'Saturday', status: 'open', capacity: 20, created_at: 1 }],
    bikes: [{ id: 'b1', name: 'R-11', type: 'Road', size: 'M', status: 'available', colors: ['#111111'], color_names: ['Black'], bike_number: 11 }],
    customers: [{ id: 'c1', name: 'Lina Haddad', phone: '0550000001', email: 'lina@example.com', height: 168 }],
    queue_entries: [{ id: 'q1', session_id: DAY, session_day: 'Saturday', session_date: DAY, queue_num: 1, name: 'Lina Haddad',
      phone: '0550000001', customer_id: 'c1', type_preference: 'Road', size: 'M', status: 'waiting', paid: false, price: 75,
      registered_at: DAY + 'T10:00:00Z' }],
  };
}

// The customer half's fields (2026-10-05): the build's field-name check now reads the rider pages too
// (scripts/split-staff.mjs, tests/build-checks.spec.ts); these are the fields it found unnamed, each now
// named by its visible label (for=/id) or a translated aria-label. A placeholder is not a name.
test.describe('@customer:a11y every field on the rider pages has a name', () => {
  const named = (page: Page, sel: string, name: string | RegExp) => expect(page.locator(sel), sel).toHaveAccessibleName(name);

  test('Account names each field by its label', async ({ page }) => {
    await loginCustomer(page, { id: 'c1', name: 'Test Rider Name', height: 170, type_preference: 'Road' });
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [] });
    await page.goto('/');
    await waitForSb(page);
    // each field on its page of the account menu (2026-11-10)
    for (const [pg, sel, name] of [['personal', '#acc-first', 'First Name'], ['personal', '#acc-middle', 'Middle Name'], ['personal', '#acc-last', 'Last Name'], ['contact', '#acc-email', 'Email Address'],
      ['contact', '#acc-cc', 'Country code'], ['contact', '#acc-phone', 'Phone Number'], ['riding', '#acc-height', /^Height/], ['residence', '#acc-country', 'Country of residence'],
      ['residence', '#acc-city', 'City of residence'], ['personal', '#acc-nationality', 'Nationality']] as const) {
      await page.evaluate(`setCustTab('account','${pg}')`);
      await expect(page.locator(sel)).toBeVisible();
      await named(page, sel, name);
    }
  });

  test('Create account names the country code; the cancel dialog names its own reason', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [] });
    await page.goto('/signup');
    await waitForSb(page);
    await expect(page.locator('#a-cc')).toBeVisible();
    await named(page, '#a-cc', 'Country code');
    await page.evaluate(`showCancelReasonModal('none')`);
    await page.locator('#cancel-reason-modal .cancel-reason-opt').last().click(); // Other: the box for their own words
    await expect(page.locator('#cancel-other-text')).toBeVisible();
    await named(page, '#cancel-other-text', 'Tell us the reason');
  });

  test('the application fix page names each field by its item\'s label', async ({ page }) => {
    await stubSupabase(page, { sessions: [], 'rpc:list_sessions': [], queue_entries: [], bikes: [],
      'rpc:community_fix_get': { ok: true, first: 'Test', lang: 'en', fields: ['email', 'phone', 'nationality', 'height', 'profession', 'workplace', 'instagram', 'linkedin'], note: '', values: {} } });
    await page.goto('/?appfix=a1b2c3d4e5f60718293a4b5c6d7e8f901234&lang=en');
    await waitForSb(page);
    const box = page.locator('#app-fix .afx-box');
    await expect(box.locator('#afx-email')).toBeVisible();
    for (const k of ['email', 'nationality', 'height', 'instagram', 'linkedin']) {
      const lbl = (await box.locator(`#afx-l-${k}`).textContent() || '').trim();
      expect(lbl, k).not.toBe('');
      await named(page, `#app-fix .fx-item[data-afx="${k}"] :is(input,select)`, lbl);
    }
    await named(page, '#afx-prof', (await box.locator('#afx-l-profession').textContent() || '').trim());
    await named(page, '#afx-work', (await box.locator('#afx-l-workplace').textContent() || '').trim());
    await named(page, '#afx-phone', (await box.locator('#afx-l-phone').textContent() || '').trim());
    await named(page, '#afx-cc', 'Country code');
  });
});

// About twenty rows for each office list (staff round s10, item 43): the gate used to audit most office sections empty.
// Invented people and numbers; every list starts with the desk fixtures' own rows (c1, q1, b1).
function officeFixtures() {
  const base = staffFixtures();
  const N = 20;
  const ids = Array.from({ length: N }, (_, i) => i + 1);
  const first = ['Lina', 'Omar', 'Sara', 'Khalid', 'Huda', 'Faisal', 'Noura', 'Majid', 'Reem', 'Tariq'];
  const last = ['Haddad', 'Saleh', 'Ali', 'Mansour', 'Qasim', 'Nasser', 'Hamdan', 'Fahad', 'Zaid', 'Karim'];
  const nm = (i: number) => (i === 1 ? 'Lina Haddad' : `${first[(i - 1) % 10]} ${last[(i * 3) % 10]}`);
  const ph = (i: number) => `05500000${String(i).padStart(2, '0')}`;
  const at = (i: number) => new Date(Date.UTC(2026, 9, 1 + i, 9, 30)).toISOString();
  const st = ['waiting', 'active', 'done', 'no_show'];
  const customers = ids.map((i) => ({ id: `c${i}`, name: nm(i), phone: ph(i), email: `rider${i}@example.com`, height: 160 + i,
    gender: i % 2 ? 'female' : 'male', birth_date: `199${i % 10}-0${(i % 9) + 1}-1${i % 10}`, created_at: at(i) }));
  const queue_entries = [base.queue_entries[0], ...ids.slice(1).map((i) => ({ id: `q${i}`, session_id: DAY, session_day: 'Saturday', session_date: DAY,
    queue_num: i, name: nm(i), phone: ph(i), customer_id: `c${i}`, type_preference: i % 3 ? 'Road' : 'Hybrid', size: 'M', status: st[i % 4],
    paid: i % 2 === 0, price: 75, registered_at: DAY + 'T10:00:00Z' }))];
  const bikes = [base.bikes[0], ...ids.slice(1).map((i) => ({ id: `b${i}`, name: `R-${10 + i}`, type: i % 3 ? 'Road' : 'Hybrid', size: 'M',
    status: i % 5 ? 'available' : 'maintenance', colors: ['#c0392b'], color_names: ['Red'], bike_number: 10 + i }))];
  const workshop_jobs = ids.map((i) => ({ id: 100 + i, created_at: at(i), customer_id: null, name: nm(i), phone: `+9665512345${String(i).padStart(2, '0')}`,
    email: null, service: 'full-service', service_label: 'Full service', price_quoted: 409, parts: [], lane: 'dropoff', pickup_address: null,
    preferred_date: '2099-05-06', preferred_time: '17:00', bike: 'ALVAS DA54 AL', notes: 'Brakes squeal', lang: 'en',
    status: ['new', 'confirmed', 'in_progress', 'ready', 'done'][i % 5], scheduled_for: null, price_final: null, staff_notes: null,
    updated_at: at(i), updated_by: 'website' }));
  const site_messages = ids.map((i) => ({ id: 200 + i, created_at: at(i), kind: i % 2 ? 'business' : 'help', topic: i % 2 ? 'fleet-programmes' : 'warranty',
    name: nm(i), company: i % 2 ? 'Red Sea Hotels' : null, email: `sender${i}@example.test`, phone: `+9665512345${String(i).padStart(2, '0')}`,
    message: 'We need bikes for our guests.', lang: i % 3 ? 'en' : 'ar', customer_id: null, status: ['new', 'replied', 'closed'][i % 3],
    staff_notes: null, updated_at: at(i), updated_by: 'website' }));
  const badges = [
    { id: 'bd_marshal', slug: 'marshal', icon: 'shield', color: 'orange', name: 'Marshal', system: true, auto: false, retired: false, sort: 10 },
    { id: 'bd_t100', slug: 't100', icon: 'medal', color: 'gold', name: 'T100 Finisher', system: true, auto: false, retired: false, sort: 202 },
  ];
  const badge_requests = ids.map((i) => ({ id: i, customer_id: `c${i}`, badge_id: i % 2 ? 'bd_marshal' : 'bd_t100', comment: i % 3 ? 'Swept 12 rides' : null,
    proof_kind: i % 2 ? 'image' : null, proof_name: i % 2 ? 'race.png' : null, status: ['pending', 'given', 'declined'][i % 3], created_at: at(i),
    decided_at: i % 3 ? at(i + 1) : null, decided_by: i % 3 ? 'Desk A' : null, reply: null }));
  const community_applications = ids.map((i) => ({ id: `a${i}`, status: ['pending', 'approved', 'declined'][i % 3], name: nm(i),
    email: `applicant${i}@example.com`, phone: `+9665524680${String(i).padStart(2, '0')}`, instagram: `rider.${i}`, linkedin: `rider-${i}`,
    created_at: at(i), updated_at: at(i), submissions: 1, height: 170, birth_date: '1994-03-12', gender: i % 2 ? 'female' : 'male',
    nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true, decided_at: null, decided_by: null, customer_id: null,
    existing_account: null, account_oauth: null, profession: 'Architect', hidden_at: null, hidden_by: null }));
  const volunteers = ids.map((i) => ({ customer_id: `c${i}`, status: ['active', 'applied', 'active', 'ended'][i % 4], tags: [], auto_accept: false,
    agreed_version: '2026-11-05', agreed_at: at(i), days: [i % 7], profile_at: at(i), created_at: at(i) }));
  const desk_waitlist = ids.slice(0, 8).map((i) => ({ id: `w${i}`, name: nm(i + 10), phone: ph(i + 10), bike_type: 'Road', status: 'waiting',
    author: null, created_at: DAY + 'T10:00:00Z', resolved_at: null }));
  const lockers = Array.from({ length: 18 }, (_, i) => ({ id: `L${i + 1}`, code: String(i + 1), status: i === 5 ? 'out' : 'available', note: '', created_at: at(1) }));
  const locker_rentals = ids.slice(0, 10).map((i) => ({ id: `R${i}`, day: DAY, period: i % 2 ? 'late' : 'early', booking_id: `q${i}`, session_id: DAY,
    customer_id: `c${i}`, name: nm(i), locker_id: `L${i}`, price: 10, on_bill: true, status: i % 3 ? 'reserved' : 'in_use', created_at: at(i), created_by: 'rider' }));
  // Ask's pages (2026-11-13): one in each state, with answers waiting on some
  const ask_pages = ids.map((i) => ({ id: i, slug: `page-${i}`, code: String(100000 + i), title_en: `Question ${i} for ${nm(i)}`, title_ar: '', intro_en: '', intro_ar: '',
    audience: ['link', 'accounts', 'tags'][i % 3], tag_ids: i % 3 === 2 ? ['tag_saturday'] : [], status: ['live', 'draft', 'ended'][i % 3], opens_at: i % 6 ? null : '2099-01-01T09:00:00Z',
    closes_at: i % 2 ? '2099-02-01T18:00:00Z' : null, after_close: 'results', pace: 'self', listed: true, round: 1, notes: '', look: {}, open: i % 3 === 0 && i % 6 !== 0,
    questions: 1 + (i % 3), answers: i * 3, people: i * 2, pending: i % 4 }));
  return { ...base, customers, queue_entries, bikes, workshop_jobs, workshop_job_events: [], site_messages, badges, customer_badges: [], badge_requests,
    community_applications, learn_applications: [], volunteers, desk_waitlist, lockers, locker_rentals,
    'rpc:staff_store_ready': true, 'rpc:staff_store_orders': [], store_orders: [], payment_refunds: [],
    'rpc:staff_ask_pages': ask_pages, 'rpc:staff_ask_pending': 12 };
}
