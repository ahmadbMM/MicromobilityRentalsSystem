// A cascade check for the passes that move inline style="…" into classes (playwright.visual.config.ts).
// Screenshots see what is drawn in one state; they do not see a :hover or :focus rule, a rule for
// another width, or a property nothing paints (cursor, transition). An inline style outranks every
// rule that is not !important, and loses to every rule that is. A class that replaces it has to do
// the same, so this lists, for each element, the rules that could decide the same properties:
//   inline: true   every element under `roots` with a style attribute, and each rule of styles.css
//                  that matches it (in any state, at any width) and sets one of its properties
//                  - the specificity the class has to beat.
//   inline: false  every element carrying one of `classes`: its own rules (the ones naming those
//                  classes) against every other rule that matches it; a normal rule that outranks
//                  the element's own for a property it sets, or an !important rule its own
//                  !important rule outranks, is a conflict.
// Passed to page.evaluate, so it is one self-contained function.
export type AuditArg = { roots: string[]; classes: string[]; inline: boolean };
export type AuditRow = { el: string; style?: string; own?: string[]; hits: string[] };

export function cascadeAudit(arg: AuditArg): AuditRow[] {
  type Spec = [number, number, number];
  type Rule = { sel: string; test: string; spec: Spec; media: string; order: number; props: Map<string, boolean> };
  const DYN = /:(hover|focus-visible|focus-within|focus|active|visited|target)(?![\w-])/g;
  const PSEUDO_EL = /::?(before|after|placeholder|selection|marker|backdrop|first-line|first-letter|-webkit-[\w-]+|-moz-[\w-]+)/;
  const identCh = (c: string) => /[\w\-\u00a0-\uffff\\]/.test(c);
  function splitTop(s: string): string[] {
    const out: string[] = []; let d = 0, q = '', cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === '\\') { cur += s[++i] || ''; } else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'") { q = c; cur += c; continue; }
      if (c === '(' || c === '[') d++; else if (c === ')' || c === ']') d--;
      if (c === ',' && !d) { out.push(cur.trim()); cur = ''; continue; }
      cur += c;
    }
    out.push(cur.trim());
    return out.filter(Boolean);
  }
  const max = (l: Spec[]): Spec => l.reduce((m, x) => (cmp(x, m) > 0 ? x : m), [0, 0, 0] as Spec);
  const cmp = (x: Spec, y: Spec) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  function spec(s: string): Spec {
    let a = 0, b = 0, c = 0, i = 0;
    const skipIdent = () => { while (i < s.length && identCh(s[i])) { if (s[i] === '\\') i++; i++; } };
    const inner = () => { // s[i] === '(' : returns the text inside the matching ')'
      let d = 0; const st = i + 1;
      for (; i < s.length; i++) { if (s[i] === '(') d++; else if (s[i] === ')') { d--; if (!d) break; } }
      i++; return s.slice(st, i - 1);
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '#') { a++; i++; skipIdent(); continue; }
      if (ch === '.') { b++; i++; skipIdent(); continue; }
      if (ch === '[') { b++; let q = ''; for (i++; i < s.length; i++) { if (q) { if (s[i] === q) q = ''; } else if (s[i] === '"' || s[i] === "'") q = s[i]; else if (s[i] === ']') break; } i++; continue; }
      if (ch === ':') {
        if (s[i + 1] === ':') { c++; i += 2; skipIdent(); if (s[i] === '(') inner(); continue; }
        i++; const st = i; skipIdent(); const name = s.slice(st, i).toLowerCase();
        if (['before', 'after', 'first-line', 'first-letter'].includes(name)) { c++; continue; }
        if (s[i] === '(') {
          const txt = inner();
          if (name === 'where') continue;
          if (['is', 'not', 'has', 'matches', '-webkit-any'].includes(name)) { const m = max(splitTop(txt).map(spec)); a += m[0]; b += m[1]; c += m[2]; continue; }
          b++;
          const of = /\sof\s(.+)$/i.exec(txt);
          if (of && /^nth-(last-)?child$/.test(name)) { const m = max(splitTop(of[1]).map(spec)); a += m[0]; b += m[1]; c += m[2]; }
          continue;
        }
        b++; continue;
      }
      if (/[a-zA-Z_\u00a0-\uffff-]/.test(ch)) { c++; skipIdent(); continue; }
      i++;
    }
    return [a, b, c];
  }
  const rules: Rule[] = [];
  let order = 0;
  const walk = (list: CSSRuleList, media: string) => {
    for (const r of Array.from(list)) {
      if (r instanceof CSSStyleRule) {
        const props = new Map<string, boolean>();
        for (let k = 0; k < r.style.length; k++) props.set(r.style[k], r.style.getPropertyPriority(r.style[k]) === 'important');
        const o = order++;
        for (const sel of splitTop(r.selectorText)) {
          if (PSEUDO_EL.test(sel)) continue;
          let test = sel.replace(/:not\(\s*:(hover|focus-visible|focus-within|focus|active)\s*\)/g, '').replace(DYN, '').trim();
          if (!test || /[>+~]$/.test(test)) test += '*';
          rules.push({ sel, test, spec: spec(sel), media, order: o, props });
        }
      } else if (r instanceof CSSMediaRule) walk(r.cssRules, (media ? media + ' and ' : '') + r.conditionText);
      else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules, media);
    }
  };
  for (const sh of Array.from(document.styleSheets)) if (sh.href && /\/styles\.css(\?|$)/.test(sh.href)) walk(sh.cssRules, '');
  const matches = (el: Element, r: Rule) => { try { return el.matches(r.test); } catch { try { return el.matches(r.sel); } catch { return false; } } };
  const name = (el: Element) => {
    const path: string[] = [];
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      path.unshift(n.id ? '#' + n.id : n.tagName.toLowerCase() + (n.classList.length ? '.' + [...n.classList].join('.') : ''));
      if (n.id) break;
    }
    return path.join(' > ');
  };
  const fmt = (r: Rule, props: string[]) => `${r.sel} (${r.spec.join(',')})${r.media ? ' @' + r.media : ''} {${props.join(' ')}}`;
  const out: AuditRow[] = [];
  const own = new Set(arg.classes);
  const ownRule = (r: Rule) => [...r.sel.matchAll(/\.([\w-]+)/g)].some((m) => own.has(m[1]));
  const els = new Set<Element>();
  for (const root of arg.roots) for (const top of Array.from(document.querySelectorAll(root))) {
    for (const el of [top, ...Array.from(top.querySelectorAll('*'))]) {
      if (arg.inline ? el.hasAttribute('style') : [...el.classList].some((k) => own.has(k))) els.add(el);
    }
  }
  for (const el of els) {
    if (arg.inline) {
      const st = (el as HTMLElement).style, mine = new Set<string>();
      for (let k = 0; k < st.length; k++) mine.add(st[k]);
      const hits: string[] = [];
      for (const r of rules) {
        const p = [...r.props.keys()].filter((k) => mine.has(k));
        if (p.length && matches(el, r)) hits.push((p.some((k) => r.props.get(k)) ? '!important ' : '') + fmt(r, p));
      }
      out.push({ el: name(el), style: el.getAttribute('style') || '', hits });
      continue;
    }
    const mineRules = rules.filter((r) => ownRule(r) && matches(el, r));
    const best = new Map<string, Rule>(); // the own rule that decides each property
    for (const r of mineRules) for (const [p, imp] of r.props) {
      const cur = best.get(p);
      if (!cur || (imp && !cur.props.get(p)) || (imp === !!cur.props.get(p) && (cmp(r.spec, cur.spec) > 0 || (!cmp(r.spec, cur.spec) && r.order > cur.order)))) best.set(p, r);
    }
    const hits: string[] = [];
    for (const r of rules) {
      if (ownRule(r)) continue;
      const bad = [...r.props.keys()].filter((p) => {
        const m = best.get(p); if (!m) return false;
        const mImp = !!m.props.get(p), oImp = !!r.props.get(p), c = cmp(r.spec, m.spec);
        if (mImp) return oImp && (c < 0 || (!c && r.order < m.order)); // an !important rule that beat the inline style must still win
        return !oImp && (c > 0 || (!c && r.order > m.order)); // a normal rule the inline style beat must still lose
      });
      if (bad.length && matches(el, r)) hits.push(fmt(r, bad));
    }
    out.push({ el: name(el), own: mineRules.map((r) => fmt(r, [...r.props.keys()])), hits });
  }
  return out;
}

