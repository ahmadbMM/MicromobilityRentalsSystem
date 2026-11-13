// Ask in the Community tab (the user, 2026-11-13: "add the asks questions in the community section in the bookings app").
// The pages staff make in the staff section Ask (migration 20261113010000, AGENTS.md "Ask") are answered here too, as on
// micromobility.sa/ask/<slug>: the feed's "Have your say" card (member-hub.js, ask_list) lists the open pages this account
// may see, and a tap opens the page here (S._hubView 'ask'), drawn from ask_page and kept up to date with ask_live.
// Every kind is answered here (ask_send), an answer waiting for approval can be taken back (ask_unsend), written answers
// take upvotes (ask_vote) and a page whose look turns them on takes reactions (ask_react). Results are drawn with each
// kind's first chart (the website's default for it), only where the database sends them and the question's rule shows
// them (resultsShown). Nothing here names anyone: the functions never send a name to a rider.
// The website's own pages are the model (apps/web/src/components/ask, lib/ask.ts, lib/ask-kinds.ts, lib/ask-pace.ts): the
// same states, the same checks before sending, the same polling (every 10 s, every 2 s on a page staff pace), the
// same quiz clock against the database's time. Their words are the site's own, in the app's ten languages.
// A file of its own, fetched only when a member opens a page (_akLoad in member-hub.js), with the address the build
// stamps (ASK_HUB_V). Hand-written, not generated. No inline style: run-time values go through data-cssv.
/* global S, sb, esc, _on, _EL, _EV, _locale, _isRtl, _skelHtml, _cssv, _hCust, _hTok, _hT, HUB_LANGS, _hubRender */
const AK_T = {
  until: ["Open until {0}", "مفتوح حتى {0}", "Ouvert jusqu’au {0}", "Abierta hasta {0}", "Aberta até {0}", "{0} تک کھلا ہے", "{0} तक खुला है", "Bukas hanggang {0}", "{0} सम्म खुला", "{0} পর্যন্ত খোলা"],
  opens: ["Opens {0}", "يفتح {0}", "Ouvre le {0}", "Abre el {0}", "Abre em {0}", "{0} کو شروع", "{0} को शुरू", "Magbubukas sa {0}", "{0} मा खुल्छ", "{0} তারিখে শুরু"],
  tryLater: ["Please try again in a moment.", "يرجى المحاولة مرة أخرى بعد قليل.", "Veuillez réessayer dans un instant.", "Vuelve a intentarlo en un momento.", "Tente novamente em instantes.", "براہِ کرم تھوڑی دیر بعد دوبارہ کوشش کریں۔", "कृपया थोड़ी देर बाद फिर से कोशिश करें।", "Pakisubukan ulit maya-maya.", "कृपया केही बेरपछि फेरि प्रयास गर्नुहोस्।", "অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।"],
  none: ["This page is not available.", "هذه الصفحة غير متاحة.", "Cette page n’est pas disponible.", "Esta página no está disponible.", "Esta página não está disponível.", "یہ صفحہ دستیاب نہیں۔", "यह पेज उपलब्ध नहीं है।", "Hindi available ang page na ito.", "यो पृष्ठ उपलब्ध छैन।", "এই পৃষ্ঠাটি পাওয়া যাচ্ছে না।"],
  notYours: ["This page is not open to your account.", "هذه الصفحة غير متاحة لحسابك.", "Cette page n’est pas ouverte à votre compte.", "Esta página no está abierta para tu cuenta.", "Esta página não está aberta para a sua conta.", "یہ صفحہ آپ کے اکاؤنٹ کے لیے نہیں کھلا۔", "यह पेज आपके खाते के लिए खुला नहीं है।", "Hindi bukas ang page na ito para sa iyong account.", "यो पृष्ठ तपाईंको खाताका लागि खुला छैन।", "এই পৃষ্ঠাটি আপনার অ্যাকাউন্টের জন্য খোলা নয়।"],
  closedPage: ["This page is closed.", "هذه الصفحة مغلقة.", "Cette page est fermée.", "Esta página está cerrada.", "Esta página está encerrada.", "یہ صفحہ بند ہو چکا ہے۔", "यह पेज बंद हो चुका है।", "Sarado na ang page na ito.", "यो पृष्ठ बन्द भइसकेको छ।", "এই পৃষ্ঠাটি বন্ধ হয়ে গেছে।"],
  closed: ["Answers closed", "أُغلقت الإجابات", "Réponses closes", "Respuestas cerradas", "Respostas encerradas", "جوابات بند ہیں", "जवाब बंद हैं", "Sarado na ang mga sagot", "जवाफ बन्द भयो", "উত্তর নেওয়া বন্ধ"],
  yourAnswer: ["Your answer", "إجابتك", "Votre réponse", "Tu respuesta", "Sua resposta", "آپ کا جواب", "आपका जवाब", "Ang iyong sagot", "तपाईंको जवाफ", "আপনার উত্তর"],
  yourQuestion: ["Your question", "سؤالك", "Votre question", "Tu pregunta", "Sua pergunta", "آپ کا سوال", "आपका सवाल", "Ang iyong tanong", "तपाईंको प्रश्न", "আপনার প্রশ্ন"],
  left: ["{0} characters left", "المتبقي {0} حرفاً", "{0} caractères restants", "Quedan {0} caracteres", "Restam {0} caracteres", "{0} حروف باقی", "{0} अक्षर बाकी", "{0} character na lang", "{0} अक्षर बाँकी", "আর {0}টি অক্ষর বাকি"],
  send: ["Send", "إرسال", "Envoyer", "Enviar", "Enviar", "بھیجیں", "भेजें", "Ipadala", "पठाउनुहोस्", "পাঠান"],
  sending: ["Sending…", "جارٍ الإرسال…", "Envoi en cours…", "Enviando…", "Enviando…", "بھیجا جا رہا ہے…", "भेजा जा रहा है…", "Ipinapadala…", "पठाइँदैछ…", "পাঠানো হচ্ছে…"],
  privacy: ["Your name is never shown with an answer. MicroMobility's team can see who answered.", "لا يظهر اسمك مع أي إجابة أبداً. فريق MicroMobility يرى من أجاب.", "Votre nom n’est jamais affiché avec une réponse. L’équipe de MicroMobility peut voir qui a répondu.", "Tu nombre nunca se muestra junto a una respuesta. El equipo de MicroMobility puede ver quién respondió.", "Seu nome nunca é exibido junto com uma resposta. A equipe da MicroMobility pode ver quem respondeu.", "آپ کا نام کبھی کسی جواب کے ساتھ نہیں دکھایا جاتا۔ MicroMobility کی ٹیم دیکھ سکتی ہے کہ کس نے جواب دیا۔", "आपका नाम कभी भी किसी जवाब के साथ नहीं दिखाया जाता। MicroMobility की टीम देख सकती है कि किसने जवाब दिया।", "Hindi kailanman ipinapakita ang pangalan mo kasama ng sagot. Makikita ng team ng MicroMobility kung sino ang sumagot.", "तपाईंको नाम कहिल्यै पनि कुनै उत्तरसँग देखाइँदैन। MicroMobility को टोलीले कसले उत्तर दिएको हो भनेर देख्न सक्छ।", "আপনার নাম কখনোই কোনো উত্তরের সঙ্গে দেখানো হয় না। MicroMobility-র টিম দেখতে পারে কে উত্তর দিয়েছে।"],
  waiting: ["Waiting for approval", "بانتظار الموافقة", "En attente de validation", "Pendiente de aprobación", "Aguardando aprovação", "منظوری کا انتظار ہے", "मंज़ूरी का इंतज़ार", "Naghihintay ng approval", "स्वीकृतिको प्रतीक्षामा", "অনুমোদনের অপেক্ষায়"],
  rejected: ["Not approved", "لم تتم الموافقة", "Non validée", "No aprobada", "Não aprovada", "منظور نہیں ہوا", "मंज़ूर नहीं हुआ", "Hindi naaprubahan", "स्वीकृत भएन", "অনুমোদিত হয়নি"],
  answered: ["Answered", "تمت الإجابة", "Répondu", "Respondida", "Respondida", "جواب دے دیا گیا", "जवाब दिया गया", "Nasagot na", "जवाफ दिइयो", "উত্তর দেওয়া হয়েছে"],
  remove: ["Remove", "إزالة", "Retirer", "Quitar", "Remover", "ہٹائیں", "हटाएँ", "Alisin", "हटाउनुहोस्", "সরান"],
  up: ["Move {0} up", "تحريك {0} للأعلى", "Monter {0}", "Subir {0}", "Mover {0} para cima", "{0} کو اوپر کریں", "{0} को ऊपर करें", "Itaas ang {0}", "{0} लाई माथि सार्नुहोस्", "{0} উপরে তুলুন"],
  down: ["Move {0} down", "تحريك {0} للأسفل", "Descendre {0}", "Bajar {0}", "Mover {0} para baixo", "{0} کو نیچے کریں", "{0} को नीचे करें", "Ibaba ang {0}", "{0} लाई तल सार्नुहोस्", "{0} নিচে নামান"],
  pointsLeft: ["{0} left", "المتبقي: {0}", "Restant : {0}", "Por repartir: {0}", "A distribuir: {0}", "باقی: {0}", "बाकी: {0}", "{0} na lang", "बाँकी: {0}", "বাকি: {0}"],
  fewer: ["Fewer points for {0}", "نقاط أقل لـ {0}", "Moins de points pour {0}", "Menos puntos para {0}", "Menos pontos para {0}", "{0} کے پوائنٹس کم کریں", "{0} के पॉइंट घटाएँ", "Bawasan ang puntos para sa {0}", "{0} को अंक घटाउनुहोस्", "{0}-এর পয়েন্ট কমান"],
  more: ["More points for {0}", "نقاط أكثر لـ {0}", "Plus de points pour {0}", "Más puntos para {0}", "Mais pontos para {0}", "{0} کے پوائنٹس بڑھائیں", "{0} के पॉइंट बढ़ाएँ", "Dagdagan ang puntos para sa {0}", "{0} को अंक बढाउनुहोस्", "{0}-এর পয়েন্ট বাড়ান"],
  noAnswers: ["No answers yet", "لا توجد إجابات بعد", "Aucune réponse pour l’instant", "Aún no hay respuestas", "Ainda não há respostas", "ابھی کوئی جواب نہیں", "अभी कोई जवाब नहीं", "Wala pang sagot", "अहिलेसम्म कुनै जवाफ छैन", "এখনো কোনো উত্তর নেই"],
  oneAnswer: ["1 answer", "إجابة واحدة", "1 réponse", "1 respuesta", "1 resposta", "1 جواب", "1 जवाब", "1 sagot", "1 जवाफ", "1টি উত্তর"],
  answers: ["{0} answers", "الإجابات: {0}", "{0} réponses", "{0} respuestas", "{0} respostas", "جوابات: {0}", "जवाब: {0}", "Mga sagot: {0}", "जवाफ: {0}", "উত্তর: {0}"],
  average: ["Average {0}", "المتوسط {0}", "Moyenne : {0}", "Promedio: {0}", "Média: {0}", "اوسط {0}", "औसत {0}", "Average: {0}", "औसत {0}", "গড় {0}"],
  correct: ["Correct answer", "الإجابة الصحيحة", "Bonne réponse", "Respuesta correcta", "Resposta correta", "درست جواب", "सही जवाब", "Tamang sagot", "सही जवाफ", "সঠিক উত্তর"],
  upvote: ["Upvote ({0})", "تأييد ({0})", "Voter pour ({0})", "Votar a favor ({0})", "Votar a favor ({0})", "حمایت کریں ({0})", "समर्थन करें ({0})", "I-upvote ({0})", "समर्थन गर्नुहोस् ({0})", "সমর্থন করুন ({0})"],
  votes: ["Votes: {0}", "الأصوات: {0}", "Votes : {0}", "Votos: {0}", "Votos: {0}", "ووٹ: {0}", "वोट: {0}", "Mga boto: {0}", "मत: {0}", "ভোট: {0}"],
  lowest: ["Lowest {0}", "الأدنى {0}", "Minimum : {0}", "Mínimo: {0}", "Mínimo: {0}", "سب سے کم {0}", "न्यूनतम {0}", "Pinakamababa: {0}", "न्यूनतम {0}", "সর্বনিম্ন {0}"],
  highest: ["Highest {0}", "الأعلى {0}", "Maximum : {0}", "Máximo: {0}", "Máximo: {0}", "سب سے زیادہ {0}", "अधिकतम {0}", "Pinakamataas: {0}", "अधिकतम {0}", "সর্বোচ্চ {0}"],
  back: ["Back", "رجوع", "Retour", "Atrás", "Voltar", "واپس", "पीछे", "Bumalik", "पछाडि", "পেছনে"],
  forward: ["Next", "التالي", "Suivant", "Siguiente", "Avançar", "آگے", "आगे", "Susunod", "अर्को", "পরবর্তী"],
  step: ["Question {0} of {1}", "السؤال {0} من {1}", "Question {0} sur {1}", "Pregunta {0} de {1}", "Pergunta {0} de {1}", "{1} میں سے سوال {0}", "{1} में से सवाल {0}", "Tanong {0} sa {1}", "{1} मध्ये प्रश्न {0}", "{1}টি প্রশ্নের মধ্যে {0} নম্বর"],
  waitNext: ["Waiting for the next question", "بانتظار السؤال التالي", "En attente de la prochaine question", "Esperando la siguiente pregunta", "Aguardando a próxima pergunta", "اگلے سوال کا انتظار ہے", "अगले सवाल का इंतज़ार है", "Hinihintay ang susunod na tanong", "अर्को प्रश्नको प्रतीक्षा गर्दै", "পরের প্রশ্নের অপেক্ষায়"],
  answerSent: ["Answer sent", "تم إرسال الإجابة", "Réponse envoyée", "Respuesta enviada", "Resposta enviada", "جواب بھیج دیا گیا", "जवाब भेज दिया गया", "Naipadala ang sagot", "उत्तर पठाइयो", "উত্তর পাঠানো হয়েছে"],
  sent: ["Sent", "تم الإرسال", "Envoyé", "Enviado", "Enviado", "بھیج دیا گیا", "भेज दिया गया", "Naipadala", "पठाइयो", "পাঠানো হয়েছে"],
  required: ["Required", "مطلوب", "Obligatoire", "Obligatorio", "Obrigatório", "لازمی", "ज़रूरी", "Kailangan", "अनिवार्य", "আবশ্যক"],
  right: ["Correct", "صحيح", "Correct", "Correcto", "Correto", "درست", "सही", "Tama", "सही", "সঠিক"],
  wrong: ["Not correct", "غير صحيح", "Incorrect", "Incorrecto", "Incorreto", "درست نہیں", "सही नहीं", "Hindi tama", "सही होइन", "সঠিক নয়"],
  points: ["{0} points", "النقاط: {0}", "Points : {0}", "Puntos: {0}", "Pontos: {0}", "پوائنٹس: {0}", "पॉइंट: {0}", "Puntos: {0}", "अंक: {0}", "পয়েন্ট: {0}"],
  secondsLeft: ["{0} seconds left", "الثواني المتبقية: {0}", "Secondes restantes : {0}", "Segundos restantes: {0}", "Segundos restantes: {0}", "باقی سیکنڈ: {0}", "बाकी सेकंड: {0}", "{0} segundo na lang", "बाँकी सेकेन्ड: {0}", "বাকি সেকেন্ড: {0}"],
  me: ["Your score {0}", "نقاطك {0}", "Votre score : {0}", "Tu puntuación: {0}", "Sua pontuação: {0}", "آپ کا اسکور: {0}", "आपका स्कोर: {0}", "Ang score mo: {0}", "तपाईंको स्कोर: {0}", "আপনার স্কোর: {0}"],
  mePlace: ["Your score {0} · place {1} of {2}", "نقاطك {0} · المركز {1} من {2}", "Votre score : {0} · place {1} sur {2}", "Tu puntuación: {0} · puesto {1} de {2}", "Sua pontuação: {0} · posição {1} de {2}", "آپ کا اسکور: {0} · {2} میں سے مقام {1}", "आपका स्कोर: {0} · {2} में से स्थान {1}", "Ang score mo: {0} · puwesto {1} sa {2}", "तपाईंको स्कोर: {0} · {2} मध्ये स्थान {1}", "আপনার স্কোর: {0} · {2} জনের মধ্যে {1} নম্বরে"],
  gotRight: ["{0} of {1} got it right", "الإجابات الصحيحة: {0} من {1}", "Bonnes réponses : {0} sur {1}", "Aciertos: {0} de {1}", "Acertos: {0} de {1}", "درست جواب: {1} میں سے {0}", "सही जवाब: {1} में से {0}", "{0} sa {1} ang tumama", "सही जवाफ: {1} मध्ये {0}", "{1} জনের মধ্যে {0} জন সঠিক"],
  axisX: ["Across", "أفقياً", "Horizontal", "Horizontal", "Horizontal", "افقی", "आड़ा", "Pahalang", "तेर्सो", "আড়াআড়ি"],
  axisY: ["Upwards", "للأعلى", "Vers le haut", "Hacia arriba", "Para cima", "اوپر کی طرف", "ऊपर की ओर", "Pataas", "माथितिर", "উপরের দিকে"],
  pinAt: ["{0}% across, {1}% down", "{0}% أفقياً، {1}% من الأعلى", "{0} % depuis la gauche, {1} % depuis le haut", "{0}% desde la izquierda, {1}% desde arriba", "{0}% a partir da esquerda, {1}% a partir do topo", "بائیں سے {0}%، اوپر سے {1}%", "बाएँ से {0}%, ऊपर से {1}%", "{0}% mula sa kaliwa, {1}% mula sa itaas", "बायाँबाट {0}%, माथिबाट {1}%", "বাঁ দিক থেকে {0}%, উপর থেকে {1}%"],
  like: ["Like", "أعجبني", "J’aime", "Me gusta", "Curtir", "پسند", "पसंद", "Gusto", "मन पर्‍यो", "পছন্দ"],
  love: ["Love", "أحببته", "J’adore", "Me encanta", "Amei", "بہت پسند", "बहुत पसंद", "Mahal", "धेरै मन पर्‍यो", "ভালোবাসা"],
  clap: ["Clap", "تصفيق", "Bravo", "Aplauso", "Palmas", "تالیاں", "ताली", "Palakpak", "ताली", "হাততালি"],
  wow: ["Wow", "مذهل", "Waouh", "Guau", "Uau", "واہ", "वाह", "Wow", "वाह", "বাহ"],
  think: ["Thinking", "أفكّر", "Pensif", "Pensando", "Pensando", "سوچ", "सोच में", "Nag-iisip", "सोच्दै", "ভাবছি"],
  eSignin: ["Your session has ended. Sign in again.", "انتهت جلستك. سجّل الدخول مجدداً.", "Votre session a expiré. Reconnectez-vous.", "Tu sesión ha terminado. Inicia sesión de nuevo.", "Sua sessão terminou. Entre novamente.", "آپ کا سیشن ختم ہو گیا ہے۔ دوبارہ سائن اِن کریں۔", "आपका सेशन समाप्त हो गया है। फिर से साइन इन करें।", "Natapos na ang iyong session. Mag-sign in muli.", "तपाईंको सेसन समाप्त भयो। पुनः साइन इन गर्नुहोस्।", "আপনার সেশন শেষ হয়েছে। আবার সাইন ইন করুন।"],
  eAudience: ["This page is not open to your account.", "هذه الصفحة غير متاحة لحسابك.", "Cette page n’est pas ouverte à votre compte.", "Esta página no está abierta para tu cuenta.", "Esta página não está aberta para a sua conta.", "یہ صفحہ آپ کے اکاؤنٹ کے لیے نہیں کھلا۔", "यह पेज आपके खाते के लिए खुला नहीं है।", "Hindi bukas ang page na ito para sa iyong account.", "यो पृष्ठ तपाईंको खाताका लागि खुला छैन।", "এই পৃষ্ঠাটি আপনার অ্যাকাউন্টের জন্য খোলা নয়।"],
  eClosed: ["This question is no longer taking answers.", "لم يعد هذا السؤال يستقبل الإجابات.", "Cette question n’accepte plus de réponses.", "Esta pregunta ya no admite respuestas.", "Esta pergunta não aceita mais respostas.", "یہ سوال اب جوابات نہیں لے رہا۔", "यह सवाल अब जवाब नहीं ले रहा।", "Hindi na tumatanggap ng sagot ang tanong na ito.", "यो प्रश्नले अब जवाफ लिँदैन।", "এই প্রশ্নে আর উত্তর নেওয়া হচ্ছে না।"],
  eLimit: ["You have sent all your answers to this question.", "أرسلت كل إجاباتك على هذا السؤال.", "Vous avez envoyé toutes vos réponses à cette question.", "Ya has enviado todas tus respuestas a esta pregunta.", "Você já enviou todas as suas respostas a esta pergunta.", "آپ اس سوال کے اپنے تمام جوابات بھیج چکے ہیں۔", "आप इस सवाल के अपने सभी जवाब भेज चुके हैं।", "Naipadala mo na ang lahat ng sagot mo sa tanong na ito.", "तपाईंले यो प्रश्नका आफ्ना सबै जवाफ पठाइसक्नुभएको छ।", "আপনি এই প্রশ্নের সব উত্তর পাঠিয়ে দিয়েছেন।"],
  eAnswered: ["You have already answered this question.", "سبق أن أجبت عن هذا السؤال.", "Vous avez déjà répondu à cette question.", "Ya has respondido a esta pregunta.", "Você já respondeu a esta pergunta.", "آپ اس سوال کا جواب پہلے ہی دے چکے ہیں۔", "आप इस सवाल का जवाब पहले ही दे चुके हैं।", "Nasagot mo na ang tanong na ito.", "तपाईंले यो प्रश्नको जवाफ दिइसक्नुभएको छ।", "আপনি এই প্রশ্নের উত্তর আগেই দিয়েছেন।"],
  eEmpty: ["Type your answer first.", "اكتب إجابتك أولاً.", "Écrivez d’abord votre réponse.", "Primero escribe tu respuesta.", "Digite sua resposta primeiro.", "پہلے اپنا جواب لکھیں۔", "पहले अपना जवाब लिखें।", "I-type muna ang iyong sagot.", "पहिले आफ्नो जवाफ लेख्नुहोस्।", "আগে আপনার উত্তর লিখুন।"],
  eLong: ["That answer is too long.", "الإجابة طويلة جداً.", "Cette réponse est trop longue.", "Esa respuesta es demasiado larga.", "Essa resposta é longa demais.", "یہ جواب بہت لمبا ہے۔", "यह जवाब बहुत लंबा है।", "Masyadong mahaba ang sagot na iyan.", "त्यो जवाफ धेरै लामो भयो।", "উত্তরটি বেশি লম্বা।"],
  eLink: ["Links can't be sent.", "لا يمكن إرسال الروابط.", "Les liens ne peuvent pas être envoyés.", "No se pueden enviar enlaces.", "Não é possível enviar links.", "لنکس نہیں بھیجے جا سکتے۔", "लिंक नहीं भेजे जा सकते।", "Hindi puwedeng magpadala ng link.", "लिङ्कहरू पठाउन मिल्दैन।", "লিংক পাঠানো যায় না।"],
  eInvalid: ["That answer does not fit the question.", "هذه الإجابة لا تناسب السؤال.", "Cette réponse ne correspond pas à la question.", "Esa respuesta no encaja con la pregunta.", "Essa resposta não combina com a pergunta.", "یہ جواب سوال سے مطابقت نہیں رکھتا۔", "यह जवाब सवाल से मेल नहीं खाता।", "Hindi tugma ang sagot na iyan sa tanong.", "त्यो जवाफ प्रश्नसँग मेल खाँदैन।", "উত্তরটি প্রশ্নের সঙ্গে মিলছে না।"],
  eLate: ["Time is up.", "انتهى الوقت.", "Le temps est écoulé.", "Se acabó el tiempo.", "O tempo acabou.", "وقت ختم ہو گیا۔", "समय समाप्त।", "Tapos na ang oras.", "समय सकियो।", "সময় শেষ।"],
  eThrottled: ["Too many answers - try again in a few minutes.", "إجابات كثيرة - حاول بعد بضع دقائق.", "Trop de réponses – réessayez dans quelques minutes.", "Demasiadas respuestas. Inténtalo de nuevo en unos minutos.", "Muitas respostas — tente novamente em alguns minutos.", "بہت زیادہ جوابات — چند منٹ بعد دوبارہ کوشش کریں۔", "बहुत ज़्यादा जवाब — कुछ मिनट बाद फिर कोशिश करें।", "Masyadong maraming sagot — subukan ulit pagkalipas ng ilang minuto.", "धेरै जवाफ आए — केही मिनेटपछि फेरि प्रयास गर्नुहोस्।", "অনেক বেশি উত্তর এসেছে — কয়েক মিনিট পর আবার চেষ্টা করুন।"],
  eGeneric: ["It could not be sent. Check the connection and try again.", "تعذّر الإرسال. تحقق من الاتصال وحاول مجدداً.", "Envoi impossible. Vérifiez la connexion et réessayez.", "No se pudo enviar. Comprueba la conexión e inténtalo de nuevo.", "Não foi possível enviar. Verifique a conexão e tente novamente.", "بھیجا نہیں جا سکا۔ کنکشن چیک کریں اور دوبارہ کوشش کریں۔", "यह भेजा नहीं जा सका। कनेक्शन जाँचें और फिर कोशिश करें।", "Hindi ito maipadala. Suriin ang koneksyon at subukan ulit.", "पठाउन सकिएन। जडान जाँचेर फेरि प्रयास गर्नुहोस्।", "পাঠানো যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।"],
};
function _aT(k) { const row = AK_T[k] || [''], i = HUB_LANGS.indexOf(S.lang); return row[i < 0 ? 0 : i] || row[0]; }
function _aF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _aT(k)); }

