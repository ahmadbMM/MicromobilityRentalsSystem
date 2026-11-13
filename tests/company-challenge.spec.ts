import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb } from './helpers/supabase';

// Company challenge, totals only (new features build F26; the owner marked it Build now on 2026-11-13). Staff make a
// company's challenge (its name, a join code, the first and last day, a minimum team size, 5 unless they say
// otherwise); a rider joins with the code on Account > Company challenge, or with a link that holds it, and sees how
// many are taking part and their sessions together only from the minimum team size up, and their own count. Nothing a
// rider reads names a colleague or holds one colleague's count (members see nobody, 2026-11-04). Once the last day has
// passed, everyone with a finished session holds the Company Challenge badge. Migration 20261114012600.

const sessions = [{ id: '2099-01-01', session_date: '2099-01-01', day: 'Sunday', status: 'open', capacity: 20, created_at: 1 }];
const profile = { id: 'c1', name: 'Sara Khalid', email: 'sara@example.com', phone: '+966500000001', height: 168, birth_date: '1994-03-02', country: 'Saudi Arabia', city: 'Jeddah', nationality: 'Saudi Arabia', gender: 'female', type_preference: 'Hybrid' };
const ch = (o: Record<string, unknown> = {}) => ({ id: 7, company: 'Petromin', starts_on: '2026-11-01', ends_on: '2026-11-30', state: 'on', team: 12, sessions: 31, mine: 3, badge: false, ...o });
const mine = (...rows: Record<string, unknown>[]) => ({ ok: true, open: true, rows });
const SQL = readFileSync(resolve(__dirname, '../supabase/migrations/20261114012600_company_challenge.sql'), 'utf8');
// One function's text in the migration, from its "create or replace" to the end of its body.
const fnBody = (name: string) => {
  const at = SQL.indexOf(`create or replace function public.${name}(`);
  expect(at, name).toBeGreaterThan(-1);
  return SQL.slice(at, SQL.indexOf('$function$;', at));
};

async function rider(page: Page, fx: Record<string, unknown> = {}, path = '/') {
  await stubSupabase(page, {
    sessions, queue_entries: [],
    'rpc:customer_profile': [profile], 'rpc:customer_about': [{ profession: 'Architect', workplace: 'Design Co', heard_from: 'instagram' }],
    'rpc:customer_deletion_request': { requested_at: null },
    ...fx,
  });
  await loginCustomer(page, profile);
  await page.goto(path);
  await waitForSb(page);
  if (path === '/') await page.evaluate(`setCustTab('account')`);
}
const sent = (page: Page, rpc: string) => {
  const calls: Record<string, unknown>[] = [];
  page.on('request', (r) => { if (r.url().endsWith(`/rpc/${rpc}`)) calls.push(JSON.parse(r.postData() || '{}')); });
  return calls;
};
const at = (page: Page) => new URL(page.url()).pathname;
const row = (page: Page) => page.locator('#acc-r-company');
const host = (page: Page) => page.locator('#acc-co-host');
const nums = (page: Page, id = 7) => page.locator(`[data-coch="${id}"] .coch-num`);

