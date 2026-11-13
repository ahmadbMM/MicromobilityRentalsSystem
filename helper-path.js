// Helper path (new features F23, 2026-11-13; migration 20261114082300): the member's own step on the path rider, helper,
// trainee ride leader, ride leader, their helper days (the days of the volunteer shifts they attended) and the helper-day
// ladder, drawn as the badge tiles are. A card on Account > Badges, between the badges and the titles card, and a line on
// Account > Stats under Rides led. Everything here is the member's own (S._hpMine, the answer of customer_helper_path):
// members see nothing of each other, so no other member's step or days is ever read or drawn.
// A file of its own, fetched only for a member (_hpShow in app.src.html), with its own words in all ten languages.
// Hand-written, not generated; the build stamps its address (HP_V).
/* global S, esc, getSession, _cuIc, _bdgMedal */
const HP_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const HP_T = {
  title: ['Helper path', 'مسار المساعد', 'Parcours d’assistant', 'Camino de ayudante', 'Percurso de ajudante', 'مددگار کا راستہ', 'सहायक पथ', 'Landas ng helper', 'सहयोगी पथ', 'সহায়ক পথ'],
  s0: ['Rider', 'راكب', 'Cycliste', 'Ciclista', 'Ciclista', 'سوار', 'राइडर', 'Rider', 'राइडर', 'রাইডার'],
  s1: ['Helper', 'مساعد', 'Assistant', 'Ayudante', 'Ajudante', 'مددگار', 'सहायक', 'Helper', 'सहयोगी', 'সহায়ক'],
  s2: ['Trainee ride leader', 'قائد جولة متدرّب', 'Chef de sortie en formation', 'Líder de salida en formación', 'Líder de passeio em formação', 'زیرِ تربیت رائیڈ لیڈر', 'प्रशिक्षु राइड लीडर', 'Trainee ride leader', 'प्रशिक्षार्थी राइड लिडर', 'শিক্ষানবিশ রাইড লিডার'],
  s3: ['Ride leader', 'قائد الجولة', 'Chef de sortie', 'Líder de salida', 'Líder de passeio', 'رائیڈ لیڈر', 'राइड लीडर', 'Ride leader', 'राइड लिडर', 'রাইড লিডার'],
  next: ['Next step: {0}', 'الخطوة التالية: {0}', 'Prochaine étape : {0}', 'Siguiente paso: {0}', 'Próximo passo: {0}', 'اگلا مرحلہ: {0}', 'अगला चरण: {0}', 'Susunod na hakbang: {0}', 'अर्को चरण: {0}', 'পরের ধাপ: {0}'],
  days: ['Helper days', 'أيام المساعدة', 'Jours d’aide', 'Días de ayuda', 'Dias de ajuda', 'مدد کے دن', 'सहायता के दिन', 'Mga araw ng pagtulong', 'सहयोगका दिन', 'সহায়তার দিন'],
  line: ['Helper days: {0}', 'أيام المساعدة: {0}', 'Jours d’aide : {0}', 'Días de ayuda: {0}', 'Dias de ajuda: {0}', 'مدد کے دن: {0}', 'सहायता के दिन: {0}', 'Mga araw ng pagtulong: {0}', 'सहयोगका दिन: {0}', 'সহায়তার দিন: {0}'],
  b1: ['1 helper day', 'يوم مساعدة واحد', '1 jour d’aide', '1 día de ayuda', '1 dia de ajuda', 'مدد کا 1 دن', 'सहायता का 1 दिन', '1 araw ng pagtulong', 'सहयोगको 1 दिन', 'সহায়তার 1 দিন'],
  b5: ['5 helper days', '5 أيام مساعدة', '5 jours d’aide', '5 días de ayuda', '5 dias de ajuda', 'مدد کے 5 دن', 'सहायता के 5 दिन', '5 araw ng pagtulong', 'सहयोगका 5 दिन', 'সহায়তার 5 দিন'],
  b10: ['10 helper days', '10 أيام مساعدة', '10 jours d’aide', '10 días de ayuda', '10 dias de ajuda', 'مدد کے 10 دن', 'सहायता के 10 दिन', '10 araw ng pagtulong', 'सहयोगका 10 दिन', 'সহায়তার 10 দিন'],
  b25: ['25 helper days', '25 يوم مساعدة', '25 jours d’aide', '25 días de ayuda', '25 dias de ajuda', 'مدد کے 25 دن', 'सहायता के 25 दिन', '25 araw ng pagtulong', 'सहयोगका 25 दिन', 'সহায়তার 25 দিন'],
};
// The helper-day ladder: [days, its name, the medal's colour], in the style of the rides-led ladder.
const HP_LADDER = [[1, 'b1', 'green'], [5, 'b5', 'teal'], [10, 'b10', 'purple'], [25, 'b25', 'gold']];
const HP_STEPS = ['s0', 's1', 's2', 's3'];
function _hpT(k) {
  const row = HP_T[k] || [], i = HP_LANGS.indexOf(S.lang);
  return String(row[i < 0 ? 0 : i] || row[0] || '');
}
function _hpF(k, v) { return _hpT(k).split('{0}').join(String(v)); }
// What the card shows, from the read's answer: the step held in 0..3 and whole helper days, never below zero.
function _hpOwn(a) {
  const step = Math.max(0, Math.min(HP_STEPS.length - 1, Math.floor(Number(a && a.step) || 0)));
  return { step, days: Math.max(0, Math.floor(Number(a && a.days) || 0)) };
}
function _hpCardHtml(o) {
  const steps = HP_STEPS.map((k, i) => `<li class="hp-step${i < o.step ? ' done' : i === o.step ? ' on' : ''}"${i === o.step ? ' aria-current="step"' : ''}>
    <i aria-hidden="true">${i < o.step ? _cuIc('tick', 14) : ''}</i><span>${esc(_hpT(k))}</span></li>`).join('');
  const next = o.step < HP_STEPS.length - 1 ? `<div class="hp-next">${esc(_hpF('next', _hpT(HP_STEPS[o.step + 1])))}</div>` : '';
  const tiles = HP_LADDER.map(([n, k, col]) => `<li class="mr-badge${o.days >= n ? '' : ' locked'}">
    ${o.days >= n ? '' : `<span class="mr-badge-p"><bdi>${o.days}/${n}</bdi></span>`}
    ${_bdgMedal('hand', col)}
    <span class="mr-badge-nm">${esc(_hpT(k))}</span></li>`).join('');
  return `<div class="amb-mine-title">${esc(_hpT('title'))}</div>
    <ol class="hp-steps">${steps}</ol>
    ${next}
    <div class="hp-days"><span class="hp-days-n">${o.days}</span><span class="hp-days-w">${esc(_hpT('days'))}</span></div>
    <ul class="mr-badges hp-badges">${tiles}</ul>`;
}
// Drawn again on every paint of the account page (the panes are written afresh): the old card and line go first, and
// nothing comes back for a rider who is not a member or once another account is signed in.
function _hpRender() {
  const a = S._hpMine, c = S.loggedIn || getSession();
  ['hp-mine', 'hp-line'].forEach((id) => { const el = document.getElementById(id); if (el) el.remove(); });
  if (!a || !a.on || !c || a.forId !== c.id) return;
  const o = _hpOwn(a), host = document.getElementById('acc-pane-badges');
  if (host && host.firstElementChild) {
    const card = document.createElement('div');
    card.id = 'hp-mine'; card.className = 'amb-mine hp-mine';
    card.innerHTML = _hpCardHtml(o);
    host.firstElementChild.insertAdjacentElement('afterend', card); // under the badges, above the titles card
  }
  const season = document.querySelector('#acc-pane-stats .mr-season');
  if (season && o.days > 0) {
    const line = document.createElement('div');
    line.id = 'hp-line'; line.className = 'mr-season-line';
    line.innerHTML = `${_cuIc('people', 18)}<span>${esc(_hpF('line', o.days))}</span>`;
    const lines = season.querySelectorAll('.mr-season-line'), after = lines.length ? lines[lines.length - 1] : season.querySelector('.mr-season-tier');
    if (after) after.insertAdjacentElement('afterend', line); else season.appendChild(line);
  }
}
window._hpRender = _hpRender;