// ── Reading what the database answers: nothing trusts a shape ─────────────────────────────────────
const _akO = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
const _akL = (v) => (Array.isArray(v) ? v : []);
const _akS = (v) => (typeof v === 'string' ? v : '');
function _akNum(v) { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null; }
function _akInt(v) { const n = _akNum(v); return n !== null && Number.isInteger(n) ? n : null; }
const _akClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const _akWhenOk = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
const _akHttps = (v) => (typeof v === 'string' && v.length <= 500 && /^https:\/\/[^\s"'<>]+$/i.test(v) ? v : null);
// Staff write a text in English and/or Arabic: Arabic readers get the Arabic (else the English), everyone else the English.
function _akTx(en, ar) { const e = _akS(en).trim(), a = _akS(ar).trim(); return S.lang === 'ar' ? a || e : e || a; }
// Digits typed on an Arabic, Persian, Devanagari or Bengali keyboard, as the Latin ones a number is sent in.
const AK_DIGITS = [0x660, 0x6f0, 0x966, 0x9e6];
function _akLat(s) {
  let out = '';
  for (const ch of String(s == null ? '' : s)) {
    const c = ch.charCodeAt(0), z = AK_DIGITS.find((b) => c >= b && c <= b + 9);
    out += z === undefined ? ch : String(c - z);
  }
  return out;
}
const _akLen = (s) => [...String(s || '')].length;
const _akFold = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function _akN(n, d) { try { return new Intl.NumberFormat(_locale(), { maximumFractionDigits: d == null ? 1 : d }).format(n); } catch (_) { return String(n); } }
const _akPct = (share) => Math.round(_akClamp(share || 0, 0, 1) * 100) + '%';
function _akWhen(iso) {
  const t = Date.parse(iso || ''); if (Number.isNaN(t)) return '';
  try { return new Intl.DateTimeFormat(_locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' }).format(t); } catch (_) { return ''; }
}

// ── The kinds and their settings ────────────────────────────────────────────────────────────────────
const AK_KINDS = ['cloud', 'open', 'qa', 'choice', 'scales', 'ranking', 'points', 'number', 'info', 'grid', 'pin', 'form', 'quiz', 'quiz_text'];
const _akDrawn = (k) => AK_KINDS.includes(k);
const _akQuiz = (k) => k === 'quiz' || k === 'quiz_text';
const _akWritten = (k) => k === 'cloud' || k === 'open' || k === 'qa';
function _akOpts(c) {
  const seen = new Set(), out = [];
  for (const raw of _akL(_akO(c) && c.options)) {
    const o = _akO(raw), id = _akS(o && o.id);
    if (!o || !/^[a-z0-9]{1,12}$/.test(id) || seen.has(id) || !(_akS(o.en).trim() || _akS(o.ar).trim())) continue;
    seen.add(id); out.push({ id, en: _akS(o.en), ar: _akS(o.ar) });
  }
  return out;
}
const _akOt = (o) => _akTx(o.en, o.ar);
function _akCfgW(kind, c) {
  c = _akO(c) || {};
  return { maxLen: _akClamp(_akInt(c.max_len) ?? (kind === 'cloud' ? 25 : 200), 1, 500), perPerson: _akClamp(_akInt(c.per_person) ?? (kind === 'open' ? 1 : 3), 1, 10), votes: typeof c.votes === 'boolean' ? c.votes : kind === 'qa' };
}
function _akCfgC(c) {
  c = _akO(c) || {};
  const options = _akOpts(c), ids = new Set(options.map((o) => o.id));
  return { options, maxPicks: _akClamp(_akInt(c.max_picks) ?? 1, 1, Math.max(1, options.length)), change: c.change === true, correct: _akL(c.correct).filter((x) => typeof x === 'string' && ids.has(x)) };
}
function _akCfgS(c) {
  c = _akO(c) || {};
  const min = _akInt(c.min) === 0 ? 0 : 1;
  return { options: _akOpts(c), min, max: _akClamp(_akInt(c.max) ?? 5, Math.max(3, min + 1), 10), lo: _akTx(c.lo_en, c.lo_ar), hi: _akTx(c.hi_en, c.hi_ar), skip: c.skip === true };
}
function _akCfgP(c) { c = _akO(c) || {}; return { options: _akOpts(c), total: _akClamp(_akInt(c.total) ?? 100, 1, 1000) }; }
function _akCfgN(c) {
  c = _akO(c) || {};
  const lo = _akNum(c.min) ?? 0, hi = _akNum(c.max) ?? 100, st = _akNum(c.step) ?? 1;
  return { min: Math.min(lo, hi), max: Math.max(lo, hi), step: st > 0 ? st : 1, unit: _akTx(c.unit_en, c.unit_ar), correct: _akNum(c.correct) };
}
function _akCfgG(c) { c = _akO(c) || {}; const m = _akInt(c.max); return { options: _akOpts(c), max: m !== null && m >= 3 && m <= 10 ? m : 10, x: _akTx(c.x_en, c.x_ar), y: _akTx(c.y_en, c.y_ar) }; }
function _akSecs(v, d) { const n = _akInt(v); return n !== null && n >= 5 && n <= 120 ? n : d; }
function _akCfgQ(c) {
  c = _akO(c) || {};
  const options = _akOpts(c);
  return { options, seconds: _akSecs(c.seconds, 20), correct: _akL(c.correct).filter((x) => typeof x === 'string' && options.some((o) => o.id === x)) };
}
function _akCfgQT(c) {
  c = _akO(c) || {};
  const len = _akInt(c.max_len);
  return { seconds: _akSecs(c.seconds, 30), maxLen: len !== null && len >= 5 && len <= 80 ? len : 40, accept: _akL(c.accept).filter((x) => typeof x === 'string' && x.trim()) };
}
function _akFields(c) {
  const out = [];
  for (const x of _akL(_akO(c) && c.fields)) {
    const f = _akO(x), id = _akS(f && f.id);
    const type = f && (f.type === 'number' || f.type === 'choice' || f.type === 'text') ? f.type : null;
    if (!f || !/^[a-z0-9]{1,12}$/.test(id) || !type || out.some((o) => o.id === id) || !(_akS(f.en).trim() || _akS(f.ar).trim())) continue;
    out.push({ id, label: _akTx(f.en, f.ar), type, options: type === 'choice' ? _akOpts(f) : [], required: f.required !== false });
  }
  return out.slice(0, 8);
}

// ── An answer's value per kind, checked as the database would (it checks again) ────────────────────
const _akNo = (error) => ({ ok: false, error });
const _akYes = (value) => ({ ok: true, value });
const AK_LINK = /(?:https?:\/\/|www\.)\S/i;
function _akShapeW(kind, c, text) {
  const t = _akFold(text);
  if (!t || (kind === 'cloud' && !/[\p{L}\p{N}]/u.test(t))) return _akNo('empty');
  if (_akLen(t) > _akCfgW(kind, c).maxLen) return _akNo('long');
  if (AK_LINK.test(t)) return _akNo('link');
  return _akYes({ t });
}
function _akShapeC(c, picks) {
  const cf = _akCfgC(c), ids = new Set(cf.options.map((o) => o.id)), o = [...new Set(_akL(picks).filter((x) => typeof x === 'string'))];
  if (!o.length) return _akNo('empty');
  if (o.length > cf.maxPicks || !o.every((id) => ids.has(id))) return _akNo('invalid');
  return _akYes({ o: cf.options.map((x) => x.id).filter((id) => o.includes(id)) });
}
function _akShapeS(c, marks) {
  const cf = _akCfgS(c), m = _akO(marks) || {}, s = {};
  for (const o of cf.options) {
    const v = m[o.id]; if (v === undefined || v === null || v === '') continue;
    const n = _akInt(v); if (n === null || n < cf.min || n > cf.max) return _akNo('invalid');
    s[o.id] = n;
  }
  const given = Object.keys(s).length;
  if (!given || (!cf.skip && given < cf.options.length)) return _akNo('empty');
  return _akYes({ s });
}
function _akShapeR(c, order) {
  const ids = _akOpts(c).map((o) => o.id), r = _akL(order).filter((x) => typeof x === 'string');
  if (!ids.length || r.length !== ids.length || new Set(r).size !== r.length || !r.every((id) => ids.includes(id))) return _akNo('invalid');
  return _akYes({ r });
}
function _akShapeP(c, points) {
  const cf = _akCfgP(c), m = _akO(points) || {}, p = {};
  let sum = 0;
  for (const o of cf.options) {
    const n = m[o.id] === undefined || m[o.id] === null || m[o.id] === '' ? 0 : _akInt(m[o.id]);
    if (n === null || n < 0) return _akNo('invalid');
    p[o.id] = n; sum += n;
  }
  if (!cf.options.length || sum > cf.total) return _akNo('invalid');
  return sum < 1 ? _akNo('empty') : _akYes({ p });
}
function _akTyped(raw) {
  const text = _akLat(raw).replace(/[,٫]/g, '.').trim();
  if (!text) return null;
  return /^-?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text)) ? Number(text) : 'bad';
}
function _akShapeN(c, raw) {
  const cf = _akCfgN(c), n = _akTyped(raw);
  if (n === null) return _akNo('empty');
  if (n === 'bad' || n < cf.min || n > cf.max) return _akNo('invalid');
  const steps = (n - cf.min) / cf.step;
  return Math.abs(steps - Math.round(steps)) > 1e-6 ? _akNo('invalid') : _akYes({ n });
}
function _akShapeG(c, marks) {
  const cf = _akCfgG(c), m = _akO(marks) || {}, g = {};
  for (const o of cf.options) {
    const v = _akL(m[o.id]);
    if (!v.length) return _akNo('empty');
    const x = _akNum(v[0]), y = _akNum(v[1]);
    if (v.length !== 2 || x === null || y === null || x < 0 || x > cf.max || y < 0 || y > cf.max) return _akNo('invalid');
    g[o.id] = [x, y];
  }
  return cf.options.length ? _akYes({ g }) : _akNo('invalid');
}
const _akFrac = (v) => _akClamp(Math.round(v * 10000) / 10000, 0, 1);
function _akShapePin(pin) {
  const p = _akO(pin), x = _akNum(p && p.x), y = _akNum(p && p.y);
  if (!p || x === null || y === null) return _akNo('empty');
  return x < 0 || x > 1 || y < 0 || y > 1 ? _akNo('invalid') : _akYes({ x: _akFrac(x), y: _akFrac(y) });
}
function _akShapeF(c, values) {
  const v = _akO(values) || {}, f = {};
  for (const fd of _akFields(c)) {
    const raw = v[fd.id];
    if (fd.type === 'number') {
      const n = _akTyped(raw);
      if (n === 'bad') return _akNo('invalid');
      if (n === null) { if (fd.required) return _akNo('empty'); continue; }
      f[fd.id] = n;
    } else if (fd.type === 'choice') {
      const id = _akS(raw);
      if (!id) { if (fd.required) return _akNo('empty'); continue; }
      if (!fd.options.some((o) => o.id === id)) return _akNo('invalid');
      f[fd.id] = id;
    } else {
      const t = _akFold(raw);
      if (!t) { if (fd.required) return _akNo('empty'); continue; }
      if (_akLen(t) > 200) return _akNo('long');
      f[fd.id] = t;
    }
  }
  return Object.keys(f).length ? _akYes({ f }) : _akNo('empty');
}
function _akShapeQT(c, text) { const t = _akFold(text); if (!t) return _akNo('empty'); return _akLen(t) > _akCfgQT(c).maxLen ? _akNo('long') : _akYes({ t }); }
const AK_ERR = { signin: 'eSignin', audience: 'eAudience', closed: 'eClosed', limit: 'eLimit', answered: 'eAnswered', empty: 'eEmpty', long: 'eLong', link: 'eLink', invalid: 'eInvalid', late: 'eLate', throttled: 'eThrottled', busy: 'eThrottled' };
const _akErrText = (code) => _aT(AK_ERR[code] || 'eGeneric');

// What the viewer sent, read back into the answer's own form.
const _akSentIds = (v, k) => _akL(_akO(v) && v[k]).filter((x) => typeof x === 'string');
function _akSentMarks(v, k) { const out = {}; for (const [id, x] of Object.entries(_akO(_akO(v) && v[k]) || {})) { const n = _akNum(x); if (n !== null) out[id] = n; } return out; }
function _akSentGrid(v) { const out = {}; for (const [id, x] of Object.entries(_akO(_akO(v) && v.g) || {})) { const a = _akNum(_akL(x)[0]), b = _akNum(_akL(x)[1]); if (a !== null && b !== null) out[id] = [a, b]; } return out; }
function _akSentPin(v) { const o = _akO(v), x = _akNum(o && o.x), y = _akNum(o && o.y); return o && x !== null && y !== null && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null; }
function _akSentForm(v) { const out = {}; for (const [id, x] of Object.entries(_akO(_akO(v) && v.f) || {})) if (typeof x === 'string' || typeof x === 'number') out[id] = String(x); return out; }

// ── ask_page, ask_live, ask_send as the page holds them ─────────────────────────────────────────────
const AK_RESULTS = ['live', 'answered', 'closed', 'staff'];
function _akQ(raw) {
  const q = _akO(raw), id = _akInt(q && q.id);
  if (!q || id === null || !_akS(q.kind)) return null;
  return {
    id, pos: _akNum(q.pos) ?? 0, kind: _akS(q.kind), title: _akTx(q.title_en, q.title_ar), help: _akTx(q.help_en, q.help_ar), image: _akHttps(q.image),
    config: _akO(q.config) || {}, results: AK_RESULTS.includes(q.results) ? q.results : 'staff',
    open: q.open !== false, reveal: q.reveal === true, started_at: _akWhenOk(q.started_at),
  };
}
function _akMine1(raw) {
  const m = _akO(raw), id = _akInt(m && m.id);
  if (!m || id === null) return null;
  const value = _akO(m.value) || {};
  return { id, value, body: _akS(m.body) || _akS(value.t), status: m.status === 'approved' || m.status === 'rejected' ? m.status : 'pending', created_at: _akS(m.created_at), score: _akNum(m.score) };
}
const _akMineList = (raw) => _akL(raw).map(_akMine1).filter(Boolean);
function _akLive(raw) {
  const l = _akO(raw); if (!l) return null;
  const q = {};
  for (const [id, v] of Object.entries(_akO(l.q) || {})) { const o = _akO(v); if (o) q[id] = { open: o.open !== false, reveal: o.reveal === true, started_at: _akWhenOk(o.started_at) }; }
  const reactions = {};
  for (const [id, v] of Object.entries(_akO(l.reactions) || {})) {
    const counts = {}; for (const [k, n] of Object.entries(_akO(v) || {})) { const c = _akInt(n); if (c !== null && c > 0) counts[k] = c; }
    reactions[id] = counts;
  }
  return {
    ver: Math.max(0, _akNum(l.ver) ?? 0), state: l.state === 'closed' ? 'closed' : 'ok', open: l.open !== false, pace: l.pace === 'live' ? 'live' : 'self',
    current_q: _akInt(l.current_q), round: _akInt(l.round) ?? 1, q, results: _akO(l.results) || {}, now: _akWhenOk(l.now), reactions,
  };
}
function _akFull(o) {
  const p = _akO(o.page), id = _akInt(p && p.id);
  if (!p || id === null) return null;
  const questions = _akL(o.questions).map(_akQ).filter(Boolean).sort((a, b) => a.pos - b.pos || a.id - b.id);
  const mine = {}; for (const [qid, rows] of Object.entries(_akO(o.mine) || {})) mine[qid] = _akMineList(rows);
  const me = _akO(o.me), score = _akNum(me && me.score), rank = _akInt(me && me.rank), players = _akInt(me && me.players);
  const look = _akO(p.look) || {};
  return {
    signed: o.signed === true, canAnswer: o.can_answer === true && o.preview !== true, rk: _akS(o.rk),
    page: {
      id, title: _akTx(p.title_en, p.title_ar), intro: _akTx(p.intro_en, p.intro_ar), pace: p.pace === 'live' ? 'live' : 'self', current_q: _akInt(p.current_q),
      closes_at: _akWhenOk(p.closes_at), round: _akInt(p.round) ?? 1, open: p.open !== false,
      cover: _akHttps(look.cover), steps: look.layout === 'steps', reactions: look.reactions === true, thanks: _akTx(String(look.thanks_en || '').slice(0, 160), String(look.thanks_ar || '').slice(0, 160)),
    },
    questions, mine, voted: _akL(o.voted).map(_akInt).filter((n) => n !== null), live: _akLive(o.live),
    reacted: Object.fromEntries(Object.entries(_akO(o.reacted) || {}).map(([k, v]) => [k, _akL(v).filter((x) => typeof x === 'string')])),
    me: me && score !== null && rank !== null && rank >= 1 && players !== null && players >= rank ? { score, rank, players } : null,
  };
}
function _akView(raw) {
  const o = _akO(raw); if (!o) return { state: 'none' };
  const head = _akO(o.page) && (_akS(o.page.title_en).trim() || _akS(o.page.title_ar).trim()) ? { title: _akTx(o.page.title_en, o.page.title_ar), opens_at: _akWhenOk(o.page.opens_at) } : null;
  if (o.state === 'ok') { const full = _akFull(o); return full ? { state: 'ok', head, full } : { state: 'none' }; }
  if (o.state === 'closed') return head ? { state: 'closed', head, full: Array.isArray(o.questions) ? _akFull(o) : null } : { state: 'none' };
  if (o.state === 'soon') return head ? { state: 'soon', head } : { state: 'none' };
  if (o.state === 'signin' || o.state === 'audience') return { state: o.state };
  return { state: 'none' };
}
// A live answer taken in. `reload`: the page itself must be read again (a question it does not hold, a new round, a quiz
// revealed: the viewer's own score is the page's to say). A version older than the page's is dropped.
function _akApplyLive(full, live) {
  if (full.live && live.ver < full.live.ver) return false;
  const held = new Set(full.questions.map((q) => String(q.id)));
  const revealed = full.questions.some((q) => _akQuiz(q.kind) && !q.reveal && live.q[String(q.id)] && live.q[String(q.id)].reveal);
  const reload = Object.keys(live.q).some((id) => !held.has(id)) || live.round !== full.page.round || revealed;
  full.questions.forEach((q) => { const n = live.q[String(q.id)]; if (n) Object.assign(q, n); });
  full.live = live;
  full.page.open = live.open && live.state === 'ok'; full.page.current_q = live.current_q; full.page.pace = live.pace;
  return reload;
}
const _akPageOpen = (full) => full.page.open && (!full.live || (full.live.open && full.live.state === 'ok'));
const _akPaced = (full) => ((full.live && full.live.pace) || full.page.pace) === 'live';
function _akLiveQ(full) { const id = full.live ? full.live.current_q : full.page.current_q; return id === null ? null : full.questions.find((q) => q.id === id && _akDrawn(q.kind)) || null; }
const _akMine = (full, q) => full.mine[String(q.id)] || [];
// What stands where a question's answer goes (the website's answerState): none, signin, open, change, full, done, shut.
function _akState(q, full) {
  if (q.kind === 'info' || !_akDrawn(q.kind)) return 'none';
  const mine = _akMine(full, q);
  if (!(_akPageOpen(full) && q.open)) return mine.length && !_akWritten(q.kind) ? 'shut' : 'none';
  if (!full.signed || !full.canAnswer) return full.signed ? 'none' : 'signin';
  if (_akWritten(q.kind)) return mine.filter((m) => m.status !== 'rejected').length >= _akCfgW(q.kind, q.config).perPerson ? 'full' : 'open';
  if (!mine.length) return 'open';
  return q.kind === 'choice' && _akCfgC(q.config).change ? 'change' : 'done';
}
function _akShown(q, full) {
  if (q.kind === 'info' || !_akDrawn(q.kind) || q.results === 'staff') return false;
  if (_akQuiz(q.kind) && !q.reveal) return false;
  if (q.results !== 'answered') return true;
  return _akMine(full, q).length > 0 || !(_akPageOpen(full) && q.open);
}
const _akPending = (full) => Object.values(full.mine).some((rows) => rows.some((m) => m.status === 'pending'));
// The viewer's own quiz line: their points once revealed, their place only when every quiz answer of theirs is counted.
function _akMeLine(full) {
  if (!full.signed) return null;
  let shown = 0, hidden = 0, any = false;
  for (const q of full.questions) {
    if (!_akQuiz(q.kind)) continue;
    for (const m of _akMine(full, q)) { if (q.reveal) { shown += m.score || 0; any = true; } else hidden++; }
  }
  if (!any) return null;
  const whole = !hidden && full.me && full.me.score === shown;
  return { score: shown, rank: whole ? full.me.rank : null, players: whole ? full.me.players : null };
}
// The database's own time, read off the polls: a quiz clock counts against it, never the phone's.
function _akOffset(sentAt, gotAt, now) {
  const t = now ? Date.parse(now) : NaN;
  if (Number.isNaN(t) || !(gotAt >= sentAt)) return null;
  return { ms: Math.round(t - (sentAt + gotAt) / 2), rtt: gotAt - sentAt, at: gotAt };
}
const _akBetter = (held, next) => (!next ? held : !held || next.rtt <= held.rtt || next.at - held.at > 60000 ? next : held);
function _akClock(q, a) {
  if (!_akQuiz(q.kind) || !q.started_at || !a.offset) return null;
  const total = q.kind === 'quiz' ? _akCfgQ(q.config).seconds : _akCfgQT(q.config).seconds;
  const leftMs = Date.parse(q.started_at) + total * 1000 - (Date.now() + a.offset.ms);
  return { total, left: _akClamp(Math.ceil(leftMs / 1000), 0, total), share: _akClamp(leftMs / (total * 1000), 0, 1), over: leftMs <= 0 };
}

// ── The page's state ──────────────────────────────────────────────────────────────────────────────
// S._ak holds one page for one account: what ask_page answered, kept up to date, and what the member has typed or
// picked and not yet sent (`draft`), which a repaint keeps.
function _akNew(slug, forId) {
  return { slug, forId, view: null, readAt: 0, reading: false, failed: false, later: null, timer: null, polling: false, fails: 0, refused: 0, quiet: false, own: false,
    offset: null, draft: {}, errs: {}, busy: {}, thanked: null, voting: null, removing: null, step: { id: null, index: 0 }, tick: null, over: {} };
}
function _akOnView() {
  const tab = document.getElementById('tab-members'), view = document.getElementById('view-customer');
  return S._hubView === 'ask' && S.custTab === 'members' && !!tab && tab.classList.contains('active') && (!view || view.classList.contains('active')) && !!document.getElementById('ak-view');
}
function _akFullNow() { const a = S._ak; return a && a.view && a.view.full; }
function _akQById(id) { const f = _akFullNow(); return f ? f.questions.find((q) => q.id === id) : null; }

// The page read again: at most once every 30 seconds, unless it must be now (and even then not twice in 1.5 s).
async function _akRead(must) {
  const a = S._ak; if (!a || a.reading) return;
  const now = Date.now();
  if (a.readAt && now - a.readAt < (must ? 1500 : 30000)) {
    if (!must && !a.later) a.later = setTimeout(() => { a.later = null; if (S._ak === a) _akRead(false); }, 30000 - (now - a.readAt));
    return;
  }
  const c = _hCust(); if (!c || !sb) return;
  a.reading = true; a.readAt = now;
  let r; const sent = Date.now();
  try { r = await sb.rpc('ask_page', { p_slug: a.slug, ..._hTok(c) }); } catch (e) { r = { error: e }; }
  const got = Date.now();
  a.reading = false;
  const who = _hCust();
  if (S._ak !== a || !who || who.id !== a.forId) return;
  if (r && !r.error && r.data) {
    a.view = _akView(r.data); a.failed = false; a.refused = 0; a.quiet = false;
    a.offset = _akBetter(a.offset, _akOffset(sent, got, r.data.now));
  } else if (!a.view) a.failed = true;
  _akRepaint();
  _akArm();
}
function _akRetry() { const a = S._ak; if (!a) return; a.failed = false; a.readAt = 0; _akRepaint(); _akRead(true); }

// ask_live, straight from the browser: every 10 s, every 2 s on a page staff pace, doubled for each failure in a row (two
// minutes at most); never while the page is hidden or another tab is open (a return asks at once).
function _akArm() {
  const a = S._ak, full = _akFullNow();
  if (!a || a.timer || a.polling || a.quiet || !full || !full.rk || !_akOnView() || document.hidden) return;
  const ms = Math.min(120000, (_akPaced(full) && _akPageOpen(full) ? 2000 : 10000) * 2 ** Math.min(a.fails, 6));
  a.timer = setTimeout(_akPoll, ms);
}
function _akPollNow() { const a = S._ak; if (!a) return; clearTimeout(a.timer); a.timer = null; _akPoll(); }
async function _akPoll() {
  const a = S._ak; if (!a) return;
  a.timer = null;
  const full = _akFullNow();
  if (a.polling || !full || !full.rk || !_akOnView() || document.hidden) return;
  a.polling = true;
  let r; const sent = Date.now();
  try { r = await sb.rpc('ask_live', { p_slug: a.slug, p_key: full.rk, p_ver: full.live ? full.live.ver : 0 }); } catch (e) { r = { error: e }; }
  const got = Date.now();
  a.polling = false;
  if (S._ak !== a || _akFullNow() !== full) { _akArm(); return; }
  if (!r || r.error) { a.fails++; _akArm(); return; }
  a.fails = 0;
  const o = _akO(r.data), mine = a.own;
  a.own = false;
  if (!o || o.ok !== true) { // the key no longer opens the page: read it again; three refusals in a row and it stops asking
    if (++a.refused >= 3) a.quiet = true; else _akRead(true);
    _akArm(); return;
  }
  a.refused = 0;
  a.offset = _akBetter(a.offset, _akOffset(sent, got, o.now));
  if (o.same === true) {
    if (full.live && (o.state === 'ok' || o.state === 'closed') && typeof o.open === 'boolean') {
      full.live.state = o.state; full.live.open = o.open; full.page.open = o.open && o.state === 'ok';
    }
  } else {
    const live = _akLive(o);
    if (live) {
      // the version moved while an answer of theirs waits (and not by their own answer): staff may have reviewed it
      const reviewed = !mine && _akPending(full) && full.live && live.ver > full.live.ver;
      const wasPaced = _akPaced(full);
      const reload = _akApplyLive(full, live);
      if (reload || reviewed) _akRead(reload && (wasPaced || live.pace === 'live'));
    }
  }
  _akRepaint();
  _akArm();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S._ak && _akOnView()) _akPollNow(); });