test.describe('@customer:account company challenge: the row, joining, the card', () => {
  test('the row shows once the read has answered, with the company a rider joined; its page is fetched only when opened', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (r) => { const p = new URL(r.url()).pathname; if (p === '/company-challenge.js') asked.push(r.url()); });
    await rider(page, { 'rpc:company_challenge_mine': mine(ch()) });
    await expect(row(page)).toBeVisible();
    await expect(row(page).locator('.acc-row-t')).toHaveText('Company challenge');
    await expect(page.locator('#acc-v-company')).toHaveText('Petromin');
    expect(asked).toEqual([]); // the menu alone carries none of the page
    await row(page).click();
    expect(at(page)).toBe('/account/company');
    await expect(host(page).locator('[data-coch="7"] .coch-name')).toHaveText('Petromin');
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/\/company-challenge\.js\?v=[0-9a-f]{10}$/); // the build's stamp, past the cache-first worker
    await expect(page.locator('#acc-pg-company-h')).toHaveText('Company challenge');
  });

  test('a database without the function, or one that answers nothing, shows no row and says nothing', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await rider(page, { 'rpc:company_challenge_mine': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.company_challenge_mine in the schema cache' } } });
    await expect(page.locator('#acc-r-personal')).toBeVisible();
    await expect(row(page)).toBeHidden();
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
    expect(await page.evaluate(`S._cochGone`)).toBe(true);
    // its address then leads to the menu, not to an empty page
    await page.evaluate(`setCustTab('account','company')`);
    await expect(page.locator('#acc-pg-company')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('the generic stub (no answer of its shape) keeps the row away too', async ({ page }) => {
    await rider(page);
    await expect(page.locator('#acc-r-personal')).toBeVisible();
    await expect(row(page)).toBeHidden();
  });

  test('no challenge to join and none of the rider\'s own: no row; one of their own that has ended still shows', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': { ok: true, open: false, rows: [] } });
    await expect(page.locator('#acc-r-personal')).toBeVisible();
    await expect.poll(() => page.evaluate(`!!(S._coch&&S._coch.rows&&!S._coch.busy)`)).toBe(true);
    await expect(row(page)).toBeHidden();
    await page.evaluate(`S._coch={id:'c1',busy:false,at:Date.now(),open:false,rows:[{id:8,company:'Petrolube',starts_on:'2026-09-01',ends_on:'2026-09-30',state:'ended',team:null,sessions:null,mine:1,badge:true}]};_cochPaint()`);
    await expect(row(page)).toBeVisible();
    await expect(page.locator('#acc-v-company')).toHaveText('Petrolube');
  });

  test('join by code: the code typed is sent tidied, the card appears and the row names the company', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(), 'rpc:company_challenge_join': { ...mine(ch({ team: null, sessions: null, mine: 0 })), joined: 7 } });
    const calls = sent(page, 'company_challenge_join');
    await expect(row(page)).toBeVisible();
    await expect(page.locator('#acc-v-company')).toHaveText('');
    await row(page).click();
    await expect(page.locator('label[for="coch-code"]')).toHaveText('Company code');
    await expect(host(page).locator('.coch-card')).toHaveCount(0);
    await page.locator('#coch-code').fill(' petro-26 ');
    await page.locator('#coch-join').click();
    await expect(host(page).locator('[data-coch="7"] .coch-name')).toHaveText('Petromin');
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_code: 'PETRO26' }]);
    await expect(page.locator('#coch-code')).toHaveValue('');
    await expect(page.locator('#coch-err')).toHaveText('');
    await expect(host(page).locator('.coch-dates')).toContainText('2026');
    await expect(page.locator('#acc-v-company')).toHaveText('Petromin'); // the menu's row, at once
  });

  test('Enter in the box joins; a code too short never leaves the device', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(), 'rpc:company_challenge_join': { ...mine(ch()), joined: 7 } });
    const calls = sent(page, 'company_challenge_join');
    await row(page).click();
    await page.locator('#coch-code').fill('ab');
    await page.locator('#coch-code').press('Enter');
    await expect(page.locator('#coch-err')).toHaveText('We do not know this code. Check it and try again.');
    expect(calls).toEqual([]);
    await page.locator('#coch-code').fill('petro26');
    await page.locator('#coch-code').press('Enter');
    await expect(host(page).locator('[data-coch="7"]')).toBeVisible();
    expect(calls).toHaveLength(1);
  });

  for (const [error, words] of [['code', 'We do not know this code. Check it and try again.'], ['ended', 'This challenge has ended.'], ['busy', 'Too many tries. Please wait ten minutes.'], ['denied', 'We could not do that. Please try again.']] as const) {
    test(`a refused join says why under the box and keeps the code: ${error}`, async ({ page }) => {
      await rider(page, { 'rpc:company_challenge_mine': mine(), 'rpc:company_challenge_join': { ok: false, error } });
      await row(page).click();
      await page.locator('#coch-code').fill('WRONG1');
      await page.locator('#coch-join').click();
      await expect(page.locator('#coch-err')).toHaveText(words);
      await expect(page.locator('#coch-code')).toHaveValue('WRONG1');
      await expect(page.locator('#coch-join')).toBeEnabled();
      await expect(host(page).locator('.coch-card')).toHaveCount(0);
    });
  }

  test('a join link: /?company=CODE comes off the address, opens the page once signed in and joins', async ({ page }) => {
    const calls = sent(page, 'company_challenge_join');
    await rider(page, { 'rpc:company_challenge_mine': mine(), 'rpc:company_challenge_join': { ...mine(ch()), joined: 7 } }, '/?company=petro-26');
    await expect(host(page).locator('[data-coch="7"] .coch-name')).toHaveText('Petromin');
    expect(calls).toEqual([{ p_id: 'c1', p_token: 'tok-spec', p_code: 'PETRO26' }]);
    expect(page.url()).not.toContain('company=');
    expect(at(page)).toBe('/account/company');
    expect(await page.evaluate(`localStorage.getItem('mm_co_code')`)).toBeNull(); // used once, whatever the answer
    await page.evaluate(`renderAccount()`);
    await expect(host(page).locator('[data-coch="7"]')).toBeVisible();
    expect(calls).toHaveLength(1);
  });

  test('its own address: /account/company, opened or reloaded, shows the page', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(ch()) }, '/account/company');
    await expect(host(page).locator('[data-coch="7"] .coch-name')).toHaveText('Petromin');
    await expect(page.locator('#coch-code')).toBeVisible();
    expect(at(page)).toBe('/account/company');
  });

  test('a join link opened signed out keeps the code on the device for the sign-in', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [] });
    await page.goto('/?company=petro26&lang=en');
    await waitForSb(page);
    expect(page.url()).not.toContain('company=');
    expect(await page.evaluate(`_cochParked()`)).toBe('PETRO26');
    expect(await page.evaluate(`sessionStorage.getItem('cq_open_tab')`)).toBe('account/company');
    // a code is letters and digits only, twelve at most; anything else in the link is dropped
    await page.goto('/?company=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    await waitForSb(page);
    expect(await page.evaluate(`_cochParked()`)).toBe('SCRIPTALERT1');
    // a sign-in that only ended keeps the code for the way back in; Log out drops it, so the next person on this
    // phone does not join the last one's company
    await page.evaluate(`doLogout(true)`);
    expect(await page.evaluate(`_cochParked()`)).toBe('SCRIPTALERT1');
    await page.evaluate(`doLogout()`);
    expect(await page.evaluate(`_cochParked()`)).toBe('');
  });

  test('totals hidden under the minimum team size: the card holds the rider\'s own count and nothing else', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(ch({ team: null, sessions: null, mine: 2 })) });
    await row(page).click();
    await expect(nums(page)).toHaveCount(1);
    await expect(nums(page).first()).toHaveAttribute('data-coch-n', 'mine');
    await expect(nums(page).first()).toContainText('2');
    await expect(nums(page).first()).toContainText('Your sessions');
    await expect(host(page)).not.toContainText('Taking part');
    await expect(host(page)).not.toContainText('Sessions together');
    await expect(host(page).locator('.coch-card .cu-card-sub6, .coch-card .label-hint')).toHaveCount(0); // and no line saying why
  });

  test('from the minimum up: how many are taking part, their sessions together, and the rider\'s own', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(ch({ team: 6, sessions: 14, mine: 2 })) });
    await row(page).click();
    await expect(nums(page)).toHaveCount(3);
    await expect(page.locator('[data-coch="7"] [data-coch-n="team"]')).toHaveText(/^6\s*Taking part$/);
    await expect(page.locator('[data-coch="7"] [data-coch-n="sessions"]')).toHaveText(/^14\s*Sessions together$/);
    await expect(page.locator('[data-coch="7"] [data-coch-n="mine"]')).toHaveText(/^2\s*Your sessions$/);
    // a total sent as anything but a number is not drawn
    await page.evaluate(`S._coch.rows=[{id:7,company:'Petromin',starts_on:'2026-11-01',ends_on:'2026-11-30',state:'on',team:'6',sessions:'14',mine:2,badge:false}];_cochRender()`);
    await expect(nums(page)).toHaveCount(1);
  });

  test('a sessions total under 10 is not sent: the card holds how many are taking part and the rider\'s own count', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(ch({ team: 5, sessions: null, mine: 2 })) });
    await row(page).click();
    await expect(nums(page)).toHaveCount(2);
    await expect(page.locator('[data-coch="7"] [data-coch-n="team"]')).toHaveText(/^5\s*Taking part$/);
    await expect(page.locator('[data-coch="7"] [data-coch-n="mine"]')).toHaveText(/^2\s*Your sessions$/);
    await expect(host(page)).not.toContainText('Sessions together');
  });

  test('no colleague on the page: whatever else an answer carried is never drawn', async ({ page }) => {
    const leaky = ch({ riders: [{ id: 'c9', name: 'Omar Zed', phone: '+966511111111', n: 9 }], names: ['Omar Zed'], top: 'Omar Zed', code: 'PETRO26', min_team: 5 });
    await rider(page, { 'rpc:company_challenge_mine': mine(leaky) });
    await row(page).click();
    await expect(host(page).locator('[data-coch="7"]')).toBeVisible();
    const text = await page.locator('#tab-account').innerText(), html = await page.locator('#tab-account').innerHTML();
    for (const s of ['Omar', '+966511111111', 'PETRO26']) { expect(text).not.toContain(s); expect(html).not.toContain(s); }
    expect(await page.locator('#tab-account [data-on-click*="c9"]').count()).toBe(0);
  });

  test('the badge at the end: shown from the start, in full once the challenge has ended and it is the rider\'s', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(ch(), ch({ id: 8, company: 'Petrolube', state: 'ended', starts_on: '2026-09-01', ends_on: '2026-09-30', badge: true, mine: 4 }), ch({ id: 9, company: 'Dukan', state: 'ended', badge: false, mine: 0 }), ch({ id: 10, company: 'Sela', state: 'soon', starts_on: '2099-01-01', ends_on: '2099-01-31', team: null, sessions: null, mine: 0 })) });
    await row(page).click();
    const card = (id: number) => page.locator(`[data-coch="${id}"]`);
    await expect(card(7).locator('.coch-badge')).toHaveText('Company Challenge');
    await expect(card(7).locator('.coch-badge')).not.toHaveClass(/coch-won/);
    await expect(card(7).locator('svg.coch-medal')).toHaveCount(1);
    await expect(card(7).locator('.coch-st')).toHaveCount(0);
    await expect(card(8).locator('.coch-badge')).toHaveClass(/coch-won/);
    await expect(card(8).locator('.coch-badge-ok')).toHaveText('Badge earned');
    await expect(card(8).locator('.coch-st')).toHaveText('Ended');
    await expect(card(9).locator('.coch-badge')).not.toHaveClass(/coch-won/);
    await expect(card(9).locator('.coch-badge-ok')).toHaveCount(0);
    await expect(card(10).locator('.coch-st')).toHaveText('Upcoming');
    await expect(page.locator('#acc-v-company')).toHaveText('Petromin · Petrolube · Dukan · Sela');
  });

  test('the badge is the app\'s own: worded in every language, held-only, and on Account > Badges once given', async ({ page }) => {
    const held = { slug: 'company_challenge', icon: 'briefcase', color: 'blue', name: 'Company Challenge', system: true, note: 'Petromin', at: '2026-12-01T00:30:00Z' };
    await rider(page, { 'rpc:company_challenge_mine': mine(), 'rpc:customer_my_badges': [held] });
    expect(await page.evaluate(`JSON.stringify(BD_SYS.company_challenge)`)).toBe('["briefcase","blue","bdgCompanyChallenge"]');
    expect(await page.evaluate(`BDG_HELD_ONLY.has('company_challenge')`)).toBe(true);
    const keys = ['bdgCompanyChallenge', 'bdgCompanyChallengeD', 'bdgCompanyChallengeA', 'cochTitle'];
    expect(await page.evaluate(`${JSON.stringify(keys)}.filter(k=>!LANG.en[k])`)).toEqual([]);
    for (const lang of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) { // the riders' own pack of each language
      const pack = JSON.parse(readFileSync(resolve(__dirname, `../lang/${lang}.json`), 'utf8')) as Record<string, string>;
      expect(keys.filter((k) => !pack[k]), lang).toEqual([]);
    }
    await page.evaluate(`_accSetView('badges')`);
    await expect(page.locator('#acc-pane-badges')).toContainText('Company Challenge');
  });

  test('the page\'s own words: ten languages each, and Arabic on the page', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(ch({ state: 'ended', badge: true })) });
    await row(page).click();
    await expect(host(page).locator('[data-coch="7"]')).toBeVisible();
    expect(await page.evaluate(`COCH_LANGS.join()`)).toBe('en,ar,fr,es,pt,ur,hi,tl,ne,bn');
    expect(await page.evaluate(`Object.entries(COCH_T).filter(([k,v])=>v.length!==10||v.some(x=>!String(x).trim())).map(([k])=>k)`)).toEqual([]);
    expect(await page.evaluate(`Object.values(COCH_T).flat().filter(x=>/[\\u0660-\\u0669\\u06F0-\\u06F9\\u0966-\\u096F\\u09E6-\\u09EF]/.test(x))`)).toEqual([]); // Latin digits everywhere
    await page.evaluate(`S.lang='ar';_cochRender()`);
    await expect(page.locator('label[for="coch-code"]')).toHaveText('رمز الشركة');
    await expect(page.locator('#coch-join')).toHaveText('انضم');
    await expect(page.locator('[data-coch="7"] [data-coch-n="team"]')).toContainText('المشاركون');
    await expect(page.locator('[data-coch="7"] .coch-badge-ok')).toHaveText('حصلت على الوسام');
    expect(await page.evaluate(`['fr','es','pt','ur','hi','tl','ne','bn'].map(l=>{S.lang=l;return _cochT('join')}).filter(x=>!x||x==='Join')`)).toEqual([]);
  });

  test('the box keeps what is being typed when the page is drawn again', async ({ page }) => {
    await rider(page, { 'rpc:company_challenge_mine': mine(ch()) });
    await row(page).click();
    await page.locator('#coch-code').pressSequentially('pet');
    await page.evaluate(`_cochPaint()`);
    await expect(page.locator('#coch-code')).toHaveValue('pet');
    await expect(page.locator('#coch-code')).toBeFocused();
  });
});

