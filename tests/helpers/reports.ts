import type { Page } from '@playwright/test';

// Reports open in the viewer inside the site since 2026-11-13 (the reports rework), not in a window of their own. A spec
// reads each report's page as it opens through S._rxTap: tapReports(page) keeps them in window.__rep and keeps the viewer
// shut (the tap takes the report, as the stand-in windows specs once gave window.open did); tapReports(page, true) lets
// the viewer open as well, for a spec that works in the report's own document (reportFrame).
export async function tapReports(page: Page, viewer = false): Promise<void> {
  await page.evaluate(`window.__rep=[];S._rxTap=(h)=>{window.__rep.push(h);return ${viewer ? 'false' : 'true'};};`);
}
export async function reports(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __rep?: string[] }).__rep || []);
}
export async function lastReport(page: Page): Promise<string> {
  const r = await reports(page);
  return r[r.length - 1] || '';
}
export async function waitReport(page: Page, n = 1): Promise<string> {
  await page.waitForFunction((k) => ((window as unknown as { __rep?: string[] }).__rep || []).length >= k, n);
  return lastReport(page);
}
export const reportFrame = (page: Page) => page.frameLocator('#rx-modal .rx-frame');
// The report on the viewer's sheet, as a Frame (locator, evaluate, waitForSelector...), once its body is in.
export async function viewerFrame(page: Page) {
  const el = await page.waitForSelector('#rx-modal .rx-frame', { state: 'attached' });
  await page.waitForFunction(() => {
    const f = document.querySelector('#rx-modal .rx-frame') as HTMLIFrameElement | null;
    return !!(f && f.contentDocument && f.contentDocument.querySelector('.rx-main'));
  });
  const fr = await el.contentFrame();
  if (!fr) throw new Error('the report viewer has no frame');
  return fr;
}
export async function closeViewer(page: Page): Promise<void> {
  await page.locator('#rx-modal .rx-close').click();
}