function _akStop() { const a = S._ak; if (!a) return; clearTimeout(a.timer); a.timer = null; clearTimeout(a.later); a.later = null; clearInterval(a.tick); a.tick = null; }

// ── Drawing: the page in blocks of parts, each part written again only when its markup changed ─────
// A poll every few seconds must not take away what the member is typing: a text box's value is never in the markup (it
// is put back from the draft after each write, _akFill), so a part holding one is written again only when something
// else in it changed, and then the focus and the caret are put back.
function _akRepaint() { if (S._hubView !== 'ask' || S.custTab !== 'members') return; const body = document.getElementById('hub-body'); if (body) _akPaint(body); }
function _akPaint(body) {
  const c = _hCust(); if (!c) return;
  let a = S._ak;
  if (!a || a.slug !== S._akSlug || a.forId !== c.id) { _akStop(); a = S._ak = _akNew(S._akSlug, c.id); }
  if (!a.view && !a.reading && !a.failed) _akRead(true);
  const blocks = _akBlocks(a);
  const key = blocks.map((b) => b.id + ':' + b.parts.map((p) => p[0]).join(',')).join('|');
  let root = document.getElementById('ak-view');
  const ae = document.activeElement, focusId = ae && ae.id && body.contains(ae) ? ae.id : null;
  const sel = focusId && typeof ae.selectionStart === 'number' ? [ae.selectionStart, ae.selectionEnd] : null;
  let lost = false;
  if (!root || !body.contains(root) || root._akKey !== key) {
    body.innerHTML = `<div id="ak-view">${blocks.map((b) => `<${b.tag || 'div'} id="${b.id}" class="${b.cls}"${b.attrs || ''}>${b.parts.map(([id, h]) => `<div id="${id}" class="ak-part">${h}</div>`).join('')}</${b.tag || 'div'}>`).join('')}</div>`;
    root = document.getElementById('ak-view');
    root._akKey = key;
    blocks.forEach((b) => b.parts.forEach(([id, h]) => { const el = document.getElementById(id); if (el) el._akH = h; }));
    lost = !!focusId;
  } else {
    blocks.forEach((b) => b.parts.forEach(([id, h]) => {
      const el = document.getElementById(id);
      if (!el || el._akH === h) return;
      if (focusId && ae && el.contains(ae)) lost = true;
      el.innerHTML = h; el._akH = h;
    }));
  }
  _akFill(root);
  if (lost) {
    const n = document.getElementById(focusId);
    if (n) try { n.focus({ preventScroll: true }); if (sel && n.setSelectionRange && n.value != null) n.setSelectionRange(sel[0], sel[1]); } catch (_) {}
  }
  _akTickArm();
  _akArm();
}
// Text boxes take their value from the draft, and each one's count of what is left.
function _akFill(root) {
  const a = S._ak; if (!a || !root) return;
  root.querySelectorAll('[data-ak-d]').forEach((el) => {
    const [qid, path] = el.getAttribute('data-ak-d').split('|'), d = a.draft[qid];
    if (!d) return;
    const v = path.startsWith('f.') ? (d.f && d.f[path.slice(2)]) || '' : d[path] || '';
    if (el.value !== v) el.value = v;
  });
  root.querySelectorAll('[data-ak-left]').forEach((el) => _akLeftSet(el));
}
function _akLeftSet(el) {
  const a = S._ak, qid = el.getAttribute('data-ak-left'), q = _akQById(Number(qid)), d = a && a.draft[qid];
  if (!q || !d) return;
  const max = q.kind === 'quiz_text' ? _akCfgQT(q.config).maxLen : _akCfgW(q.kind, q.config).maxLen, left = max - _akLen(d.t || '');
  el.textContent = String(left); el.classList.toggle('low', left <= 5);
}

