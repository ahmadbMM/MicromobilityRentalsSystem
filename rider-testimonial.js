// Testimonials, the rider's side (the user, 2026-11-18: "Create a testimonials page but don't make it visible, People write
// their testimonials on our services & community rides. Then we publish them in a testimonials page"; migration
// 20261119120000). Three places, one form:
//   - Account > Write a testimonial (/account/testimonial): what it is about, stars 1 to 5, the words (20 to 800), an
//     optional photo (made small on the phone), how the name shows (exactly as testimonial_mine words it, or anonymous),
//     the "Rider since" line beside a name, and the tick that MicroMobility may publish it; under it the rider's own, each
//     with its state, and Delete (a second tap).
//   - After a rating of 9 or 10 (the forced rating's pop-up, its next step; app.src.html _tstRateFor, this file's _tstRateNew): the words from the
//     rating's comment, the stars from the score, what it is about from the booking; Send or Not now.
//   - Once, about an old comment (a done ride rated 9 or 10 before this, 40+ characters; app.src.html _tstAskCheck): the
//     words as written, the ride, a name, the tick; Publish it or No thanks (testimonial_old_answer). Never again after.
// The database answers every refusal as {ok:false, error}; each one is said in the rider's words (_tstErr).
// A file of its own, fetched when first needed, with its words in ten languages; the build stamps its address (TST_V).
// What it takes from the page comes in window._tstDeps (app.src.html _tstLoad). Hand-written, not generated.
/* global S, sb, esc, _on, _EL, getSession */
const TST_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms'];
const TST_T = {
  ab_saturday: ['Saturday community ride', 'جولة السبت المجتمعية', 'Sortie communautaire du samedi', 'Salida comunitaria del sábado', 'Passeio comunitário de sábado', 'ہفتے کی کمیونٹی رائیڈ', 'शनिवार की कम्युनिटी राइड', 'Community ride tuwing Sabado', 'शनिबारको सामुदायिक सवारी', 'শনিবারের কমিউনিটি রাইড', 'Kayuhan komuniti Sabtu'],
  ab_session: ['Session or rental', 'جلسة أو استئجار', 'Séance ou location', 'Sesión o alquiler', 'Sessão ou aluguer', 'سیشن یا کرایہ', 'सेशन या किराया', 'Session o renta', 'सत्र वा भाडा', 'সেশন বা ভাড়া', 'Sesi atau sewa basikal'],
  ab_learn: ['Learn to ride', 'تعلّم ركوب الدراجة', 'Apprendre à rouler', 'Aprender a montar', 'Aprender a andar', 'سائیکل چلانا سیکھنا', 'साइकिल चलाना सीखना', 'Pag-aaral magbisikleta', 'साइकल चलाउन सिक्ने', 'সাইকেল চালানো শেখা', 'Belajar berbasikal'],
  ab_event: ['Event', 'فعالية', 'Événement', 'Evento', 'Evento', 'ایونٹ', 'इवेंट', 'Event', 'कार्यक्रम', 'ইভেন্ট', 'Acara'],
  ab_workshop: ['Workshop or store', 'الورشة أو المتجر', 'Atelier ou boutique', 'Taller o tienda', 'Oficina ou loja', 'ورکشاپ یا اسٹور', 'वर्कशॉप या स्टोर', 'Workshop o tindahan', 'वर्कशप वा पसल', 'ওয়ার্কশপ বা স্টোর', 'Bengkel atau kedai'],
  ab_other: ['Something else', 'شيء آخر', 'Autre chose', 'Otra cosa', 'Outra coisa', 'کچھ اور', 'कुछ और', 'Iba pa', 'अरू केही', 'অন্য কিছু', 'Lain-lain'],
  aboutL: ['What is it about?', 'عمّ تكتب؟', 'De quoi parlez-vous ?', '¿Sobre qué es?', 'Sobre o que é?', 'یہ کس بارے میں ہے؟', 'यह किस बारे में है?', 'Tungkol saan ito?', 'यो केको बारेमा हो?', 'এটি কী নিয়ে?', 'Tentang apa?'],
  starsL: ['Your rating', 'تقييمك', 'Votre note', 'Tu valoración', 'A sua avaliação', 'آپ کی ریٹنگ', 'आपकी रेटिंग', 'Ang rating mo', 'तपाईंको मूल्याङ्कन', 'আপনার রেটিং', 'Penilaian anda'],
  starsOf: ['{0} out of 5 stars', '{0} من 5 نجوم', '{0} étoiles sur 5', '{0} de 5 estrellas', '{0} de 5 estrelas', '5 میں سے {0} ستارے', '5 में से {0} स्टार', '{0} sa 5 bituin', '5 मध्ये {0} तारा', '5-এর মধ্যে {0} তারা', '{0} daripada 5 bintang'],
  wordsL: ['Your words', 'كلماتك', 'Votre témoignage', 'Tu testimonio', 'O seu testemunho', 'آپ کے الفاظ', 'आपके शब्द', 'Ang mga salita mo', 'तपाईंका शब्दहरू', 'আপনার কথা', 'Kata-kata anda'],
  photoL: ['Photo', 'صورة', 'Photo', 'Foto', 'Fotografia', 'تصویر', 'फ़ोटो', 'Larawan', 'फोटो', 'ছবি', 'Foto'],
  optional: ['optional', 'اختياري', 'facultatif', 'opcional', 'opcional', 'اختیاری', 'वैकल्पिक', 'opsyonal', 'ऐच्छिक', 'ঐচ্ছিক', 'pilihan'],
  photoAdd: ['Add a photo', 'أضف صورة', 'Ajouter une photo', 'Añadir una foto', 'Adicionar uma fotografia', 'تصویر شامل کریں', 'फ़ोटो जोड़ें', 'Magdagdag ng larawan', 'फोटो थप्नुहोस्', 'ছবি যোগ করুন', 'Tambah foto'],
  photoChange: ['Change photo', 'غيّر الصورة', 'Changer la photo', 'Cambiar la foto', 'Mudar a fotografia', 'تصویر بدلیں', 'फ़ोटो बदलें', 'Palitan ang larawan', 'फोटो बदल्नुहोस्', 'ছবি বদলান', 'Tukar foto'],
  photoDrop: ['Remove photo', 'احذف الصورة', 'Retirer la photo', 'Quitar la foto', 'Remover a fotografia', 'تصویر ہٹائیں', 'फ़ोटो हटाएँ', 'Alisin ang larawan', 'फोटो हटाउनुहोस्', 'ছবি সরান', 'Buang foto'],
  nameL: ['How your name shows', 'كيف يظهر اسمك', 'Comment votre nom apparaît', 'Cómo aparece tu nombre', 'Como aparece o seu nome', 'آپ کا نام کیسے دکھے گا', 'आपका नाम कैसे दिखेगा', 'Paano lalabas ang pangalan mo', 'तपाईंको नाम कसरी देखिन्छ', 'আপনার নাম কীভাবে দেখাবে', 'Cara nama anda dipaparkan'],
  anon: ['Anonymous', 'دون اسم', 'Anonyme', 'Anónimo', 'Anónimo', 'گمنام', 'गुमनाम', 'Hindi nagpakilala', 'गुमनाम', 'নামহীন', 'Tanpa nama'],
  anonShows: ['A MicroMobility rider', 'أحد راكبي MicroMobility', 'Un cycliste MicroMobility', 'Un ciclista de MicroMobility', 'Um ciclista MicroMobility', 'MicroMobility کا ایک رائیڈر', 'MicroMobility का एक राइडर', 'Isang rider ng MicroMobility', 'MicroMobility का एक राइडर', 'MicroMobility-র একজন রাইডার', 'Penunggang MicroMobility'],
  since0: ['Rider since {0}', 'راكب منذ {0}', 'Cycliste depuis {0}', 'Ciclista desde {0}', 'Ciclista desde {0}', '{0} سے رائیڈر', '{0} से राइडर', 'Rider mula {0}', '{0} देखि राइडर', '{0} থেকে রাইডার', 'Penunggang sejak {0}'],
  since1: ['Rider since {0} · 1 ride', 'راكب منذ {0} · جولة واحدة', 'Cycliste depuis {0} · 1 sortie', 'Ciclista desde {0} · 1 salida', 'Ciclista desde {0} · 1 passeio', '{0} سے رائیڈر · 1 رائیڈ', '{0} से राइडर · 1 राइड', 'Rider mula {0} · 1 ride', '{0} देखि राइडर · 1 सवारी', '{0} থেকে রাইডার · 1টি রাইড', 'Penunggang sejak {0} · 1 kayuhan'],
  sinceN: ['Rider since {0} · {1} rides', 'راكب منذ {0} · الجولات: {1}', 'Cycliste depuis {0} · {1} sorties', 'Ciclista desde {0} · {1} salidas', 'Ciclista desde {0} · {1} passeios', '{0} سے رائیڈر · {1} رائیڈز', '{0} से राइडर · {1} राइड', 'Rider mula {0} · {1} ride', '{0} देखि राइडर · {1} सवारी', '{0} থেকে রাইডার · {1}টি রাইড', 'Penunggang sejak {0} · {1} kayuhan'],
  consent: ['MicroMobility may publish this testimonial on its website', 'أوافق على أن تنشر MicroMobility هذه الشهادة على موقعها الإلكتروني', 'MicroMobility peut publier ce témoignage sur son site web', 'MicroMobility puede publicar este testimonio en su sitio web', 'A MicroMobility pode publicar este testemunho no seu site', 'MicroMobility یہ تاثرات اپنی ویب سائٹ پر شائع کر سکتی ہے', 'MicroMobility यह प्रशंसापत्र अपनी वेबसाइट पर प्रकाशित कर सकती है', 'Maaaring ilathala ng MicroMobility ang testimonial na ito sa website nito', 'MicroMobility ले यो प्रशंसापत्र आफ्नो वेबसाइटमा प्रकाशित गर्न सक्छ', 'MicroMobility এই প্রশংসাপত্রটি তাদের ওয়েবসাইটে প্রকাশ করতে পারবে', 'MicroMobility boleh menerbitkan testimoni ini di laman webnya'],
  send: ['Send', 'إرسال', 'Envoyer', 'Enviar', 'Enviar', 'بھیجیں', 'भेजें', 'Ipadala', 'पठाउनुहोस्', 'পাঠান', 'Hantar'],
  sending: ['Sending', 'جارٍ الإرسال', 'Envoi', 'Enviando', 'A enviar', 'بھیجا جا رہا ہے', 'भेजा जा रहा है', 'Ipinapadala', 'पठाउँदै', 'পাঠানো হচ্ছে', 'Menghantar'],
  sent: ['Thank you. Our team will review it soon.', 'شكراً لك. سيراجعها فريقنا قريباً.', 'Merci. Notre équipe va le relire bientôt.', 'Gracias. Nuestro equipo lo revisará pronto.', 'Obrigado. A nossa equipa vai revê-lo em breve.', 'شکریہ۔ ہماری ٹیم جلد اس کا جائزہ لے گی۔', 'धन्यवाद। हमारी टीम जल्द ही इसकी समीक्षा करेगी।', 'Salamat. Susuriin ito ng aming team sa lalong madaling panahon.', 'धन्यवाद। हाम्रो टोलीले चाँडै यसलाई हेर्नेछ।', 'ধন্যবাদ। আমাদের টিম শিগগিরই এটি দেখবে।', 'Terima kasih. Pasukan kami akan menyemaknya tidak lama lagi.'],
  again: ['Write another', 'اكتب شهادة أخرى', 'En écrire un autre', 'Escribir otro', 'Escrever outro', 'ایک اور لکھیں', 'एक और लिखें', 'Sumulat ng isa pa', 'अर्को लेख्नुहोस्', 'আরেকটি লিখুন', 'Tulis testimoni lain'],
  mineH: ['Your testimonials', 'شهاداتك', 'Vos témoignages', 'Tus testimonios', 'Os seus testemunhos', 'آپ کے تاثرات', 'आपके प्रशंसापत्र', 'Ang mga testimonial mo', 'तपाईंका प्रशंसापत्रहरू', 'আপনার প্রশংসাপত্র', 'Testimoni anda'],
  stPending: ['Waiting for review', 'بانتظار المراجعة', 'En attente de relecture', 'Pendiente de revisión', 'À espera de revisão', 'جائزے کا انتظار', 'समीक्षा की प्रतीक्षा में', 'Naghihintay ng pagsusuri', 'समीक्षाको पर्खाइमा', 'পর্যালোচনার অপেক্ষায়', 'Menunggu semakan'],
  stPublished: ['Published', 'منشورة', 'Publié', 'Publicado', 'Publicado', 'شائع شدہ', 'प्रकाशित', 'Nailathala', 'प्रकाशित', 'প্রকাশিত', 'Disiarkan'],
  stNot: ['Not published', 'غير منشورة', 'Non publié', 'No publicado', 'Não publicado', 'شائع نہیں ہوا', 'प्रकाशित नहीं', 'Hindi nailathala', 'प्रकाशित भएन', 'প্রকাশিত হয়নি', 'Tidak disiarkan'],
  del: ['Delete', 'حذف', 'Supprimer', 'Eliminar', 'Eliminar', 'حذف کریں', 'हटाएँ', 'Burahin', 'मेटाउनुहोस्', 'মুছুন', 'Padam'],
  delSure: ['Tap again to delete', 'اضغط مرة أخرى للحذف', 'Touchez encore pour supprimer', 'Toca de nuevo para eliminar', 'Toque novamente para eliminar', 'حذف کرنے کے لیے دوبارہ دبائیں', 'हटाने के लिए फिर से दबाएँ', 'Pindutin muli para burahin', 'मेटाउन फेरि थिच्नुहोस्', 'মুছতে আবার চাপুন', 'Ketik sekali lagi untuk memadam'],
  deleted: ['Testimonial deleted', 'حُذفت الشهادة', 'Témoignage supprimé', 'Testimonio eliminado', 'Testemunho eliminado', 'تاثرات حذف ہو گئے', 'प्रशंसापत्र हटा दिया गया', 'Nabura ang testimonial', 'प्रशंसापत्र मेटाइयो', 'প্রশংসাপত্র মুছে ফেলা হয়েছে', 'Testimoni dipadam'],
  errAbout: ['Pick what it is about.', 'اختر موضوعها.', 'Choisissez le sujet.', 'Elige de qué trata.', 'Escolha sobre o que é.', 'منتخب کریں کہ یہ کس بارے میں ہے۔', 'चुनें कि यह किस बारे में है।', 'Piliin kung tungkol saan ito.', 'यो केको बारेमा हो छान्नुहोस्।', 'এটি কী নিয়ে তা বেছে নিন।', 'Pilih topiknya.'],
  errStars: ['Pick from 1 to 5 stars.', 'اختر من 1 إلى 5 نجوم.', 'Choisissez de 1 à 5 étoiles.', 'Elige de 1 a 5 estrellas.', 'Escolha de 1 a 5 estrelas.', '1 سے 5 ستارے منتخب کریں۔', '1 से 5 स्टार चुनें।', 'Pumili mula 1 hanggang 5 bituin.', '1 देखि 5 तारा छान्नुहोस्।', '1 থেকে 5 তারা বেছে নিন।', 'Pilih antara 1 hingga 5 bintang.'],
  errBody: ['Write between 20 and 800 characters.', 'اكتب بين 20 و800 حرف.', 'Écrivez entre 20 et 800 caractères.', 'Escribe entre 20 y 800 caracteres.', 'Escreva entre 20 e 800 caracteres.', '20 سے 800 حروف کے درمیان لکھیں۔', '20 से 800 अक्षरों के बीच लिखें।', 'Sumulat ng 20 hanggang 800 na character.', '20 देखि 800 अक्षरसम्म लेख्नुहोस्।', '20 থেকে 800 অক্ষরের মধ্যে লিখুন।', 'Tulis antara 20 hingga 800 aksara.'],
  errLink: ['Please leave out links.', 'يرجى عدم إضافة روابط.', 'Merci de ne pas mettre de liens.', 'Por favor, no incluyas enlaces.', 'Por favor, não inclua links.', 'براہ کرم لنکس شامل نہ کریں۔', 'कृपया लिंक न डालें।', 'Pakialis ang mga link.', 'कृपया लिङ्क नराख्नुहोस्।', 'অনুগ্রহ করে লিংক দেবেন না।', 'Sila jangan sertakan pautan.'],
  errConsent: ['Tick the box so MicroMobility may publish it.', 'ضع علامة في المربع لتسمح لـ MicroMobility بنشرها.', 'Cochez la case pour que MicroMobility puisse le publier.', 'Marca la casilla para que MicroMobility pueda publicarlo.', 'Assinale a caixa para que a MicroMobility o possa publicar.', 'باکس پر نشان لگائیں تاکہ MicroMobility اسے شائع کر سکے۔', 'बॉक्स पर टिक करें ताकि MicroMobility इसे प्रकाशित कर सके।', 'Lagyan ng tsek ang kahon para mailathala ito ng MicroMobility.', 'MicroMobility ले प्रकाशित गर्न सकोस् भनेर बाकसमा चिन्ह लगाउनुहोस्।', 'MicroMobility যাতে এটি প্রকাশ করতে পারে, সেজন্য বক্সে টিক দিন।', 'Tandakan kotak supaya MicroMobility boleh menerbitkannya.'],
  errName: ['Your account has no name for this choice. Pick another one.', 'لا يوجد في حسابك اسم لهذا الخيار. اختر خياراً آخر.', "Votre compte n'a pas de nom pour ce choix. Choisissez-en un autre.", 'Tu cuenta no tiene un nombre para esta opción. Elige otra.', 'A sua conta não tem nome para esta opção. Escolha outra.', 'آپ کے اکاؤنٹ میں اس انتخاب کے لیے نام نہیں ہے۔ کوئی اور منتخب کریں۔', 'आपके खाते में इस विकल्प के लिए नाम नहीं है। कोई दूसरा चुनें।', 'Walang pangalan ang account mo para sa piniling ito. Pumili ng iba.', 'तपाईंको खातामा यो छनोटका लागि नाम छैन। अर्को छान्नुहोस्।', 'এই বিকল্পের জন্য আপনার অ্যাকাউন্টে কোনো নাম নেই। অন্যটি বেছে নিন।', 'Akaun anda tiada nama untuk pilihan ini. Pilih yang lain.'],
  errPhoto: ['This photo cannot be used. Try another one.', 'لا يمكن استخدام هذه الصورة. جرّب صورة أخرى.', 'Cette photo ne peut pas être utilisée. Essayez-en une autre.', 'No se puede usar esta foto. Prueba con otra.', 'Esta fotografia não pode ser usada. Experimente outra.', 'یہ تصویر استعمال نہیں ہو سکتی۔ کوئی اور آزمائیں۔', 'यह फ़ोटो इस्तेमाल नहीं हो सकती। कोई दूसरी आज़माएँ।', 'Hindi magagamit ang larawang ito. Sumubok ng iba.', 'यो फोटो प्रयोग गर्न सकिँदैन। अर्को प्रयास गर्नुहोस्।', 'এই ছবিটি ব্যবহার করা যাবে না। অন্য একটি চেষ্টা করুন।', 'Foto ini tidak boleh digunakan. Cuba foto lain.'],
  errEntry: ['This booking cannot take a testimonial.', 'لا يمكن إضافة شهادة لهذا الحجز.', 'Cette réservation ne peut pas recevoir de témoignage.', 'Esta reserva no admite un testimonio.', 'Esta reserva não pode receber um testemunho.', 'اس بکنگ پر تاثرات نہیں دیے جا سکتے۔', 'इस बुकिंग पर प्रशंसापत्र नहीं दिया जा सकता।', 'Hindi puwedeng lagyan ng testimonial ang booking na ito.', 'यो बुकिङमा प्रशंसापत्र दिन सकिँदैन।', 'এই বুকিংয়ে প্রশংসাপত্র দেওয়া যাবে না।', 'Tempahan ini tidak boleh menerima testimoni.'],
  errDup: ['You already shared a testimonial about this booking.', 'سبق أن شاركت شهادة عن هذا الحجز.', 'Vous avez déjà partagé un témoignage sur cette réservation.', 'Ya compartiste un testimonio sobre esta reserva.', 'Já partilhou um testemunho sobre esta reserva.', 'آپ اس بکنگ کے بارے میں پہلے ہی تاثرات دے چکے ہیں۔', 'आप इस बुकिंग के बारे में पहले ही प्रशंसापत्र दे चुके हैं।', 'Nakapagbahagi ka na ng testimonial tungkol sa booking na ito.', 'तपाईंले यो बुकिङबारे पहिले नै प्रशंसापत्र दिनुभएको छ।', 'এই বুকিং নিয়ে আপনি আগেই প্রশংসাপত্র দিয়েছেন।', 'Anda sudah berkongsi testimoni tentang tempahan ini.'],
  errLimit: ['Three of yours are waiting for review. Please wait until our team has read them.', 'ثلاث من شهاداتك بانتظار المراجعة. يرجى الانتظار حتى يطّلع عليها فريقنا.', "Trois de vos témoignages attendent d'être relus. Attendez que notre équipe les ait lus.", 'Tres de tus testimonios esperan revisión. Espera a que nuestro equipo los lea.', 'Três dos seus testemunhos aguardam revisão. Aguarde até a nossa equipa os ler.', 'آپ کے تین تاثرات جائزے کے منتظر ہیں۔ براہ کرم ہماری ٹیم کے پڑھنے تک انتظار کریں۔', 'आपके तीन प्रशंसापत्र समीक्षा की प्रतीक्षा में हैं। कृपया हमारी टीम के पढ़ने तक रुकें।', 'Tatlo sa mga testimonial mo ang naghihintay ng pagsusuri. Pakihintay hanggang mabasa ito ng aming team.', 'तपाईंका तीनवटा प्रशंसापत्र समीक्षाको पर्खाइमा छन्। हाम्रो टोलीले पढ्दासम्म कृपया पर्खनुहोस्।', 'আপনার তিনটি প্রশংসাপত্র পর্যালোচনার অপেক্ষায় আছে। আমাদের টিম পড়া পর্যন্ত অপেক্ষা করুন।', 'Tiga testimoni anda sedang menunggu semakan. Sila tunggu sehingga pasukan kami membacanya.'],
  errThrottled: ['You have sent five today. Please try again tomorrow.', 'أرسلت خمساً اليوم. يرجى المحاولة غداً.', "Vous en avez envoyé cinq aujourd'hui. Réessayez demain.", 'Hoy has enviado cinco. Inténtalo de nuevo mañana.', 'Enviou cinco hoje. Tente novamente amanhã.', 'آپ آج پانچ بھیج چکے ہیں۔ براہ کرم کل دوبارہ کوشش کریں۔', 'आप आज पाँच भेज चुके हैं। कृपया कल फिर कोशिश करें।', 'Lima na ang naipadala mo ngayon. Pakisubukang muli bukas.', 'तपाईंले आज पाँचवटा पठाइसक्नुभयो। कृपया भोलि फेरि प्रयास गर्नुहोस्।', 'আজ আপনি পাঁচটি পাঠিয়েছেন। আগামীকাল আবার চেষ্টা করুন।', 'Anda telah menghantar lima testimoni hari ini. Sila cuba lagi esok.'],
  errSignin: ['Please sign in again.', 'يرجى تسجيل الدخول مرة أخرى.', 'Veuillez vous reconnecter.', 'Vuelve a iniciar sesión.', 'Inicie sessão novamente.', 'براہ کرم دوبارہ سائن ان کریں۔', 'कृपया फिर से साइन इन करें।', 'Pakimag-sign in muli.', 'कृपया फेरि साइन इन गर्नुहोस्।', 'অনুগ্রহ করে আবার সাইন ইন করুন।', 'Sila log masuk semula.'],
  errNet: ['We could not send it. Please try again.', 'تعذّر الإرسال. يرجى المحاولة مرة أخرى.', 'Envoi impossible. Veuillez réessayer.', 'No se pudo enviar. Inténtalo de nuevo.', 'Não foi possível enviar. Tente novamente.', 'بھیجا نہیں جا سکا۔ دوبارہ کوشش کریں۔', 'भेजा नहीं जा सका। फिर कोशिश करें।', 'Hindi naipadala. Pakisubukang muli.', 'पठाउन सकिएन। फेरि प्रयास गर्नुहोस्।', 'পাঠানো যায়নি। আবার চেষ্টা করুন।', 'Kami tidak dapat menghantarnya. Sila cuba lagi.'],
  errLoad: ['We could not load your testimonials.', 'تعذّر تحميل شهاداتك.', 'Impossible de charger vos témoignages.', 'No se pudieron cargar tus testimonios.', 'Não foi possível carregar os seus testemunhos.', 'آپ کے تاثرات لوڈ نہیں ہو سکے۔', 'आपके प्रशंसापत्र लोड नहीं हो सके।', 'Hindi ma-load ang mga testimonial mo.', 'तपाईंका प्रशंसापत्र लोड गर्न सकिएन।', 'আপনার প্রশংসাপত্র লোড করা যায়নি।', 'Kami tidak dapat memuatkan testimoni anda.'],
  retry: ['Try again', 'حاول مرة أخرى', 'Réessayer', 'Reintentar', 'Tentar novamente', 'دوبارہ کوشش کریں', 'फिर कोशिश करें', 'Subukang muli', 'फेरि प्रयास गर्नुहोस्', 'আবার চেষ্টা করুন', 'Cuba lagi'],
  noDb: ['Testimonials are not available yet.', 'الشهادات غير متاحة بعد.', 'Les témoignages ne sont pas encore disponibles.', 'Los testimonios aún no están disponibles.', 'Os testemunhos ainda não estão disponíveis.', 'تاثرات ابھی دستیاب نہیں۔', 'प्रशंसापत्र अभी उपलब्ध नहीं हैं।', 'Hindi pa available ang mga testimonial.', 'प्रशंसापत्र अझै उपलब्ध छैनन्।', 'প্রশংসাপত্র এখনো চালু হয়নি।', 'Testimoni belum tersedia.'],
  rateT: ['Share it as a testimonial?', 'هل تشاركها كشهادة؟', 'Le partager comme témoignage ?', '¿Lo compartes como testimonio?', 'Partilhar como testemunho?', 'کیا اسے تاثرات کے طور پر شیئر کریں؟', 'क्या इसे प्रशंसापत्र के रूप में साझा करें?', 'Ibahagi ito bilang testimonial?', 'यसलाई प्रशंसापत्रको रूपमा साझा गर्ने?', 'এটি প্রশংসাপত্র হিসেবে শেয়ার করবেন?', 'Kongsi sebagai testimoni?'],
  notNow: ['Not now', 'ليس الآن', 'Pas maintenant', 'Ahora no', 'Agora não', 'ابھی نہیں', 'अभी नहीं', 'Hindi muna', 'अहिले होइन', 'এখন নয়', 'Bukan sekarang'],
  askT: ['May we publish your words?', 'هل تسمح لنا بنشر كلماتك؟', 'Pouvons-nous publier vos mots ?', '¿Podemos publicar tus palabras?', 'Podemos publicar as suas palavras?', 'کیا ہم آپ کے الفاظ شائع کر سکتے ہیں؟', 'क्या हम आपके शब्द प्रकाशित कर सकते हैं?', 'Puwede ba naming ilathala ang mga salita mo?', 'के हामी तपाईंका शब्दहरू प्रकाशित गर्न सक्छौं?', 'আমরা কি আপনার কথাগুলো প্রকাশ করতে পারি?', 'Bolehkah kami menerbitkan kata-kata anda?'],
  askYes: ['Publish it', 'انشرها', 'Publiez-le', 'Publícalo', 'Publiquem', 'شائع کریں', 'प्रकाशित करें', 'Ilathala ito', 'प्रकाशित गर्नुहोस्', 'প্রকাশ করুন', 'Terbitkan'],
  askNo: ['No thanks', 'لا، شكراً', 'Non merci', 'No, gracias', 'Não, obrigado', 'نہیں، شکریہ', 'नहीं, धन्यवाद', 'Huwag na, salamat', 'पर्दैन, धन्यवाद', 'না, ধন্যবাদ', 'Tidak, terima kasih'],
};
const TST_ABOUT = ['saturday', 'session', 'learn', 'event', 'workshop', 'other'];
const TST_MIN = 20, TST_MAX = 800;
function _tstL(r) { const i = TST_LANGS.indexOf(S.lang); return r[i < 0 ? 0 : i] || r[0] || ''; }
function _tstT(k) { return _tstL(TST_T[k] || []); }
function _tstDep() { return window._tstDeps || {}; }
function _tstIc(k, px) { const d = _tstDep(); return d.ic ? d.ic(k, px) : ''; }
function _tstDate(v) { const d = _tstDep(); return d.date ? d.date(v) : String(v || '').slice(0, 10); }
function _tstToast(m, k) { const d = _tstDep(); if (d.toast) d.toast(m, k); }
// The words a refusal is said in: each error the database answers with, else the network's.
const TST_ERR = { signin: 'errSignin', consent: 'errConsent', body: 'errBody', link: 'errLink', stars: 'errStars', about: 'errAbout', name: 'errName', photo: 'errPhoto', entry: 'errEntry', dup: 'errDup', limit: 'errLimit', throttled: 'errThrottled' };
function _tstErr(code) { return _tstT(TST_ERR[code] || 'errNet'); }
// The language the words are in, by their script: Arabic letters are Arabic (or Urdu on an Urdu page), Devanagari
// Hindi or Nepali, Bengali Bengali; Latin letters the page's language where it is written in them, else English.
function _tstLang(body) {
  const l = S.lang || 'en';
  if (/[؀-ۿ]/.test(body)) return l === 'ur' ? 'ur' : 'ar';
  if (/[ऀ-ॿ]/.test(body)) return l === 'ne' ? 'ne' : 'hi';
  if (/[ঀ-৿]/.test(body)) return 'bn';
  return ['fr', 'es', 'pt', 'tl', 'ms'].includes(l) ? l : 'en';
}
function _tstSince(s) {
  if (!s || !s.year) return '';
  const n = Number(s.rides) || 0;
  return _tstT(n === 1 ? 'since1' : n > 1 ? 'sinceN' : 'since0').replace('{0}', String(s.year)).replace('{1}', String(n));
}
// A star, drawn: filled when on.
function _tstStar(on, px) {
  return `<svg aria-hidden="true" class="tst-star${on ? ' on' : ''}" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.7l-5.12 2.7.98-5.72L3.7 9.64l5.75-.84z"/></svg>`;
}
// ── The form's pieces, shared by the page ('f'), the step after a rating ('r') and the old comment's ask ('a') ──────
function _tstSt(k) { return k === 'f' ? S._tstF : k === 'r' ? S._rg && S._rg.tm : k === 'a' ? S._tma : null; }
function _tstAboutHtml(k, F) {
  return `<div class="tst-f"><span class="tst-lbl" id="tst-ab-l-${k}">${_tstT('aboutL')}</span>
    <div class="tst-pills" role="group" aria-labelledby="tst-ab-l-${k}" id="tst-ab-${k}">${TST_ABOUT.map((a) => `<button type="button" class="tst-pill${F.about === a ? ' on' : ''}" aria-pressed="${F.about === a}" data-ab="${a}"${F.busy ? ' disabled' : ''} data-on-click="${_on('_tstAbout', k, a)}">${esc(_tstT('ab_' + a))}</button>`).join('')}</div></div>`;
}
function _tstStarsHtml(k, F) {
  return `<div class="tst-f"><span class="tst-lbl" id="tst-st-l-${k}">${_tstT('starsL')}</span>
    <div class="tst-starpick" role="radiogroup" aria-labelledby="tst-st-l-${k}" id="tst-st-${k}">${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="tst-sb" role="radio" aria-checked="${F.stars === n}" aria-label="${esc(_tstT('starsOf').replace('{0}', n))}" data-n="${n}"${F.busy ? ' disabled' : ''} data-on-click="${_on('_tstStars', k, n)}">${_tstStar(n <= F.stars, 30)}</button>`).join('')}</div></div>`;
}
function _tstWordsHtml(k, F) {
  const n = String(F.body || '').trim().length;
  return `<div class="tst-f"><label class="tst-lbl" for="tst-w-${k}">${_tstT('wordsL')}</label>
    <textarea id="tst-w-${k}" class="tst-ta" dir="auto" rows="${k === 'f' ? 6 : 4}" maxlength="${TST_MAX}"${F.busy ? ' disabled' : ''} data-on-input="${_on('_tstWords', k, _EL)}">${esc(F.body || '')}</textarea>
    <div class="tst-count${n && n < TST_MIN ? ' low' : ''}" id="tst-n-${k}" dir="ltr" aria-live="polite">${n} / ${TST_MAX}</div></div>`;
}
// The names exactly as the database will write them (testimonial_mine), each once, and Anonymous; beside a name, its
// "Rider since" line, as the website will show it.
function _tstNames(F) {
  const n = F.names || {}, out = [];
  if (n.full) out.push(['full', n.full]);
  if (n.short && n.short !== n.full) out.push(['short', n.short]);
  out.push(['anon', _tstT('anon')]);
  return out;
}
// The name chosen to start with: the short one, else the one the account has, else none.
function _tstDefName(names) { const o = _tstNames({ names }).map((x) => x[0]); return o.includes('short') ? 'short' : o[0]; }
function _tstShowsHtml(F) {
  if (F.name === 'anon') return `<span class="tst-shows-n">${esc(_tstT('anonShows'))}</span>`;
  const n = (F.names || {})[F.name] || '', s = _tstSince(F.since);
  return `<span class="tst-shows-n"><bdi>${esc(n)}</bdi></span>${s ? `<span class="tst-shows-s">${esc(s)}</span>` : ''}`;
}
function _tstNameHtml(k, F) {
  return `<fieldset class="tst-f tst-names"><legend class="tst-lbl">${_tstT('nameL')}</legend>
    ${_tstNames(F).map(([v, l]) => `<label class="tst-nm${F.name === v ? ' on' : ''}"><input type="radio" name="tst-nm-${k}" value="${v}"${F.name === v ? ' checked' : ''}${F.busy ? ' disabled' : ''} data-on-change="${_on('_tstName', k, v)}"><bdi>${esc(l)}</bdi></label>`).join('')}
    <div class="tst-shows" id="tst-shows-${k}">${_tstShowsHtml(F)}</div></fieldset>`;
}
function _tstConsentHtml(k, F) {
  const d = _tstDep();
  return `<div class="tst-f tst-consent">${d.tick ? d.tick('tst-ok-' + k, !!F.consent, esc(_tstT('consent')), k === 'f' ? '_tstOkF' : k === 'r' ? '_tstOkR' : '_tstOkA', true) : ''}</div>`;
}
function _tstErrHtml(F) { return F.err ? `<div class="tst-err" role="alert">${esc(F.err)}</div>` : ''; }
// Answers on the form, each drawing only what it changes: a box being typed in keeps its caret.
function _tstAbout(k, a) {
  const F = _tstSt(k); if (!F || F.busy || !TST_ABOUT.includes(a)) return;
  F.about = a; _tstClearErr(k, F);
  document.querySelectorAll(`#tst-ab-${k} .tst-pill`).forEach((b) => { const on = b.dataset.ab === a; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
}
function _tstStars(k, n) {
  const F = _tstSt(k); if (!F || F.busy) return;
  F.stars = Math.max(1, Math.min(5, Number(n) || 0)); _tstClearErr(k, F);
  document.querySelectorAll(`#tst-st-${k} .tst-sb`).forEach((b) => { const v = Number(b.dataset.n); b.setAttribute('aria-checked', String(v === F.stars)); const s = b.querySelector('.tst-star'); if (s) s.classList.toggle('on', v <= F.stars); });
}
function _tstWords(k, el) {
  const F = _tstSt(k); if (!F || !el) return;
  F.body = el.value; const n = String(F.body).trim().length, c = document.getElementById('tst-n-' + k);
  if (c) { c.textContent = n + ' / ' + TST_MAX; c.classList.toggle('low', !!n && n < TST_MIN); }
  if (F.err) _tstClearErr(k, F);
}
function _tstName(k, v) {
  const F = _tstSt(k); if (!F || F.busy) return;
  F.name = v; _tstClearErr(k, F);
  document.querySelectorAll(`input[name="tst-nm-${k}"]`).forEach((r) => { const l = r.closest('.tst-nm'); if (l) l.classList.toggle('on', r.value === v); });
  const s = document.getElementById('tst-shows-' + k); if (s) s.innerHTML = _tstShowsHtml(F);
}
function _tstOk(k) {
  const F = _tstSt(k); if (!F || F.busy) return;
  F.consent = !F.consent; const d = _tstDep(); if (d.tickSet) d.tickSet('tst-ok-' + k, F.consent);
  _tstClearErr(k, F);
}
function _tstOkF() { _tstOk('f'); }
function _tstOkR() { _tstOk('r'); }
function _tstOkA() { _tstOk('a'); }
function _tstClearErr(k, F) {
  if (!F.err) return; F.err = '';
  const box = k === 'f' ? document.getElementById('tst-page') : document.getElementById(k === 'r' ? 'rate-modal' : 'tst-ask');
  const e = box && box.querySelector('.tst-err'); if (e) e.remove();
}
// What the form lacks before it is sent ('' when nothing): the about, the stars, 20 to 800 characters, the tick.
function _tstCheck(F) {
  const b = String(F.body || '').trim();
  if (!TST_ABOUT.includes(F.about)) return _tstT('errAbout');
  if (!(F.stars >= 1 && F.stars <= 5)) return _tstT('errStars');
  if (b.length < TST_MIN || b.length > TST_MAX) return _tstT('errBody');
  if (!F.consent) return _tstT('errConsent');
  return '';
}
async function _tstSendRpc(c, F, source, entry) {
  const body = String(F.body || '').trim();
  let r;
  try {
    r = await sb.rpc('testimonial_send', { p_id: c.id, p_token: c.session_token, p_body: body, p_stars: F.stars, p_about: F.about, p_name_mode: F.name,
      p_consent: !!F.consent, p_photo: F.photo || null, p_source: source, p_entry: entry || null, p_lang: _tstLang(body) });
  } catch (e) { r = { error: e }; }
  return r && !r.error ? r.data || null : null;
}
// ── The page: Account > Write a testimonial ───────────────────────────────────────────────────────────────────────
// S._tstMine: {id: the account, d: testimonial_mine's answer, at, busy, err ('' | 'net' | 'gone')}.
// S._tstF: the form {id, about, stars, body, photo, name, consent, names, since, busy, err, sent}; kept through repaints.
function _tstMineLoad(c, force) {
  const M = S._tstMine && S._tstMine.id === c.id ? S._tstMine : (S._tstMine = { id: c.id, d: null, at: 0, busy: false, err: '' });
  if (!sb || M.busy || (!force && M.d && Date.now() - M.at < 6e4)) return Promise.resolve(M.d);
  M.busy = true; M.err = '';
  return Promise.resolve(sb.rpc('testimonial_mine', { p_id: c.id, p_token: c.session_token })).then((r) => {
    M.busy = false; M.at = Date.now();
    const d = r && !r.error ? r.data : null, dep = _tstDep();
    if (d && d.ok === true) { M.d = d; if (dep.onSet) dep.onSet(d.on === true); }
    else M.err = r && r.error && dep.absent && dep.absent(r.error) ? 'gone' : 'net';
    return M.d;
  }, () => { M.busy = false; M.err = 'net'; return M.d; });
}
function _tstForm(c, d) {
  let F = S._tstF;
  if (!F || F.id !== c.id) F = S._tstF = { id: c.id, about: '', stars: 0, body: '', photo: '', name: '', consent: false, busy: false, err: '', sent: false };
  F.names = d.names || {}; F.since = d.since || null;
  if (!_tstNames(F).some(([v]) => v === F.name)) F.name = _tstDefName(F.names);
  return F;
}
function _tstPage() {
  const h = document.getElementById('tst-page'), c = S.loggedIn || getSession();
  if (!h || !c) return;
  if (!c.session_token) { h.innerHTML = `<p class="tst-note">${_tstT('errSignin')}</p>`; return; }
  const M = S._tstMine && S._tstMine.id === c.id ? S._tstMine : null;
  if (!M || !M.d || Date.now() - M.at > 6e4) _tstMineLoad(c).then(() => _tstPaint()); // read at most once a minute
  _tstPaint();
}
function _tstPaint() {
  const h = document.getElementById('tst-page'), c = S.loggedIn || getSession(), M = c && S._tstMine && S._tstMine.id === c.id ? S._tstMine : null;
  if (!h || !M) return;
  if (!M.d) {
    h.innerHTML = M.busy ? (_tstDep().skel ? _tstDep().skel() : '') : M.err === 'gone' ? `<p class="tst-note">${_tstT('noDb')}</p>`
      : `<div class="tst-note">${_tstT('errLoad')} <button type="button" class="btn-secondary tst-retry" data-on-click="${_on('_tstReload')}">${_tstT('retry')}</button></div>`;
    return;
  }
  const F = _tstForm(c, M.d);
  h.innerHTML = `<section class="form-section acc-pg-card tst-card" id="tst-card">${F.sent ? _tstSentHtml() : _tstFormHtml(F)}</section>${_tstMineHtml(M.d)}`;
}
function _tstReload() { const c = S.loggedIn || getSession(); if (!c) return; _tstMineLoad(c, true).then(() => _tstPaint()); _tstPaint(); }
function _tstFormHtml(F) {
  const ph = F.photo, off = F.busy ? ' disabled' : '';
  return `${_tstAboutHtml('f', F)}${_tstStarsHtml('f', F)}${_tstWordsHtml('f', F)}
    <div class="tst-f tst-photo"><label class="tst-lbl" for="tst-file">${_tstT('photoL')} <span class="tst-opt">(${_tstT('optional')})</span></label>
      ${ph ? `<div class="tst-ph"><img class="tst-thumb" src="${esc(ph)}" alt=""><button type="button" class="btn-secondary tst-ph-drop"${off} data-on-click="${_on('_tstPhotoDrop')}">${_tstT('photoDrop')}</button></div>` : ''}
      <label class="btn-secondary tst-pick"><input type="file" id="tst-file" accept="image/*" class="sr-only"${off} data-on-change="${_on('_tstPhoto', _EL)}">${_tstIc('plus', 16)}<span>${_tstT(ph ? 'photoChange' : 'photoAdd')}</span></label></div>
    ${_tstNameHtml('f', F)}${_tstConsentHtml('f', F)}${_tstErrHtml(F)}
    <button type="button" class="btn-primary tst-send"${off} data-on-click="${_on('_tstSend')}">${F.busy ? _tstT('sending') : _tstT('send')}</button>`;
}
function _tstSentHtml() {
  return `<p class="tst-sent" id="tst-sent" role="status" tabindex="-1">${_tstIc('tick', 18)}<span>${_tstT('sent')}</span></p>
    <button type="button" class="btn-secondary tst-again" data-on-click="${_on('_tstAgain')}">${_tstT('again')}</button>`;
}
function _tstMineHtml(d) {
  const L = Array.isArray(d.items) ? d.items : [];
  if (!L.length) return '';
  return `<section class="tst-mine" aria-labelledby="tst-mine-h"><h3 class="tst-h" id="tst-mine-h">${_tstT('mineH')}</h3>
    <ul class="tst-list">${L.map(_tstItemHtml).join('')}</ul></section>`;
}
function _tstItemHtml(x) {
  const st = x.status === 'published' ? 'pub' : x.status === 'pending' ? 'wait' : 'no', sure = S._tstDelArm === x.id, n = Number(x.stars) || 0;
  const who = x.name_mode === 'anon' ? _tstT('anon') : x.display_name || '';
  return `<li class="tst-item" data-tid="${esc(String(x.id))}">
    <div class="tst-item-h">${n ? `<span class="tst-stars" role="img" aria-label="${esc(_tstT('starsOf').replace('{0}', n))}">${[1, 2, 3, 4, 5].map((i) => _tstStar(i <= n, 15)).join('')}</span>` : ''}
      <span class="tst-st tst-st-${st}">${_tstT(st === 'pub' ? 'stPublished' : st === 'wait' ? 'stPending' : 'stNot')}</span></div>
    <p class="tst-body" dir="auto">${esc(x.body || '')}</p>
    <div class="tst-item-m">${esc([_tstT('ab_' + (TST_ABOUT.includes(x.about) ? x.about : 'other')), who, _tstDate(x.created_at), x.photo ? _tstT('photoL') : ''].filter(Boolean).join(' · '))}</div>
    <button type="button" class="${sure ? 'btn-red' : 'btn-secondary'} tst-del" data-on-click="${_on('_tstDel', x.id)}">${_tstT(sure ? 'delSure' : 'del')}</button>
  </li>`;
}
// A photo made small enough for the database (600,000 bytes as a data: URL): the long side 1200 px, a JPEG from 0.82
// down, smaller again when that is not enough; '' when it cannot be made. (The staff page's Add testimonial: _tsmFit.)
async function _tstFitImg(f) {
  const max = _tstDep().max || 600000;
  try {
    let im;
    try { im = await createImageBitmap(f); } catch (_) {
      im = await new Promise((ok, no) => { const u = URL.createObjectURL(f), x = new Image(); x.onload = () => { URL.revokeObjectURL(u); ok(x); }; x.onerror = () => { URL.revokeObjectURL(u); no(new Error('image')); }; x.src = u; });
    }
    const W = im.width || im.naturalWidth, H = im.height || im.naturalHeight;
    for (let side = 1200; side >= 400; side = Math.round(side * 0.75)) {
      const k = Math.min(1, side / Math.max(W, H, 1)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
      const cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, c.width, c.height); cx.drawImage(im, 0, 0, c.width, c.height);
      for (let q = 0.82; q >= 0.4; q -= 0.1) { const u = c.toDataURL('image/jpeg', q); if (u.length <= max && /^data:image\/jpeg;base64,/.test(u)) return u; }
    }
  } catch (_) { /* not a picture this browser can read */ }
  return '';
}
async function _tstPhoto(el) {
  const F = S._tstF, f = el && el.files && el.files[0], d = _tstDep();
  if (!F || !f || F.busy) return;
  const u = /^image\//.test(f.type || '') ? await _tstFitImg(f) : '';
  if (S._tstF !== F) return;
  if (!u || u.length > (d.max || 600000)) { F.err = _tstT('errPhoto'); _tstPaint(); return; }
  F.photo = u; F.err = ''; _tstPaint();
}
function _tstPhotoDrop() { const F = S._tstF; if (!F || F.busy) return; F.photo = ''; _tstPaint(); }
async function _tstSend() {
  const c = S.loggedIn || getSession(), F = S._tstF, M = S._tstMine, d = _tstDep();
  if (!c || !F || F.busy || !c.session_token) return;
  const miss = _tstCheck(F);
  if (miss) { F.err = miss; _tstPaint(); const e = document.querySelector('#tst-page .tst-err'); if (e) try { e.scrollIntoView({ block: 'center' }); } catch (_) {} return; }
  if (d.offline && d.offline(() => _tstSend())) return;
  F.busy = true; F.err = ''; _tstPaint();
  const a = await _tstSendRpc(c, F, 'app', null);
  if (S._tstF !== F) return;
  F.busy = false;
  if (!a || a.ok !== true) { F.err = _tstErr(a && a.error); _tstPaint(); return; }
  if (M && M.d) M.d = { ...M.d, items: [{ id: a.id, about: F.about, stars: F.stars, body: a.body || String(F.body).trim(), name_mode: F.name, display_name: a.display_name || null, status: 'pending', photo: !!F.photo, source: 'app', created_at: new Date().toISOString() }, ...(M.d.items || [])] };
  S._tstF = { id: c.id, about: '', stars: 0, body: '', photo: '', name: F.name, consent: false, busy: false, err: '', sent: true };
  _tstPaint();
  const s = document.getElementById('tst-sent'); if (s) try { s.focus({ preventScroll: true }); } catch (_) {}
}
function _tstAgain() {
  const F = S._tstF; if (!F) return;
  F.sent = false; _tstPaint();
  const w = document.getElementById('tst-w-f'); if (w) try { w.focus({ preventScroll: true }); } catch (_) {}
}
// Delete: the first tap arms it, the second deletes (testimonial_delete); one already gone leaves the list too.
async function _tstDel(id) {
  const c = S.loggedIn || getSession(), M = S._tstMine;
  if (!c || !M || !M.d || S._tstDelBusy) return;
  if (S._tstDelArm !== id) { S._tstDelArm = id; _tstPaint(); const b = document.querySelector(`#tst-page .tst-item[data-tid="${CSS.escape(String(id))}"] .tst-del`); if (b) try { b.focus({ preventScroll: true }); } catch (_) {} return; }
  S._tstDelArm = null; S._tstDelBusy = true;
  let r; try { r = await sb.rpc('testimonial_delete', { p_id: c.id, p_token: c.session_token, p_tid: Number(id) }); } catch (e) { r = { error: e }; }
  S._tstDelBusy = false;
  const a = r && !r.error ? r.data : null;
  if (!a || (a.ok !== true && a.error !== 'gone')) { _tstToast(a && a.error === 'signin' ? _tstT('errSignin') : _tstT('errNet'), 'error'); _tstPaint(); return; }
  if (M.d) M.d = { ...M.d, items: (M.d.items || []).filter((x) => String(x.id) !== String(id)) };
  _tstPaint(); _tstToast(_tstT('deleted'), 'success');
}
// ── After a rating of 9 or 10: the same pop-up's next step ──────────────────────────────────────────────────────────
// null when it should not show: the switch off, that booking shared already, three waiting (the send would be refused).
async function _tstRateNew(x) {
  const c = S.loggedIn; if (!c || !c.session_token || !x) return null;
  const d = await _tstMineLoad(c, true);
  if (!d || d.on !== true) return null;
  const L = Array.isArray(d.items) ? d.items : [];
  if (L.some((i) => i.entry_id === x.entry && i.status !== 'rejected') || L.filter((i) => i.status === 'pending').length >= 3) return null;
  const n = d.names || {};
  return { entry: x.entry, about: TST_ABOUT.includes(x.about) ? x.about : 'other', stars: Math.max(1, Math.min(5, Math.round((Number(x.exp) || 10) / 2))),
    body: String(x.note || '').trim().slice(0, TST_MAX), name: _tstDefName(n), consent: false, busy: false, err: '', names: n, since: d.since || null };
}
function _tstRateHtml(R) {
  const off = R.busy ? ' disabled' : '';
  return `<div class="auth-backdrop"><div class="pg-box fx-box rg-box tst-rate" role="dialog" aria-modal="true" aria-labelledby="tst-rate-t" tabindex="-1">
    <h2 id="tst-rate-t" class="pg-title">${_tstT('rateT')}</h2>
    ${_tstAboutHtml('r', R)}${_tstStarsHtml('r', R)}${_tstWordsHtml('r', R)}${_tstNameHtml('r', R)}${_tstConsentHtml('r', R)}${_tstErrHtml(R)}
    <button type="button" class="pg-btn tst-rate-send"${off} data-on-click="${_on('_tstRateSend')}">${R.busy ? _tstT('sending') : _tstT('send')}</button>
    <button type="button" class="gate-out tst-rate-skip"${off} data-on-click="${_on('_tstRateSkip')}">${_tstT('notNow')}</button>
  </div></div>`;
}
function _tstRatePaint() { const d = _tstDep(); if (d.paintRate) d.paintRate(); }
async function _tstRateSend() {
  const g = S._rg, R = g && g.tm, c = S.loggedIn, d = _tstDep();
  if (!R || R.busy || !c || !c.session_token) return;
  const miss = _tstCheck(R);
  if (miss) { R.err = miss; _tstRatePaint(); return; }
  R.busy = true; R.err = ''; _tstRatePaint();
  const a = await _tstSendRpc(c, R, 'rating', R.entry);
  if (!S._rg || S._rg.tm !== R) return;
  R.busy = false;
  if (a && (a.ok === true || a.error === 'dup')) { // shared, or shared already: the step is done
    if (a.ok === true && S._tstMine && S._tstMine.id === c.id) S._tstMine.at = 0; // the page reads them again
    _tstToast(_tstT(a.ok === true ? 'sent' : 'errDup'), a.ok === true ? 'success' : 'info');
    if (d.rateDone) d.rateDone(); return;
  }
  R.err = _tstErr(a && a.error); _tstRatePaint();
}
function _tstRateSkip() { const g = S._rg, d = _tstDep(); if (!g || !g.tm || g.tm.busy) return; if (d.rateDone) d.rateDone(); }
// ── The one-time ask about an old comment ──────────────────────────────────────────────────────────────────────────
// S._tma: {id, ask: {entry_id, body, date, title, title_ar, ...}, names, since, name, consent, busy, err}.
// The page's _tstAskCheck has decided it is time to ask (the switch on, nothing else open, not asked today): this reads
// testimonial_mine; none due is noted for a week, one due for a day (an answer ends it for good, _tstAskDone).
async function _tstAskRun(c) {
  const dep = _tstDep(), mark = (o) => { try { localStorage.setItem((dep.askKey || 'cq_tst_ask_') + c.id, JSON.stringify({ at: Date.now(), ...o })); } catch (_) { /* storage refused: once a day a page */ } };
  const d = await _tstMineLoad(c, true);
  if (!d || !S.loggedIn || S.loggedIn.id !== c.id) return; // no answer (or signed out meanwhile): asked again tomorrow
  if (d.on !== true) return;
  if (!d.ask || !d.ask.entry_id) { mark({ none: 1 }); return; }
  mark({});
  if (!S._tma && (!dep.askFree || dep.askFree())) _tstAskShow(d);
}
function _tstAskShow(d) {
  const c = S.loggedIn; if (!c || !d || !d.ask) return;
  const n = d.names || {};
  S._tma = { id: c.id, ask: d.ask, names: n, since: d.since || null, name: _tstDefName(n), consent: false, busy: false, err: '' };
  _tstAskPaint(true);
}
function _tstAskPaint(first) {
  const A = S._tma, dep = _tstDep(); if (!A || !dep.askHost) return;
  // an untitled ride (every Saturday, most sessions) is named by its kind
  const a = A.ask, title = (S.lang === 'ar' && a.title_ar) || a.title || (TST_ABOUT.includes(a.about) && a.about !== 'other' ? _tstT('ab_' + a.about) : ''), when = a.date ? _tstDate(a.date) : '', off = A.busy ? ' disabled' : '';
  dep.askHost(`<div class="auth-backdrop"><div class="pg-box fx-box tst-ask" role="dialog" aria-modal="true" aria-labelledby="tst-ask-t" tabindex="-1">
    <h2 id="tst-ask-t" class="pg-title">${_tstT('askT')}</h2>
    ${title || when ? `<div class="rg-meta">${esc([title, when].filter(Boolean).join(' · '))}</div>` : ''}
    <blockquote class="tst-quote" dir="auto">${esc(a.body || '')}</blockquote>
    ${_tstNameHtml('a', A)}${_tstConsentHtml('a', A)}${_tstErrHtml(A)}
    <button type="button" class="pg-btn tst-ask-yes"${off} data-on-click="${_on('_tstAskAnswer', true)}">${A.busy ? _tstT('sending') : _tstT('askYes')}</button>
    <button type="button" class="gate-out tst-ask-no"${off} data-on-click="${_on('_tstAskAnswer', false)}">${_tstT('askNo')}</button>
  </div></div>`);
  if (first) { const b = document.querySelector('#tst-ask .tst-ask'); if (b) try { b.focus({ preventScroll: true }); } catch (_) {} }
}
async function _tstAskAnswer(yes) {
  const A = S._tma, c = S.loggedIn, dep = _tstDep();
  if (!A || A.busy || !c || c.id !== A.id || !c.session_token) return;
  if (yes && !A.consent) { A.err = _tstT('errConsent'); _tstAskPaint(); return; }
  A.busy = true; A.err = ''; _tstAskPaint();
  let r;
  try { r = await sb.rpc('testimonial_old_answer', { p_id: c.id, p_token: c.session_token, p_entry: A.ask.entry_id, p_yes: !!yes, p_name_mode: A.name, p_consent: !!(yes && A.consent) }); } catch (e) { r = { error: e }; }
  if (S._tma !== A) return;
  A.busy = false;
  const a = r && !r.error ? r.data : null;
  // answered (or answered before, or the ride no longer qualifies, or the switch went off): it ends here for good
  if (a && (a.ok === true || ['done', 'entry', 'off'].includes(a.error))) {
    if (a.ok === true && yes) _tstToast(_tstT('sent'), 'success');
    if (S._tstMine && S._tstMine.id === c.id) S._tstMine.at = 0;
    if (dep.askDone) dep.askDone(c.id); return;
  }
  if (!yes && (!a || a.error === 'signin')) { S._tma = null; if (dep.askHost) dep.askHost(null); return; } // No thanks that did not reach us: asked again another day
  A.err = a && a.error === 'name' ? _tstT('errName') : a && a.error === 'consent' ? _tstT('errConsent') : a && a.error === 'signin' ? _tstT('errSignin') : _tstT('errNet');
  _tstAskPaint();
}
window._tstPage = _tstPage;
window._tstRateNew = _tstRateNew; // not _tstRateFor: the page's own function of that name calls this one
window._tstRateHtml = _tstRateHtml;
window._tstRateSkip = _tstRateSkip;
window._tstAskRun = _tstAskRun;
