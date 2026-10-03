import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb, staffReady } from './helpers/supabase';

// The staff header is sticky and painted above everything else that sticks. The sections
// burger, the analytics range bar and the fleet bulk bar all stuck at top:0, so once the page
// scrolled they slid out of sight UNDER it - on a phone the only way to another section was to
// scroll back to the top first. And on a tablet the roster scrolls sideways under its pinned
// booking number, which has to stay the one thing painted in that column.

const S1 = '2099-10-10';
const sess = { id: S1, session_date: S1, day: 'Sunday', status: 'open', capacity: 60, created_at: 1 };
const rider = (n: number, status: string) => ({
  id: `r${n}`, session_id: S1, session_day: 'Sunday', session_date: S1, queue_num: n,
  name: `Rider ${n}`, phone: '05500' + String(n).padStart(5, '0'), type_preference: 'Road',
  status, paid: true, price: 75, size: 'M', registered_at: '2099-01-01T10:00:00Z',
});
const queue_entries = [rider(1, 'active'), rider(2, 'noshow'), ...Array.from({ length: 40 }, (_, i) => rider(i + 3, 'waiting'))];

async function staffAt(page: import('@playwright/test').Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  await stubSupabase(page, { sessions: [sess], queue_entries, bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await staffReady(page);
}

/** True when the element itself (or something inside it) is what is painted at its centre. */
async function onTop(page: import('@playwright/test').Page, sel: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit && (hit === el || el.contains(hit));
  }, sel);
}

/** Enough page below the fold to scroll well past the header. */
async function tallPage(page: import('@playwright/test').Page, tab: string) {
  await page.evaluate((t) => {
    document.getElementById('tab-' + t)!.insertAdjacentHTML('beforeend', '<div class="spec-spacer" style="height:3000px"></div>');
  }, tab);
}

for (const [name, width, height] of [['a phone', 390, 780], ['a tablet', 820, 1100]] as const) {
  test(`on ${name} the sections burger stays below the header while the page scrolls`, async ({ page }) => {
    await staffAt(page, width, height);
    await page.evaluate(`setStaffTab('queue')`);
    await tallPage(page, 'queue');
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(100);

    const header = (await page.locator('#topbar').boundingBox())!;
    const burger = (await page.locator('#snav-burger').boundingBox())!;
    expect(burger.y).toBeGreaterThanOrEqual(header.y + header.height - 1); // under the bar, not behind it
    expect(await onTop(page, '#snav-burger')).toBe(true);

    await page.locator('#snav-burger').click();
    const nav = page.locator('#staff-tab-nav');
    await expect(nav).toBeVisible();
    expect(await onTop(page, '#staff-tab-nav .tab-btn[data-stab="queue"]')).toBe(true);
    await nav.locator('.tab-btn[data-stab="analytics"]').click();
    expect(await page.evaluate('S.staffTab')).toBe('analytics');
  });
}

for (const [name, width, height] of [['a desktop', 1440, 900], ['a phone', 390, 780]] as const) {
  test(`on ${name} the analytics range bar sticks below the header, not under it`, async ({ page }) => {
    await staffAt(page, width, height);
    await page.evaluate(`setStaffTab('analytics')`);
    await expect(page.locator('#tab-analytics .an-sticky')).toBeVisible();
    await tallPage(page, 'analytics');
    await page.evaluate(() => window.scrollTo(0, 1800));
    await page.waitForTimeout(150);
    expect(await onTop(page, '#tab-analytics .an-sticky .an-range-bar')).toBe(true);
    const header = (await page.locator('#topbar').boundingBox())!;
    const bar = (await page.locator('#tab-analytics .an-sticky').boundingBox())!;
    expect(bar.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
  });
}

test('on a tablet the pinned booking number stays readable while the roster scrolls sideways', async ({ page }) => {
  await staffAt(page, 780, 1100); // 780, not 820: since the roster fits a laptop (2026-10-03) it only just overflows at 820
  // sfShowFinished: the no-show row would otherwise be folded into the "finished" line
  await page.evaluate(`setStaffTab('queue');S.queueView='bookings';S.sfSession='${S1}';S.sfShowFinished=true;renderStaffQueue()`);
  const wrap = page.locator('#tab-queue .queue-table-desktop-wrap');
  await expect(wrap).toBeVisible();
  const overflow = await wrap.evaluate((w) => w.scrollWidth - w.clientWidth);
  expect(overflow).toBeGreaterThan(40); // the roster really is wider than a tablet
  await wrap.evaluate((w) => { w.scrollLeft = 200; });
  await page.waitForTimeout(100);

  // The "#" header is painted over the headers scrolling under it, not the other way round.
  expect(await onTop(page, '#tab-queue .queue-table-desktop-wrap thead th:first-child')).toBe(true);

  // The on-bike and no-show rows tint their cells with a see-through wash; on the pinned cell
  // it has to sit on an opaque fill, or the columns scrolling underneath show through it.
  const fills = await page.evaluate(() => ['row-active', 'row-noshow-cancel'].map((c) => {
    const td = document.querySelector(`#tab-queue .queue-table-desktop-wrap tr.${c} td:first-child`);
    return td ? getComputedStyle(td).backgroundColor : 'missing';
  }));
  for (const f of fills) {
    expect(f).not.toBe('missing');
    expect(f).not.toMatch(/rgba\(\d+, \d+, \d+, 0(\.\d+)?\)|transparent/);
  }
});