function _akIc(k, px) {
  const p = AK_IC[k] || '', fill = k === 'vote';
  return `<svg aria-hidden="true" focusable="false" class="ak-ic" width="${px || 18}" height="${px || 18}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="${/^(like|love|clap|wow|think)$/.test(k) ? 1.9 : 2}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
}
// Small line drawings of our own (no emoji): the website's Ask marks.
const AK_IC = {
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>', down: '<path d="M12 5v14M5 12l7 7 7-7"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>', check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  vote: '<path d="M12 5.5c.5 0 1 .2 1.3.7l6.2 8.6c.8 1.1 0 2.7-1.3 2.7H5.8c-1.3 0-2.1-1.6-1.3-2.7l6.2-8.6c.3-.5.8-.7 1.3-.7z"/>',
  like: '<path d="M7 10.5v9.5H4.5a1 1 0 0 1-1-1v-7.5a1 1 0 0 1 1-1H7zm0 0 3.6-7.2A2.4 2.4 0 0 1 13 5.7v3.3h5.4a2 2 0 0 1 2 2.4l-1.2 6.9a2 2 0 0 1-2 1.7H7"/>',
  love: '<path d="M12 20.2S4.4 15.6 4.4 10.3A4.2 4.2 0 0 1 12 7.8a4.2 4.2 0 0 1 7.6 2.5c0 5.3-7.6 9.9-7.6 9.9z"/>',
  clap: '<path d="M9.6 12.6 6.9 9.9a1.4 1.4 0 0 0-2 2l4.3 4.6a5.2 5.2 0 0 0 7.5.1l2.5-2.6a2.4 2.4 0 0 0 .5-2.6l-1.9-4.6a1.3 1.3 0 0 0-2.5.8l.7 2.2-4.9-5a1.4 1.4 0 0 0-2 2l3.3 3.4"/><path d="M9.6 12.6 7.9 10.8M4.4 4.8l1.2 1.4M7.6 3.2l.5 1.8M2.9 8l1.8.5"/>',
  wow: '<path d="m12 2.8 2 5.3 5.6-.9-3.2 4.6 3.9 4.1-5.6.4-.6 5.5L12 17.4l-4.1 4.4-.6-5.5-5.6-.4 3.9-4.1-3.2-4.6 5.6.9z"/>',
  think: '<path d="M7.4 14.4a3.9 3.9 0 0 1-.5-7.7 5 5 0 0 1 9.4-.8 4.1 4.1 0 0 1 .5 8.2z"/><circle cx="7.6" cy="17.9" r="1.2"/><circle cx="4.9" cy="20.5" r=".7"/>',
};
const AK_REACT = ['like', 'love', 'clap', 'wow', 'think'];

// The blocks of the page, in order. A block's id and its parts' ids are its shape: when the shape changes (another
// question on screen, the next step) the page is written whole.
function _akBlocks(a) {
  const close = `<button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_akClose')}">${_hT('close')}</button>`;
  const headOf = (title, body) => ({ id: 'ak-head', cls: 'hub-card ak-head', parts: [['ak-head-t', `<div class="mt-head"><h2 class="mt-h1" dir="auto" id="ak-title">${esc(title)}</h2>${close}</div>`], ['ak-head-b', body]] });
  const v = a.view;
  if (!v) {
    return [headOf('', a.failed
      ? `<p class="ak-line" role="status">${_aT('eGeneric')}</p><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_akRetry')}">${_hT('retry')}</button>`
      : _skelHtml(2, 'hub-skel'))];
  }
  const full = v.full;
  if (!full) {
    const line = v.state === 'soon' ? (v.head && v.head.opens_at ? _aF('opens', _akWhen(v.head.opens_at)) : '') : v.state === 'closed' ? _aT('closedPage')
      : v.state === 'audience' ? _aT('notYours') : v.state === 'signin' ? _aT('eSignin') : _aT('none');
    return [headOf(v.head ? v.head.title : '', line ? `<p class="ak-line" role="status">${esc(line)}</p>` : '')];
  }
  const p = full.page, open = _akPageOpen(full);
  const drawn = full.questions.filter((q) => _akDrawn(q.kind));
  const head = [
    p.cover ? `<img class="ak-cover" src="${esc(p.cover)}" alt="" decoding="async">` : '',
    !open ? `<p class="ak-flags"><span class="ak-chip">${_aT('closed')}</span></p>` : '',
    p.intro ? `<p class="ak-intro" dir="auto">${esc(p.intro)}</p>` : '',
    open && drawn.some((q) => q.kind !== 'info') ? `<p class="ak-private">${esc(_aT('privacy'))}</p>` : '',
    open && p.closes_at ? `<p class="ak-until">${esc(_aF('until', _akWhen(p.closes_at)))}</p>` : '',
  ].join('');
  const blocks = [headOf(p.title, head)];
  const me = _akMeLine(full);
  if (me) blocks.push({ id: 'ak-me', cls: 'hub-card hub-flat ak-me', attrs: ' role="status"', parts: [['ak-me-t', `<strong>${esc(me.rank !== null && me.players !== null ? _aF('mePlace', _akN(me.score, 0), me.rank, me.players) : _aF('me', _akN(me.score, 0)))}</strong>`]] });
  const paced = _akPaced(full) && open;
  if (paced) {
    const cur = _akLiveQ(full);
    blocks.push(cur ? _akQBlock(a, full, cur) : { id: 'ak-wait', cls: 'hub-card ak-wait', parts: [['ak-wait-t', `<p class="ak-line" role="status">${_aT('waitNext')}</p>`]] });
    return blocks;
  }
  if (p.steps && drawn.length > 1) {
    const at = _akStepAt(drawn.map((q) => q.id), a.step);
    blocks.push({ id: 'ak-prog', cls: 'ak-prog', parts: [['ak-prog-t', `<p class="ak-step" id="ak-step" tabindex="-1">${esc(_aF('step', at + 1, drawn.length))}</p><div class="hub-bar" aria-hidden="true"><span data-cssv="${_cssv({ '--w': ((at + 1) / drawn.length * 100).toFixed(1) + '%' })}"></span></div>`]] });
    blocks.push(_akQBlock(a, full, drawn[at]));
    blocks.push({ id: 'ak-nav', cls: 'ak-nav', parts: [['ak-nav-b', `<button type="button" class="btn-secondary" id="ak-back"${at <= 0 ? ' disabled' : ''} data-on-click="${_on('_akStepGo', -1)}">${_aT('back')}</button><button type="button" class="btn-primary" id="ak-next"${at >= drawn.length - 1 ? ' disabled' : ''} data-on-click="${_on('_akStepGo', 1)}">${_aT('forward')}</button>`]] });
    return blocks;
  }
  drawn.forEach((q) => blocks.push(_akQBlock(a, full, q)));
  return blocks;
}
function _akStepAt(ids, held) {
  if (!ids.length) return -1;
  const same = held.id === null ? -1 : ids.indexOf(held.id);
  return same >= 0 ? same : _akClamp(Math.round(held.index) || 0, 0, ids.length - 1);
}
function _akStepGo(by) {
  const a = S._ak, full = _akFullNow(); if (!a || !full) return;
  const ids = full.questions.filter((q) => _akDrawn(q.kind)).map((q) => q.id), at = _akStepAt(ids, a.step), to = _akClamp(at + by, 0, ids.length - 1);
  a.step = { id: ids[to], index: to };
  _akRepaint();
  const h = document.getElementById('ak-step');
  if (h) try { h.focus({ preventScroll: true }); h.scrollIntoView({ block: 'start' }); } catch (_) {}
}

