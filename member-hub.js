// The Community tab (members only), rebuilt 2026-11-11 (reports/Booking app Community tab.md, M1-M33; the user: "do them
// all"). One feed, no sub-menu: the member's next session (or the next one they can book), what is coming up, the year in
// December and January, their own monthly challenge (made by the database, the level theirs to pick), a staff season
// challenge, the club's monthly goal with the member's own share, the club's numbers (totals of 10 or more only), one staff
// card (the Saturday report, else the news, else the tip of the week), a call for volunteers when one is open, and the
// invitation. Members see nothing of each other (2026-11-04): every number here is the member's own or the club's total.
// Everything comes from one read (hub_feed, migration 20261111100000), kept on the phone so the tab paints at once.
// A file of its own, loaded only on this tab (_hubLoad in app.src.html), with its own words in all ten languages.
// Hand-written, not generated; the build stamps its address (HUB_V).
/* global S, sb, esc, _on, getSession, _cssv, shortDate, t, _cuIc, sessionTime, _dayWord, _evName, _evOf, _evKindName, allSessions,
   _isCommunity, _sessPastDay, _bwOpen, _sessFull, _sgOk, _sgChip, _myRideGroups, _sessGet, getQueue, setCustTab, _locale,
   _mrBadgeList, _mrBadgeInfo, _rideKind, _skelHtml, _bdgMedal, toast */
