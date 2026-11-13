// The Community tab (members only), rebuilt 2026-11-11 (reports/Booking app Community tab.md, M1-M33; the user: "do them
// all"). One feed, no sub-menu: the member's next session (or the next one they can book), what is coming up, the year in
// December and January, their own monthly challenge (made by the database, the level theirs to pick), a staff season
// challenge, the club's monthly goal with the member's own share, the club's numbers (totals of 10 or more only), one staff
// card (the Saturday report, else the news, else the tip of the week), a call for volunteers when one is open, and the
// invitation. Members see nothing of each other (2026-11-04): every number here is the member's own or the club's total.
// Everything comes from one read (hub_feed, migration 20261111100000), kept on the phone so the tab paints at once.
// A file of its own, loaded only on this tab (_hubLoad in app.src.html), with its own words in all ten languages.
// Hand-written, not generated; the build stamps its address (HUB_V).
// 2026-11-13 (reports/Community tab reach after launch.md, R3 R9 R10 R13 R20): each open of the tab tells the read where
// it came from; the next session's card gives its two times, where it meets with one map button, and changes with the
// time to turn up; the Saturday report is number tiles; a club goal reached names the next Saturday's own target.
// 2026-11-13: the Mentorship programme (its card in the feed, its own page S._hubView 'mentor', its read mentor_feed);
// see the block above window._hubRender.
/* global S, sb, esc, _on, getSession, _cssv, shortDate, t, _cuIc, sessionTime, _dayWord, _evName, _evOf, _evKindName, allSessions,
   _isCommunity, _sessPastDay, _bwOpen, _sessFull, _sgOk, _sgChip, _myRideGroups, _sessGet, getQueue, setCustTab, _locale,
   _mrBadgeList, _mrBadgeInfo, _rideKind, _skelHtml, _bdgMedal, toast, selectEvent, selectSessCard, _bookingAhead, _ptnAll,
   _arHold, _isApprovalRide, _commPublished,
   NATIONALITIES, nationalityLabel, _natFor, _selOnce, askConfirm, closeConfirm, _EL, _EV */
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
  plan: ['Plan my Saturdays', 'خطتي لأيام السبت', 'Planifier mes samedis', 'Planificar mis sábados', 'Planejar os meus sábados', 'میرے ہفتے کے دنوں کی منصوبہ بندی', 'मेरे शनिवार की योजना', 'Planuhin ang mga Sabado ko', 'मेरा शनिबारको योजना', 'আমার শনিবারের পরিকল্পনা'],
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
  // The Saturday report's tiles, the ride's status chip and the next Saturday's target (2026-11-13, R10 R13 R20).
  tRiders: ['Riders', 'الراكبون', 'Cyclistes', 'Ciclistas', 'Ciclistas', 'سوار', 'राइडर', 'Rider', 'राइडर', 'রাইডার'],
  tRides: ['Rides', 'الرحلات', 'Sorties', 'Salidas', 'Passeios', 'سواریاں', 'राइड', 'Ride', 'राइड', 'রাইড'],
  tFirst: ['First Saturday rides', 'أول رحلة سبت', 'Premières sorties du samedi', 'Primeras salidas de sábado', 'Primeiros passeios de sábado', 'ہفتے کی پہلی سواریاں', 'पहली शनिवार राइड', 'Unang Saturday ride', 'पहिलो शनिबारे राइड', 'প্রথম শনিবারের রাইড'],
  tLeads: ['Ride leads', 'قادة الرحلة', 'Responsables de sortie', 'Guías de la salida', 'Líderes do passeio', 'رائیڈ لیڈر', 'राइड लीडर', 'Ride leader', 'राइड लिडर', 'রাইড লিডার'],
  tVols: ['Volunteers', 'المتطوعون', 'Bénévoles', 'Voluntarios', 'Voluntários', 'رضاکار', 'स्वयंसेवक', 'Volunteer', 'स्वयंसेवक', 'স্বেচ্ছাসেবক'],
  tChange: ['Change from last week', 'التغيّر عن الأسبوع الماضي', 'Par rapport à la semaine dernière', 'Respecto a la semana pasada', 'Face à semana passada', 'پچھلے ہفتے کے مقابلے میں', 'पिछले हफ़्ते से बदलाव', 'Kumpara sa nakaraang linggo', 'गत हप्ताभन्दा फरक', 'গত সপ্তাহের তুলনায়'],
  tMine: ['Your Saturday rides this month', 'رحلاتك يوم السبت هذا الشهر', 'Vos sorties du samedi ce mois-ci', 'Tus salidas de sábado este mes', 'Os seus passeios de sábado este mês', 'اس مہینے آپ کی ہفتے کی سواریاں', 'इस महीने आपकी शनिवार राइड', 'Ang Saturday ride mo ngayong buwan', 'यो महिना तपाईंका शनिबारे राइड', 'এই মাসে আপনার শনিবারের রাইড'],
  rsMoved: ['Start moved', 'تغيّر موعد الانطلاق', 'Départ décalé', 'Salida cambiada', 'Partida alterada', 'آغاز کا وقت بدل گیا', 'शुरुआत का समय बदला', 'Inilipat ang simula', 'सुरुवातको समय सारियो', 'শুরুর সময় বদলেছে'],
  rsShort: ['Shortened', 'تم تقصير المسار', 'Parcours raccourci', 'Recorrido acortado', 'Percurso encurtado', 'راستہ مختصر', 'रास्ता छोटा किया गया', 'Pinaikli', 'बाटो छोटो गरियो', 'পথ ছোট করা হয়েছে'],
  rsCancel: ['Cancelled', 'ملغاة', 'Annulée', 'Cancelada', 'Cancelada', 'منسوخ', 'रद्द', 'Kanselado', 'रद्द', 'বাতিল'],
  nextSat: ['Next Saturday', 'السبت القادم', 'Samedi prochain', 'Próximo sábado', 'Próximo sábado', 'اگلا ہفتہ', 'अगला शनिवार', 'Susunod na Sabado', 'अर्को शनिबार', 'পরের শনিবার'],
  nextTarget: ['Target', 'الهدف', 'Objectif', 'Meta', 'Objetivo', 'ہدف', 'लक्ष्य', 'Target', 'लक्ष्य', 'লক্ষ্য'],
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
// Each open of the tab (R3, 2026-11-13): the tab coming on screen, from the tab bar ('tab') or from a prompt or a link
// elsewhere that names itself in S._hubSrc first (dot, rating, booked, badge, wa, push, link). The open's first read
// carries it (hub_feed's p_src), once: the re-reads while the tab stays open, its two-minute refresh and Try again carry
// none, so they are not counted again. A read that got no answer has counted nothing, so the next one carries it. Leaving
// the tab, or the rider pages, ends the open.
function _hubVisitNow() {
  if (S._hubVisit && !S._hubSrc) return;
  S._hubVisit = { src: String(S._hubSrc || 'tab').slice(0, 24), due: true };
  S._hubSrc = null;
}
(function _hubVisitWatch() {
  const tab = document.getElementById('tab-members'), view = document.getElementById('view-customer');
  if (!tab || typeof MutationObserver !== 'function') return;
  const off = () => { if (!tab.classList.contains('active') || (view && !view.classList.contains('active'))) S._hubVisit = null; };
  const mo = new MutationObserver(off);
  [tab, view].forEach((el) => { if (el) mo.observe(el, { attributes: true, attributeFilter: ['class'] }); });
})();
async function _hubFetch(force) {
  const c = _hCust(); if (!c || !sb) return;
  const o = S._hubVisit && S._hubVisit.due ? S._hubVisit : null;
  if (S._hubBusy) { if (o) S._hubAgain = true; return; }
  const h = S._hub;
  if (!force && !o && h && h.forId === c.id && h.d && !h.stale && Date.now() - h.at < 12e4) return;
  S._hubBusy = true; S._hubAgain = false; if (o) o.sent = true;
  let r; try { r = await sb.rpc('hub_feed', o ? { ..._hTok(c), p_src: o.src } : _hTok(c)); } catch (e) { r = { error: e }; }
  // A database before the entry points (20261114000100) has only the two-argument read: the open is read without its source.
  if (o && r && r.error && r.error.code === 'PGRST202') { try { r = await sb.rpc('hub_feed', _hTok(c)); } catch (e) { r = { error: e }; } }
  S._hubBusy = false;
  if (S._hubAgain) { S._hubAgain = false; if (S._hubVisit && S._hubVisit.due && S._hubVisit !== o) setTimeout(() => _hubFetch(true), 0); }
  // Signed out, or another account signed in, while it was asked: the answer is not theirs (a shared phone).
  const now = _hCust();
  if (!now || now.id !== c.id) { if (S.custTab === 'members') _hubRender(); return; }
  const d = r && !r.error && r.data;
  if (d && d.ok === false && d.error === 'member') { S._hub = null; try { localStorage.removeItem(_HUB_KEY + c.id); } catch (_) {} if (S.custTab === 'members') setCustTab('register'); return; }
  if (d && d.ok === true) {
    if (o) o.due = false;
    S._hub = { forId: c.id, at: Date.now(), d };
    _hubSave(c, d);
    if (Array.isArray(d.awarded) && d.awarded.length) _hubCheer(d.awarded);
  } else if (h && h.forId === c.id && h.d) { h.stale = true; h.failAt = Date.now(); }
  else S._hub = { forId: c.id, at: Date.now(), d: null, failAt: Date.now() };
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
  // Marked seen only when it opens here: a member who left the tab while this read, or another pop-up already up, leaves
  // it unseen, so Account's own pop (_bdgCelebrate, within its three days) still shows it. It was marked first and lost.
  if (S.custTab !== 'members' || document.getElementById('badge-pop')) return;
  const top = slugs[slugs.length - 1], g = r.data.find((x) => x && x.slug === top);
  const L = _mrBadgeList(c), i = L.findIndex((x) => (x.b && x.b.slug === top) || (x.lv && x.lv.some((y) => y.b && y.b.slug === top)));
  if (i < 0) return;
  try { if (g && g.at) localStorage.setItem('cq_bdg_seen_' + c.id, String(Math.max(Date.parse(g.at) || 0, +localStorage.getItem('cq_bdg_seen_' + c.id) || 0))); } catch (_) {}
  _mrBadgeInfo(i, true);
  // Seen on the server too (hub_seen), so the app's pulse never shows the same badge again on this or another phone.
  if (typeof _plsSeen === 'function') _plsSeen(c, slugs);
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────────
function _hubRender() {
  const body = document.getElementById('hub-body');
  if (!body) return;
  const c = _hCust();
  if (S._hub && (!c || S._hub.forId !== c.id)) S._hub = null;
  if (!S._hub && c) { const disk = _hubDisk(c); if (disk) S._hub = { forId: c.id, at: disk.at, d: disk.d }; }
  const h = S._hub, d = h && h.d;
  _hubVisitNow();
  _mtFetch();
  _akListFetch();
  // An open's first read goes at once, the copy on the phone painted meanwhile. A failed read (the copy kept and marked
  // stale, or none at all) is tried again two minutes on too, not only by Retry.
  if ((S._hubVisit && S._hubVisit.due && !S._hubVisit.sent) || !h || (d && !h.stale && Date.now() - h.at >= 12e4) || ((h.stale || !d) && Date.now() - (h.failAt || 0) >= 12e4)) _hubFetch();
  // Keep the focused control across a repaint (a pick, a slide), found again by what it does, or a link by where it goes.
  const _key = (x) => x.getAttribute('data-on-click') || (x.getAttribute('href') ? 'href:' + x.getAttribute('href') : null);
  const was = document.activeElement && body.contains(document.activeElement) ? _key(document.activeElement) : null;
  // An Ask page (member-ask.js) draws itself in parts, keeping what the member is typing; it does not need the feed.
  if (S._hubView === 'ask' && c) {
    if (window._akPaint) window._akPaint(body);
    else { body.innerHTML = _akShellHtml(); _akLoad(); }
    return;
  }
  if (!d) {
    body.innerHTML = h ? `<div class="hub-card" role="status"><strong class="hub-name">${_hT('err')}</strong><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_hubRetry')}">${_hT('retry')}</button></div>` : _skelHtml(2, 'hub-skel');
    return;
  }
  if (S._hubView === 'mentor' && S._mt && S._mt.off) S._hubView = null;
  body.innerHTML = S._hubView === 'mentor' ? _mtHtml() : S._hubView === 'year' && d.year ? _yrHtml(d) : _feedHtml(c, d, h.stale);
  if (S._hubView === 'year' && d.year) _yrPrep(d.year);
  if (d.post && d.post.img) _hubPostImg(d.post.id);
  if (was) { const el = [...body.querySelectorAll('[data-on-click],a[href]')].find((x) => _key(x) === was); if (el) try { el.focus({ preventScroll: true }); } catch (_) {} }
}

function _hubInvite() { const dep = window._hubDeps || {}; if (dep.inv) dep.inv(); }
// The Updates list's way in (new features build F3, 2026-11-13): a button at the foot of the staff card, whichever of the
// three it is. The page draws it (window._hubDeps.upd), and repaints it when the unread count lands.
function _hubUpd(html) { const dep = window._hubDeps || {}, i = html.lastIndexOf('</div>'); return dep.upd && i >= 0 ? html.slice(0, i) + dep.upd() + html.slice(i) : html; }
function _feedHtml(c, d, stale) {
  const dep = window._hubDeps || {}, hero = _heroHtml(c, d);
  // A ride the member has just finished, with nothing else booked: its recap leads the page, before the next one to book.
  const staff = _hubUpd(_staffHtml(d));
  return [
    stale ? `<div class="hub-card hub-stale" role="status"><span>${_hT('stale')}</span><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_hubRetry')}">${_hT('retry')}</button></div>` : '',
    d.birthday ? `<div class="hub-card hub-bday">${_cuIc('gift', 20)}<strong>${esc(_hF('bday', String((c && c.name) || '').trim().split(/\s+/)[0] || ''))}</strong></div>` : '',
    hero.recap ? staff : '',
    hero.html,
    d.year ? _yrCardHtml(d.year) : '',
    _soonHtml(c, hero.open),
    _akCardHtml(),
    _p5Html() || _meHtml(d.me),
    _planHtml(),
    (Array.isArray(d.goals) ? d.goals : []).map(_seasonHtml).join(''),
    d.club ? _clubHtml(d.club) : '',
    _numsHtml(d.numbers),
    hero.recap ? '' : staff,
    _mtCardHtml(),
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
// Staff's word on the ride (R10): the start moved, the route shortened, or the ride cancelled; a chip, never a sentence.
const HUB_RS = { moved: 'rsMoved', shortened: 'rsShort', cancelled: 'rsCancel' };
function _hubRs(s) {
  const v = s && s.ride_status;
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HUB_RS, v) ? `<span class="hub-chip hub-rs hub-rs-${v}">${esc(_hT(HUB_RS[v]))}</span>` : '';
}
// Its two times as the ticket names them for its kind (R9): a ride that gathers, the gathering and the start (Victory
// Lap: doors open and the first heat); a circuit or Petromin night, bike collection (a waitlisted rider's own) and the
// start; anything else (the pool, a run, yoga, a workshop) its start and end. With the moments that set the card's state:
// when to turn up and when it starts (a start past midnight is the next day's).
function _hubTimes(s, e) {
  const dep = window._hubDeps || {};
  if (!s || !dep.slots || !dep.at || !dep.gathers) return null;
  const ds = String(s.session_date || s.id || '').slice(0, 10);
  const p = String((dep.slots(s.bike_slots) || {})._time || '').replace(/[<>"'&`]/g, '').split('-').map((x) => x.trim()).filter(Boolean);
  if (!p.length) return null;
  const vl = _rideKind(s) === 'vlap', w = _hubW();
  let f, go, st;
  if (dep.gathers(s)) { f = [[vl ? w.doors : w.gather, p[0]], [vl ? w.heat : w.start, p[1]]]; go = p[0]; st = p[1] || p[0]; }
  else if (dep.bike(s)) {
    const col = (e && e.status === 'waitlist' && dep.wlCollect && dep.wlCollect(s)) || dep.collect(s);
    f = [[w.collect, col], [w.start, p[0]]]; go = col || p[0]; st = p[0];
  } else { f = [[w.start, p[0]], [w.end, p[1]]]; go = p[0]; st = p[0]; }
  const goMs = dep.at(ds, go); let stMs = dep.at(ds, st);
  if (stMs < goMs) stMs += 864e5;
  return { f: f.filter((x) => x[0] && x[1]), go: goMs, st: stMs };
}
// The ticket's own words (lent by _hubDeps.words: the build keeps a word only where rider code names it).
function _hubW() { const dep = window._hubDeps || {}; let w = null; try { w = dep.words && dep.words(); } catch (_) {} return w || {}; }
// R10: from 24 hours before the time to turn up the day heads the card; from 3 hours before, where to go comes first and
// Show ticket opens the ticket; from an hour after the start the card moves on.
function _hubState(tm, now) {
  if (!tm || !Number.isFinite(tm.go)) return '';
  if (now >= (Number.isFinite(tm.st) ? tm.st : tm.go) + 36e5) return 'done';
  return now >= tm.go - 108e5 ? 'today' : now >= tm.go - 864e5 ? 'tomorrow' : '';
}
function _hubNextAt(tm, now) {
  if (!tm || !Number.isFinite(tm.go)) return 0;
  const st = Number.isFinite(tm.st) ? tm.st : tm.go; // the start itself too: "Still coming?" leaves the card then (F2)
  return [tm.go - 864e5, tm.go - 108e5, st, st + 36e5].find((x) => x > now) || 0;
}
// The page draws itself again when the card's state changes while it is open (within the next twelve hours).
function _hubArm(at) {
  if (S._hubT) { clearTimeout(S._hubT); S._hubT = null; }
  const ms = at - Date.now();
  if (!(ms > 0) || ms > 432e5) return;
  S._hubT = setTimeout(() => { S._hubT = null; if (S.view === 'customer' && S.custTab === 'members') _hubRender(); }, ms + 1000);
}
// Where it meets (R9): the name staff gave the point (meet_name, in Arabic on an Arabic page), else what the ticket names
// it; held back as the ticket holds it (a Saturday ride kept without its meeting point names one with no map). One map
// button: the point's own coordinates when staff set them, else the ticket's own link.
function _hubPlace(s) {
  const dep = window._hubDeps || {}, w = _hubW();
  const nm = String((S.lang === 'ar' && s.meet_name_ar) || s.meet_name || '').trim();
  const lat = Number(s.meet_lat), lng = Number(s.meet_lng);
  const ll = s.meet_lat != null && s.meet_lng != null && s.meet_lat !== '' && s.meet_lng !== '' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if ((!nm && !ll && !dep.venue) || !w.meet) return '';
  const held = !nm && !ll && !!(dep.held && dep.held(s));
  const lbl = nm || ll || held || (dep.meets && dep.meets(s)) ? w.meet : w.where;
  let name = nm || (held || !dep.venue ? '' : String(dep.venue(s) || ''));
  if (name === lbl) name = ''; // the ticket's stand-in name says no more than the label
  const map = ll
    ? `<a class="btn-secondary hub-map" href="${esc('https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng)}" target="_blank" rel="noopener" aria-label="${esc(w.map + (w.newTab || ''))}">${_cuIc('pin', 16)} ${esc(w.map)}</a>`
    : held || !dep.dir ? '' : _hubMapBtn(dep.dir(s));
  return `<div class="hub-place"><span class="hub-f"><span class="hub-fk">${esc(lbl)}</span>${name ? `<strong class="hub-fv"><bdi>${esc(name)}</bdi></strong>` : ''}</span>${map}</div>`;
}
// The ticket's own map button (_dirBtnHtml: the meeting point's link, the venue searched by name, or the circuit's pin with
// Apple Maps offered on an iPhone), dressed as this card's and named Map: the field beside it already says where.
function _hubMapBtn(html) {
  const tp = document.createElement('template'); tp.innerHTML = String(html || '').trim();
  const b = tp.content.firstElementChild;
  if (!b || (b.tagName !== 'A' && b.tagName !== 'BUTTON')) return '';
  const w = _hubW();
  b.className = 'btn-secondary hub-map';
  b.innerHTML = `${_cuIc('pin', 16)} ${esc(w.map || '')}`;
  if (b.tagName === 'A') b.setAttribute('aria-label', (w.map || '') + (w.newTab || '')); else b.removeAttribute('aria-label');
  return b.outerHTML;
}
function _hubFields(f) {
  const dep = window._hubDeps || {};
  return f.length ? `<div class="hub-fields">${f.map(([k, v]) => `<span class="hub-f"><span class="hub-fk">${esc(k)}</span><strong class="hub-fv"><bdi>${esc(dep.hm ? dep.hm(v) : v)}</bdi></strong></span>`).join('')}</div>` : '';
}
// "Still coming?" (new features build F2, 2026-11-13): the ticket's own two buttons, "I'm coming" and "Can't come", or its
// quiet chip after a yes, from 24 hours before the time to turn up until the start (app.src.html _stcHtml, lent as
// _hubDeps.still, with its words). It takes every row of that booking, as the ticket groups them, and whether the place
// is held and the rider has been told so: the ticket's own rule for showing its code (renderBookingTicket's _qrReady).
// Nothing on a waitlisted booking, and no line of text with them.
function _hubStill(s, e) {
  const dep = window._hubDeps || {};
  if (!dep.still) return '';
  try {
    const g = getQueue().filter((x) => x.customerId === e.customerId && x.sessionId === e.sessionId && _bookingAhead(x)), p = _ptnAll(g);
    return dep.still(s, g, !_arHold(s, g) && (!_isApprovalRide(s) || ((p || _commPublished(s)) && (p || g.every((x) => x.approval === 'approved')))));
  } catch (_) { return ''; }
}
function _bookedHtml(s, e, tm, st) {
  const ds = String(s.session_date || s.id).slice(0, 10), dw = _dayWord(ds), soon = st === 'today' || st === 'tomorrow';
  const f = _hubFields(tm ? tm.f : []), place = _hubPlace(s);
  const when = `<bdi>${esc(!soon && dw ? dw + ' · ' : '')}${esc(shortDate(ds))}</bdi>${f ? '' : ` · <bdi>${sessionTime(s)}</bdi>`}`;
  const chips = `${e.status === 'waitlist' ? `<span class="hub-chip">${_hT('wl')}</span>` : ''}${_hubRs(s)}`;
  return `<div class="hub-hero${st ? ' hub-hero-' + st : ''}"><span class="hub-k">${esc(soon && dw ? dw : _hT('next'))}</span><strong class="hub-hero-t"><bdi>${esc(_evName(s))}</bdi></strong>
      <span class="hub-hero-m">${when}</span>${chips ? `<span class="hub-chips">${chips}</span>` : ''}
      ${st === 'today' ? place + f : f + place}
      ${soon ? _hubStill(s, e) : ''}
      <button type="button" class="btn-primary hub-hero-b" data-on-click="${st === 'today' ? _on('_hubTicket', e.id) : _on('setCustTab', 'myrides')}">${_cuIc('ticket', 18)} ${_hT('ticket')}</button></div>`;
}
// { html, open: the session offered to book (Coming up leaves it out), recap: the staff card leads the page }. With nothing
// booked ahead, the recap of the member's own last ride leads the page on its day and the day after.
function _heroHtml(c, d) {
  const now = Date.now(), gs = c ? _myRideGroups(c) : {};
  let last = '';
  for (const g of gs.current || []) {
    const e = g[0], s = e && _sessGet(e.sessionId); if (!s) continue;
    const tm = _hubTimes(s, e), st = _hubState(tm, now);
    if (st === 'done') { last = String(s.session_date || s.id).slice(0, 10); continue; }
    _hubArm(_hubNextAt(tm, now));
    return { html: _bookedHtml(s, e, tm, st) };
  }
  _hubArm(0);
  const pg = (gs.past || [])[0], pe = pg && pg[0];
  if (pe) { const x = String(pe.sessionDate || pe.sessionId || '').slice(0, 10); if (x > last) last = x; }
  const p = d && d.post, pd = p && p.date ? String(p.date).slice(0, 10) : '';
  const recap = !!(pd && pd === last && pd >= new Date(now + 108e5 - 864e5).toISOString().slice(0, 10));
  const s = c ? _hubOpen(c, 1)[0] : null;
  if (s) {
    return { recap, open: s.id, html: `<div class="hub-hero"><span class="hub-k">${_hT('nextOpen')}</span><strong class="hub-hero-t"><bdi>${esc(_evName(s))}</bdi></strong>
      <span class="hub-hero-m">${_hubWhen(s)}</span>${_sgChip(s)}${_hubRs(s)}
      <button type="button" class="btn-primary hub-hero-b" data-on-click="${_on('_hubBook', s.id)}">${_hT('book')}</button></div>` };
  }
  return { recap, html: `<div class="hub-hero"><strong class="hub-hero-t">${_hT('noneOpen')}</strong>
    <button type="button" class="btn-primary hub-hero-b" data-on-click="${_on('setCustTab', 'register')}">${_hT('seeAll')}</button></div>` };
}
// Show ticket on the day (R10): Bookings, scrolled to that booking's ticket (the one whose Share button names it), its
// code drawn large there. Bookings has no page of one ticket; before the day the button opens Bookings as before.
function _hubTicket(id) {
  setCustTab('myrides');
  const card = [...document.querySelectorAll('#tab-myrides .ticket-card')].find((x) => [...x.querySelectorAll('[data-on-click]')].some((b) => {
    try { const v = JSON.parse(b.getAttribute('data-on-click')); return Array.isArray(v) && v[0] === '_tkShare' && v[1] === id; } catch (_) { return false; }
  }));
  if (!card) return;
  const bar = document.getElementById('topbar');
  const top = card.getBoundingClientRect().top + window.scrollY - ((bar && bar.getBoundingClientRect().height) || 0) - 12;
  try { window.scrollTo({ top: Math.max(0, top) }); } catch (_) { window.scrollTo(0, Math.max(0, top)); }
}
// The way a link to a date opens Reserve (?ev=&session=): the event first (its gates, and a fresh start without the
// add-ons, locker, promo code, tickets or booking being changed from before), then the date with its own gates (the
// profile, a rider turned down, the Saturday ride code, the age pop-ups). Setting the date straight skipped them all.
async function _hubBook(id) {
  const s = _sessGet(id); if (!s) { setCustTab('register'); return; }
  const ev = _evOf(s);
  await selectEvent(ev);
  if (S.selEvent !== ev || S.view !== 'customer' || S.custTab !== 'register') return;
  await selectSessCard(id);
}
function _soonHtml(c, skip) {
  if (!c) return '';
  const list = _hubOpen(c, 3, skip).slice(0, 3);
  if (!list.length) return '';
  return `<div class="hub-card"><span class="hub-k">${_hT('soon')}</span>${list.map((s) => `<div class="hub-soon">
      <span class="hub-soon-t"><strong><bdi>${esc(_evName(s))}</bdi></strong> ${_sgChip(s)}<small>${_hubWhen(s)}</small></span>
      <button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_hubBook', s.id)}">${_hT('book')}</button></div>`).join('')}</div>`;
}

// Progress: dots for five or fewer, a bar above that; the count always written.
function _hubProg(n, target, label, text) { // text: the count in words, where the card writes it so ("2 of 5")
  const v = Math.min(n, target), txt = text || `${v} / ${target}`;
  if (target <= 5) {
    return `<div class="hub-dots" role="progressbar" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${v}" aria-valuetext="${esc(txt)}" aria-label="${esc(label)}">${Array.from({ length: target }, (_, i) => `<span class="${i < v ? 'on' : ''}"></span>`).join('')}</div>`;
  }
  const pct = Math.min(100, Math.round((v / target) * 100));
  return `<div class="hub-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${v}" aria-valuetext="${esc(txt)}" aria-label="${esc(label)}"><span data-cssv="${_cssv({ '--w': pct + '%' })}"></span></div>`;
}
function _meName(me) {
  return me.kind === 'first' ? _hT('chFirst') : me.kind === 'second' ? _hT('chSecond') : me.kind === 'back' ? _hT('chBack') : _hF('chLevel', me.target);
}
// A finished challenge is shared as a picture (new features build F12, 2026-11-13): the page's share pop-up, which
// lives in badge-share.js and is fetched on the tap (_shrLoad in app.src.html). k: 'me' the member's own, 'goal' a season's.
function _hubShare(k, id) { if (typeof _shrLoad === 'function') _shrLoad({ kind: 'mile', k, id: id || null }); }
function _hubShareBtn(k, id) {
  return typeof _shrLoad === 'function' ? `<button type="button" class="btn-secondary hub-wide shr-btn" data-on-click="${_on('_hubShare', k, id || '')}">${_cuIc('share', 16)}<span>${esc(t('tcShare'))}</span></button>` : '';
}
function _meHtml(me) {
  if (!me || !me.kind) return '';
  const n = Number(me.n) || 0, tg = Number(me.target) || 1, done = n >= tg, name = _meName(me);
  const pick = me.kind === 'level' && !me.chosen && !done && Array.isArray(me.levels)
    ? `<div class="hub-pick" role="group" aria-label="${esc(_hT('chPick'))}">${me.levels.map((k) => `<button type="button" class="hub-lv${k === tg ? ' on' : ''}" aria-pressed="${k === tg}" data-on-click="${_on('_hubPick', k)}"><bdi>${esc(String(k))}</bdi></button>`).join('')}</div>`
    : '';
  return `<div class="hub-card"><span class="hub-k">${_cuIc('flag', 16)} ${_hT('goalYou')}</span><strong class="hub-name"><bdi>${esc(name)}</bdi></strong>
    ${pick ? `<span class="hub-k">${_hT('chPick')}</span>${pick}` : ''}
    ${_hubProg(n, tg, name)}<div class="hub-meta">${done ? `<strong>${_hT('goalDone')}</strong> · ` : ''}${esc(_hF('goalOf', Math.min(n, tg), tg, _hDate(me.ends_on)))}</div>${done ? _hubShareBtn('me') : ''}</div>`;
}
// The first five rides (new features build F1, 2026-11-13): a member with fewer than five rides sees their path of five
// marks in this slot, in place of the month's challenge, until the fifth ride. The count is the page's own (the ride
// tier's), lent with its words through _hubDeps.p5; a page from before it lends nothing and the challenge stays.
function _p5Html() {
  const dep = window._hubDeps || {}; let p = null;
  try { p = dep.p5 ? dep.p5() : null; } catch (_) {}
  if (!p) return '';
  return `<div class="hub-card hub-p5"><span class="hub-k">${_cuIc('flag', 16)} ${_hT('goalYou')}</span><strong class="hub-name"><bdi>${esc(p.nm)}</bdi></strong>
    ${_hubProg(p.n, p.tg, p.nm, p.of)}<div class="hub-meta"><bdi>${esc(p.of)}</bdi></div></div>`;
}
async function _hubPick(k) {
  const c = _hCust(), h = S._hub; if (!c || !h || !h.d || !h.d.me || S._hubPicking) return;
  const was = h.d.me.target; h.d.me.target = k; S._hubPicking = true; _hubRender();
  let r; try { r = await sb.rpc('hub_pick_level', { ..._hTok(c), p_level: k }); } catch (e) { r = { error: e }; }
  S._hubPicking = false;
  if (!r || r.error || !r.data || r.data.ok !== true) { h.d.me.target = was; if (typeof toast === 'function') toast(_hT('err'), 'error'); _hubRender(); return; }
  // Onto the copy on screen now: a read that was in flight may have replaced S._hub with one taken before the pick
  // (the old level, not chosen), and saving the replaced object put that older copy on the phone with a fresh time.
  const cur = S._hub;
  if (cur && cur.forId === c.id && cur.d && cur.d.me && cur.d.me.kind === 'level') { cur.d.me.target = k; cur.d.me.chosen = true; _hubSave(c, cur.d); }
  _hubRender();
}
// ── Plan my Saturdays (new features build F10, 2026-11-13) ──────────────────────────────────────────
// Beside the month's challenge: the current month's Saturdays as tick boxes. A tick books nothing and holds no place: it
// stores that the member plans to come (hub_plans, migration 20261114011000, which only that member's own read returns),
// and the database sends them one "booking is open" message when that Saturday's ride opens, unless they have booked
// it. Nothing is ticked for them; a Saturday already gone shows, locked. A read of its own (hub_plan), kept two minutes
// like the feed and never on the phone, so a database before the migration has no card and no error.
// S._plan: {id, at, month, days: [{date, on, past}], pend: {date: true}, off}.
function _planMine() { const c = _hCust(), p = S._plan; return c && p && p.id === c.id ? p : null; }
async function _planFetch() {
  const c = _hCust(); if (!c || !c.session_token || !sb || S._planBusy) return;
  S._planBusy = true;
  let r; try { r = await sb.rpc('hub_plan', _hTok(c)); } catch (e) { r = { error: e }; }
  S._planBusy = false;
  const now = _hCust(); if (!now || now.id !== c.id) return; // signed out, or another account, meanwhile: not theirs
  const d = r && !r.error && r.data, had = _planMine(), pend = (had && had.pend) || {};
  if (d && d.ok === true && Array.isArray(d.days)) {
    // A tick still on its way to the database keeps what the member chose, not what this read saw before it.
    const days = d.days.filter((x) => x && /^\d{4}-\d\d-\d\d$/.test(String(x.date || ''))).map((x) => {
      const was = pend[x.date] && had && Array.isArray(had.days) ? had.days.find((y) => y.date === x.date) : null;
      return { date: String(x.date), on: was ? was.on : x.on === true, past: x.past === true };
    });
    S._plan = { id: c.id, at: Date.now(), month: String(d.month || (days[0] && days[0].date) || '').slice(0, 7), days, pend };
  } else if (r && r.error && (r.error.code === 'PGRST202' || r.error.code === '42883')) {
    S._plan = { id: c.id, at: Date.now(), off: true }; // a database before the migration: no card, and not asked again
  } else {
    S._plan = { ...(had || { id: c.id }), at: Date.now() }; // no answer: what is on screen stays, asked again in two minutes
  }
  // Repainted only when there is a card to draw or to bring up to date: a tab without one is left alone.
  const has = (x) => !!(x && Array.isArray(x.days) && x.days.length);
  if ((has(had) || has(S._plan)) && S.custTab === 'members') _hubRender();
}
function _planHtml() {
  const c = _hCust(); if (!c) return '';
  const p = _planMine();
  if (!p || (!p.off && Date.now() - p.at >= 12e4)) _planFetch();
  if (!p || p.off || !Array.isArray(p.days) || !p.days.length) return '';
  const today = todayStr(), name = _hT('plan'), month = /^\d{4}-\d\d$/.test(p.month) ? _hMonth(p.month, false) : '';
  let fmt = null; try { fmt = new Intl.DateTimeFormat(_locale(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }); } catch (_) {}
  const box = (x) => {
    const past = x.past || x.date < today, at = new Date(x.date + 'T12:00:00Z');
    let label = x.date; try { if (fmt) label = fmt.format(at); } catch (_) {}
    return `<button type="button" role="checkbox" class="hub-sat${x.on ? ' on' : ''}" aria-checked="${x.on ? 'true' : 'false'}" aria-label="${esc(label)}"${past ? ' disabled' : ''} data-on-click="${_on('_planTick', x.date)}"><span class="hub-sat-box">${x.on ? _cuIc('tick', 14) : ''}</span><bdi>${esc(String(Number(x.date.slice(8, 10))))}</bdi></button>`;
  };
  return `<div class="hub-card hub-plan"><span class="hub-k">${_cuIc('cal', 16)} ${esc(name)}</span>${month ? `<strong class="hub-name"><bdi>${esc(month)}</bdi></strong>` : ''}
    <div class="hub-sats" role="group" aria-label="${esc(month ? name + ' · ' + month : name)}">${p.days.map(box).join('')}</div></div>`;
}
async function _planTick(date) {
  const c = _hCust(), p = _planMine(); if (!c || !sb || !p || !Array.isArray(p.days)) return;
  const d = p.days.find((x) => x.date === date);
  if (!d || d.past || d.date < todayStr() || (p.pend && p.pend[date])) return; // gone, or its last tap still on its way
  const want = !d.on;
  d.on = want; p.pend = p.pend || {}; p.pend[date] = true; _hubRender();
  let r; try { r = await sb.rpc('hub_plan_set', { ..._hTok(c), p_date: date, p_on: want }); } catch (e) { r = { error: e }; }
  // Onto the copy on screen now: a read that was in flight may have replaced S._plan (it carries the same pend).
  const cur = _planMine();
  if (p.pend) delete p.pend[date];
  if (!cur || !Array.isArray(cur.days)) return;
  if (cur.pend) delete cur.pend[date];
  const x = cur.days.find((y) => y.date === date);
  if (!r || r.error || !r.data || r.data.ok !== true) { if (x) x.on = !want; if (typeof toast === 'function') toast(_hT('err'), 'error'); }
  else if (x) x.on = r.data.on === true;
  if (S.custTab === 'members') _hubRender();
}
// This file is fetched as the tab opens: the plan's first read leaves here, beside the feed's own, not a turn after it.
_planFetch();
function _seasonHtml(g) {
  const n = Number(g.n) || 0, tg = Number(g.target) || 1, name = _hPick(g, 'name', 'name_ar');
  const medal = g.badge && typeof _bdgMedal === 'function' ? _bdgMedal(g.badge.icon, g.badge.color, 'hub-medal') : '';
  return `<div class="hub-card"><span class="hub-k">${_hT('season')}</span><div class="hub-row2">${medal}<strong class="hub-name"><bdi>${esc(name)}</bdi></strong></div>
    ${_hubProg(n, tg, name)}<div class="hub-meta">${n >= tg ? `<strong>${_hT('goalDone')}</strong> · ` : ''}${esc(_hF('goalOf', Math.min(n, tg), tg, _hDate(g.ends_on)))}</div>${n >= tg ? _hubShareBtn('goal', g.id) : ''}</div>`;
}
// The club's goal: "so far" while less than two thirds is done, then what is left; the member's own share only to them.
function _clubHtml(g) {
  const n = Number(g.n) || 0, tg = Number(g.target) || 1, name = g.name ? _hPick(g, 'name', 'name_ar') : _hF('clubSat', tg), hit = n >= tg;
  const line = hit ? `<strong>${_hT('clubHit')}</strong>` : esc(n / tg < 2 / 3 ? _hF('soFar', n, _hDate(g.ends_on)) : _hF('toGo', tg - n, _hDate(g.ends_on)));
  // Reached before the month is out (R20): the next Saturday's own target, as the server sizes it, to aim at next.
  const nx = hit && g.next && /^\d{4}-\d\d-\d\d$/.test(String(g.next.date || '')) && Number(g.next.target) > 0
    ? `<div class="hub-fields hub-next"><span class="hub-f"><span class="hub-fk">${esc(_hT('nextSat'))}</span><strong class="hub-fv"><bdi>${esc(_hDate(g.next.date))}</bdi></strong></span><span class="hub-f"><span class="hub-fk">${esc(_hT('nextTarget'))}</span><strong class="hub-fv">${_hN(g.next.target)}</strong></span></div>`
    : '';
  return `<div class="hub-card${hit ? ' hub-hit' : ''}"><span class="hub-k">${_cuIc('people', 16)} ${_hT('goalAll')}</span><strong class="hub-name"><bdi>${esc(name)}</bdi></strong>
    ${_hubProg(n, tg, name)}<div class="hub-meta">${line}</div>${Number(g.mine) > 0 ? `<div class="hub-meta">${esc(_hF('clubYou', Number(g.mine)))}</div>` : ''}${nx}</div>`;
}
function _numsHtml(x) {
  if (!x) return '';
  const st = (v, l) => (v == null ? '' : `<div class="hub-stat"><strong>${_hN(v)}</strong><span>${esc(l)}</span></div>`);
  const cells = [st(x.last_riders, _hT('numLast')), st(x.month, _hT('numMonth')), st(x.all, x.since ? _hF('numAll', _hMonth(String(x.since), true)) : '')].join('');
  return cells ? `<div class="hub-card"><span class="hub-k">${_hT('nums')}</span><div class="hub-stats">${cells}</div></div>` : '';
}
// One staff card: the Saturday report showing now, else the site's first announcement, else the tip of the week.
// The report is number tiles (R13, 2026-11-13; the server writes one after each Saturday ride, staff may add a line and a
// photo): riders, rides when they differ, first Saturday rides, ride leads, volunteers, each only as the server sends it
// (10 or more), the change from the week before, the month's total toward the club's own goal, and the member's own
// Saturdays this month when they rode it. No names, no ranking.
function _hubBig(v) { return v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 10; }
function _staffHtml(d) {
  const p = d.post;
  if (p) {
    const line = _hPick(p, 'line', 'line_ar'), cl = d.club, cells = [];
    const tile = (v, k) => cells.push(`<div class="hub-stat"><strong>${v}</strong><span>${esc(_hT(k))}</span></div>`);
    if (_hubBig(p.riders)) tile(_hN(p.riders), 'tRiders');
    if (_hubBig(p.rides) && Number(p.rides) !== Number(p.riders)) tile(_hN(p.rides), 'tRides');
    if (_hubBig(p.first_rides)) tile(_hN(p.first_rides), 'tFirst');
    if (_hubBig(p.leads)) tile(_hN(p.leads), 'tLeads');
    if (_hubBig(p.volunteers)) tile(_hN(p.volunteers), 'tVols');
    if (_hubBig(p.riders) && _hubBig(p.prev_riders)) { const x = Number(p.riders) - Number(p.prev_riders); tile(`<bdi dir="ltr">${x > 0 ? '+' : x < 0 ? '-' : ''}${Math.abs(x)}</bdi>`, 'tChange'); }
    if (cl && !cl.name && Number(cl.target) > 0 && _hubBig(cl.n) && (!p.date || !cl.from || String(p.date).slice(0, 7) === String(cl.from).slice(0, 7))) tile(`<bdi dir="ltr">${esc(String(Number(cl.n) || 0))} / ${esc(String(Number(cl.target)))}</bdi>`, 'goalAll');
    const mine = p.mine != null && Number(p.mine) > 0 ? `<div class="hub-mine"><span>${esc(_hT('tMine'))}</span><strong>${_hN(p.mine)}</strong></div>` : '';
    return `<div class="hub-card hub-flat hub-report"><span class="hub-k">${_hT('report')}${p.date ? ` · <bdi>${esc(_hDate(p.date))}</bdi>` : ''}</span>
      ${p.img ? `<img class="hub-photo" data-hubimg="${esc(p.id)}" alt="">` : ''}
      ${cells.length ? `<div class="hub-stats">${cells.join('')}</div>` : ''}${mine}${line ? `<p class="hub-line"><bdi>${esc(line)}</bdi></p>` : ''}</div>`;
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
// ── Mentorship (2026-11-13) ──────────────────────────────────────────────────────────────────────
// The user, 2026-11-13: "create a mentorship program exclusively for community members, we put anonymous profiles of
// students in specific universities and cities worldwide and let community members who have knowledge or can help choose
// the profile they can help and we match them and make them contact with them" (migration 20261114050000).
// One card in the feed opens a page of its own (S._hubView 'mentor'): the member's matches (first name, WhatsApp and the
// "Still in touch?" check two weeks after the match, then monthly), their own request with the offers staff proposed to
// them (Accept or Not now), their own offers, and the open profiles, which carry no name. A member starting university
// asks for a mentor here; staff publish it. A name and number cross only an accepted match (the one exception to
// "members see nobody", the user's own request); the read is mentor_feed, apart from hub_feed, and never kept on the phone.
// The user's two registrations (the same day: "Mentee registration", "Mentor registration & choosing from mentees list"):
// a student registers as a mentee (mentor_ask), a member registers once as a mentor (mentor_join, with the rules and the
// consent), and only a registered mentor offers on a profile from the list; Leave the programme ends it (mentor_quit).
Object.assign(HUB_T, {
  mtTitle: ["Mentorship", "الإرشاد", "Mentorat", "Mentoría", "Mentoria", "رہنمائی پروگرام", "मेंटरशिप", "Mentorship", "मेन्टरशिप", "মেন্টরশিপ"],
  mtHelpName: ["Help a member starting university", "ساعد عضوًا يبدأ دراسته الجامعية", "Aidez un membre qui entre à l'université", "Ayuda a un miembro que empieza la universidad", "Ajude um membro que começa a universidade", "یونیورسٹی شروع کرنے والے رکن کی مدد کریں", "विश्वविद्यालय शुरू करने वाले सदस्य की मदद करें", "Tulungan ang miyembrong magsisimula sa unibersidad", "विश्वविद्यालय सुरु गर्दै गरेको सदस्यलाई सहयोग गर्नुहोस्", "বিশ্ববিদ্যালয় শুরু করা একজন সদস্যকে সাহায্য করুন"],
  mtOpenN: ["Students looking for a mentor: {0}", "طلاب يبحثون عن مرشد: {0}", "Étudiants qui cherchent un mentor : {0}", "Estudiantes que buscan mentor: {0}", "Estudantes à procura de mentor: {0}", "رہنما کی تلاش میں طلبہ: {0}", "मेंटर ढूँढ रहे छात्र: {0}", "Mga estudyanteng naghahanap ng mentor: {0}", "मेन्टर खोजिरहेका विद्यार्थी: {0}", "মেন্টর খুঁজছে এমন শিক্ষার্থী: {0}"],
  mtSee: ["See the students", "عرض الطلاب", "Voir les étudiants", "Ver a los estudiantes", "Ver os estudantes", "طلبہ دیکھیں", "छात्र देखें", "Tingnan ang mga estudyante", "विद्यार्थीहरू हेर्नुहोस्", "শিক্ষার্থীদের দেখুন"],
  mtAsk: ["Register as a mentee", "التسجيل كمسترشد", "S'inscrire comme mentoré", "Inscribirme como mentorizado", "Registar-me como mentorando", "رہنمائی لینے کے لیے رجسٹر کریں", "मेंटी के रूप में पंजीकरण करें", "Magparehistro bilang mentee", "मेन्टीको रूपमा दर्ता गर्नुहोस्", "মেন্টি হিসেবে নিবন্ধন করুন"],
  mtMatches: ["Your matches", "مطابقاتك", "Vos binômes", "Tus emparejamientos", "Os seus pares", "آپ کے جوڑ", "आपकी जोड़ियाँ", "Ang iyong mga kapareha", "तपाईंका जोडी", "আপনার জুটি"],
  mtYourAsk: ["Your request", "طلبك", "Votre demande", "Tu solicitud", "O seu pedido", "آپ کی درخواست", "आपका अनुरोध", "Ang iyong hiling", "तपाईंको अनुरोध", "আপনার অনুরোধ"],
  mtYourOffers: ["Your offers", "عروضك", "Vos propositions", "Tus ofrecimientos", "As suas ofertas", "آپ کی پیشکشیں", "आपके प्रस्ताव", "Ang iyong mga alok", "तपाईंका प्रस्ताव", "আপনার প্রস্তাব"],
  mtStudents: ["Students looking for a mentor", "طلاب يبحثون عن مرشد", "Étudiants qui cherchent un mentor", "Estudiantes que buscan mentor", "Estudantes à procura de mentor", "رہنما کی تلاش میں طلبہ", "मेंटर ढूँढ रहे छात्र", "Mga estudyanteng naghahanap ng mentor", "मेन्टर खोजिरहेका विद्यार्थी", "মেন্টর খুঁজছে এমন শিক্ষার্থী"],
  mtNone: ["No student is looking for a mentor right now.", "لا يوجد طالب يبحث عن مرشد حاليًا.", "Aucun étudiant ne cherche de mentor pour le moment.", "Ahora mismo ningún estudiante busca mentor.", "Neste momento nenhum estudante procura mentor.", "اس وقت کوئی طالب علم رہنما نہیں ڈھونڈ رہا۔", "अभी कोई छात्र मेंटर नहीं ढूँढ रहा।", "Walang estudyanteng naghahanap ng mentor ngayon.", "अहिले कुनै विद्यार्थीले मेन्टर खोजिरहेको छैन।", "এই মুহূর্তে কোনো শিক্ষার্থী মেন্টর খুঁজছে না।"],
  mtProfile: ["Profile {0}", "الملف {0}", "Profil {0}", "Perfil {0}", "Perfil {0}", "پروفائل {0}", "प्रोफ़ाइल {0}", "Profile {0}", "प्रोफाइल {0}", "প্রোফাইল {0}"],
  mtClass: ["Class of {0}", "دفعة {0}", "Promotion {0}", "Promoción {0}", "Turma de {0}", "بیچ {0}", "{0} बैच", "Batch {0}", "ब्याच {0}", "ব্যাচ {0}"],
  mtCanHelp: ["I can help", "يمكنني المساعدة", "Je peux aider", "Puedo ayudar", "Posso ajudar", "مدد کی پیشکش کریں", "मदद की पेशकश करें", "Makakatulong ako", "म सहयोग गर्न सक्छु", "আমি সাহায্য করতে পারি"],
  mtStOffered: ["Offer sent", "تم إرسال العرض", "Proposition envoyée", "Ofrecimiento enviado", "Oferta enviada", "پیشکش بھیج دی گئی", "प्रस्ताव भेजा गया", "Naipadala ang alok", "प्रस्ताव पठाइयो", "প্রস্তাব পাঠানো হয়েছে"],
  mtStProposed: ["With the student", "لدى الطالب", "Chez l'étudiant", "Con el estudiante", "Com o estudante", "طالب علم کے پاس", "छात्र के पास", "Nasa estudyante", "विद्यार्थीसँग", "শিক্ষার্থীর কাছে"],
  mtStMatched: ["Matched", "تمت المطابقة", "Binôme formé", "Emparejados", "Par formado", "جوڑ بن گیا", "जोड़ी बनी", "Nagkapareha", "जोडी बन्यो", "জুটি হয়েছে"],
  mtStDeclined: ["Not this time", "ليس هذه المرة", "Pas cette fois", "Esta vez no", "Desta vez não", "اس بار نہیں", "इस बार नहीं", "Hindi sa ngayon", "यस पटक होइन", "এবার নয়"],
  mtStEnded: ["Ended", "انتهت", "Terminé", "Terminado", "Terminado", "ختم", "समाप्त", "Natapos", "समाप्त", "শেষ"],
  mtAskPending: ["Waiting for our team", "بانتظار فريقنا", "En attente de notre équipe", "Esperando a nuestro equipo", "À espera da nossa equipa", "ہماری ٹیم کا انتظار", "हमारी टीम की प्रतीक्षा", "Hinihintay ang aming team", "हाम्रो टोलीको प्रतीक्षामा", "আমাদের দলের অপেক্ষায়"],
  mtAskOpen: ["Looking for a mentor", "يبحث عن مرشد", "Recherche d'un mentor", "Buscando mentor", "À procura de mentor", "رہنما کی تلاش جاری", "मेंटर की तलाश", "Naghahanap ng mentor", "मेन्टर खोजिँदै", "মেন্টর খোঁজা হচ্ছে"],
  mtYourMentor: ["Your mentor", "مرشدك", "Votre mentor", "Tu mentor", "O seu mentor", "آپ کا رہنما", "आपके मेंटर", "Ang iyong mentor", "तपाईंको मेन्टर", "আপনার মেন্টর"],
  mtYourStudent: ["Your student", "طالبك", "Votre étudiant", "Tu estudiante", "O seu estudante", "آپ کا طالب علم", "आपका छात्र", "Ang iyong estudyante", "तपाईंको विद्यार्थी", "আপনার শিক্ষার্থী"],
  mtWa: ["Message on WhatsApp", "مراسلة عبر واتساب", "Écrire sur WhatsApp", "Escribir por WhatsApp", "Enviar mensagem no WhatsApp", "واٹس ایپ پر پیغام بھیجیں", "WhatsApp पर संदेश भेजें", "Mag-message sa WhatsApp", "WhatsApp मा सन्देश पठाउनुहोस्", "WhatsApp-এ বার্তা পাঠান"],
  mtStepBack: ["Step back", "الانسحاب", "Me retirer", "Retirarme", "Sair", "الگ ہو جائیں", "पीछे हटें", "Umatras", "पछि हट्नुहोस्", "সরে দাঁড়ান"],
  mtStepBackQ: ["Step back from this match?", "الانسحاب من هذه المطابقة؟", "Vous retirer de ce binôme ?", "¿Retirarte de este emparejamiento?", "Sair deste par?", "اس جوڑ سے الگ ہو جائیں؟", "इस जोड़ी से पीछे हटें?", "Umatras sa pagpaparehang ito?", "यो जोडीबाट पछि हट्ने?", "এই জুটি থেকে সরে দাঁড়াবেন?"],
  mtWithdraw: ["Withdraw offer", "سحب العرض", "Retirer la proposition", "Retirar ofrecimiento", "Retirar oferta", "پیشکش واپس لیں", "प्रस्ताव वापस लें", "Bawiin ang alok", "प्रस्ताव फिर्ता लिनुहोस्", "প্রস্তাব প্রত্যাহার করুন"],
  mtWithdrawQ: ["Withdraw this offer?", "سحب هذا العرض؟", "Retirer cette proposition ?", "¿Retirar este ofrecimiento?", "Retirar esta oferta?", "یہ پیشکش واپس لیں؟", "यह प्रस्ताव वापस लें?", "Bawiin ang alok na ito?", "यो प्रस्ताव फिर्ता लिने?", "এই প্রস্তাব প্রত্যাহার করবেন?"],
  mtCloseAsk: ["Close my request", "إغلاق طلبي", "Fermer ma demande", "Cerrar mi solicitud", "Fechar o meu pedido", "میری درخواست بند کریں", "मेरा अनुरोध बंद करें", "Isara ang aking hiling", "मेरो अनुरोध बन्द गर्नुहोस्", "আমার অনুরোধ বন্ধ করুন"],
  mtCloseAskQ: ["Close your request?", "إغلاق طلبك؟", "Fermer votre demande ?", "¿Cerrar tu solicitud?", "Fechar o seu pedido?", "اپنی درخواست بند کریں؟", "अपना अनुरोध बंद करें?", "Isara ang iyong hiling?", "आफ्नो अनुरोध बन्द गर्ने?", "আপনার অনুরোধ বন্ধ করবেন?"],
  mtEdit: ["Change", "تعديل", "Modifier", "Cambiar", "Alterar", "تبدیل کریں", "बदलें", "Baguhin", "परिवर्तन गर्नुहोस्", "পরিবর্তন করুন"],
  mtOffered: ["A member offered to help you", "عرض عضو مساعدتك", "Un membre propose de vous aider", "Un miembro se ofrece a ayudarte", "Um membro ofereceu-se para ajudar", "ایک رکن نے آپ کی مدد کی پیشکش کی", "एक सदस्य ने आपकी मदद की पेशकश की", "May miyembrong nag-alok na tumulong sa iyo", "एक सदस्यले तपाईंलाई सहयोग गर्ने प्रस्ताव गरे", "একজন সদস্য আপনাকে সাহায্য করার প্রস্তাব দিয়েছেন"],
  mtAccept: ["Accept", "قبول", "Accepter", "Aceptar", "Aceitar", "قبول کریں", "स्वीकार करें", "Tanggapin", "स्वीकार गर्नुहोस्", "গ্রহণ করুন"],
  mtNotNow: ["Not now", "ليس الآن", "Pas maintenant", "Ahora no", "Agora não", "ابھی نہیں", "अभी नहीं", "Hindi muna", "अहिले होइन", "এখন নয়"],
  mtNotNowQ: ["Turn down this offer?", "رفض هذا العرض؟", "Refuser cette proposition ?", "¿Rechazar este ofrecimiento?", "Recusar esta oferta?", "یہ پیشکش رد کریں؟", "यह प्रस्ताव अस्वीकार करें?", "Tanggihan ang alok na ito?", "यो प्रस्ताव अस्वीकार गर्ने?", "এই প্রস্তাব ফিরিয়ে দেবেন?"],
  mtCheckQ: ["Still in touch with {0}?", "هل ما زلت على تواصل مع {0}؟", "Toujours en contact avec {0} ?", "¿Sigues en contacto con {0}?", "Ainda em contacto com {0}?", "کیا {0} سے رابطہ ہے؟", "क्या {0} से संपर्क बना है?", "May komunikasyon pa ba kayo ni {0}?", "के {0} सँग सम्पर्क छ?", "{0}-এর সাথে কি যোগাযোগ আছে?"],
  mtYes: ["Yes", "نعم", "Oui", "Sí", "Sim", "ہاں", "हाँ", "Oo", "हो", "হ্যাঁ"],
  mtNotYet: ["Not yet", "ليس بعد", "Pas encore", "Todavía no", "Ainda não", "ابھی تک نہیں", "अभी तक नहीं", "Hindi pa", "अहिलेसम्म छैन", "এখনো না"],
  mtNeedHelp: ["I need help from the team", "أحتاج مساعدة الفريق", "J'ai besoin de l'équipe", "Necesito ayuda del equipo", "Preciso de ajuda da equipa", "مجھے ٹیم کی مدد چاہیے", "मुझे टीम की मदद चाहिए", "Kailangan ko ng tulong ng team", "मलाई टोलीको सहयोग चाहिन्छ", "আমার দলের সাহায্য দরকার"],
  hpQuestions: ["Questions and coaching", "أسئلة وتوجيه", "Questions et conseils", "Preguntas y orientación", "Perguntas e orientação", "سوالات اور رہنمائی", "सवाल और मार्गदर्शन", "Mga tanong at gabay", "प्रश्न र मार्गदर्शन", "প্রশ্ন ও পরামর্শ"],
  hpSubjects: ["Choosing subjects", "اختيار المواد", "Choix des matières", "Elegir asignaturas", "Escolher disciplinas", "مضامین کا انتخاب", "विषय चुनना", "Pagpili ng mga subject", "विषय छनोट", "বিষয় বাছাই"],
  hpCv: ["CV review", "مراجعة السيرة الذاتية", "Relecture du CV", "Revisión del CV", "Revisão do CV", "سی وی کا جائزہ", "CV की समीक्षा", "Pagsusuri ng CV", "CV समीक्षा", "সিভি পর্যালোচনা"],
  hpInternship: ["Summer internships", "التدريب الصيفي", "Stages d'été", "Prácticas de verano", "Estágios de verão", "گرمیوں کی انٹرن شپ", "ग्रीष्मकालीन इंटर्नशिप", "Summer internship", "ग्रीष्मकालीन इन्टर्नसिप", "গ্রীষ্মকালীন ইন্টার্নশিপ"],
  hpJob: ["First job", "الوظيفة الأولى", "Premier emploi", "Primer empleo", "Primeiro emprego", "پہلی نوکری", "पहली नौकरी", "Unang trabaho", "पहिलो जागिर", "প্রথম চাকরি"],
  hpUnilife: ["University life", "الحياة الجامعية", "Vie universitaire", "Vida universitaria", "Vida universitária", "یونیورسٹی کی زندگی", "विश्वविद्यालय जीवन", "Buhay sa unibersidad", "विश्वविद्यालय जीवन", "বিশ্ববিদ্যালয় জীবন"],
  hpCity: ["Settling into the city", "الاستقرار في المدينة", "S'installer dans la ville", "Instalarse en la ciudad", "Instalar-se na cidade", "شہر میں بسنا", "शहर में बसना", "Pag-aangkop sa lungsod", "सहरमा बसोबास", "শহরে মানিয়ে নেওয়া"],
  hpTalk: ["Someone to talk to", "شخص للتحدث معه", "Quelqu'un à qui parler", "Alguien con quien hablar", "Alguém com quem falar", "بات کرنے کے لیے کوئی", "बात करने के लिए कोई", "Makakausap", "कुरा गर्ने कोही", "কথা বলার মতো কেউ"],
  lkUni: ["Same university", "الجامعة نفسها", "Même université", "Misma universidad", "Mesma universidade", "وہی یونیورسٹی", "वही विश्वविद्यालय", "Parehong unibersidad", "उही विश्वविद्यालय", "একই বিশ্ববিদ্যালয়"],
  lkField: ["Same or a related degree", "التخصص نفسه أو قريب منه", "Diplôme identique ou proche", "Misma carrera o afín", "Mesmo curso ou afim", "وہی یا ملتی جلتی ڈگری", "वही या मिलती-जुलती डिग्री", "Pareho o kaugnay na kurso", "उही वा मिल्दोजुल्दो डिग्री", "একই বা সম্পর্কিত ডিগ্রি"],
  lkCity: ["Lived or studied in this city", "عشت أو درست في هذه المدينة", "J'ai vécu ou étudié dans cette ville", "Viví o estudié en esta ciudad", "Vivi ou estudei nesta cidade", "اس شہر میں رہائش یا تعلیم", "इस शहर में रहना या पढ़ाई", "Nanirahan o nag-aral sa lungsod na ito", "यो सहरमा बसेको वा पढेको", "এই শহরে থেকেছি বা পড়েছি"],
  lkIndustry: ["Work in this field", "أعمل في هذا المجال", "Je travaille dans ce domaine", "Trabajo en este campo", "Trabalho nesta área", "اسی شعبے میں کام", "इसी क्षेत्र में काम", "Nagtatrabaho sa larangang ito", "यही क्षेत्रमा काम", "এই ক্ষেত্রে কাজ করি"],
  lkExperience: ["Other relevant experience", "خبرة أخرى ذات صلة", "Autre expérience utile", "Otra experiencia útil", "Outra experiência relevante", "دیگر متعلقہ تجربہ", "अन्य संबंधित अनुभव", "Ibang kaugnay na karanasan", "अन्य सम्बन्धित अनुभव", "অন্যান্য প্রাসঙ্গিক অভিজ্ঞতা"],
  mtLinksQ: ["How do you know this path?", "كيف تعرف هذا المسار؟", "Comment connaissez-vous ce parcours ?", "¿Cómo conoces este camino?", "Como conhece este percurso?", "آپ اس راستے کو کیسے جانتے ہیں؟", "आप इस राह को कैसे जानते हैं?", "Paano mo kilala ang landas na ito?", "तपाईं यो बाटो कसरी चिन्नुहुन्छ?", "আপনি এই পথ কীভাবে চেনেন?"],
  mtHelpsQ: ["How can you help?", "كيف يمكنك المساعدة؟", "Comment pouvez-vous aider ?", "¿Cómo puedes ayudar?", "Como pode ajudar?", "آپ کیسے مدد کر سکتے ہیں؟", "आप कैसे मदद कर सकते हैं?", "Paano ka makakatulong?", "तपाईं कसरी सहयोग गर्न सक्नुहुन्छ?", "আপনি কীভাবে সাহায্য করতে পারেন?"],
  mtNoteQ: ["How could your experience help?", "كيف يمكن لخبرتك أن تساعد؟", "En quoi votre expérience peut-elle aider ?", "¿Cómo puede ayudar tu experiencia?", "Como pode a sua experiência ajudar?", "آپ کا تجربہ کیسے مدد کر سکتا ہے؟", "आपका अनुभव कैसे मदद कर सकता है?", "Paano makakatulong ang iyong karanasan?", "तपाईंको अनुभवले कसरी सहयोग गर्न सक्छ?", "আপনার অভিজ্ঞতা কীভাবে সাহায্য করতে পারে?"],
  mtSend: ["Send", "إرسال", "Envoyer", "Enviar", "Enviar", "بھیجیں", "भेजें", "Ipadala", "पठाउनुहोस्", "পাঠান"],
  mtUni: ["University", "الجامعة", "Université", "Universidad", "Universidade", "یونیورسٹی", "विश्वविद्यालय", "Unibersidad", "विश्वविद्यालय", "বিশ্ববিদ্যালয়"],
  mtField: ["Field of study", "التخصص", "Domaine d'études", "Carrera", "Curso", "شعبۂ تعلیم", "अध्ययन का क्षेत्र", "Kurso", "अध्ययनको क्षेत्र", "পড়ার বিষয়"],
  mtCity: ["City", "المدينة", "Ville", "Ciudad", "Cidade", "شہر", "शहर", "Lungsod", "सहर", "শহর"],
  mtCountry: ["Country", "الدولة", "Pays", "País", "País", "ملک", "देश", "Bansa", "देश", "দেশ"],
  mtYear: ["Starting year", "سنة البدء", "Année de début", "Año de inicio", "Ano de início", "آغاز کا سال", "शुरुआत का वर्ष", "Taon ng pagsisimula", "सुरु हुने वर्ष", "শুরুর বছর"],
  mtWantQ: ["What would help you?", "ما الذي سيساعدك؟", "Qu'est-ce qui vous aiderait ?", "¿Qué te ayudaría?", "O que o ajudaria?", "آپ کو کس چیز سے مدد ملے گی؟", "आपको किससे मदद मिलेगी?", "Ano ang makakatulong sa iyo?", "तपाईंलाई केले सहयोग गर्छ?", "কী আপনাকে সাহায্য করবে?"],
  mtGoal: ["Your goal", "هدفك", "Votre objectif", "Tu objetivo", "O seu objetivo", "آپ کا مقصد", "आपका लक्ष्य", "Ang iyong layunin", "तपाईंको लक्ष्य", "আপনার লক্ষ্য"],
  mtPref: ["Mentor you prefer", "المرشد الذي تفضّله", "Mentor souhaité", "Mentor que prefieres", "Mentor que prefere", "پسندیدہ رہنما", "पसंदीदा मेंटर", "Mentor na gusto mo", "रुचाइएको मेन्टर", "পছন্দের মেন্টর"],
  mtPrefAny: ["Either", "لا فرق", "Peu importe", "Me da igual", "Tanto faz", "کوئی بھی", "कोई भी", "Kahit sino", "जो भए पनि", "যে কেউ"],
  mtPrefF: ["A woman", "امرأة", "Une femme", "Una mujer", "Uma mulher", "خاتون", "महिला", "Babae", "महिला", "নারী"],
  mtPrefM: ["A man", "رجل", "Un homme", "Un hombre", "Um homem", "مرد", "पुरुष", "Lalaki", "पुरुष", "পুরুষ"],
  mtRules: ["Mentorship rules", "قواعد الإرشاد", "Règles du mentorat", "Normas de la mentoría", "Regras da mentoria", "رہنمائی کے اصول", "मेंटरशिप के नियम", "Mga patakaran ng mentorship", "मेन्टरशिपका नियम", "মেন্টরশিপের নিয়ম"],
  mtR1: ["Be kind and respectful, and keep it about study, work and student life.", "اللطف والاحترام، والحديث عن الدراسة والعمل والحياة الجامعية.", "Soyez bienveillant et respectueux, et restez sur les études, le travail et la vie étudiante.", "Sé amable y respetuoso, y habla de estudios, trabajo y vida de estudiante.", "Seja simpático e respeitoso, e fale de estudos, trabalho e vida de estudante.", "مہربان اور باادب رہیں، اور بات تعلیم، کام اور طالب علمی کی زندگی تک رکھیں۔", "विनम्र और सम्मानजनक रहें, और बात पढ़ाई, काम और छात्र जीवन तक रखें।", "Maging mabait at magalang, at panatilihin ang usapan sa pag-aaral, trabaho at buhay-estudyante.", "दयालु र सम्मानजनक हुनुहोस्, र कुरा पढाइ, काम र विद्यार्थी जीवनमै राख्नुहोस्।", "সদয় ও সম্মানজনক থাকুন, এবং আলোচনা পড়াশোনা, কাজ ও ছাত্রজীবনের মধ্যে রাখুন।"],
  mtR2: ["Never ask for or offer money, gifts or favours.", "لا طلب ولا عرض لمال أو هدايا أو خدمات.", "Ne demandez ni n'offrez jamais d'argent, de cadeaux ou de faveurs.", "Nunca pidas ni ofrezcas dinero, regalos ni favores.", "Nunca peça nem ofereça dinheiro, presentes ou favores.", "کبھی پیسے، تحفے یا احسان نہ مانگیں نہ پیش کریں۔", "कभी पैसे, तोहफ़े या एहसान न माँगें, न दें।", "Huwag humingi o mag-alok ng pera, regalo o pabor.", "पैसा, उपहार वा अनुग्रह कहिल्यै नमाग्नुहोस्, नदिनुहोस्।", "কখনো টাকা, উপহার বা সুবিধা চাইবেন না বা দেবেন না।"],
  mtR3: ["Keep what you learn about each other private.", "ما تعرفانه عن بعضكما يبقى بينكما.", "Gardez pour vous ce que vous apprenez l'un de l'autre.", "Guarda en privado lo que sepáis el uno del otro.", "Mantenha em privado o que souberem um do outro.", "ایک دوسرے کے بارے میں جو جانیں اسے راز رکھیں۔", "एक-दूसरे के बारे में जो जानें, उसे निजी रखें।", "Panatilihing pribado ang nalalaman ninyo tungkol sa isa't isa.", "एकअर्काबारे थाहा पाएका कुरा गोप्य राख्नुहोस्।", "একে অপরের সম্পর্কে যা জানবেন, তা গোপন রাখুন।"],
  mtR4: ["Meet online or in a public place.", "اللقاء عبر الإنترنت أو في مكان عام.", "Rencontrez-vous en ligne ou dans un lieu public.", "Quedad en línea o en un lugar público.", "Encontrem-se online ou num local público.", "آن لائن یا کسی عوامی جگہ پر ملیں۔", "ऑनलाइन या किसी सार्वजनिक जगह पर मिलें।", "Magkita online o sa pampublikong lugar.", "अनलाइन वा सार्वजनिक ठाउँमा भेट्नुहोस्।", "অনলাইনে বা জনসমাগমের জায়গায় দেখা করুন।"],
  mtR5: ["Tell our team if anything feels wrong. You can step back at any time.", "يمكن إبلاغ فريقنا بأي أمر مقلق، والانسحاب متاح في أي وقت.", "Prévenez notre équipe si quelque chose ne va pas. Vous pouvez vous retirer à tout moment.", "Avisa a nuestro equipo si algo no va bien. Puedes retirarte cuando quieras.", "Avise a nossa equipa se algo não estiver bem. Pode sair a qualquer momento.", "اگر کچھ غلط لگے تو ہماری ٹیم کو بتائیں۔ آپ کسی بھی وقت الگ ہو سکتے ہیں۔", "कुछ भी ठीक न लगे तो हमारी टीम को बताएँ। आप कभी भी पीछे हट सकते हैं।", "Sabihan ang aming team kung may hindi tama. Maaari kang umatras anumang oras.", "केही ठीक नलागे हाम्रो टोलीलाई भन्नुहोस्। तपाईं जुनसुकै बेला पछि हट्न सक्नुहुन्छ।", "কিছু ঠিক না লাগলে আমাদের দলকে জানান। আপনি যেকোনো সময় সরে দাঁড়াতে পারেন।"],
  mtAgree: ["I agree to the mentorship rules and to sharing my first name and WhatsApp number with my match once we both accept.", "أوافق على قواعد الإرشاد وعلى مشاركة اسمي الأول ورقم واتساب الخاص بي مع من تتم مطابقتي معه بعد قبولنا كلينا.", "J'accepte les règles du mentorat et le partage de mon prénom et de mon numéro WhatsApp avec mon binôme une fois que nous aurons tous deux accepté.", "Acepto las normas de la mentoría y compartir mi nombre y mi número de WhatsApp con mi pareja de mentoría cuando ambos aceptemos.", "Aceito as regras da mentoria e a partilha do meu primeiro nome e número de WhatsApp com o meu par quando ambos aceitarmos.", "میں رہنمائی کے اصولوں سے اور دونوں کی منظوری کے بعد اپنا پہلا نام اور واٹس ایپ نمبر اپنے جوڑ کے ساتھ شیئر کرنے پر متفق ہوں۔", "मैं मेंटरशिप के नियमों से और हम दोनों के स्वीकार करने के बाद अपना पहला नाम और WhatsApp नंबर अपनी जोड़ी के साथ साझा करने पर सहमत हूँ।", "Sumasang-ayon ako sa mga patakaran ng mentorship at sa pagbabahagi ng aking unang pangalan at WhatsApp number sa aking kapareha kapag pareho kaming pumayag.", "म मेन्टरशिपका नियम र हामी दुवैले स्वीकार गरेपछि मेरो पहिलो नाम र WhatsApp नम्बर मेरो जोडीसँग साझा गर्न सहमत छु।", "আমি মেন্টরশিপের নিয়ম মানছি এবং আমরা দুজনেই রাজি হলে আমার প্রথম নাম ও WhatsApp নম্বর আমার জুটির সাথে শেয়ার করতে সম্মত।"],
  mtFill: ["Please fill this in.", "يرجى تعبئة هذا الحقل.", "Veuillez remplir ce champ.", "Rellena este campo.", "Preencha este campo.", "براہ کرم یہ پُر کریں۔", "कृपया इसे भरें।", "Pakipunan ito.", "कृपया यो भर्नुहोस्।", "অনুগ্রহ করে এটি পূরণ করুন।"],
  mtPickOne: ["Please pick at least one.", "يرجى اختيار واحد على الأقل.", "Choisissez-en au moins un.", "Elige al menos uno.", "Escolha pelo menos um.", "کم از کم ایک چنیں۔", "कम से कम एक चुनें।", "Pumili ng kahit isa.", "कम्तीमा एउटा छान्नुहोस्।", "অন্তত একটি বেছে নিন।"],
  mtTick: ["Please tick to agree.", "يرجى وضع علامة للموافقة.", "Cochez pour accepter.", "Marca la casilla para aceptar.", "Assinale para aceitar.", "اتفاق کے لیے نشان لگائیں۔", "सहमति के लिए टिक करें।", "Lagyan ng tsek para pumayag.", "सहमतिका लागि टिक लगाउनुहोस्।", "সম্মতি দিতে টিক দিন।"],
  mtGone: ["This is no longer open.", "لم يعد هذا متاحًا.", "Ce n'est plus ouvert.", "Ya no está abierto.", "Já não está disponível.", "یہ اب دستیاب نہیں۔", "यह अब उपलब्ध नहीं है।", "Hindi na ito bukas.", "यो अब उपलब्ध छैन।", "এটি আর খোলা নেই।"],
  mtExists: ["You already have a request.", "لديك طلب بالفعل.", "Vous avez déjà une demande.", "Ya tienes una solicitud.", "Já tem um pedido.", "آپ کی ایک درخواست پہلے سے موجود ہے۔", "आपका एक अनुरोध पहले से है।", "Mayroon ka nang hiling.", "तपाईंको अनुरोध पहिले नै छ।", "আপনার একটি অনুরোধ আগে থেকেই আছে।"],
  mtLimit: ["You have sent many offers today. Please try again tomorrow.", "أرسلت عروضًا كثيرة اليوم. يرجى المحاولة غدًا.", "Vous avez envoyé beaucoup de propositions aujourd'hui. Réessayez demain.", "Has enviado muchos ofrecimientos hoy. Inténtalo mañana.", "Enviou muitas ofertas hoje. Tente amanhã.", "آپ نے آج بہت سی پیشکشیں بھیجی ہیں۔ کل دوبارہ کوشش کریں۔", "आपने आज कई प्रस्ताव भेजे हैं। कल फिर कोशिश करें।", "Marami ka nang naipadalang alok ngayon. Subukan ulit bukas.", "तपाईंले आज धेरै प्रस्ताव पठाउनुभयो। भोलि फेरि प्रयास गर्नुहोस्।", "আপনি আজ অনেক প্রস্তাব পাঠিয়েছেন। আগামীকাল আবার চেষ্টা করুন।"],
  mtRegMentor: ["Register as a mentor", "التسجيل كمرشد", "S'inscrire comme mentor", "Inscribirme como mentor", "Registar-me como mentor", "بطور رہنما رجسٹر کریں", "मेंटर के रूप में पंजीकरण करें", "Magparehistro bilang mentor", "मेन्टरको रूपमा दर्ता गर्नुहोस्", "মেন্টর হিসেবে নিবন্ধন করুন"],
  mtYouMentor: ["You as a mentor", "أنت كمرشد", "Vous, mentor", "Tú como mentor", "Você como mentor", "آپ بطور رہنما", "मेंटर के रूप में आप", "Ikaw bilang mentor", "मेन्टरको रूपमा तपाईं", "মেন্টর হিসেবে আপনি"],
  mtMUni: ["Where you studied", "أين درست", "Où vous avez étudié", "Dónde estudiaste", "Onde estudou", "آپ نے کہاں تعلیم حاصل کی", "आपने कहाँ पढ़ाई की", "Saan ka nag-aral", "तपाईंले कहाँ पढ्नुभयो", "আপনি কোথায় পড়েছেন"],
  mtMField: ["What you studied", "ماذا درست", "Ce que vous avez étudié", "Qué estudiaste", "O que estudou", "آپ نے کیا پڑھا", "आपने क्या पढ़ा", "Ano ang iyong pinag-aralan", "तपाईंले के पढ्नुभयो", "আপনি কী পড়েছেন"],
  mtMWork: ["Your work or industry", "عملك أو مجالك", "Votre métier ou secteur", "Tu trabajo o sector", "O seu trabalho ou setor", "آپ کا کام یا شعبہ", "आपका काम या उद्योग", "Ang iyong trabaho o industriya", "तपाईंको काम वा क्षेत्र", "আপনার কাজ বা খাত"],
  mtMPlaces: ["Cities and countries you lived or studied in", "المدن والدول التي عشت أو درست فيها", "Villes et pays où vous avez vécu ou étudié", "Ciudades y países donde viviste o estudiaste", "Cidades e países onde viveu ou estudou", "وہ شہر اور ممالک جہاں آپ رہے یا پڑھے", "शहर और देश जहाँ आप रहे या पढ़े", "Mga lungsod at bansang tinirhan o pinag-aralan mo", "तपाईं बसेका वा पढेका सहर र देश", "যেসব শহর ও দেশে আপনি থেকেছেন বা পড়েছেন"],
  mtMAbout: ["How your experience could help students", "كيف يمكن لخبرتك أن تساعد الطلاب", "En quoi votre expérience peut aider des étudiants", "Cómo puede ayudar tu experiencia a los estudiantes", "Como a sua experiência pode ajudar estudantes", "آپ کا تجربہ طلبہ کی کیسے مدد کر سکتا ہے", "आपका अनुभव छात्रों की कैसे मदद कर सकता है", "Paano makakatulong ang karanasan mo sa mga estudyante", "तपाईंको अनुभवले विद्यार्थीलाई कसरी सहयोग गर्न सक्छ", "আপনার অভিজ্ঞতা শিক্ষার্থীদের কীভাবে সাহায্য করতে পারে"],
  mtLeaveProg: ["Leave the programme", "مغادرة البرنامج", "Quitter le programme", "Dejar el programa", "Sair do programa", "پروگرام چھوڑ دیں", "कार्यक्रम छोड़ें", "Umalis sa programa", "कार्यक्रम छोड्नुहोस्", "প্রোগ্রাম ছেড়ে দিন"],
  mtLeaveProgQ: ["Leave the programme? Your offers are withdrawn and your matches end.", "مغادرة البرنامج؟ ستُسحب عروضك وتنتهي مطابقاتك.", "Quitter le programme ? Vos propositions sont retirées et vos binômes prennent fin.", "¿Dejar el programa? Tus ofrecimientos se retiran y tus emparejamientos terminan.", "Sair do programa? As suas ofertas são retiradas e os seus pares terminam.", "پروگرام چھوڑیں؟ آپ کی پیشکشیں واپس اور جوڑ ختم ہو جائیں گے۔", "कार्यक्रम छोड़ें? आपके प्रस्ताव वापस और जोड़ियाँ समाप्त हो जाएँगी।", "Umalis sa programa? Babawiin ang iyong mga alok at matatapos ang iyong mga pagpapareha.", "कार्यक्रम छोड्ने? तपाईंका प्रस्ताव फिर्ता हुनेछन् र जोडी अन्त्य हुनेछन्।", "প্রোগ্রাম ছাড়বেন? আপনার প্রস্তাব প্রত্যাহার হবে এবং জুটি শেষ হবে।"],
});
const MT_HELPS = ['questions', 'subjects', 'cv', 'internship', 'job', 'unilife', 'city', 'talk'];
const MT_HELP_K = { questions: 'hpQuestions', subjects: 'hpSubjects', cv: 'hpCv', internship: 'hpInternship', job: 'hpJob', unilife: 'hpUnilife', city: 'hpCity', talk: 'hpTalk' };
const MT_LINKS = ['uni', 'field', 'city', 'industry', 'experience'];
const MT_LINK_K = { uni: 'lkUni', field: 'lkField', city: 'lkCity', industry: 'lkIndustry', experience: 'lkExperience' };
const MT_RULES = ['mtR1', 'mtR2', 'mtR3', 'mtR4', 'mtR5'];
const MT_CHECKS = [['yes', 'mtYes'], ['not_yet', 'mtNotYet'], ['help', 'mtNeedHelp']];

function _mtData() { const c = _hCust(), m = S._mt; return c && m && m.forId === c.id && !m.off ? m.d : null; }
function _mtCountry(code) { const r = (typeof NATIONALITIES !== 'undefined' ? NATIONALITIES : []).find((x) => x[0] === code); return r ? nationalityLabel(r[1]) : String(code || ''); }
function _mtChips(list, K) {
  const a = (Array.isArray(list) ? list : []).filter((k) => K[k]);
  return a.length ? `<ul class="mt-chips">${a.map((k) => `<li>${esc(_hT(K[k]))}</li>`).join('')}</ul>` : '';
}
function _mtWhere(p) { return `<bdi>${esc(p.city || '')}</bdi>, ${esc(_mtCountry(p.country))} · ${esc(_hF('mtClass', p.class_year))}`; }

// The read: when the tab paints, and again after two minutes or a write. A database without the programme hides it.
async function _mtFetch(force) {
  const c = _hCust(); if (!c || !sb || S._mtBusy) return;
  const m = S._mt;
  if (!force && m && m.forId === c.id && Date.now() - m.at < 12e4) return;
  S._mtBusy = true;
  let r; try { r = await sb.rpc('mentor_feed', _hTok(c)); } catch (e) { r = { error: e }; }
  S._mtBusy = false;
  const now = _hCust(); if (!now || now.id !== c.id) return;
  const e = r && r.error;
  if (e && (e.code === 'PGRST202' || e.code === '42883')) S._mt = { forId: c.id, at: Date.now(), off: true };
  else if (r && !e && r.data && r.data.ok === true) S._mt = { forId: c.id, at: Date.now(), d: r.data };
  else if (m && m.forId === c.id && m.d) m.at = Date.now();
  else S._mt = { forId: c.id, at: Date.now(), d: null };
  if (S.custTab === 'members') _hubRender();
}

// The feed's card: what waits for the member first (an offer to answer, a check due), then the way in.
function _mtDue(d) {
  const a = d.ask;
  return [...((a && a.matches) || []).filter((x) => x.due), ...(d.offers || []).filter((x) => x.status === 'matched' && x.due)];
}
function _mtCardHtml() {
  const d = _mtData(); if (!d) return '';
  const a = d.ask, n = (d.profiles || []).length, due = _mtDue(d);
  const line = a && Array.isArray(a.proposed) && a.proposed.length ? _hT('mtOffered') : due.length ? _hF('mtCheckQ', due[0].name || '') : '';
  return `<div class="hub-card mt-card"><span class="hub-k">${_cuIc('people', 16)} ${_hT('mtTitle')}</span>
    <strong class="hub-name">${_hT('mtHelpName')}</strong>
    ${n ? `<div class="hub-meta">${esc(_hF('mtOpenN', n))}</div>` : ''}
    ${line ? `<div class="mt-alert" role="status"><bdi>${esc(line)}</bdi></div>` : ''}
    ${d.mentor ? '' : `<button type="button" class="btn-primary hub-wide" data-on-click="${_on('_mtJoinOpen', 0)}">${_hT('mtRegMentor')}</button>`}
    <button type="button" class="${d.mentor ? 'btn-primary' : 'btn-secondary'} hub-wide" data-on-click="${_on('_mtOpen')}">${_hT('mtSee')}</button>
    ${a ? '' : `<button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_mtAskOpen')}">${_hT('mtAsk')}</button>`}</div>`;
}
function _mtOpen() { S._hubView = 'mentor'; _hubRender(); _mtFetch(true); try { window.scrollTo(0, 0); } catch (_) {} }
function _mtClose() { S._hubView = null; _hubRender(); }

// The page.
function _mtHtml() {
  const d = _mtData();
  const head = `<div class="hub-card hub-flat mt-head"><h2 class="mt-h1">${_hT('mtTitle')}</h2><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_mtClose')}">${_hT('close')}</button></div>`;
  if (!d) {
    const m = S._mt;
    return head + (m && m.d === null && !S._mtBusy
      ? `<div class="hub-card" role="status"><strong class="hub-name">${_hT('err')}</strong><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_mtRetry')}">${_hT('retry')}</button></div>`
      : _skelHtml(2, 'hub-skel'));
  }
  const a = d.ask, offers = Array.isArray(d.offers) ? d.offers : [], profiles = Array.isArray(d.profiles) ? d.profiles : [];
  const matches = [
    ...((a && a.matches) || []).map((x) => _mtMatchHtml(x, 'student', null)),
    ...offers.filter((o) => o.status === 'matched').map((o) => _mtMatchHtml(o, 'mentor', o)),
  ];
  const mine = offers.filter((o) => o.status !== 'matched');
  return [
    head,
    matches.length ? `<h3 class="mt-h2">${_hT('mtMatches')}</h3>${matches.join('')}` : '',
    a ? `<h3 class="mt-h2">${_hT('mtYourAsk')}</h3>${_mtAskHtml(a)}` : '',
    `<h3 class="mt-h2">${_hT('mtYouMentor')}</h3>${_mtMentorHtml(d.mentor)}`,
    mine.length ? `<h3 class="mt-h2">${_hT('mtYourOffers')}</h3><div class="hub-card mt-list">${mine.map(_mtOfferRow).join('')}</div>` : '',
    `<h3 class="mt-h2">${_hT('mtStudents')}</h3>`,
    profiles.length ? profiles.map(_mtProfHtml).join('') : `<div class="hub-card hub-flat"><span class="hub-meta">${_hT('mtNone')}</span></div>`,
    a ? '' : `<div class="hub-card hub-flat"><button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_mtAskOpen')}">${_hT('mtAsk')}</button></div>`,
  ].join('');
}
function _mtRetry() { _mtFetch(true); }
function _mtMentorHtml(m) {
  if (!m) return `<div class="hub-card hub-flat"><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_mtJoinOpen', 0)}">${_hT('mtRegMentor')}</button></div>`;
  const line = [m.work, m.places].filter(Boolean).map((x) => `<bdi>${esc(x)}</bdi>`).join(' · ');
  return `<div class="hub-card mt-me"><strong class="hub-name"><bdi>${esc(m.university || '')}</bdi></strong><div class="mt-line"><bdi>${esc(m.field || '')}</bdi></div>
    ${line ? `<div class="hub-meta">${line}</div>` : ''}${_mtChips(m.helps, MT_HELP_K)}
    <button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_mtJoinOpen', 0)}">${_hT('mtEdit')}</button>
    <button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_mtQuit')}">${_hT('mtLeaveProg')}</button></div>`;
}
function _mtMatchHtml(x, side, o) {
  const wa = String(x.wa || '').replace(/\D/g, '');
  const chk = x.due ? `<div class="mt-check"><span class="hub-k"><bdi>${esc(_hF('mtCheckQ', x.name || ''))}</bdi></span><div class="mt-acts">${MT_CHECKS.map(([v, k]) => `<button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_mtCheck', x.id, v)}">${_hT(k)}</button>`).join('')}</div></div>` : '';
  const about = side === 'mentor' && o
    ? `<div class="mt-line">${esc(_hF('mtProfile', o.num))} · <bdi>${esc(o.university || '')}</bdi></div><div class="hub-meta"><bdi>${esc(o.field || '')}</bdi> · ${_mtWhere(o)}</div>`
    : `${x.summary ? `<p class="mt-goal"><bdi>${esc(x.summary)}</bdi></p>` : ''}${_mtChips(x.links, MT_LINK_K)}`;
  return `<div class="hub-card mt-match"><span class="hub-k">${_hT(side === 'student' ? 'mtYourMentor' : 'mtYourStudent')}</span>
    <strong class="hub-name"><bdi>${esc(x.name || '')}</bdi></strong>${about}
    ${wa ? `<a class="btn-primary hub-wide hub-link mt-wa" href="https://wa.me/${esc(wa)}" target="_blank" rel="noopener">${_cuIc('chat', 16)} ${_hT('mtWa')}</a>` : ''}
    ${chk}<button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_mtLeave', x.id, 'match')}">${_hT('mtStepBack')}</button></div>`;
}
function _mtAskHtml(a) {
  const st = a.status === 'pending' ? 'mtAskPending' : a.status === 'matched' ? 'mtStMatched' : 'mtAskOpen';
  const props = (Array.isArray(a.proposed) ? a.proposed : []).map((p) => `<div class="mt-sub" role="group" aria-label="${esc(_hT('mtOffered'))}">
      <strong class="mt-line">${_hT('mtOffered')}</strong>${p.summary ? `<p class="mt-goal"><bdi>${esc(p.summary)}</bdi></p>` : ''}
      ${_mtChips(p.links, MT_LINK_K)}${_mtChips(p.helps, MT_HELP_K)}
      <div class="hub-slide-nav"><button type="button" class="btn-secondary" data-on-click="${_on('_mtAnswer', p.id, false)}">${_hT('mtNotNow')}</button><button type="button" class="btn-primary" data-on-click="${_on('_mtAnswer', p.id, true)}">${_hT('mtAccept')}</button></div></div>`).join('');
  return `<div class="hub-card mt-ask"><span class="mt-pill">${_hT(st)}</span>
    ${a.num ? `<span class="hub-k">${esc(_hF('mtProfile', a.num))}</span>` : ''}
    <strong class="hub-name"><bdi>${esc(a.university || '')}</bdi></strong><div class="mt-line"><bdi>${esc(a.field || '')}</bdi></div>
    <div class="hub-meta">${_mtWhere(a)}</div>${_mtChips(a.helps, MT_HELP_K)}${a.goal ? `<p class="mt-goal"><bdi>${esc(a.goal)}</bdi></p>` : ''}
    ${props}
    ${a.status === 'pending' ? `<button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_mtAskOpen')}">${_hT('mtEdit')}</button>` : ''}
    <button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_mtLeave', null, 'ask')}">${_hT('mtCloseAsk')}</button></div>`;
}
function _mtOfferRow(o) {
  const st = o.status === 'proposed' ? 'mtStProposed' : o.status === 'declined' ? 'mtStDeclined' : o.status === 'ended' ? 'mtStEnded' : 'mtStOffered';
  const live = o.status === 'offered' || o.status === 'proposed';
  return `<div class="mt-row"><div class="mt-row-t"><strong>${esc(_hF('mtProfile', o.num))}</strong><span><bdi>${esc(o.university || '')}</bdi> · <bdi>${esc(o.field || '')}</bdi></span><span class="mt-pill">${_hT(st)}</span></div>
    ${live ? `<button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_mtLeave', o.id, 'offer')}">${_hT('mtWithdraw')}</button>` : ''}</div>`;
}
function _mtProfHtml(p) {
  const st = p.offered;
  return `<div class="hub-card mt-prof"><span class="hub-k">${esc(_hF('mtProfile', p.num))}</span>
    <strong class="hub-name"><bdi>${esc(p.university || '')}</bdi></strong><div class="mt-line"><bdi>${esc(p.field || '')}</bdi></div>
    <div class="hub-meta">${_mtWhere(p)}</div>${_mtChips(p.helps, MT_HELP_K)}${p.goal ? `<p class="mt-goal"><bdi>${esc(p.goal)}</bdi></p>` : ''}
    ${st ? `<span class="mt-pill">${_hT(st === 'matched' ? 'mtStMatched' : st === 'proposed' ? 'mtStProposed' : 'mtStOffered')}</span>`
      : `<button type="button" class="btn-primary hub-wide" data-on-click="${_on('_mtOfferOpen', p.num)}">${_hT('mtCanHelp')}</button>`}</div>`;
}

// ── The two forms, centred pop-ups in the app's dialog host ──────────────────────────────────────
function _mtModal(id, title, body, go) {
  const m = document.getElementById('confirm-modal'); if (!m) return;
  m.style.display = 'block';
  m.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_mtBack', _EV, _EL)}"><div class="confirm-box mt-box" role="dialog" aria-modal="true" aria-labelledby="${id}-t">
    <div class="chrome-dh10"><div class="chrome-dt" id="${id}-t">${esc(title)}</div><button type="button" data-on-click="${_on('closeConfirm')}" aria-label="${esc(t('closeBtn'))}" class="chrome-xt x-close">&times;</button></div>
    <div class="chrome-dbody mt-form" id="${id}">${body}</div>
    <div class="chrome-dact"><button type="button" class="btn-secondary" data-on-click="${_on('closeConfirm')}">${esc(t('cancelBtn'))}</button><button type="button" class="btn-primary chrome-mw100" id="${id}-go" data-on-click="${_on(go)}">${_hT('mtSend')}</button></div></div></div>`;
  const f = m.querySelector('.mt-form input, .mt-form .mt-chip'); if (f) try { f.focus({ preventScroll: true }); } catch (_) {}
}
function _mtBack(ev, el) { if (ev && ev.target === el) closeConfirm(); }
function _mtChipGroup(key, keys, K, on, lbl) {
  return `<div class="pg-field" data-mt="${key}"><span class="mt-lbl" id="mt-${key}-l">${esc(lbl)}</span><div class="mt-picks" role="group" aria-labelledby="mt-${key}-l">${keys.map((k) => `<button type="button" class="mt-chip${on.includes(k) ? ' on' : ''}" aria-pressed="${on.includes(k)}" data-k="${k}" data-on-click="${_on('_mtChip', _EL)}">${esc(_hT(K[k]))}</button>`).join('')}</div></div>`;
}
function _mtChip(el) {
  if (!el) return;
  const on = el.getAttribute('aria-pressed') !== 'true';
  el.setAttribute('aria-pressed', String(on)); el.classList.toggle('on', on);
  _mtClr(el);
}
function _mtClr(el) { const f = el && el.closest && el.closest('.pg-field'); if (f) { f.classList.remove('err'); const x = f.querySelector('.pg-msg'); if (x) x.remove(); } }
function _mtPicked(key) { return [...document.querySelectorAll(`[data-mt="${key}"] .mt-chip[aria-pressed="true"]`)].map((b) => b.getAttribute('data-k')); }
function _mtField(key, lbl, ctl) { return `<div class="pg-field" data-mt="${key}"><label for="mt-${key}">${esc(lbl)}</label>${ctl}</div>`; }
function _mtAgreeHtml() {
  return `<details class="mt-rules"><summary>${_hT('mtRules')}</summary><ul>${MT_RULES.map((k) => `<li>${esc(_hT(k))}</li>`).join('')}</ul></details>
    <div class="pg-field mt-agree" data-mt="ok"><label class="mt-tick"><input type="checkbox" id="mt-ok" data-on-change="${_on('_mtClr', _EL)}"><span>${esc(_hT('mtAgree'))}</span></label></div>`;
}
function _mtErr(box, key, k) {
  const f = box.querySelector(`[data-mt="${key}"]`); if (!f) return;
  f.classList.add('err');
  if (!f.querySelector('.pg-msg')) f.insertAdjacentHTML('beforeend', `<div class="pg-msg" role="alert">${esc(_hT(k))}</div>`);
}
function _mtVal(id) { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; }
function _mtErrMsg(res) {
  const e = res && res.error;
  return _hT(e === 'gone' || e === 'own' ? 'mtGone' : e === 'exists' ? 'mtExists' : e === 'limit' ? 'mtLimit' : 'err');
}
async function _mtSend(boxId, fn, args, after) {
  const c = _hCust(), go = document.getElementById(boxId + '-go'); if (!c || S._mtSending) return;
  S._mtSending = true; if (go) go.disabled = true;
  let r; try { r = await sb.rpc(fn, { ..._hTok(c), ...args }); } catch (e) { r = { error: e }; }
  S._mtSending = false; if (go) go.disabled = false;
  const res = r && !r.error && r.data;
  if (!res || res.ok !== true) {
    if (typeof toast === 'function') toast(_mtErrMsg(res), 'error');
    if (res && (res.error === 'gone' || res.error === 'own' || res.error === 'exists')) { closeConfirm(); _mtFetch(true); }
    return;
  }
  closeConfirm();
  await _mtFetch(true);
  const d = _mtData();
  if (after && d && d.mentor && (d.profiles || []).some((x) => x.num === after && !x.offered)) _mtOfferOpen(after);
}
function _mtCheckForm(box, fields) {
  let bad = false;
  fields.forEach(([key, ok, k]) => { if (!ok) { _mtErr(box, key, k); bad = true; } });
  if (bad) { const f = box.querySelector('.pg-field.err input, .pg-field.err select, .pg-field.err textarea, .pg-field.err .mt-chip'); if (f) try { f.focus(); } catch (_) {} }
  return !bad;
}

// A member offers to help one profile.
function _mtOfferOpen(num) {
  const d = _mtData(), p = d && (d.profiles || []).find((x) => x.num === num); if (!p) return;
  if (!d.mentor) { _mtJoinOpen(num); return; }
  S._mtNum = num;
  _mtModal('mt-of', _hF('mtProfile', num), `<div class="mt-sum"><strong><bdi>${esc(p.university || '')}</bdi></strong><span><bdi>${esc(p.field || '')}</bdi></span><span>${_mtWhere(p)}</span></div>
    ${_mtChipGroup('links', MT_LINKS, MT_LINK_K, [], _hT('mtLinksQ'))}
    ${_mtChipGroup('helps', MT_HELPS, MT_HELP_K, Array.isArray(d.mentor.helps) ? d.mentor.helps : [], _hT('mtHelpsQ'))}
    ${_mtField('note', _hT('mtNoteQ'), `<textarea id="mt-note" maxlength="500" rows="4" data-on-input="${_on('_mtClr', _EL)}"></textarea>`)}`, '_mtOfferSend');
}
function _mtOfferSend() {
  const box = document.getElementById('mt-of'); if (!box) return;
  const links = _mtPicked('links'), helps = _mtPicked('helps'), note = _mtVal('mt-note');
  if (!_mtCheckForm(box, [['links', links.length, 'mtPickOne'], ['helps', helps.length, 'mtPickOne'], ['note', note, 'mtFill']])) return;
  _mtSend('mt-of', 'mentor_offer', { p_num: S._mtNum, p_links: links, p_helps: helps, p_note: note });
}

// A member registers as a mentor (or changes it); from a profile's "I can help", that profile's offer opens next.
function _mtJoinOpen(after) {
  const d = _mtData(), m = (d && d.mentor) || {};
  S._mtAfter = Number(after) || 0;
  const inp = (key, v, max, ac) => `<input type="text" id="mt-${key}" maxlength="${max}" value="${esc(v || '')}"${ac ? ` autocomplete="${ac}"` : ''} data-on-input="${_on('_mtClr', _EL)}">`;
  _mtModal('mt-jn', _hT('mtRegMentor'), [
    _mtField('muni', _hT('mtMUni'), inp('muni', m.university, 160, 'organization')),
    _mtField('mfield', _hT('mtMField'), inp('mfield', m.field, 120)),
    _mtField('mwork', _hT('mtMWork'), inp('mwork', m.work, 120, 'organization-title')),
    _mtField('mplaces', _hT('mtMPlaces'), inp('mplaces', m.places, 160)),
    _mtChipGroup('mhelps', MT_HELPS, MT_HELP_K, Array.isArray(m.helps) ? m.helps : [], _hT('mtHelpsQ')),
    _mtField('mabout', _hT('mtMAbout'), `<textarea id="mt-mabout" maxlength="500" rows="4" data-on-input="${_on('_mtClr', _EL)}">${esc(m.about || '')}</textarea>`),
    _mtAgreeHtml(),
  ].join(''), '_mtJoinSend');
}
function _mtJoinSend() {
  const box = document.getElementById('mt-jn'); if (!box) return;
  const v = { uni: _mtVal('mt-muni'), field: _mtVal('mt-mfield'), about: _mtVal('mt-mabout') };
  const helps = _mtPicked('mhelps'), ok = !!(document.getElementById('mt-ok') || {}).checked;
  if (!_mtCheckForm(box, [['muni', v.uni.length >= 2, 'mtFill'], ['mfield', v.field.length >= 2, 'mtFill'], ['mhelps', helps.length, 'mtPickOne'], ['mabout', v.about, 'mtFill'], ['ok', ok, 'mtTick']])) return;
  _mtSend('mt-jn', 'mentor_join', {
    p_university: v.uni, p_field: v.field, p_work: _mtVal('mt-mwork') || null, p_places: _mtVal('mt-mplaces') || null,
    p_helps: helps, p_about: v.about, p_ok: true,
  }, S._mtAfter);
}
async function _mtQuit() {
  if (!(await askConfirm({ title: _hT('mtLeaveProgQ'), confirmLabel: _hT('mtLeaveProg'), confirmClass: 'btn-red' }))) return;
  _mtCall('mentor_quit', {});
}

// A member starting university asks for a mentor (or changes a request staff have not published yet).
function _mtCountryOpts(code) {
  const r = NATIONALITIES.find((x) => x[0] === code), once = _selOnce(r ? r[1] : '');
  const codeOf = Object.fromEntries(NATIONALITIES.map(([k, n]) => [n, k]));
  const m = _natFor(S.lang || 'en');
  return `<option value=""></option>${m.list.map((n) => `<option value="${esc(codeOf[n] || '')}"${once(n) ? ' selected' : ''}>${esc(m.lab[n] || n)}</option>`).join('')}`;
}
function _mtAskOpen() {
  const d = _mtData(), a = (d && d.ask && d.ask.status === 'pending' && d.ask) || {};
  const y = new Date().getFullYear(), yr = Number(a.class_year) || y;
  const years = [y - 1, y, y + 1, y + 2, y + 3].map((v) => `<option value="${v}"${v === yr ? ' selected' : ''}>${v}</option>`).join('');
  const pref = a.gender_pref || 'any';
  const prefs = [['any', 'mtPrefAny'], ['female', 'mtPrefF'], ['male', 'mtPrefM']].map(([v, k]) => `<option value="${v}"${v === pref ? ' selected' : ''}>${esc(_hT(k))}</option>`).join('');
  const inp = (key, v, max, ac) => `<input type="text" id="mt-${key}" maxlength="${max}" value="${esc(v || '')}"${ac ? ` autocomplete="${ac}"` : ''} data-on-input="${_on('_mtClr', _EL)}">`;
  _mtModal('mt-ak', _hT('mtAsk'), [
    _mtField('uni', _hT('mtUni'), inp('uni', a.university, 100, 'organization')),
    _mtField('field', _hT('mtField'), inp('field', a.field, 100)),
    _mtField('city', _hT('mtCity'), inp('city', a.city, 60, 'address-level2')),
    _mtField('country', _hT('mtCountry'), `<select id="mt-country" data-on-change="${_on('_mtClr', _EL)}">${_mtCountryOpts(a.country)}</select>`),
    _mtField('year', _hT('mtYear'), `<select id="mt-year">${years}</select>`),
    _mtChipGroup('want', MT_HELPS, MT_HELP_K, Array.isArray(a.helps) ? a.helps : [], _hT('mtWantQ')),
    _mtField('goal', _hT('mtGoal'), `<textarea id="mt-goal" maxlength="200" rows="3">${esc(a.goal || '')}</textarea>`),
    _mtField('pref', _hT('mtPref'), `<select id="mt-pref">${prefs}</select>`),
    _mtAgreeHtml(),
  ].join(''), '_mtAskSend');
}
function _mtAskSend() {
  const box = document.getElementById('mt-ak'); if (!box) return;
  const v = { uni: _mtVal('mt-uni'), field: _mtVal('mt-field'), city: _mtVal('mt-city'), country: _mtVal('mt-country') };
  const want = _mtPicked('want'), ok = !!(document.getElementById('mt-ok') || {}).checked;
  if (!_mtCheckForm(box, [['uni', v.uni.length >= 2, 'mtFill'], ['field', v.field.length >= 2, 'mtFill'], ['city', v.city, 'mtFill'], ['country', v.country, 'mtFill'], ['want', want.length, 'mtPickOne'], ['ok', ok, 'mtTick']])) return;
  _mtSend('mt-ak', 'mentor_ask', {
    p_university: v.uni, p_field: v.field, p_city: v.city, p_country: v.country, p_class_year: Number(_mtVal('mt-year')) || new Date().getFullYear(),
    p_helps: want, p_goal: _mtVal('mt-goal') || null, p_gender_pref: _mtVal('mt-pref') || 'any', p_ok: true,
  });
}

// Answers, stepping back and the check: each asks the database, then reads the page again.
async function _mtCall(fn, args) {
  const c = _hCust(); if (!c || S._mtSending) return;
  S._mtSending = true;
  let r; try { r = await sb.rpc(fn, { ..._hTok(c), ...args }); } catch (e) { r = { error: e }; }
  S._mtSending = false;
  const res = r && !r.error && r.data;
  if ((!res || res.ok !== true) && typeof toast === 'function') toast(_mtErrMsg(res), 'error');
  _mtFetch(true);
}
async function _mtAnswer(id, yes) {
  if (!yes && !(await askConfirm({ title: _hT('mtNotNowQ'), confirmLabel: _hT('mtNotNow'), confirmClass: 'btn-red' }))) return;
  _mtCall('mentor_answer', { p_offer: id, p_yes: !!yes });
}
async function _mtLeave(id, kind) {
  const [q, l] = kind === 'ask' ? ['mtCloseAskQ', 'mtCloseAsk'] : kind === 'offer' ? ['mtWithdrawQ', 'mtWithdraw'] : ['mtStepBackQ', 'mtStepBack'];
  if (!(await askConfirm({ title: _hT(q), confirmLabel: _hT(l), confirmClass: 'btn-red' }))) return;
  _mtCall('mentor_leave', { p_offer: kind === 'ask' ? null : id });
}
function _mtCheck(id, answer) { _mtCall('mentor_check', { p_offer: id, p_answer: answer }); }

// ── Ask: the questions staff put to members (the user, 2026-11-13: "add the asks questions in the community section in
// the bookings app") ───────────────────────────────────────────────────────────────────────────────────────────────
// The feed's "Have your say" card lists the open pages this account may see (ask_list: listed, open, its audience; the
// same list as micromobility.sa/ask), with how many of their questions the member has answered. A tap opens the page
// here (S._hubView 'ask', S._akSlug), drawn by member-ask.js, fetched only then (_akLoad, its address stamped by the
// build as ASK_HUB_V). The list is read when the tab paints, again after two minutes, and after an answer; it is never
// kept on the phone. A database without Ask hides the card.
Object.assign(HUB_T, {
  akTitle: ['Have your say', 'شاركنا رأيك', 'Donnez votre avis', 'Danos tu opinión', 'Dê a sua opinião', 'اپنی رائے دیں', 'अपनी राय दें', 'Ibahagi ang iyong opinyon', 'आफ्नो विचार राख्नुहोस्', 'আপনার মতামত দিন'],
  akGo: ['Answer', 'أجب', 'Répondre', 'Responder', 'Responder', 'جواب دیں', 'जवाब दें', 'Sumagot', 'जवाफ दिनुहोस्', 'উত্তর দিন'],
  akOpen: ['Open', 'فتح', 'Ouvrir', 'Abrir', 'Abrir', 'کھولیں', 'खोलें', 'Buksan', 'खोल्नुहोस्', 'খুলুন'],
  akProg: ['{0} of {1} answered', 'أجبت عن {0} من {1}', 'Répondu : {0} sur {1}', 'Respondidas: {0} de {1}', 'Respondidas: {0} de {1}', '{1} میں سے {0} کا جواب دیا', '{1} में से {0} का जवाब दिया', 'Nasagot ang {0} sa {1}', '{1} मध्ये {0} को जवाफ दिइयो', '{1}টির মধ্যে {0}টির উত্তর দেওয়া হয়েছে'],
  akUntil: ['Open until {0}', 'مفتوح حتى {0}', 'Ouvert jusqu’au {0}', 'Abierta hasta {0}', 'Aberta até {0}', '{0} تک کھلا ہے', '{0} तक खुला है', 'Bukas hanggang {0}', '{0} सम्म खुला', '{0} পর্যন্ত খোলা'],
});
async function _akListFetch(force) {
  const c = _hCust(); if (!c || !sb || S._akListBusy) return;
  const l = S._akList;
  if (l && l.forId === c.id && (l.off || (!force && S._akListAt && Date.now() - S._akListAt < 12e4))) return;
  S._akListBusy = true; S._akListAt = Date.now();
  let r; try { r = await sb.rpc('ask_list', _hTok(c)); } catch (e) { r = { error: e }; }
  S._akListBusy = false;
  const now = _hCust(); if (!now || now.id !== c.id) return;
  const e = r && r.error;
  if (e && (e.code === 'PGRST202' || e.code === '42883')) S._akList = { forId: c.id, off: true, pages: [] };
  else if (r && !e && r.data && Array.isArray(r.data.pages)) {
    const pages = r.data.pages.filter((p) => p && typeof p.slug === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.slug) && (String(p.title_en || '').trim() || String(p.title_ar || '').trim()));
    S._akList = { forId: c.id, pages };
  } else if (!l || l.forId !== c.id) S._akList = { forId: c.id, pages: [] }; // no answer: what was shown stays
  if (S.custTab === 'members' && S._hubView !== 'ask') _hubRender();
}
function _akCardHtml() {
  const c = _hCust(), l = S._akList;
  if (!c || !l || l.forId !== c.id || l.off || !l.pages.length) return '';
  const when = (iso) => { const t = Date.parse(iso || ''); if (Number.isNaN(t)) return ''; try { return new Intl.DateTimeFormat(_locale(), { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Riyadh' }).format(t); } catch (_) { return ''; } };
  const rows = l.pages.slice(0, 6).map((p) => {
    const all = Number(p.questions) || 0, done = Math.min(all, Number(p.answered) || 0), finished = all > 0 && done >= all;
    const meta = done > 0 ? _hF('akProg', done, all) : p.closes_at && when(p.closes_at) ? _hF('akUntil', when(p.closes_at)) : '';
    return `<div class="ak-row"><div class="ak-row-t"><strong dir="auto">${esc(_hPick(p, 'title_en', 'title_ar'))}</strong>${meta ? `<span class="hub-meta">${esc(meta)}</span>` : ''}</div>
      <button type="button" class="${finished ? 'btn-secondary' : 'btn-primary'} btn-sm" data-on-click="${_on('_akOpen', p.slug)}">${_hT(finished ? 'akOpen' : 'akGo')}</button></div>`;
  }).join('');
  return `<div class="hub-card ak-card"><span class="hub-k">${_cuIc('chat', 16)} ${_hT('akTitle')}</span>${rows}</div>`;
}
function _akOpen(slug) {
  if (typeof slug !== 'string' || !/^[a-z0-9-]{3,40}$/.test(slug)) return;
  S._akSlug = slug; S._hubView = 'ask';
  _hubRender();
  try { window.scrollTo(0, 0); } catch (_) {}
}
function _akClose() {
  if (window._akStop) window._akStop();
  S._hubView = null;
  _hubRender();
  _akListFetch(true);
  try { window.scrollTo(0, 0); } catch (_) {}
}
// The page's own file, fetched the first time a page opens; until it is here, the page's head and a skeleton.
function _akLoad() {
  if (window._akPaint || S._akLoading) return;
  S._akLoading = true; S._akLoadErr = false;
  const v = (window._hubDeps || {}).askV;
  const s = document.createElement('script'); s.src = '/member-ask.js' + (v ? '?v=' + v : '');
  s.onload = () => { S._akLoading = false; if (S.custTab === 'members' && S._hubView === 'ask') _hubRender(); };
  s.onerror = () => { S._akLoading = false; S._akLoadErr = true; s.remove(); if (S.custTab === 'members' && S._hubView === 'ask') _hubRender(); };
  document.head.appendChild(s);
}
function _akLoadRetry() { S._akLoadErr = false; _akLoad(); _hubRender(); }
function _akShellHtml() {
  return `<div class="hub-card ak-head"><div class="mt-head"><h2 class="mt-h1"></h2><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_akClose')}">${_hT('close')}</button></div>
    ${S._akLoadErr ? `<p class="ak-line" role="status">${_hT('err')}</p><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_akLoadRetry')}">${_hT('retry')}</button>` : _skelHtml(2, 'hub-skel')}</div>`;
}

window._hubRender = _hubRender;