// One question: what it asks, its clock, where it is answered, what went wrong or the page's thanks, the member's own
// written answers, the results, the reactions.
function _akQBlock(a, full, q) {
  const k = q.id, st = _akState(q, full), shown = _akShown(q, full), result = full.live ? full.live.results[String(k)] : undefined;
  const shut = !q.open && _akPageOpen(full) && q.kind !== 'info';
  const same = q.title.trim() === full.page.title.trim();
  const formed = (st === 'open' || st === 'change' || st === 'done' || st === 'shut') && !(q.kind === 'pin' && (st === 'done' || st === 'shut') && shown);
  const head = [
    `<div class="ak-qhead"><h3 class="ak-qt${same && !shut ? ' sr-only' : ''}" id="ak-qt-${k}" dir="auto">${esc(q.title)}</h3>${shut ? `<span class="ak-chip">${_aT('closed')}</span>` : ''}</div>`,
    q.help ? `<p class="ak-help" dir="auto">${esc(q.help)}</p>` : '',
    q.image && !(q.kind === 'pin' && (formed || shown)) ? `<img class="ak-img" src="${esc(q.image)}" alt="" loading="lazy" decoding="async">` : '',
  ].join('');
  const clk = _akClock(q, a), ticking = !!clk && q.open && !q.reveal && _akPageOpen(full);
  a.over[k] = ticking && clk.over;
  const clock = ticking ? `<div class="ak-clock${clk.over ? ' over' : ''}" role="timer" id="ak-clk-${k}" aria-label="${esc(clk.over ? _aT('eLate') : _aF('secondsLeft', clk.left))}"><span class="ak-clock-n" aria-hidden="true">${clk.left}</span><span class="ak-clock-bar" aria-hidden="true"><span data-cssv="${_cssv({ '--w': (clk.share * 100).toFixed(1) + '%' })}"></span></span></div>` : '';
  const err = a.errs[k];
  const right = _akRightLine(q, result, formed, shown);
  const msg = [
    st === 'signin' ? `<p class="ak-err" role="alert">${_aT('eSignin')}</p>` : '',
    err ? `<p class="ak-err" role="alert">${esc(err)}</p>` : a.thanked === k && full.page.thanks ? `<p class="ak-thanks" role="status" dir="auto">${esc(full.page.thanks)}</p>` : '',
    right,
  ].join('');
  const mine = _akWritten(q.kind) ? _akMineHtml(a, full, q) : '';
  return {
    id: 'ak-q-' + k, tag: 'section', cls: 'hub-card ak-q', attrs: ` data-kind="${esc(q.kind)}" aria-labelledby="ak-qt-${k}"`,
    parts: [['ak-q-' + k + '-h', head], ['ak-q-' + k + '-c', clock], ['ak-q-' + k + '-f', formed ? _akForm(a, full, q, st, ticking && clk.over) : ''], ['ak-q-' + k + '-e', msg], ['ak-q-' + k + '-m', mine],
      ['ak-q-' + k + '-r', shown && result != null ? _akRes(a, full, q, result) : ''], ['ak-q-' + k + '-x', full.page.reactions ? _akReactHtml(full, q) : '']],
  };
}
// The right answer of a revealed question in a line, where neither the form nor the chart says it.
function _akRightLine(q, result, formed, shown) {
  if (!q.reveal) return '';
  if (shown || ((q.kind === 'choice' || q.kind === 'quiz') && formed)) return '';
  let said = '';
  const r = _akO(result) || {};
  if (q.kind === 'quiz_text') { const acc = _akCfgQT(q.config).accept; said = (acc.length ? acc : _akL(r.correct).filter((x) => typeof x === 'string')).join(' · '); }
  else if (q.kind === 'number') { const c = _akCfgN(q.config), v = c.correct ?? _akNum(r.correct); said = v === null ? '' : _akN(v, 4) + (c.unit ? ' ' + c.unit : ''); }
  else if (q.kind === 'choice' || q.kind === 'quiz') {
    const c = q.kind === 'quiz' ? _akCfgQ(q.config) : _akCfgC(q.config), ids = c.correct.length ? c.correct : _akL(r.correct);
    said = c.options.filter((o) => ids.includes(o.id)).map(_akOt).join(' · ');
  }
  return said ? `<p class="ak-reveal"><span class="ak-right">${_akIc('check', 14)}</span><span>${_aT('correct')}</span> <b dir="auto">${esc(said)}</b></p>` : '';
}
function _akMineHtml(a, full, q) {
  const rows = _akMine(full, q); if (!rows.length) return '';
  return `<ul class="ak-mine">${rows.map((m) => `<li class="ak-mine-row" data-status="${m.status}"><span id="ak-a-${m.id}" class="ak-mine-t" dir="auto">${esc(m.body)}</span>${m.status === 'approved' ? '' : `<span class="ak-mine-s"><span class="ak-chip ${m.status === 'pending' ? 'ak-chip-wait' : 'ak-chip-no'}">${_aT(m.status === 'pending' ? 'waiting' : 'rejected')}</span>${m.status === 'pending' && full.signed ? `<button type="button" class="ak-x" id="ak-rm-${m.id}" aria-label="${esc(_aT('remove'))}" aria-describedby="ak-a-${m.id}"${a.removing === m.id ? ' disabled' : ''} data-on-click="${_on('_akUnsend', q.id, m.id)}">${_akIc('close', 14)}</button>` : ''}</span>`}</li>`).join('')}</ul>`;
}

