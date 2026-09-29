import { test, expect } from '@playwright/test';
import { stubSupabase, loginCustomer, waitForSb, loadStaffHalf } from './helpers/supabase';

// The small shared helpers every screen leans on: labels that go straight into markup, dates,
// the bike suggestion, language packs, the staff role, the snapshot and signing out.

const S1 = '2099-12-01';
const sessions = [{ id: S1, session_date: S1, day: 'Tuesday', status: 'open', capacity: 10, created_at: 1 }];

async function boot(page: import('@playwright/test').Page, fixtures: Record<string, unknown> = {}) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [], ...fixtures });
  await page.goto('/');
  await waitForSb(page);
  await loadStaffHalf(page); // _bestFreeBike, sizeLabel and friends live in the staff half
}

test('an unknown stored type, day or time cannot put markup on the page', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(()=>{
    const bad='<img src=x onerror="window.__pwned=1">';
    const host=document.createElement('div');document.body.appendChild(host);
    host.innerHTML=typeBadge(bad)+statusBadge(bad)+dayLabel(bad)+sessionTime({bike_slots:JSON.stringify({_time:bad+' - 23:00'})});
    const r={imgs:host.querySelectorAll('img').length,label:typeLabel(bad),proto:typeLabel('constructor'),badge:typeBadge('constructor'),
      road:typeLabel('Road'),own:typeBadge('Own').includes('type-any')};
    host.remove();return r;
  })()`) as Record<string, unknown>;
  expect(out.imgs).toBe(0);
  expect(out.label).toContain('&lt;img');
  expect(out.proto).toBe('constructor');
  expect(String(out.badge)).not.toContain('native code');
  expect(out.road).toBe('Road');
  expect(out.own).toBe(true);
});

test('shortDate: a timestamp is its own Riyadh day, a date-prefixed id reads as its date, junk prints nothing', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`[shortDate('2026-09-04T22:22:11.123+00:00'),shortDate('2026-09-20-pt'),shortDate('<b>x</b>'),shortDate('2026-09-20')]`);
  expect(out).toEqual(['5 Sept 2026', '20 Sept 2026', '', '20 Sept 2026']);
});

test.describe('west of UTC-9', () => {
  test.use({ timezoneId: 'Pacific/Honolulu' });
  test('a session day is not moved to the next day', async ({ page }) => {
    await boot(page);
    expect(await page.evaluate(`shortDate('2026-09-20')`)).toBe('20 Sept 2026');
  });
});

test('Reserve bike suggests a Road bike, carbon first, for a Road Carbon booking', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(()=>{
    S.bikes=[{id:'al',type:'Road',size:'M',status:'available',frame_type:'Aluminum'},{id:'cf',type:'Road',size:'L',status:'available',frame_type:'Carbon'},{id:'hy',type:'Hybrid',size:'M',status:'available'}];
    const carbon=_bestFreeBike({id:'x',typePreference:'Road Carbon',size:'M',status:'waiting'});
    S.bikes=S.bikes.filter(b=>b.id!=='cf');
    const road=_bestFreeBike({id:'x',typePreference:'Road Carbon',size:'M',status:'waiting'});
    return [carbon&&carbon.id,road&&road.id];
  })()`);
  expect(out).toEqual(['cf', 'al']);
});

test('a language pack that failed to arrive is asked for again', async ({ page }) => {
  let hits = 0;
  await page.route(/\/lang\/hi\.json/, (r) => { hits++; return hits === 1 ? r.abort() : r.fallback(); });
  await boot(page);
  const first = await page.evaluate(`loadLangPack('hi')`);
  const second = await page.evaluate(`loadLangPack('hi')`);
  expect(first).toBe(false);
  expect(second).toBe(true);
  expect(hits).toBe(2);
});

test('a staff sign-in whose role lookup failed is front desk unless this account was confirmed here', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(()=>{
    localStorage.removeItem('cq_role_uid');localStorage.setItem('cq_role','admin');
    const fresh=_staffRoleGuess('u1');
    localStorage.setItem('cq_role_uid','u1');
    const same=_staffRoleGuess('u1'),other=_staffRoleGuess('u2');
    return [fresh,same,other];
  })()`);
  expect(out).toEqual(['frontdesk', 'admin', 'frontdesk']);
});

test('a staff phone lookup that fails is a connection problem, not a wrong password', async ({ page }) => {
  await boot(page);
  await page.route(/\/rest\/v1\/rpc\/staff_email_for_phone/, (r) => r.fulfill({
    status: 503, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'XX000', message: 'upstream timed out' }),
  }));
  expect(await page.evaluate(`_staffLoginEmail('0501234567').then(v=>v===undefined?'undefined':v)`)).toBe('undefined');
  expect(await page.evaluate(`staffAuthSignIn('0501234567','x').then(r=>r.msg===t('errConnection'))`)).toBe(true);
});

test('the snapshot holds the boot window, is dropped rather than left stale when even that does not fit, and is not rewritten unchanged', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(()=>{
    const real=Storage.prototype.setItem;
    localStorage.setItem('cq_snapshot','OLD');
    S.queue=[{id:'old',sessionDate:'2001-01-01'},{id:'new',sessionDate:'2099-01-01'}];
    let limit=Infinity;
    Storage.prototype.setItem=function(k,v){if(k==='cq_snapshot'&&String(v).length>limit)throw new DOMException('quota','QuotaExceededError');return real.call(this,k,v);};
    try{
      const full=JSON.stringify({q:S.queue,ses:S.sessions,bk:S.bikes,inv:S.inventory,cs:S.cashSales}).length;
      limit=full-1;_cacheSave();
      const trimmed=JSON.parse(localStorage.getItem('cq_snapshot')).q.map(e=>e.id);
      // A save with nothing changed writes nothing (the copy on disk is the one just written), so the
      // queue changes before the write that cannot fit.
      localStorage.setItem('cq_snapshot','OLD');S.queue=[...S.queue,{id:'newer',sessionDate:'2099-01-02'}];limit=5;_cacheSave();
      return {trimmed,gone:localStorage.getItem('cq_snapshot')===null};
    }finally{Storage.prototype.setItem=real;}
  })()`);
  expect(out).toEqual({ trimmed: ['new'], gone: true });
});

