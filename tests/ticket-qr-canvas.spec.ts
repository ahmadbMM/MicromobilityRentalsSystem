import { test, expect, chromium, type Page } from '@playwright/test';
import { stubSupabase, loginCustomer, unlockStaff, waitForSb, loadStaffHalf } from './helpers/supabase';

// The owner, 2026-10-05: "why does the dark theme/appearance for the website not contain a white themed
// qr code as the dark qr codes arent getting scanned properly". Samsung Internet's dark mode recolours
// every svg (rectangles darkened as background, paths lightened as foreground) and a site cannot opt
// out, so the ticket's white tile went dark. It leaves a canvas alone: the code is painted on one, which
// takes the svg's place. And the desk's scanner reads a code shown light on dark from an inverted copy
// of the frame, so a recoloured ticket (or a picture of one) still scans.
test.describe('@customer:ticket the ticket code on a canvas', () => {
  const FUT = '2099-02-01';
  const sess = { id: 's-' + FUT, day: 'Sunday', session_date: FUT, capacity: 12, status: 'open', created_at: 1, location: 'JCC', bike_slots: '{"_time":"21:00 - 23:00","_total":12}' };
  const row = { id: 'q1abcd', name: 'Spec Rider', customer_id: 'c1', session_id: 's-' + FUT, session_day: 'Sunday', session_date: FUT, queue_num: 3, status: 'waiting', paid: false, price: 75, waiver_version: '2026-10-v3' };

  async function ticket(page: Page) {
    await stubSupabase(page, { sessions: [sess], 'rpc:list_sessions': [sess], queue_entries: [row], 'rpc:my_bookings': [row] });
    await loginCustomer(page, { id: 'c1' });
    await page.goto('/');
    await waitForSb(page);
    await page.evaluate(`goCustomer('myrides')`);
    const box = page.locator('#tab-myrides .cu-qr-box').first();
    await expect(box).toHaveClass(/\bcv\b/);
    await box.scrollIntoViewIfNeeded();
    return box;
  }
  // jsQR (the scanner's own fallback decoder), told not to try the inverted image: a code must read
  // dark on light as it is shown.
  async function decode(page: Page, dataUrl: string) {
    await page.addScriptTag({ url: '/vendor/jsqr-1.4.0.min.js' });
    return page.evaluate(async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      const r = (window as unknown as { jsQR: (a: Uint8ClampedArray, w: number, h: number, o: unknown) => { data: string } | null })
        .jsQR(d.data, c.width, c.height, { inversionAttempts: 'dontInvert' });
      return r && r.data;
    }, dataUrl);
  }

  test('the code is painted on a canvas that stands in for the svg, white tile, dark modules, and it reads back', async ({ page }) => {
    const box = await ticket(page);
    const cv = box.locator('canvas.qr-cv');
    await expect(cv).toBeVisible();
    await expect(cv).toHaveAttribute('role', 'img');
    await expect(cv).toHaveAttribute('aria-label', 'Booking QR code');
    await expect(box.locator('svg:not(.qr-live)')).toBeHidden(); // the fallback steps aside
    await expect(box.locator('svg.qr-live')).toBeVisible(); // the live line still runs round it
    const n = await page.evaluate(`QR.encode(document.querySelector('#tab-myrides .cu-qr-box').getAttribute('data-qr')).size`) as number;
    const m = await cv.evaluate((el: HTMLCanvasElement, n: number) => {
      const g = el.getContext('2d')!, px = (x: number, y: number) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3));
      const k = el.width / el.getBoundingClientRect().width;
      // the top-left finder's centre: 6 px of tile, 4 modules of quiet zone, then 3.5 modules in
      const at = Math.round((6 + (4 + 3.5) * ((132 - 12) / (n + 8))) * k);
      return { css: Math.round(el.getBoundingClientRect().width), k, corner: px(2, 2), finder: px(at, at) };
    }, n);
    expect(m.css).toBe(132);
    expect(m.k).toBeGreaterThanOrEqual(1);
    expect(m.corner).toEqual([255, 255, 255]);
    expect(Math.max(...m.finder)).toBeLessThan(60);
    const want = await page.evaluate(`bookingRef(getQueue().find(e=>e.id==='q1abcd'))`);
    const url = await cv.evaluate((el: HTMLCanvasElement) => el.toDataURL('image/png'));
    expect(await decode(page, url)).toBe(want);
  });

  test('a browser that darkens the page leaves the code dark on white, and it scans from the screen', async ({ browserName }, info) => {
    test.skip(browserName !== 'chromium' || info.project.name !== 'chromium', 'one forced-dark run is enough');
    const b = await chromium.launch({ args: ['--blink-settings=forceDarkModeEnabled=true'] });
    try {
      const ctx = await b.newContext({ colorScheme: 'dark', bypassCSP: true, baseURL: info.project.use.baseURL || `http://localhost:${process.env.PW_PORT || 4173}` });
      const page = await ctx.newPage();
      const box = await ticket(page);
      const shot = await box.screenshot();
      expect(await decode(page, 'data:image/png;base64,' + shot.toString('base64'))).toMatch(/^MMC-3-q1abcd$/);
    } finally { await b.close(); }
  });

  test('the desk reads a code shown light on dark from an inverted copy of the frame', async ({ page }) => {
    await stubSupabase(page, { sessions: [sess] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await loadStaffHalf(page);
    // The inverted copy really is the frame with its colours flipped.
    const px = await page.evaluate(`(()=>{const c=document.createElement('canvas');c.width=40;c.height=20;const g=c.getContext('2d');
      g.fillStyle='#000';g.fillRect(0,0,20,20);g.fillStyle='#fff';g.fillRect(20,0,20,20);
      Object.defineProperty(c,'videoWidth',{value:40});Object.defineProperty(c,'videoHeight',{value:20});
      const out=_scanInverted(c),h=out.getContext('2d');return [h.getImageData(5,5,1,1).data[0],h.getImageData(30,5,1,1).data[0]];})()`);
    expect(px).toEqual([255, 0]);
    // The camera's detector finds nothing in the frame as it is, and the code in the inverted copy:
    // the look that tries the copy hands the code on, as a plain read would.
    const got = await page.evaluate(`(async()=>{
      const v=document.createElement('video');v.id='scan-video';document.body.appendChild(v);
      for(const [k,val] of [['readyState',4],['videoWidth',40],['videoHeight',20]])Object.defineProperty(v,k,{value:val});
      const seen=[];window._onScanPayload=t=>seen.push(t);
      _scanDetector={detect:async src=>src.tagName==='CANVAS'?[{rawValue:'MMC-7-abc123'}]:[]};
      _scanStream={getTracks:()=>[]};
      for(let i=0;i<2&&!seen.length;i++){_scanFlip=i===1;await _scanTick(_scanGen);clearTimeout(_scanTimer);}
      _scanStream=null;_scanDetector=null;
      return seen;
    })()`);
    expect(got).toEqual(['MMC-7-abc123']);
  });
});