// ── Where each kind is answered ─────────────────────────────────────────────────────────────────────
// The draft starts from the answer on file (redrawn whenever that answer changes), else empty.
function _akD(q, sent) {
  const a = S._ak, k = String(q.id), from = sent ? sent.id + ':' + sent.created_at : '';
  let d = a.draft[k];
  if (d && d._from === from) return d;
  const v = sent ? sent.value : null;
  d = { _from: from };
  if (q.kind === 'choice') d.o = _akSentIds(v, 'o');
  else if (q.kind === 'scales') d.s = _akSentMarks(v, 's');
  else if (q.kind === 'points') d.p = _akSentMarks(v, 'p');
  else if (q.kind === 'ranking') { const was = _akSentIds(v, 'r'); d.r = _akShapeR(q.config, was).ok ? was : _akOpts(q.config).map((o) => o.id); }
  else if (q.kind === 'number') { const n = _akNum(_akO(v) && v.n); d.n = n === null ? '' : String(n); }
  else if (q.kind === 'grid') { d.g = _akSentGrid(v); d.act = null; }
  else if (q.kind === 'pin') d.pin = _akSentPin(v);
  else if (q.kind === 'form') d.f = _akSentForm(v);
  else if (q.kind === 'quiz_text') d.t = sent ? sent.body : '';
  else d.t = (a.draft[k] && a.draft[k].t) || '';
  a.draft[k] = d;
  return d;
}
const _akSendBtn = (q, busy, off) => `<button type="button" class="btn-primary ak-send" id="ak-go-${q.id}"${busy || off ? ' disabled' : ''} data-on-click="${_on('_akGo', q.id)}">${_aT(busy ? 'sending' : 'send')}</button>`;
function _akForm(a, full, q, st, late) {
  const k = q.id, mine = _akMine(full, q), sent = _akWritten(q.kind) ? null : mine[0] || null, d = _akD(q, sent);
  const busy = !!a.busy[k], locked = st === 'done' || st === 'shut';
  switch (q.kind) {
    case 'cloud': case 'open': case 'qa': {
      const c = _akCfgW(q.kind, q.config), long = c.maxLen > 80;
      const attrs = `id="ak-in-${k}" class="ak-input" dir="auto" maxlength="${c.maxLen}" autocomplete="off" enterkeyhint="send" placeholder="${esc(_aT(q.kind === 'qa' ? 'yourQuestion' : 'yourAnswer'))}" aria-labelledby="ak-qt-${k}" data-ak-d="${k}|t" data-on-input="${_on('_akIn', k, 't', _EL)}" data-on-keydown="${_on('_akKey', _EV, k)}"`;
      return `<div class="ak-write"><div class="ak-field">${long ? `<textarea rows="2" ${attrs}></textarea>` : `<input type="text" ${attrs}>`}<span class="ak-left" data-ak-left="${k}" aria-hidden="true"></span></div>${_akSendBtn(q, busy)}</div>`;
    }
    case 'choice': {
      const c = _akCfgC(q.config), single = c.maxPicks === 1, was = _akSentIds(sent && sent.value, 'o');
      const same = d.o.length === was.length && d.o.every((id) => was.includes(id));
      return `<div class="ak-opts" role="${single ? 'radiogroup' : 'group'}" aria-labelledby="ak-qt-${k}">${c.options.map((o) => {
        const on = d.o.includes(o.id), off = locked || busy || (!single && !on && d.o.length >= c.maxPicks);
        return `<button type="button" class="ak-opt${on ? ' on' : ''}${single ? '' : ' many'}" id="ak-o-${k}-${o.id}" role="${single ? 'radio' : 'checkbox'}" aria-checked="${on}"${off ? ' disabled' : ''} data-on-click="${_on('_akPick', k, o.id)}"><span class="ak-mark" aria-hidden="true"></span><span class="ak-opt-t" dir="auto">${esc(_akOt(o))}</span>${q.reveal && c.correct.includes(o.id) ? `<span class="ak-right">${_akIc('check', 14)}<span class="sr-only">${_aT('correct')}</span></span>` : ''}</button>`;
      }).join('')}</div>${locked ? '' : _akSendBtn(q, busy, !d.o.length || (st === 'change' && same))}`;
    }
    case 'scales': {
      const c = _akCfgS(q.config), vals = Array.from({ length: c.max - c.min + 1 }, (_, i) => c.min + i);
      return c.options.map((o) => `<div class="ak-scale" role="radiogroup" aria-labelledby="ak-sl-${k}-${o.id}"><span class="ak-scale-l" id="ak-sl-${k}-${o.id}" dir="auto">${esc(_akOt(o))}</span><div class="ak-marks">${vals.map((v) => {
        const on = d.s[o.id] === v;
        return `<button type="button" class="ak-mk${on ? ' on' : ''}" id="ak-m-${k}-${o.id}-${v}" role="radio" aria-checked="${on}"${locked || busy ? ' disabled' : ''} data-on-click="${_on('_akMark', k, o.id, v)}">${v}</button>`;
      }).join('')}</div>${c.lo || c.hi ? `<div class="ak-ends" aria-hidden="true"><span dir="auto">${esc(c.lo)}</span><span dir="auto">${esc(c.hi)}</span></div>` : ''}</div>`).join('')
        + (locked ? '' : _akSendBtn(q, busy, !_akShapeS(q.config, d.s).ok));
    }
    case 'ranking': {
      const opts = _akOpts(q.config), name = (id) => { const o = opts.find((x) => x.id === id); return o ? _akOt(o) : ''; };
      return `<ol class="ak-rank" aria-labelledby="ak-qt-${k}">${d.r.map((id, i) => `<li class="ak-rank-r"><span class="ak-rank-n" aria-hidden="true">${i + 1}</span><span class="ak-rank-t" dir="auto">${esc(name(id))}</span>${locked ? '' : `<span class="ak-rank-b"><button type="button" class="ak-ib" id="ak-up-${k}-${id}" aria-label="${esc(_aF('up', name(id)))}"${i === 0 || busy ? ' disabled' : ''} data-on-click="${_on('_akMove', k, i, -1)}">${_akIc('up', 18)}</button><button type="button" class="ak-ib" id="ak-dn-${k}-${id}" aria-label="${esc(_aF('down', name(id)))}"${i === d.r.length - 1 || busy ? ' disabled' : ''} data-on-click="${_on('_akMove', k, i, 1)}">${_akIc('down', 18)}</button></span>`}</li>`).join('')}</ol>${locked ? '' : _akSendBtn(q, busy)}`;
    }
    case 'points': {
      const c = _akCfgP(q.config), used = c.options.reduce((s, o) => s + (d.p[o.id] || 0), 0), left = c.total - used;
      return `<ul class="ak-points">${c.options.map((o) => {
        const n = d.p[o.id] || 0, lbl = _akOt(o);
        return `<li class="ak-points-r"><span class="ak-points-t" id="ak-pl-${k}-${o.id}" dir="auto">${esc(lbl)}</span><span class="ak-stepper">${locked ? '' : `<button type="button" class="ak-ib" id="ak-pm-${k}-${o.id}" aria-label="${esc(_aF('fewer', lbl))}"${busy || n <= 0 ? ' disabled' : ''} data-on-click="${_on('_akPts', k, o.id, -1)}">${_akIc('minus', 18)}</button>`}<input type="text" class="ak-input ak-pbox" id="ak-pb-${k}-${o.id}" inputmode="numeric" autocomplete="off" value="${n}" aria-labelledby="ak-pl-${k}-${o.id}"${locked || busy ? ' disabled' : ''} data-on-input="${_on('_akIn', k, 'p.' + o.id, _EL)}">${locked ? '' : `<button type="button" class="ak-ib" id="ak-pp-${k}-${o.id}" aria-label="${esc(_aF('more', lbl))}"${busy || left <= 0 ? ' disabled' : ''} data-on-click="${_on('_akPts', k, o.id, 1)}">${_akIc('plus', 18)}</button>`}</span></li>`;
      }).join('')}</ul>${locked ? '' : `<div class="ak-send-row"><p class="ak-pleft" role="status">${esc(_aF('pointsLeft', left))}</p>${_akSendBtn(q, busy, used < 1 || used > c.total)}</div>`}`;
    }
    case 'number': {
      const c = _akCfgN(q.config);
      return `<div class="ak-number"><input type="text" class="ak-input ak-nbox" id="ak-in-${k}" inputmode="${c.min < 0 ? 'text' : Number.isInteger(c.step) && Number.isInteger(c.min) ? 'numeric' : 'decimal'}" autocomplete="off" maxlength="16" placeholder="${esc(_akN(c.min, 4) + ' - ' + _akN(c.max, 4))}" aria-labelledby="ak-qt-${k}"${locked || busy ? ' disabled' : ''} ${locked ? `value="${esc(d.n)}"` : `data-ak-d="${k}|n" data-on-input="${_on('_akIn', k, 'n', _EL)}" data-on-keydown="${_on('_akKey', _EV, k)}"`}>${c.unit ? `<span class="ak-unit" dir="auto">${esc(c.unit)}</span>` : ''}${locked ? '' : _akSendBtn(q, busy)}</div>`;
    }
    case 'grid': return _akGridHtml(q, d, locked, busy);
    case 'pin': return _akPinHtml(q, d, locked, busy, q.reveal ? _akTarget(q.config.correct) : null);
    case 'form': {
      const fields = _akFields(q.config);
      return fields.map((f) => {
        const lbl = `<span dir="auto">${esc(f.label)}</span>${f.required ? `<span class="ak-req">${_aT('required')}</span>` : ''}`;
        if (f.type === 'choice') {
          return `<div class="ak-ff" role="radiogroup" aria-labelledby="ak-fl-${k}-${f.id}"><span class="ak-ff-l" id="ak-fl-${k}-${f.id}">${lbl}</span><div class="ak-opts">${f.options.map((o) => {
            const on = d.f[f.id] === o.id;
            return `<button type="button" class="ak-opt${on ? ' on' : ''}" id="ak-fo-${k}-${f.id}-${o.id}" role="radio" aria-checked="${on}"${locked || busy ? ' disabled' : ''} data-on-click="${_on('_akFPick', k, f.id, o.id)}"><span class="ak-mark" aria-hidden="true"></span><span class="ak-opt-t" dir="auto">${esc(_akOt(o))}</span></button>`;
          }).join('')}</div></div>`;
        }
        const id = `ak-f-${k}-${f.id}`;
        return `<div class="ak-ff"><label class="ak-ff-l" for="${id}">${lbl}</label><input type="text" class="ak-input" id="${id}" ${f.type === 'number' ? 'inputmode="decimal" maxlength="24"' : 'dir="auto" maxlength="200"'} autocomplete="off"${locked || busy ? ' disabled' : ''} ${locked ? `value="${esc(d.f[f.id] || '')}"` : `data-ak-d="${k}|f.${f.id}" data-on-input="${_on('_akIn', k, 'f.' + f.id, _EL)}"`}></div>`;
      }).join('') + (locked ? (sent ? `<p class="ak-own" role="status">${_aT('sent')}</p>` : '') : _akSendBtn(q, busy));
    }
    case 'quiz': {
      const c = _akCfgQ(q.config), picked = _akSentIds(sent && sent.value, 'o')[0] || '', off = locked || late || busy || !!picked || !!d.going;
      return `<div class="ak-quiz" role="group" aria-labelledby="ak-qt-${k}">${c.options.map((o) => {
        const me = picked === o.id || d.going === o.id, right = q.reveal && c.correct.includes(o.id);
        return `<button type="button" class="ak-qopt${me ? ' on' : ''}${right ? ' right' : q.reveal && me ? ' wrong' : ''}" id="ak-qo-${k}-${o.id}" aria-pressed="${me}"${off ? ' disabled' : ''} data-on-click="${_on('_akQuizPick', k, o.id)}"><span class="ak-qopt-t" dir="auto">${esc(_akOt(o))}</span>${right ? `<span class="ak-right">${_akIc('check', 14)}<span class="sr-only">${_aT('correct')}</span></span>` : ''}${me ? `<span class="ak-chip">${_aT('yourAnswer')}</span>` : ''}</button>`;
      }).join('')}</div>${_akOwnQuiz(q, sent, late)}`;
    }
    case 'quiz_text': {
      const c = _akCfgQT(q.config), off = locked || late || !!sent;
      return `<div class="ak-write"><div class="ak-field"><input type="text" class="ak-input" id="ak-in-${k}" dir="auto" maxlength="${c.maxLen}" autocomplete="off" enterkeyhint="send" placeholder="${esc(_aT('yourAnswer'))}" aria-labelledby="ak-qt-${k}"${off || busy ? ' disabled' : ''} ${off ? `value="${esc(sent ? sent.body : '')}"` : `data-ak-d="${k}|t" data-on-input="${_on('_akIn', k, 't', _EL)}" data-on-keydown="${_on('_akKey', _EV, k)}"`}>${off ? '' : `<span class="ak-left" data-ak-left="${k}" aria-hidden="true"></span>`}</div>${off ? '' : _akSendBtn(q, busy)}</div>${_akOwnQuiz(q, sent, late)}`;
    }
    default: return '';
  }
}
// Under a quiz answer: "Answer sent" until staff reveal it, then right or not and its points; none in time: time is up.
function _akOwnQuiz(q, sent, late) {
  if (!sent) return late ? `<p class="ak-own" role="status">${_aT('eLate')}</p>` : '';
  if (!q.reveal || sent.score === null) return `<p class="ak-own" role="status">${_aT('answerSent')}</p>`;
  const ok = sent.score > 0;
  return `<p class="ak-own" role="status"><span class="ak-chip ${ok ? 'ak-chip-ok' : 'ak-chip-no'}">${_aT(ok ? 'right' : 'wrong')}</span> <b>${esc(_aF('points', _akN(sent.score, 0)))}</b></p>`;
}
// A grid: every item placed on a square between two named axes. A tap on the square places the item picked (else the
// first one not placed yet); a tap on a number picks that item; the two sliders of each item are the keyboard's way.
const AK_GRID_STEP = 0.5;
const _akSnap = (v, max) => _akClamp(Math.round((Number.isFinite(v) ? v : 0) / AK_GRID_STEP) * AK_GRID_STEP, 0, max);
function _akGridHtml(q, d, locked, busy) {
  const c = _akCfgG(q.config), k = q.id, xn = c.x || _aT('axisX'), yn = c.y || _aT('axisY'), mid = c.max / 2, n = c.options.length;
  const marks = c.options.map((o, i) => {
    const m = d.g[o.id], turn = (2 * Math.PI * i) / Math.max(1, n) - Math.PI / 2, out = n > 1 ? 0.12 : 0;
    const fx = m ? m[0] / c.max : 0.5 + out * Math.cos(turn), fy = m ? m[1] / c.max : 0.5 - out * Math.sin(turn);
    return `<span class="ak-gm${m ? ' set' : ''}${d.act === o.id ? ' act' : ''}" id="ak-gm-${k}-${o.id}" data-g="${o.id}" data-cssv="${_cssv({ '--x': (fx * 100).toFixed(2) + '%', '--y': (fy * 100).toFixed(2) + '%' })}">${i + 1}</span>`;
  }).join('');
  const items = c.options.map((o, i) => {
    const m = d.g[o.id], name = _akOt(o);
    return `<li><button type="button" class="ak-gname${d.act === o.id ? ' act' : ''}" id="ak-gn-${k}-${o.id}" aria-pressed="${d.act === o.id}"${locked ? ' disabled' : ''} data-on-click="${_on('_akGridAct', k, o.id)}"><span class="ak-gno${m ? ' set' : ''}" aria-hidden="true">${i + 1}</span><span dir="auto">${esc(name)}</span></button>${['x', 'y'].map((ax) => {
      const v = m ? m[ax === 'x' ? 0 : 1] : mid, lbl = ax === 'x' ? xn : yn;
      return `<label class="ak-gsl"><span dir="auto">${esc(lbl)}</span><input type="range" id="ak-gs-${k}-${o.id}-${ax}" min="0" max="${c.max}" step="${AK_GRID_STEP}" value="${v}" aria-label="${esc(name + ': ' + lbl)}"${locked ? ' disabled' : ''} data-on-input="${_on('_akGridSl', k, o.id, ax, _EL)}" data-on-change="${_on('_akGridSlDone', k)}"><span class="ak-gv" id="ak-gv-${k}-${o.id}-${ax}" aria-hidden="true">${m ? esc(_akN(v)) : ''}</span></label>`;
    }).join('')}</li>`;
  }).join('');
  return `<div class="ak-grid" aria-hidden="true"><span class="ak-grid-y" dir="auto">${esc(yn)}</span><div class="ak-grid-a${locked ? ' still' : ''}" id="ak-ga-${k}" data-on-click="${_on('_akGridTap', _EV, _EL, k)}">${marks}</div><span class="ak-grid-x" dir="auto">${esc(xn)}</span></div><ol class="ak-gitems">${items}</ol>${locked ? '' : _akSendBtn(q, busy, !_akShapeG(q.config, d.g).ok)}`;
}
function _akTarget(v) { const o = _akO(v), x = _akNum(o && o.x), y = _akNum(o && o.y), r = _akNum(o && o.r); return o && x !== null && y !== null && r !== null && x >= 0 && x <= 1 && y >= 0 && y <= 1 && r > 0 && r <= 0.5 ? { x, y, r } : null; }
// A pin on the question's picture: a tap drops it where it fell, the arrow keys move it by 1% (Shift: 5%).
function _akPinHtml(q, d, locked, busy, target) {
  if (!q.image) return '';
  const k = q.id, p = d.pin;
  return `<div class="ak-pin"><img src="${esc(q.image)}" alt="" decoding="async"><button type="button" class="ak-pin-a" id="ak-pa-${k}" aria-labelledby="ak-qt-${k}"${p ? ` aria-describedby="ak-pn-${k}"` : ''}${locked || busy ? ' disabled' : ''} data-on-click="${_on('_akPinTap', _EV, _EL, k)}" data-on-keydown="${_on('_akPinKey', _EV, k)}"></button>${target ? `<span class="ak-ring" aria-hidden="true" data-cssv="${_cssv({ '--x': (target.x * 100) + '%', '--y': (target.y * 100) + '%', '--r': (target.r * 200) + '%' })}"></span>` : ''}${p ? `<span class="ak-pm" aria-hidden="true" data-cssv="${_cssv({ '--x': (p.x * 100) + '%', '--y': (p.y * 100) + '%' })}"></span>` : ''}</div>${p ? `<span id="ak-pn-${k}" class="sr-only">${esc(_aF('pinAt', Math.round(p.x * 100), Math.round(p.y * 100)))}</span>` : ''}${locked ? '' : _akSendBtn(q, busy, !p)}`;
}

