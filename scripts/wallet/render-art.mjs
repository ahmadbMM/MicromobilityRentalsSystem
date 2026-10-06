// The Wallet pass art of each event, drawn from its event-picker card's own CSS and assets (the owner,
// 2026-10-06: "make sure that the apple pass booking cards are themed the same way the event picker card is
// themed"): the strip (375 x 98 points) and the logo (inside 160 x 50) at @1x, @2x and @3x, as PNG files named
// <theme>-strip[@2x|@3x].png / <theme>-logo... in the folder given. Not part of any build: run it when a card's
// look changes, then put each file's base64 in pass-images.js (RIDE_IMAGES) and npm run build:wallet.
//   node scripts/wallet/render-art.mjs <out folder>
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const WT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(WT + '/package.json');
const { chromium } = req('playwright');
const OUT = path.resolve(process.argv[2] || '.');
fs.mkdirSync(OUT, { recursive: true });
const css = fs.readFileSync(WT + '/styles.css', 'utf8');
const chev = /--jcc-chev:(url\("data:image\/svg\+xml,[^"]+"\))/.exec(css)[1];
const f = (p) => 'file://' + WT + '/' + p;
const route = (() => {
  const X = (x) => x;
  const p = `M${X(10)} 32 C${X(30)} 32 ${X(34)} 15 ${X(58)} 17 S${X(96)} 30 ${X(122)} 26 S${X(160)} 15 ${X(188)} 20 S${X(236)} 31 ${X(262)} 24 S${X(296)} 15 ${X(309)} 17`;
  const pill = (x, y, t) => `<g><rect x="${x - 14}" y="${y - 19}" width="28" height="12" rx="6" fill="#E8628E"/><text x="${x}" y="${y - 10.4}" text-anchor="middle" fill="#fff" style="font:700 8.6px/1 'Helvetica Neue',Arial,sans-serif;letter-spacing:.3px">${t}</text><path d="M${x} ${y - 7}V${y - 3.6}" fill="none" stroke="#E8628E" stroke-width="1.2"/></g>`;
  return `<svg viewBox="0 0 320 38" style="position:absolute;right:14px;bottom:6px;width:228px;height:auto;overflow:visible"><path d="${p}" fill="none" stroke="#E8628E" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="10" cy="32" r="4" fill="none" stroke="#E8628E" stroke-width="2.2"/><circle cx="122" cy="26" r="2.6" fill="#E8628E"/><circle cx="262" cy="24" r="2.6" fill="#E8628E"/>` +
    `<circle cx="188" cy="20" r="3.4" fill="#fff" stroke="#E8628E" stroke-width="2"/><circle cx="309" cy="17" r="3.4" fill="#fff" stroke="#E8628E" stroke-width="2"/>${pill(188, 20, '3K')}${pill(309, 17, '5K')}</svg>`;
})();
// 375 x 98 points: the event ticket's strip. The fields sit over its start, so the art gathers at the end.
const STRIPS = {
  jcc: `<style>.s{background:${chev} right 22px bottom 14px/111px 30px no-repeat,linear-gradient(112deg,#031E2B 0%,#06346F 44%,#0A4F96 100%) #06346F}</style><div class="s"></div>`,
  comm: `<style>.s{background:linear-gradient(to right,#fff 0 34%,rgba(255,255,255,.84) 60%,rgba(255,255,255,0) 100%),url('${f('assets/mm-pattern.svg')}') right -16px top -12px/112px auto repeat #fff}</style><div class="s"></div>`,
  runher: `<div class="s" style="background:radial-gradient(90% 150% at 100% 100%,rgba(242,120,159,.26) 0%,rgba(242,120,159,.1) 38%,rgba(255,255,255,0) 66%) #fff">${route}</div>`,
  event: `<div class="s" style="background:linear-gradient(to right,#fff 0 40%,rgba(124,58,237,.10) 100%) #fff"></div>`,
};
// The logo: at most 160 x 50 points, the mark each event card wears.
const LOGOS = { jcc: ['jcc-white.webp', 330, 166], comm: ['logo-dark.webp', 241, 256], runher: ['assets/runher-partners.webp', 653, 120] };
const browser = await chromium.launch();
for (const scale of [1, 2, 3]) {
  const ctx = await browser.newContext({ deviceScaleFactor: scale, viewport: { width: 375, height: 98 } });
  const page = await ctx.newPage();
  for (const [k, html] of Object.entries(STRIPS)) {
    fs.writeFileSync(`${OUT}/_${k}.html`, `<html><body style="margin:0"><style>.s{position:relative;width:375px;height:98px;overflow:hidden}</style>${html}</body></html>`);
    await page.goto(`file://${OUT}/_${k}.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(250);
    await page.locator('.s').screenshot({ path: `${OUT}/${k}-strip${scale > 1 ? '@' + scale + 'x' : ''}.png` });
  }
  for (const [k, [src, w, h]] of Object.entries(LOGOS)) {
    const s = Math.min(160 / w, 50 / h), W = Math.round(w * s), H = Math.round(h * s);
    await page.setViewportSize({ width: W, height: H });
    await page.setContent(`<html><body style="margin:0;background:transparent"><img id="l" src="${f(src)}" style="display:block;width:${W}px;height:${H}px"></body></html>`);
    await page.waitForFunction(() => document.getElementById('l').complete);
    await page.locator('#l').screenshot({ path: `${OUT}/${k}-logo${scale > 1 ? '@' + scale + 'x' : ''}.png`, omitBackground: true });
    await page.setViewportSize({ width: 375, height: 98 });
  }
  await ctx.close();
}
await browser.close();
for (const k of Object.keys(STRIPS)) fs.rmSync(`${OUT}/_${k}.html`, { force: true });
console.log('done: ' + OUT);
