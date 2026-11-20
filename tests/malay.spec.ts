import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { stubSupabase, unlockStaff, waitForSb } from './helpers/supabase';

// Malay (ms, Bahasa Melayu), the eleventh language (the user, 2026-11-20: "make sure all websites and apps include a
// malay language"). The pack itself is held to every other language's rules by scripts/check-i18n.mjs; this file holds
// the pieces that live outside it: the database's words (migration 20261120230000) and the staff message tables.
const MIG = resolve(__dirname, '../supabase/migrations');
const sql = readFileSync(resolve(MIG, '20261120230000_malay_language.sql'), 'utf8');

test.describe('@customer:account Malay in the database', () => {
  test('every push word the earlier migrations wrote in English has its Malay row', () => {
    const en = new Set<string>();
    for (const f of readdirSync(MIG).filter((x) => x.endsWith('.sql') && x < '20261120230000')) {
      const text = readFileSync(resolve(MIG, f), 'utf8');
      for (const m of text.matchAll(/^\s*\('([a-z_:]+[a-z0-9_]*)',\s*'en',\s*'/gm)) en.add(m[1]);
      // the month names are written from an array, one row per month
      if (/'kind:month' \|\| m\.n/.test(text)) for (let i = 1; i <= 12; i++) en.add(`kind:month${i}`);
    }
    const ms = new Map([...sql.matchAll(/^\s*\('([a-z_:0-9]+)', 'ms', '((?:[^']|'')*)', '((?:[^']|'')*)'\)/gm)].map((m) => [m[1], { title: m[2], body: m[3] }]));
    expect(en.size).toBeGreaterThan(30);
    for (const k of en) expect(ms.has(k), k).toBe(true);
    expect(ms.get('remind')!.body).toContain('{0}');
    expect(ms.get('remind')!.body).toContain('{1}');
    expect(ms.get('kind:month3')!.title).toBe('Mac');
    for (const [k, w] of ms) {
      expect(w.title.length, k).toBeLessThanOrEqual(120);
      expect(w.body.length, k).toBeLessThanOrEqual(300);
    }
  });

  test('both language checks take Malay, the three functions\' lists are extended in place, and the skills are named', () => {
    const L11 = "('en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms')";
    expect(sql).toContain(`alter table public.push_prefs add constraint push_prefs_lang_check check (lang in ${L11});`);
    expect(sql).toContain(`alter table public.push_words add constraint push_words_lang_check check (lang in ${L11});`);
    expect(sql).toMatch(/pg_get_functiondef\(r\.oid\)/);
    expect(sql).toMatch(/proname in \('customer_push_prefs_set', '_updates_text', 'calendar_link'\)/);
    const seed = readFileSync(resolve(MIG, '20261114082100_learn_ladder.sql'), 'utf8');
    const skills = [...seed.matchAll(/^\s*\('([a-z_]+)', \d, \d, '\{"en"/gm)].map((m) => m[1]);
    expect(skills).toHaveLength(16);
    for (const k of skills) expect(sql, k).toMatch(new RegExp(`\\('${k}', '[^']+'\\)`));
    expect(sql).toContain("values ('20261120230000', 'malay_language')");
  });
});

test.describe('@staff:settings Malay in the staff message tables', () => {
  test('every built-in WhatsApp message has its Malay, with the same blanks', async ({ page }) => {
    await stubSupabase(page, { sessions: [], bikes: [], queue_entries: [] });
    await unlockStaff(page);
    await page.goto('/');
    await waitForSb(page);
    await page.waitForFunction(`typeof CA_MSG!=='undefined'&&typeof BD_MSG!=='undefined'`);
    await page.evaluate(`_loadStaffPart('remind')`);
    await page.waitForFunction(`typeof REM_MSG!=='undefined'&&typeof REM_MSG_NC!=='undefined'`);
    const bad = await page.evaluate(`(()=>{const out=[];const T={BD_MSG:typeof BD_MSG!=='undefined'?BD_MSG:null,CA_MSG:typeof CA_MSG!=='undefined'?CA_MSG:null,CA_INV_MSG:typeof CA_INV_MSG!=='undefined'?CA_INV_MSG:null,CA_TP_MSG:typeof CA_TP_MSG!=='undefined'?CA_TP_MSG:null,CA_FIX_MSG:typeof CA_FIX_MSG!=='undefined'?CA_FIX_MSG:null,LA_FIX_MSG:typeof LA_FIX_MSG!=='undefined'?LA_FIX_MSG:null,LA_MSG:typeof LA_MSG!=='undefined'?LA_MSG:null,LM_LINE_DEF:typeof LM_LINE_DEF!=='undefined'?LM_LINE_DEF:null,REM_MSG:typeof REM_MSG!=='undefined'?REM_MSG:null,REM_MSG_NC:typeof REM_MSG_NC!=='undefined'?REM_MSG_NC:null,N6C_LATE_MSG:typeof N6C_LATE_MSG!=='undefined'?N6C_LATE_MSG:null};
      const ph=s=>(String(s).match(/\\{[a-z_0-9]+\\}/g)||[]).sort().join();
      for(const [n,t] of Object.entries(T)){if(!t){out.push(n+': not loaded');continue;}if(!t.ms){out.push(n+': no ms');continue;}
        if(typeof t.en==='string'){if(ph(t.en)!==ph(t.ms))out.push(n);continue;}
        for(const k of Object.keys(t.en)){if(!t.ms[k]||ph(t.en[k])!==ph(t.ms[k]))out.push(n+'.'+k);}}
      return out;})()`);
    expect(bad).toEqual([]);
  });
});
