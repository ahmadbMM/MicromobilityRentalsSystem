import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Refunding a receipt that has the SAME item on two lines must restock the full quantity with a
// single inventory write per item (concurrent absolute-value writes could otherwise lose an update).
test('refund restocks the summed quantity per item in one write', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
    inventory: [{ id: 'gel', name: 'Gel', category: 'EnergyGels', qty: 5, price: 8, low_threshold: 1 }],
    cashier_sales: [
      { id: 'l1', receipt_id: 'r1', session_id: 's1', name: 'Gel', item_id: 'gel', category: 'EnergyGels', qty: 1, price: 8, pay: 'paid', created_at: '2099-01-09T11:00:00Z' },
      { id: 'l2', receipt_id: 'r1', session_id: 's1', name: 'Gel', item_id: 'gel', category: 'EnergyGels', qty: 2, price: 8, pay: 'paid', created_at: '2099-01-09T11:00:00Z' },
    ],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  // The receipt and the stock have to be in before the refund looks for them, and the refund saves
  // first and restocks after: on a slow CI runner neither fits a fixed 50 ms (2026-10-02).
  await page.waitForFunction(`(S.cashSales||[]).some(r=>r.receipt_id==='r1')&&(S.inventory||[]).some(i=>i.id==='gel')`);
  await page.evaluate(`(()=>{
    // capture every inventory PATCH the refund issues
    const writes=window.__writes=[];
    const realFrom=sb.from.bind(sb);
    sb.from=(t)=>{ const q=realFrom(t);
      if(t==='inventory'){ const realUpd=q.update.bind(q);
        q.update=(patch)=>{ writes.push(patch.qty); const b=realUpd(patch); return b; };
      }
      return q;
    };
    confirmDialog=(o)=>o.onConfirm&&o.onConfirm(); // auto-confirm
    _askMoneyReason=async()=>({v:'mistake',txt:'Rung up by mistake'}); // the reason asked since 2026-10-09
    _ctRefundReceipt('r1');
  })()`);
  await expect.poll(() => page.evaluate(`window.__writes.length`)).toBeGreaterThan(0);
  await page.waitForTimeout(100); // a second, racing write would land here
  const result = await page.evaluate(`({ writes: window.__writes, mem:(S.inventory.find(i=>i.id==='gel')||{}).qty })`) as { writes: number[]; mem: number };

  expect(result.writes.length).toBe(1);   // ONE write for the item, not two racing writes
  expect(result.writes[0]).toBe(8);       // 5 + (1+2) restocked
  expect(result.mem).toBe(8);
});

test('a sale with the same item on two lines decrements once by the summed qty', async ({ page }) => {
  await stubSupabase(page, {
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
    inventory: [{ id: 'gel', name: 'Gel', category: 'EnergyGels', qty: 10, price: 8, low_threshold: 1 }],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);
  const result = await page.evaluate(`(async()=>{
    const writes=[];
    const realFrom=sb.from.bind(sb);
    sb.from=(t)=>{ const q=realFrom(t); if(t==='inventory'){ const u=q.update.bind(q); q.update=(patch)=>{ writes.push(patch.qty); return u(patch); }; } return q; };
    S._ctSession='s1'; S._ctCust='';
    S._ctCart=[
      {item_id:'gel',name:'Gel',cat:'EnergyGels',qty:1,price:8,pay:'paid'},
      {item_id:'gel',name:'Gel',cat:'EnergyGels',qty:3,price:8,pay:'paid'},
    ];
    window.open=()=>({document:{write:()=>{},close:()=>{}},focus:()=>{},print:()=>{}}); // swallow the print popup
    await _ctRecord();
    await new Promise(r=>setTimeout(r,50));
    return { writes, mem:(S.inventory.find(i=>i.id==='gel')||{}).qty };
  })()`) as { writes: number[]; mem: number };
  expect(result.writes.length).toBe(1);  // one write, not two racing decrements
  expect(result.writes[0]).toBe(6);      // 10 - (1+3)
  expect(result.mem).toBe(6);
});
