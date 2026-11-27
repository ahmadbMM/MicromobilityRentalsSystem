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
// 2026-11-18: My interests (its card, and Coming up led by the sessions of a picked interest); the last block of this file.
// 2026-11-18: Suggest a ride (its card in the feed, its own page S._hubView 'suggest', ride_suggestions_mine / ride_suggest);
// its block is the last above window._hubRender.
// 2026-11-18: the Ramadan season (its dates from hub_season, a card and the next session's accent; see _ssnCheck).
// 2026-11-20: the feed in three parts behind a switch, Sessions, Challenges and Club (see the block above _feedHtml).
// 2026-11-20: the Community chat (its own page S._hubView 'chat', chat_read / chat_send; the one place a member reads another
// member's full name, the owner's pick); its block is the last above window._hubRender. Its way in is a round button at the
// bottom corner of every page (app.src.html _chtFab*, the user's "show the chat in booking app as an icon at the bottom
// corner of the page"), no longer a card in the Club part.
/* global S, sb, esc, _on, getSession, _cssv, shortDate, t, _cuIc, sessionTime, _dayWord, _evName, _evOf, _evKindName, allSessions,
   _isCommunity, _sessPastDay, _sessEnded, _bwOpen, _sessFull, _sgOk, _sgChip, _myRideGroups, _sessGet, getQueue, setCustTab, _locale,
   _mrBadgeList, _mrBadgeInfo, _rideKind, _skelHtml, _bdgMedal, toast, selectEvent, selectSessCard, _bookingAhead, _ptnAll,
   _arHold, _isApprovalRide, _commPublished, _needsBike, _typeClosed, _mfMarkHtml, todayStr,
   NATIONALITIES, nationalityLabel, _natFor, _selOnce, askConfirm, closeConfirm, _EL, _EV, _sbCooling, _chtFabPaint, goLanding */
