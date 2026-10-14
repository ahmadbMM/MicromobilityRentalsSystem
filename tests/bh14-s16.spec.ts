import { test, expect, type Page } from '@playwright/test';
import { stubSupabase, unlockStaff, loginCustomer, waitForSb } from './helpers/supabase';

// Bug hunt 2026-10-14 (s16): the offline booking outbox, the till's Z-report, the exceptions'
// operator filter and the tag form.
const TOMORROW = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Riyadh' });
const sessions = [{ id: 's0', day: 'Friday', session_date: TOMORROW, capacity: 12, status: 'open', created_at: 1 }];
const q1 = { id: 'q1', session_id: 's0', session_day: 'Friday', session_date: TOMORROW, queue_num: 1, name: 'Rider One', status: 'waiting', paid: false, price: 75, registered_at: '2026-01-01T10:00:00Z' };

async function bootStaff(page: Page) {
  await stubSupabase(page, { sessions, queue_entries: [q1], bikes: [] });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  await page.waitForFunction(`getQueue().length>0`);
  await page.evaluate(`localStorage.setItem('cq_op_name','Spec Staff');S.staffRole='admin';`);
}

test.describe('@bh14 s16 money, outbox and tags', () => {
  test('a throw outside the row guards does not leave the booking outbox locked for good', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [] });
    await loginCustomer(page, { id: 'c1' });
    await page.goto('/');
    await waitForSb(page);
    const busy = await page.evaluate(`(async()=>{
      const row={id:'mine',name:'Mine',session_id:'s0',session_day:'Friday',session_date:'${TOMORROW}',queue_num:1,status:'waiting',paid:false,price:30,registered_at:'2026-01-01T10:00:00Z'};
      localStorage.setItem('cq_book_outbox',JSON.stringify([row]));
      const real=window._bookOutboxSave;window._bookOutboxSave=()=>{throw new Error('storage full');};
      try{await _bookOutboxFlush();}catch(_){}
      window._bookOutboxSave=real;
      return _bookBusy;
    })()`);
    expect(busy).toBe(false);
  });

  test('the Z-report of a till whose ride was deleted reads that night, not today\'s shop', async ({ page }) => {
    await bootStaff(page);
    const ctx = await page.evaluate(`(async()=>{
      await Promise.resolve(renderMoneyView('none')); // the money part is in
      let seen=null;const real=window._tillTake;window._tillTake=c=>{seen=c;return real(c);};
      window.open=()=>({document:{write(){},close(){},querySelectorAll(){return[];},querySelector(){return null;}},focus(){},close(){},closed:false});
      S._tillH={from:'2026-09-01',to:'2026-10-14',rows:[{id:'t1',session_id:'gone',day:'2026-10-01',float:100,opened_at:'2026-10-01T15:00:00Z',expected_cash:100,counted_cash:100}],busy:false,err:null,key:''};
      await _tillZ('t1');
      window._tillTake=real;
      return seen&&{shop:seen.shop,day:seen.day};
    })()`);
    expect(ctx).toEqual({ shop: false, day: '2026-10-01' });
  });

  test('an operator the new dates do not have stops filtering the exceptions', async ({ page }) => {
    await bootStaff(page);
    const op = await page.evaluate(`(async()=>{
      await Promise.resolve(renderMoneyView('none'));
      const h=document.createElement('div');h.id='mny-host';document.body.appendChild(h);
      const E=_exS();E.items=[{type:'house',at:new Date().toISOString(),what:['Gel'],amt:12,op:'Someone',reason:'',ref:'r1',cust:''}];E.key=E.from+'~'+E.to;E.busy=false;E.op='Gone Person';
      _exDraw(true);
      return {op:E.op,rows:h.querySelectorAll('.mny-t tbody tr').length};
    })()`) as { op: string; rows: number };
    expect(op.op).toBe('');
    expect(op.rows).toBeGreaterThan(0);
  });

  test('two taps on Save make one tag', async ({ page }) => {
    await bootStaff(page);
    const inserts = await page.evaluate(`(async()=>{
      await Promise.resolve(renderCommunity&&renderCommunity());
      const i=document.createElement('input');i.id='tag-name';i.value='Night Owls';document.body.appendChild(i);
      S.tagEdit={};let n=0;const realFrom=sb.from.bind(sb);
      sb.from=t=>{const q=realFrom(t);if(t==='tags'){const ri=q.insert.bind(q);q.insert=r=>{n++;return ri(r);};}return q;};
      await Promise.all([saveTag(),saveTag()]);
      sb.from=realFrom;
      return n;
    })()`);
    expect(inserts).toBe(1);
  });
});