test.describe('@customer:account company challenge: what the database lets a rider read', () => {
  test('the two rider functions answer with a fixed set of fields: no name, no list, nobody else\'s count', () => {
    // every key of every jsonb_build_object in a function: its arguments at the top level, the even ones
    const keys = (body: string) => {
      const out = new Set<string>();
      for (let at = body.indexOf('jsonb_build_object('); at > -1; at = body.indexOf('jsonb_build_object(', at + 1)) {
        const args: string[] = [];
        let depth = 0, cur = '', quote = false;
        for (let i = at + 'jsonb_build_object('.length; i < body.length; i++) {
          const c = body[i];
          if (c === "'") quote = !quote;
          if (!quote && c === '(') depth++;
          if (!quote && c === ')') { if (depth === 0) break; depth--; }
          if (!quote && c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; } else cur += c;
        }
        args.push(cur.trim());
        args.forEach((a, i) => { if (i % 2 === 0) { expect(a, 'a key is a plain literal').toMatch(/^'[a-z_]+'$/); out.add(a.slice(1, -1)); } });
      }
      return [...out].sort();
    };
    const mineFn = fnBody('company_challenge_mine'), joinFn = fnBody('company_challenge_join');
    expect(keys(mineFn)).toEqual(['badge', 'company', 'ends_on', 'error', 'id', 'mine', 'ok', 'open', 'rows', 'sessions', 'starts_on', 'state', 'team']);
    expect(mineFn).toContain(`'open', exists (select 1 from company_challenges c where c.ends_on >= v_today)`); // a yes or no, about nobody
    expect(keys(joinFn)).toEqual(['error', 'joined', 'ok']);
    for (const body of [mineFn, joinFn]) {
      expect(body).toContain('_cust_token_ok(p_id, p_token)');
      expect(body).toMatch(/security definer/);
      expect(body).not.toMatch(/\b(name|phone|email|photo|joined_at|riders|to_jsonb|row_to_json)\b/);
      expect(body).not.toMatch(/\.\*\s*\)/); // no whole row built into the answer
    }
    // both totals only from the minimum team size up, the sessions total only from 10 (at 3 taking part, "mine 2,
    // together 2" would say both colleagues stand at 0), and the count the rider gets is their own person's
    expect(mineFn).toContain(`'team', case when v_team >= ch.min_team then v_team end`);
    expect(mineFn).toContain(`'sessions', case when v_team >= ch.min_team and v_sum >= 10 then v_sum end`);    expect(mineFn).toContain('filter (where p.pid = v_me)');
    // a minimum is never under 3, so a total is never one other person's number; 5 unless staff say otherwise
    expect(SQL).toContain('min_team    integer not null default 5 check (min_team between 3 and 500)');
    expect(fnBody('staff_company_challenge_save')).toContain('v_min not between 3 and 500');
  });

  test('the tables are closed to every client, and each function is granted to whom it is for', () => {
    for (const t of ['company_challenges', 'company_challenge_members']) {
      expect(SQL).toContain(`alter table public.${t} enable row level security;`);
      expect(SQL).toContain(`revoke all on public.${t} from public, anon, authenticated;`);
      expect(SQL).not.toMatch(new RegExp(`grant[^;]*on\\s+(table\\s+)?public\\.${t}\\b`, 'i'));
      expect(SQL).not.toMatch(new RegExp(`create policy[^;]*public\\.${t}\\b`, 'i'));
    }
    for (const f of ['company_challenge_mine(text, text)', 'company_challenge_join(text, text, text)']) {
      expect(SQL).toContain(`grant execute on function public.${f} to anon, authenticated;`);
    }
    for (const f of ['staff_company_challenges()', 'staff_company_challenge_save(bigint, text, text, date, date, integer)', 'staff_company_challenge_delete(bigint)', 'staff_company_challenge_remove(bigint, text)']) {
      expect(SQL).toContain(`revoke all on function public.${f} from public, anon;`);
      expect(SQL).toContain(`grant execute on function public.${f} to authenticated;`);
    }
    for (const f of ['_cc_people(bigint)', '_cc_award(bigint)']) expect(SQL).toContain(`revoke all on function public.${f} from public, anon, authenticated;`);
    expect(fnBody('staff_company_challenges')).toContain(`if not _staff_mod('community', false) then raise exception`);
    for (const f of ['staff_company_challenge_save', 'staff_company_challenge_delete', 'staff_company_challenge_remove']) expect(fnBody(f)).toContain(`if not _staff_mod('community', true) then raise exception`);
  });

  test('the badge at the end: one finished session or more, only once the last day has passed in Riyadh', () => {
    const award = fnBody('_cc_award');
    expect(award).toContain(`v_today date := (now() at time zone 'Asia/Riyadh')::date;`);
    expect(award).toContain('where c.ends_on < v_today and c.ends_on >= v_today - 45');
    expect(award).toContain(`select p.pid, 'bd_company_challenge', left(ch.company, 140), 'system'`);
    expect(award).toContain('where p.n >= 1');
    expect(award).toContain('on conflict do nothing');
    expect(fnBody('_cc_people')).toContain(`q.status = 'done'`);
    expect(SQL).toContain(`('bd_company_challenge', 'company_challenge', 'briefcase', 'blue', 'Company Challenge'`);
    expect(SQL).toContain(`cron.schedule('mm-company-challenge'`);
    // a wrong code is metered; a right one is not, so an office joining from one address is not locked out
    const join = fnBody('company_challenge_join');
    expect(join).toContain(`_ip_gate('cojoin', 20, interval '10 minutes')`);
    expect(join.indexOf('if v_id is null then')).toBeLessThan(join.indexOf(`_ip_gate('cojoin'`));
    expect(join).toContain(`if v_ends < v_today then return jsonb_build_object('ok', false, 'error', 'ended'); end if;`);
    expect(SQL).toContain(`values ('20261114012600', 'company_challenge')`);
  });
});