const HUB_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms'];
const HUB_T = {
  err: ['We could not do that. Please try again.', 'تعذّر ذلك. يرجى المحاولة مرة أخرى.', 'Action impossible. Veuillez réessayer.', 'No se pudo hacer. Inténtalo de nuevo.', 'Não foi possível. Tente novamente.', 'یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔', 'यह नहीं हो सका। फिर कोशिश करें।', 'Hindi ito nagawa. Pakisubukang muli.', 'यो हुन सकेन। फेरि प्रयास गर्नुहोस्।', 'এটি করা যায়নি। আবার চেষ্টা করুন।', 'Kami tidak dapat melakukannya. Sila cuba lagi.'],
  retry: ['Try again', 'حاول مرة أخرى', 'Réessayer', 'Reintentar', 'Tentar novamente', 'دوبارہ کوشش کریں', 'फिर कोशिश करें', 'Subukang muli', 'फेरि प्रयास गर्नुहोस्', 'আবার চেষ্টা করুন', 'Cuba lagi'],
  stale: ['Couldn’t refresh', 'تعذّر التحديث', 'Actualisation impossible', 'No se pudo actualizar', 'Não foi possível atualizar', 'تازہ نہیں ہو سکا', 'रीफ़्रेश नहीं हो सका', 'Hindi ma-refresh', 'रिफ्रेस गर्न सकिएन', 'রিফ্রেশ করা যায়নি', 'Tidak dapat dimuat semula'],
  // The tab's three parts (2026-11-20): the switch's buttons.
  secSess: ['Sessions', 'الجلسات', 'Séances', 'Sesiones', 'Sessões', 'سیشن', 'सत्र', 'Mga session', 'सत्रहरू', 'সেশন', 'Sesi'],
  secGoals: ['Challenges', 'التحديات', 'Défis', 'Retos', 'Desafios', 'چیلنجز', 'चुनौतियाँ', 'Mga hamon', 'चुनौतीहरू', 'চ্যালেঞ্জ', 'Cabaran'],
  secClub: ['Club', 'النادي', 'Club', 'Club', 'Clube', 'کلب', 'क्लब', 'Club', 'क्लब', 'ক্লাব', 'Kelab'],
  secBoard: ['Leaderboard', 'المتصدرون', 'Classement', 'Clasificación', 'Classificação', 'لیڈر بورڈ', 'लीडरबोर्ड', 'Leaderboard', 'लिडरबोर्ड', 'লিডারবোর্ড', 'Pendahulu'],
  lbT: ['Distance leaderboards', 'لوحات المسافات', 'Classements des distances', 'Clasificaciones de distancia', 'Classificações de distância', 'فاصلے کے لیڈر بورڈز', 'दूरी के लीडरबोर्ड', 'Mga leaderboard ng distansya', 'दूरीका लिडरबोर्ड', 'দূরত্বের লিডারবোর্ড', 'Papan pendahulu jarak'],
  lbLongest: ['Longest ride', 'أطول رحلة', 'Plus longue sortie', 'Ruta más larga', 'Pedalada mais longa', 'سب سے لمبی سواری', 'सबसे लंबी सवारी', 'Pinakamahabang biyahe', 'सबैभन्दा लामो सवारी', 'দীর্ঘতম রাইড', 'Kayuhan terpanjang'],
  lbLifetime: ['Lifetime', 'كل الأوقات', 'Depuis le début', 'Total', 'Total', 'اب تک', 'अब तक', 'Kabuuan', 'अहिलेसम्म', 'সর্বমোট', 'Sepanjang masa'],
  lbYear: ['This year', 'هذا العام', 'Cette année', 'Este año', 'Este ano', 'اس سال', 'इस साल', 'Ngayong taon', 'यो वर्ष', 'এই বছর', 'Tahun ini'],
  next: ['Your next session', 'جلستك القادمة', 'Votre prochaine séance', 'Tu próxima sesión', 'A sua próxima sessão', 'آپ کا اگلا سیشن', 'आपका अगला सत्र', 'Ang susunod mong session', 'तपाईंको अर्को सत्र', 'আপনার পরের সেশন', 'Sesi anda seterusnya'],
  nextOpen: ['Next session to book', 'الجلسة القادمة المتاحة للحجز', 'Prochaine séance à réserver', 'Próxima sesión para reservar', 'Próxima sessão para reservar', 'بکنگ کے لیے اگلا سیشن', 'बुक करने के लिए अगला सत्र', 'Susunod na session na mabu-book', 'बुक गर्न अर्को सत्र', 'বুক করার পরের সেশন', 'Sesi seterusnya untuk ditempah'],
  ticket: ['Show ticket', 'عرض التذكرة', 'Voir le billet', 'Ver el billete', 'Ver o bilhete', 'ٹکٹ دکھائیں', 'टिकट दिखाएँ', 'Ipakita ang tiket', 'टिकट देखाउनुहोस्', 'টিকিট দেখান', 'Tunjuk tiket'],
  book: ['Book', 'احجز', 'Réserver', 'Reservar', 'Reservar', 'بک کریں', 'बुक करें', 'Mag-book', 'बुक गर्नुहोस्', 'বুক করুন', 'Tempah'],
  wl: ['On the waitlist', 'في قائمة الانتظار', 'En liste d’attente', 'En lista de espera', 'Na lista de espera', 'انتظار کی فہرست میں', 'प्रतीक्षा सूची में', 'Nasa waitlist', 'प्रतीक्षा सूचीमा', 'অপেক্ষার তালিকায়', 'Dalam senarai menunggu'],
  noneOpen: ['No session is open to book right now', 'لا توجد جلسة متاحة للحجز الآن', 'Aucune séance ouverte à la réservation pour le moment', 'Ahora no hay ninguna sesión abierta para reservar', 'De momento não há nenhuma sessão aberta para reservar', 'ابھی بکنگ کے لیے کوئی سیشن کھلا نہیں', 'अभी बुकिंग के लिए कोई सत्र खुला नहीं है', 'Walang bukas na session na mabu-book ngayon', 'अहिले बुक गर्न कुनै सत्र खुला छैन', 'এখন বুক করার মতো কোনো সেশন খোলা নেই', 'Tiada sesi yang dibuka untuk tempahan sekarang'],
  seeAll: ['See all sessions', 'عرض كل الجلسات', 'Voir toutes les séances', 'Ver todas las sesiones', 'Ver todas as sessões', 'تمام سیشن دیکھیں', 'सभी सत्र देखें', 'Tingnan ang lahat ng session', 'सबै सत्र हेर्नुहोस्', 'সব সেশন দেখুন', 'Lihat semua sesi'],
  soon: ['Coming up', 'قريبًا', 'À venir', 'Próximamente', 'Em breve', 'آنے والے', 'आने वाले', 'Paparating', 'आउँदै गरेका', 'আসছে', 'Akan datang'],
  goalYou: ['Your challenge', 'تحديك', 'Votre défi', 'Tu reto', 'O seu desafio', 'آپ کا چیلنج', 'आपकी चुनौती', 'Hamon mo', 'तपाईंको चुनौती', 'আপনার চ্যালেঞ্জ', 'Cabaran anda'],
  chFirst: ['Your first session', 'جلستك الأولى', 'Votre première séance', 'Tu primera sesión', 'A sua primeira sessão', 'آپ کا پہلا سیشن', 'आपका पहला सत्र', 'Ang una mong session', 'तपाईंको पहिलो सत्र', 'আপনার প্রথম সেশন', 'Sesi pertama anda'],
  chSecond: ['Your second session', 'جلستك الثانية', 'Votre deuxième séance', 'Tu segunda sesión', 'A sua segunda sessão', 'آپ کا دوسرا سیشن', 'आपका दूसरा सत्र', 'Ang ikalawa mong session', 'तपाईंको दोस्रो सत्र', 'আপনার দ্বিতীয় সেশন', 'Sesi kedua anda'],
  chBack: ['Back this month', 'عُد هذا الشهر', 'De retour ce mois-ci', 'De vuelta este mes', 'De volta este mês', 'اس مہینے واپس آئیں', 'इस महीने वापसी', 'Bumalik ngayong buwan', 'यो महिना फर्कनुहोस्', 'এই মাসে ফিরে আসুন', 'Kembali bulan ini'],
  chLevel: ['{0} sessions this month', '{0} جلسات هذا الشهر', '{0} séances ce mois-ci', '{0} sesiones este mes', '{0} sessões este mês', 'اس مہینے {0} سیشن', 'इस महीने {0} सत्र', '{0} session ngayong buwan', 'यो महिना {0} सत्र', 'এই মাসে {0}টি সেশন', '{0} sesi bulan ini'],
  chPick: ['Pick your challenge', 'اختر تحديك', 'Choisissez votre défi', 'Elige tu reto', 'Escolha o seu desafio', 'اپنا چیلنج چنیں', 'अपनी चुनौती चुनें', 'Piliin ang hamon mo', 'आफ्नो चुनौती छान्नुहोस्', 'আপনার চ্যালেঞ্জ বেছে নিন', 'Pilih cabaran anda'],
  goalOf: ['{0} of {1}, until {2}', '{0} من {1}، حتى {2}', '{0} sur {1}, jusqu’au {2}', '{0} de {1}, hasta el {2}', '{0} de {1}, até {2}', '{1} میں سے {0}، {2} تک', '{1} में से {0}, {2} तक', '{0} sa {1}, hanggang {2}', '{1} मध्ये {0}, {2} सम्म', '{1}টির মধ্যে {0}টি, {2} পর্যন্ত', '{0} daripada {1}, hingga {2}'],
  goalDone: ['Done', 'تم', 'Terminé', 'Hecho', 'Concluído', 'مکمل', 'पूरा', 'Tapos na', 'पूरा भयो', 'সম্পন্ন', 'Selesai'],
  plan: ['Plan my Saturdays', 'خطتي لأيام السبت', 'Planifier mes samedis', 'Planificar mis sábados', 'Planejar os meus sábados', 'میرے ہفتے کے دنوں کی منصوبہ بندی', 'मेरे शनिवार की योजना', 'Planuhin ang mga Sabado ko', 'मेरा शनिबारको योजना', 'আমার শনিবারের পরিকল্পনা', 'Rancang hari Sabtu saya'],
  bup: ['Build-up plan', 'خطة الاستعداد', 'Plan de préparation', 'Plan de preparación', 'Plano de preparação', 'تیاری کا منصوبہ', 'तैयारी की योजना', 'Plano ng paghahanda', 'तयारी योजना', 'প্রস্তুতির পরিকল্পনা', 'Pelan latihan berperingkat'],
  bupOne: ['1 Saturday to go', 'يتبقى سبت واحد', '1 samedi restant', 'Queda 1 sábado', 'Falta 1 sábado', 'ہفتے کا 1 دن باقی', '1 शनिवार बाकी', '1 Sabado na lang', '1 शनिबार बाँकी', '1টি শনিবার বাকি', '1 Sabtu lagi'],
  bupN: ['{0} Saturdays to go', 'أيام السبت المتبقية: {0}', '{0} samedis restants', 'Quedan {0} sábados', 'Faltam {0} sábados', 'ہفتے کے {0} دن باقی', '{0} शनिवार बाकी', '{0} Sabado na lang', '{0} शनिबार बाँकी', '{0}টি শনিবার বাকি', '{0} Sabtu lagi'],
  bupSats: ['Saturday rides', 'جولات السبت', 'Sorties du samedi', 'Recorridos del sábado', 'Passeios de sábado', 'ہفتے کی رائیڈز', 'शनिवार राइड', 'Mga Saturday ride', 'शनिबार राइडहरू', 'শনিবারের রাইড', 'Kayuhan Sabtu'],
  bupSoon: ['Not open yet', 'لم يُفتح الحجز بعد', 'Pas encore ouvert', 'Aún no abierto', 'Ainda não aberto', 'ابھی کھلا نہیں', 'अभी खुला नहीं', 'Hindi pa bukas', 'अझै खुलेको छैन', 'এখনো খোলেনি', 'Belum dibuka'],
  season: ['Season challenge', 'تحدي الموسم', 'Défi de la saison', 'Reto de temporada', 'Desafio da época', 'سیزن کا چیلنج', 'सीज़न की चुनौती', 'Hamon ng season', 'मौसमको चुनौती', 'মৌসুমের চ্যালেঞ্জ', 'Cabaran musim'],
  goalAll: ['Community goal', 'هدف المجتمع', 'Objectif de la communauté', 'Meta de la comunidad', 'Objetivo da comunidade', 'کمیونٹی کا ہدف', 'समुदाय का लक्ष्य', 'Layunin ng komunidad', 'समुदायको लक्ष्य', 'কমিউনিটির লক্ষ্য', 'Matlamat komuniti'],
  clubSat: ['{0} Saturday rides this month', '{0} رحلة سبت هذا الشهر', '{0} sorties du samedi ce mois-ci', '{0} salidas de sábado este mes', '{0} passeios de sábado este mês', 'اس مہینے ہفتے کی {0} سواریاں', 'इस महीने {0} शनिवार राइड', '{0} Saturday ride ngayong buwan', 'यो महिना {0} शनिबारे राइड', 'এই মাসে শনিবারের {0}টি রাইড', '{0} kayuhan Sabtu bulan ini'],
  soFar: ['{0} so far, until {1}', '{0} حتى الآن، حتى {1}', '{0} pour l’instant, jusqu’au {1}', '{0} hasta ahora, hasta el {1}', '{0} até agora, até {1}', 'اب تک {0}، {1} تک', 'अब तक {0}, {1} तक', '{0} sa ngayon, hanggang {1}', 'अहिलेसम्म {0}, {1} सम्म', 'এখন পর্যন্ত {0}, {1} পর্যন্ত', '{0} setakat ini, hingga {1}'],
  toGo: ['{0} to go, until {1}', 'بقي {0}، حتى {1}', 'Encore {0}, jusqu’au {1}', 'Faltan {0}, hasta el {1}', 'Faltam {0}, até {1}', '{0} باقی، {1} تک', '{0} बाकी, {1} तक', '{0} pa, hanggang {1}', '{0} बाँकी, {1} सम्म', 'আর {0}, {1} পর্যন্ত', '{0} lagi, hingga {1}'],
  clubYou: ['You: {0} of them', 'أنت: {0} منها', 'Vous : {0} d’entre elles', 'Tú: {0} de ellas', 'Você: {0} delas', 'آپ: ان میں سے {0}', 'आप: इनमें से {0}', 'Ikaw: {0} rito', 'तपाईं: तीमध्ये {0}', 'আপনি: এর মধ্যে {0}টি', 'Anda: {0} daripadanya'],
  clubHit: ['The club reached it', 'حقّق النادي الهدف', 'Le club l’a atteint', 'El club lo logró', 'O clube conseguiu', 'کلب نے ہدف حاصل کر لیا', 'क्लब ने लक्ष्य पा लिया', 'Naabot ito ng club', 'क्लबले लक्ष्य पूरा गर्‍यो', 'ক্লাব লক্ষ্যে পৌঁছেছে', 'Kelab telah mencapainya'],
  report: ['Saturday report', 'تقرير السبت', 'Le samedi en bref', 'Crónica del sábado', 'Resumo de sábado', 'ہفتے کی رپورٹ', 'शनिवार की रिपोर्ट', 'Ulat ng Sabado', 'शनिबारको रिपोर्ट', 'শনিবারের প্রতিবেদন', 'Laporan Sabtu'],
  // The Saturday report's tiles, the ride's status chip and the next Saturday's target (2026-11-13, R10 R13 R20).
  tMine: ['Your Saturday rides this month', 'رحلاتك يوم السبت هذا الشهر', 'Vos sorties du samedi ce mois-ci', 'Tus salidas de sábado este mes', 'Os seus passeios de sábado este mês', 'اس مہینے آپ کی ہفتے کی سواریاں', 'इस महीने आपकी शनिवार राइड', 'Ang Saturday ride mo ngayong buwan', 'यो महिना तपाईंका शनिबारे राइड', 'এই মাসে আপনার শনিবারের রাইড', 'Kayuhan Sabtu anda bulan ini'],
  rsMoved: ['Start moved', 'تغيّر موعد الانطلاق', 'Départ décalé', 'Salida cambiada', 'Partida alterada', 'آغاز کا وقت بدل گیا', 'शुरुआत का समय बदला', 'Inilipat ang simula', 'सुरुवातको समय सारियो', 'শুরুর সময় বদলেছে', 'Masa mula dianjak'],
  rsShort: ['Shortened', 'تم تقصير المسار', 'Parcours raccourci', 'Recorrido acortado', 'Percurso encurtado', 'راستہ مختصر', 'रास्ता छोटा किया गया', 'Pinaikli', 'बाटो छोटो गरियो', 'পথ ছোট করা হয়েছে', 'Dipendekkan'],
  rsCancel: ['Cancelled', 'ملغاة', 'Annulée', 'Cancelada', 'Cancelada', 'منسوخ', 'रद्द', 'Kanselado', 'रद्द', 'বাতিল', 'Dibatalkan'],
  nextSat: ['Next Saturday', 'السبت القادم', 'Samedi prochain', 'Próximo sábado', 'Próximo sábado', 'اگلا ہفتہ', 'अगला शनिवार', 'Susunod na Sabado', 'अर्को शनिबार', 'পরের শনিবার', 'Sabtu seterusnya'],
  nextTarget: ['Target', 'الهدف', 'Objectif', 'Meta', 'Objetivo', 'ہدف', 'लक्ष्य', 'Target', 'लक्ष्य', 'লক্ষ্য', 'Sasaran'],
  news: ['News', 'أخبار', 'Actualités', 'Novedades', 'Novidades', 'خبریں', 'समाचार', 'Balita', 'समाचार', 'খবর', 'Berita'],
  tip: ['Tip of the week', 'نصيحة الأسبوع', 'Conseil de la semaine', 'Consejo de la semana', 'Dica da semana', 'ہفتے کا مشورہ', 'हफ़्ते की सलाह', 'Tip ng linggo', 'हप्ताको सुझाव', 'সপ্তাহের পরামর্শ', 'Tip minggu ini'],
  vol: ['Volunteers needed', 'نحتاج متطوعين', 'Bénévoles recherchés', 'Se buscan voluntarios', 'Procuram-se voluntários', 'رضاکاروں کی ضرورت ہے', 'स्वयंसेवकों की ज़रूरत है', 'Kailangan ng mga volunteer', 'स्वयंसेवक चाहिएको छ', 'স্বেচ্ছাসেবক প্রয়োজন', 'Sukarelawan diperlukan'],
  volBtn: ['Volunteer', 'تطوّع', 'Je me propose', 'Quiero ayudar', 'Quero ajudar', 'رضاکار بنیں', 'स्वयंसेवा करें', 'Mag-volunteer', 'स्वयंसेवा गर्नुहोस्', 'স্বেচ্ছাসেবক হন', 'Sukarelawan'],
  bday: ['Happy birthday, {0}!', 'كل عام وأنت بخير يا {0}!', 'Joyeux anniversaire, {0} !', '¡Feliz cumpleaños, {0}!', 'Feliz aniversário, {0}!', 'سالگرہ مبارک، {0}!', 'जन्मदिन मुबारक, {0}!', 'Maligayang kaarawan, {0}!', 'जन्मदिनको शुभकामना, {0}!', 'শুভ জন্মদিন, {0}!', 'Selamat hari lahir, {0}!'],
  // The Ramadan season (2026-11-18): the card that opens the tab while Ramadan runs, and on Eid al-Fitr's first three days.
  ssnRam: ['Ramadan Kareem', 'رمضان كريم', 'Ramadan Karim', 'Ramadán Kareem', 'Ramadan Kareem', 'رمضان کریم', 'रमज़ान करीम', 'Ramadan Kareem', 'रमजान करिम', 'রমজান কারিম', 'Salam Ramadan'],
  ssnEid: ['Eid Mubarak', 'عيد مبارك', 'Aïd Moubarak', 'Eid Mubarak', 'Eid Mubarak', 'عید مبارک', 'ईद मुबारक', 'Eid Mubarak', 'ईद मुबारक', 'ঈদ মোবারক', 'Selamat Hari Raya'],
  yrTitle: ['Your {0} with MicroMobility', 'عامك {0} مع مايكروموبيليتي', 'Votre année {0} avec MicroMobility', 'Tu {0} con MicroMobility', 'O seu {0} com a MicroMobility', 'MicroMobility کے ساتھ آپ کا {0}', 'MicroMobility के साथ आपका {0}', 'Ang {0} mo kasama ang MicroMobility', 'MicroMobility सँग तपाईंको {0}', 'MicroMobility-র সাথে আপনার {0}', 'Tahun {0} anda bersama MicroMobility'],
  yrSoFar: ['Your year so far', 'عامك حتى الآن', 'Votre année jusqu’ici', 'Tu año hasta ahora', 'O seu ano até agora', 'اب تک آپ کا سال', 'अब तक आपका साल', 'Ang taon mo sa ngayon', 'अहिलेसम्मको तपाईंको वर्ष', 'এ পর্যন্ত আপনার বছর', 'Tahun anda setakat ini'],
  yrOpen: ['See your year', 'شاهد عامك', 'Voir votre année', 'Ver tu año', 'Ver o seu ano', 'اپنا سال دیکھیں', 'अपना साल देखें', 'Tingnan ang taon mo', 'आफ्नो वर्ष हेर्नुहोस्', 'আপনার বছর দেখুন', 'Lihat tahun anda'],
  yrRange: ['{0} to December', 'من {0} إلى ديسمبر', 'De {0} à décembre', 'De {0} a diciembre', 'De {0} a dezembro', '{0} سے دسمبر تک', '{0} से दिसंबर तक', '{0} hanggang Disyembre', '{0} देखि डिसेम्बरसम्म', '{0} থেকে ডিসেম্বর', '{0} hingga Disember'],
  yrSince: ['With us since {0}', 'معنا منذ {0}', 'Avec nous depuis le {0}', 'Con nosotros desde el {0}', 'Connosco desde {0}', '{0} سے ہمارے ساتھ', '{0} से हमारे साथ', 'Kasama namin mula {0}', '{0} देखि हामीसँग', '{0} থেকে আমাদের সাথে', 'Bersama kami sejak {0}'],
  yrSessions: ['Sessions', 'الأنشطة', 'Sessions', 'Sesiones', 'Sessões', 'سیشن', 'सत्र', 'Mga session', 'सत्र', 'সেশন', 'Sesi'],
  yrSatOf: ['{0} of {1} Saturdays', '{0} من {1} أيام سبت', '{0} samedis sur {1}', '{0} de {1} sábados', '{0} de {1} sábados', '{1} میں سے {0} ہفتے', '{1} में से {0} शनिवार', '{0} sa {1} Sabado', '{1} मध्ये {0} शनिबार', '{1}টির মধ্যে {0}টি শনিবার', '{0} daripada {1} Sabtu'],
  yrKinds: ['What you tried', 'ما جرّبته', 'Ce que vous avez essayé', 'Lo que probaste', 'O que experimentou', 'آپ نے کیا آزمایا', 'आपने क्या आज़माया', 'Ang mga sinubukan mo', 'तपाईंले के प्रयास गर्नुभयो', 'আপনি যা চেষ্টা করেছেন', 'Apa yang anda cuba'],
  yrBusiest: ['Your busiest month', 'أكثر شهر نشاطًا لك', 'Votre mois le plus actif', 'Tu mes más activo', 'O seu mês mais ativo', 'آپ کا مصروف ترین مہینہ', 'आपका सबसे व्यस्त महीना', 'Pinakaabala mong buwan', 'तपाईंको सबैभन्दा व्यस्त महिना', 'আপনার সবচেয়ে সক্রিয় মাস', 'Bulan tersibuk anda'],
  yrBadges: ['Badges this year', 'شارات هذا العام', 'Badges cette année', 'Insignias este año', 'Emblemas este ano', 'اس سال کے بیج', 'इस साल के बैज', 'Mga badge ngayong taon', 'यस वर्षका ब्याज', 'এ বছরের ব্যাজ', 'Lencana tahun ini'],
  yrShareOf: ['{0} of the club’s {1} sessions', '{0} من {1} جلسة للنادي', '{0} des {1} séances du club', '{0} de las {1} sesiones del club', '{0} das {1} sessões do clube', 'کلب کے {1} سیشنز میں سے {0}', 'क्लब के {1} सत्रों में से {0}', '{0} sa {1} session ng club', 'क्लबका {1} सत्रमध्ये {0}', 'ক্লাবের {1}টি সেশনের মধ্যে {0}টি', '{0} daripada {1} sesi kelab'],
  yrFirstOnly: ['Your first session: {0}', 'جلستك الأولى: {0}', 'Votre première séance : {0}', 'Tu primera sesión: {0}', 'A sua primeira sessão: {0}', 'آپ کا پہلا سیشن: {0}', 'आपका पहला सत्र: {0}', 'Ang una mong session: {0}', 'तपाईंको पहिलो सत्र: {0}', 'আপনার প্রথম সেশন: {0}', 'Sesi pertama anda: {0}'],
  yrNext: ['Your next challenge is ready', 'تحديك القادم جاهز', 'Votre prochain défi est prêt', 'Tu próximo reto está listo', 'O seu próximo desafio está pronto', 'آپ کا اگلا چیلنج تیار ہے', 'आपकी अगली चुनौती तैयार है', 'Handa na ang susunod mong hamon', 'तपाईंको अर्को चुनौती तयार छ', 'আপনার পরের চ্যালেঞ্জ প্রস্তুত', 'Cabaran anda seterusnya sudah tersedia'],
  yrShare: ['Share my year', 'شارك عامي', 'Partager mon année', 'Compartir mi año', 'Partilhar o meu ano', 'میرا سال شیئر کریں', 'मेरा साल साझा करें', 'Ibahagi ang taon ko', 'मेरो वर्ष साझा गर्नुहोस्', 'আমার বছর শেয়ার করুন', 'Kongsi tahun saya'],
  yrMy: ['My {0} with MicroMobility', 'عامي {0} مع مايكروموبيليتي', 'Mon année {0} avec MicroMobility', 'Mi {0} con MicroMobility', 'O meu {0} com a MicroMobility', 'MicroMobility کے ساتھ میرا {0}', 'MicroMobility के साथ मेरा {0}', 'Ang {0} ko kasama ang MicroMobility', 'MicroMobility सँग मेरो {0}', 'MicroMobility-র সাথে আমার {0}', 'Tahun {0} saya bersama MicroMobility'],
  yrShareMsg: ['My {0} with MicroMobility: {1} sessions, {2} Saturday rides.', 'عامي {0} مع مايكروموبيليتي: {1} نشاط، {2} رحلة سبت.', 'Mon année {0} avec MicroMobility : {1} sessions, {2} sorties du samedi.', 'Mi {0} con MicroMobility: {1} sesiones, {2} salidas de sábado.', 'O meu {0} com a MicroMobility: {1} sessões, {2} passeios de sábado.', 'MicroMobility کے ساتھ میرا {0}: {1} سیشن، ہفتے کی {2} سواریاں۔', 'MicroMobility के साथ मेरा {0}: {1} सत्र, {2} शनिवार राइड।', 'Ang {0} ko kasama ang MicroMobility: {1} session, {2} Saturday ride.', 'MicroMobility सँग मेरो {0}: {1} सत्र, {2} शनिबारे राइड।', 'MicroMobility-র সাথে আমার {0}: {1}টি সেশন, শনিবারের {2}টি রাইড।', 'Tahun {0} saya bersama MicroMobility: {1} sesi, {2} kayuhan Sabtu.'],
  monTitle: ['My month', 'شهري', 'Mon mois', 'Mi mes', 'O meu mês', 'میرا مہینہ', 'मेरा महीना', 'Ang buwan ko', 'मेरो महिना', 'আমার মাস', 'Bulan saya'],
  monSats: ['Saturdays ridden', 'أيام السبت التي ركبت فيها', 'Samedis roulés', 'Sábados rodados', 'Sábados pedalados', 'سواری والے ہفتے', 'राइड वाले शनिवार', 'Mga Sabadong nag-ride', 'राइड गरेका शनिबार', 'রাইড করা শনিবার', 'Sabtu berkayuh'],
  monBadges: ['Badges earned', 'الأوسمة المكتسبة', 'Badges obtenus', 'Insignias conseguidas', 'Conquistas obtidas', 'حاصل کیے گئے بیجز', 'अर्जित बैज', 'Mga nakuhang badge', 'कमाएका ब्याजहरू', 'অর্জিত ব্যাজ', 'Lencana yang diperoleh'],
  monVs: ['Sessions compared with {0}', 'الأنشطة مقارنةً بشهر {0}', 'Sessions par rapport à {0}', 'Sesiones respecto a {0}', 'Sessões face a {0}', '{0} کے مقابلے میں سیشن', '{0} की तुलना में सत्र', 'Mga session kumpara sa {0}', '{0} को तुलनामा सत्र', '{0}-এর তুলনায় সেশন', 'Sesi berbanding {0}'],
  prev: ['Previous', 'السابق', 'Précédent', 'Anterior', 'Anterior', 'پچھلا', 'पिछला', 'Nakaraan', 'अघिल्लो', 'আগের', 'Sebelumnya'],
  nextB: ['Next', 'التالي', 'Suivant', 'Siguiente', 'Seguinte', 'اگلا', 'अगला', 'Susunod', 'अर्को', 'পরের', 'Seterusnya'],
  close: ['Close', 'إغلاق', 'Fermer', 'Cerrar', 'Fechar', 'بند کریں', 'बंद करें', 'Isara', 'बन्द गर्नुहोस्', 'বন্ধ করুন', 'Tutup'],
  tip0: ['Arrive by the gathering time: the ride starts on time.', 'احضر في وقت التجمع، فالرحلة تنطلق في موعدها.', 'Arrivez à l’heure du rassemblement : le départ est à l’heure.', 'Llega a la hora de encuentro: la salida es puntual.', 'Chegue à hora do encontro: a partida é pontual.', 'جمع ہونے کے وقت تک پہنچیں، سواری وقت پر شروع ہوتی ہے۔', 'इकट्ठा होने के समय तक पहुँचें: राइड समय पर शुरू होती है।', 'Dumating bago ang oras ng pagtitipon: nagsisimula sa oras ang ride.', 'भेला हुने समयसम्म आइपुग्नुहोस्: राइड समयमै सुरु हुन्छ।', 'জমায়েতের সময়ের মধ্যে পৌঁছান: রাইড ঠিক সময়ে শুরু হয়।', 'Tiba sebelum waktu berkumpul: kayuhan bermula tepat pada masanya.'],
  tip1: ['First time? Tell the ride leader.', 'أول مرة؟ أخبر قائد الرحلة.', 'Première fois ? Dites-le au responsable de la sortie.', '¿Primera vez? Avisa al guía de la salida.', 'Primeira vez? Avise o líder do passeio.', 'پہلی بار؟ رائیڈ لیڈر کو بتائیں۔', 'पहली बार? राइड लीडर को बताएँ।', 'Unang beses? Sabihin sa ride leader.', 'पहिलो पटक? राइड लिडरलाई भन्नुहोस्।', 'প্রথমবার? রাইড লিডারকে জানান।', 'Kali pertama? Beritahu ketua kayuhan.'],
  tip2: ['Bring water, even on a cool morning.', 'أحضر الماء حتى في الصباح البارد.', 'Prenez de l’eau, même par une matinée fraîche.', 'Lleva agua, incluso en una mañana fresca.', 'Leve água, mesmo numa manhã fresca.', 'ٹھنڈی صبح میں بھی پانی ساتھ رکھیں۔', 'ठंडी सुबह में भी पानी साथ रखें।', 'Magdala ng tubig, kahit malamig ang umaga.', 'चिसो बिहानमा पनि पानी लिनुहोस्।', 'ঠান্ডা সকালেও পানি সঙ্গে রাখুন।', 'Bawa air, walaupun pada pagi yang sejuk.'],
  tip3: ['A helmet comes with every bike. Keep it fastened.', 'تأتي خوذة مع كل دراجة. أبقها مربوطة.', 'Un casque est fourni avec chaque vélo. Gardez-le attaché.', 'Cada bici viene con casco. Llévalo abrochado.', 'Cada bicicleta vem com capacete. Mantenha-o apertado.', 'ہر سائیکل کے ساتھ ہیلمٹ ملتا ہے۔ اسے بند رکھیں۔', 'हर साइकिल के साथ हेलमेट मिलता है। इसे बंधा रखें।', 'May kasamang helmet ang bawat bike. Panatilihin itong nakakabit.', 'हरेक साइकलसँग हेलमेट आउँछ। यसलाई बाँधेर राख्नुहोस्।', 'প্রতিটি সাইকেলের সাথে হেলমেট থাকে। এটি আটকে রাখুন।', 'Setiap basikal disertakan topi keledar. Pastikan ia sentiasa diikat.'],
  tip4: ['Riding your own bike? Check the tyres before you leave home.', 'تركب دراجتك؟ افحص الإطارات قبل أن تخرج من المنزل.', 'Vous venez avec votre vélo ? Vérifiez les pneus avant de partir.', '¿Vienes con tu bici? Revisa las ruedas antes de salir de casa.', 'Vem com a sua bicicleta? Verifique os pneus antes de sair de casa.', 'اپنی سائیکل لا رہے ہیں؟ گھر سے نکلنے سے پہلے ٹائر چیک کریں۔', 'अपनी साइकिल ला रहे हैं? घर से निकलने से पहले टायर जाँचें।', 'Sariling bike ang dala? Tingnan ang gulong bago umalis ng bahay.', 'आफ्नै साइकल? घरबाट निस्कनुअघि टायर जाँच्नुहोस्।', 'নিজের সাইকেল আনছেন? বাড়ি থেকে বের হওয়ার আগে টায়ার দেখে নিন।', 'Menunggang basikal sendiri? Periksa tayar sebelum anda keluar rumah.'],
  tip5: ['Keep a bike length from the rider in front.', 'حافظ على مسافة دراجة عن الراكب أمامك.', 'Gardez une longueur de vélo avec le cycliste devant vous.', 'Deja el largo de una bici con quien va delante.', 'Mantenha o comprimento de uma bicicleta do ciclista da frente.', 'آگے والے سوار سے ایک سائیکل جتنا فاصلہ رکھیں۔', 'आगे वाले राइडर से एक साइकिल जितनी दूरी रखें।', 'Panatilihin ang layong isang bike mula sa rider sa unahan.', 'अगाडिको राइडरबाट एउटा साइकल बराबर दूरी राख्नुहोस्।', 'সামনের রাইডার থেকে এক সাইকেল দূরত্ব রাখুন।', 'Jaga jarak sepanjang satu basikal daripada penunggang di hadapan.'],
  tip6: ['Say “stopping” before you brake in a group.', 'قل «توقف» قبل أن تضغط الفرامل في المجموعة.', 'Dites « stop » avant de freiner en groupe.', 'Avisa «paro» antes de frenar en grupo.', 'Diga «a parar» antes de travar em grupo.', 'گروپ میں بریک لگانے سے پہلے «رک رہا ہوں» کہیں۔', 'ग्रुप में ब्रेक लगाने से पहले «रुक रहा हूँ» कहें।', 'Sabihing “hihinto” bago magpreno sa grupo.', 'समूहमा ब्रेक लगाउनुअघि «रोकिँदै» भन्नुहोस्।', 'দলে ব্রেক করার আগে «থামছি» বলুন।', 'Sebut “berhenti” sebelum anda membrek dalam kumpulan.'],
  tip7: ['Eat something light an hour before you ride.', 'تناول شيئًا خفيفًا قبل الرحلة بساعة.', 'Mangez léger une heure avant de rouler.', 'Come algo ligero una hora antes de salir.', 'Coma algo leve uma hora antes de pedalar.', 'سواری سے ایک گھنٹہ پہلے کچھ ہلکا کھائیں۔', 'राइड से एक घंटा पहले कुछ हल्का खाएँ।', 'Kumain ng magaan isang oras bago mag-ride.', 'राइडभन्दा एक घण्टाअघि हल्का केही खानुहोस्।', 'রাইডের এক ঘণ্টা আগে হালকা কিছু খান।', 'Makan sesuatu yang ringan sejam sebelum berbasikal.'],
  tip8: ['Can’t come? Cancel your booking so someone else gets the place.', 'لن تحضر؟ ألغِ حجزك ليحصل غيرك على المكان.', 'Vous ne venez pas ? Annulez pour libérer la place.', '¿No puedes venir? Cancela tu reserva para que otra persona tenga la plaza.', 'Não pode vir? Cancele a reserva para outra pessoa ficar com o lugar.', 'نہیں آ سکتے؟ بکنگ منسوخ کریں تاکہ جگہ کسی اور کو مل جائے۔', 'नहीं आ सकते? बुकिंग रद्द करें ताकि जगह किसी और को मिले।', 'Hindi makakarating? I-cancel ang booking para may iba na makakuha ng puwesto.', 'आउन सक्नुहुन्न? बुकिङ रद्द गर्नुहोस् ताकि अरूले ठाउँ पाऊन्।', 'আসতে পারবেন না? বুকিং বাতিল করুন যাতে অন্য কেউ জায়গা পায়।', 'Tidak dapat hadir? Batalkan tempahan anda supaya orang lain mendapat tempat itu.'],
  tip9: ['Sunscreen and sunglasses help, even early in the day.', 'واقي الشمس والنظارة الشمسية مفيدان حتى في الصباح الباكر.', 'Crème solaire et lunettes de soleil aident, même tôt le matin.', 'Protector solar y gafas de sol ayudan, incluso temprano.', 'Protetor solar e óculos de sol ajudam, mesmo cedo.', 'صبح سویرے بھی سن اسکرین اور دھوپ کا چشمہ مفید ہیں۔', 'सुबह जल्दी भी सनस्क्रीन और धूप का चश्मा काम आते हैं।', 'Makakatulong ang sunscreen at sunglasses, kahit maaga pa.', 'बिहान सबेरै पनि सनस्क्रिन र सनग्लास काम लाग्छन्।', 'ভোরেও সানস্ক্রিন আর সানগ্লাস কাজে লাগে।', 'Pelindung matahari dan cermin mata hitam membantu, walaupun pada awal pagi.'],
  tip10: ['Keep right on the path and pass on the left.', 'التزم يمين المسار وتجاوز من اليسار.', 'Restez à droite et dépassez par la gauche.', 'Mantente a la derecha y adelanta por la izquierda.', 'Mantenha-se à direita e ultrapasse pela esquerda.', 'راستے کے دائیں رہیں اور بائیں سے آگے نکلیں۔', 'रास्ते के दाईं ओर रहें और बाईं ओर से आगे निकलें।', 'Manatili sa kanan at sa kaliwa dumaan kapag mag-o-overtake.', 'बाटोको दायाँ रहनुहोस् र बायाँबाट उछिन्नुहोस्।', 'পথের ডান দিকে থাকুন, বাঁ দিক দিয়ে পার হন।', 'Kekal di sebelah kanan laluan dan potong di sebelah kiri.'],
  tip11: ['Ride with a friend: you can invite one from this page.', 'اركب مع صديق: يمكنك دعوته من هذه الصفحة.', 'Roulez avec un ami : invitez-le depuis cette page.', 'Sal con un amigo: puedes invitarlo desde esta página.', 'Pedale com um amigo: pode convidá-lo a partir desta página.', 'کسی دوست کے ساتھ سواری کریں: اس صفحے سے دعوت دیں۔', 'किसी दोस्त के साथ राइड करें: इस पेज से न्योता भेजें।', 'Mag-ride kasama ang kaibigan: maaari mo siyang imbitahan mula rito.', 'साथीसँग राइड गर्नुहोस्: यही पृष्ठबाट निम्तो पठाउनुहोस्।', 'বন্ধুর সাথে রাইড করুন: এই পাতা থেকে আমন্ত্রণ পাঠান।', 'Berbasikal bersama rakan: anda boleh menjemput seorang dari halaman ini.'],
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
  // A way in that shows the member's challenge (a badge's pop-up, the rating's last step, "You're booked") opens Challenges.
  if (/^(badge|rating|booked)$/.test(S._hubVisit.src)) S._hubSec = 'goals';
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
    _monFetch(c, d); // My month (F13): a read of its own, from the 26th
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

// ── The Ramadan season (2026-11-18; the user picked "Ramadan season (about 8 Feb to 8 Mar 2027): a Ramadan challenge from
// the existing template, a season badge, an Eid ride and a Ramadan look for the tab") ─────────────────────────────────────
// The tab reads Ramadan's dates on its own (hub_season, migration 20261118210900: the Ramadan running now or the next one,
// as staff keep it in Community > Activities > Club goal), kept on the phone for six hours so the look paints at once. While
// today (Riyadh's date, todayStr, as the birthday week reads it) is between its first and last day the feed opens with a
// "Ramadan Kareem" card (a crescent and two lanterns, drawn here) and the next session's card wears night blue and gold
// (#hub-body.hub-ssn-on); on Eid al-Fitr's first three days the card says "Eid Mubarak". Gregorian dates only, no Hijri. A
// database without the function, a failed read or a member outside the dates: no card, no accent, nothing said. The season
// challenges themselves are ordinary staff challenges (goal_ramadan_2027, goal_eid_2027) that hub_feed sends in their dates.
// S._ssn: {id, at, ram: {from, to, eid} | null, off}.
const _SSN_KEY = 'cq_hub_ssn_', _SSN_TTL = 216e5;
function _ssnYmd(v) { const s = String(v || '').slice(0, 10); return /^\d{4}-\d\d-\d\d$/.test(s) ? s : ''; }
function _ssnDay(d, n) { return new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10); }
function _ssnRam(x) {
  const from = _ssnYmd(x && (x.from || x.starts_on)), to = _ssnYmd(x && (x.to || x.ends_on)), eid = _ssnYmd(x && (x.eid || x.eid_on));
  return from && to && eid && from <= to && to < eid ? { from, to, eid } : null;
}
function _ssnMine() { const c = _hCust(); return c && S._ssn && S._ssn.id === c.id ? S._ssn : null; }
function _ssnCheck() {
  const c = _hCust(); if (!c) return null;
  let s = S._ssn && S._ssn.id === c.id ? S._ssn : null;
  if (!s) {
    let k = null; try { k = JSON.parse(localStorage.getItem(_SSN_KEY + c.id) || 'null'); } catch (_) {}
    if (k && typeof k.at === 'number') s = S._ssn = { id: c.id, at: k.at, ram: _ssnRam(k.ram) };
  }
  if (!s || (!s.off && Date.now() - s.at >= _SSN_TTL)) _ssnFetch(c);
  return s;
}
async function _ssnFetch(c) {
  if (!c || !c.session_token || !sb || S._ssnBusy) return;
  S._ssnBusy = true;
  let r; try { r = await sb.rpc('hub_season', _hTok(c)); } catch (e) { r = { error: e }; }
  S._ssnBusy = false;
  const now = _hCust(); if (!now || now.id !== c.id) return; // signed out, or another account, meanwhile
  const was = S._ssn && S._ssn.id === c.id ? S._ssn : null, before = _ssnKind(was), d = r && !r.error && r.data;
  if (d && (d.ok === true || d.error === 'member')) {
    S._ssn = { id: c.id, at: Date.now(), ram: d.ok === true ? _ssnRam(d.ramadan) : null };
    try { localStorage.setItem(_SSN_KEY + c.id, JSON.stringify({ at: S._ssn.at, ram: S._ssn.ram })); } catch (_) {}
  } else if (r && r.error && (r.error.code === 'PGRST202' || r.error.code === '42883')) {
    S._ssn = { id: c.id, at: Date.now(), ram: null, off: true }; // a database before the migration: not asked again
  } else {
    S._ssn = { id: c.id, ram: was ? was.ram : null, at: Date.now() - _SSN_TTL + 12e4 }; // no answer: what shows stays, asked again in two minutes
  }
  if (S.custTab === 'members' && _ssnKind(S._ssn) !== before) _hubRender();
}
// 'ramadan' from its first day to its last, 'eid' on the three days after, else ''.
function _ssnKind(s) {
  const r = s && s.ram; if (!r) return '';
  const t0 = todayStr();
  return t0 >= r.from && t0 <= r.to ? 'ramadan' : t0 >= r.eid && t0 <= _ssnDay(r.eid, 2) ? 'eid' : '';
}
// A crescent with its star (BDG_GLYPH.crescent's lines) and two lanterns hanging on their cords, in the season's gold.
function _ssnArt() {
  const lamp = (x, y, k) => `<path class="hs-str" d="M${x + 12 * k} 0V${(y + 4.6 * k).toFixed(1)}"/><g transform="translate(${x} ${y}) scale(${k})"><path class="hs-cap" d="M8.4 4.6h7.2l-1.1 2.2H9.5z"/><path class="hs-glass" d="M8 7.4h8l1.6 4-1.6 7.2H8l-1.6-7.2z"/><path class="hs-core" d="M10.6 9.2h2.8v7.6h-2.8z"/><path class="hs-cap" d="M7.4 19h9.2l-1.2 2.8H8.6z"/></g>`;
  return `<svg class="hub-ssn-art" viewBox="0 0 124 56" aria-hidden="true" focusable="false"><g transform="translate(2 1) scale(2.25)"><path class="hs-moon" d="M15.6 3.2A9.3 9.3 0 1 0 15.6 20.8 8.83 8.83 0 1 1 15.6 3.2Z"/><path class="hs-star" d="M18.6 7.4l.68 1.87 1.98.06-1.57 1.23.56 1.91-1.65-1.12-1.65 1.12.56-1.91-1.57-1.23 1.98-.06z"/></g>${lamp(62, 6, 1.5)}${lamp(92, 16, 1.2)}</svg>`;
}
function _ssnHtml(kind) {
  if (!kind) return '';
  return `<div class="hub-card hub-ssn hub-ssn-${kind}"><strong class="hub-ssn-t">${esc(_hT(kind === 'eid' ? 'ssnEid' : 'ssnRam'))}</strong>${_ssnArt()}</div>`;
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
  if (HUB_VIEW_SEC[S._hubView]) S._hubSec = HUB_VIEW_SEC[S._hubView]; // a page of its own goes back to the part its card is in
  const ssn = _ssnKind(_ssnCheck());
  body.classList.toggle('hub-ssn-on', !!ssn);
  _mtFetch();
  _akListFetch();
  _intFetch();
  if (typeof _chtFabPaint === 'function') _chtFabPaint(); // the chat's button: its count, and hidden while the chat is open
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
  // Suggest a ride: written once, then only its list again, so a repaint keeps what the member is typing.
  if (S._hubView === 'suggest' && S._rsgOff) S._hubView = null;
  if (S._hubView === 'suggest' && c) { _rsgPaint(body, c); return; }
  // The Community chat: written once, then only its messages again, so a read landing never takes away what is being typed.
  if (S._hubView === 'chat' && S._chtOff) S._hubView = null;
  if (S._hubView === 'chat' && c) { _chtPaint(body, c); return; }
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
function _hubBoard(b) { const dep = window._hubDeps || {}; if (dep.board) dep.board({ board: b }); }
// The Updates list's way in (new features build F3, 2026-11-13): a button at the foot of the staff card, whichever of the
// three it is. The page draws it (window._hubDeps.upd), and repaints it when the unread count lands.
function _hubUpd(html) { const dep = window._hubDeps || {}, i = html.lastIndexOf('</div>'); return dep.upd && i >= 0 ? html.slice(0, i) + dep.upd() + html.slice(i) : html; }
// ── The tab's three parts (the user, 2026-11-20: "divide the community section in the booking app into sections becuz it
// looks so cluttered now") ──────────────────────────────────────────────────────────────────────────────────────────────
// It was one feed of up to twenty cards. Now a switch under the title, as Account's (Account, Stats, Badges):
//   Sessions:   the Ramadan card, the next session (the recap of the last one leading it on its day), the Build-up plan,
//               My interests (they order Coming up), Coming up, the staff card with the Updates button;
//   Challenges: the year (December and January), My month (from the 26th), the member's own challenge (or the first five
//               rides), Plan my Saturdays, the season challenges, the club's goal;
//   Leaderboard: the distance leaderboards' ways in (2026-11-27, distance-board.js);
//   Club:       the club's own places: Ask, the Mentorship programme, a call for volunteers, Suggest a ride, the invitation.
// "Couldn't refresh" and the birthday greeting sit above the parts, for all three. All three are drawn and two hidden, so a
// switch draws nothing and keeps what is typed. A part with nothing in it has no button (no "nothing here" line, the owner's
// rule of 2026-11-08); with one part only, no switch. S._hubSec names the part on screen (Sessions first); a page of its
// own (Ask, mentorship, Suggest a ride, the year) goes back to the part holding its card, and a way in that shows the
// member's challenge opens Challenges (_hubVisitNow).
const HUB_SECS = [['sess', 'secSess'], ['goals', 'secGoals'], ['board', 'secBoard'], ['club', 'secClub']];
const HUB_VIEW_SEC = { ask: 'club', mentor: 'club', suggest: 'club', year: 'goals' }; // the chat has no card: the part on screen stays
function _hubSecOf(parts) { // the part to show: the one picked, else the first with something in it
  const k = S._hubSec;
  return parts[k] ? k : (HUB_SECS.find(([x]) => parts[x]) || ['sess'])[0];
}
function _hubSecsHtml(parts, on) {
  const ks = HUB_SECS.filter(([k]) => parts[k]);
  if (ks.length < 2) return '';
  return `<div class="hub-secs" role="group" aria-label="${esc(t('mbTitle'))}">${ks.map(([k, w]) => `<button type="button" class="hub-sec${k === on ? ' active' : ''}" aria-pressed="${k === on}" aria-controls="hub-pane-${k}" data-hub-sec="${k}" data-on-click="${_on('_hubSecSet', k)}">${_hT(w)}</button>`).join('')}</div>`;
}
// The switch: the parts are already drawn, so only which one shows changes (and a page scrolled past the switch goes back
// to it, as Account's does).
function _hubSecSet(k) {
  if (!HUB_SECS.some(([x]) => x === k)) return;
  S._hubSec = k;
  const body = document.getElementById('hub-body'); if (!body) return;
  body.querySelectorAll('.hub-sec').forEach((b) => { const on = b.getAttribute('data-hub-sec') === k; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  body.querySelectorAll('.hub-pane').forEach((p) => { p.hidden = p.getAttribute('data-hub-sec') !== k; });
  const bar = body.querySelector('.hub-secs');
  if (bar && bar.getBoundingClientRect().top < 0) try { window.scrollTo({ top: 0 }); } catch (_) {}
}
function _feedHtml(c, d, stale) {
  const dep = window._hubDeps || {}, hero = _heroHtml(c, d);
  // A ride the member has just finished, with nothing else booked: its recap leads the page, before the next one to book.
  const staff = _hubUpd(_staffHtml(d));
  const parts = {
    sess: [
      _ssnHtml(_ssnKind(_ssnMine())),
      hero.recap ? staff : '',
      hero.html,
      _bupHtml(c), // the Build-up plan, right after the hero (2026-11-18)
      _intHtml(false),
      _soonHtml(c, hero.open),
      hero.recap ? '' : staff,
      _intHtml(true),
    ].join(''),
    goals: [
      d.year ? _yrCardHtml(d.year) : '',
      _monHtml(c, d),
      _p5Html() || _meHtml(d.me),
      _planHtml(),
      (Array.isArray(d.goals) ? d.goals : []).map(_seasonHtml).join(''),
      d.club ? _clubHtml(d.club) : '',
    ].join(''),
    club: [
      _akCardHtml(),
      _mtCardHtml(),
      d.volunteer && dep.vol ? `<div class="hub-card hub-flat"><span class="hub-k">${_cuIc('people', 16)} ${_hT('vol')}</span><a class="btn-secondary hub-wide hub-link" href="${esc(dep.vol + '/#o/' + encodeURIComponent(d.volunteer))}" target="_blank" rel="noopener">${_hT('volBtn')}</a></div>` : '',
      _rsgCardHtml(),
      dep.inv ? `<div class="hub-card hub-flat"><button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_hubInvite')}">${esc(dep.invLabel())}</button></div>` : '',
    ].join(''),
    // The distance leaderboards (2026-11-27): one way into each board; the page itself is distance-board.js.
    board: dep.board ? `<div class="hub-card hub-lb"><span class="hub-k">${_cuIc('flag', 16)} ${_hT('lbT')}</span><div class="hub-lb-go">${[['longest', 'lbLongest'], ['lifetime', 'lbLifetime'], ['year', 'lbYear']].map(([b, w]) => `<button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_hubBoard', b)}">${_hT(w)}</button>`).join('')}</div></div>` : '',
  };
  const on = _hubSecOf(parts);
  return [
    _hubSecsHtml(parts, on),
    stale ? `<div class="hub-card hub-stale" role="status"><span>${_hT('stale')}</span><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_hubRetry')}">${_hT('retry')}</button></div>` : '',
    d.birthday ? `<div class="hub-card hub-bday">${_cuIc('gift', 20)}<strong>${esc(_hF('bday', String((c && c.name) || '').trim().split(/\s+/)[0] || ''))}</strong></div>` : '',
    ...HUB_SECS.filter(([k]) => parts[k]).map(([k]) => `<div class="hub-pane" id="hub-pane-${k}" data-hub-sec="${k}"${k === on ? '' : ' hidden'}>${parts[k]}</div>`),
  ].join('');
}

// The member's next session: booked (soonest first, as Bookings lists them), else the next one they may book. Bookings and
// Reserve stay the only places that book: the card opens one of them.
// Not one over earlier today (the server refuses it, as the Reserve list drops it) and not one staff marked cancelled
// (bug hunt 2026-11-18 mod1-1, mod1-3).
function _hubOpen(c, n, skip) {
  const me = S.loggedIn || c, mine = new Set(getQueue().filter((e) => e.customerId === c.id && e.status !== 'cancelled').map((e) => e.sessionId));
  return allSessions().filter((s) => s && _isCommunity(s) && s.status === 'open' && !s.cancelled_at && s.ride_status !== 'cancelled' && !_sessPastDay(s) && !_sessEnded(s) && _bwOpen(s, 1) && !_sessFull(s) && _sgOk(s, me) && !mine.has(s.id) && s.id !== skip)
    .sort((a, b) => String(a.session_date || a.id).localeCompare(String(b.session_date || b.id))).slice(0, n);
}
// Members book first (20261118210800): a member books as usual, and the session wears the app's own mark while it runs.
function _hubMf(s) { return typeof _mfMarkHtml === 'function' ? _mfMarkHtml(s, 'hub-chip hub-mf') : ''; }
function _hubWhen(s) { const d = String(s.session_date || s.id).slice(0, 10); return `<bdi>${esc(_dayWord(d) || '')}${_dayWord(d) ? ' · ' : ''}${esc(shortDate(d))}</bdi> · <bdi>${sessionTime(s)}</bdi>`; }
// Staff's word on the ride (R10): the start moved, the route shortened, or the ride cancelled; a chip, never a sentence.
const HUB_RS = { moved: 'rsMoved', shortened: 'rsShort', cancelled: 'rsCancel' };
function _hubRs(s) {
  const v = s && s.ride_status;
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(HUB_RS, v) ? `<span class="hub-chip hub-rs hub-rs-${v}">${esc(_hT(HUB_RS[v]))}</span>` : '';
}
// Its two times as the ticket names them for its kind (R9): a ride that gathers, the gathering and the start (Victory
// Lap: doors open and the first heat; the Farm House Night: arrival and dinner); a circuit or Petromin night, bike collection (a waitlisted rider's own) and the
// start; anything else (the pool, a run, yoga, a workshop) its start and end. With the moments that set the card's state:
// when to turn up and when it starts (a start past midnight is the next day's).
function _hubTimes(s, e) {
  const dep = window._hubDeps || {};
  if (!s || !dep.slots || !dep.at || !dep.gathers) return null;
  const ds = String(s.session_date || s.id || '').slice(0, 10);
  const p = String((dep.slots(s.bike_slots) || {})._time || '').replace(/[<>"'&`]/g, '').split('-').map((x) => x.trim()).filter(Boolean);
  if (!p.length) return null;
  const vl = _rideKind(s) === 'vlap', fh = _rideKind(s) === 'farm', w = _hubW(); // the Farm House Night: arrival, then dinner (2026-11-13)
  let f, go, st;
  if (dep.gathers(s)) { f = [[vl ? w.doors : fh ? w.arrive : w.gather, p[0]], [vl ? w.heat : fh ? w.dinner : w.start, p[1]]]; go = p[0]; st = p[1] || p[0]; }
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
// No head counts on the next-session card (the user, 2026-11-13: "dont mention this to customers 216 going · 48
// first-timers"): hub_feed's `going` (F19) may still arrive, and nothing on the page reads it.
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
      <span class="hub-hero-m">${_hubWhen(s)}</span>${_sgChip(s)}${_hubMf(s)}${_hubRs(s)}
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
// A picked interest's sessions come first (in date order among themselves), each marked by a class only (My interests).
function _soonHtml(c, skip) {
  if (!c) return '';
  const all = _hubOpen(c, 99, skip), list = [...all.filter(_intHit), ...all.filter((s) => !_intHit(s))].slice(0, 3);
  if (!list.length) return '';
  return `<div class="hub-card"><span class="hub-k">${_hT('soon')}</span>${list.map((s) => `<div class="hub-soon${_intHit(s) ? ' int-on' : ''}">
      <span class="hub-soon-t"><strong><bdi>${esc(_evName(s))}</bdi></strong> ${_sgChip(s)}${_hubMf(s)}<small>${_hubWhen(s)}</small></span>
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
// stores that the member plans to come (hub_plans, migration 20261114081000, which only that member's own read returns),
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
// ── Build-up plan (the user, 2026-11-18) ────────────────────────────────────────────────────────────
// "When a member books a big event (T100, Victory Lap and the like), the tab counts down the Saturdays left and suggests
// which ones to book. It ticks each one off once they've ridden it. It builds on Plan my Saturdays." Staff mark the event
// with the session forms' Build-up plan switch (bike_slots._bup 1; never on a Saturday ride). The member's nearest place
// held on a marked date (waiting or checked in; never waitlisted or cancelled) that has not come yet gets one card right
// after the hero: the event's title as its ticket names it, its date, the Saturdays to go (from today, today too on a
// Saturday, to the day before), then one row per Saturday from the later of the booking's day and eight weeks before the
// event: Done with a tick (a Saturday ride finished), the date alone, dimmed (gone, not ridden), Booked, On the waitlist,
// Book (a ride the member may book now, the hero's own checks; it opens Reserve as the hero's Book does), Fully booked,
// Cancelled, the date alone, dimmed (every ride that day is for the other gender: none will open to them; bug hunt
// 2026-11-18, cf-platform1-2), or Not open yet. All from what the page holds (the member's own bookings, the sessions
// Reserve reads); no read of its own. The card's words never call the event a ride: it may be a run or a race.
function _bupDay(d, n) { const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function _bupSats(from, to) { // the Saturdays from `from` to `to`, both included
  const out = [];
  for (let d = _bupDay(from, (13 - new Date(from + 'T12:00:00Z').getUTCDay()) % 7); d <= to; d = _bupDay(d, 7)) out.push(d);
  return out;
}
const _bupYmd = (x) => String(x || '').slice(0, 10), _bupOk = (d) => /^\d{4}-\d\d-\d\d$/.test(d);
function _bupHtml(c) {
  const dep = window._hubDeps || {};
  if (!c || !dep.slots) return '';
  const today = todayStr(), me = S.loggedIn || c, Q = getQueue().filter((e) => e && e.customerId === c.id);
  let ev = null;
  for (const e of Q) {
    if (e.status !== 'waiting' && e.status !== 'active') continue;
    const s = _sessGet(e.sessionId), d = s ? _bupYmd(s.session_date || s.id) : '';
    if (!s || !_bupOk(d) || d <= today || s.cancelled_at || _rideKind(s) === 'saturday' || !(dep.slots(s.bike_slots) || {})._bup) continue;
    if (!ev || d < ev.d || (d === ev.d && String(s.id) < String(ev.s.id))) ev = { s, d };
  }
  if (!ev) return '';
  // From the booking's day (the member's first row on that date's session), or eight weeks before, whichever is later.
  const made = Q.filter((e) => e.sessionId === ev.s.id).map((e) => _ksaYmd(e.registeredAt)).filter(_bupOk).sort()[0] || '';
  const last = _bupDay(ev.d, -1), from = made > _bupDay(ev.d, -56) ? made : _bupDay(ev.d, -56);
  const togo = _bupSats(today, last).length, rows = _bupSats(from, last).slice(-8);
  if (!togo) return ''; // no Saturday left before the event (fixed 2026-11-18: the card stays until then, not a week before)
  const mine = {}, sats = {};
  for (const e of Q) { const s = _sessGet(e.sessionId); if (s && _rideKind(s) === 'saturday') { const k = _bupYmd(s.session_date || s.id); (mine[k] = mine[k] || []).push(e); }; }
  for (const s of S.sessions || []) { if (s && _rideKind(s) === 'saturday' && s.status !== 'deleted' && !s.draft) { const k = _bupYmd(s.session_date || s.id); (sats[k] = sats[k] || []).push(s); }; }
  const w = _hubW();
  let fmt = null; try { fmt = new Intl.DateTimeFormat(_locale(), { day: 'numeric', month: 'short', timeZone: 'UTC' }); } catch (_) {}
  const row = (d) => {
    const E = mine[d] || [], L = (sats[d] || []).filter((s) => !s.cancelled_at), past = d < today;
    let cls = '', end = '';
    if (E.some((e) => e.status === 'done' || (past && e.status === 'active'))) { cls = 'done'; end = `<span class="hub-bup-s">${_cuIc('tick', 14)}${_hT('goalDone')}</span>`; }
    else if (past) cls = 'past';
    else if (E.some((e) => e.status === 'waiting' || e.status === 'active')) { cls = 'held'; end = `<span class="hub-bup-s">${esc(w.booked || '')}</span>`; }
    else if (E.some((e) => e.status === 'waitlist')) end = `<span class="hub-bup-s">${_hT('wl')}</span>`;
    else {
      const ok = L.find((s) => s.status === 'open' && _bwOpen(s, 1) && !_sessFull(s) && _sgOk(s, me)); // a member books in a members-first window too, as the hero does
      if (ok) end = `<button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_hubBook', ok.id)}">${_hT('book')}</button>`;
      else if (L.some((s) => _sgOk(s, me) && (s.status === 'full' || (s.status === 'closed' && (dep.slots(s.bike_slots) || {})._fbk)))) end = `<span class="hub-bup-s">${esc(w.full || '')}</span>`;
      else if (L.length && !L.some((s) => _sgOk(s, me))) cls = 'none'; // only the other gender's rides that day: nothing to wait for
      else end = `<span class="hub-bup-s">${_hT(!L.length && (sats[d] || []).length ? 'rsCancel' : 'bupSoon')}</span>`;
    }
    let dt = d; try { if (fmt) dt = fmt.format(new Date(d + 'T12:00:00Z')); } catch (_) {}
    return `<li class="hub-bup-r${cls ? ' ' + cls : ''}"><span class="hub-bup-d"><bdi>${esc(dt)}</bdi></span>${end}</li>`;
  };
  return `<div class="hub-card hub-bup"><span class="hub-k">${_cuIc('flag', 16)} ${_hT('bup')}</span><strong class="hub-name"><bdi>${esc(_evName(ev.s))}</bdi></strong>
    <span class="hub-meta hub-bup-w"><bdi>${esc(_hDate(ev.d))}</bdi></span><strong class="hub-bup-n">${esc(togo === 1 ? _hT('bupOne') : _hF('bupN', togo))}</strong>
    ${rows.length ? `<ul class="hub-bup-l" aria-label="${esc(_hT('bupSats'))}">${rows.map(row).join('')}</ul>` : ''}</div>`;
}
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
// No "club in numbers" card (riders last Saturday, Saturday rides this month and since the start): the user, 2026-11-13,
// does not want them shown to customers. hub_feed's `numbers` may still arrive, and nothing on the page reads it.
// One staff card: the Saturday report showing now, else the site's first announcement, else the tip of the week.
// The report (R13, 2026-11-13; the server writes one after each Saturday ride, staff may add a line and a photo) is its
// photo, the member's own Saturdays this month when they rode it, and the staff's line. No head counts: the riders, rides,
// first Saturday rides, ride leads, volunteers, the change from last week and the month's club total were tiles here until
// bug hunt 2026-11-18 (mod1-2; the owner's rule of 2026-11-13: members never see the club's numbers). No names, no ranking.
function _staffHtml(d) {
  const p = d.post;
  if (p) {
    const line = _hPick(p, 'line', 'line_ar');
    const mine = p.mine != null && Number(p.mine) > 0 ? `<div class="hub-mine"><span>${esc(_hT('tMine'))}</span><strong>${_hN(p.mine)}</strong></div>` : '';
    return `<div class="hub-card hub-flat hub-report"><span class="hub-k">${_hT('report')}${p.date ? ` · <bdi>${esc(_hDate(p.date))}</bdi>` : ''}</span>
      ${p.img ? `<img class="hub-photo" data-hubimg="${esc(p.id)}" alt="">` : ''}
      ${mine}${line ? `<p class="hub-line"><bdi>${esc(line)}</bdi></p>` : ''}</div>`;
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

// ── My month (new features build F13, 2026-11-13) ───────────────────────────────────────────────
// From the 26th to the end of the month, a member with two or more finished sessions that month gets one card: the
// Saturdays they rode, their sessions by kind, the badges they earned this month, and one comparison with their own month
// before. Every number is the member's own; nothing compares them with anyone. The numbers come from a read of their own
// (hub_month, migration 20261114081300), asked only on those days, after the tab's read and by its date (the server's
// day in Riyadh). The database decides whether the card shows: its first day is site_content 'hub.month.from' (26
// December 2026), and it answers show false before that day, before the 26th and under two sessions; the page checks the
// same three on what came back. A database without the function, or a read that fails, shows no card and no error. The
// last good answer is kept on the phone per account, so the card paints with the rest of the tab.
const _MON_KEY = 'cq_hubm_';
function _monDay(d) { const s = String((d && d.today) || ''); return /^\d{4}-\d\d-\d\d$/.test(s) ? s : ''; }
function _monDue(d) { const s = _monDay(d); return !!s && Number(s.slice(8)) >= 26; }
function _monOk(m, day) {
  return !!m && m.ok === true && m.show === true && !!day && Number(day.slice(8)) >= 26
    && String(m.month || '').slice(0, 7) === day.slice(0, 7)
    && /^\d{4}-\d\d-\d\d$/.test(String(m.from || '')) && String(m.from) <= day
    && Number(m.sessions) >= 2;
}
async function _monFetch(c, d) {
  const day = _monDay(d);
  if (!sb || !c || !_monDue(d) || S._hubMonOff || S._hubMonBusy) return;
  const a = S._hubMon;
  if (a && a.forId === c.id && a.day === day && Date.now() - a.at < 12e4) return;
  S._hubMonBusy = true;
  let r; try { r = await sb.rpc('hub_month', _hTok(c)); } catch (e) { r = { error: e }; }
  S._hubMonBusy = false;
  const code = r && r.error && r.error.code;
  if (code === 'PGRST202' || code === '42883') { // a database before the migration: no card, and not asked again on this page
    S._hubMonOff = true; S._hubMon = null;
    try { localStorage.removeItem(_MON_KEY + c.id); } catch (_) {}
    if (S.custTab === 'members') _hubRender();
    return;
  }
  // Signed out, or another account signed in, while it was asked: the answer is not theirs. A read that failed keeps
  // what is in hand; the tab's next read asks again.
  const now = _hCust(), m = r && !r.error && r.data;
  if (!now || now.id !== c.id || !m || m.ok !== true) return;
  S._hubMon = { forId: c.id, at: Date.now(), day, m };
  try { if (m.show === true) localStorage.setItem(_MON_KEY + c.id, JSON.stringify({ day, m })); else localStorage.removeItem(_MON_KEY + c.id); } catch (_) {}
  if (S.custTab === 'members') _hubRender();
}
// The answer in hand for this account, else the copy on the phone.
function _monMine(c) {
  let a = S._hubMon;
  if (a && (!c || a.forId !== c.id)) a = S._hubMon = null;
  if (!a && c && !S._hubMonOff) {
    try { const x = JSON.parse(localStorage.getItem(_MON_KEY + c.id) || 'null'); if (x && x.m && x.m.ok === true) a = S._hubMon = { forId: c.id, at: 0, day: String(x.day || ''), m: x.m }; } catch (_) {}
  }
  return a ? a.m : null;
}
// Sessions by kind, most first. A session without a ride kind is the circuit's own (the database says 'rental').
function _monKinds(m) {
  const by = new Map();
  (Array.isArray(m.kinds) ? m.kinds : []).forEach((x) => {
    const k = x && typeof x.k === 'string' ? (x.k === 'rental' ? 'jcc' : x.k) : '', n = x ? Math.floor(Number(x.n)) : 0;
    if (k && n > 0) by.set(k, (by.get(k) || 0) + n);
  });
  return [...by].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n || a.k.localeCompare(b.k));
}
function _monIc(k) { return _own(KIND_IC, k) ? KIND_IC[k] : 'bike'; } // the app's own icon for each kind (_kindIc)
// The one comparison: this month's sessions against the member's own month before. None for a member whose first
// session is this month (the database sends no previous month).
function _monPrev(m) {
  const p = m.prev, ym = p ? String(p.month || '') : '';
  if (!p || p.sessions == null || !/^\d{4}-\d\d/.test(ym) || !Number.isFinite(Number(p.sessions))) return null;
  return { x: (Number(m.sessions) || 0) - Math.max(0, Math.floor(Number(p.sessions))), name: _hMonth(ym, false) };
}
function _monHtml(c, d) {
  if (!_monDue(d)) return '';
  const m = _monMine(c);
  if (!_monOk(m, _monDay(d))) return '';
  const st = (k, v, l) => `<div class="hub-stat" data-mon="${k}"><strong>${v}</strong><span>${esc(l)}</span></div>`;
  const p = _monPrev(m), kinds = _monKinds(m);
  const cells = [st('sats', _hN(m.saturdays), _hT('monSats')), st('sessions', _hN(m.sessions), _hT('yrSessions')), st('badges', _hN(m.badges), _hT('monBadges'))];
  if (p) cells.push(st('prev', `<bdi dir="ltr">${p.x > 0 ? '+' : p.x < 0 ? '-' : ''}${Math.abs(p.x)}</bdi>`, _hF('monVs', p.name)));
  return `<div class="hub-card hub-mon" id="hub-mon"><span class="hub-k">${_cuIc('cal', 16)} ${_hT('monTitle')}</span><strong class="hub-name"><bdi>${esc(_hMonth(String(m.month), true))}</bdi></strong>
    <div class="hub-stats">${cells.join('')}</div>
    ${kinds.length ? `<ul class="hub-kinds">${kinds.map((k) => `<li data-kind="${esc(k.k)}">${_cuIc(_monIc(k.k), 18)} <span>${esc(_evKindName(k.k))}</span><strong>${_hN(k.n)}</strong></li>`).join('')}</ul>` : ''}
    ${typeof _shrLoad === 'function' ? `<button type="button" class="btn-secondary hub-wide shr-btn" data-on-click="${_on('_monShare')}">${_cuIc('share', 16)}<span>${esc(t('tcShare'))}</span></button>` : ''}</div>`;
}
// The card as a picture, through the page's share pop-up (badge-share.js, F12), which asks _monSub what to draw: the
// month, then one line for each number above zero. A picture a member sends out says what they did: no "0 badges", the
// comparison only when it is a gain, and the kinds other than the Saturday ride (its Saturdays are the first line), three
// at most. ltr: how that file holds a number in its order inside a right-to-left line.
function _monShare() { if (typeof _shrLoad === 'function') _shrLoad({ kind: 'month' }); }
function _monSub(c, ltr) {
  const h = S._hub, d = h && c && h.forId === c.id ? h.d : null, a = S._hubMon, m = a && c && a.forId === c.id ? a.m : null;
  if (!d || !_monOk(m, _monDay(d))) return null;
  const n = (v) => (typeof ltr === 'function' ? ltr(v) : String(v)), row = (label, v) => label + ': ' + n(v);
  const lines = [], p = _monPrev(m);
  if (Number(m.saturdays) > 0) lines.push(row(_hT('monSats'), Number(m.saturdays)));
  lines.push(row(_hT('yrSessions'), Number(m.sessions)));
  _monKinds(m).filter((k) => k.k !== 'saturday').slice(0, 3).forEach((k) => lines.push(row(_evKindName(k.k), k.n)));
  if (Number(m.badges) > 0) lines.push(row(_hT('monBadges'), Number(m.badges)));
  if (p && p.x > 0) lines.push(row(_hF('monVs', p.name), '+' + p.x));
  return { label: _hT('monTitle'), name: _hMonth(String(m.month), true), level: '', date: '', club: '', medal: { icon: 'calcheck', color: 'green' }, lines, file: 'micromobility-' + String(m.month).slice(0, 7) };
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
  const kinds = [...new Set((Array.isArray(y.kinds) ? y.kinds : []).map((k) => (k === 'rental' ? 'jcc' : k)))].map((k) => `<li>${_cuIc(_monIc(k), 18)} <span>${esc(_evKindName(k))}</span></li>`).join('');
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
// them (Accept or Not now), their own offers, and the open profiles, which carry no name. The user, 2026-11-18: "i want
// mentees to be anonymous, only show their university and major": a mentee's profile shows mentors its number, university
// and field and nothing else (city, country, year, help and goal reach staff only; migration 20261118120000), so the offer
// form has no "Same city" either. A member starting university
// asks for a mentor here; staff publish it. A name and number cross only an accepted match (the one exception to
// "members see nobody", the user's own request); the read is mentor_feed, apart from hub_feed, and never kept on the phone.
// The user's two registrations (the same day: "Mentee registration", "Mentor registration & choosing from mentees list"):
// a student registers as a mentee (mentor_ask), a member registers once as a mentor (mentor_join, with the rules and the
// consent), and only a registered mentor offers on a profile from the list; Leave the programme ends it (mentor_quit).
Object.assign(HUB_T, {
  mtTitle: ["Mentorship", "الإرشاد", "Mentorat", "Mentoría", "Mentoria", "رہنمائی پروگرام", "मेंटरशिप", "Mentorship", "मेन्टरशिप", "মেন্টরশিপ", 'Bimbingan'],
  mtHelpName: ["Help a member starting university", "ساعد عضوًا يبدأ دراسته الجامعية", "Aidez un membre qui entre à l'université", "Ayuda a un miembro que empieza la universidad", "Ajude um membro que começa a universidade", "یونیورسٹی شروع کرنے والے رکن کی مدد کریں", "विश्वविद्यालय शुरू करने वाले सदस्य की मदद करें", "Tulungan ang miyembrong magsisimula sa unibersidad", "विश्वविद्यालय सुरु गर्दै गरेको सदस्यलाई सहयोग गर्नुहोस्", "বিশ্ববিদ্যালয় শুরু করা একজন সদস্যকে সাহায্য করুন", 'Bantu ahli yang baru memulakan pengajian universiti'],
  mtOpenN: ["Students looking for a mentor: {0}", "طلاب يبحثون عن مرشد: {0}", "Étudiants qui cherchent un mentor : {0}", "Estudiantes que buscan mentor: {0}", "Estudantes à procura de mentor: {0}", "رہنما کی تلاش میں طلبہ: {0}", "मेंटर ढूँढ रहे छात्र: {0}", "Mga estudyanteng naghahanap ng mentor: {0}", "मेन्टर खोजिरहेका विद्यार्थी: {0}", "মেন্টর খুঁজছে এমন শিক্ষার্থী: {0}", 'Pelajar yang mencari mentor: {0}'],
  mtSee: ["See the students", "عرض الطلاب", "Voir les étudiants", "Ver a los estudiantes", "Ver os estudantes", "طلبہ دیکھیں", "छात्र देखें", "Tingnan ang mga estudyante", "विद्यार्थीहरू हेर्नुहोस्", "শিক্ষার্থীদের দেখুন", 'Lihat pelajar'],
  mtAsk: ["Register as a mentee", "التسجيل كمسترشد", "S'inscrire comme mentoré", "Inscribirme como mentorizado", "Registar-me como mentorando", "رہنمائی لینے کے لیے رجسٹر کریں", "मेंटी के रूप में पंजीकरण करें", "Magparehistro bilang mentee", "मेन्टीको रूपमा दर्ता गर्नुहोस्", "মেন্টি হিসেবে নিবন্ধন করুন", 'Daftar sebagai mentee'],
  mtMatches: ["Your matches", "مطابقاتك", "Vos binômes", "Tus emparejamientos", "Os seus pares", "آپ کے جوڑ", "आपकी जोड़ियाँ", "Ang iyong mga kapareha", "तपाईंका जोडी", "আপনার জুটি", 'Padanan anda'],
  mtYourAsk: ["Your request", "طلبك", "Votre demande", "Tu solicitud", "O seu pedido", "آپ کی درخواست", "आपका अनुरोध", "Ang iyong hiling", "तपाईंको अनुरोध", "আপনার অনুরোধ", 'Permintaan anda'],
  mtYourOffers: ["Your offers", "عروضك", "Vos propositions", "Tus ofrecimientos", "As suas ofertas", "آپ کی پیشکشیں", "आपके प्रस्ताव", "Ang iyong mga alok", "तपाईंका प्रस्ताव", "আপনার প্রস্তাব", 'Tawaran anda'],
  mtStudents: ["Students looking for a mentor", "طلاب يبحثون عن مرشد", "Étudiants qui cherchent un mentor", "Estudiantes que buscan mentor", "Estudantes à procura de mentor", "رہنما کی تلاش میں طلبہ", "मेंटर ढूँढ रहे छात्र", "Mga estudyanteng naghahanap ng mentor", "मेन्टर खोजिरहेका विद्यार्थी", "মেন্টর খুঁজছে এমন শিক্ষার্থী", 'Pelajar yang mencari mentor'],
  mtNone: ["No student is looking for a mentor right now.", "لا يوجد طالب يبحث عن مرشد حاليًا.", "Aucun étudiant ne cherche de mentor pour le moment.", "Ahora mismo ningún estudiante busca mentor.", "Neste momento nenhum estudante procura mentor.", "اس وقت کوئی طالب علم رہنما نہیں ڈھونڈ رہا۔", "अभी कोई छात्र मेंटर नहीं ढूँढ रहा।", "Walang estudyanteng naghahanap ng mentor ngayon.", "अहिले कुनै विद्यार्थीले मेन्टर खोजिरहेको छैन।", "এই মুহূর্তে কোনো শিক্ষার্থী মেন্টর খুঁজছে না।", 'Tiada pelajar yang mencari mentor buat masa ini.'],
  mtProfile: ["Profile {0}", "الملف {0}", "Profil {0}", "Perfil {0}", "Perfil {0}", "پروفائل {0}", "प्रोफ़ाइल {0}", "Profile {0}", "प्रोफाइल {0}", "প্রোফাইল {0}", 'Profil {0}'],
  mtClass: ["Class of {0}", "دفعة {0}", "Promotion {0}", "Promoción {0}", "Turma de {0}", "بیچ {0}", "{0} बैच", "Batch {0}", "ब्याच {0}", "ব্যাচ {0}", 'Kohort {0}'],
  mtCanHelp: ["I can help", "يمكنني المساعدة", "Je peux aider", "Puedo ayudar", "Posso ajudar", "مدد کی پیشکش کریں", "मदद की पेशकश करें", "Makakatulong ako", "म सहयोग गर्न सक्छु", "আমি সাহায্য করতে পারি", 'Saya boleh bantu'],
  mtStOffered: ["Offer sent", "تم إرسال العرض", "Proposition envoyée", "Ofrecimiento enviado", "Oferta enviada", "پیشکش بھیج دی گئی", "प्रस्ताव भेजा गया", "Naipadala ang alok", "प्रस्ताव पठाइयो", "প্রস্তাব পাঠানো হয়েছে", 'Tawaran dihantar'],
  mtStProposed: ["With the student", "لدى الطالب", "Chez l'étudiant", "Con el estudiante", "Com o estudante", "طالب علم کے پاس", "छात्र के पास", "Nasa estudyante", "विद्यार्थीसँग", "শিক্ষার্থীর কাছে", 'Menunggu pelajar'],
  mtStMatched: ["Matched", "تمت المطابقة", "Binôme formé", "Emparejados", "Par formado", "جوڑ بن گیا", "जोड़ी बनी", "Nagkapareha", "जोडी बन्यो", "জুটি হয়েছে", 'Dipadankan'],
  mtStDeclined: ["Not this time", "ليس هذه المرة", "Pas cette fois", "Esta vez no", "Desta vez não", "اس بار نہیں", "इस बार नहीं", "Hindi sa ngayon", "यस पटक होइन", "এবার নয়", 'Bukan kali ini'],
  mtStEnded: ["Ended", "انتهت", "Terminé", "Terminado", "Terminado", "ختم", "समाप्त", "Natapos", "समाप्त", "শেষ", 'Tamat'],
  mtAskPending: ["Waiting for our team", "بانتظار فريقنا", "En attente de notre équipe", "Esperando a nuestro equipo", "À espera da nossa equipa", "ہماری ٹیم کا انتظار", "हमारी टीम की प्रतीक्षा", "Hinihintay ang aming team", "हाम्रो टोलीको प्रतीक्षामा", "আমাদের দলের অপেক্ষায়", 'Menunggu pasukan kami'],
  mtAskOpen: ["Looking for a mentor", "يبحث عن مرشد", "Recherche d'un mentor", "Buscando mentor", "À procura de mentor", "رہنما کی تلاش جاری", "मेंटर की तलाश", "Naghahanap ng mentor", "मेन्टर खोजिँदै", "মেন্টর খোঁজা হচ্ছে", 'Mencari mentor'],
  mtYourMentor: ["Your mentor", "مرشدك", "Votre mentor", "Tu mentor", "O seu mentor", "آپ کا رہنما", "आपके मेंटर", "Ang iyong mentor", "तपाईंको मेन्टर", "আপনার মেন্টর", 'Mentor anda'],
  mtYourStudent: ["Your student", "طالبك", "Votre étudiant", "Tu estudiante", "O seu estudante", "آپ کا طالب علم", "आपका छात्र", "Ang iyong estudyante", "तपाईंको विद्यार्थी", "আপনার শিক্ষার্থী", 'Pelajar anda'],
  mtWa: ["Message on WhatsApp", "مراسلة عبر واتساب", "Écrire sur WhatsApp", "Escribir por WhatsApp", "Enviar mensagem no WhatsApp", "واٹس ایپ پر پیغام بھیجیں", "WhatsApp पर संदेश भेजें", "Mag-message sa WhatsApp", "WhatsApp मा सन्देश पठाउनुहोस्", "WhatsApp-এ বার্তা পাঠান", 'Hantar mesej WhatsApp'],
  mtStepBack: ["Step back", "الانسحاب", "Me retirer", "Retirarme", "Sair", "الگ ہو جائیں", "पीछे हटें", "Umatras", "पछि हट्नुहोस्", "সরে দাঁড়ান", 'Undur diri'],
  mtStepBackQ: ["Step back from this match?", "الانسحاب من هذه المطابقة؟", "Vous retirer de ce binôme ?", "¿Retirarte de este emparejamiento?", "Sair deste par?", "اس جوڑ سے الگ ہو جائیں؟", "इस जोड़ी से पीछे हटें?", "Umatras sa pagpaparehang ito?", "यो जोडीबाट पछि हट्ने?", "এই জুটি থেকে সরে দাঁড়াবেন?", 'Undur diri daripada padanan ini?'],
  mtWithdraw: ["Withdraw offer", "سحب العرض", "Retirer la proposition", "Retirar ofrecimiento", "Retirar oferta", "پیشکش واپس لیں", "प्रस्ताव वापस लें", "Bawiin ang alok", "प्रस्ताव फिर्ता लिनुहोस्", "প্রস্তাব প্রত্যাহার করুন", 'Tarik balik tawaran'],
  mtWithdrawQ: ["Withdraw this offer?", "سحب هذا العرض؟", "Retirer cette proposition ?", "¿Retirar este ofrecimiento?", "Retirar esta oferta?", "یہ پیشکش واپس لیں؟", "यह प्रस्ताव वापस लें?", "Bawiin ang alok na ito?", "यो प्रस्ताव फिर्ता लिने?", "এই প্রস্তাব প্রত্যাহার করবেন?", 'Tarik balik tawaran ini?'],
  mtCloseAsk: ["Close my request", "إغلاق طلبي", "Fermer ma demande", "Cerrar mi solicitud", "Fechar o meu pedido", "میری درخواست بند کریں", "मेरा अनुरोध बंद करें", "Isara ang aking hiling", "मेरो अनुरोध बन्द गर्नुहोस्", "আমার অনুরোধ বন্ধ করুন", 'Tutup permintaan saya'],
  mtCloseAskQ: ["Close your request?", "إغلاق طلبك؟", "Fermer votre demande ?", "¿Cerrar tu solicitud?", "Fechar o seu pedido?", "اپنی درخواست بند کریں؟", "अपना अनुरोध बंद करें?", "Isara ang iyong hiling?", "आफ्नो अनुरोध बन्द गर्ने?", "আপনার অনুরোধ বন্ধ করবেন?", 'Tutup permintaan anda?'],
  mtEdit: ["Change", "تعديل", "Modifier", "Cambiar", "Alterar", "تبدیل کریں", "बदलें", "Baguhin", "परिवर्तन गर्नुहोस्", "পরিবর্তন করুন", 'Tukar'],
  mtOffered: ["A member offered to help you", "عرض عضو مساعدتك", "Un membre propose de vous aider", "Un miembro se ofrece a ayudarte", "Um membro ofereceu-se para ajudar", "ایک رکن نے آپ کی مدد کی پیشکش کی", "एक सदस्य ने आपकी मदद की पेशकश की", "May miyembrong nag-alok na tumulong sa iyo", "एक सदस्यले तपाईंलाई सहयोग गर्ने प्रस्ताव गरे", "একজন সদস্য আপনাকে সাহায্য করার প্রস্তাব দিয়েছেন", 'Seorang ahli menawarkan bantuan kepada anda'],
  mtAccept: ["Accept", "قبول", "Accepter", "Aceptar", "Aceitar", "قبول کریں", "स्वीकार करें", "Tanggapin", "स्वीकार गर्नुहोस्", "গ্রহণ করুন", 'Terima'],
  mtNotNow: ["Not now", "ليس الآن", "Pas maintenant", "Ahora no", "Agora não", "ابھی نہیں", "अभी नहीं", "Hindi muna", "अहिले होइन", "এখন নয়", 'Bukan sekarang'],
  mtNotNowQ: ["Turn down this offer?", "رفض هذا العرض؟", "Refuser cette proposition ?", "¿Rechazar este ofrecimiento?", "Recusar esta oferta?", "یہ پیشکش رد کریں؟", "यह प्रस्ताव अस्वीकार करें?", "Tanggihan ang alok na ito?", "यो प्रस्ताव अस्वीकार गर्ने?", "এই প্রস্তাব ফিরিয়ে দেবেন?", 'Tolak tawaran ini?'],
  mtCheckQ: ["Still in touch with {0}?", "هل ما زلت على تواصل مع {0}؟", "Toujours en contact avec {0} ?", "¿Sigues en contacto con {0}?", "Ainda em contacto com {0}?", "کیا {0} سے رابطہ ہے؟", "क्या {0} से संपर्क बना है?", "May komunikasyon pa ba kayo ni {0}?", "के {0} सँग सम्पर्क छ?", "{0}-এর সাথে কি যোগাযোগ আছে?", 'Masih berhubung dengan {0}?'],
  mtYes: ["Yes", "نعم", "Oui", "Sí", "Sim", "ہاں", "हाँ", "Oo", "हो", "হ্যাঁ", 'Ya'],
  mtNotYet: ["Not yet", "ليس بعد", "Pas encore", "Todavía no", "Ainda não", "ابھی تک نہیں", "अभी तक नहीं", "Hindi pa", "अहिलेसम्म छैन", "এখনো না", 'Belum'],
  mtNeedHelp: ["I need help from the team", "أحتاج مساعدة الفريق", "J'ai besoin de l'équipe", "Necesito ayuda del equipo", "Preciso de ajuda da equipa", "مجھے ٹیم کی مدد چاہیے", "मुझे टीम की मदद चाहिए", "Kailangan ko ng tulong ng team", "मलाई टोलीको सहयोग चाहिन्छ", "আমার দলের সাহায্য দরকার", 'Saya perlukan bantuan pasukan'],
  hpQuestions: ["Questions and coaching", "أسئلة وتوجيه", "Questions et conseils", "Preguntas y orientación", "Perguntas e orientação", "سوالات اور رہنمائی", "सवाल और मार्गदर्शन", "Mga tanong at gabay", "प्रश्न र मार्गदर्शन", "প্রশ্ন ও পরামর্শ", 'Soalan dan bimbingan'],
  hpSubjects: ["Choosing subjects", "اختيار المواد", "Choix des matières", "Elegir asignaturas", "Escolher disciplinas", "مضامین کا انتخاب", "विषय चुनना", "Pagpili ng mga subject", "विषय छनोट", "বিষয় বাছাই", 'Memilih subjek'],
  hpCv: ["CV review", "مراجعة السيرة الذاتية", "Relecture du CV", "Revisión del CV", "Revisão do CV", "سی وی کا جائزہ", "CV की समीक्षा", "Pagsusuri ng CV", "CV समीक्षा", "সিভি পর্যালোচনা", 'Semakan CV'],
  hpInternship: ["Summer internships", "التدريب الصيفي", "Stages d'été", "Prácticas de verano", "Estágios de verão", "گرمیوں کی انٹرن شپ", "ग्रीष्मकालीन इंटर्नशिप", "Summer internship", "ग्रीष्मकालीन इन्टर्नसिप", "গ্রীষ্মকালীন ইন্টার্নশিপ", 'Latihan industri musim panas'],
  hpJob: ["First job", "الوظيفة الأولى", "Premier emploi", "Primer empleo", "Primeiro emprego", "پہلی نوکری", "पहली नौकरी", "Unang trabaho", "पहिलो जागिर", "প্রথম চাকরি", 'Pekerjaan pertama'],
  hpUnilife: ["University life", "الحياة الجامعية", "Vie universitaire", "Vida universitaria", "Vida universitária", "یونیورسٹی کی زندگی", "विश्वविद्यालय जीवन", "Buhay sa unibersidad", "विश्वविद्यालय जीवन", "বিশ্ববিদ্যালয় জীবন", 'Kehidupan universiti'],
  hpCity: ["Settling into the city", "الاستقرار في المدينة", "S'installer dans la ville", "Instalarse en la ciudad", "Instalar-se na cidade", "شہر میں بسنا", "शहर में बसना", "Pag-aangkop sa lungsod", "सहरमा बसोबास", "শহরে মানিয়ে নেওয়া", 'Menyesuaikan diri di bandar'],
  hpTalk: ["Someone to talk to", "شخص للتحدث معه", "Quelqu'un à qui parler", "Alguien con quien hablar", "Alguém com quem falar", "بات کرنے کے لیے کوئی", "बात करने के लिए कोई", "Makakausap", "कुरा गर्ने कोही", "কথা বলার মতো কেউ", 'Seseorang untuk berbual'],
  lkUni: ["Same university", "الجامعة نفسها", "Même université", "Misma universidad", "Mesma universidade", "وہی یونیورسٹی", "वही विश्वविद्यालय", "Parehong unibersidad", "उही विश्वविद्यालय", "একই বিশ্ববিদ্যালয়", 'Universiti yang sama'],
  lkField: ["Same or a related degree", "التخصص نفسه أو قريب منه", "Diplôme identique ou proche", "Misma carrera o afín", "Mesmo curso ou afim", "وہی یا ملتی جلتی ڈگری", "वही या मिलती-जुलती डिग्री", "Pareho o kaugnay na kurso", "उही वा मिल्दोजुल्दो डिग्री", "একই বা সম্পর্কিত ডিগ্রি", 'Ijazah yang sama atau berkaitan'],
  lkCity: ["Lived or studied in this city", "عشت أو درست في هذه المدينة", "J'ai vécu ou étudié dans cette ville", "Viví o estudié en esta ciudad", "Vivi ou estudei nesta cidade", "اس شہر میں رہائش یا تعلیم", "इस शहर में रहना या पढ़ाई", "Nanirahan o nag-aral sa lungsod na ito", "यो सहरमा बसेको वा पढेको", "এই শহরে থেকেছি বা পড়েছি", 'Pernah tinggal atau belajar di bandar ini'],
  lkIndustry: ["Work in this field", "أعمل في هذا المجال", "Je travaille dans ce domaine", "Trabajo en este campo", "Trabalho nesta área", "اسی شعبے میں کام", "इसी क्षेत्र में काम", "Nagtatrabaho sa larangang ito", "यही क्षेत्रमा काम", "এই ক্ষেত্রে কাজ করি", 'Bekerja dalam bidang ini'],
  lkExperience: ["Other relevant experience", "خبرة أخرى ذات صلة", "Autre expérience utile", "Otra experiencia útil", "Outra experiência relevante", "دیگر متعلقہ تجربہ", "अन्य संबंधित अनुभव", "Ibang kaugnay na karanasan", "अन्य सम्बन्धित अनुभव", "অন্যান্য প্রাসঙ্গিক অভিজ্ঞতা", 'Pengalaman lain yang berkaitan'],
  mtLinksQ: ["How do you know this path?", "كيف تعرف هذا المسار؟", "Comment connaissez-vous ce parcours ?", "¿Cómo conoces este camino?", "Como conhece este percurso?", "آپ اس راستے کو کیسے جانتے ہیں؟", "आप इस राह को कैसे जानते हैं?", "Paano mo kilala ang landas na ito?", "तपाईं यो बाटो कसरी चिन्नुहुन्छ?", "আপনি এই পথ কীভাবে চেনেন?", 'Bagaimana anda mengenali laluan ini?'],
  mtHelpsQ: ["How can you help?", "كيف يمكنك المساعدة؟", "Comment pouvez-vous aider ?", "¿Cómo puedes ayudar?", "Como pode ajudar?", "آپ کیسے مدد کر سکتے ہیں؟", "आप कैसे मदद कर सकते हैं?", "Paano ka makakatulong?", "तपाईं कसरी सहयोग गर्न सक्नुहुन्छ?", "আপনি কীভাবে সাহায্য করতে পারেন?", 'Bagaimana anda boleh membantu?'],
  mtNoteQ: ["How could your experience help?", "كيف يمكن لخبرتك أن تساعد؟", "En quoi votre expérience peut-elle aider ?", "¿Cómo puede ayudar tu experiencia?", "Como pode a sua experiência ajudar?", "آپ کا تجربہ کیسے مدد کر سکتا ہے؟", "आपका अनुभव कैसे मदद कर सकता है?", "Paano makakatulong ang iyong karanasan?", "तपाईंको अनुभवले कसरी सहयोग गर्न सक्छ?", "আপনার অভিজ্ঞতা কীভাবে সাহায্য করতে পারে?", 'Bagaimana pengalaman anda boleh membantu?'],
  mtSend: ["Send", "إرسال", "Envoyer", "Enviar", "Enviar", "بھیجیں", "भेजें", "Ipadala", "पठाउनुहोस्", "পাঠান", 'Hantar'],
  mtUni: ["University", "الجامعة", "Université", "Universidad", "Universidade", "یونیورسٹی", "विश्वविद्यालय", "Unibersidad", "विश्वविद्यालय", "বিশ্ববিদ্যালয়", 'Universiti'],
  mtField: ["Field of study", "التخصص", "Domaine d'études", "Carrera", "Curso", "شعبۂ تعلیم", "अध्ययन का क्षेत्र", "Kurso", "अध्ययनको क्षेत्र", "পড়ার বিষয়", 'Bidang pengajian'],
  mtCity: ["City", "المدينة", "Ville", "Ciudad", "Cidade", "شہر", "शहर", "Lungsod", "सहर", "শহর", 'Bandar'],
  mtCountry: ["Country", "الدولة", "Pays", "País", "País", "ملک", "देश", "Bansa", "देश", "দেশ", 'Negara'],
  mtYear: ["Starting year", "سنة البدء", "Année de début", "Año de inicio", "Ano de início", "آغاز کا سال", "शुरुआत का वर्ष", "Taon ng pagsisimula", "सुरु हुने वर्ष", "শুরুর বছর", 'Tahun mula'],
  mtWantQ: ["What would help you?", "ما الذي سيساعدك؟", "Qu'est-ce qui vous aiderait ?", "¿Qué te ayudaría?", "O que o ajudaria?", "آپ کو کس چیز سے مدد ملے گی؟", "आपको किससे मदद मिलेगी?", "Ano ang makakatulong sa iyo?", "तपाईंलाई केले सहयोग गर्छ?", "কী আপনাকে সাহায্য করবে?", 'Apa yang boleh membantu anda?'],
  mtGoal: ["Your goal", "هدفك", "Votre objectif", "Tu objetivo", "O seu objetivo", "آپ کا مقصد", "आपका लक्ष्य", "Ang iyong layunin", "तपाईंको लक्ष्य", "আপনার লক্ষ্য", 'Matlamat anda'],
  mtPref: ["Mentor you prefer", "المرشد الذي تفضّله", "Mentor souhaité", "Mentor que prefieres", "Mentor que prefere", "پسندیدہ رہنما", "पसंदीदा मेंटर", "Mentor na gusto mo", "रुचाइएको मेन्टर", "পছন্দের মেন্টর", 'Mentor pilihan anda'],
  mtPrefAny: ["Either", "لا فرق", "Peu importe", "Me da igual", "Tanto faz", "کوئی بھی", "कोई भी", "Kahit sino", "जो भए पनि", "যে কেউ", 'Mana-mana'],
  mtPrefF: ["A woman", "امرأة", "Une femme", "Una mujer", "Uma mulher", "خاتون", "महिला", "Babae", "महिला", "নারী", 'Wanita'],
  mtPrefM: ["A man", "رجل", "Un homme", "Un hombre", "Um homem", "مرد", "पुरुष", "Lalaki", "पुरुष", "পুরুষ", 'Lelaki'],
  mtRules: ["Mentorship rules", "قواعد الإرشاد", "Règles du mentorat", "Normas de la mentoría", "Regras da mentoria", "رہنمائی کے اصول", "मेंटरशिप के नियम", "Mga patakaran ng mentorship", "मेन्टरशिपका नियम", "মেন্টরশিপের নিয়ম", 'Peraturan bimbingan'],
  mtR1: ["Be kind and respectful, and keep it about study, work and student life.", "اللطف والاحترام، والحديث عن الدراسة والعمل والحياة الجامعية.", "Soyez bienveillant et respectueux, et restez sur les études, le travail et la vie étudiante.", "Sé amable y respetuoso, y habla de estudios, trabajo y vida de estudiante.", "Seja simpático e respeitoso, e fale de estudos, trabalho e vida de estudante.", "مہربان اور باادب رہیں، اور بات تعلیم، کام اور طالب علمی کی زندگی تک رکھیں۔", "विनम्र और सम्मानजनक रहें, और बात पढ़ाई, काम और छात्र जीवन तक रखें।", "Maging mabait at magalang, at panatilihin ang usapan sa pag-aaral, trabaho at buhay-estudyante.", "दयालु र सम्मानजनक हुनुहोस्, र कुरा पढाइ, काम र विद्यार्थी जीवनमै राख्नुहोस्।", "সদয় ও সম্মানজনক থাকুন, এবং আলোচনা পড়াশোনা, কাজ ও ছাত্রজীবনের মধ্যে রাখুন।", 'Bersikap baik dan hormat, dan hadkan perbualan kepada pengajian, kerja dan kehidupan pelajar.'],
  mtR2: ["Never ask for or offer money, gifts or favours.", "لا طلب ولا عرض لمال أو هدايا أو خدمات.", "Ne demandez ni n'offrez jamais d'argent, de cadeaux ou de faveurs.", "Nunca pidas ni ofrezcas dinero, regalos ni favores.", "Nunca peça nem ofereça dinheiro, presentes ou favores.", "کبھی پیسے، تحفے یا احسان نہ مانگیں نہ پیش کریں۔", "कभी पैसे, तोहफ़े या एहसान न माँगें, न दें।", "Huwag humingi o mag-alok ng pera, regalo o pabor.", "पैसा, उपहार वा अनुग्रह कहिल्यै नमाग्नुहोस्, नदिनुहोस्।", "কখনো টাকা, উপহার বা সুবিধা চাইবেন না বা দেবেন না।", 'Jangan sekali-kali meminta atau menawarkan wang, hadiah atau pertolongan peribadi.'],
  mtR3: ["Keep what you learn about each other private.", "ما تعرفانه عن بعضكما يبقى بينكما.", "Gardez pour vous ce que vous apprenez l'un de l'autre.", "Guarda en privado lo que sepáis el uno del otro.", "Mantenha em privado o que souberem um do outro.", "ایک دوسرے کے بارے میں جو جانیں اسے راز رکھیں۔", "एक-दूसरे के बारे में जो जानें, उसे निजी रखें।", "Panatilihing pribado ang nalalaman ninyo tungkol sa isa't isa.", "एकअर्काबारे थाहा पाएका कुरा गोप्य राख्नुहोस्।", "একে অপরের সম্পর্কে যা জানবেন, তা গোপন রাখুন।", 'Rahsiakan apa yang anda ketahui tentang satu sama lain.'],
  mtR4: ["Meet online or in a public place.", "اللقاء عبر الإنترنت أو في مكان عام.", "Rencontrez-vous en ligne ou dans un lieu public.", "Quedad en línea o en un lugar público.", "Encontrem-se online ou num local público.", "آن لائن یا کسی عوامی جگہ پر ملیں۔", "ऑनलाइन या किसी सार्वजनिक जगह पर मिलें।", "Magkita online o sa pampublikong lugar.", "अनलाइन वा सार्वजनिक ठाउँमा भेट्नुहोस्।", "অনলাইনে বা জনসমাগমের জায়গায় দেখা করুন।", 'Bertemu dalam talian atau di tempat awam.'],
  mtR5: ["Tell our team if anything feels wrong. You can step back at any time.", "يمكن إبلاغ فريقنا بأي أمر مقلق، والانسحاب متاح في أي وقت.", "Prévenez notre équipe si quelque chose ne va pas. Vous pouvez vous retirer à tout moment.", "Avisa a nuestro equipo si algo no va bien. Puedes retirarte cuando quieras.", "Avise a nossa equipa se algo não estiver bem. Pode sair a qualquer momento.", "اگر کچھ غلط لگے تو ہماری ٹیم کو بتائیں۔ آپ کسی بھی وقت الگ ہو سکتے ہیں۔", "कुछ भी ठीक न लगे तो हमारी टीम को बताएँ। आप कभी भी पीछे हट सकते हैं।", "Sabihan ang aming team kung may hindi tama. Maaari kang umatras anumang oras.", "केही ठीक नलागे हाम्रो टोलीलाई भन्नुहोस्। तपाईं जुनसुकै बेला पछि हट्न सक्नुहुन्छ।", "কিছু ঠিক না লাগলে আমাদের দলকে জানান। আপনি যেকোনো সময় সরে দাঁড়াতে পারেন।", 'Beritahu pasukan kami jika ada sesuatu yang terasa tidak kena. Anda boleh mengundur diri pada bila-bila masa.'],
  mtAgree: ["I agree to the mentorship rules and to sharing my first name and WhatsApp number with my match once we both accept.", "أوافق على قواعد الإرشاد وعلى مشاركة اسمي الأول ورقم واتساب الخاص بي مع من تتم مطابقتي معه بعد قبولنا كلينا.", "J'accepte les règles du mentorat et le partage de mon prénom et de mon numéro WhatsApp avec mon binôme une fois que nous aurons tous deux accepté.", "Acepto las normas de la mentoría y compartir mi nombre y mi número de WhatsApp con mi pareja de mentoría cuando ambos aceptemos.", "Aceito as regras da mentoria e a partilha do meu primeiro nome e número de WhatsApp com o meu par quando ambos aceitarmos.", "میں رہنمائی کے اصولوں سے اور دونوں کی منظوری کے بعد اپنا پہلا نام اور واٹس ایپ نمبر اپنے جوڑ کے ساتھ شیئر کرنے پر متفق ہوں۔", "मैं मेंटरशिप के नियमों से और हम दोनों के स्वीकार करने के बाद अपना पहला नाम और WhatsApp नंबर अपनी जोड़ी के साथ साझा करने पर सहमत हूँ।", "Sumasang-ayon ako sa mga patakaran ng mentorship at sa pagbabahagi ng aking unang pangalan at WhatsApp number sa aking kapareha kapag pareho kaming pumayag.", "म मेन्टरशिपका नियम र हामी दुवैले स्वीकार गरेपछि मेरो पहिलो नाम र WhatsApp नम्बर मेरो जोडीसँग साझा गर्न सहमत छु।", "আমি মেন্টরশিপের নিয়ম মানছি এবং আমরা দুজনেই রাজি হলে আমার প্রথম নাম ও WhatsApp নম্বর আমার জুটির সাথে শেয়ার করতে সম্মত।", 'Saya bersetuju dengan peraturan bimbingan dan berkongsi nama pertama serta nombor WhatsApp saya dengan padanan saya sebaik sahaja kami berdua menerima.'],
  mtFill: ["Please fill this in.", "يرجى تعبئة هذا الحقل.", "Veuillez remplir ce champ.", "Rellena este campo.", "Preencha este campo.", "براہ کرم یہ پُر کریں۔", "कृपया इसे भरें।", "Pakipunan ito.", "कृपया यो भर्नुहोस्।", "অনুগ্রহ করে এটি পূরণ করুন।", 'Sila isi ruangan ini.'],
  mtPickOne: ["Please pick at least one.", "يرجى اختيار واحد على الأقل.", "Choisissez-en au moins un.", "Elige al menos uno.", "Escolha pelo menos um.", "کم از کم ایک چنیں۔", "कम से कम एक चुनें।", "Pumili ng kahit isa.", "कम्तीमा एउटा छान्नुहोस्।", "অন্তত একটি বেছে নিন।", 'Sila pilih sekurang-kurangnya satu.'],
  mtTick: ["Please tick to agree.", "يرجى وضع علامة للموافقة.", "Cochez pour accepter.", "Marca la casilla para aceptar.", "Assinale para aceitar.", "اتفاق کے لیے نشان لگائیں۔", "सहमति के लिए टिक करें।", "Lagyan ng tsek para pumayag.", "सहमतिका लागि टिक लगाउनुहोस्।", "সম্মতি দিতে টিক দিন।", 'Sila tandakan untuk bersetuju.'],
  mtGone: ["This is no longer open.", "لم يعد هذا متاحًا.", "Ce n'est plus ouvert.", "Ya no está abierto.", "Já não está disponível.", "یہ اب دستیاب نہیں۔", "यह अब उपलब्ध नहीं है।", "Hindi na ito bukas.", "यो अब उपलब्ध छैन।", "এটি আর খোলা নেই।", 'Ini tidak lagi dibuka.'],
  mtExists: ["You already have a request.", "لديك طلب بالفعل.", "Vous avez déjà une demande.", "Ya tienes una solicitud.", "Já tem um pedido.", "آپ کی ایک درخواست پہلے سے موجود ہے۔", "आपका एक अनुरोध पहले से है।", "Mayroon ka nang hiling.", "तपाईंको अनुरोध पहिले नै छ।", "আপনার একটি অনুরোধ আগে থেকেই আছে।", 'Anda sudah mempunyai permintaan.'],
  mtLimit: ["You have sent many offers today. Please try again tomorrow.", "أرسلت عروضًا كثيرة اليوم. يرجى المحاولة غدًا.", "Vous avez envoyé beaucoup de propositions aujourd'hui. Réessayez demain.", "Has enviado muchos ofrecimientos hoy. Inténtalo mañana.", "Enviou muitas ofertas hoje. Tente amanhã.", "آپ نے آج بہت سی پیشکشیں بھیجی ہیں۔ کل دوبارہ کوشش کریں۔", "आपने आज कई प्रस्ताव भेजे हैं। कल फिर कोशिश करें।", "Marami ka nang naipadalang alok ngayon. Subukan ulit bukas.", "तपाईंले आज धेरै प्रस्ताव पठाउनुभयो। भोलि फेरि प्रयास गर्नुहोस्।", "আপনি আজ অনেক প্রস্তাব পাঠিয়েছেন। আগামীকাল আবার চেষ্টা করুন।", 'Anda telah menghantar banyak tawaran hari ini. Sila cuba lagi esok.'],
  mtRegMentor: ["Register as a mentor", "التسجيل كمرشد", "S'inscrire comme mentor", "Inscribirme como mentor", "Registar-me como mentor", "بطور رہنما رجسٹر کریں", "मेंटर के रूप में पंजीकरण करें", "Magparehistro bilang mentor", "मेन्टरको रूपमा दर्ता गर्नुहोस्", "মেন্টর হিসেবে নিবন্ধন করুন", 'Daftar sebagai mentor'],
  mtYouMentor: ["You as a mentor", "أنت كمرشد", "Vous, mentor", "Tú como mentor", "Você como mentor", "آپ بطور رہنما", "मेंटर के रूप में आप", "Ikaw bilang mentor", "मेन्टरको रूपमा तपाईं", "মেন্টর হিসেবে আপনি", 'Anda sebagai mentor'],
  mtMUni: ["Where you studied", "أين درست", "Où vous avez étudié", "Dónde estudiaste", "Onde estudou", "آپ نے کہاں تعلیم حاصل کی", "आपने कहाँ पढ़ाई की", "Saan ka nag-aral", "तपाईंले कहाँ पढ्नुभयो", "আপনি কোথায় পড়েছেন", 'Tempat anda belajar'],
  mtMField: ["What you studied", "ماذا درست", "Ce que vous avez étudié", "Qué estudiaste", "O que estudou", "آپ نے کیا پڑھا", "आपने क्या पढ़ा", "Ano ang iyong pinag-aralan", "तपाईंले के पढ्नुभयो", "আপনি কী পড়েছেন", 'Bidang yang anda pelajari'],
  mtMWork: ["Your work or industry", "عملك أو مجالك", "Votre métier ou secteur", "Tu trabajo o sector", "O seu trabalho ou setor", "آپ کا کام یا شعبہ", "आपका काम या उद्योग", "Ang iyong trabaho o industriya", "तपाईंको काम वा क्षेत्र", "আপনার কাজ বা খাত", 'Pekerjaan atau industri anda'],
  mtMPlaces: ["Cities and countries you lived or studied in", "المدن والدول التي عشت أو درست فيها", "Villes et pays où vous avez vécu ou étudié", "Ciudades y países donde viviste o estudiaste", "Cidades e países onde viveu ou estudou", "وہ شہر اور ممالک جہاں آپ رہے یا پڑھے", "शहर और देश जहाँ आप रहे या पढ़े", "Mga lungsod at bansang tinirhan o pinag-aralan mo", "तपाईं बसेका वा पढेका सहर र देश", "যেসব শহর ও দেশে আপনি থেকেছেন বা পড়েছেন", 'Bandar dan negara tempat anda pernah tinggal atau belajar'],
  mtMAbout: ["How your experience could help students", "كيف يمكن لخبرتك أن تساعد الطلاب", "En quoi votre expérience peut aider des étudiants", "Cómo puede ayudar tu experiencia a los estudiantes", "Como a sua experiência pode ajudar estudantes", "آپ کا تجربہ طلبہ کی کیسے مدد کر سکتا ہے", "आपका अनुभव छात्रों की कैसे मदद कर सकता है", "Paano makakatulong ang karanasan mo sa mga estudyante", "तपाईंको अनुभवले विद्यार्थीलाई कसरी सहयोग गर्न सक्छ", "আপনার অভিজ্ঞতা শিক্ষার্থীদের কীভাবে সাহায্য করতে পারে", 'Bagaimana pengalaman anda boleh membantu pelajar'],
  mtLeaveProg: ["Leave the programme", "مغادرة البرنامج", "Quitter le programme", "Dejar el programa", "Sair do programa", "پروگرام چھوڑ دیں", "कार्यक्रम छोड़ें", "Umalis sa programa", "कार्यक्रम छोड्नुहोस्", "প্রোগ্রাম ছেড়ে দিন", 'Keluar daripada program'],
  mtLeaveProgQ: ["Leave the programme? Your offers are withdrawn and your matches end.", "مغادرة البرنامج؟ ستُسحب عروضك وتنتهي مطابقاتك.", "Quitter le programme ? Vos propositions sont retirées et vos binômes prennent fin.", "¿Dejar el programa? Tus ofrecimientos se retiran y tus emparejamientos terminan.", "Sair do programa? As suas ofertas são retiradas e os seus pares terminam.", "پروگرام چھوڑیں؟ آپ کی پیشکشیں واپس اور جوڑ ختم ہو جائیں گے۔", "कार्यक्रम छोड़ें? आपके प्रस्ताव वापस और जोड़ियाँ समाप्त हो जाएँगी।", "Umalis sa programa? Babawiin ang iyong mga alok at matatapos ang iyong mga pagpapareha.", "कार्यक्रम छोड्ने? तपाईंका प्रस्ताव फिर्ता हुनेछन् र जोडी अन्त्य हुनेछन्।", "প্রোগ্রাম ছাড়বেন? আপনার প্রস্তাব প্রত্যাহার হবে এবং জুটি শেষ হবে।", 'Keluar daripada program? Tawaran anda akan ditarik balik dan padanan anda akan tamat.'],
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
    ? `<div class="mt-line">${esc(_hF('mtProfile', o.num))} · <bdi>${esc(o.university || '')}</bdi></div><div class="hub-meta"><bdi>${esc(o.field || '')}</bdi></div>`
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
  _mtModal('mt-of', _hF('mtProfile', num), `<div class="mt-sum"><strong><bdi>${esc(p.university || '')}</bdi></strong><span><bdi>${esc(p.field || '')}</bdi></span></div>
    ${_mtChipGroup('links', MT_LINKS.filter((k) => k !== 'city'), MT_LINK_K, [], _hT('mtLinksQ'))}
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
  // The year a waiting request holds is offered too, outside this year's window (bug hunt 2026-11-18, app50-4): the first
  // option showed, and sending it again wrote that over the class year.
  const ys = [y - 1, y, y + 1, y + 2, y + 3];
  if (!ys.includes(yr)) { ys.push(yr); ys.sort((p, q) => p - q); }
  const years = ys.map((v) => `<option value="${v}"${v === yr ? ' selected' : ''}>${v}</option>`).join('');
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
  akTitle: ['Have your say', 'شاركنا رأيك', 'Donnez votre avis', 'Danos tu opinión', 'Dê a sua opinião', 'اپنی رائے دیں', 'अपनी राय दें', 'Ibahagi ang iyong opinyon', 'आफ्नो विचार राख्नुहोस्', 'আপনার মতামত দিন', 'Suarakan pendapat anda'],
  akGo: ['Answer', 'أجب', 'Répondre', 'Responder', 'Responder', 'جواب دیں', 'जवाब दें', 'Sumagot', 'जवाफ दिनुहोस्', 'উত্তর দিন', 'Jawapan'],
  akOpen: ['Open', 'فتح', 'Ouvrir', 'Abrir', 'Abrir', 'کھولیں', 'खोलें', 'Buksan', 'खोल्नुहोस्', 'খুলুন', 'Buka'],
  akProg: ['{0} of {1} answered', 'أجبت عن {0} من {1}', 'Répondu : {0} sur {1}', 'Respondidas: {0} de {1}', 'Respondidas: {0} de {1}', '{1} میں سے {0} کا جواب دیا', '{1} में से {0} का जवाब दिया', 'Nasagot ang {0} sa {1}', '{1} मध्ये {0} को जवाफ दिइयो', '{1}টির মধ্যে {0}টির উত্তর দেওয়া হয়েছে', '{0} daripada {1} dijawab'],
  akUntil: ['Open until {0}', 'مفتوح حتى {0}', 'Ouvert jusqu’au {0}', 'Abierta hasta {0}', 'Aberta até {0}', '{0} تک کھلا ہے', '{0} तक खुला है', 'Bukas hanggang {0}', '{0} सम्म खुला', '{0} পর্যন্ত খোলা', 'Dibuka hingga {0}'],
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
  S._ak = null; // opened again, the page is read again (answers sent elsewhere, edits by staff; bug hunt 2026-11-18 mod0-2)
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

// ── My interests (the user, 2026-11-18: "the member picks what they want ... Coming up and Updates then show those first";
// migration 20261118210300) ─────────────────────────────────────────────────────────────────────────────────────────
// One card: until the member has saved once it sits right after the next session, its chips ticked from their sport answer
// (member_interests_get's 'suggested'; nothing is kept until Save); afterwards it sits near the end of the feed with their
// picks and Change. Coming up lists the sessions of a picked interest first, each marked by a class, no word. The list of
// keys is the database's _interest_keys() and the staff side's INT_K; 'women' only for an account the database offers it
// to. The read is its own, never kept on the phone; a database without it hides the card.
const INT_KEYS = ['saturday', 'circuit', 'road', 'petromin', 'women', 'learn', 'runs', 'races', 'swim', 'yoga', 'farm', 'charity'];
// The kind each session counts under (the app's _rideKind); road, women and a triathlon event are read off the session.
const INT_KIND = { saturday: 'saturday', jcc: 'circuit', petromin: 'petromin', workshop: 'learn', runher: 'runs', defe5k: 'runs', vlap: 'races', arena: 'races', swim: 'swim', yoga: 'yoga', farm: 'farm', blood: 'charity', paint: 'learn', wed: 'saturday' };
Object.assign(HUB_T, {
  intTitle: ['Your interests', 'اهتماماتك', 'Vos centres d’intérêt', 'Tus intereses', 'Os seus interesses', 'آپ کی دلچسپیاں', 'आपकी रुचियाँ', 'Ang iyong mga interes', 'तपाईंका रुचिहरू', 'আপনার আগ্রহ', 'Minat anda'],
  intSave: ['Save', 'حفظ', 'Enregistrer', 'Guardar', 'Salvar', 'محفوظ کریں', 'सहेजें', 'I-save', 'सेभ गर्नुहोस्', 'সংরক্ষণ করুন', 'Simpan'],
  intChange: ['Change', 'تغيير', 'Modifier', 'Cambiar', 'Alterar', 'تبدیل کریں', 'बदलें', 'Baguhin', 'परिवर्तन गर्नुहोस्', 'পরিবর্তন করুন', 'Tukar'],
  intChoose: ['Choose', 'اختر', 'Choisir', 'Elegir', 'Escolher', 'منتخب کریں', 'चुनें', 'Pumili', 'छान्नुहोस्', 'বেছে নিন', 'Pilih'],
  intLimit: ['Too many changes. Please try again in an hour.', 'تغييرات كثيرة. يرجى المحاولة بعد ساعة.', 'Trop de modifications. Réessayez dans une heure.', 'Demasiados cambios. Inténtalo de nuevo en una hora.', 'Alterações demais. Tente novamente daqui a uma hora.', 'بہت زیادہ تبدیلیاں۔ ایک گھنٹے بعد دوبارہ کوشش کریں۔', 'बहुत ज़्यादा बदलाव। एक घंटे बाद फिर कोशिश करें।', 'Masyadong maraming pagbabago. Subukang muli pagkalipas ng isang oras.', 'धेरै परिवर्तन भए। एक घण्टापछि फेरि प्रयास गर्नुहोस्।', 'অনেক বেশি পরিবর্তন। এক ঘণ্টা পরে আবার চেষ্টা করুন।', 'Terlalu banyak perubahan. Sila cuba lagi dalam sejam.'],
  int_saturday: ['Saturday Social Rides', 'جولات السبت الاجتماعية', 'Sorties sociales du samedi', 'Salidas sociales del sábado', 'Passeios sociais de sábado', 'ہفتے کی سوشل رائیڈز', 'शनिवार की सोशल राइड', 'Mga Social Ride tuwing Sabado', 'शनिबारको सोसल राइड', 'শনিবারের সোশ্যাল রাইড', 'Kayuhan Sosial Sabtu'],
  int_circuit: ['Circuit nights', 'ليالي الحلبة', 'Soirées sur circuit', 'Noches en el circuito', 'Noites no circuito', 'سرکٹ کی راتیں', 'सर्किट नाइट्स', 'Mga gabi sa circuit', 'सर्किट रातहरू', 'সার্কিট নাইট', 'Malam litar'],
  int_road: ['Road bike rides', 'جولات الدراجات الطرقية', 'Sorties en vélo de route', 'Salidas en bici de carretera', 'Passeios de bicicleta de estrada', 'روڈ بائیک رائیڈز', 'रोड बाइक राइड', 'Mga ride sa road bike', 'रोड बाइक राइड', 'রোড বাইক রাইড', 'Kayuhan basikal jalan raya'],
  int_petromin: ['Petromin nights', 'ليالي بترومين', 'Soirées Petromin', 'Noches Petromin', 'Noites Petromin', 'پیٹرومن کی راتیں', 'पेट्रोमिन नाइट्स', 'Mga gabi ng Petromin', 'पेट्रोमिन रातहरू', 'পেট্রোমিন নাইট', 'Malam Petromin'],
  int_women: ['Women’s sessions', 'جلسات للسيدات', 'Séances pour femmes', 'Sesiones para mujeres', 'Sessões para mulheres', 'خواتین کے سیشن', 'महिलाओं के सत्र', 'Mga session para sa kababaihan', 'महिलाका सत्रहरू', 'নারীদের সেশন', 'Sesi wanita'],
  int_learn: ['Learning and workshops', 'التعلّم وورش العمل', 'Apprentissage et ateliers', 'Aprendizaje y talleres', 'Aprendizado e workshops', 'سیکھنا اور ورکشاپس', 'सीखना और वर्कशॉप', 'Pag-aaral at mga workshop', 'सिकाइ र कार्यशाला', 'শেখা ও কর্মশালা', 'Pembelajaran dan bengkel'],
  int_runs: ['Runs', 'الجري', 'Courses à pied', 'Carreras a pie', 'Corridas', 'دوڑ', 'दौड़', 'Takbo', 'दौड', 'দৌড়', 'Larian'],
  int_races: ['Races', 'السباقات', 'Compétitions', 'Competiciones', 'Competições', 'ریسز', 'रेस', 'Mga karera', 'रेसहरू', 'রেস', 'Perlumbaan'],
  int_swim: ['Swimming', 'السباحة', 'Natation', 'Natación', 'Natação', 'تیراکی', 'तैराकी', 'Paglangoy', 'पौडी', 'সাঁতার', 'Renang'],
  int_yoga: ['Yoga', 'اليوغا', 'Yoga', 'Yoga', 'Ioga', 'یوگا', 'योग', 'Yoga', 'योग', 'যোগ', 'Yoga'],
  int_farm: ['Farm House Nights', 'ليالي المزرعة', 'Soirées à la ferme', 'Noches en la granja', 'Noites na fazenda', 'فارم ہاؤس کی راتیں', 'फ़ार्म हाउस नाइट्स', 'Mga gabi sa Farm House', 'फार्म हाउस रातहरू', 'ফার্ম হাউস নাইট', 'Malam di Ladang'],
  int_charity: ['Charity and blood donation', 'العمل الخيري والتبرع بالدم', 'Solidarité et don du sang', 'Solidaridad y donación de sangre', 'Solidariedade e doação de sangue', 'خیرات اور خون کا عطیہ', 'परोपकार और रक्तदान', 'Kawanggawa at pag-donate ng dugo', 'परोपकार र रक्तदान', 'দাতব্য ও রক্তদান', 'Amal dan derma darah'],
});
function _intData() { const c = _hCust(), x = S._int; return c && x && x.forId === c.id && !x.off ? x.d : null; }
async function _intFetch(force) {
  const c = _hCust(); if (!c || !sb || S._intBusy) return;
  const x = S._int;
  if (x && x.forId === c.id && (x.off || (!force && Date.now() - x.at < 12e4))) return;
  S._intBusy = true;
  let r; try { r = await sb.rpc('member_interests_get', _hTok(c)); } catch (e) { r = { error: e }; }
  S._intBusy = false;
  const now = _hCust(); if (!now || now.id !== c.id) return;
  const e = r && r.error, d = r && !e && r.data;
  if (e && (e.code === 'PGRST202' || e.code === '42883')) S._int = { forId: c.id, at: Date.now(), off: true };
  else if (d && d.ok === true) {
    const ok = (a) => (Array.isArray(a) ? a : []).filter((k) => INT_KEYS.includes(k));
    S._int = { forId: c.id, at: Date.now(), d: { saved: !!d.saved, keys: ok(d.keys), suggested: ok(d.suggested), offered: ok(d.offered) } };
  } else if (x && x.forId === c.id && x.d) x.at = Date.now();
  else S._int = { forId: c.id, at: Date.now(), d: null };
  if (S.custTab === 'members' && !S._hubView) _hubRender();
}
// The keys a session counts under.
function _intOf(s) {
  const k = _rideKind(s), out = INT_KIND[k] ? [INT_KIND[k]] : [];
  if (k === 'event' && /triathlon|ترايثلون/i.test(String(s.title || '') + ' ' + String(s.title_ar || ''))) out.push('swim');
  if (_needsBike(s) && !_typeClosed(s, 'Road')) out.push('road');
  if (s.gender_only === 'female') out.push('women');
  return out;
}
// The member's saved picks (none before a first save: suggestions order nothing).
function _intMine() { const d = _intData(); return d && d.saved ? d.keys : []; }
function _intHit(s) { const m = _intMine(); return m.length > 0 && _intOf(s).some((k) => m.includes(k)); }
// The draft while the chips are open: a first-time member's suggestions, else what they saved.
function _intDraft(d) {
  const c = _hCust(), e = S._intEd;
  if (e && c && e.forId === c.id) return e;
  if (d.saved) return null;
  return (S._intEd = { forId: c && c.id, keys: d.suggested.filter((k) => d.offered.includes(k)) });
}
function _intHtml(end) {
  const d = _intData(); if (!d || d.saved !== end) return '';
  const ed = _intDraft(d), head = `<span class="hub-k" id="int-t">${_cuIc('star', 16)} ${_hT('intTitle')}</span>`;
  if (!ed) {
    const mine = d.keys.filter((k) => HUB_T['int_' + k]);
    return `<div class="hub-card int-card">${head}${mine.length ? `<ul class="mt-chips">${mine.map((k) => `<li>${esc(_hT('int_' + k))}</li>`).join('')}</ul>` : ''}
      <button type="button" class="btn-secondary hub-wide int-go" id="int-change" data-on-click="${_on('_intEdit')}">${_hT(mine.length ? 'intChange' : 'intChoose')}</button></div>`;
  }
  const chips = INT_KEYS.filter((k) => d.offered.includes(k) || ed.keys.includes(k)).map((k) => {
    const on = ed.keys.includes(k);
    return `<button type="button" class="mt-chip int-chip${on ? ' on' : ''}" aria-pressed="${on}" data-k="${k}" data-on-click="${_on('_intTog', _EL)}">${esc(_hT('int_' + k))}</button>`;
  }).join('');
  return `<div class="hub-card int-card">${head}<div class="mt-picks int-picks" role="group" aria-labelledby="int-t">${chips}</div>
    <div class="int-acts">${d.saved ? `<button type="button" class="btn-secondary" data-on-click="${_on('_intCancel')}">${esc(t('cancelBtn'))}</button>` : ''}<button type="button" class="btn-primary int-go" id="int-save" data-on-click="${_on('_intSave')}">${_hT('intSave')}</button></div></div>`;
}
function _intEdit() {
  const d = _intData(), c = _hCust(); if (!d || !c) return;
  S._intEd = { forId: c.id, keys: d.keys.slice() };
  _hubRender();
  const f = document.querySelector('#hub-body .int-chip'); if (f) try { f.focus({ preventScroll: true }); } catch (_) {}
}
function _intCancel() { S._intEd = null; _hubRender(); const b = document.getElementById('int-change'); if (b) try { b.focus({ preventScroll: true }); } catch (_) {} }
// A tap flips the chip where it is: no repaint, so the focus stays on it.
function _intTog(el) {
  const c = _hCust(), d = _intData(), k = el && el.getAttribute('data-k'); if (!c || !d || !INT_KEYS.includes(k)) return;
  const ed = _intDraft(d) || (S._intEd = { forId: c.id, keys: d.keys.slice() });
  const on = !ed.keys.includes(k);
  ed.keys = on ? INT_KEYS.filter((x) => x === k || ed.keys.includes(x)) : ed.keys.filter((x) => x !== k);
  el.setAttribute('aria-pressed', String(on)); el.classList.toggle('on', on);
}
async function _intSave() {
  const c = _hCust(), d = _intData(); if (!c || !d || S._intSending) return;
  const ed = _intDraft(d); if (!ed) return;
  const go = document.getElementById('int-save');
  S._intSending = true; if (go) go.disabled = true;
  let r; try { r = await sb.rpc('member_interests_set', { ..._hTok(c), p_keys: ed.keys.slice() }); } catch (e) { r = { error: e }; }
  S._intSending = false; if (go) go.disabled = false;
  const res = r && !r.error && r.data;
  if (!res || res.ok !== true) {
    if (typeof toast === 'function') toast(_hT(res && res.error === 'limit' ? 'intLimit' : 'err'), 'error');
    if (res && (res.error === 'member' || res.error === 'women')) { _intFetch(true); if (res.error === 'member') _hubFetch(true); }
    return;
  }
  const now = _hCust(); if (!now || now.id !== c.id) return;
  d.saved = true; d.keys = (Array.isArray(res.keys) ? res.keys : ed.keys).filter((k) => INT_KEYS.includes(k)); d.suggested = [];
  S._intEd = null; if (S._int) S._int.at = Date.now();
  _hubRender();
  const b = document.getElementById('int-change'); if (b) try { b.focus({ preventScroll: true }); } catch (_) {}
}

// ── Suggest a ride (the user's pick of 2026-11-18: "Suggest a ride: a member sends staff a route, a breakfast spot or an
// idea, and sees only their own suggestions, each marked Planned or Done. When one happens, an Updates entry tells them.")
// A card near the end of the feed opens a page of its own (S._hubView 'suggest'; an Updates row about a suggestion opens it
// too, /members?hv=suggest): what it is (four chips), the text, Send; under it the member's own suggestions, newest first,
// each with its kind, date, Sent / Planned / Done and the team's reply. One read when the page opens (ride_suggestions_mine,
// never kept on the phone), one write (ride_suggest); migration 20261118210500, which also writes the Updates rows. The page
// is written once and then only its list part, so a repaint of the tab never takes away what the member is typing. A
// database without it (PGRST202) closes the page and hides the card.
Object.assign(HUB_T, {
  rsgTitle: ['Suggest a ride', 'اقترح جولة', 'Suggérer une sortie', 'Sugiere una salida', 'Sugira um passeio', 'سواری کی تجویز دیں', 'राइड का सुझाव दें', 'Magmungkahi ng ride', 'राइडको सुझाव दिनुहोस्', 'একটি রাইডের পরামর্শ দিন', 'Cadangkan kayuhan'],
  rsgGo: ['Make a suggestion', 'قدّم اقتراحًا', 'Faire une suggestion', 'Hacer una sugerencia', 'Fazer uma sugestão', 'تجویز دیں', 'सुझाव दें', 'Magbigay ng mungkahi', 'सुझाव दिनुहोस्', 'পরামর্শ দিন', 'Buat cadangan'],
  rsgKindQ: ['What is it?', 'ما نوع اقتراحك؟', 'De quoi s’agit-il ?', '¿Qué es?', 'O que é?', 'یہ کیا ہے؟', 'यह क्या है?', 'Ano ito?', 'यो के हो?', 'এটি কী?', 'Apakah ia?'],
  rsgKRoute: ['Route', 'مسار', 'Itinéraire', 'Ruta', 'Percurso', 'راستہ', 'रास्ता', 'Ruta', 'बाटो', 'রুট', 'Laluan'],
  rsgKBreakfast: ['Breakfast spot', 'مكان للفطور', 'Lieu pour le petit-déjeuner', 'Sitio para desayunar', 'Lugar para o café da manhã', 'ناشتے کی جگہ', 'नाश्ते की जगह', 'Lugar para sa almusal', 'बिहानको खाजाको ठाउँ', 'নাস্তার জায়গা', 'Tempat sarapan'],
  rsgKIdea: ['Ride idea', 'فكرة جولة', 'Idée de sortie', 'Idea de salida', 'Ideia de passeio', 'سواری کا خیال', 'राइड का आइडिया', 'Ideya para sa ride', 'राइडको विचार', 'রাইডের আইডিয়া', 'Idea kayuhan'],
  rsgKOther: ['Something else', 'شيء آخر', 'Autre chose', 'Otra cosa', 'Outra coisa', 'کچھ اور', 'कुछ और', 'Iba pa', 'अरू केही', 'অন্য কিছু', 'Lain-lain'],
  rsgText: ['Your suggestion', 'اقتراحك', 'Votre suggestion', 'Tu sugerencia', 'A sua sugestão', 'آپ کی تجویز', 'आपका सुझाव', 'Ang mungkahi mo', 'तपाईंको सुझाव', 'আপনার পরামর্শ', 'Cadangan anda'],
  rsgSend: ['Send', 'إرسال', 'Envoyer', 'Enviar', 'Enviar', 'بھیجیں', 'भेजें', 'Ipadala', 'पठाउनुहोस्', 'পাঠান', 'Hantar'],
  rsgMine: ['Your suggestions', 'اقتراحاتك', 'Vos suggestions', 'Tus sugerencias', 'As suas sugestões', 'آپ کی تجاویز', 'आपके सुझाव', 'Mga mungkahi mo', 'तपाईंका सुझावहरू', 'আপনার পরামর্শগুলো', 'Cadangan anda'],
  rsgSent: ['Sent', 'أُرسل', 'Envoyée', 'Enviada', 'Enviada', 'بھیج دی گئی', 'भेजा गया', 'Naipadala', 'पठाइयो', 'পাঠানো হয়েছে', 'Dihantar'],
  rsgPlanned: ['Planned', 'ضمن الخطة', 'Prévue', 'Planificada', 'Planejada', 'منصوبے میں', 'योजना में', 'Nakaplano', 'योजनामा', 'পরিকল্পিত', 'Dirancang'],
  rsgDone: ['Done', 'نُفّذ', 'Réalisée', 'Hecha', 'Realizada', 'ہو گئی', 'पूरा हुआ', 'Natupad', 'पूरा भयो', 'সম্পন্ন', 'Selesai'],
  rsgReply: ['From the team', 'من الفريق', 'De l’équipe', 'Del equipo', 'Da equipe', 'ٹیم کی طرف سے', 'टीम की ओर से', 'Mula sa team', 'टिमबाट', 'টিমের পক্ষ থেকে', 'Daripada pasukan'],
  rsgPickKind: ['Please pick what it is.', 'يرجى اختيار نوع الاقتراح.', 'Choisissez de quoi il s’agit.', 'Elige qué es.', 'Escolha o que é.', 'براہ کرم چنیں کہ یہ کیا ہے۔', 'कृपया चुनें कि यह क्या है।', 'Pakipili kung ano ito.', 'कृपया यो के हो छान्नुहोस्।', 'অনুগ্রহ করে বেছে নিন এটি কী।', 'Sila pilih jenisnya.'],
  rsgShort: ['Please write at least 3 characters.', 'يرجى كتابة 3 أحرف على الأقل.', 'Écrivez au moins 3 caractères.', 'Escribe al menos 3 caracteres.', 'Escreva pelo menos 3 caracteres.', 'کم از کم 3 حروف لکھیں۔', 'कम से कम 3 अक्षर लिखें।', 'Sumulat ng hindi bababa sa 3 character.', 'कम्तीमा 3 अक्षर लेख्नुहोस्।', 'অন্তত 3টি অক্ষর লিখুন।', 'Sila tulis sekurang-kurangnya 3 aksara.'],
  rsgDay: ['You can send 3 suggestions a day. Please try again tomorrow.', 'يمكنك إرسال 3 اقتراحات في اليوم. يرجى المحاولة غدًا.', 'Vous pouvez envoyer 3 suggestions par jour. Réessayez demain.', 'Puedes enviar 3 sugerencias al día. Inténtalo mañana.', 'Pode enviar 3 sugestões por dia. Tente amanhã.', 'آپ دن میں 3 تجاویز بھیج سکتے ہیں۔ کل دوبارہ کوشش کریں۔', 'आप दिन में 3 सुझाव भेज सकते हैं। कल फिर कोशिश करें।', 'Puwede kang magpadala ng 3 mungkahi bawat araw. Subukang muli bukas.', 'तपाईं दिनमा 3 सुझाव पठाउन सक्नुहुन्छ। भोलि फेरि प्रयास गर्नुहोस्।', 'আপনি দিনে 3টি পরামর্শ পাঠাতে পারেন। আগামীকাল আবার চেষ্টা করুন।', 'Anda boleh menghantar 3 cadangan sehari. Sila cuba lagi esok.'],
  rsgOpenMax: ['You have 10 suggestions waiting for the team. You can send more once they have looked at them.', 'لديك 10 اقتراحات بانتظار الفريق. يمكنك إرسال المزيد بعد أن يطّلع عليها.', '10 de vos suggestions attendent l’équipe. Vous pourrez en envoyer d’autres quand elle les aura lues.', 'Tienes 10 sugerencias esperando al equipo. Podrás enviar más cuando las haya visto.', 'Você tem 10 sugestões aguardando a equipe. Poderá enviar mais quando ela as tiver visto.', 'آپ کی 10 تجاویز ٹیم کے جائزے کی منتظر ہیں۔ ٹیم کے دیکھ لینے کے بعد آپ مزید بھیج سکتے ہیں۔', 'आपके 10 सुझाव टीम के देखने का इंतज़ार कर रहे हैं। टीम के देख लेने के बाद आप और भेज सकते हैं।', 'May 10 mungkahi kang hinihintay pang tingnan ng team. Makakapagpadala ka ulit kapag natingnan na nila ang mga ito.', 'तपाईंका 10 सुझाव टिमले हेर्न बाँकी छन्। टिमले हेरेपछि तपाईं थप पठाउन सक्नुहुन्छ।', 'আপনার 10টি পরামর্শ টিমের দেখার অপেক্ষায় আছে। টিম দেখে নেওয়ার পর আপনি আরও পাঠাতে পারবেন।', 'Anda mempunyai 10 cadangan yang menunggu semakan pasukan. Anda boleh menghantar lagi selepas mereka menyemaknya.'],
  rsgMember: ['Suggestions are for Community members.', 'الاقتراحات متاحة لأعضاء المجتمع.', 'Les suggestions sont réservées aux membres de la communauté.', 'Las sugerencias son para los miembros de la comunidad.', 'As sugestões são para membros da comunidade.', 'تجاویز صرف کمیونٹی ممبران کے لیے ہیں۔', 'सुझाव केवल कम्युनिटी सदस्यों के लिए हैं।', 'Para sa mga miyembro ng Community ang mga mungkahi.', 'सुझाव कम्युनिटीका सदस्यहरूका लागि मात्र हुन्।', 'পরামর্শ শুধু কমিউনিটির সদস্যদের জন্য।', 'Cadangan khas untuk ahli Komuniti.'],
});
const RSG_KINDS = [['route', 'rsgKRoute', 'pin'], ['breakfast', 'rsgKBreakfast', 'cup'], ['idea', 'rsgKIdea', 'bike'], ['other', 'rsgKOther', 'chat']];
const RSG_ERR = { day: 'rsgDay', open: 'rsgOpenMax', invalid: 'rsgShort', member: 'rsgMember' };
// S._rsg: {forId, rows (null until read), kind, draft, err, busy, loading, fail, html}; per account, in memory only.
function _rsgState(c) {
  if (!c) return null;
  if (!S._rsg || S._rsg.forId !== c.id) S._rsg = { forId: c.id, rows: null, kind: '', draft: '', err: '', busy: false, loading: false, fail: false, html: null };
  return S._rsg;
}
function _rsgCardHtml() {
  if (S._rsgOff) return '';
  return `<div class="hub-card hub-flat rsg-card"><span class="hub-k">${_cuIc('chat', 16)} ${_hT('rsgTitle')}</span><button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_rsgOpen')}">${_hT('rsgGo')}</button></div>`;
}
function _rsgOpen() { S._hubView = 'suggest'; _hubRender(); _rsgFetch(); try { window.scrollTo(0, 0); } catch (_) {} }
function _rsgClose() { S._hubView = null; _hubRender(); try { window.scrollTo(0, 0); } catch (_) {} }
async function _rsgFetch() {
  const c = _hCust(), g = _rsgState(c); if (!g || !sb || g.loading) return;
  g.loading = true; g.fail = false;
  let r; try { r = await sb.rpc('ride_suggestions_mine', _hTok(c)); } catch (e) { r = { error: e }; }
  g.loading = false;
  const now = _hCust(); if (!now || now.id !== c.id) return;
  const e = r && r.error, d = r && !e && r.data;
  if (e && (e.code === 'PGRST202' || e.code === '42883')) S._rsgOff = true;
  else if (d && d.ok === true && Array.isArray(d.rows)) g.rows = d.rows;
  else g.fail = true; // the rows already shown stay
  if (S.custTab === 'members') _hubRender();
}
function _rsgPaint(body, c) {
  const g = _rsgState(c), key = c.id + '|' + (S.lang || 'en');
  if (g.rows === null && !g.loading && !g.fail) _rsgFetch();
  let pg = document.getElementById('rsg-page');
  if (!pg || !body.contains(pg) || pg.getAttribute('data-k') !== key) {
    body.innerHTML = _rsgPageHtml(key);
    pg = document.getElementById('rsg-page'); g.html = null;
    const ta = document.getElementById('rsg-text'); if (ta) ta.value = g.draft;
  }
  const L = document.getElementById('rsg-list'), h = _rsgListHtml(g);
  if (L && g.html !== h) { L.innerHTML = h; g.html = h; }
  _rsgSync(g);
}
function _rsgPageHtml(key) {
  return `<div id="rsg-page" data-k="${esc(key)}"><div class="hub-card hub-flat mt-head"><h2 class="mt-h1" id="rsg-h">${_hT('rsgTitle')}</h2><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_rsgClose')}">${_hT('close')}</button></div>
    <div class="hub-card rsg-form" role="group" aria-labelledby="rsg-h"><span class="mt-lbl" id="rsg-kind-l">${_hT('rsgKindQ')}</span>
      <div class="mt-picks rsg-picks" role="group" aria-labelledby="rsg-kind-l">${RSG_KINDS.map(([k, w, ic]) => `<button type="button" class="mt-chip rsg-kind" data-k="${k}" aria-pressed="false" data-on-click="${_on('_rsgKind', k)}">${_cuIc(ic, 16)} ${_hT(w)}</button>`).join('')}</div>
      <label class="mt-lbl rsg-lbl" for="rsg-text">${_hT('rsgText')}</label>
      <textarea id="rsg-text" class="rsg-text" maxlength="500" rows="4" data-on-input="${_on('_rsgInput', _EL)}"></textarea>
      <p id="rsg-msg" class="rsg-msg" role="alert"></p>
      <button type="button" id="rsg-go" class="btn-primary hub-wide" data-on-click="${_on('_rsgSend')}">${_hT('rsgSend')}</button></div>
    <div id="rsg-list"></div></div>`;
}
function _rsgListHtml(g) {
  if (g.rows === null) return g.fail ? `<div class="hub-card" role="status"><strong class="hub-name">${_hT('err')}</strong><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_rsgFetch')}">${_hT('retry')}</button></div>` : _skelHtml(1, 'hub-skel');
  if (!g.rows.length) return '';
  return `<h3 class="mt-h2">${_hT('rsgMine')}</h3><ul class="hub-card rsg-list">${g.rows.map(_rsgRowHtml).join('')}</ul>`;
}
function _rsgRowHtml(x) {
  const k = RSG_KINDS.find((y) => y[0] === x.kind) || RSG_KINDS[3], st = x.status === 'planned' || x.status === 'done' ? x.status : 'sent';
  return `<li class="rsg-row"><div class="rsg-row-h"><span class="hub-k">${_cuIc(k[2], 16)} ${_hT(k[1])}</span><span class="rsg-st rsg-st-${st}">${_hT(st === 'planned' ? 'rsgPlanned' : st === 'done' ? 'rsgDone' : 'rsgSent')}</span></div>
    <p class="rsg-body" dir="auto">${esc(x.body || '')}</p><span class="hub-meta">${esc(_hDate(x.day))}</span>
    ${x.reply ? `<div class="rsg-reply"><span class="rsg-reply-k">${_hT('rsgReply')}</span><p dir="auto">${esc(x.reply)}</p></div>` : ''}</li>`;
}
// The form's state onto the page as it stands: the chip picked, the message, Send while it is sending.
function _rsgSync(g) {
  document.querySelectorAll('#rsg-page .rsg-kind').forEach((b) => { const on = b.getAttribute('data-k') === g.kind; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); });
  const m = document.getElementById('rsg-msg'); if (m && m.textContent !== (g.err ? _hT(g.err) : '')) m.textContent = g.err ? _hT(g.err) : '';
  const ta = document.getElementById('rsg-text'); if (ta) { if (g.err === 'rsgShort') ta.setAttribute('aria-invalid', 'true'); else ta.removeAttribute('aria-invalid'); }
  const go = document.getElementById('rsg-go'); if (go) go.disabled = !!g.busy;
}
function _rsgKind(k) {
  const g = _rsgState(_hCust()); if (!g || !RSG_KINDS.some((y) => y[0] === k)) return;
  g.kind = g.kind === k ? '' : k;
  if (g.err === 'rsgPickKind') g.err = '';
  _rsgSync(g);
}
function _rsgInput(el) {
  const g = _rsgState(_hCust()); if (!g || !el) return;
  g.draft = String(el.value || '');
  if (g.err) { g.err = ''; _rsgSync(g); }
}
async function _rsgSend() {
  const c = _hCust(), g = _rsgState(c); if (!g || !sb || g.busy) return;
  const ta = document.getElementById('rsg-text'); if (ta) g.draft = String(ta.value || '');
  const text = g.draft.trim();
  g.err = !g.kind ? 'rsgPickKind' : text.length < 3 ? 'rsgShort' : '';
  if (g.err) { _rsgSync(g); const f = g.err === 'rsgPickKind' ? document.querySelector('#rsg-page .rsg-kind') : ta; if (f) try { f.focus(); } catch (_) {} return; }
  g.busy = true; _rsgSync(g);
  let r; try { r = await sb.rpc('ride_suggest', { ..._hTok(c), p_kind: g.kind, p_body: text }); } catch (e) { r = { error: e }; }
  g.busy = false;
  const now = _hCust(); if (!now || now.id !== c.id) return;
  const res = r && !r.error && r.data;
  if (!res || res.ok !== true || !res.row) { g.err = (res && RSG_ERR[res.error]) || 'err'; _rsgSync(g); return; }
  g.kind = ''; g.draft = ''; g.err = ''; if (ta) ta.value = '';
  g.rows = [res.row, ...(g.rows || []).filter((x) => x.id !== res.row.id)];
  _hubRender();
}

// ── The Community chat (the user, 2026-11-20: "can we create a live chat in the booking app but only for community
// members?"; asked how a member appears, where it lives and what may be sent: "Full name", "One club chat", "Text only")
// One room for every active member. The round button at the bottom corner of every page (app.src.html _chtFab*: how many
// new since this phone last read to the end, chat_peek) opens a page of its own (S._hubView 'chat'; /members?hv=chat),
// whose Close goes back to the page the button was on (S._chtFrom): the messages oldest to newest under their day, the
// author's FULL NAME over a run of theirs (the owner's pick, the one exception here to "members see nothing of each
// other"; nothing else about a member is ever sent), the team's under "MicroMobility team", the member's own on the other
// side; the box to write in stays at the foot of the screen. Migration 20261120203000.
// - Reads: chat_read gives the newest 50, then only what came after the last one held (p_after) or the 50 before the
//   first (Earlier messages). Never kept on the phone. Only the id read to is (cq_cht_seen_<account>), for the card.
// - Six hours (the user, 2026-11-20: "delete chats when it completes 6 hours but keep it shown for staff and never
//   delete them"; migration 20261120213000): the database sends members only the last six hours and says so with each
//   read (`keep` seconds, on its own clock `now`), and the open page drops a message the moment it turns that old
//   (_chtPrune). Staff keep every message; nothing here deletes one.
// - Live: the page joins the realtime topic 'hub-chat' while it is open; the database sends an EMPTY 'tick' there for
//   every change and the page then asks chat_read (the tick names nobody and carries no words). Ticks that bring nothing
//   are answered less and less often (a topic anyone can write to must not make every phone read). Without a tick the
//   page asks by itself: every 12 s while the topic is not joined, every 45 s while it is, never while hidden.
// - Writes: chat_send (the first one asks for the member's yes to their full name, kept by the database), chat_remove
//   (their own message) and chat_report (someone else's, to the team). A refusal is said over the box, no toast.
// - The page is written once and then only its messages, so nothing typed is lost; the scroll stays with the reader:
//   at the end it follows new messages, further up a "New messages" button appears instead.
// A database without the functions (PGRST202) closes the page and hides the card.
Object.assign(HUB_T, {
  chtTitle: ['Community chat', 'دردشة المجتمع', 'Discussion de la communauté', 'Chat de la comunidad', 'Chat da comunidade', 'کمیونٹی چیٹ', 'कम्युनिटी चैट', 'Chat ng Community', 'कम्युनिटी च्याट', 'কমিউনিটি চ্যাট', 'Sembang Komuniti'],
  chtLabel: ['Message', 'رسالة', 'Message', 'Mensaje', 'Mensagem', 'پیغام', 'संदेश', 'Mensahe', 'सन्देश', 'বার্তা', 'Mesej'],
  chtEmpty: ['No messages yet.', 'لا توجد رسائل بعد.', 'Aucun message pour le moment.', 'Aún no hay mensajes.', 'Ainda não há mensagens.', 'ابھی کوئی پیغام نہیں۔', 'अभी कोई संदेश नहीं।', 'Wala pang mensahe.', 'अहिलेसम्म कुनै सन्देश छैन।', 'এখনও কোনো বার্তা নেই।', 'Belum ada mesej.'],
  chtOlder: ['Earlier messages', 'الرسائل السابقة', 'Messages précédents', 'Mensajes anteriores', 'Mensagens anteriores', 'پچھلے پیغامات', 'पहले के संदेश', 'Mga naunang mensahe', 'अघिल्ला सन्देशहरू', 'আগের বার্তাগুলো', 'Mesej terdahulu'],
  chtNew: ['New messages', 'رسائل جديدة', 'Nouveaux messages', 'Mensajes nuevos', 'Novas mensagens', 'نئے پیغامات', 'नए संदेश', 'Mga bagong mensahe', 'नयाँ सन्देशहरू', 'নতুন বার্তা', 'Mesej baharu'],
  chtTeam: ['MicroMobility team', 'فريق MicroMobility', 'Équipe MicroMobility', 'Equipo MicroMobility', 'Equipe MicroMobility', 'MicroMobility ٹیم', 'MicroMobility टीम', 'MicroMobility team', 'MicroMobility टिम', 'MicroMobility টিম', 'Pasukan MicroMobility'],
  chtMember: ['Member', 'عضو', 'Membre', 'Miembro', 'Membro', 'ممبر', 'सदस्य', 'Miyembro', 'सदस्य', 'সদস্য', 'Ahli'],
  chtAgree: ['Other members will see your full name, {0}, with your messages.', 'سيرى الأعضاء الآخرون اسمك الكامل، {0}، مع رسائلك.', 'Les autres membres verront votre nom complet, {0}, avec vos messages.', 'Los demás miembros verán tu nombre completo, {0}, junto a tus mensajes.', 'Os outros membros verão o seu nome completo, {0}, com as suas mensagens.', 'دوسرے ممبران آپ کے پیغامات کے ساتھ آپ کا پورا نام، {0}، دیکھیں گے۔', 'दूसरे सदस्य आपके संदेशों के साथ आपका पूरा नाम, {0}, देखेंगे।', 'Makikita ng ibang miyembro ang buo mong pangalan, {0}, kasama ng mga mensahe mo.', 'अरू सदस्यहरूले तपाईंका सन्देशसँगै तपाईंको पूरा नाम, {0}, देख्नेछन्।', 'অন্য সদস্যরা আপনার বার্তার সাথে আপনার পুরো নাম, {0}, দেখতে পাবেন।', 'Ahli lain akan melihat nama penuh anda, {0}, bersama mesej anda.'],
  chtRemoveQ: ['Remove your message?', 'هل تريد حذف رسالتك؟', 'Supprimer votre message ?', '¿Eliminar tu mensaje?', 'Remover a sua mensagem?', 'اپنا پیغام ہٹائیں؟', 'अपना संदेश हटाएँ?', 'Alisin ang mensahe mo?', 'तपाईंको सन्देश हटाउने?', 'আপনার বার্তাটি সরাবেন?', 'Buang mesej anda?'],
  chtRemove: ['Remove', 'حذف', 'Supprimer', 'Eliminar', 'Remover', 'ہٹائیں', 'हटाएँ', 'Alisin', 'हटाउनुहोस्', 'সরান', 'Buang'],
  chtReportQ: ['Report this message to the team?', 'هل تريد إبلاغ الفريق عن هذه الرسالة؟', 'Signaler ce message à l’équipe ?', '¿Denunciar este mensaje al equipo?', 'Denunciar esta mensagem à equipe?', 'اس پیغام کی ٹیم کو اطلاع دیں؟', 'इस संदेश की टीम को रिपोर्ट करें?', 'I-report ang mensaheng ito sa team?', 'यो सन्देश टिमलाई रिपोर्ट गर्ने?', 'এই বার্তাটি টিমকে রিপোর্ট করবেন?', 'Laporkan mesej ini kepada pasukan?'],
  chtReport: ['Report', 'إبلاغ', 'Signaler', 'Denunciar', 'Denunciar', 'رپورٹ کریں', 'रिपोर्ट करें', 'I-report', 'रिपोर्ट गर्नुहोस्', 'রিপোর্ট করুন', 'Laporkan'],
  chtEdited: ['Edited by the team', 'عدّلها الفريق', 'Modifié par l’équipe', 'Editado por el equipo', 'Editada pela equipe', 'ٹیم نے ترمیم کی', 'टीम ने संपादित किया', 'In-edit ng team', 'टिमले सम्पादन गर्‍यो', 'টিম সম্পাদনা করেছে', 'Diubah oleh pasukan'],
  chtReported: ['Reported', 'تم الإبلاغ', 'Signalé', 'Denunciado', 'Denunciada', 'رپورٹ ہو گیا', 'रिपोर्ट किया गया', 'Nai-report', 'रिपोर्ट गरियो', 'রিপোর্ট করা হয়েছে', 'Dilaporkan'],
  chtFast: ['You are sending too fast. Please try again in a moment.', 'أنت ترسل بسرعة كبيرة. يرجى المحاولة بعد لحظة.', 'Vous envoyez trop vite. Réessayez dans un instant.', 'Estás enviando demasiado rápido. Inténtalo en un momento.', 'Você está enviando rápido demais. Tente novamente em instantes.', 'آپ بہت تیزی سے بھیج رہے ہیں۔ ذرا دیر بعد دوبارہ کوشش کریں۔', 'आप बहुत तेज़ी से भेज रहे हैं। थोड़ी देर बाद फिर कोशिश करें।', 'Masyadong mabilis ang pagpapadala mo. Subukang muli maya-maya.', 'तपाईं धेरै छिटो पठाउँदै हुनुहुन्छ। केही बेरपछि फेरि प्रयास गर्नुहोस्।', 'আপনি খুব দ্রুত পাঠাচ্ছেন। একটু পরে আবার চেষ্টা করুন।', 'Anda menghantar terlalu cepat. Sila cuba lagi sebentar lagi.'],
  chtLimit: ['You have sent many messages. Please try again in a few minutes.', 'أرسلت رسائل كثيرة. يرجى المحاولة بعد بضع دقائق.', 'Vous avez envoyé beaucoup de messages. Réessayez dans quelques minutes.', 'Has enviado muchos mensajes. Inténtalo en unos minutos.', 'Você enviou muitas mensagens. Tente novamente em alguns minutos.', 'آپ نے بہت سے پیغامات بھیجے ہیں۔ چند منٹ بعد دوبارہ کوشش کریں۔', 'आपने बहुत संदेश भेजे हैं। कुछ मिनट बाद फिर कोशिश करें।', 'Marami ka nang naipadalang mensahe. Subukang muli pagkalipas ng ilang minuto.', 'तपाईंले धेरै सन्देश पठाउनुभयो। केही मिनेटपछि फेरि प्रयास गर्नुहोस्।', 'আপনি অনেক বার্তা পাঠিয়েছেন। কয়েক মিনিট পরে আবার চেষ্টা করুন।', 'Anda telah menghantar banyak mesej. Sila cuba lagi dalam beberapa minit.'],
  chtMuted: ['You cannot write in the chat for now.', 'لا يمكنك الكتابة في الدردشة حاليًا.', 'Vous ne pouvez pas écrire dans la discussion pour le moment.', 'Por ahora no puedes escribir en el chat.', 'Por enquanto você não pode escrever no chat.', 'آپ فی الحال چیٹ میں نہیں لکھ سکتے۔', 'आप अभी चैट में नहीं लिख सकते।', 'Hindi ka muna makakasulat sa chat.', 'तपाईं अहिले च्याटमा लेख्न सक्नुहुन्न।', 'আপনি আপাতত চ্যাটে লিখতে পারবেন না।', 'Anda tidak boleh menulis dalam sembang buat masa ini.'],
  chtMutedTill: ['You cannot write in the chat until {0}.', 'لا يمكنك الكتابة في الدردشة حتى {0}.', 'Vous ne pouvez pas écrire dans la discussion avant le {0}.', 'No puedes escribir en el chat hasta el {0}.', 'Você não pode escrever no chat até {0}.', 'آپ {0} تک چیٹ میں نہیں لکھ سکتے۔', 'आप {0} तक चैट में नहीं लिख सकते।', 'Hindi ka makakasulat sa chat hanggang {0}.', 'तपाईं {0} सम्म च्याटमा लेख्न सक्नुहुन्न।', 'আপনি {0} পর্যন্ত চ্যাটে লিখতে পারবেন না।', 'Anda tidak boleh menulis dalam sembang hingga {0}.'],
});
const CHT_ERR = { fast: 'chtFast', limit: 'chtLimit' };
const _CHT_SEEN = 'cq_cht_seen_'; // the id read to; the corner button's count (app.src.html _chtFabPeek) asks from it
// S._cht: {forId, rows (null until read), more, me {agreed, muted, until}, draft, err, busy, loading, again, fail, html, jump,
// keep, fresh (others' messages that came while the reader was further up), rep {id: 1}, readAt, selfAt, tickT, tickGap,
// tickNext, ttl (how long a message is shown, ms; 0 = the database did not say) and skew (its clock less this phone's)};
// per account, in memory only. S._chtN: {id, at, n} = the corner button's count. S._chtCh: the joined topic.
function _chtState(c) {
  if (!c) return null;
  if (!S._cht || S._cht.forId !== c.id) S._cht = { forId: c.id, rows: null, more: false, me: null, draft: '', err: '', busy: false, loading: false, again: false, fail: false, html: null, jump: true, keep: false, fresh: 0, rep: {}, readAt: 0, selfAt: 0, tickT: null, tickGap: 0, tickNext: 0, ttl: 0, skew: 0 };
  return S._cht;
}
function _chtOn() { return S.custTab === 'members' && S._hubView === 'chat' && !!document.getElementById('cht-page'); }
function _chtCool() { try { return typeof _sbCooling === 'function' && !!_sbCooling(); } catch (_) { return false; } }

// Close: back to the page the corner button was on (a tab, or the event picker), else the Community tab.
function _chtClose() {
  const from = S._chtFrom; S._chtFrom = null;
  S._hubView = null; _chtLeave();
  if (from) { const b = document.getElementById('hub-body'); if (b) b.innerHTML = ''; } // the chat leaves the tab it hid in; the tab draws itself again when opened
  if (from === 'landing') { goLanding(); return; }
  if (from && from !== 'members') { setCustTab(from); return; }
  _hubRender(); try { window.scrollTo(0, 0); } catch (_) {}
}

// The topic and the page's own clock: both live only while the chat is on screen.
function _chtJoin() {
  if (S._chtCh || !sb || !sb.channel) return;
  try {
    const ch = S._chtCh = sb.channel('hub-chat');
    ch.on('broadcast', { event: 'tick' }, _chtTick).subscribe((st) => {
      if (S._chtCh !== ch) return;
      const live = st === 'SUBSCRIBED';
      if (live && !S._chtLive && S._cht && S._cht.rows !== null) _chtFetch('new'); // joined, or joined again: what came meanwhile
      S._chtLive = live;
    });
  } catch (_) { S._chtCh = null; S._chtLive = false; }
}
function _chtLeave() {
  const ch = S._chtCh; S._chtCh = null; S._chtLive = false;
  if (ch) try { sb.removeChannel(ch); } catch (_) {}
  if (S._chtT) { clearInterval(S._chtT); S._chtT = null; }
  const g = S._cht; if (g && g.tickT) { clearTimeout(g.tickT); g.tickT = null; }
}
function _chtWatch() {
  if (!S._chtBound) {
    S._chtBound = true;
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && _chtOn() && S._cht && S._cht.rows !== null) _chtFetch('new'); });
    window.addEventListener('scroll', () => {
      if (S._chtRaf || !S._cht || !S._cht.fresh || !_chtOn()) return;
      S._chtRaf = requestAnimationFrame(() => { S._chtRaf = 0; const g = S._cht; if (g && g.fresh && _chtOn() && _chtNear()) { _chtMark(g); _chtSync(g); } });
    }, { passive: true });
  }
  if (S._chtT) return;
  S._chtT = setInterval(() => {
    const g = S._cht;
    if (!_chtOn() || !_hCust()) { _chtLeave(); return; }
    if (g && g.rows && g.rows.some((x) => _chtOld(g, x))) _hubRender(); // one has turned six hours old: it leaves the page
    if (document.visibilityState !== 'visible' || !g || g.rows === null || g.loading || _chtCool()) return;
    if (Date.now() - g.readAt >= (S._chtLive ? 45e3 : 12e3)) _chtFetch('new');
  }, 4e3);
}
// A tick: read soon, one read for a burst. A tick whose read brought nothing doubles the wait before the next tick is
// answered (1.5 s up to 30 s); one that brought something sets it back.
function _chtTick() {
  const g = S._cht; if (!g || g.tickT || !_chtOn()) return;
  g.tickT = setTimeout(() => { g.tickT = null; if (_chtOn() && !_chtCool()) _chtFetch('new', true); }, Math.max(350, g.tickNext - Date.now()));
}

async function _chtFetch(mode, viaTick) {
  const c = _hCust(), g = _chtState(c); if (!g || !sb) return;
  if (g.loading) { if (mode === 'new') g.again = true; return; }
  const first = g.rows === null, args = _hTok(c);
  if (!first && mode === 'older') { if (!g.more || !g.rows.length) return; args.p_before = g.rows[0].id; }
  else if (!first) args.p_after = g.rows.length ? g.rows[g.rows.length - 1].id : 0;
  g.loading = true; g.fail = false;
  let r; try { r = await sb.rpc('chat_read', args); } catch (e) { r = { error: e }; }
  g.loading = false; g.readAt = Date.now();
  const now = _hCust(); if (!now || now.id !== c.id || S._cht !== g) return;
  const e = r && r.error, d = r && !e && r.data;
  let got = false;
  if (e && (e.code === 'PGRST202' || e.code === '42883')) { S._chtOff = true; _chtLeave(); }
  else if (d && d.ok === false && d.error === 'member') { S._hubView = null; _chtLeave(); _hubFetch(true); return; } // no longer a member: the feed's read sends them on
  else if (d && d.ok === true && Array.isArray(d.rows)) {
    if (d.me) g.me = d.me;
    const sn = Date.parse(d.now);
    if (Number(d.keep) > 0 && sn) { g.ttl = Number(d.keep) * 1000; g.skew = sn - Date.now(); }
    if (first || d.reset) { g.rows = d.rows; g.more = !!d.more; g.jump = true; g.fresh = 0; got = true; }
    else if (args.p_before != null) {
      const have = new Set(g.rows.map((x) => x.id)), add = d.rows.filter((x) => !have.has(x.id));
      g.rows = [...add, ...g.rows]; g.more = !!d.more; g.keep = add.length > 0;
    } else {
      const gone = new Set(Array.isArray(d.gone) ? d.gone : []), have = new Set(g.rows.map((x) => x.id));
      const add = d.rows.filter((x) => !have.has(x.id) && !gone.has(x.id)), n0 = g.rows.length;
      g.rows = g.rows.filter((x) => !gone.has(x.id));
      got = add.length > 0 || g.rows.length !== n0;
      // the team edited a message on the page (20261120233000): its words are swapped in place, marked edited
      const ed = new Map((Array.isArray(d.edits) ? d.edits : []).map((x) => [x.id, x]));
      if (ed.size) g.rows = g.rows.map((x) => { const y = ed.get(x.id); if (!y || (y.body === x.body && !!y.ed === !!x.ed)) return x; got = true; return { ...x, body: y.body, ed: !!y.ed }; });
      if (add.length) { g.rows = [...g.rows, ...add].sort((a, b) => a.id - b.id); g.fresh += add.filter((x) => !x.mine).length; }
    }
  } else if (first) g.fail = true; // a later read that failed: what is shown stays, the page asks again by itself
  if (viaTick) { g.tickGap = got || Date.now() - g.selfAt < 4e3 ? 0 : Math.min(3e4, Math.max(1500, g.tickGap * 2)); g.tickNext = Date.now() + g.tickGap; }
  if (S.custTab === 'members') _hubRender();
  if (g.again) { g.again = false; _chtFetch('new'); }
}
function _chtRetry() { const g = S._cht; if (g) { g.fail = false; g.html = null; } _hubRender(); }
function _chtOlder() { _chtFetch('older'); }

// Where the reader is: the end of the page is where the box sits just as it stops floating.
function _chtEnd() {
  const pg = document.getElementById('cht-page'), ft = document.getElementById('cht-foot'); if (!pg || !ft) return null;
  let b = 0; try { b = parseFloat(getComputedStyle(ft).bottom) || 0; } catch (_) {}
  return Math.max(0, window.scrollY + pg.getBoundingClientRect().bottom - (window.innerHeight - b));
}
function _chtNear() { const end = _chtEnd(); return end === null || window.scrollY >= end - 160; }
function _chtMark(g) {
  g.fresh = 0;
  const last = g.rows && g.rows.length ? g.rows[g.rows.length - 1].id : 0;
  if (last) { try { localStorage.setItem(_CHT_SEEN + g.forId, String(last)); } catch (_) {} }
  S._chtN = { id: g.forId, at: Date.now(), n: 0 };
}
function _chtDown() {
  const g = S._cht, end = _chtEnd(); if (!g || end === null) return;
  try { window.scrollTo(0, end); } catch (_) {}
  _chtMark(g); _chtSync(g);
}

// Shown for six hours: older than the database's `keep`, on the database's clock.
function _chtOld(g, x) { return g.ttl > 0 && Date.parse(x.at) < Date.now() + g.skew - g.ttl; }
function _chtPrune(g) {
  if (!g.ttl || !g.rows || !g.rows.length) return false;
  const n = g.rows.length;
  g.rows = g.rows.filter((x) => !_chtOld(g, x));
  return g.rows.length !== n;
}
function _chtPaint(body, c) {
  const g = _chtState(c), key = c.id + '|' + (S.lang || 'en');
  if (g.rows === null) { if (!g.loading && !g.fail) _chtFetch('new'); }
  else if (!g.loading && Date.now() - g.readAt > 15e3 && !_chtCool()) _chtFetch('new'); // back on the tab after a while
  _chtJoin(); _chtWatch();
  let pg = document.getElementById('cht-page');
  if (!pg || !body.contains(pg) || pg.getAttribute('data-k') !== key) {
    body.innerHTML = _chtPageHtml(key); g.html = null; g.jump = true;
    const ta = document.getElementById('cht-text'); if (ta) ta.value = g.draft;
  }
  const aged = _chtPrune(g), L = document.getElementById('cht-log'), h = _chtLogHtml(g);
  if (L && g.html !== h) {
    const near = _chtNear(), sc = document.scrollingElement || document.documentElement, was = sc.scrollHeight;
    L.innerHTML = h; g.html = h;
    // earlier messages went in above, or old ones left the top: the reader stays where they were
    if (g.keep || (aged && !near && !g.jump)) { try { window.scrollTo(0, window.scrollY + (sc.scrollHeight - was)); } catch (_) {} }
    else if (g.rows && (g.jump || near)) _chtDown();
    if (g.rows) g.jump = false;
    g.keep = false;
  }
  _chtSync(g);
}
function _chtPageHtml(key) {
  return `<div id="cht-page" data-k="${esc(key)}"><div class="hub-card hub-flat mt-head"><h2 class="mt-h1" id="cht-h">${_hT('chtTitle')}</h2><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_chtClose')}">${_hT('close')}</button></div>
    <div id="cht-log" class="cht-log" role="log" aria-labelledby="cht-h"></div>
    <div id="cht-foot" class="cht-foot"><button type="button" id="cht-new" class="cht-new" hidden data-on-click="${_on('_chtDown')}">${_hT('chtNew')}</button>
      <p id="cht-msg" class="cht-msg" role="alert"></p>
      <div class="cht-bar"><label class="sr-only" for="cht-text">${_hT('chtLabel')}</label>
        <textarea id="cht-text" class="cht-text" rows="1" maxlength="500" dir="auto" placeholder="${esc(_hT('chtLabel'))}" data-on-input="${_on('_chtInput', _EL)}" data-on-keydown="${_on('_chtKey', _EV)}"></textarea>
        <button type="button" id="cht-go" class="btn-primary cht-go" aria-label="${esc(_hT('rsgSend'))}" data-on-click="${_on('_chtSend')}">${_cuIc('go', 20, true)}</button></div></div></div>`;
}
function _chtTime(at) {
  try {
    const l = _locale();
    if (!S._chtFmt || S._chtFmt.l !== l) S._chtFmt = { l, f: new Intl.DateTimeFormat(l, { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Riyadh' }) };
    return S._chtFmt.f.format(new Date(at));
  } catch (_) { return ''; }
}
function _chtLogHtml(g) {
  if (g.rows === null) return g.fail ? `<div class="hub-card" role="status"><strong class="hub-name">${_hT('err')}</strong><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_chtRetry')}">${_hT('retry')}</button></div>` : _skelHtml(2, 'hub-skel');
  if (!g.rows.length) return `<p class="cht-empty">${_hT('chtEmpty')}</p>`;
  let h = g.more ? `<button type="button" class="btn-secondary btn-sm cht-older" data-on-click="${_on('_chtOlder')}">${_hT('chtOlder')}</button>` : '', prev = null;
  for (const x of g.rows) {
    if (!prev || prev.day !== x.day) { h += `<div class="cht-day">${esc(_dayWord(x.day) || _hDate(x.day))}</div>`; prev = null; }
    h += _chtRowHtml(x, prev, g); prev = x;
  }
  return h;
}
// One message. A run (the same author within five minutes) is drawn under one name. The member's own has Remove, another
// member's has Report (until this phone reported it), the team's has neither.
function _chtRowHtml(x, prev, g) {
  const run = !!prev && prev.k === x.k && Date.parse(x.at) - Date.parse(prev.at) < 3e5, rep = !!g.rep[x.id];
  const who = x.mine || run ? '' : `<span class="cht-who${x.team ? ' cht-who-team' : ''}"><bdi>${esc(x.team ? _hT('chtTeam') : x.name || _hT('chtMember'))}</bdi></span>`;
  const act = x.mine ? `<button type="button" class="cht-more" aria-label="${esc(_hT('chtRemove'))}" data-on-click="${_on('_chtMore', x.id)}">${_cuIc('trash', 18)}</button>`
    : x.team || rep ? '' : `<button type="button" class="cht-more" aria-label="${esc(_hT('chtReport'))}" data-on-click="${_on('_chtMore', x.id)}">${_cuIc('flag', 18)}</button>`;
  return `<div class="cht-row${x.mine ? ' cht-mine' : ''}${x.team ? ' cht-team' : ''}${run ? ' cht-run' : ''}" data-id="${esc(String(x.id))}">${who}<div class="cht-line"><div class="cht-bub"><p class="cht-body" dir="auto">${esc(x.body || '')}</p><span class="cht-at">${x.ed ? `<span class="cht-ed">${_hT('chtEdited')}</span> · ` : ''}${esc(_chtTime(x.at))}</span></div>${act}</div>${rep ? `<span class="cht-rep">${_hT('chtReported')}</span>` : ''}</div>`;
}
// The foot as it stands: what was refused (or that the member is muted), the box and Send, the New messages button.
function _chtSync(g) {
  const muted = !!(g.me && g.me.muted);
  const say = muted ? (g.me.until ? _hF('chtMutedTill', shortDate(String(g.me.until))) : _hT('chtMuted')) : g.err ? _hT(g.err) : '';
  const m = document.getElementById('cht-msg'); if (m && m.textContent !== say) m.textContent = say;
  const ta = document.getElementById('cht-text'); if (ta) ta.disabled = muted;
  const go = document.getElementById('cht-go'); if (go) go.disabled = muted || !!g.busy;
  const nb = document.getElementById('cht-new'); if (nb) nb.hidden = !(g.fresh > 0) || _chtNear();
}
function _chtInput(el) {
  const g = _chtState(_hCust()); if (!g || !el) return;
  g.draft = String(el.value || '');
  if (g.err) { g.err = ''; _chtSync(g); }
}
// Enter sends where there is a keyboard and a mouse; on a phone it is a new line and Send is the button.
function _chtKey(ev) {
  if (!ev || ev.key !== 'Enter' || ev.shiftKey || ev.isComposing) return;
  let fine = false; try { fine = window.matchMedia('(hover:hover) and (pointer:fine)').matches; } catch (_) {}
  if (!fine) return;
  ev.preventDefault(); _chtSend();
}
async function _chtSend() {
  const c = _hCust(), g = _chtState(c); if (!g || !sb || g.busy || g.asking || (g.me && g.me.muted)) return;
  const ta = document.getElementById('cht-text'); if (ta) g.draft = String(ta.value || '');
  const text = g.draft.trim();
  if (!text) { if (ta) try { ta.focus(); } catch (_) {} return; }
  if (!g.yes && g.me && g.me.agreed === false) {
    // the first message: the member's yes to their full name being shown, asked once (g.yes) and kept by the database
    g.asking = true;
    const ok = await askConfirm({ title: _hT('chtTitle'), body: esc(_hF('chtAgree', String(c.name || '').trim())), confirmLabel: esc(_hT('rsgSend')), confirmClass: 'btn-primary' });
    g.asking = false;
    if (!ok) return;
    g.yes = true;
  }
  g.busy = true; g.err = ''; _chtSync(g);
  let r; try { r = await sb.rpc('chat_send', { ..._hTok(c), p_body: text, p_agree: !!g.yes }); } catch (e) { r = { error: e }; }
  g.busy = false;
  const now = _hCust(); if (!now || now.id !== c.id || S._cht !== g) return;
  const res = r && !r.error && r.data;
  if (res && res.ok === false && res.error === 'agree' && !g.yes) { g.me = { ...(g.me || {}), agreed: false }; _chtSync(g); return _chtSend(); } // the page thought the yes was given: ask now
  if (res && res.ok === false && res.error === 'member') { S._hubView = null; _chtLeave(); _hubFetch(true); return; }
  if (!res || res.ok !== true || !res.row) {
    if (res && res.error === 'muted') g.me = { ...(g.me || {}), muted: true, until: res.until || null };
    else g.err = (res && CHT_ERR[res.error]) || 'err';
    _chtSync(g); return;
  }
  g.me = { ...(g.me || {}), agreed: true }; g.yes = false; g.selfAt = Date.now();
  // what was typed while it was being sent stays in the box
  if (ta && String(ta.value || '').trim() === text) { ta.value = ''; g.draft = ''; } else if (ta) g.draft = String(ta.value || '');
  if (g.rows && !g.rows.some((x) => x.id === res.row.id)) g.rows = [...g.rows, res.row].sort((a, b) => a.id - b.id);
  g.jump = true;
  _hubRender();
  if (ta && _chtOn()) try { ta.focus({ preventScroll: true }); } catch (_) {}
}
// A message's one button: the member's own is removed for everyone, another member's is reported to the team.
async function _chtMore(id) {
  const c = _hCust(), g = _chtState(c), x = g && g.rows && g.rows.find((y) => y.id === id); if (!x || !sb || g.acting) return;
  const cut = String(x.body || '').replace(/\s+/g, ' ').trim(), quote = esc((x.mine ? '' : (x.name || _hT('chtMember')) + ': ') + (cut.length > 140 ? cut.slice(0, 139) + '…' : cut));
  if (x.team && !x.mine) return;
  if (!await askConfirm(x.mine ? { title: _hT('chtRemoveQ'), body: quote, confirmLabel: esc(_hT('chtRemove')), confirmClass: 'btn-red' }
    : { title: _hT('chtReportQ'), body: quote, confirmLabel: esc(_hT('chtReport')), confirmClass: 'btn-red' })) return;
  g.acting = true;
  let r; try { r = await sb.rpc(x.mine ? 'chat_remove' : 'chat_report', { ..._hTok(c), p_msg: id }); } catch (e) { r = { error: e }; }
  g.acting = false;
  const now = _hCust(); if (!now || now.id !== c.id || S._cht !== g) return;
  const res = r && !r.error && r.data;
  if (!res || res.ok !== true) { g.err = 'err'; _chtSync(g); return; }
  g.selfAt = Date.now(); g.err = '';
  if (x.mine) g.rows = (g.rows || []).filter((y) => y.id !== id); else g.rep[id] = 1;
  _hubRender();
}

window._hubRender = _hubRender;