// ── What the member does ────────────────────────────────────────────────────────────────────────────
function _akClearErr(qid) { const a = S._ak; if (a && (a.errs[qid] || a.thanked === qid)) { a.errs[qid] = ''; if (a.thanked === qid) a.thanked = null; _akRepaint(); } }
function _akIn(qid, path, el) {
  const a = S._ak, d = a && a.draft[String(qid)]; if (!d || !el) return;
  const v = String(el.value == null ? '' : el.value);
  if (path.startsWith('f.')) d.f[path.slice(2)] = v;
  else if (path.startsWith('p.')) {
    const q = _akQById(qid), c = q && _akCfgP(q.config); if (!c) return;
    const id = path.slice(2), others = c.options.reduce((s, o) => s + (o.id === id ? 0 : d.p[o.id] || 0), 0);
    d.p[id] = Math.max(0, Math.min(Math.floor(Number(_akLat(v).replace(/\D/g, '').slice(0, 4)) || 0), c.total - others));
    _akRepaint();
  } else d[path] = v;
  const left = document.querySelector(`[data-ak-left="${qid}"]`); if (left) _akLeftSet(left);
  if (a.errs[qid]) _akClearErr(qid);
}
function _akKey(ev, qid) {
  if (!ev || ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
  ev.preventDefault();
  _akGo(qid);
}
function _akPick(qid, oid) {
  const q = _akQById(qid), d = S._ak && S._ak.draft[String(qid)]; if (!q || !d) return;
  const c = _akCfgC(q.config);
  d.o = c.maxPicks === 1 ? [oid] : d.o.includes(oid) ? d.o.filter((x) => x !== oid) : d.o.length < c.maxPicks ? [...d.o, oid] : d.o;
  S._ak.errs[qid] = '';
  _akRepaint();
}
function _akMark(qid, oid, v) {
  const q = _akQById(qid), d = S._ak && S._ak.draft[String(qid)]; if (!q || !d) return;
  if (_akCfgS(q.config).skip && d.s[oid] === v) delete d.s[oid]; else d.s[oid] = v;
  S._ak.errs[qid] = '';
  _akRepaint();
}
function _akMove(qid, i, by) {
  const d = S._ak && S._ak.draft[String(qid)]; if (!d) return;
  const j = i + by; if (j < 0 || j >= d.r.length) return;
  const r = d.r.slice(); [r[i], r[j]] = [r[j], r[i]]; d.r = r;
  _akRepaint();
  // the moved item keeps the keyboard: its button in its new row
  const b = document.getElementById(`ak-${by < 0 ? 'up' : 'dn'}-${qid}-${r[j]}`);
  if (b && !b.disabled) try { b.focus({ preventScroll: true }); } catch (_) {}
}
function _akPts(qid, oid, dir) {
  const q = _akQById(qid), d = S._ak && S._ak.draft[String(qid)]; if (!q || !d) return;
  const c = _akCfgP(q.config), step = Math.max(1, Math.round(c.total / 20)), others = c.options.reduce((s, o) => s + (o.id === oid ? 0 : d.p[o.id] || 0), 0);
  d.p[oid] = Math.max(0, Math.min((d.p[oid] || 0) + dir * step, c.total - others));
  _akRepaint();
}
function _akFPick(qid, fid, oid) {
  const q = _akQById(qid), d = S._ak && S._ak.draft[String(qid)]; if (!q || !d) return;
  const f = _akFields(q.config).find((x) => x.id === fid); if (!f) return;
  d.f[fid] = d.f[fid] === oid && !f.required ? '' : oid;
  _akRepaint();
}
function _akGridAct(qid, oid) { const d = S._ak && S._ak.draft[String(qid)]; if (!d) return; d.act = d.act === oid ? null : oid; _akRepaint(); }
function _akGridTap(ev, el, qid) {
  const q = _akQById(qid), d = S._ak && S._ak.draft[String(qid)]; if (!q || !d || !el || el.classList.contains('still')) return;
  const c = _akCfgG(q.config), hit = ev && ev.target && ev.target.closest && ev.target.closest('[data-g]');
  if (hit && el.contains(hit)) { d.act = hit.getAttribute('data-g'); _akRepaint(); return; }
  const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
  const id = d.act || (c.options.find((o) => !d.g[o.id]) || {}).id; if (!id) return;
  const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
  d.g[id] = [_akSnap((_isRtl() ? 1 - fx : fx) * c.max, c.max), _akSnap((1 - fy) * c.max, c.max)];
  const next = c.options.find((o) => !d.g[o.id]);
  d.act = next ? next.id : null;
  _akRepaint();
}
function _akGridSl(qid, oid, ax, el) {
  const q = _akQById(qid), d = S._ak && S._ak.draft[String(qid)]; if (!q || !d || !el) return;
  const c = _akCfgG(q.config), mid = c.max / 2, m = d.g[oid] || [mid, mid], v = _akSnap(Number(el.value), c.max);
  d.g[oid] = ax === 'x' ? [v, m[1]] : [m[0], v];
  // moved while the finger is on it: the marker and the value follow without redrawing the slider
  const mk = document.getElementById(`ak-gm-${qid}-${oid}`);
  if (mk) { mk.classList.add('set'); mk.style.setProperty('--x', (d.g[oid][0] / c.max * 100).toFixed(2) + '%'); mk.style.setProperty('--y', (d.g[oid][1] / c.max * 100).toFixed(2) + '%'); }
  ['x', 'y'].forEach((a, i) => { const t = document.getElementById(`ak-gv-${qid}-${oid}-${a}`); if (t) t.textContent = _akN(d.g[oid][i]); });
}
function _akGridSlDone() { _akRepaint(); }
function _akPinTap(ev, el, qid) {
  const d = S._ak && S._ak.draft[String(qid)]; if (!d || !el) return;
  if (ev && ev.detail === 0) { if (!d.pin) d.pin = { x: 0.5, y: 0.5 }; _akRepaint(); return; } // Enter or Space on the picture
  const r = el.getBoundingClientRect(); if (!r.width || !r.height) return;
  d.pin = { x: _akFrac((ev.clientX - r.left) / r.width), y: _akFrac((ev.clientY - r.top) / r.height) };
  _akRepaint();
}
function _akPinKey(ev, qid) {
  const d = S._ak && S._ak.draft[String(qid)]; if (!d || !ev) return;
  const by = ev.shiftKey ? 0.05 : 0.01;
  const m = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }[ev.key];
  if (!m) return;
  ev.preventDefault();
  d.pin = d.pin ? { x: _akFrac(d.pin.x + m[0]), y: _akFrac(d.pin.y + m[1]) } : { x: 0.5, y: 0.5 };
  _akRepaint();
}
function _akQuizPick(qid, oid) {
  const q = _akQById(qid), d = S._ak && S._ak.draft[String(qid)]; if (!q || !d || d.going) return;
  d.going = oid;
  _akSend(q, { o: [oid] }).then(() => { d.going = ''; _akRepaint(); });
}
// Send: the value shaped and checked here first; what is wrong is said under the question.
function _akGo(qid) {
  const a = S._ak, q = _akQById(qid); if (!a || !q || a.busy[qid]) return;
  const d = a.draft[String(qid)] || _akD(q, null);
  let sh;
  switch (q.kind) {
    case 'cloud': case 'open': case 'qa': sh = _akShapeW(q.kind, q.config, d.t); break;
    case 'choice': sh = _akShapeC(q.config, d.o); break;
    case 'scales': sh = _akShapeS(q.config, d.s); break;
    case 'ranking': sh = _akShapeR(q.config, d.r); break;
    case 'points': sh = _akShapeP(q.config, d.p); break;
    case 'number': sh = _akShapeN(q.config, d.n); break;
    case 'grid': sh = _akShapeG(q.config, d.g); break;
    case 'pin': sh = _akShapePin(d.pin); break;
    case 'form': sh = _akShapeF(q.config, d.f); break;
    case 'quiz_text': sh = _akShapeQT(q.config, d.t); break;
    default: return;
  }
  if (!sh.ok) { a.errs[qid] = _akErrText(sh.error); a.thanked = null; _akRepaint(); return; }
  const typed = d.t;
  _akSend(q, sh.value).then((ok) => {
    if (!ok || !_akWritten(q.kind)) return;
    // sent: the box is empty again (unless more was typed meanwhile), with the keyboard still in it
    if (d.t === typed) d.t = '';
    _akRepaint();
    const box = document.getElementById('ak-in-' + qid); if (box) try { box.focus({ preventScroll: true }); } catch (_) {}
  });
}
async function _akSend(q, value) {
  const a = S._ak, full = _akFullNow(), c = _hCust(); if (!a || !full || !c) return false;
  const k = q.id;
  a.busy[k] = true; a.errs[k] = ''; a.thanked = null;
  _akRepaint();
  let r; try { r = await sb.rpc('ask_send', { p_question: k, ..._hTok(c), p_value: value, p_lang: /^[a-z]{2}$/.test(S.lang || '') ? S.lang : 'en' }); } catch (e) { r = { error: e }; }
  a.busy[k] = false;
  if (S._ak !== a) return false;
  const o = r && !r.error ? _akO(r.data) : null;
  if (o && o.ok === true) {
    a.thanked = k;
    if (Array.isArray(o.mine)) { const f = _akFullNow(); if (f) f.mine[String(k)] = _akMineList(o.mine); } else _akRead(true);
    a.own = true;
    S._akListAt = 0; // the feed's card counts this answer when it is read again
    _akRepaint();
    _akPollNow();
    return true;
  }
  const code = o ? o.error : 'generic';
  a.errs[k] = _akErrText(code);
  if (code === 'signin' || code === 'audience' || code === 'closed') _akRead(false); // the page is not what it was
  _akRepaint();
  return false;
}
async function _akUnsend(qid, aid) {
  const a = S._ak, c = _hCust(); if (!a || !c || a.removing !== null) return;
  a.removing = aid; a.errs[qid] = ''; _akRepaint();
  let r; try { r = await sb.rpc('ask_unsend', { p_answer: aid, ..._hTok(c) }); } catch (e) { r = { error: e }; }
  a.removing = null;
  if (S._ak !== a) return;
  const ok = r && !r.error && r.data && r.data.ok === true, f = _akFullNow();
  if (ok && f) { f.mine[String(qid)] = (f.mine[String(qid)] || []).filter((m) => m.id !== aid); S._akListAt = 0; _akPollNow(); }
  else { a.errs[qid] = _aT('tryLater'); if (r && !r.error) _akRead(false); } // not taken back: staff may have reviewed it meanwhile
  _akRepaint();
}
async function _akVote(qid, aid, on) {
  const a = S._ak, c = _hCust(); if (!a || !c || a.voting !== null) return;
  a.voting = aid; _akRepaint();
  let r; try { r = await sb.rpc('ask_vote', { p_answer: aid, ..._hTok(c), p_on: !!on }); } catch (e) { r = { error: e }; }
  a.voting = null;
  if (S._ak !== a) return;
  const f = _akFullNow(), o = r && !r.error && _akO(r.data);
  if (o && o.ok === true && f) {
    const was = f.voted.includes(aid);
    f.voted = on ? [...new Set([...f.voted, aid])] : f.voted.filter((x) => x !== aid);
    const res = f.live && _akO(f.live.results[String(qid)]);
    if (res && Array.isArray(res.items)) res.items = res.items.map((x) => { const it = _akO(x); if (!it || _akInt(it.id) !== aid) return x; const votes = _akInt(o.votes); return { ...it, v: votes !== null ? votes : Math.max(0, (_akInt(it.v) || 0) + (on === was ? 0 : on ? 1 : -1)) }; });
  } else a.errs[qid] = _aT('tryLater');
  _akRepaint();
}
// A reaction shows at once and is put back as it was if the database did not take it.
function _akReact(qid, kind, on) {
  const a = S._ak, c = _hCust(), f = _akFullNow(); if (!a || !c || !f) return;
  const set = (to) => {
    const id = String(qid), had = (f.reacted[id] || []).includes(kind); if (had === to) return;
    f.reacted[id] = to ? [...(f.reacted[id] || []), kind] : (f.reacted[id] || []).filter((x) => x !== kind);
    if (f.live) { const cn = f.live.reactions[id] = { ...(f.live.reactions[id] || {}) }; cn[kind] = Math.max(0, (cn[kind] || 0) + (to ? 1 : -1)); }
  };
  set(!!on); _akRepaint();
  sb.rpc('ask_react', { p_question: qid, ..._hTok(c), p_kind: kind, p_on: !!on })
    .then((r) => { if (r && !r.error && r.data && r.data.ok === true) { a.own = true; _akPollNow(); } else { set(!on); _akRepaint(); } }, () => { set(!on); _akRepaint(); });
}
function _akReactHtml(full, q) {
  const id = String(q.id), counts = (full.live && full.live.reactions[id]) || {}, mine = full.reacted[id] || [], open = _akPageOpen(full);
  const rows = AK_REACT.map((k) => ({ k, n: Math.max(0, counts[k] || 0), on: mine.includes(k) }));
  if (!open && rows.every((r) => !r.n)) return '';
  return `<div class="ak-reacts">${rows.map((r) => `<button type="button" class="ak-react${r.on ? ' on' : ''}" id="ak-re-${q.id}-${r.k}" aria-pressed="${r.on}" aria-label="${esc(r.n ? _aT(r.k) + ' (' + r.n + ')' : _aT(r.k))}"${!open || !full.canAnswer ? ' disabled' : ''} data-on-click="${_on('_akReact', q.id, r.k, !r.on)}">${_akIc(r.k, 20)}${r.n ? `<span aria-hidden="true">${r.n}</span>` : ''}</button>`).join('')}</div>`;
}

