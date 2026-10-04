import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// The Bookings page's report builder, pointed at accounts: every field an account carries
// as a column, a filter on each of them — the tag above all — summaries drawn as charts,
// and the result as a printed sheet or a CSV.

const now = Date.now();
const day = 86400000;
const tags = [
  { id: 'tag_saturday', slug: 'saturday', name: 'Community', color: '#00e585', locked: true },
  { id: 'tag_vip', slug: 'vip', name: 'VIP', color: '#ff0000' },
];
const customer_tags = [
  { customer_id: 'c1', tag_id: 'tag_saturday', added_at: now - 30 * day, expires_at: null, starts_at: null },
  { customer_id: 'c2', tag_id: 'tag_saturday', added_at: now - 400 * day, expires_at: now - 10 * day, starts_at: null }, // expired
  { customer_id: 'c3', tag_id: 'tag_vip', added_at: now - 5 * day, expires_at: null, starts_at: null },
];
const customers = [
  { id: 'c1', name: 'Amal Member', email: 'amal@example.test', phone: '0500000001', gender: 'female', birth_date: '1990-05-05', country: 'Saudi Arabia', city: 'Jeddah', height: 165, type_preference: 'Road', created_at: '2026-08-20T10:00:00Z', default_pay: 'normal' },
  { id: 'c2', name: 'Bader Lapsed', email: 'bader@example.test', phone: '0500000002', gender: 'male', birth_date: '2010-01-01', country: 'Saudi Arabia', city: 'Riyadh', height: 180, type_preference: 'Hybrid', created_at: '2025-01-05T10:00:00Z', default_pay: 'house' },
  { id: 'c3', name: 'Cara Vip', email: 'cara@example.test', phone: '0500000003', gender: 'female', birth_date: '1975-01-01', country: 'UK', city: 'London', height: 170, type_preference: 'Mountain', created_at: '2026-09-01T10:00:00Z', default_pay: 'normal' },
  { id: 'c4', name: 'Dan Untagged', email: 'dan@example.test', phone: '0500000004', gender: 'male', birth_date: '', country: '', city: 'Jeddah', height: null, type_preference: 'Any', created_at: '2026-07-01T10:00:00Z' },
];
const sessions = [
  { id: '2026-08-22', day: 'Saturday', session_date: '2026-08-22', capacity: 20, status: 'closed', created_at: 1, event_kind: 'community', ride_kind: 'saturday', needs_approval: true, spots: 20, bike_slots: '{"_time":"05:30 - 06:00"}' },
  { id: '2026-08-25', day: 'Tuesday', session_date: '2026-08-25', capacity: 12, status: 'closed', created_at: 2, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' },
  { id: '2099-01-10', day: 'Saturday', session_date: '2099-01-10', capacity: 12, status: 'open', created_at: 3, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' },
];
const row = (id: string, cust: string, sess: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, customer_id: cust, session_id: sess, session_day: 'Saturday', session_date: sess, queue_num: 1, name: cust,
  type_preference: 'Road', size: 'M', status, paid: status === 'done', price: 75, registered_at: '2026-08-01T10:00:00Z', ...extra,
});
const queue_entries = [
  row('q1', 'c1', '2026-08-22', 'done', { ride_duration: 40, price: 0 }),   // a community ride
  row('q2', 'c1', '2026-08-25', 'done', { ride_duration: 50 }),
  row('q3', 'c1', '2099-01-10', 'waiting'),                                  // upcoming
  row('q4', 'c2', '2026-08-25', 'noshow'),
  row('q5', 'c3', '2026-08-25', 'cancelled'),
];
const fixtures = { sessions, queue_entries, bikes: [], customers, tags, customer_tags };

async function staff(page: import('@playwright/test').Page) {
  await stubSupabase(page, fixtures);
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getCustomers().length===4`);
  await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
}

test('the Accounts panel offers the report builder, with columns, summaries, filters and both formats', async ({ page }) => {
  await staff(page);
  await page.getByRole('button', { name: /Account report/ }).click();
  const m = page.locator('#print-opts-modal');
  await expect(m).toContainText('Columns');
  await expect(m).toContainText('Summaries & charts');
  await expect(m).toContainText('Filters');
  await expect(m).toContainText('PDF / Print');
  await expect(m).toContainText('Excel (CSV)');
  await expect(m.locator('#acr-count')).toContainText('4 / 4');
  // every profile field, tag field and history figure is on offer as a column
  for (const lbl of ['Tags', 'Tag since', 'Age', 'Country of residence', 'Nationality', 'City', 'Joined', 'Rides completed', 'Community rides', 'Upcoming', 'No-Show', 'Last ride', 'Spent (SAR)', 'Default payment'])
    await expect(m).toContainText(lbl);
});

test('the tag filter reads live tags only — an expired Community tag does not count', async ({ page }) => {
  await staff(page);
  const ids = (f: string) => page.evaluate(`(()=>{const o=_accOpts();Object.assign(o,${f});return _accRows().map(r=>r.c.id);})()`);
  expect(await ids(`{fTag:'tag_saturday'}`)).toEqual(['c1']);
  expect(await ids(`{fTag:'any'}`)).toEqual(['c1', 'c3']);
  expect(await ids(`{fTag:'none'}`)).toEqual(['c2', 'c4']);
});

test('every other filter narrows the list as it says', async ({ page }) => {
  await staff(page);
  const ids = (f: string) => page.evaluate(`(()=>{S._accOpts=null;const o=_accOpts();Object.assign(o,${f});return _accRows().map(r=>r.c.id);})()`);
  expect(await ids(`{fGender:'female'}`)).toEqual(['c1', 'c3']);
  expect(await ids(`{fAge:'u18'}`)).toEqual(['c2']);
  expect(await ids(`{fAge:'45'}`)).toEqual(['c3']);
  expect(await ids(`{fCountry:'UK'}`)).toEqual(['c3']);
  expect(await ids(`{fCity:'Jeddah'}`)).toEqual(['c1', 'c4']);
  expect(await ids(`{fType:'Hybrid'}`)).toEqual(['c2']);
  expect(await ids(`{fRides:'rode'}`)).toEqual(['c1']);
  expect(await ids(`{fRides:'never'}`)).toEqual(['c2', 'c3', 'c4']);
  expect(await ids(`{fActive:'inactive'}`)).toEqual(['c2', 'c3', 'c4']);
  expect(await ids(`{fUpcoming:'yes'}`)).toEqual(['c1']);
  expect(await ids(`{fPay:'house'}`)).toEqual(['c2', 'c3']); // a VIP is on the house whatever default_pay says, as the Pay column shows
  expect(await ids(`{sort:'rides'}`)).toEqual(['c1', 'c2', 'c3', 'c4']);
});

test('the cells carry the profile, the tags and the aggregated history', async ({ page }) => {
  await staff(page);
  const c1 = await page.evaluate(`_accRows().find(r=>r.c.id==='c1').cells`) as Record<string, string>;
  expect(c1.name).toBe('Amal Member');
  expect(c1.tags).toBe('Community');
  expect(c1.gender).toBe('Female');
  expect(c1.age).toBe(String(new Date().getFullYear() - 1990 - (new Date() < new Date(new Date().getFullYear(), 4, 5) ? 1 : 0)));
  expect(c1.bookings).toBe('3');
  expect(c1.rides).toBe('2');
  expect(c1.commRides).toBe('1');
  expect(c1.upcoming).toBe('1');
  expect(c1.minutes).toBe('90');
  expect(c1.spent).toBe('75');
  expect(c1.lastRide).toContain('2026');
  expect(c1.height).toBe('165 cm');
  const c2 = await page.evaluate(`_accRows().find(r=>r.c.id==='c2').cells`) as Record<string, string>;
  expect(c2.tags).toBe('');            // expired: not a live tag
  expect(c2.noshows).toBe('1');
  expect(c2.pay).toBe('On the house');
});

test('a tag pill on the list seeds the builder with that tag', async ({ page }) => {
  await staff(page);
  await page.evaluate(`S.amTagFilter='tag_vip';renderCommunity();showAccountReportOptions()`);
  await expect(page.locator('#print-opts-modal #acr-count')).toContainText('1 / 4');
  expect(await page.evaluate(`_accOpts().fTag`)).toBe('tag_vip');
});

test('the printed sheet carries the chosen columns, the chosen summaries as charts, and the tag breakdown', async ({ page }) => {
  await staff(page);
  await page.evaluate(`const o=_accOpts();o.cols.spent=1;o.chartsOn.city=1;o.charts.city='hbar';o.charts.tags='donut';o.charts.joined='line'`);
  const html = await page.evaluate(`_accReportHtml()`) as string;
  expect(html).toContain('Account report');
  expect(html).toContain('Spent (SAR)');
  expect(html).toContain('Amal Member');
  expect(html).toContain('Accounts by tag');
  expect(html).toContain('Sign-ups by month');
  expect(html).toContain('By city');
  expect(html).toContain('Tag breakdown');
  expect((html.match(/<svg /g) || []).length).toBeGreaterThanOrEqual(5);
  expect(html).toContain('#2a78d6');      // donut slices wear the categorical hues…
  expect(html).toContain('#0c7a3d');      // …and single-series marks the brand green
  // "table only" draws no chart for that summary but keeps its numbers
  await page.evaluate(`_accOpts().charts.tags='table';_accOpts().charts.gender='table'`);
  const html2 = await page.evaluate(`_accReportHtml()`) as string;
  expect(html2).toContain('Accounts by tag');
  expect(html2).not.toContain('#2a78d6');
});

test('the breakdowns count the accounts on the list', async ({ page }) => {
  await staff(page);
  const bd = (k: string) => page.evaluate(`_accBreakdown('${k}',_accRows(),_accOpts())`);
  expect(await bd('gender')).toEqual([{ label: 'Female', value: 2 }, { label: 'Male', value: 2 }]);
  expect(await bd('tags')).toEqual([{ label: 'No tag', value: 2 }, { label: 'Community', value: 1 }, { label: 'VIP', value: 1 }]);
  expect(await bd('rides')).toEqual([{ label: 'No rides', value: 3 }, { label: '1-4 rides', value: 1 }]);
  expect((await bd('joined') as { label: string; value: number }[]).length).toBe(12);
  expect(await bd('city')).toEqual([{ label: 'Jeddah', value: 2 }, { label: 'London', value: 1 }, { label: 'Riyadh', value: 1 }]);
});

test('the CSV carries the columns, then the chosen summaries as blocks', async ({ page }) => {
  await staff(page);
  const csv = await page.evaluate(`(()=>{let out='';const _c=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';
    const _a=document.createElement.bind(document);document.createElement=(tag)=>{const el=_a(tag);if(tag==='a')el.click=()=>{};return el;};
    const _B=window.Blob;window.Blob=function(parts,o){out=parts.join('');return new _B(parts,o);};
    exportAccountsCsv();window.Blob=_B;document.createElement=_a;URL.createObjectURL=_c;return out;})()`) as string;
  expect(csv).toContain('Name,Email,Phone,Tags');
  expect(csv).toContain('Amal Member,amal@example.test');
  expect(csv).toContain('Accounts by tag,#,Share');
  expect(csv).toContain('Community,1,25%');
});

test('choices persist on the device and reset restores the defaults', async ({ page }) => {
  await staff(page);
  await page.evaluate(`showAccountReportOptions();_accToggle('cols','spent');_accSet('fGender','male')`);
  await page.reload();
  await waitForSb(page);
  await page.waitForFunction(`getCustomers().length===4`);
  expect(await page.evaluate(`(()=>{const o=_accOpts();return [o.cols.spent,o.fGender];})()`)).toEqual([1, 'male']);
  await page.evaluate(`_accReset()`);
  expect(await page.evaluate(`(()=>{const o=_accOpts();return [o.cols.spent,o.fGender];})()`)).toEqual([0, 'all']);
});

// Active in the last 14 days: a booking (not cancelled) whose session fell in the window, or
// one made in the window. Shown per account as a column, usable as a filter, drawn as a
// summary, and counted in the totals.
test('active in the last 14 days: column, filter, breakdown and count', async ({ page }) => {
  const iso = (d: number) => new Date(now - d * day).toISOString().slice(0, 10);
  const sess = (d: string) => ({ id: d, day: 'Tuesday', session_date: d, capacity: 12, status: 'closed', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' });
  const sessions14 = [sess(iso(3)), sess(iso(40)), sess('2099-01-10')];
  const q = [
    row('a1', 'c1', iso(3), 'done', { registered_at: iso(20) + 'T10:00:00Z' }),            // rode three days ago
    row('a2', 'c2', '2099-01-10', 'waiting', { registered_at: iso(2) + 'T10:00:00Z' }),   // booked two days ago
    row('a3', 'c3', iso(40), 'done', { registered_at: iso(45) + 'T10:00:00Z' }),          // last ride 40 days ago
    row('a4', 'c4', iso(5), 'cancelled', { registered_at: iso(6) + 'T10:00:00Z' }),       // cancelled: not active
  ];
  await stubSupabase(page, { customers, tags, customer_tags, sessions: sessions14, queue_entries: q });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0 && getQueue().length>0');
  await page.evaluate('localStorage.removeItem("cq_acc_rep_opts"); S._accOpts=null;');

  const cells = await page.evaluate(`_accRows().map(r=>[r.c.id,r.cells.active14])`) as [string, string][];
  expect(Object.fromEntries(cells)).toEqual({ c1: 'Yes', c2: 'Yes', c3: 'No', c4: 'No' });

  expect(await page.evaluate(`_accBreakdown('active14',_accRows(),_accOpts())`)).toEqual([{ label: 'Yes', value: 2 }, { label: 'No', value: 2 }]);

  await page.evaluate(`_accSet('fActive','14')`);
  expect(await page.evaluate(`_accRows().map(r=>r.c.id).sort()`)).toEqual(['c1', 'c2']);
  await page.evaluate(`_accSet('fActive','14no')`);
  expect(await page.evaluate(`_accRows().map(r=>r.c.id).sort()`)).toEqual(['c3', 'c4']);
  await page.evaluate(`_accSet('fActive','all')`);

  const sheet = await page.evaluate(`_accReportHtml()`) as string;
  expect(sheet).toContain('Active last 14 days');
  expect(sheet).toContain('Active (14 days)');
});

// The same yes/no, over 30 days: a rider whose last booking was 20 days ago is out of the
// 14-day window but inside the 30-day one.
test('active in the last 30 days: column, filter, breakdown and count', async ({ page }) => {
  const iso = (d: number) => new Date(now - d * day).toISOString().slice(0, 10);
  const sess = (d: string) => ({ id: d, day: 'Tuesday', session_date: d, capacity: 12, status: 'closed', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00","_total":12}' });
  const sessions30 = [sess(iso(3)), sess(iso(20)), sess(iso(40))];
  const q = [
    row('a1', 'c1', iso(3), 'done', { registered_at: iso(10) + 'T10:00:00Z' }),    // rode three days ago
    row('a2', 'c2', iso(20), 'done', { registered_at: iso(25) + 'T10:00:00Z' }),   // rode 20 days ago: 30-day yes, 14-day no
    row('a3', 'c3', iso(40), 'done', { registered_at: iso(45) + 'T10:00:00Z' }),   // last ride 40 days ago
    row('a4', 'c4', iso(5), 'cancelled', { registered_at: iso(6) + 'T10:00:00Z' }), // cancelled: not active
  ];
  await stubSupabase(page, { customers, tags, customer_tags, sessions: sessions30, queue_entries: q });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0 && getQueue().length>0');
  await page.evaluate('localStorage.removeItem("cq_acc_rep_opts"); S._accOpts=null;');

  const cells = await page.evaluate(`_accRows().map(r=>[r.c.id,r.cells.active30+'/'+r.cells.active14])`) as [string, string][];
  expect(Object.fromEntries(cells)).toEqual({ c1: 'Yes/Yes', c2: 'Yes/No', c3: 'No/No', c4: 'No/No' });

  expect(await page.evaluate(`_accBreakdown('active30',_accRows(),_accOpts())`)).toEqual([{ label: 'Yes', value: 2 }, { label: 'No', value: 2 }]);

  await page.evaluate(`_accSet('fActive','30')`);
  expect(await page.evaluate(`_accRows().map(r=>r.c.id).sort()`)).toEqual(['c1', 'c2']);
  await page.evaluate(`_accSet('fActive','30no')`);
  expect(await page.evaluate(`_accRows().map(r=>r.c.id).sort()`)).toEqual(['c3', 'c4']);
  await page.evaluate(`_accSet('fActive','all')`);

  const sheet = await page.evaluate(`_accReportHtml()`) as string;
  expect(sheet).toContain('Active last 30 days');
  expect(sheet).toContain('Active (30 days)');
});

// Accounts made before signup asked for a gender have none. The Community row offers it in
// one tap, the Edit form carries the toggle too, and the report can list the ones still unset.
test('an account with no gender can be given one from the Community row, and listed', async ({ page }) => {
  const custs = customers.map(c => (c.id === 'c4' ? { ...c, gender: null } : c));
  await stubSupabase(page, { customers: custs, tags, customer_tags, sessions, queue_entries: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('getCustomers().length>0');
  await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;setStaffTab('community');S.communityTab='accounts';renderCommunity()`);

  expect(await page.evaluate(`(()=>{const o=_accOpts();o.fGender='unset';const ids=_accRows().map(r=>r.c.id);o.fGender='all';return ids;})()`)).toEqual(['c4']);

  const ask = page.locator('.am-gender');
  await expect(ask).toHaveCount(1);
  await expect(ask).toContainText('Gender not set');
  const patches: string[] = [];
  page.on('request', r => { if (r.method() === 'PATCH' && /customers/.test(r.url())) patches.push(r.postData() || ''); });
  await ask.getByRole('button', { name: 'Male', exact: true }).click();
  await expect(page.locator('.am-gender')).toHaveCount(0);
  expect(patches.some(p => /"gender":"male"/.test(p))).toBe(true);
  expect(await page.evaluate(`getCustomers().find(c=>c.id==='c4').gender`)).toBe('male');

  // The Edit form shows the toggle for an existing account too, with the saved value selected.
  await page.evaluate(`showEditCustomerModal('c4')`);
  await expect(page.locator('#cust-form-modal, .modal-box').getByRole('button', { name: 'Male', exact: true })).toHaveClass(/active/);
});