const HUB_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const HUB_T = {
  err: ['We could not do that. Please try again.', 'تعذّر ذلك. يرجى المحاولة مرة أخرى.', 'Action impossible. Veuillez réessayer.', 'No se pudo hacer. Inténtalo de nuevo.', 'Não foi possível. Tente novamente.', 'یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔', 'यह नहीं हो सका। फिर कोशिश करें।', 'Hindi ito nagawa. Pakisubukang muli.', 'यो हुन सकेन। फेरि प्रयास गर्नुहोस्।', 'এটি করা যায়নি। আবার চেষ্টা করুন।'],
  retry: ['Try again', 'حاول مرة أخرى', 'Réessayer', 'Reintentar', 'Tentar novamente', 'دوبارہ کوشش کریں', 'फिर कोशिश करें', 'Subukang muli', 'फेरि प्रयास गर्नुहोस्', 'আবার চেষ্টা করুন'],
  stale: ['Couldn’t refresh', 'تعذّر التحديث', 'Actualisation impossible', 'No se pudo actualizar', 'Não foi possível atualizar', 'تازہ نہیں ہو سکا', 'रीफ़्रेश नहीं हो सका', 'Hindi ma-refresh', 'रिफ्रेस गर्न सकिएन', 'রিফ্রেশ করা যায়নি'],
  next: ['Your next session', 'جلستك القادمة', 'Votre prochaine séance', 'Tu próxima sesión', 'A sua próxima sessão', 'آپ کا اگلا سیشن', 'आपका अगला सत्र', 'Ang susunod mong session', 'तपाईंको अर्को सत्र', 'আপনার পরের সেশন'],
  nextOpen: ['Next session to book', 'الجلسة القادمة المتاحة للحجز', 'Prochaine séance à réserver', 'Próxima sesión para reservar', 'Próxima sessão para reservar', 'بکنگ کے لیے اگلا سیشن', 'बुक करने के लिए अगला सत्र', 'Susunod na session na mabu-book', 'बुक गर्न अर्को सत्र', 'বুক করার পরের সেশন'],
  ticket: ['Show ticket', 'عرض التذكرة', 'Voir le billet', 'Ver el billete', 'Ver o bilhete', 'ٹکٹ دکھائیں', 'टिकट दिखाएँ', 'Ipakita ang tiket', 'टिकट देखाउनुहोस्', 'টিকিট দেখান'],
  book: ['Book', 'احجز', 'Réserver', 'Reservar', 'Reservar', 'بک کریں', 'बुक करें', 'Mag-book', 'बुक गर्नुहोस्', 'বুক করুন'],
  wl: ['On the waitlist', 'في قائمة الانتظار', 'En liste d’attente', 'En lista de espera', 'Na lista de espera', 'انتظار کی فہرست میں', 'प्रतीक्षा सूची में', 'Nasa waitlist', 'प्रतीक्षा सूचीमा', 'অপেক্ষার তালিকায়'],
  noneOpen: ['No session is open to book right now', 'لا توجد جلسة متاحة للحجز الآن', 'Aucune séance ouverte à la réservation pour le moment', 'Ahora no hay ninguna sesión abierta para reservar', 'De momento não há nenhuma sessão aberta para reservar', 'ابھی بکنگ کے لیے کوئی سیشن کھلا نہیں', 'अभी बुकिंग के लिए कोई सत्र खुला नहीं है', 'Walang bukas na session na mabu-book ngayon', 'अहिले बुक गर्न कुनै सत्र खुला छैन', 'এখন বুক করার মতো কোনো সেশন খোলা নেই'],
  seeAll: ['See all sessions', 'عرض كل الجلسات', 'Voir toutes les séances', 'Ver todas las sesiones', 'Ver todas as sessões', 'تمام سیشن دیکھیں', 'सभी सत्र देखें', 'Tingnan ang lahat ng session', 'सबै सत्र हेर्नुहोस्', 'সব সেশন দেখুন'],
  soon: ['Coming up', 'قريبًا', 'À venir', 'Próximamente', 'Em breve', 'آنے والے', 'आने वाले', 'Paparating', 'आउँदै गरेका', 'আসছে'],
  goalYou: ['Your challenge', 'تحديك', 'Votre défi', 'Tu reto', 'O seu desafio', 'آپ کا چیلنج', 'आपकी चुनौती', 'Hamon mo', 'तपाईंको चुनौती', 'আপনার চ্যালেঞ্জ'],
  chFirst: ['Your first session', 'جلستك الأولى', 'Votre première séance', 'Tu primera sesión', 'A sua primeira sessão', 'آپ کا پہلا سیشن', 'आपका पहला सत्र', 'Ang una mong session', 'तपाईंको पहिलो सत्र', 'আপনার প্রথম সেশন'],
  chSecond: ['Your second session', 'جلستك الثانية', 'Votre deuxième séance', 'Tu segunda sesión', 'A sua segunda sessão', 'آپ کا دوسرا سیشن', 'आपका दूसरा सत्र', 'Ang ikalawa mong session', 'तपाईंको दोस्रो सत्र', 'আপনার দ্বিতীয় সেশন'],
  chBack: ['Back this month', 'عُد هذا الشهر', 'De retour ce mois-ci', 'De vuelta este mes', 'De volta este mês', 'اس مہینے واپس آئیں', 'इस महीने वापसी', 'Bumalik ngayong buwan', 'यो महिना फर्कनुहोस्', 'এই মাসে ফিরে আসুন'],
  chLevel: ['{0} sessions this month', '{0} جلسات هذا الشهر', '{0} séances ce mois-ci', '{0} sesiones este mes', '{0} sessões este mês', 'اس مہینے {0} سیشن', 'इस महीने {0} सत्र', '{0} session ngayong buwan', 'यो महिना {0} सत्र', 'এই মাসে {0}টি সেশন'],
  chPick: ['Pick your challenge', 'اختر تحديك', 'Choisissez votre défi', 'Elige tu reto', 'Escolha o seu desafio', 'اپنا چیلنج چنیں', 'अपनी चुनौती चुनें', 'Piliin ang hamon mo', 'आफ्नो चुनौती छान्नुहोस्', 'আপনার চ্যালেঞ্জ বেছে নিন'],
  goalOf: ['{0} of {1}, until {2}', '{0} من {1}، حتى {2}', '{0} sur {1}, jusqu’au {2}', '{0} de {1}, hasta el {2}', '{0} de {1}, até {2}', '{1} میں سے {0}، {2} تک', '{1} में से {0}, {2} तक', '{0} sa {1}, hanggang {2}', '{1} मध्ये {0}, {2} सम्म', '{1}টির মধ্যে {0}টি, {2} পর্যন্ত'],
  goalDone: ['Done', 'تم', 'Terminé', 'Hecho', 'Concluído', 'مکمل', 'पूरा', 'Tapos na', 'पूरा भयो', 'সম্পন্ন'],
  season: ['Season challenge', 'تحدي الموسم', 'Défi de la saison', 'Reto de temporada', 'Desafio da época', 'سیزن کا چیلنج', 'सीज़न की चुनौती', 'Hamon ng season', 'मौसमको चुनौती', 'মৌসুমের চ্যালেঞ্জ'],
  goalAll: ['Community goal', 'هدف المجتمع', 'Objectif de la communauté', 'Meta de la comunidad', 'Objetivo da comunidade', 'کمیونٹی کا ہدف', 'समुदाय का लक्ष्य', 'Layunin ng komunidad', 'समुदायको लक्ष्य', 'কমিউনিটির লক্ষ্য'],
  clubSat: ['{0} Saturday rides this month', '{0} رحلة سبت هذا الشهر', '{0} sorties du samedi ce mois-ci', '{0} salidas de sábado este mes', '{0} passeios de sábado este mês', 'اس مہینے ہفتے کی {0} سواریاں', 'इस महीने {0} शनिवार राइड', '{0} Saturday ride ngayong buwan', 'यो महिना {0} शनिबारे राइड', 'এই মাসে শনিবারের {0}টি রাইড'],
  soFar: ['{0} so far, until {1}', '{0} حتى الآن، حتى {1}', '{0} pour l’instant, jusqu’au {1}', '{0} hasta ahora, hasta el {1}', '{0} até agora, até {1}', 'اب تک {0}، {1} تک', 'अब तक {0}, {1} तक', '{0} sa ngayon, hanggang {1}', 'अहिलेसम्म {0}, {1} सम्म', 'এখন পর্যন্ত {0}, {1} পর্যন্ত'],
  toGo: ['{0} to go, until {1}', 'بقي {0}، حتى {1}', 'Encore {0}, jusqu’au {1}', 'Faltan {0}, hasta el {1}', 'Faltam {0}, até {1}', '{0} باقی، {1} تک', '{0} बाकी, {1} तक', '{0} pa, hanggang {1}', '{0} बाँकी, {1} सम्म', 'আর {0}, {1} পর্যন্ত'],
  clubYou: ['You: {0} of them', 'أنت: {0} منها', 'Vous : {0} d’entre elles', 'Tú: {0} de ellas', 'Você: {0} delas', 'آپ: ان میں سے {0}', 'आप: इनमें से {0}', 'Ikaw: {0} rito', 'तपाईं: तीमध्ये {0}', 'আপনি: এর মধ্যে {0}টি'],
  clubHit: ['The club reached it', 'حقّق النادي الهدف', 'Le club l’a atteint', 'El club lo logró', 'O clube conseguiu', 'کلب نے ہدف حاصل کر لیا', 'क्लब ने लक्ष्य पा लिया', 'Naabot ito ng club', 'क्लबले लक्ष्य पूरा गर्‍यो', 'ক্লাব লক্ষ্যে পৌঁছেছে'],
  nums: ['The club in numbers', 'النادي بالأرقام', 'Le club en chiffres', 'El club en cifras', 'O clube em números', 'کلب اعداد میں', 'आँकड़ों में क्लब', 'Ang club sa mga numero', 'अङ्कमा क्लब', 'সংখ্যায় ক্লাব'],
  numLast: ['Riders last Saturday', 'راكبو السبت الماضي', 'Cyclistes samedi dernier', 'Ciclistas el sábado pasado', 'Ciclistas no sábado passado', 'پچھلے ہفتے کے سوار', 'पिछले शनिवार के राइडर', 'Rider noong nakaraang Sabado', 'गत शनिबारका राइडर', 'গত শনিবারের রাইডার'],
  numMonth: ['Saturday rides this month', 'رحلات السبت هذا الشهر', 'Sorties du samedi ce mois-ci', 'Salidas de sábado este mes', 'Passeios de sábado este mês', 'اس مہینے ہفتے کی سواریاں', 'इस महीने शनिवार राइड', 'Saturday ride ngayong buwan', 'यो महिना शनिबारे राइड', 'এই মাসে শনিবারের রাইড'],
  numAll: ['Saturday rides since {0}', 'رحلات السبت منذ {0}', 'Sorties du samedi depuis {0}', 'Salidas de sábado desde {0}', 'Passeios de sábado desde {0}', '{0} سے ہفتے کی سواریاں', '{0} से शनिवार राइड', 'Saturday ride mula {0}', '{0} देखि शनिबारे राइड', '{0} থেকে শনিবারের রাইড'],
  report: ['Saturday report', 'تقرير السبت', 'Le samedi en bref', 'Crónica del sábado', 'Resumo de sábado', 'ہفتے کی رپورٹ', 'शनिवार की रिपोर्ट', 'Ulat ng Sabado', 'शनिबारको रिपोर्ट', 'শনিবারের প্রতিবেদন'],
  riders: ['{0} riders', '{0} راكبًا', '{0} cyclistes', '{0} ciclistas', '{0} ciclistas', '{0} سوار', '{0} राइडर', '{0} rider', '{0} राइडर', '{0} জন রাইডার'],
  news: ['News', 'أخبار', 'Actualités', 'Novedades', 'Novidades', 'خبریں', 'समाचार', 'Balita', 'समाचार', 'খবর'],
  tip: ['Tip of the week', 'نصيحة الأسبوع', 'Conseil de la semaine', 'Consejo de la semana', 'Dica da semana', 'ہفتے کا مشورہ', 'हफ़्ते की सलाह', 'Tip ng linggo', 'हप्ताको सुझाव', 'সপ্তাহের পরামর্শ'],
  vol: ['Volunteers needed', 'نحتاج متطوعين', 'Bénévoles recherchés', 'Se buscan voluntarios', 'Procuram-se voluntários', 'رضاکاروں کی ضرورت ہے', 'स्वयंसेवकों की ज़रूरत है', 'Kailangan ng mga volunteer', 'स्वयंसेवक चाहिएको छ', 'স্বেচ্ছাসেবক প্রয়োজন'],
  volBtn: ['Volunteer', 'تطوّع', 'Je me propose', 'Quiero ayudar', 'Quero ajudar', 'رضاکار بنیں', 'स्वयंसेवा करें', 'Mag-volunteer', 'स्वयंसेवा गर्नुहोस्', 'স্বেচ্ছাসেবক হন'],
  bday: ['Happy birthday, {0}!', 'كل عام وأنت بخير يا {0}!', 'Joyeux anniversaire, {0} !', '¡Feliz cumpleaños, {0}!', 'Feliz aniversário, {0}!', 'سالگرہ مبارک، {0}!', 'जन्मदिन मुबारक, {0}!', 'Maligayang kaarawan, {0}!', 'जन्मदिनको शुभकामना, {0}!', 'শুভ জন্মদিন, {0}!'],
  yrTitle: ['Your {0} with MicroMobility', 'عامك {0} مع مايكروموبيليتي', 'Votre année {0} avec MicroMobility', 'Tu {0} con MicroMobility', 'O seu {0} com a MicroMobility', 'MicroMobility کے ساتھ آپ کا {0}', 'MicroMobility के साथ आपका {0}', 'Ang {0} mo kasama ang MicroMobility', 'MicroMobility सँग तपाईंको {0}', 'MicroMobility-র সাথে আপনার {0}'],
  yrSoFar: ['Your year so far', 'عامك حتى الآن', 'Votre année jusqu’ici', 'Tu año hasta ahora', 'O seu ano até agora', 'اب تک آپ کا سال', 'अब तक आपका साल', 'Ang taon mo sa ngayon', 'अहिलेसम्मको तपाईंको वर्ष', 'এ পর্যন্ত আপনার বছর'],
  yrOpen: ['See your year', 'شاهد عامك', 'Voir votre année', 'Ver tu año', 'Ver o seu ano', 'اپنا سال دیکھیں', 'अपना साल देखें', 'Tingnan ang taon mo', 'आफ्नो वर्ष हेर्नुहोस्', 'আপনার বছর দেখুন'],
  yrRange: ['{0} to December', 'من {0} إلى ديسمبر', 'De {0} à décembre', 'De {0} a diciembre', 'De {0} a dezembro', '{0} سے دسمبر تک', '{0} से दिसंबर तक', '{0} hanggang Disyembre', '{0} देखि डिसेम्बरसम्म', '{0} থেকে ডিসেম্বর'],
  yrSince: ['With us since {0}', 'معنا منذ {0}', 'Avec nous depuis le {0}', 'Con nosotros desde el {0}', 'Connosco desde {0}', '{0} سے ہمارے ساتھ', '{0} से हमारे साथ', 'Kasama namin mula {0}', '{0} देखि हामीसँग', '{0} থেকে আমাদের সাথে'],
  yrSessions: ['Sessions', 'الأنشطة', 'Sessions', 'Sesiones', 'Sessões', 'سیشن', 'सत्र', 'Mga session', 'सत्र', 'সেশন'],
  yrSatOf: ['{0} of {1} Saturdays', '{0} من {1} أيام سبت', '{0} samedis sur {1}', '{0} de {1} sábados', '{0} de {1} sábados', '{1} میں سے {0} ہفتے', '{1} में से {0} शनिवार', '{0} sa {1} Sabado', '{1} मध्ये {0} शनिबार', '{1}টির মধ্যে {0}টি শনিবার'],
  yrKinds: ['What you tried', 'ما جرّبته', 'Ce que vous avez essayé', 'Lo que probaste', 'O que experimentou', 'آپ نے کیا آزمایا', 'आपने क्या आज़माया', 'Ang mga sinubukan mo', 'तपाईंले के प्रयास गर्नुभयो', 'আপনি যা চেষ্টা করেছেন'],
  yrBusiest: ['Your busiest month', 'أكثر شهر نشاطًا لك', 'Votre mois le plus actif', 'Tu mes más activo', 'O seu mês mais ativo', 'آپ کا مصروف ترین مہینہ', 'आपका सबसे व्यस्त महीना', 'Pinakaabala mong buwan', 'तपाईंको सबैभन्दा व्यस्त महिना', 'আপনার সবচেয়ে সক্রিয় মাস'],
  yrBadges: ['Badges this year', 'شارات هذا العام', 'Badges cette année', 'Insignias este año', 'Emblemas este ano', 'اس سال کے بیج', 'इस साल के बैज', 'Mga badge ngayong taon', 'यस वर्षका ब्याज', 'এ বছরের ব্যাজ'],
  yrShareOf: ['{0} of the club’s {1} sessions', '{0} من {1} جلسة للنادي', '{0} des {1} séances du club', '{0} de las {1} sesiones del club', '{0} das {1} sessões do clube', 'کلب کے {1} سیشنز میں سے {0}', 'क्लब के {1} सत्रों में से {0}', '{0} sa {1} session ng club', 'क्लबका {1} सत्रमध्ये {0}', 'ক্লাবের {1}টি সেশনের মধ্যে {0}টি'],
  yrFirstOnly: ['Your first session: {0}', 'جلستك الأولى: {0}', 'Votre première séance : {0}', 'Tu primera sesión: {0}', 'A sua primeira sessão: {0}', 'آپ کا پہلا سیشن: {0}', 'आपका पहला सत्र: {0}', 'Ang una mong session: {0}', 'तपाईंको पहिलो सत्र: {0}', 'আপনার প্রথম সেশন: {0}'],
  yrNext: ['Your next challenge is ready', 'تحديك القادم جاهز', 'Votre prochain défi est prêt', 'Tu próximo reto está listo', 'O seu próximo desafio está pronto', 'آپ کا اگلا چیلنج تیار ہے', 'आपकी अगली चुनौती तैयार है', 'Handa na ang susunod mong hamon', 'तपाईंको अर्को चुनौती तयार छ', 'আপনার পরের চ্যালেঞ্জ প্রস্তুত'],
  yrShare: ['Share my year', 'شارك عامي', 'Partager mon année', 'Compartir mi año', 'Partilhar o meu ano', 'میرا سال شیئر کریں', 'मेरा साल साझा करें', 'Ibahagi ang taon ko', 'मेरो वर्ष साझा गर्नुहोस्', 'আমার বছর শেয়ার করুন'],
  yrMy: ['My {0} with MicroMobility', 'عامي {0} مع مايكروموبيليتي', 'Mon année {0} avec MicroMobility', 'Mi {0} con MicroMobility', 'O meu {0} com a MicroMobility', 'MicroMobility کے ساتھ میرا {0}', 'MicroMobility के साथ मेरा {0}', 'Ang {0} ko kasama ang MicroMobility', 'MicroMobility सँग मेरो {0}', 'MicroMobility-র সাথে আমার {0}'],
  yrShareMsg: ['My {0} with MicroMobility: {1} sessions, {2} Saturday rides.', 'عامي {0} مع مايكروموبيليتي: {1} نشاط، {2} رحلة سبت.', 'Mon année {0} avec MicroMobility : {1} sessions, {2} sorties du samedi.', 'Mi {0} con MicroMobility: {1} sesiones, {2} salidas de sábado.', 'O meu {0} com a MicroMobility: {1} sessões, {2} passeios de sábado.', 'MicroMobility کے ساتھ میرا {0}: {1} سیشن، ہفتے کی {2} سواریاں۔', 'MicroMobility के साथ मेरा {0}: {1} सत्र, {2} शनिवार राइड।', 'Ang {0} ko kasama ang MicroMobility: {1} session, {2} Saturday ride.', 'MicroMobility सँग मेरो {0}: {1} सत्र, {2} शनिबारे राइड।', 'MicroMobility-র সাথে আমার {0}: {1}টি সেশন, শনিবারের {2}টি রাইড।'],
  prev: ['Previous', 'السابق', 'Précédent', 'Anterior', 'Anterior', 'پچھلا', 'पिछला', 'Nakaraan', 'अघिल्लो', 'আগের'],
  nextB: ['Next', 'التالي', 'Suivant', 'Siguiente', 'Seguinte', 'اگلا', 'अगला', 'Susunod', 'अर्को', 'পরের'],
  close: ['Close', 'إغلاق', 'Fermer', 'Cerrar', 'Fechar', 'بند کریں', 'बंद करें', 'Isara', 'बन्द गर्नुहोस्', 'বন্ধ করুন'],
  tip0: ['Arrive by the gathering time: the ride starts on time.', 'احضر في وقت التجمع، فالرحلة تنطلق في موعدها.', 'Arrivez à l’heure du rassemblement : le départ est à l’heure.', 'Llega a la hora de encuentro: la salida es puntual.', 'Chegue à hora do encontro: a partida é pontual.', 'جمع ہونے کے وقت تک پہنچیں، سواری وقت پر شروع ہوتی ہے۔', 'इकट्ठा होने के समय तक पहुँचें: राइड समय पर शुरू होती है।', 'Dumating bago ang oras ng pagtitipon: nagsisimula sa oras ang ride.', 'भेला हुने समयसम्म आइपुग्नुहोस्: राइड समयमै सुरु हुन्छ।', 'জমায়েতের সময়ের মধ্যে পৌঁছান: রাইড ঠিক সময়ে শুরু হয়।'],
  tip1: ['First time? Tell the ride leader.', 'أول مرة؟ أخبر قائد الرحلة.', 'Première fois ? Dites-le au responsable de la sortie.', '¿Primera vez? Avisa al guía de la salida.', 'Primeira vez? Avise o líder do passeio.', 'پہلی بار؟ رائیڈ لیڈر کو بتائیں۔', 'पहली बार? राइड लीडर को बताएँ।', 'Unang beses? Sabihin sa ride leader.', 'पहिलो पटक? राइड लिडरलाई भन्नुहोस्।', 'প্রথমবার? রাইড লিডারকে জানান।'],
  tip2: ['Bring water, even on a cool morning.', 'أحضر الماء حتى في الصباح البارد.', 'Prenez de l’eau, même par une matinée fraîche.', 'Lleva agua, incluso en una mañana fresca.', 'Leve água, mesmo numa manhã fresca.', 'ٹھنڈی صبح میں بھی پانی ساتھ رکھیں۔', 'ठंडी सुबह में भी पानी साथ रखें।', 'Magdala ng tubig, kahit malamig ang umaga.', 'चिसो बिहानमा पनि पानी लिनुहोस्।', 'ঠান্ডা সকালেও পানি সঙ্গে রাখুন।'],
  tip3: ['A helmet comes with every bike. Keep it fastened.', 'تأتي خوذة مع كل دراجة. أبقها مربوطة.', 'Un casque est fourni avec chaque vélo. Gardez-le attaché.', 'Cada bici viene con casco. Llévalo abrochado.', 'Cada bicicleta vem com capacete. Mantenha-o apertado.', 'ہر سائیکل کے ساتھ ہیلمٹ ملتا ہے۔ اسے بند رکھیں۔', 'हर साइकिल के साथ हेलमेट मिलता है। इसे बंधा रखें।', 'May kasamang helmet ang bawat bike. Panatilihin itong nakakabit.', 'हरेक साइकलसँग हेलमेट आउँछ। यसलाई बाँधेर राख्नुहोस्।', 'প্রতিটি সাইকেলের সাথে হেলমেট থাকে। এটি আটকে রাখুন।'],
  tip4: ['Riding your own bike? Check the tyres before you leave home.', 'تركب دراجتك؟ افحص الإطارات قبل أن تخرج من المنزل.', 'Vous venez avec votre vélo ? Vérifiez les pneus avant de partir.', '¿Vienes con tu bici? Revisa las ruedas antes de salir de casa.', 'Vem com a sua bicicleta? Verifique os pneus antes de sair de casa.', 'اپنی سائیکل لا رہے ہیں؟ گھر سے نکلنے سے پہلے ٹائر چیک کریں۔', 'अपनी साइकिल ला रहे हैं? घर से निकलने से पहले टायर जाँचें।', 'Sariling bike ang dala? Tingnan ang gulong bago umalis ng bahay.', 'आफ्नै साइकल? घरबाट निस्कनुअघि टायर जाँच्नुहोस्।', 'নিজের সাইকেল আনছেন? বাড়ি থেকে বের হওয়ার আগে টায়ার দেখে নিন।'],
  tip5: ['Keep a bike length from the rider in front.', 'حافظ على مسافة دراجة عن الراكب أمامك.', 'Gardez une longueur de vélo avec le cycliste devant vous.', 'Deja el largo de una bici con quien va delante.', 'Mantenha o comprimento de uma bicicleta do ciclista da frente.', 'آگے والے سوار سے ایک سائیکل جتنا فاصلہ رکھیں۔', 'आगे वाले राइडर से एक साइकिल जितनी दूरी रखें।', 'Panatilihin ang layong isang bike mula sa rider sa unahan.', 'अगाडिको राइडरबाट एउटा साइकल बराबर दूरी राख्नुहोस्।', 'সামনের রাইডার থেকে এক সাইকেল দূরত্ব রাখুন।'],
  tip6: ['Say “stopping” before you brake in a group.', 'قل «توقف» قبل أن تضغط الفرامل في المجموعة.', 'Dites « stop » avant de freiner en groupe.', 'Avisa «paro» antes de frenar en grupo.', 'Diga «a parar» antes de travar em grupo.', 'گروپ میں بریک لگانے سے پہلے «رک رہا ہوں» کہیں۔', 'ग्रुप में ब्रेक लगाने से पहले «रुक रहा हूँ» कहें।', 'Sabihing “hihinto” bago magpreno sa grupo.', 'समूहमा ब्रेक लगाउनुअघि «रोकिँदै» भन्नुहोस्।', 'দলে ব্রেক করার আগে «থামছি» বলুন।'],
  tip7: ['Eat something light an hour before you ride.', 'تناول شيئًا خفيفًا قبل الرحلة بساعة.', 'Mangez léger une heure avant de rouler.', 'Come algo ligero una hora antes de salir.', 'Coma algo leve uma hora antes de pedalar.', 'سواری سے ایک گھنٹہ پہلے کچھ ہلکا کھائیں۔', 'राइड से एक घंटा पहले कुछ हल्का खाएँ।', 'Kumain ng magaan isang oras bago mag-ride.', 'राइडभन्दा एक घण्टाअघि हल्का केही खानुहोस्।', 'রাইডের এক ঘণ্টা আগে হালকা কিছু খান।'],
  tip8: ['Can’t come? Cancel your booking so someone else gets the place.', 'لن تحضر؟ ألغِ حجزك ليحصل غيرك على المكان.', 'Vous ne venez pas ? Annulez pour libérer la place.', '¿No puedes venir? Cancela tu reserva para que otra persona tenga la plaza.', 'Não pode vir? Cancele a reserva para outra pessoa ficar com o lugar.', 'نہیں آ سکتے؟ بکنگ منسوخ کریں تاکہ جگہ کسی اور کو مل جائے۔', 'नहीं आ सकते? बुकिंग रद्द करें ताकि जगह किसी और को मिले।', 'Hindi makakarating? I-cancel ang booking para may iba na makakuha ng puwesto.', 'आउन सक्नुहुन्न? बुकिङ रद्द गर्नुहोस् ताकि अरूले ठाउँ पाऊन्।', 'আসতে পারবেন না? বুকিং বাতিল করুন যাতে অন্য কেউ জায়গা পায়।'],
  tip9: ['Sunscreen and sunglasses help, even early in the day.', 'واقي الشمس والنظارة الشمسية مفيدان حتى في الصباح الباكر.', 'Crème solaire et lunettes de soleil aident, même tôt le matin.', 'Protector solar y gafas de sol ayudan, incluso temprano.', 'Protetor solar e óculos de sol ajudam, mesmo cedo.', 'صبح سویرے بھی سن اسکرین اور دھوپ کا چشمہ مفید ہیں۔', 'सुबह जल्दी भी सनस्क्रीन और धूप का चश्मा काम आते हैं।', 'Makakatulong ang sunscreen at sunglasses, kahit maaga pa.', 'बिहान सबेरै पनि सनस्क्रिन र सनग्लास काम लाग्छन्।', 'ভোরেও সানস্ক্রিন আর সানগ্লাস কাজে লাগে।'],
  tip10: ['Keep right on the path and pass on the left.', 'التزم يمين المسار وتجاوز من اليسار.', 'Restez à droite et dépassez par la gauche.', 'Mantente a la derecha y adelanta por la izquierda.', 'Mantenha-se à direita e ultrapasse pela esquerda.', 'راستے کے دائیں رہیں اور بائیں سے آگے نکلیں۔', 'रास्ते के दाईं ओर रहें और बाईं ओर से आगे निकलें।', 'Manatili sa kanan at sa kaliwa dumaan kapag mag-o-overtake.', 'बाटोको दायाँ रहनुहोस् र बायाँबाट उछिन्नुहोस्।', 'পথের ডান দিকে থাকুন, বাঁ দিক দিয়ে পার হন।'],
  tip11: ['Ride with a friend: you can invite one from this page.', 'اركب مع صديق: يمكنك دعوته من هذه الصفحة.', 'Roulez avec un ami : invitez-le depuis cette page.', 'Sal con un amigo: puedes invitarlo desde esta página.', 'Pedale com um amigo: pode convidá-lo a partir desta página.', 'کسی دوست کے ساتھ سواری کریں: اس صفحے سے دعوت دیں۔', 'किसी दोस्त के साथ राइड करें: इस पेज से न्योता भेजें।', 'Mag-ride kasama ang kaibigan: maaari mo siyang imbitahan mula rito.', 'साथीसँग राइड गर्नुहोस्: यही पृष्ठबाट निम्तो पठाउनुहोस्।', 'বন্ধুর সাথে রাইড করুন: এই পাতা থেকে আমন্ত্রণ পাঠান।'],
};
const HUB_TIPS = 12;
function _hT(k) {
  const row = HUB_T[k] || [''], i = HUB_LANGS.indexOf(S.lang);
  return row[i < 0 ? 0 : i] || row[0];
}
function _hF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _hT(k)); }
function _hPick(x, en, ar) { return String((x && ((S.lang === 'ar' && x[ar]) || x[en])) || ''); }
function _hCust() { return S.loggedIn || getSession(); }
function _hDate(d) { const s = String(d || '').slice(0, 10); return /^\d{4}-\d\d-\d\d$/.test(s) ? shortDate(s) : ''; }
function _hTok(c) { return { p_id: c.id, p_token: c.session_token }; }
function _hN(n) { return `<bdi>${esc(String(Number(n) || 0))}</bdi>`; }
function _hMonth(ym, withYear) { // "2026-10" -> "October" (or "October 2026") in the page's language
  try { return new Intl.DateTimeFormat(_locale(), { month: 'long', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' }).format(new Date(ym.slice(0, 7) + '-15T00:00:00Z')); } catch (_) { return ym.slice(0, 7); }
}

// ── The read: one call, kept on the phone ───────────────────────────────────────────────────────
// The last answer is kept per account (without the badges just given) so the tab paints at once next time; a fresh read
// follows when the copy is older than two minutes. A failed read keeps the copy and says so in one card.
const _HUB_KEY = 'cq_hub_';
function _hubDisk(c) { try { const x = JSON.parse(localStorage.getItem(_HUB_KEY + c.id) || 'null'); return x && x.d && x.d.ok ? x : null; } catch (_) { return null; } }
function _hubSave(c, d) { try { localStorage.setItem(_HUB_KEY + c.id, JSON.stringify({ at: Date.now(), d: { ...d, awarded: [] } })); } catch (_) {} }
async function _hubFetch(force) {
  const c = _hCust(); if (!c || !sb || S._hubBusy) return;
  const h = S._hub;
  if (!force && h && h.forId === c.id && h.d && !h.stale && Date.now() - h.at < 12e4) return;
  S._hubBusy = true;
  let r; try { r = await sb.rpc('hub_feed', _hTok(c)); } catch (e) { r = { error: e }; }
  S._hubBusy = false;
  // Signed out, or another account signed in, while it was asked: the answer is not theirs (a shared phone).
  const now = _hCust();
  if (!now || now.id !== c.id) { if (S.custTab === 'members') _hubRender(); return; }
  const d = r && !r.error && r.data;
  if (d && d.ok === false && d.error === 'member') { S._hub = null; try { localStorage.removeItem(_HUB_KEY + c.id); } catch (_) {} if (S.custTab === 'members') setCustTab('register'); return; }
  if (d && d.ok === true) {
    S._hub = { forId: c.id, at: Date.now(), d };
    _hubSave(c, d);
    if (Array.isArray(d.awarded) && d.awarded.length) _hubCheer(d.awarded);
  } else if (h && h.forId === c.id && h.d) h.stale = true;
  else S._hub = { forId: c.id, at: Date.now(), d: null };
  if (S.custTab === 'members') _hubRender();
}
function _hubRetry() { if (S._hub) S._hub.stale = false; _hubRender(); _hubFetch(true); }

// A badge the read just gave: the account's badges are read again and the newest one opens in the app's badge pop-up,
// once (the database gives it once; this device marks it seen so Account does not show it again).
async function _hubCheer(slugs) {
  const c = _hCust(); if (!c) return;
  let r; try { r = await sb.rpc('customer_my_badges', _hTok(c)); } catch (_) { return; }
  if (!r || r.error || !Array.isArray(r.data)) return;
  S._bdgMine = { id: c.id, at: Date.now(), busy: false, list: r.data };
  if (!Array.isArray(S._bdgCat) || !S._bdgCat.length) { try { const k = await sb.rpc('badge_catalog'); if (!k.error && Array.isArray(k.data)) S._bdgCat = k.data; } catch (_) {} }
  const top = slugs[slugs.length - 1], g = r.data.find((x) => x && x.slug === top);
  try { if (g && g.at) localStorage.setItem('cq_bdg_seen_' + c.id, String(Math.max(Date.parse(g.at) || 0, +localStorage.getItem('cq_bdg_seen_' + c.id) || 0))); } catch (_) {}
  if (S.custTab !== 'members' || document.getElementById('badge-pop')) return;
  const L = _mrBadgeList(c), i = L.findIndex((x) => (x.b && x.b.slug === top) || (x.lv && x.lv.some((y) => y.b && y.b.slug === top)));
  if (i >= 0) _mrBadgeInfo(i, true);
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────────
function _hubRender() {
  const body = document.getElementById('hub-body');
  if (!body) return;
  const c = _hCust();
  if (S._hub && (!c || S._hub.forId !== c.id)) S._hub = null;
  if (!S._hub && c) { const disk = _hubDisk(c); if (disk) S._hub = { forId: c.id, at: disk.at, d: disk.d }; }
  const h = S._hub, d = h && h.d;
  if (!h || (d && !h.stale && Date.now() - h.at >= 12e4)) _hubFetch();
  // Keep the focused control across a repaint (a pick, a slide), found again by what it does.
  const was = document.activeElement && body.contains(document.activeElement) ? document.activeElement.getAttribute('data-on-click') : null;
  if (!d) {
    body.innerHTML = h ? `<div class="hub-card" role="status"><strong class="hub-name">${_hT('err')}</strong><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_hubRetry')}">${_hT('retry')}</button></div>` : _skelHtml(2, 'hub-skel');
    return;
  }
  body.innerHTML = S._hubView === 'year' && d.year ? _yrHtml(d) : _feedHtml(c, d, h.stale);
  if (S._hubView === 'year' && d.year) _yrPrep(d.year);
  if (d.post && d.post.img) _hubPostImg(d.post.id);
  if (was) { const el = [...body.querySelectorAll('[data-on-click]')].find((x) => x.getAttribute('data-on-click') === was); if (el) try { el.focus({ preventScroll: true }); } catch (_) {} }
}

function _hubInvite() { const dep = window._hubDeps || {}; if (dep.inv) dep.inv(); }
function _feedHtml(c, d, stale) {
  const dep = window._hubDeps || {};
  return [
    stale ? `<div class="hub-card hub-stale" role="status"><span>${_hT('stale')}</span><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_hubRetry')}">${_hT('retry')}</button></div>` : '',
    d.birthday ? `<div class="hub-card hub-bday">${_cuIc('gift', 20)}<strong>${esc(_hF('bday', String((c && c.name) || '').trim().split(/\s+/)[0] || ''))}</strong></div>` : '',
    _heroHtml(c),
    d.year ? _yrCardHtml(d.year) : '',
    _soonHtml(c),
    _meHtml(d.me),
    (Array.isArray(d.goals) ? d.goals : []).map(_seasonHtml).join(''),
    d.club ? _clubHtml(d.club) : '',
    _numsHtml(d.numbers),
    _staffHtml(d),
    d.volunteer && dep.vol ? `<div class="hub-card hub-flat"><span class="hub-k">${_cuIc('people', 16)} ${_hT('vol')}</span><a class="btn-secondary hub-wide hub-link" href="${esc(dep.vol + '/#o/' + encodeURIComponent(d.volunteer))}" target="_blank" rel="noopener">${_hT('volBtn')}</a></div>` : '',
    dep.inv ? `<div class="hub-card hub-flat"><button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_hubInvite')}">${esc(dep.invLabel())}</button></div>` : '',
  ].join('');
}

// The member's next session: booked (soonest first, as Bookings lists them), else the next one they may book. Bookings and
// Reserve stay the only places that book: the card opens one of them.
function _hubOpen(c, n, skip) {
  const me = S.loggedIn || c, mine = new Set(getQueue().filter((e) => e.customerId === c.id && e.status !== 'cancelled').map((e) => e.sessionId));
  return allSessions().filter((s) => s && _isCommunity(s) && s.status === 'open' && !_sessPastDay(s) && _bwOpen(s) && !_sessFull(s) && _sgOk(s, me) && !mine.has(s.id) && s.id !== skip)
    .sort((a, b) => String(a.session_date || a.id).localeCompare(String(b.session_date || b.id))).slice(0, n);
}
function _hubWhen(s) { const d = String(s.session_date || s.id).slice(0, 10); return `<bdi>${esc(_dayWord(d) || '')}${_dayWord(d) ? ' · ' : ''}${esc(shortDate(d))}</bdi> · <bdi>${sessionTime(s)}</bdi>`; }
function _heroHtml(c) {
  const g = c ? (_myRideGroups(c).current || [])[0] : null, e = g && g[0], bs = e && _sessGet(e.sessionId);
  if (bs) {
    return `<div class="hub-hero"><span class="hub-k">${_hT('next')}</span><strong class="hub-hero-t"><bdi>${esc(_evName(bs))}</bdi></strong>
      <span class="hub-hero-m">${_hubWhen(bs)}</span>${e.status === 'waitlist' ? `<span class="hub-chip">${_hT('wl')}</span>` : ''}
      <button type="button" class="btn-primary hub-hero-b" data-on-click="${_on('setCustTab', 'myrides')}">${_cuIc('ticket', 18)} ${_hT('ticket')}</button></div>`;
  }
  const s = c ? _hubOpen(c, 1)[0] : null;
  if (s) {
    return `<div class="hub-hero"><span class="hub-k">${_hT('nextOpen')}</span><strong class="hub-hero-t"><bdi>${esc(_evName(s))}</bdi></strong>
      <span class="hub-hero-m">${_hubWhen(s)}</span>${_sgChip(s)}
      <button type="button" class="btn-primary hub-hero-b" data-on-click="${_on('_hubBook', s.id)}">${_hT('book')}</button></div>`;
  }
  return `<div class="hub-hero"><strong class="hub-hero-t">${_hT('noneOpen')}</strong>
    <button type="button" class="btn-primary hub-hero-b" data-on-click="${_on('setCustTab', 'register')}">${_hT('seeAll')}</button></div>`;
}
function _hubBook(id) {
  const s = _sessGet(id); if (!s) { setCustTab('register'); return; }
  S.selEvent = _evOf(s); S.selSession = id; S.regStep = 1; setCustTab('register');
}
function _soonHtml(c) {
  if (!c) return '';
  const g = (_myRideGroups(c).current || [])[0], skip = g ? null : (_hubOpen(c, 1)[0] || {}).id, list = _hubOpen(c, 3, skip).filter((s) => s.id !== skip).slice(0, 3);
  if (!list.length) return '';
  return `<div class="hub-card"><span class="hub-k">${_hT('soon')}</span>${list.map((s) => `<div class="hub-soon">
      <span class="hub-soon-t"><strong><bdi>${esc(_evName(s))}</bdi></strong> ${_sgChip(s)}<small>${_hubWhen(s)}</small></span>
      <button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_hubBook', s.id)}">${_hT('book')}</button></div>`).join('')}</div>`;
}

// Progress: dots for five or fewer, a bar above that; the count always written.
function _hubProg(n, target, label) {
  const v = Math.min(n, target), txt = `${v} / ${target}`;
  if (target <= 5) {
    return `<div class="hub-dots" role="progressbar" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${v}" aria-valuetext="${esc(txt)}" aria-label="${esc(label)}">${Array.from({ length: target }, (_, i) => `<span class="${i < v ? 'on' : ''}"></span>`).join('')}</div>`;
  }
  const pct = Math.min(100, Math.round((v / target) * 100));
  return `<div class="hub-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${v}" aria-valuetext="${esc(txt)}" aria-label="${esc(label)}"><span data-cssv="${_cssv({ '--w': pct + '%' })}"></span></div>`;
}
function _meName(me) {
  return me.kind === 'first' ? _hT('chFirst') : me.kind === 'second' ? _hT('chSecond') : me.kind === 'back' ? _hT('chBack') : _hF('chLevel', me.target);
}
function _meHtml(me) {
  if (!me || !me.kind) return '';
  const n = Number(me.n) || 0, tg = Number(me.target) || 1, done = n >= tg, name = _meName(me);
  const pick = me.kind === 'level' && !me.chosen && !done && Array.isArray(me.levels)
    ? `<div class="hub-pick" role="group" aria-label="${esc(_hT('chPick'))}">${me.levels.map((k) => `<button type="button" class="hub-lv${k === tg ? ' on' : ''}" aria-pressed="${k === tg}" data-on-click="${_on('_hubPick', k)}"><bdi>${esc(String(k))}</bdi></button>`).join('')}</div>`
    : '';
  return `<div class="hub-card"><span class="hub-k">${_cuIc('flag', 16)} ${_hT('goalYou')}</span><strong class="hub-name"><bdi>${esc(name)}</bdi></strong>
    ${pick ? `<span class="hub-k">${_hT('chPick')}</span>${pick}` : ''}
    ${_hubProg(n, tg, name)}<div class="hub-meta">${done ? `<strong>${_hT('goalDone')}</strong> · ` : ''}${esc(_hF('goalOf', Math.min(n, tg), tg, _hDate(me.ends_on)))}</div></div>`;
}
async function _hubPick(k) {
  const c = _hCust(), h = S._hub; if (!c || !h || !h.d || !h.d.me || S._hubPicking) return;
  const was = h.d.me.target; h.d.me.target = k; S._hubPicking = true; _hubRender();
  let r; try { r = await sb.rpc('hub_pick_level', { ..._hTok(c), p_level: k }); } catch (e) { r = { error: e }; }
  S._hubPicking = false;
  if (!r || r.error || !r.data || r.data.ok !== true) { h.d.me.target = was; if (typeof toast === 'function') toast(_hT('err'), 'error'); _hubRender(); return; }
  h.d.me.chosen = true; _hubSave(c, h.d); _hubRender();
}
function _seasonHtml(g) {
  const n = Number(g.n) || 0, tg = Number(g.target) || 1, name = _hPick(g, 'name', 'name_ar');
  const medal = g.badge && typeof _bdgMedal === 'function' ? _bdgMedal(g.badge.icon, g.badge.color, 'hub-medal') : '';
  return `<div class="hub-card"><span class="hub-k">${_hT('season')}</span><div class="hub-row2">${medal}<strong class="hub-name"><bdi>${esc(name)}</bdi></strong></div>
    ${_hubProg(n, tg, name)}<div class="hub-meta">${n >= tg ? `<strong>${_hT('goalDone')}</strong> · ` : ''}${esc(_hF('goalOf', Math.min(n, tg), tg, _hDate(g.ends_on)))}</div></div>`;
}
// The club's goal: "so far" while less than two thirds is done, then what is left; the member's own share only to them.
function _clubHtml(g) {
  const n = Number(g.n) || 0, tg = Number(g.target) || 1, name = g.name ? _hPick(g, 'name', 'name_ar') : _hF('clubSat', tg), hit = n >= tg;
  const line = hit ? `<strong>${_hT('clubHit')}</strong>` : esc(n / tg < 2 / 3 ? _hF('soFar', n, _hDate(g.ends_on)) : _hF('toGo', tg - n, _hDate(g.ends_on)));
  return `<div class="hub-card"><span class="hub-k">${_cuIc('people', 16)} ${_hT('goalAll')}</span><strong class="hub-name"><bdi>${esc(name)}</bdi></strong>
    ${_hubProg(n, tg, name)}<div class="hub-meta">${line}</div>${Number(g.mine) > 0 ? `<div class="hub-meta">${esc(_hF('clubYou', Number(g.mine)))}</div>` : ''}</div>`;
}
function _numsHtml(x) {
  if (!x) return '';
  const st = (v, l) => (v == null ? '' : `<div class="hub-stat"><strong>${_hN(v)}</strong><span>${esc(l)}</span></div>`);
  const cells = [st(x.last_riders, _hT('numLast')), st(x.month, _hT('numMonth')), st(x.all, x.since ? _hF('numAll', _hMonth(String(x.since), true)) : '')].join('');
  return cells ? `<div class="hub-card"><span class="hub-k">${_hT('nums')}</span><div class="hub-stats">${cells}</div></div>` : '';
}
// One staff card: the Saturday report showing now, else the site's first announcement, else the tip of the week.
function _staffHtml(d) {
  const p = d.post;
  if (p) {
    const line = _hPick(p, 'line', 'line_ar');
    return `<div class="hub-card hub-flat"><span class="hub-k">${_hT('report')}${p.date ? ` · <bdi>${esc(_hDate(p.date))}</bdi>` : ''}</span>
      ${p.img ? `<img class="hub-photo" data-hubimg="${esc(p.id)}" alt="">` : ''}
      ${p.riders != null ? `<strong class="hub-name">${esc(_hF('riders', p.riders))}</strong>` : ''}${line ? `<p class="hub-line"><bdi>${esc(line)}</bdi></p>` : ''}</div>`;
  }
  const a = Array.isArray(d.announce) ? d.announce.map((m) => (m && m.text ? _hPick(m.text, 'en', 'ar') : '')).find(Boolean) : '';
  if (a) return `<div class="hub-card hub-flat"><span class="hub-k">${_hT('news')}</span><p class="hub-line"><bdi>${esc(a)}</bdi></p></div>`;
  const wk = Math.floor((Date.parse(String(d.today || '') + 'T00:00:00Z') || Date.now()) / 6048e5) % HUB_TIPS;
  return `<div class="hub-card hub-flat"><span class="hub-k">${_cuIc('info', 16)} ${_hT('tip')}</span><p class="hub-line">${esc(_hT('tip' + wk))}</p></div>`;
}
async function _hubPostImg(id) {
  const el = document.querySelector(`#hub-body img[data-hubimg="${CSS.escape(id)}"]`); if (!el || el.src) return;
  S._hubImg = S._hubImg || {};
  if (!(id in S._hubImg)) {
    const c = _hCust(); if (!c) return;
    S._hubImg[id] = null;
    let r; try { r = await sb.rpc('hub_post_img', { ..._hTok(c), p_post: id }); } catch (e) { r = { error: e }; }
    S._hubImg[id] = r && !r.error && typeof r.data === 'string' && r.data.startsWith('data:image/jpeg;base64,') ? r.data : '';
  }
  const src = S._hubImg[id], now = document.querySelector(`#hub-body img[data-hubimg="${CSS.escape(id)}"]`);
  if (now && src) now.src = src; else if (now && src === '') now.remove();
}

// ── The year (December and January) ─────────────────────────────────────────────────────────────
// A card in the feed, "so far" until the last Saturday, opening slides the member moves through themselves (nothing moves
// on its own). Only the member's own counts and the club's total; never anyone else. The first year is the months the club
// rode in. One session: a single card.
function _yrRange(y) { const f = String(y.club_first || ''); return /^\d{4}-(0[2-9]|1[0-2])/.test(f) ? _hF('yrRange', _hMonth(f, false)) : ''; }
function _yrCardHtml(y) {
  return `<div class="hub-card hub-yr"><span class="hub-k">${_cuIc('star', 16)} ${y.full ? esc(_hF('yrTitle', y.year)) : _hT('yrSoFar')}</span>
    <div class="hub-num">${_hN(y.sessions)}</div><div class="hub-meta">${esc(_hT('yrSessions'))}${_yrRange(y) ? ` · ${esc(_yrRange(y))}` : ''}</div>
    <button type="button" class="btn-primary hub-wide" data-on-click="${_on('_yrOpen')}">${_hT('yrOpen')}</button></div>`;
}
function _yrSlides(y) {
  const n = Number(y.sessions) || 0, first = _hDate(y.first);
  if (n <= 1) return [`<div class="hub-big">${esc(_hF('yrFirstOnly', first))}</div>`];
  // A session without a ride kind is the circuit's own (the database says 'rental'): named as the circuit, once.
  const kinds = [...new Set((Array.isArray(y.kinds) ? y.kinds : []).map((k) => (k === 'rental' ? 'jcc' : k)))].map((k) => `<li>${_cuIc(k === 'swim' ? 'wave' : k === 'runher' || k === 'defe5k' ? 'run' : k === 'workshop' ? 'info' : 'bike', 18)} <span>${esc(_evKindName(k))}</span></li>`).join('');
  const share = Number(y.club) >= 10 ? `<div class="hub-meta">${esc(_hF('yrShareOf', n, y.club))}</div>` : '';
  return [
    `<div class="hub-big">${esc(_hF('yrTitle', y.year))}</div>${_yrRange(y) ? `<div class="hub-meta">${esc(_yrRange(y))}</div>` : ''}<div class="hub-meta">${esc(_hF('yrSince', first))}</div>`,
    `<div class="hub-num">${_hN(n)}</div><div class="hub-meta">${_hT('yrSessions')}</div><div class="hub-meta">${esc(_hF('yrSatOf', Number(y.saturdays) || 0, Math.max(Number(y.sats_held) || 0, Number(y.saturdays) || 0)))}</div>`,
    `<div class="hub-k">${_hT('yrKinds')}</div><ul class="hub-kinds">${kinds}</ul>`,
    `<div class="hub-k">${_hT('yrBusiest')}</div><div class="hub-big">${esc(y.busiest ? _hMonth(String(y.busiest), false) : '')}</div><div class="hub-meta">${esc(_hT('yrBadges'))}: ${_hN(y.badges)}</div>${share}`,
    `<div class="hub-big">${_hT('yrNext')}</div>`,
  ];
}
function _yrHtml(d) {
  const y = d.year, sl = _yrSlides(y), i = Math.max(0, Math.min(sl.length - 1, S._yrSlide || 0)), last = i === sl.length - 1;
  return `<div class="hub-card hub-yr hub-slides"><div class="hub-slide" aria-live="polite">${sl[i]}</div>
    <div class="hub-dots hub-dots-sm" aria-hidden="true">${sl.map((_, k) => `<span class="${k === i ? 'on' : ''}"></span>`).join('')}</div>
    <div class="hub-slide-nav">${i > 0 ? `<button type="button" class="btn-secondary" data-on-click="${_on('_yrGo', i - 1)}">${_hT('prev')}</button>` : `<button type="button" class="btn-secondary" data-on-click="${_on('_yrClose')}">${_hT('close')}</button>`}
      ${last ? `<button type="button" class="btn-primary" data-on-click="${_on('_yrShare')}">${_hT('yrShare')}</button>` : `<button type="button" class="btn-primary" data-on-click="${_on('_yrGo', i + 1)}">${_hT('nextB')}</button>`}</div>
    ${last ? `<button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_yrClose')}">${_hT('close')}</button>` : ''}</div>`;
}
function _yrOpen() { S._hubView = 'year'; S._yrSlide = 0; _hubRender(); }
function _yrClose() { S._hubView = null; _hubRender(); }
function _yrGo(i) { S._yrSlide = i; _hubRender(); }

// The share image: drawn when the recap opens (sharing a file must follow the tap at once), 1080 x 1920, the member's own
// totals only, no name, no ticket, no number to call. Arabic and Urdu draw right to left. Without file sharing: the words.
async function _yrPrep(y) {
  const key = `${S.lang}|${y.year}|${y.sessions}|${y.saturdays}`;
  if (S._yrPng && S._yrPng.key === key) return;
  S._yrPng = { key, file: null };
  try {
    const cv = document.createElement('canvas'); cv.width = 1080; cv.height = 1920;
    const x = cv.getContext('2d'); if (!x) return;
    const fam = getComputedStyle(document.body).fontFamily || 'sans-serif', rtl = S.lang === 'ar' || S.lang === 'ur';
    try { await Promise.all(['700 120px', '600 52px', '400 44px'].map((w) => document.fonts.load(`${w} ${fam}`))); } catch (_) {}
    x.direction = rtl ? 'rtl' : 'ltr'; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    x.fillStyle = '#0b0e0a'; x.fillRect(0, 0, 1080, 1920);
    x.fillStyle = '#03ff89'; x.font = `600 52px ${fam}`; x.fillText('MicroMobility', 540, 260);
    x.fillStyle = '#ffffff'; x.font = `700 64px ${fam}`; x.fillText(_hF('yrMy', y.year), 540, 520);
    if (_yrRange(y)) { x.fillStyle = '#b8c2bb'; x.font = `400 44px ${fam}`; x.fillText(_yrRange(y), 540, 600); }
    x.fillStyle = '#03ff89'; x.font = `700 240px ${fam}`; x.fillText('⁦' + String(Number(y.sessions) || 0) + '⁩', 540, 980);
    x.fillStyle = '#ffffff'; x.font = `600 56px ${fam}`; x.fillText(_hT('yrSessions'), 540, 1080);
    x.font = `400 48px ${fam}`; x.fillStyle = '#d7ded9';
    x.fillText(_hF('yrSatOf', '⁦' + (Number(y.saturdays) || 0) + '⁩', '⁦' + Math.max(Number(y.sats_held) || 0, Number(y.saturdays) || 0) + '⁩'), 540, 1260);
    if (y.busiest) x.fillText(_hT('yrBusiest') + ': ' + _hMonth(String(y.busiest), false), 540, 1350);
    x.fillStyle = '#7f8a83'; x.font = `400 40px ${fam}`; x.fillText('experiences.micromobility.sa', 540, 1760);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    if (blob && S._yrPng.key === key) S._yrPng.file = new File([blob], `micromobility-${y.year}.png`, { type: 'image/png' });
  } catch (_) {}
}
async function _yrShare() {
  const h = S._hub, c = _hCust(), y = h && c && h.forId === c.id && h.d && h.d.year; if (!y) return;
  const f = S._yrPng && S._yrPng.file;
  if (f && navigator.canShare && navigator.share) {
    try { if (navigator.canShare({ files: [f] })) { await navigator.share({ files: [f] }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  const text = _hF('yrShareMsg', y.year, Number(y.sessions) || 0, Number(y.saturdays) || 0);
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
window._hubRender = _hubRender;
