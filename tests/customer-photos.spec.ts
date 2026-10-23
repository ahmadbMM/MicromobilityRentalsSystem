import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Accounts and Members, 2026-10-23: the rider's profile photo beside the name. The account list
// leaves photo out; the links come in one read of their own, an old inline photo only for a row on
// the page, and a rider without one (or whose link no longer opens) shows their initials.

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const INLINE = 'data:image/png;base64,' + PNG.toString('base64');
const customers = [
  { id: 'c1', name: 'Sara Ali', email: 'sara@example.com', phone: '+966561111111', created_at: '2026-01-05T10:00:00Z', gender: 'female' },
  { id: 'c2', name: 'Omar Harbi', email: 'omar@example.com', phone: '+966562222222', created_at: '2026-02-05T10:00:00Z', gender: 'male' },
  { id: 'c3', name: 'Lina Saad', email: 'lina@example.com', phone: '+966563333333', created_at: '2026-03-05T10:00:00Z', gender: 'female' },
  { id: 'c4', name: 'Huda Noor', email: 'huda@example.com', phone: '+966564444444', created_at: '2026-04-05T10:00:00Z', gender: 'female' },
];
type P = import('@playwright/test').Page;

async function open(page: P) {
  const asked: string[] = [];
  await stubSupabase(page, { sessions: [], queue_entries: [], customers, tags: [], customer_tags: [] });
  await page.route(/\/rest\/v1\/customers\?.*photo=like/, (r) => {
    const u = decodeURIComponent(r.request().url());
    asked.push(u);
    const body = u.includes('like.https')
      ? [{ id: 'c1', photo: 'https://lh3.googleusercontent.com/a/sara' }, { id: 'c4', photo: 'https://lh3.googleusercontent.com/a/gone' }]
      : [{ id: 'c2' }];
    return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  });
  await page.route(/\/rest\/v1\/customers\?.*id=in\./, (r) => {
    asked.push(decodeURIComponent(r.request().url()));
    return r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ id: 'c2', photo: INLINE }]) });
  });
  await page.route('https://lh3.googleusercontent.com/a/sara', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
  await page.route('https://lh3.googleusercontent.com/a/gone', (r) => r.fulfill({ status: 404, body: '' }));
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length>0');
  await page.evaluate(`setStaffTab('customers');setCustomersTab('accounts')`);
  await expect(page.locator('#am-cust-rows .am-cust')).toHaveCount(4);
  return asked;
}
const av = (page: P, id: string) => page.locator(`.am-row[data-cust="${id}"] .am-av`);

test('photos beside the names, initials where there is none or the link is broken', async ({ page }) => {
  const asked = await open(page);
  await expect(av(page, 'c1')).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/sara');
  await expect(av(page, 'c2')).toHaveAttribute('src', INLINE);            // the inline one, read for the rows on the page
  await expect(av(page, 'c3')).toHaveText('LS');                           // no photo
  await expect(av(page, 'c4')).toHaveText('HN');                           // its link 404s
  await expect.poll(() => asked.filter((u) => u.includes('id=in.')).length).toBe(1);
  expect(asked.find((u) => u.includes('id=in.'))).toContain('c2');
  // the photo sits before the name, inside the name column
  const a = await av(page, 'c1').boundingBox(), n = await page.locator('.am-row[data-cust="c1"] .am-cust-name').boundingBox();
  expect(a!.x + a!.width).toBeLessThanOrEqual(n!.x + 1);
  // tapping it shows it big
  await av(page, 'c1').click();
  await expect(page.locator('#photo-lightbox img')).toHaveAttribute('src', 'https://lh3.googleusercontent.com/a/sara');
  // a repaint (another tab and back) keeps the photos and reads nothing again
  const n0 = asked.length;
  await page.keyboard.press('Escape');
  await page.evaluate(`setCustomersTab('members');setCustomersTab('accounts')`);
  await expect(av(page, 'c2')).toHaveAttribute('src', INLINE);
  expect(asked.length).toBe(n0);
});