// ── Nationality: how many, and which ─────────────────────────────────────────
// A rider base drawn from thirty countries says nothing at seven named rows, so the
// nationality breakdown carries its own depth and the rest folds into one Other. Beside it,
// the plain count of how many different nationalities the list holds.

test.describe('the nationality breakdown', () => {
  // 25 nationalities: the first twenty at descending weights, five more with one rider each.
  const NATS = ['Saudi Arabia', 'Egypt', 'India', 'Pakistan', 'Sudan', 'Yemen', 'Syria', 'Jordan', 'Philippines', 'Bangladesh',
    'Nepal', 'Nigeria', 'Morocco', 'Tunisia', 'Lebanon', 'Palestine', 'Somalia', 'Turkey', 'Indonesia', 'Sri Lanka',
    'Kenya', 'Ghana', 'Ethiopia', 'Uganda', 'Chad'];
  const many: Record<string, unknown>[] = [];
  NATS.forEach((nat, i) => {
    const n = i < 20 ? 21 - i : 1;                       // 21, 20, 19 … down to 2, then five singles
    for (let k = 0; k < n; k++) many.push({ id: `n${i}_${k}`, name: `Rider ${i}-${k}`, email: `n${i}_${k}@example.test`, nationality: nat, created_at: '2026-08-20T10:00:00Z' });
  });
  many.push({ id: 'nBlank', name: 'No Nationality', email: 'blank@example.test', nationality: '', created_at: '2026-08-20T10:00:00Z' });

  async function open(page: import('@playwright/test').Page) {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [], customers: many, tags: [], customer_tags: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`getCustomers().length===${many.length}`);
    await page.evaluate(`localStorage.removeItem('cq_acc_rep_opts');S._accOpts=null;setStaffTab('community');S.communityTab='accounts';renderCommunity()`);
  }

  test('names the top twenty and folds the rest into one Other', async ({ page }) => {
    await open(page);
    const items = await page.evaluate(`_accBreakdown('nationality',_accRows(),_accOpts())`) as { label: string; value: number }[];
    expect(items).toHaveLength(21);                       // twenty named, then Other
    expect(items[0]).toEqual({ label: 'Saudi Arabia', value: 21 });
    expect(items[19].label).toBe('Sri Lanka');
    expect(items[20].label).toBe('Other');
    // Other is the five one-rider nationalities plus the account with none recorded
    expect(items[20].value).toBe(6);
    expect(items.reduce((s, x) => s + x.value, 0)).toBe(many.length);
  });

  test('the depth is a choice: ten, fifty or all of them', async ({ page }) => {
    await open(page);
    const at = async (n: number) => {
      await page.evaluate(`_accSetNatTop(${n})`);
      return page.evaluate(`_accBreakdown('nationality',_accRows(),_accOpts()).map(x=>x.label)`) as Promise<string[]>;
    };
    expect(await at(10)).toHaveLength(11);
    expect((await at(10))[10]).toBe('Other');
    expect(await at(50)).toHaveLength(26);                // 25 nationalities + the unknown
    expect(await at(50)).not.toContain('Other');          // nothing left to fold
    expect(await at(0)).toHaveLength(26);                 // all of them
  });

  test('the count of different nationalities is its own tile, and rides along in the CSV', async ({ page }) => {
    await open(page);
    expect(await page.evaluate(`_accNatCount(_accRows())`)).toBe(25);   // the blank is not a nationality
    // Off by default, so an existing report is unchanged
    expect(await page.evaluate(`_accOpts().sections.natCount`)).toBeFalsy();
    expect(await page.evaluate(`_accReportHtml()`)).not.toContain('Nationalities</span>');
    await page.evaluate(`_accToggle('sections','natCount')`);
    const sheet = await page.evaluate(`_accReportHtml()`) as string;
    expect(sheet).toContain('>25</span><span class="total-lbl">Nationalities</span>');
    const csv = await page.evaluate(`(()=>{let out='';const _B=window.Blob;window.Blob=function(p){out=p.join('');return new _B(p,{type:'text/plain'});};
      const _a=document.createElement.bind(document);document.createElement=(t)=>t==='a'?{click(){},set href(v){},set download(v){}}:_a(t);
      const _c=URL.createObjectURL;URL.createObjectURL=()=>'blob:x';
      exportAccountsCsv();window.Blob=_B;document.createElement=_a;URL.createObjectURL=_c;return out;})()`) as string;
    expect(csv).toContain('Nationalities,25');
  });

  test('the builder offers all three: the count, the depth and the pie', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: /Account report/ }).click();
    const m = page.locator('#print-opts-modal');
    await expect(m.getByRole('button', { name: 'Nationality count' })).toBeVisible();
    const depth = m.locator('#acr-nat-top');
    await expect(depth).toBeDisabled();                          // no nationality chart, nothing to deepen
    await m.locator('[data-rep="chartsOn:nationality"]').click();
    await expect(depth).toBeEnabled();
    await expect(depth).toHaveValue('20');
    await expect(m).toContainText('Nationalities named before Other');
    await expect(m.locator('[aria-label="Nationality"] option', { hasText: 'Pie' })).toHaveCount(1);
    await depth.selectOption('50');
    expect(await page.evaluate(`_accOpts().natTop`)).toBe(50);
  });

  test('a pie is one of the shapes, and every slice has a colour of its own', async ({ page }) => {
    await open(page);
    await page.evaluate(`_accToggle('chartsOn','nationality');_accSetChart('nationality','pie')`);
    const svg = await page.evaluate(`_accSvg('pie',_accBreakdown('nationality',_accRows(),_accOpts()))`) as string;
    expect(svg.startsWith('<svg')).toBe(true);
    const fills = [...svg.matchAll(/fill="([^"]+)"/g)].map(m => m[1]);
    expect(fills).toHaveLength(21);                       // one wedge per row of the table
    expect(new Set(fills).size).toBe(21);                 // and no two the same
    // The printed figure pairs it with the table that carries the names and the shares.
    const fig = await page.evaluate(`_accFigure('nationality',_accBreakdown('nationality',_accRows(),_accOpts()),'pie')`) as string;
    expect(fig).toContain('Saudi Arabia');
    expect(fig).toContain('Other');
    expect(fig.match(/<tr>/g) || []).toHaveLength(22);   // the header, then a row per slice
  });
});