// ── The quiz clock: five times a second while one runs on screen ───────────────────────────────────
function _akTickArm() {
  const a = S._ak; if (!a) return;
  const any = !!document.querySelector('#ak-view .ak-clock:not(.over)');
  if (any && !a.tick) a.tick = setInterval(_akTick, 200);
  else if (!any && a.tick) { clearInterval(a.tick); a.tick = null; }
}
function _akTick() {
  const a = S._ak, full = _akFullNow();
  if (!a || !full || !_akOnView()) { if (a) { clearInterval(a.tick); a.tick = null; } return; }
  let redraw = false;
  document.querySelectorAll('#ak-view .ak-clock').forEach((el) => {
    const q = _akQById(Number(el.id.replace('ak-clk-', ''))), c = q && _akClock(q, a); if (!c) return;
    const n = el.querySelector('.ak-clock-n'), bar = el.querySelector('.ak-clock-bar span');
    if (n) n.textContent = String(c.left);
    if (bar) bar.style.setProperty('--w', (c.share * 100).toFixed(1) + '%');
    el.setAttribute('aria-label', c.over ? _aT('eLate') : _aF('secondsLeft', c.left));
    if (c.over !== !!a.over[q.id]) redraw = true; // run out: the form locks
  });
  if (redraw) _akRepaint();
}

// ── Results: each kind's first chart ───────────────────────────────────────────────────────────────
const _akTotal = (n) => `<p class="ak-total">${esc(n === 0 ? _aT('noAnswers') : n === 1 ? _aT('oneAnswer') : _aF('answers', n))}</p>`;
const _akBarsHtml = (rows) => `<ul class="ak-bars">${rows.map((r) => `<li class="ak-bar${r.right ? ' right' : ''}${r.mine ? ' mine' : ''}"><div class="ak-bar-top"><span class="ak-bar-l" dir="auto">${r.no != null ? `<span class="ak-bar-no" aria-hidden="true">${r.no}</span>` : ''}${esc(r.label)}${r.right ? `<span class="ak-right">${_akIc('check', 14)}<span class="sr-only">${_aT('correct')}</span></span>` : ''}</span><span class="ak-bar-v"><bdi>${esc(r.val)}</bdi></span></div><div class="ak-bar-t"><span data-cssv="${_cssv({ '--w': (_akClamp(r.share, 0, 1) * 100).toFixed(1) + '%' })}"></span></div></li>`).join('')}</ul>`;
function _akRes(a, full, q, raw) {
  const r = _akO(raw) || {}, n = Math.max(0, _akInt(r.n) ?? 0);
  const sent = _akMine(full, q)[0] || null;
  let body = '';
  switch (q.kind) {
    case 'cloud': {
      const seen = new Map();
      for (const x of _akL(r.words)) { const o = _akO(x), w = _akS(o && o.w).trim(), c = _akInt(o && o.n) || 0; if (!w || c <= 0) continue; const h = seen.get(w); if (h) h.n += c; else seen.set(w, { w, n: c }); }
      const words = [...seen.values()].sort((x, y) => y.n - x.n).slice(0, 60), top = words.length ? words[0].n : 1;
      // the most given in the middle, the rest on either side
      const laid = []; words.forEach((w, i) => { if (i % 2) laid.push(w); else laid.unshift(w); });
      body = laid.length ? `<ul class="ak-cloud">${laid.map((w) => { const s = w.n / top; return `<li class="ak-w ak-w${s >= 0.8 ? 5 : s >= 0.6 ? 4 : s >= 0.4 ? 3 : s >= 0.2 ? 2 : 1}" dir="auto">${esc(w.w)}${w.n > 1 ? `<span class="sr-only"> (${w.n})</span>` : ''}</li>`; }).join('')}</ul>` : '';
      break;
    }
    case 'open': case 'qa': {
      const items = [];
      for (const x of _akL(r.items)) { const o = _akO(x), id = _akInt(o && o.id); if (o && id !== null && _akS(o.t).trim()) items.push({ id, t: _akS(o.t).trim(), v: Math.max(0, _akInt(o.v) || 0), done: o.a === true }); }
      if (q.kind === 'qa') items.sort((x, y) => Number(x.done) - Number(y.done) || y.v - x.v);
      const votes = _akCfgW(q.kind, q.config).votes, mineIds = new Set(_akMine(full, q).map((m) => m.id));
      body = items.length ? `<ul class="ak-texts">${items.slice(0, 100).map((x) => {
        let vt = '';
        if (votes) {
          const on = full.voted.includes(x.id);
          vt = !full.signed || mineIds.has(x.id) || !_akPageOpen(full)
            ? `<span class="ak-votes">${_akIc('vote', 14)}<span aria-hidden="true">${x.v}</span><span class="sr-only">${esc(_aF('votes', x.v))}</span></span>`
            : `<button type="button" class="ak-vote${on ? ' on' : ''}" id="ak-v-${x.id}" aria-pressed="${on}" aria-label="${esc(_aF('upvote', x.v))}"${a.voting === x.id ? ' disabled' : ''} data-on-click="${_on('_akVote', q.id, x.id, !on)}">${_akIc('vote', 14)}<span aria-hidden="true">${x.v}</span></button>`;
        }
        return `<li class="ak-text${x.done ? ' done' : ''}"><p dir="auto">${esc(x.t)}</p>${x.done || vt ? `<div class="ak-text-b">${x.done ? `<span class="ak-chip ak-chip-ok">${_aT('answered')}</span>` : ''}${vt}</div>` : ''}</li>`;
      }).join('')}</ul>` : '';
      break;
    }
    case 'choice': case 'quiz': {
      const c = q.kind === 'quiz' ? _akCfgQ(q.config) : _akCfgC(q.config), counts = _akO(r.counts) || {}, right = _akL(r.correct);
      const each = c.options.map((o) => Math.max(0, _akInt(counts[o.id]) ?? 0)), all = Math.max(n, ...each, 0), picked = _akSentIds(sent && sent.value, 'o');
      body = _akBarsHtml(c.options.map((o, i) => ({ label: _akOt(o), share: all ? each[i] / all : 0, val: _akN(each[i], 0) + ' · ' + _akPct(all ? each[i] / all : 0), right: right.includes(o.id), mine: picked.includes(o.id) })));
      if (q.kind === 'quiz' && right.length) { const got = Math.min(all, c.options.reduce((s, o, i) => s + (right.includes(o.id) ? each[i] : 0), 0)); body += `<p class="ak-meta">${esc(_aF('gotRight', got, all))}</p>`; }
      break;
    }
    case 'scales': {
      const c = _akCfgS(q.config), avg = _akO(r.avg) || {};
      body = `<ul class="ak-scales">${c.options.map((o) => {
        const v = _akNum(avg[o.id]), m = v === null ? null : _akClamp(v, c.min, c.max), at = m === null ? 0 : (m - c.min) / (c.max - c.min);
        return `<li class="ak-sc"><div class="ak-bar-top"><span class="ak-bar-l" dir="auto">${esc(_akOt(o))}</span><span class="ak-bar-v">${m === null ? '' : esc(_aF('average', _akN(m, 1)))}</span></div><div class="ak-track">${m === null ? '' : `<span class="ak-dot" data-cssv="${_cssv({ '--at': (at * 100).toFixed(1) + '%' })}"></span>`}</div><div class="ak-ends" aria-hidden="true"><span dir="auto">${esc(c.lo || String(c.min))}</span><span dir="auto">${esc(c.hi || String(c.max))}</span></div></li>`;
      }).join('')}</ul>`;
      break;
    }
    case 'ranking': {
      const score = _akO(r.score) || {}, pos = _akO(r.pos) || {};
      const rows = _akOpts(q.config).map((o, i) => ({ i, label: _akOt(o), s: Math.max(0, _akNum(score[o.id]) ?? 0), p: _akNum(pos[o.id]) }));
      const top = Math.max(...rows.map((x) => x.s), 0), all = rows.reduce((s, x) => s + x.s, 0);
      rows.sort((x, y) => y.s - x.s || (x.p ?? Infinity) - (y.p ?? Infinity) || x.i - y.i);
      body = _akBarsHtml(rows.map((x, i) => ({ no: i + 1, label: x.label, share: top ? x.s / top : 0, val: _akN(x.s, 0) + ' · ' + _akPct(all ? x.s / all : 0) })));
      break;
    }
    case 'points': {
      const c = _akCfgP(q.config), avg = _akO(r.avg) || {};
      body = _akBarsHtml(c.options.map((o) => { const v = Math.max(0, _akNum(avg[o.id]) ?? 0); return { label: _akOt(o), share: v / c.total, val: _akN(v, 1) }; }));
      break;
    }
    case 'number': {
      const c = _akCfgN(q.config), bins = _akL(r.bins).map(_akO).filter(Boolean).map((b) => ({ n: Math.max(0, _akInt(b.n) || 0) })).slice(0, 40);
      const most = Math.max(...bins.map((b) => b.n), 0), av = _akNum(r.avg), lo = _akNum(r.min), hi = _akNum(r.max), right = _akNum(r.correct), u = c.unit ? ' ' + c.unit : '';
      body = (most ? `<div class="ak-hist" aria-hidden="true">${bins.map((b) => `<span data-cssv="${_cssv({ '--h': (b.n / most * 100).toFixed(1) + '%' })}"></span>`).join('')}</div><div class="ak-ends" aria-hidden="true"><span>${esc(_akN(c.min, 4))}</span><span>${esc(_akN(c.max, 4))}</span></div>` : '')
        + (av !== null ? `<p class="ak-meta"><b>${esc(_aF('average', _akN(av, 2) + u))}</b>${lo !== null ? ' · ' + esc(_aF('lowest', _akN(lo, 4))) : ''}${hi !== null ? ' · ' + esc(_aF('highest', _akN(hi, 4))) : ''}</p>` : '')
        + (right !== null ? `<p class="ak-reveal"><span class="ak-right">${_akIc('check', 14)}</span><span>${_aT('correct')}</span> <b>${esc(_akN(right, 4) + u)}</b></p>` : '');
      break;
    }
    case 'grid': {
      const c = _akCfgG(q.config), pts = _akO(r.pts) || {};
      const dots = c.options.map((o, i) => { const x = _akNum(_akL(pts[o.id])[0]), y = _akNum(_akL(pts[o.id])[1]); return x === null || y === null ? '' : `<span class="ak-gm set" data-cssv="${_cssv({ '--x': (_akClamp(x, 0, c.max) / c.max * 100).toFixed(2) + '%', '--y': (_akClamp(y, 0, c.max) / c.max * 100).toFixed(2) + '%' })}">${i + 1}</span>`; }).join('');
      body = `<div class="ak-grid" aria-hidden="true"><span class="ak-grid-y" dir="auto">${esc(c.y || _aT('axisY'))}</span><div class="ak-grid-a still">${dots}</div><span class="ak-grid-x" dir="auto">${esc(c.x || _aT('axisX'))}</span></div><ol class="ak-glegend">${c.options.map((o) => { const x = _akNum(_akL(pts[o.id])[0]), y = _akNum(_akL(pts[o.id])[1]); return `<li dir="auto">${esc(_akOt(o))}${x !== null && y !== null ? ` <span class="ak-meta"><bdi>${esc(_akN(x, 1))}, ${esc(_akN(y, 1))}</bdi></span>` : ''}</li>`; }).join('')}</ol>`;
      break;
    }
    case 'pin': {
      if (!q.image) break;
      const pins = _akL(r.pins).map((p) => [_akNum(_akL(p)[0]), _akNum(_akL(p)[1])]).filter(([x, y]) => x !== null && y !== null && x >= 0 && x <= 1 && y >= 0 && y <= 1).slice(0, 400);
      const target = _akTarget(r.correct) || (q.reveal ? _akTarget(q.config.correct) : null), own = _akSentPin(sent && sent.value);
      body = `<div class="ak-pin"><img src="${esc(q.image)}" alt="" loading="lazy" decoding="async">${target ? `<span class="ak-ring" aria-hidden="true" data-cssv="${_cssv({ '--x': (target.x * 100) + '%', '--y': (target.y * 100) + '%', '--r': (target.r * 200) + '%' })}"></span>` : ''}${pins.map(([x, y]) => `<span class="ak-pd" aria-hidden="true" data-cssv="${_cssv({ '--x': (x * 100).toFixed(1) + '%', '--y': (y * 100).toFixed(1) + '%' })}"></span>`).join('')}${own ? `<span class="ak-pm" aria-hidden="true" data-cssv="${_cssv({ '--x': (own.x * 100) + '%', '--y': (own.y * 100) + '%' })}"></span>` : ''}</div>`;
      break;
    }
    case 'quiz_text': {
      const right = _akClamp(_akInt(r.right) || 0, 0, n), acc = _akL(r.correct).filter((x) => typeof x === 'string' && x.trim());
      body = `<p class="ak-meta">${esc(_aF('gotRight', right, n))}</p>${acc.length ? `<p class="ak-reveal"><span class="ak-right">${_akIc('check', 14)}</span><span>${_aT('correct')}</span> <b dir="auto">${esc(acc.join(' · '))}</b></p>` : ''}`;
      break;
    }
    default: break; // a form: its count alone
  }
  // as on the website: with no answer yet, only that line
  return `<div class="ak-res" data-kind="${esc(q.kind)}">${_akTotal(n)}${n > 0 ? body : ''}</div>`;
}

window._akPaint = _akPaint;
window._akStop = _akStop;