test('signing out leaves none of the customer\'s details on the device', async ({ page }) => {
  const mine = { id: 'q1', session_id: S1, session_day: 'Tuesday', session_date: S1, queue_num: 1, name: 'Spec Rider', email: 'spec@example.com', phone: '0500000001', customer_id: 'c1', status: 'waiting', type_preference: 'Any', paid: false, price: 30, registered_at: '2099-01-01T10:00:00Z' };
  await stubSupabase(page, { sessions, queue_entries: [mine], bikes: [] });
  await loginCustomer(page);
  await page.goto('/');
  await waitForSb(page);
  await expect.poll(() => page.evaluate(`!!getQueue().find(e=>e.id==='q1'&&e.name==='Spec Rider')`)).toBe(true);
  await page.evaluate(`doLogout(true)`);
  const out = await page.evaluate(`(()=>{const e=getQueue().find(x=>x.id==='q1');return {kept:!!e,status:e&&e.status,name:e&&e.name,cust:e&&e.customerId,snap:localStorage.getItem('cq_snapshot')||''};})()`) as Record<string, unknown>;
  expect(out.kept).toBe(true);           // still counts toward the night's places
  expect(out.status).toBe('waiting');
  expect(out.name).toBeUndefined();
  expect(out.cust).toBeUndefined();
  expect(String(out.snap)).not.toContain('Spec Rider');
  expect(String(out.snap)).not.toContain('spec@example.com');
});

test('a row read from the public view keeps what the staff device already knew', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(()=>{
    const prev={id:'x',name:'Known',customerId:'c1',addons:[{id:'i1',qty:1}],pay_method:'card',status:'waiting',paid:false};
    const e=entryFromDB({id:'x',session_id:'s',session_day:'Friday',session_date:'2099-01-01',queue_num:4,status:'active',paid:true,price:0});
    _carryKnown(e,prev);
    return {name:e.name,cust:e.customerId,addons:e.addons.length,pay:e.pay_method,status:e.status,paid:e.paid,q:e.queueNum};
  })()`);
  expect(out).toEqual({ name: 'Known', cust: 'c1', addons: 1, pay: 'card', status: 'active', paid: true, q: 4 });
});

test('a booking on a session this device cannot see carries no queue number in its reference', async ({ page }) => {
  await boot(page);
  expect(await page.evaluate(`bookingRef({id:'abc123xyz',sessionId:'not-here',queueNum:7})`)).toBe('MMC-abc123');
  expect(await page.evaluate(`bookingRef({id:'def456xyz',sessionId:'${S1}',queueNum:3})`)).toBe('MMC-3-def456');
});

test('size labels come in the page language\'s unit, with no English words', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(async()=>{const r=[sizeLabel('XS'),sizeLabel('Kids')];await loadLangPack('ar');S.lang='ar';r.push(sizeLabel('Kids'));S.lang='en';return r;})()`) as string[];
  expect(out[0]).toBe('XS');
  expect(out[1]).toBe('Kids (≤ 144 cm)');
  expect(out[2]).toContain('سم');
  expect(out[2]).toContain('أطفال');
});