const customers = [
  { id: 'c1', name: 'Sara Khalid', email: 'sara@example.com', phone: '+966500000001', created_at: '2026-01-01T10:00:00Z' },
  { id: 'c2', name: 'Omar Zed', email: 'omar@example.com', phone: '+966500000002', created_at: '2026-01-02T10:00:00Z' },
];
const staffRows = [
  { id: 7, company: 'Petromin', code: 'PETRO26', starts_on: '2026-11-01', ends_on: '2099-11-30', min_team: 5, created_at: '2026-10-28T09:00:00Z', created_by: 'Spec Staff', awarded_at: null, team: 2, sessions: 5,
    riders: [{ id: 'c2', name: 'Omar Zed', phone: '+966500000002', joined_at: '2026-11-02T08:00:00Z', n: 4, badge: false }, { id: 'c1', name: 'Sara Khalid', phone: '+966500000001', joined_at: '2026-11-01T08:00:00Z', n: 1, badge: true }] },
  { id: 6, company: 'Dukan', code: 'DUKAN25', starts_on: '2025-01-01', ends_on: '2025-01-31', min_team: 3, created_at: '2024-12-20T09:00:00Z', created_by: 'Spec Staff', awarded_at: '2025-02-01T00:20:00Z', team: 0, sessions: 0, riders: [] },
];
async function staff(page: Page, fx: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], customers, tags: [], customer_tags: [], staff_options: [], 'rpc:staff_company_challenges': staffRows, ...fx });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction('(S.customers||[]).length===2');
  await page.evaluate(`setStaffTab('community');setCommTab('companies')`);
}
const view = (page: Page) => page.locator('#tab-community');
const crow = (page: Page, id: number) => page.locator(`#tab-community [data-cochs="${id}"]`);
const dlg = (page: Page) => page.locator('#mny-modal [role="dialog"]');

