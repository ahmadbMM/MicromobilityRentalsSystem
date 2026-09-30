import { test, expect, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// staff.micromobility.sa serves the same app, locked to its staff side. It opens on the staff
// sign-in or the panel, never on the customer pages, and the sign-in cannot be closed onto
// them. Search engines are shut out. Chromium resolves *.localhost to this machine, so
// staff.localhost stands in for the real address.

const staffUrl = (path = '/') => {
  const base = new URL(String(test.info().project.use.baseURL));
  return `${base.protocol}//staff.localhost:${base.port}${path}`;
};
const sessions = [{ id: '2099-03-03', day: 'Tuesday', session_date: '2099-03-03', capacity: 40, status: 'open', created_at: 1, bike_slots: '{"_time":"21:00 - 23:00"}' }];

async function open(page: Page, staff: boolean) {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  if (staff) await unlockStaff(page);
  await page.goto(staffUrl());
  await waitForSb(page);
}

test('a signed-out device gets the staff sign-in alone', async ({ page }) => {
  await open(page, false);
  await expect(page.locator('#pin-modal .pin-box')).toBeVisible();
  await expect(page).toHaveTitle('MicroMobility Staff');
  await expect(page.locator('#view-landing')).toBeHidden();
  await expect(page.locator('#auth-modal')).toBeHidden(); // never the customer sign-in
  await expect(page.locator('#customer-tab-nav')).toBeHidden();
});

test('closing the sign-in brings it back: there is nothing behind it', async ({ page }) => {
  await open(page, false);
  await page.locator('#pin-modal .pin-cancel').click();
  await expect(page.locator('#pin-modal .pin-box')).toBeVisible();
  expect(await page.evaluate('S.view')).not.toBe('customer');
});

test('an unlocked device opens on the staff panel, and customer routes lead back to it', async ({ page }) => {
  await open(page, true);
  await expect(page.locator('#view-staff')).toHaveClass(/active/);
  await expect(page).toHaveTitle('MicroMobility Staff');
  await page.evaluate(`goLanding()`);
  expect(await page.evaluate('S.view')).toBe('staff');
  await page.evaluate(`goCustomer('register')`);
  expect(await page.evaluate('S.view')).toBe('staff');
});

test('the customer address is unchanged', async ({ page }) => {
  await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
  await page.goto('/');
  await waitForSb(page);
  await expect(page).toHaveTitle('MicroMobility Experiences');
  await expect(page.locator('#pin-modal .pin-box')).toHaveCount(0);
  expect(await page.evaluate(`document.body.classList.contains('staff-host')`)).toBe(false);
});

test.describe('the middleware on the staff address', () => {
  const run = async (url: string) => {
    const mod = await import(pathToFileURL(resolve(__dirname, '..', 'functions/_middleware.js')).href + '?h=' + Math.random());
    return mod.onRequest({ request: new Request(url), next: () => new Response('asset', { headers: { 'content-type': 'text/html' } }) }) as Promise<Response>;
  };
  test('shuts every crawler out', async () => {
    const r = await run('https://staff.micromobility.sa/robots.txt');
    expect(await r.text()).toBe('User-agent: *\nDisallow: /\n');
  });
  test('marks every page noindex, and still hides internal files', async () => {
    const r = await run('https://staff.micromobility.sa/');
    expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(await r.text()).toBe('asset');
    expect((await run('https://staff.micromobility.sa/AGENTS.md')).status).toBe(404);
  });
  test('leaves the customer address alone', async () => {
    const r = await run('https://micromobilityrentals.pages.dev/');
    expect(r.headers.get('x-robots-tag')).toBeNull();
    expect(await (await run('https://micromobilityrentals.pages.dev/robots.txt')).text()).toBe('asset');
  });
});

// The live customer address keeps no way into staff (2026-09-24). Only the live host changes:
// previews, local runs and this suite keep the old entrances, so these check the rules directly.
test.describe('the customer address, once staff has its own', () => {
  const mw = async (url: string) => {
    const mod = await import(pathToFileURL(resolve(__dirname, '..', 'functions/_middleware.js')).href + '?s=' + Math.random());
    return mod.onRequest({ request: new Request(url), next: () => new Response('asset') }) as Promise<Response>;
  };
  test('the server sends every staff link on to the staff address', async () => {
    const live = 'https://micromobilityrentals.pages.dev';
    for (const [path, to] of [['/staff/', 'https://staff.micromobility.sa/'], ['/staff', 'https://staff.micromobility.sa/'],
      ['/?staff', 'https://staff.micromobility.sa/'], ['/?bike=042', 'https://staff.micromobility.sa/?bike=042'],
      ['/?bike=04A1B2C3D4', 'https://staff.micromobility.sa/?bike=04A1B2C3D4'], ['/?bike=<x>', 'https://staff.micromobility.sa/']]) {
      const r = await mw(live + path);
      expect(r.status, path).toBe(302);
      expect(r.headers.get('location'), path).toBe(to);
    }
    expect((await mw(live + '/')).status).toBe(200);
    expect((await mw(live + '/?lang=ar')).status).toBe(200);
  });
  test('previews and other hosts keep the old entrances', async () => {
    expect((await mw('https://abc123.micromobilityrentals.pages.dev/staff/')).status).toBe(200);
    expect((await mw('https://staff.micromobility.sa/?bike=042')).status).toBe(200);
  });
  test('the page does the same when the offline cache answered it', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await page.goto('/');
    await waitForSb(page);
    const r = await page.evaluate(`[
      _staffRedirectFor('micromobilityrentals.pages.dev','?bike=042',false),
      _staffRedirectFor('micromobilityrentals.pages.dev','?staff',false),
      _staffRedirectFor('micromobilityrentals.pages.dev','',true),
      _staffRedirectFor('micromobilityrentals.pages.dev','?lang=ar',false),
      _staffRedirectFor('127.0.0.1','?staff',false),
      _staffRedirectFor('staff.micromobility.sa','?bike=042',false)]`);
    expect(r).toEqual(['https://staff.micromobility.sa/?bike=042', 'https://staff.micromobility.sa/', 'https://staff.micromobility.sa/', '', '', '']);
  });
  test('locally the Staff Access button is still there (only the live address hides it)', async ({ page }) => {
    await stubSupabase(page, { sessions, queue_entries: [], bikes: [] });
    await page.goto('/');
    await waitForSb(page);
    expect(await page.evaluate(`document.body.classList.contains('no-staff-entry')`)).toBe(false);
  });
});