// The owner's chart (2026-09-29): Road XS 145-159, S 160-172, M 173-179, L 180-189, XL 190+;
// Hybrid and Mountain XS 145-159, S 160-170, M 171-185, L 186+; 144 and under is a Kids bike.
test('@staff:bookings the frame size follows the owner\'s chart for each bike type', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(()=>{
    const hs=[100,144,145,159,160,170,171,172,173,179,180,185,186,189,190,210];
    const row=ty=>hs.map(h=>bikeFit(h,ty)).join(' ');
    return {road:row('Road'),carbon:row('Road Carbon'),hybrid:row('Hybrid'),mountain:row('Mountain'),kids:row('Kids'),
      saved:[heightToSize(140,'Road'),heightToSize(182,'Hybrid'),heightToSize(182,'Road')],none:bikeFit(null,'Road')};
  })()`) as Record<string, unknown>;
  expect(out.road).toBe('Kids Kids XS XS S S S S M M L L L L XL XL');
  expect(out.carbon).toBe(out.road);
  expect(out.hybrid).toBe('Kids Kids XS XS S S M M M M M M L L L L');
  expect(out.mountain).toBe(out.hybrid);
  expect(out.kids).toBe('Kids Kids XS XS S S S S M M L L L L XL XL'); // above 144 a Kids booking reads Road's chart
  expect(out.saved).toEqual(['', 'M', 'L']); // queue_entries.size takes frame sizes only
  expect(out.none).toBe('');
});

test('@staff:bookings staff see the size on the booked type, both charts for an Any booking, and a bike fits by its own type', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(()=>{
    S.bikes=[{id:'rl',type:'Road',size:'L',status:'available'},{id:'hm',type:'Hybrid',size:'M',status:'available'},{id:'hl',type:'Hybrid',size:'L',status:'available'},{id:'k1',type:'Kids',size:'XS',status:'available'}];
    const e=(o)=>({id:'x',status:'waiting',size:'',...o});
    const any182=e({typePreference:'Any',height:182}),road182=e({typePreference:'Road',height:182}),hyb182=e({typePreference:'Hybrid',height:182});
    const kid=e({typePreference:'Road',height:130}),tall=e({typePreference:'Kids',height:150}),own=e({typePreference:'Own',height:180}),legacy=e({typePreference:'Road',size:'M'});
    const fits=x=>S.bikes.filter(b=>_bikeFits(x,b)).map(b=>b.id).join(',');
    return {
      text:[_entryFitText(road182),_entryFitText(hyb182),_entryFitText(any182),_entryFitText(e({typePreference:'Any',height:175})),_entryFitText(kid),_entryFitText(own),_entryFitText(legacy)],
      fits:[fits(any182),fits(e({typePreference:'Any',height:175})),fits(e({typePreference:'Any',height:188})),fits(kid),fits(tall)],
      best:[_bestFreeBike(hyb182).id,_bestFreeBike(road182).id,_bestFreeBike(any182).id],
      filter:[_entryFits(any182).includes('L'),_entryFits(any182).includes('M'),_entryFits(kid).includes('Kids')],
    };
  })()`) as Record<string, string[] | boolean[]>;
  expect(out.text).toEqual(['L', 'M', 'Road L · Hybrid/Mountain M', 'M', 'Kids', '', 'M']);
  expect(out.fits).toEqual(['rl,hm', 'hm', 'rl,hl', 'k1', '']); // a Kids bike fits no one over 144
  expect(out.best).toEqual(['hm', 'rl', 'rl']);
  expect(out.filter).toEqual([true, true, true]);
});

test('handlers still work with their arguments encoded (social link sync, language menu)', async ({ page }) => {
  await boot(page);
  const out = await page.evaluate(`(()=>{
    const host=document.createElement('div');host.innerHTML=_socFieldsHtml('pf',{instagram:'rider'},true);document.body.appendChild(host);
    const inp=document.getElementById('pf-soc-instagram');inp.value='https://instagram.com/new.handle';inp.dispatchEvent(new Event('input',{bubbles:true}));
    const href=document.getElementById('pf-soc-instagram-open').getAttribute('href');host.remove();
    showLangMenu();const btn=[...document.querySelectorAll('.pay-menu-popup .pay-menu-opt')].find(b=>b.textContent==='Français');btn.click();
    const lang=S.lang;setLang('en');return {href,lang};
  })()`);
  expect(out).toEqual({ href: 'https://www.instagram.com/new.handle', lang: 'fr' });
});

test('turning the screen with no field focused does not leave the footers unstuck; a keyboard still does', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 860 });
  await boot(page);
  // The page hears of a new size in a visualViewport 'resize' event at its next frame, and a
  // busy machine can fold two quick size changes into one event: the portrait height and the
  // keyboard height then reached the page together, with the field already focused, and the
  // keyboard was never seen. Each step waits until the page has had the event for its size.
  // This listener is added after the app's own, so when it has heard a size, so has the app.
  await page.evaluate(`window.__vvSeen=[];visualViewport.addEventListener('resize',()=>window.__vvSeen.push(Math.round(visualViewport.height)))`);
  const resize = async (width: number, height: number) => {
    const n = await page.evaluate('window.__vvSeen.length') as number;
    await page.setViewportSize({ width, height });
    await page.waitForFunction(([n, h]) => (window as unknown as { __vvSeen: number[] }).__vvSeen.slice(n).includes(h), [n, height]);
  };
  await resize(860, 412); // portrait to landscape, nothing focused
  expect(await page.evaluate(`document.documentElement.classList.contains('kb-open')`)).toBe(false);
  await resize(412, 860);
  await page.evaluate(`(()=>{const i=document.createElement('input');i.id='kb-probe';document.body.appendChild(i);i.focus();})()`);
  await resize(412, 560); // a keyboard's worth of height gone while typing
  expect(await page.evaluate(`document.documentElement.classList.contains('kb-open')`)).toBe(true);
});