test.describe('@staff:people company challenges', () => {
  test('People > Recognition > Company challenges: each company with its days, code, link and totals', async ({ page }) => {
    await staff(page);
    expect(at(page)).toBe('/people/companies');
    await expect(view(page).locator('.ppl-sub .filter-pill.active')).toHaveText('Company challenges');
    await expect(view(page).locator('.filter-pill[data-ppl-grp="recognition"]')).toHaveClass(/active/);
    await expect(view(page).locator('[data-cochs]')).toHaveCount(2);
    await expect(crow(page, 7)).toContainText('Petromin');
    await expect(crow(page, 7)).toContainText('Running');
    await expect(crow(page, 7)).toContainText('Minimum team size 5');
    await expect(crow(page, 7)).toContainText('Join code PETRO26');
    await expect(crow(page, 7)).toContainText('experiences.micromobility.sa/?company=PETRO26');
    await expect(crow(page, 7).locator('.cochs-tot')).toHaveText('Taking part 2 · Sessions completed 5');
    await expect(crow(page, 6)).toContainText('Ended');
    await expect(page.locator('#cochs-new')).toHaveText('New company challenge');
    // on a phone a row's buttons sit under its lines, which keep the row's width
    const box = await crow(page, 7).locator('.cw-row-m').boundingBox(), whole = await crow(page, 7).boundingBox();
    expect(box!.width).toBeGreaterThan(Math.min(250, whole!.width * 0.6));
    expect(await page.evaluate(`document.documentElement.scrollWidth<=window.innerWidth+1`)).toBe(true);
  });

  test('New company challenge: the corporate nights\' companies are offered, the fields are checked, and Save sends them tidied', async ({ page }) => {
    await staff(page, { 'rpc:staff_company_challenge_save': { ok: true, id: 9 } });
    const calls = sent(page, 'staff_company_challenge_save');
    await page.locator('#cochs-new').click();
    await expect(dlg(page).locator('#cochs-d-t')).toHaveText('New company challenge');
    expect(await page.evaluate(`[...document.querySelectorAll('#cochs-cos option')].map(o=>o.value).join()`)).toBe('Petromin,Petrolube,Dukan');
    await expect(page.locator('#cochs-f-min')).toHaveValue('5');
    await expect(page.locator('#cochs-f-code')).toHaveValue(/^[A-Z2-9]{6}$/); // a code is offered, staff may type their own
    for (const [id, label] of [['company', 'Company'], ['code', 'Join code'], ['from', 'Start date'], ['to', 'End date'], ['min', 'Minimum team size']]) await expect(page.locator(`label[for="cochs-f-${id}"]`)).toHaveText(label);
    await page.locator('#cochs-save').click(); // no company, no end date
    await expect(dlg(page).locator('[role="alert"]')).toContainText('a team size of 3 to 500');
    expect(calls).toEqual([]);
    await page.locator('#cochs-f-company').fill('  Petromin   Express ');
    await page.locator('#cochs-f-code').fill('pmx2026');
    await page.locator('#cochs-f-from').fill('2026-12-01');
    await page.locator('#cochs-f-to').fill('2026-11-30');
    await page.locator('#cochs-save').click(); // the end before the start
    await expect(dlg(page).locator('[role="alert"]')).toBeVisible();
    await page.locator('#cochs-f-to').fill('2026-12-31');
    await page.locator('#cochs-f-min').fill('2');
    await page.locator('#cochs-save').click(); // a team of 2 would show one colleague's count
    await expect(dlg(page).locator('[role="alert"]')).toBeVisible();
    expect(calls).toEqual([]);
    await page.locator('#cochs-f-min').fill('8');
    await page.locator('#cochs-save').click();
    await expect(page.locator('#cochs-d-t')).toHaveCount(0);
    expect(calls).toEqual([{ p_id: null, p_company: 'Petromin Express', p_code: 'PMX2026', p_starts: '2026-12-01', p_ends: '2026-12-31', p_min: 8 }]);
  });

  test('a code another challenge has is said in the dialog, which stays open', async ({ page }) => {
    await staff(page, { 'rpc:staff_company_challenge_save': { ok: false, error: 'taken' } });
    await crow(page, 7).getByRole('button', { name: 'Edit' }).click();
    await expect(page.locator('#cochs-d-t')).toHaveText('Edit · Petromin');
    await expect(page.locator('#cochs-f-company')).toHaveValue('Petromin');
    await expect(page.locator('#cochs-f-code')).toHaveValue('PETRO26');
    await page.locator('#cochs-f-code').fill('DUKAN25');
    await page.locator('#cochs-save').click();
    await expect(dlg(page).locator('[role="alert"]')).toHaveText('Another challenge already uses this code.');
    await expect(page.locator('#cochs-f-code')).toHaveValue('DUKAN25');
  });

  test('Edit sends the challenge\'s id; Delete asks first and sends it', async ({ page }) => {
    await staff(page, { 'rpc:staff_company_challenge_save': { ok: true, id: 7 }, 'rpc:staff_company_challenge_delete': { ok: true } });
    const saves = sent(page, 'staff_company_challenge_save'), dels = sent(page, 'staff_company_challenge_delete');
    await crow(page, 7).getByRole('button', { name: 'Edit' }).click();
    await page.locator('#cochs-f-min').fill('10');
    await page.locator('#cochs-save').click();
    await expect(page.locator('#cochs-d-t')).toHaveCount(0);
    expect(saves).toEqual([{ p_id: 7, p_company: 'Petromin', p_code: 'PETRO26', p_starts: '2026-11-01', p_ends: '2099-11-30', p_min: 10 }]);
    await crow(page, 6).getByRole('button', { name: 'Edit' }).click();
    await page.locator('#cochs-f-company').fill('Dukan Stores');
    await dlg(page).getByRole('button', { name: 'Delete' }).click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Delete this company challenge?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel' }).click(); // cancelled: the dialog is back, as it was typed
    await expect(page.locator('#cochs-f-company')).toHaveValue('Dukan Stores');
    await expect(ask).toHaveCount(0);
    await dlg(page).getByRole('button', { name: 'Delete' }).click();
    await expect(ask).toBeVisible();
    expect(dels).toEqual([]);
    await ask.getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => dels).toEqual([{ p_id: 6 }]);
    await expect(page.locator('#cochs-d-t')).toHaveCount(0);
    await expect(ask).toHaveCount(0);
  });

  test('Riders who joined: the totals, each rider in full with their sessions, and Remove after a question', async ({ page }) => {
    await staff(page, { 'rpc:staff_company_challenge_remove': { ok: true } });
    const calls = sent(page, 'staff_company_challenge_remove');
    await crow(page, 7).getByRole('button', { name: 'Riders who joined' }).click();
    await expect(dlg(page).locator('#cochs-r-t')).toHaveText('Riders who joined · Petromin');
    await expect(dlg(page).locator('.dash-kpi')).toHaveCount(3);
    await expect(dlg(page).locator('.dash-kpi').nth(0)).toHaveText(/2\s*Taking part/);
    await expect(dlg(page).locator('.dash-kpi').nth(1)).toHaveText(/5\s*Sessions completed/);
    await expect(dlg(page).locator('.dash-kpi').nth(2)).toHaveText(/1\s*Badges given/);
    const rs = dlg(page).locator('[data-cochs-r]');
    await expect(rs).toHaveCount(2);
    await expect(rs.nth(0)).toContainText('Omar Zed');
    await expect(rs.nth(0)).toContainText('+966500000002'); // in full: the mask is off on staff screens
    await expect(rs.nth(0)).toContainText('Joined 2 Nov 2026 · Sessions completed 4');
    await expect(rs.nth(0)).not.toContainText('Company Challenge');
    await expect(rs.nth(1)).toContainText('Sessions completed 1 · Company Challenge'); // the badge, on who holds it
    // a row per rider, so a phone has nothing to scroll sideways for and Remove is in sight
    expect(await page.evaluate(`(()=>{const b=document.querySelector('#mny-modal .mny-body');return b.scrollWidth<=b.clientWidth+1})()`)).toBe(true);
    await expect(rs.nth(0).getByRole('button', { name: 'Remove' })).toBeInViewport();
    await rs.nth(0).getByRole('button', { name: 'Remove' }).click();
    const ask = page.getByRole('dialog').filter({ hasText: 'Remove Omar Zed from this challenge?' });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: 'Cancel' }).click(); // cancelled: the list is back as it was
    await expect(rs).toHaveCount(2);
    await expect(ask).toHaveCount(0);
    await rs.nth(0).getByRole('button', { name: 'Remove' }).click();
    await expect(ask).toBeVisible();
    expect(calls).toEqual([]);
    await ask.getByRole('button', { name: 'Remove' }).click();
    await expect.poll(() => calls).toEqual([{ p_challenge: 7, p_customer: 'c2' }]);
    await expect(dlg(page).locator('#cochs-r-t')).toBeVisible(); // the list is back, read again
    // a challenge nobody joined says so
    await page.evaluate(`_mnyClose()`);
    await crow(page, 6).getByRole('button', { name: 'Riders who joined' }).click();
    await expect(dlg(page)).toContainText('Nobody has joined yet.');
  });

  test('an account that opens People without changing it reads the list and has nothing to write with', async ({ page }) => {
    await staff(page);
    await expect(page.locator('#cochs-new')).toBeVisible();
    await page.evaluate(`_accessSet({modules_view:['queue','community'],modules_edit:['queue']},'u1');renderCommunity()`);
    await expect(view(page).locator('[data-cochs]')).toHaveCount(2);
    await expect(page.locator('#cochs-new')).toHaveCount(0);
    await expect(crow(page, 7).getByRole('button', { name: 'Edit' })).toHaveCount(0);
    await crow(page, 7).getByRole('button', { name: 'Riders who joined' }).click();
    await expect(dlg(page).locator('[data-cochs-r]')).toHaveCount(2);
    await expect(dlg(page).getByRole('button', { name: 'Remove' })).toHaveCount(0);
  });

  test('none yet: the view says so and offers New', async ({ page }) => {
    await staff(page, { 'rpc:staff_company_challenges': [] });
    await expect(view(page)).toContainText('No company challenges yet.');
    await expect(page.locator('#cochs-new')).toBeVisible();
  });

  test('a database without the functions: waiting for the update, and nothing to write with', async ({ page }) => {
    await staff(page, { 'rpc:staff_company_challenges': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_company_challenges in the schema cache' } } });
    await expect(view(page)).toContainText('Waiting for the database update.');
    await expect(page.locator('#cochs-new')).toHaveCount(0);
    await expect(page.locator('#err-bar-el')).toHaveCount(0);
  });

  test('the section\'s words exist in every staff language', async ({ page }) => {
    await staff(page);
    const keys = ['cochsTab', 'cochsNew', 'cochsCode', 'cochsMin', 'cochsTeam', 'cochsSessions', 'cochsBadges', 'cochsRiders', 'cochsNone', 'cochsNoRiders', 'cochsStOn', 'cochsStEnded', 'cochsErrFields', 'cochsErrTaken', 'cochsDelAsk', 'cochsRemoveAsk'];
    expect(await page.evaluate(`${JSON.stringify(keys)}.filter(k=>!LANG.en[k])`)).toEqual([]);
    for (const lang of ['ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn']) {
      const packs = ['community', 'peoplemore'].map((p) => JSON.parse(readFileSync(resolve(__dirname, `../lang/staff-${p}-${lang}.json`), 'utf8')) as Record<string, string>);
      const all = Object.assign({}, ...packs) as Record<string, string>;
      expect(keys.filter((k) => !all[k] || all[k] === ''), lang).toEqual([]);
      expect(all.cochsRemoveAsk, lang).toContain('{0}');
    }
  });
});