// Every element under `roots`, its computed style as one hash (FNV-1a over the values), keyed by
// its place in the tree: two builds that draw the same page give the same map, and a property that
// no screenshot shows (cursor, transition, a colour under the pointer) still counts. `ignore` (a
// pattern) leaves out the custom properties a pass adds to carry run-time values (data-cssv): the
// build before it has none, and what they decide - a width, a colour - is hashed where it lands.
// `stripOrigin` drops the page's origin from the values (a mask or background url() resolves to
// http://127.0.0.1:<VIS_PORT>/...), so a baseline does not hold only on the port it was taken on.
export function styleHashes(arg: string[] | { roots: string[]; ignore?: string; stripOrigin?: boolean }): Record<string, string> {
  const roots = Array.isArray(arg) ? arg : arg.roots;
  const ign = !Array.isArray(arg) && arg.ignore ? new RegExp(arg.ignore) : null;
  const origin = !Array.isArray(arg) && arg.stripOrigin ? location.origin : '';
  const out: Record<string, string> = {};
  document.getAnimations().forEach((a) => a.cancel()); // an animation's current frame is not the page
  for (const root of roots) for (const top of Array.from(document.querySelectorAll(root))) {
    const walk = (el: Element, key: string) => {
      const cs = getComputedStyle(el), names: string[] = [];
      for (let k = 0; k < cs.length; k++) names.push(cs[k]);
      let h = 0x811c9dc5;
      for (const n of names.sort()) { // custom properties come in no fixed order
        if (ign && ign.test(n)) continue;
        const v = cs.getPropertyValue(n);
        const s = n + ':' + (origin ? v.split(origin).join('') : v) + ';';
        for (let j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 0x01000193) >>> 0; }
      }
      out[key] = h.toString(16).padStart(8, '0');
      Array.from(el.children).forEach((ch, i) => walk(ch, key + '>' + ch.tagName.toLowerCase() + ':' + i));
    };
    walk(top, root);
  }
  return out;
}

// The same, property by property, for one element: what to print when a hash differs.
// `sel` is a selector, or a key of styleHashes ('body>main:4>div:1').
export function styleOf(sel: string): Record<string, string> {
  let el: Element | null;
  if (/:\d+(>|$)/.test(sel)) {
    const [root, ...steps] = sel.split('>');
    el = document.querySelector(root);
    for (const st of steps) el = el ? el.children[Number(st.split(':')[1])] || null : null;
  } else el = document.querySelector(sel);
  if (!el) return {};
  const cs = getComputedStyle(el), o: Record<string, string> = {}, names: string[] = [];
  for (let k = 0; k < cs.length; k++) names.push(cs[k]);
  for (const n of names.sort()) o[n] = cs.getPropertyValue(n);
  o['(element)'] = el.outerHTML.slice(0, 300);
  return o;
}
