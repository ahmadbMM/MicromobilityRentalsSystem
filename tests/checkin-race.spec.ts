import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Two staff check the same WAITING rider into different bikes. The status-guarded write means the
// loser gets 0 rows; it must release the bike it claimed instead of leaving it orphaned in-use.
// Since 2026-10-05 the picker checks in through staff_checkin, which settles this race on the server;
// the direct writes below are its fallback for a database without the function, which this pins.
test('losing a check-in race releases the claimed bike (no orphan)', async ({ page }) => {
  await stubSupabase(page, {
    'rpc:staff_checkin': { __rpcError: { status: 404, code: 'PGRST202', message: 'Could not find the function public.staff_checkin in the schema cache' } },
    sessions: [{ id: 's1', day: 'Friday', session_date: '2099-01-09', capacity: 12, status: 'open', created_at: 1 }],
    bikes: [{ id: 'bX', name: 'Bike X', size: 'M', type: 'Hybrid', status: 'available', rental_price: 57.5 }],
    queue_entries: [{ id: 'q5', name: 'Rider 5', session_id: 's1', session_day: 'Friday', session_date: '2099-01-09', queue_num: 5, status: 'waiting', paid: false, price: 30, registered_at: '2099-01-09T10:00:00Z' }],
  });
  await unlockStaff(page);
  await page.goto('/');
  await waitForSb(page);

  const result = await page.evaluate(`(async()=>{
    const bikeWrites=[];
    const realFrom=sb.from.bind(sb);
    sb.from=(t)=>{ const q=realFrom(t);
      if(t==='queue_entries'){
        const realUpd=q.update.bind(q);
        q.update=(patch)=>{ const b=realUpd(patch);
          if(patch&&patch.status==='active'){ // simulate: another device already checked q5 in → 0 rows match status=waiting
            const realSel=b.select.bind(b); b.select=()=>Promise.resolve({ data:[], error:null });
          }
          return b;
        };
      }
      if(t==='bikes'){ const realUpd=q.update.bind(q);
        q.update=(patch)=>{ const b=realUpd(patch);
          const realEq=b.eq.bind(b); b.eq=(col,val)=>{ if(patch&&patch.status==='available')bikeWrites.push(val); return realEq(col,val); };
          return b;
        };
      }
      return q;
    };
    openModal('q5'); S.modalBikes=['bX'];
    await confirmAssign();
    return { released: bikeWrites.includes('bX') };
  })()`) as { released: boolean };

  expect(result.released).toBe(true); // the claimed bike bX was returned to available, not orphaned
});
