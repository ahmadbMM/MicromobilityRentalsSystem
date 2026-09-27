import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

// The Content-Security-Policy allows no inline script, so an on<event>="…" attribute in the built page
// is a control that does nothing in production - and the suite runs with the policy bypassed, so a
// click on it still "works" here. Five such handlers (the bike picker rows, the session forms' fleet
// toggles, Delete bike) hid behind a template literal's backtick until 2026-09-28 because the build's
// guard only looked for whitespace before them. This reads the two built files the way the guard now
// does, so the class of mistake cannot come back unnoticed.
const INLINE = /[\s`'"]on[a-z]+=["'][^"']{0,80}/g;

for (const file of ['index.html', 'staff.js']) {
  test(`${file} carries no inline event handler`, () => {
    const text = readFileSync(file, 'utf8');
    const hits = [...text.matchAll(INLINE)].map((m) => m[0].trim()).filter((h) => !/^[`'"]?data-on-/.test(h));
    expect(hits, `inline handlers in ${file}`).toEqual([]);
  });
}
