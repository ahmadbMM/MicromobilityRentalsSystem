// Help (the user, 2026-11-16: "do 1 5" of the booking app's new sections): Account > Help, at /account/help. The answers
// staff keep under Website > Help > "Rides & bookings" (site_content help.topics.rides, the same list micromobility.sa/help
// shows), else this file's own; a message to the team through site_message_send (kind help, topic app: it lands in the
// staff page's Messages, linked to the account by its session token); and WhatsApp us / Call us on the business line.
// The answers are drafted from rules already set (cancelling from Bookings, helmets with every bike, things left behind
// kept 14 days); nothing about refunds or ages, which are not settled for every experience.
// Words staff saved: English and Arabic as they wrote them. Any other language shows this file's translation of an answer
// staff left as shipped, else their English (nobody has translated their change yet), as the event sheets do (_infoText).
// A file of its own, fetched when the page first opens (_rhPageOpen in app.src.html), with its own words in ten languages.
// Hand-written, not generated; the build stamps its address (RH_V).
/* global S, sb, esc, _on, _EL, getSession */
const RH_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const RH_T = {
  askH: ['Send us a message', 'أرسل لنا رسالة', 'Envoyez-nous un message', 'Envíanos un mensaje', 'Envie-nos uma mensagem', 'ہمیں پیغام بھیجیں', 'हमें संदेश भेजें', 'Magpadala sa amin ng mensahe', 'हामीलाई सन्देश पठाउनुहोस्', 'আমাদের মেসেজ পাঠান'],
  msgL: ['Your message', 'رسالتك', 'Votre message', 'Tu mensaje', 'A sua mensagem', 'آپ کا پیغام', 'आपका संदेश', 'Ang mensahe mo', 'तपाईंको सन्देश', 'আপনার মেসেজ'],
  send: ['Send message', 'أرسل الرسالة', 'Envoyer le message', 'Enviar mensaje', 'Enviar mensagem', 'پیغام بھیجیں', 'संदेश भेजें', 'Ipadala ang mensahe', 'सन्देश पठाउनुहोस्', 'মেসেজ পাঠান'],
  sent: ['Message sent', 'تم إرسال رسالتك', 'Message envoyé', 'Mensaje enviado', 'Mensagem enviada', 'پیغام بھیج دیا گیا', 'संदेश भेज दिया गया', 'Naipadala ang mensahe', 'सन्देश पठाइयो', 'মেসেজ পাঠানো হয়েছে'],
  again: ['Write another', 'اكتب رسالة أخرى', 'Écrire un autre message', 'Escribir otro', 'Escrever outra', 'ایک اور لکھیں', 'एक और लिखें', 'Sumulat ng isa pa', 'अर्को लेख्नुहोस्', 'আরেকটি লিখুন'],
  errEmpty: ['Write your message first.', 'اكتب رسالتك أولاً.', "Écrivez d'abord votre message.", 'Escribe primero tu mensaje.', 'Escreva primeiro a sua mensagem.', 'پہلے اپنا پیغام لکھیں۔', 'पहले अपना संदेश लिखें।', 'Isulat muna ang mensahe mo.', 'पहिले आफ्नो सन्देश लेख्नुहोस्।', 'আগে আপনার মেসেজ লিখুন।'],
  errBusy: ['Too many messages. Please try again in a few minutes.', 'رسائل كثيرة. يرجى المحاولة بعد دقائق.', 'Trop de messages. Réessayez dans quelques minutes.', 'Demasiados mensajes. Inténtalo de nuevo en unos minutos.', 'Demasiadas mensagens. Tente novamente daqui a alguns minutos.', 'بہت زیادہ پیغامات۔ چند منٹ بعد دوبارہ کوشش کریں۔', 'बहुत सारे संदेश। कुछ मिनट बाद फिर कोशिश करें।', 'Masyadong maraming mensahe. Subukang muli pagkalipas ng ilang minuto.', 'धेरै सन्देशहरू। केही मिनेटपछि फेरि प्रयास गर्नुहोस्।', 'অনেক বেশি মেসেজ। কয়েক মিনিট পরে আবার চেষ্টা করুন।'],
  errContact: ['Add a phone number or email under Contact first.', 'أضف رقم جوال أو بريداً إلكترونياً في «التواصل» أولاً.', "Ajoutez d'abord un numéro ou un e-mail dans Coordonnées.", 'Añade primero un teléfono o un correo en Contacto.', 'Adicione primeiro um telefone ou e-mail em Contato.', 'پہلے «رابطہ» میں فون نمبر یا ای میل شامل کریں۔', 'पहले «संपर्क» में फ़ोन नंबर या ईमेल जोड़ें।', 'Magdagdag muna ng numero o email sa Contact.', 'पहिले «सम्पर्क» मा फोन नम्बर वा इमेल थप्नुहोस्।', 'আগে «যোগাযোগ»-এ ফোন নম্বর বা ইমেইল যোগ করুন।'],
  err: ['We could not send it. Please try again.', 'تعذّر الإرسال. يرجى المحاولة مرة أخرى.', 'Envoi impossible. Veuillez réessayer.', 'No se pudo enviar. Inténtalo de nuevo.', 'Não foi possível enviar. Tente novamente.', 'بھیجا نہیں جا سکا۔ دوبارہ کوشش کریں۔', 'भेजा नहीं जा सका। फिर कोशिश करें।', 'Hindi naipadala. Pakisubukang muli.', 'पठाउन सकिएन। फेरि प्रयास गर्नुहोस्।', 'পাঠানো যায়নি। আবার চেষ্টা করুন।'],
};
// The answers this file ships: the website's "Rides & bookings" defaults in English and Arabic (apps/web/src/content/
// pages/help.ts), the other eight in the app's own words for Bookings, Cancel, Need help? and the helmet line.
const RH_QA = [
  {
    q: ['How do I book?', 'كيف أحجز؟', 'Comment réserver ?', '¿Cómo reservo?', 'Como faço uma reserva?', 'بکنگ کیسے کروں؟', 'बुकिंग कैसे करूँ?', 'Paano mag-book?', 'बुकिङ कसरी गर्ने?', 'কীভাবে বুক করব?'],
    a: ['Choose an experience and a date, add who is coming and confirm. Your booking then shows under Bookings.', 'اختر التجربة والتاريخ، وأضف من سيحضر، ثم أكّد. سيظهر حجزك بعدها في «الحجوزات».', 'Choisissez une expérience et une date, ajoutez les participants et confirmez. Votre réservation apparaît ensuite dans Réservations.', 'Elige una experiencia y una fecha, añade quién viene y confirma. Tu reserva aparecerá en Reservas.', 'Escolha uma experiência e uma data, adicione quem vai e confirme. A sua reserva aparece depois em Reservas.', 'تجربہ اور تاریخ منتخب کریں، آنے والوں کو شامل کریں اور تصدیق کریں۔ پھر آپ کی بکنگ «بکنگز» میں نظر آئے گی۔', 'कोई अनुभव और तारीख चुनें, आने वालों को जोड़ें और पुष्टि करें। फिर आपकी बुकिंग «बुकिंग» में दिखेगी।', 'Pumili ng experience at petsa, idagdag kung sino ang sasama, at kumpirmahin. Makikita mo ang booking mo sa Mga Booking.', 'अनुभव र मिति छान्नुहोस्, को-को आउँदै हुनुहुन्छ थप्नुहोस् र पुष्टि गर्नुहोस्। त्यसपछि तपाईंको बुकिङ «बुकिङ» मा देखिन्छ।', 'একটি অভিজ্ঞতা ও তারিখ বেছে নিন, কারা আসছেন যোগ করুন এবং নিশ্চিত করুন। এরপর আপনার বুকিং «বুকিং»-এ দেখাবে।'],
  },
  {
    q: ['Can I cancel my booking?', 'هل يمكنني إلغاء حجزي؟', 'Puis-je annuler ma réservation ?', '¿Puedo cancelar mi reserva?', 'Posso cancelar a minha reserva?', 'کیا میں اپنی بکنگ منسوخ کر سکتا ہوں؟', 'क्या मैं अपनी बुकिंग रद्द कर सकता हूँ?', 'Puwede ko bang kanselahin ang booking ko?', 'के म मेरो बुकिङ रद्द गर्न सक्छु?', 'আমি কি বুকিং বাতিল করতে পারি?'],
    a: ['Yes. Find it under Bookings and tap Cancel, so someone else can take the place.', 'نعم. اضغط «إلغاء» على الحجز في «الحجوزات»، ليأخذ مكانك شخص آخر.', "Oui. Retrouvez-la dans Réservations et touchez Annuler, pour que quelqu'un d'autre puisse prendre la place.", 'Sí. Búscala en Reservas y toca Cancelar, para que otra persona pueda ocupar la plaza.', 'Sim. Encontre-a em Reservas e toque em Cancelar, para que outra pessoa possa ficar com o lugar.', 'جی ہاں۔ اسے «بکنگز» میں تلاش کریں اور «منسوخ کریں» دبائیں، تاکہ کوئی اور یہ جگہ لے سکے۔', 'हाँ। उसे «बुकिंग» में ढूँढें और «रद्द करें» दबाएँ, ताकि कोई और यह जगह ले सके।', 'Oo. Hanapin ito sa Mga Booking at pindutin ang Kanselahin, para may ibang makakuha ng puwesto.', 'सक्नुहुन्छ। «बुकिङ» मा यसलाई फेला पार्नुहोस् र «रद्द गर्नुहोस्» थिच्नुहोस्, ताकि अरू कसैले त्यो ठाउँ लिन सकून्।', 'হ্যাঁ। «বুকিং»-এ সেটি খুঁজে «বাতিল» চাপুন, যাতে অন্য কেউ জায়গাটি নিতে পারেন।'],
  },
  {
    q: ['Where do we meet?', 'أين نلتقي؟', 'Où se retrouve-t-on ?', '¿Dónde nos encontramos?', 'Onde nos encontramos?', 'ہم کہاں ملیں گے؟', 'हम कहाँ मिलेंगे?', 'Saan tayo magkikita?', 'हामी कहाँ भेट्छौं?', 'আমরা কোথায় দেখা করব?'],
    a: ['Your ticket under Bookings shows where and when to meet.', 'تذكرتك في «الحجوزات» تبيّن مكان اللقاء ووقته.', 'Votre billet dans Réservations indique le lieu et l\'heure du rendez-vous.', 'Tu entrada en Reservas indica el lugar y la hora del encuentro.', 'O seu bilhete em Reservas mostra o local e a hora do encontro.', '«بکنگز» میں آپ کا ٹکٹ ملنے کی جگہ اور وقت بتاتا ہے۔', '«बुकिंग» में आपका टिकट मिलने की जगह और समय बताता है।', 'Makikita sa ticket mo sa Mga Booking kung saan at kailan magkikita.', '«बुकिङ» मा तपाईंको टिकटले भेट्ने ठाउँ र समय देखाउँछ।', '«বুকিং»-এ আপনার টিকিটে দেখা করার জায়গা ও সময় দেখানো থাকে।'],
  },
  {
    q: ['Do I need my own helmet?', 'هل أحتاج إلى خوذة خاصة بي؟', 'Ai-je besoin de mon propre casque ?', '¿Necesito mi propio casco?', 'Preciso do meu próprio capacete?', 'کیا مجھے اپنا ہیلمٹ چاہیے؟', 'क्या मुझे अपना हेलमेट चाहिए?', 'Kailangan ko ba ng sariling helmet?', 'के मलाई आफ्नै हेलमेट चाहिन्छ?', 'আমার কি নিজের হেলমেট লাগবে?'],
    a: ['No. Helmets are required. One comes with every bike.', 'لا. الخوذة إلزامية، وتأتي خوذة مع كل دراجة.', 'Non. Le casque est obligatoire. Un casque est fourni avec chaque vélo.', 'No. El casco es obligatorio. Cada bicicleta incluye uno.', 'Não. O capacete é obrigatório. Cada bicicleta vem com um.', 'نہیں۔ ہیلمٹ لازمی ہے۔ ہر سائیکل کے ساتھ ایک ہیلمٹ ملتا ہے۔', 'नहीं। हेलमेट ज़रूरी है। हर साइकिल के साथ एक हेलमेट मिलता है।', 'Hindi. Kailangan ang helmet. May kasamang helmet ang bawat bisikleta.', 'चाहिँदैन। हेलमेट अनिवार्य छ। हरेक साइकलसँग एउटा हेलमेट दिइन्छ।', 'না। হেলমেট বাধ্যতামূলক। প্রতিটি সাইকেলের সাথে একটি হেলমেট দেওয়া হয়।'],
  },
  {
    q: ['What if I need help during a ride?', 'ماذا لو احتجت مساعدة أثناء الجولة؟', "Et si j'ai besoin d'aide pendant une sortie ?", '¿Y si necesito ayuda durante una salida?', 'E se eu precisar de ajuda durante um passeio?', 'اگر سواری کے دوران مدد چاہیے ہو تو؟', 'अगर राइड के दौरान मदद चाहिए तो?', 'Paano kung kailangan ko ng tulong habang nasa ride?', 'सवारीको बेला सहयोग चाहियो भने?', 'রাইডের সময় সাহায্য লাগলে কী করব?'],
    a: ['Tap Need help? on your ticket under Bookings to message or call us, with your location.', 'اضغط «تحتاج مساعدة؟» على تذكرتك في «الحجوزات» لتراسلنا أو تتصل بنا، مع موقعك.', "Touchez Besoin d'aide ? sur votre billet dans Réservations pour nous écrire ou nous appeler, avec votre position.", 'Toca ¿Necesitas ayuda? en tu entrada en Reservas para escribirnos o llamarnos, con tu ubicación.', 'Toque em Precisa de ajuda? no seu bilhete em Reservas para nos escrever ou ligar, com a sua localização.', '«بکنگز» میں اپنے ٹکٹ پر «مدد چاہیے؟» دبائیں اور اپنی لوکیشن کے ساتھ ہمیں پیغام بھیجیں یا کال کریں۔', '«बुकिंग» में अपने टिकट पर «मदद चाहिए?» दबाएँ और अपनी लोकेशन के साथ हमें मैसेज या कॉल करें।', 'Pindutin ang Kailangan ng tulong? sa ticket mo sa Mga Booking para mag-message o tumawag sa amin, kasama ang lokasyon mo.', '«बुकिङ» मा आफ्नो टिकटमा «सहयोग चाहिन्छ?» थिच्नुहोस् र आफ्नो लोकेसनसहित हामीलाई सन्देश पठाउनुहोस् वा फोन गर्नुहोस्।', '«বুকিং»-এ আপনার টিকিটে «সাহায্য দরকার?» চাপুন, আপনার লোকেশনসহ আমাদের মেসেজ বা কল করতে।'],
  },
  {
    q: ['I left something behind.', 'نسيت شيئاً بعد الجولة.', "J'ai oublié quelque chose.", 'Olvidé algo.', 'Esqueci-me de algo.', 'میں کچھ بھول گیا ہوں۔', 'मैं कुछ भूल गया।', 'May naiwan ako.', 'मैले केही छोडें।', 'আমি কিছু ফেলে এসেছি।'],
    a: ['Things left behind are kept for 14 days. Send us a message below with your booking date and what you left.', 'نحتفظ بالأغراض المنسية 14 يوماً. أرسل لنا رسالة من الأسفل بتاريخ حجزك وما نسيته.', 'Les objets oubliés sont gardés 14 jours. Envoyez-nous un message ci-dessous avec la date de votre réservation et ce que vous avez oublié.', 'Los objetos olvidados se guardan 14 días. Envíanos un mensaje abajo con la fecha de tu reserva y lo que olvidaste.', 'Os objetos esquecidos ficam guardados 14 dias. Envie-nos uma mensagem abaixo com a data da reserva e o que deixou.', 'بھولی ہوئی چیزیں 14 دن تک رکھی جاتی ہیں۔ نیچے ہمیں اپنی بکنگ کی تاریخ اور بھولی ہوئی چیز کے بارے میں پیغام بھیجیں۔', 'भूली हुई चीज़ें 14 दिन तक रखी जाती हैं। नीचे हमें अपनी बुकिंग की तारीख और भूली हुई चीज़ के बारे में संदेश भेजें।', 'Itinatago namin ang mga naiwang gamit nang 14 na araw. Magpadala sa amin ng mensahe sa ibaba kasama ang petsa ng booking mo at kung ano ang naiwan.', 'छुटेका सामान 14 दिनसम्म राखिन्छन्। तल आफ्नो बुकिङको मिति र छुटेको सामानबारे हामीलाई सन्देश पठाउनुहोस्।', 'ফেলে যাওয়া জিনিস 14 দিন রাখা হয়। নিচে আপনার বুকিংয়ের তারিখ ও কী ফেলে এসেছেন লিখে আমাদের মেসেজ পাঠান।'],
  },
];
function _rhT(k) { return _rhL(RH_T[k] || []); }
function _rhL(r) { const i = RH_LANGS.indexOf(S.lang); return r[i < 0 ? 0 : i] || r[0] || ''; }
// ── The answers: staff's list when Website > Help has one saved, read once every ten minutes ─────────────────────
function _rhQaLoad() {
  const Q = S._rhQ;
  if (!sb || (Q && (Q.busy || Date.now() - Q.at < 6e5))) return;
  S._rhQ = { busy: true, at: Date.now(), list: Q ? Q.list : null };
  Promise.resolve(sb.from('site_content').select('value').eq('key', 'help.topics.rides').maybeSingle()).then((r) => {
    const v = r && !r.error && r.data ? r.data.value : null, was = Q ? Q.list : null;
    S._rhQ = { busy: false, at: Date.now(), list: Array.isArray(v) ? v : r && r.error ? was : null };
    _rhQaPaint();
  }, () => { S._rhQ = { busy: false, at: Date.now(), list: Q ? Q.list : null }; });
}
function _rhQa() {
  const L = S.lang || 'en', list = S._rhQ && S._rhQ.list, s = (v) => (typeof v === 'string' ? v.trim() : '');
  if (!list) return RH_QA.map((x) => ({ q: _rhL(x.q), a: _rhL(x.a) }));
  return list.map((it) => {
    const q = (it && it.q) || {}, a = (it && it.a) || {};
    if (L === 'en' || L === 'ar') return { q: s(q[L]) || s(q.en), a: s(a[L]) || s(a.en) };
    if (s(q[L]) && s(a[L])) return { q: s(q[L]), a: s(a[L]) };
    const k = RH_QA.find((d) => d.q[0] === s(q.en) && d.a[0] === s(a.en));
    return k ? { q: _rhL(k.q), a: _rhL(k.a) } : { q: s(q.en), a: s(a.en) };
  }).filter((x) => x.q && x.a);
}
function _rhQaHtml() {
  return _rhQa().map((x) => `<details class="rh-q"><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join('');
}
function _rhQaPaint() {
  const h = document.getElementById('rh-qs');
  if (!h) return;
  // the ones open stay open, by their place in the list
  const open = [...h.querySelectorAll('details')].map((d) => d.open);
  h.innerHTML = _rhQaHtml();
  h.querySelectorAll('details').forEach((d, i) => { if (open[i]) d.open = true; });
}
// ── The page ─────────────────────────────────────────────────────────────────────────────────────────────────────
// S._rhM: {id: the account, text: what is typed (kept through the account page's repaints), ref: the reference of the
// message sent, err, busy}.
function _rhPage() {
  const h = document.getElementById('rh-help'), c = S.loggedIn || getSession(), dep = window._rhDeps || {};
  if (!h || !c) return;
  _rhQaLoad();
  const M = S._rhM && S._rhM.id === c.id ? S._rhM : (S._rhM = { id: c.id, text: '', ref: '', err: '', busy: false });
  const ic = (k, px) => (dep.ic ? dep.ic(k, px) : ''), w = (k) => (dep.words ? dep.words(k) : k), biz = dep.biz || '966566668818';
  h.innerHTML = `<div class="rh-qs" id="rh-qs">${_rhQaHtml()}</div>
    <section class="form-section acc-pg-card rh-ask" aria-labelledby="rh-ask-h">
      <h3 class="rh-ask-h" id="rh-ask-h">${_rhT('askH')}</h3>
      <div id="rh-ask-body">${_rhAskHtml(M, ic)}</div>
    </section>
    <div class="rh-talk">
      <a class="btn-secondary rh-talk-wa" href="https://wa.me/${esc(biz)}" target="_blank" rel="noopener noreferrer">${ic('chat', 18)}<span>${esc(w('rhWa'))}</span></a>
      <a class="btn-secondary rh-talk-call" href="tel:+${esc(biz)}">${ic('phone', 18)}<span>${esc(w('rhCall'))}</span></a>
    </div>`;
}
function _rhAskHtml(M, ic) {
  if (M.ref) {
    return `<p class="rh-sent" id="rh-sent" role="status" tabindex="-1">${ic('tick', 18)}<span>${_rhT('sent')}</span><bdi dir="ltr" class="rh-ref">${esc(M.ref)}</bdi></p>
      <button type="button" class="btn-secondary rh-again" data-on-click="${_on('_rhAgain')}">${_rhT('again')}</button>`;
  }
  return `<label class="rh-lbl" for="rh-msg">${_rhT('msgL')}</label>
      <textarea id="rh-msg" class="rh-ta" maxlength="2000" rows="4" data-on-input="${_on('_rhInput', _EL)}">${esc(M.text)}</textarea>
      <div id="rh-err" class="rh-err" role="alert">${esc(M.err)}</div>
      <button type="button" class="btn-primary rh-send" data-on-click="${_on('_rhSend')}"${M.busy ? ' disabled' : ''}>${_rhT('send')}</button>`;
}
function _rhAskPaint(focus) {
  const b = document.getElementById('rh-ask-body'), dep = window._rhDeps || {};
  if (!b || !S._rhM) return;
  b.innerHTML = _rhAskHtml(S._rhM, (k, px) => (dep.ic ? dep.ic(k, px) : ''));
  if (focus) { const el = document.getElementById(focus); if (el) try { el.focus({ preventScroll: true }); } catch (_) {} }
}
function _rhInput(el) { if (S._rhM) { S._rhM.text = el.value; if (S._rhM.err) { S._rhM.err = ''; const e = document.getElementById('rh-err'); if (e) e.textContent = ''; } } }
function _rhAgain() { if (S._rhM) { S._rhM.ref = ''; S._rhM.text = ''; S._rhM.err = ''; _rhAskPaint('rh-msg'); } }
function _rhErr(k) {
  const msg = k ? _rhT(k) : '', e = document.getElementById('rh-err');
  if (S._rhM) S._rhM.err = msg;
  if (e) e.textContent = msg;
}
// The reply-to the server asks for (a name, and a mobile or an email): the account's own, each only in a shape the
// function takes (a Saudi mobile is +9665 and eight digits; one kept as 05xxxxxxxx is written that way).
function _rhPhone(p) { p = String(p || '').replace(/[\s-]/g, ''); if (/^05\d{8}$/.test(p)) p = '+966' + p.slice(1); return /^\+[1-9][0-9]{7,14}$/.test(p) && (!/^\+966/.test(p) || /^\+9665[0-9]{8}$/.test(p)) ? p : null; }
function _rhEmail(e) { e = String(e || '').trim().toLowerCase(); return /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) && e.length <= 254 ? e : null; }
async function _rhSend() {
  const c = S.loggedIn || getSession(), M = S._rhM, ta = document.getElementById('rh-msg'), dep = window._rhDeps || {};
  if (!c || !M || M.busy || !ta) return;
  const msg = ta.value.trim().slice(0, 2000);
  if (!msg) { _rhErr('errEmpty'); try { ta.focus(); } catch (_) {} return; }
  if (dep.offline && dep.offline(() => _rhSend())) return;
  const phone = _rhPhone(c.phone), email = _rhEmail(c.email);
  if (!phone && !email) { _rhErr('errContact'); return; }
  M.busy = true; _rhErr('');
  const btn = document.querySelector('#rh-help .rh-send');
  if (btn) btn.disabled = true;
  let r;
  try {
    r = await sb.rpc('site_message_send', { p: { kind: 'help', topic: 'app', name: c.name || '', phone, email, message: msg, lang: S.lang || 'en', customer_id: c.id, token: c.session_token || '' } });
  } catch (e) { r = { error: e }; }
  M.busy = false;
  const d = r && !r.error ? r.data : null;
  if (S._rhM !== M) return; // another account meanwhile
  if (d && d.ok === true) {
    M.ref = String(d.ref || ''); M.text = ''; M.err = '';
    _rhAskPaint('rh-sent'); // the page says it (a status line in place of the form), so no toast as well
    return;
  }
  const b = document.querySelector('#rh-help .rh-send');
  if (b) b.disabled = false;
  _rhErr(d && d.error === 'throttled' ? 'errBusy' : d && d.error === 'contact' ? 'errContact' : 'err');
}
window._rhPage = _rhPage;
