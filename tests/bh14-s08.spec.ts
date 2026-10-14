import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s08): Applications' form questions, birthdays' WhatsApp button, the application
// message's WhatsApp number, and the Community/Petromin rule on application tags.

const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#4aa8f8', locked: true, auto_grant: false },
  { id: 'tag_petromin', slug: 'petromin', name: 'Petromin', color: '#d6202a', locked: true, auto_grant: false },
];
const app = {
  id: 'a1', submissions: 1, height: 178, gender: 'male', nationality: 'Egypt', bike_type: 'Road', lang: 'en', ride_news: true,
  decided_at: null, decided_by: null, customer_id: null, existing_account: null, account_oauth: null, profession: 'Architect',
  status: 'pending', instagram: '', linkedin: '', name: 'Zaid Older', email: 'zaid@example.test', phone: '+966552468011',
  whatsapp_same: false, whatsapp: '+966559990000', birth_date: '1980-01-01', workplace: 'Sela',
  created_at: '2026-09-20T08:00:00Z', updated_at: '2026-09-20T08:00:00Z',
};

async function boot(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await stubSupabase(page, {
    sessions: [], queue_entries: [], bikes: [], tags, community_applications: [app],
    customers: [{ id: 'cx', name: 'Huda Member', email: 'huda@example.test', phone: '+966552468099' }],
    customer_tags: [{ customer_id: 'cx', tag_id: 'tag_saturday', added_by: 'staff', added_at: 1 }],
    site_content: [{ key: 'community.form', value: { q: { profession: { on: true, req: false } } } }],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.evaluate(`setStaffTab('community');setCommTab('applications')`);
  await expect(page.locator('.ca-row')).toHaveCount(1);
}

test.describe('@bh14 s08', () => {
  test('the form questions read as saved after the account editor has been opened and closed', async ({ page }) => {
    await boot(page);
    // the account editor kept its state in S._cf too: closing it left null there, and the questions read all-default
    await page.evaluate(`showNewAcctModal();closeCustFormModal()`);
    await page.getByRole('button', { name: 'Customize' }).click();
    const set = page.locator('.ap-set');
    await set.getByRole('button', { name: 'Form questions' }).click();
    const prof = set.locator('.cf-row[data-cf="profession"]');
    await expect(prof.locator('input').nth(0)).toBeChecked();
    await expect(prof.locator('input').nth(1)).not.toBeChecked(); // optional, as saved (the default is required)
    // and opening the editor now keeps its own state
    await page.evaluate(`showNewAcctModal()`);
    expect(await page.evaluate(`S._cf&&S._cf.mode`)).toBe('create');
    await page.evaluate(`closeCustFormModal()`);
  });

  test('the application message goes to the WhatsApp number the applicant gave', async ({ page }) => {
    await boot(page);
    await page.evaluate(`_caMsgShow(_caFind('a1'),'reject',{})`);
    await expect(page.locator('#confirm-modal .ca-wa')).toHaveAttribute('href', /wa\.me\/966559990000\?/);
  });

  test('a birthday member with only a WhatsApp number of their own gets the wish button', async ({ page }) => {
    await boot(page);
    const html = await page.evaluate(`_bdWishHtml({id:'w1',name:'Wafa',phone:'',whatsapp_same:false,whatsapp:'+966551112222'},2026)`);
    expect(html).toContain('class="bd-wa"');
    expect(html).toContain('wa.me/966551112222');
  });

  test('a rejection\'s Petromin tag is not given to a Community member', async ({ page }) => {
    await boot(page);
    const writes: string[] = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /customer_tags/.test(r.url())) writes.push(r.url()); });
    await page.evaluate(`_caGiveTags('cx','Huda Member',['tag_petromin'],false)`);
    await expect(page.locator('.toast').last()).toContainText('never both');
    expect(writes).toHaveLength(0);
  });
});
