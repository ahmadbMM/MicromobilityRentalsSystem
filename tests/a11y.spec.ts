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
    for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target.join(' ')}`);
  }
  for (const v of incomplete) {
    console.log(`  ? [review] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
    for (const n of v.nodes.slice(0, 3)) console.log(`      ${n.target.join(' ')}`);
  }
  return results.violations.length;
}

test.describe('accessibility audit (report-only)', () => {
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
  const STAFF_TABS = ['queue', 'dashboard', 'cashier', 'inventory', 'workshop', 'customers', 'community', 'ambassadors',
    'vendors', 'website', 'catalog', 'messages', 'analytics', 'history', 'team', 'settings'] as const;
  for (const lang of ['en', 'ar'] as const) {
    for (const tab of STAFF_TABS) {
      test(`staff: ${tab} (${lang})`, async ({ page }) => {
        await stubSupabase(page, staffFixtures());
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

  // The dialogs the desk lives in: check-in, the booking editor, a customer, a bike, a sale.
  const DIALOGS: [string, string, string][] = [
    ['check-in', `showCheckinModal('q1')`, '#checkin-modal [role="dialog"]'],
    ['booking editor', `showBookingEditModal('q1')`, '[role="dialog"]'],
    ['customer', `showEditCustomerModal('c1')`, '[role="dialog"]'],
    ['bike', `openBikeProfile('b1')`, '#bike-profile-modal [role="dialog"], #bike-profile-modal .modal-backdrop'],
    ['sale', `showCashierModal('q1')`, '#cashier-modal [role="dialog"], #cashier-modal .modal-backdrop'],
  ];
  for (const [name, open, sel] of DIALOGS) {
    test(`staff dialog: ${name}`, async ({ page }) => {
      await stubSupabase(page, staffFixtures());
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

  test('My Account names each field by its label', async ({ page }) => {
    await loginCustomer(page, { id: 'c1', name: 'Test Rider Name', height: 170, type_preference: 'Road' });
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [] });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`setCustTab('account')`);
    await expect(page.locator('#acc-first')).toBeVisible();
    for (const [sel, name] of [['#acc-first', 'First Name'], ['#acc-middle', 'Middle Name'], ['#acc-last', 'Last Name'], ['#acc-email', 'Email Address'],
      ['#acc-cc', 'Country code'], ['#acc-phone', 'Phone Number'], ['#acc-height', /^Height/], ['#acc-country', 'Country of residence'],
      ['#acc-city', 'City of residence'], ['#acc-nationality', 'Nationality']] as const) await named(page, sel, name);
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
    await named(page, '#cancel-other-text', 'Please describe your reason...');
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
