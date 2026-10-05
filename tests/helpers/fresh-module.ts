import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A fresh copy of a Pages Function per call, so a test's throttles and budgets start empty and are
// its own (Playwright's loader keeps one instance per file path, whatever the query). Each copy is a
// file of its own in a temp directory. It used to be a data: URL (2026-10-05), but every stack frame
// of an error inside one carried the whole module as its URL: a logged wallet-pass error printed
// five lines of 790 KB, and GitHub's runner stalls on lines that long. Shard 2 then hung until the
// job limit with no log at all.
const dir = mkdtempSync(join(tmpdir(), 'mm-fn-'));
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
let seq = 0;

/** Imports a fresh copy of the module at `rel` (from the repository root) and returns it. */
export async function freshModule(rel: string): Promise<Record<string, unknown>> {
  const src = readFileSync(resolve(__dirname, '..', '..', rel), 'utf8');
  const file = join(dir, `${++seq}-${basename(rel).replace(/\.m?js$/, '')}.mjs`);
  writeFileSync(file, src);
  return import(pathToFileURL(file).href);
}
