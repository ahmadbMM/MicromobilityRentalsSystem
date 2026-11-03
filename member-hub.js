// The Community page's activities (the owner, 2026-11-03; migration 20261103120500): kudos, Rider of the
// Month, challenges and the community goal, squads, the photo wall and the year in review. A file of its
// own, loaded when a member opens the page (_hubLoad in app.src.html), so no other rider carries it: it holds
// its own words in all ten languages. Hand-written, not generated; the build stamps its address (HUB_V).
/* global S, sb, esc, toast, getSession, _on, _P, _cssv, shortDate, _mbRowsPaint */
const HUB_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn'];
const HUB_T = {
  tabList: ['Members', 'الأعضاء', 'Membres', 'Miembros', 'Membros', 'ارکان', 'सदस्य', 'Mga miyembro', 'सदस्य', 'সদস্য'],
  tabKudos: ['Kudos', 'التقدير', 'Bravos', 'Aplausos', 'Aplausos', 'داد', 'शाबाशी', 'Kudos', 'स्याबासी', 'বাহবা'],
  tabVote: ['Vote', 'التصويت', 'Vote', 'Votar', 'Votar', 'ووٹ', 'वोट', 'Boto', 'मतदान', 'ভোট'],
  tabGoals: ['Challenges', 'التحديات', 'Défis', 'Retos', 'Desafios', 'چیلنج', 'चुनौतियाँ', 'Mga hamon', 'चुनौती', 'চ্যালেঞ্জ'],
  tabSquads: ['Squads', 'الفرق', 'Équipes', 'Equipos', 'Equipas', 'اسکواڈ', 'स्क्वाड', 'Mga squad', 'स्क्वाड', 'স্কোয়াড'],
  tabPhotos: ['Photos', 'الصور', 'Photos', 'Fotos', 'Fotos', 'تصاویر', 'फ़ोटो', 'Mga larawan', 'फोटो', 'ছবি'],
  tabYear: ['Your year', 'عامك', 'Votre année', 'Tu año', 'O seu ano', 'آپ کا سال', 'आपका साल', 'Ang taon mo', 'तपाईंको वर्ष', 'আপনার বছর'],
  err: ['We could not do that. Please try again.', 'تعذّر ذلك. يرجى المحاولة مرة أخرى.', 'Action impossible. Veuillez réessayer.', 'No se pudo hacer. Inténtalo de nuevo.', 'Não foi possível. Tente novamente.', 'یہ نہیں ہو سکا۔ دوبارہ کوشش کریں۔', 'यह नहीं हो सका। फिर कोशिश करें।', 'Hindi ito nagawa. Pakisubukang muli.', 'यो हुन सकेन। फेरि प्रयास गर्नुहोस्।', 'এটি করা যায়নি। আবার চেষ্টা করুন।'],
  retry: ['Try again', 'حاول مرة أخرى', 'Réessayer', 'Reintentar', 'Tentar novamente', 'دوبارہ کوشش کریں', 'फिर कोशिश करें', 'Subukang muli', 'फेरि प्रयास गर्नुहोस्', 'আবার চেষ্টা করুন'],
  loading: ['Loading...', 'جارٍ التحميل...', 'Chargement...', 'Cargando...', 'A carregar...', 'لوڈ ہو رہا ہے...', 'लोड हो रहा है...', 'Nilo-load...', 'लोड हुँदै...', 'লোড হচ্ছে...'],
  buddy: ['Your welcome buddy: {0}', 'رفيق الترحيب بك: {0}', 'Votre parrain d’accueil : {0}', 'Tu compañero de bienvenida: {0}', 'O seu companheiro de boas-vindas: {0}', 'آپ کا استقبالی ساتھی: {0}', 'आपके स्वागत साथी: {0}', 'Ang welcome buddy mo: {0}', 'तपाईंको स्वागत साथी: {0}', 'আপনার স্বাগত সঙ্গী: {0}'],
  welcoming: ['You are welcoming: {0}', 'أنت ترحّب بـ: {0}', 'Vous accueillez : {0}', 'Estás dando la bienvenida a: {0}', 'Está a dar as boas-vindas a: {0}', 'آپ ان کا استقبال کر رہے ہیں: {0}', 'आप इनका स्वागत कर रहे हैं: {0}', 'Winewelcome mo si: {0}', 'तपाईं यिनको स्वागत गर्दै हुनुहुन्छ: {0}', 'আপনি স্বাগত জানাচ্ছেন: {0}'],
  kudosGot: ['Kudos you received: {0}', 'التقدير الذي تلقيته: {0}', 'Bravos reçus : {0}', 'Aplausos recibidos: {0}', 'Aplausos recebidos: {0}', 'آپ کو ملی داد: {0}', 'आपको मिली शाबाशी: {0}', 'Natanggap mong kudos: {0}', 'तपाईंले पाएको स्याबासी: {0}', 'আপনার পাওয়া বাহবা: {0}'],
  kudosFrom: ['Who was there with you on {0}', 'من كان معك في {0}', 'Qui était avec vous le {0}', 'Quién estuvo contigo el {0}', 'Quem esteve consigo em {0}', '{0} کو آپ کے ساتھ کون تھا', '{0} को आपके साथ कौन था', 'Sino ang kasama mo noong {0}', '{0} मा तपाईंसँग को थिए', '{0} তারিখে আপনার সাথে কে ছিলেন'],
  kudosNone: ['Finish a community session and you can give kudos to the members who were there.', 'أكمل نشاطًا مجتمعيًا لتتمكن من تقدير الأعضاء الذين شاركوا فيه.', 'Terminez une session de la communauté pour féliciter les membres présents.', 'Termina una sesión de la comunidad y podrás aplaudir a los miembros presentes.', 'Termine uma sessão da comunidade para aplaudir os membros presentes.', 'کمیونٹی سیشن مکمل کریں اور وہاں موجود ارکان کو داد دیں۔', 'समुदाय का सत्र पूरा करें और वहाँ मौजूद सदस्यों को शाबाशी दें।', 'Tapusin ang community session para makapagbigay ng kudos sa mga kasama mo.', 'समुदायको सत्र पूरा गरेपछि त्यहाँ भएका सदस्यलाई स्याबासी दिन सक्नुहुन्छ।', 'কমিউনিটি সেশন শেষ করলে সেখানে থাকা সদস্যদের বাহবা দিতে পারবেন।'],
  kudosGive: ['Give kudos', 'قدّم التقدير', 'Féliciter', 'Aplaudir', 'Aplaudir', 'داد دیں', 'शाबाशी दें', 'Magbigay ng kudos', 'स्याबासी दिनुहोस्', 'বাহবা দিন'],
  kudosGiven: ['Given', 'تم', 'Envoyé', 'Hecho', 'Feito', 'دی گئی', 'दी गई', 'Naibigay', 'दिइयो', 'দেওয়া হয়েছে'],
  voteAsk: ['Who should be {0}?', 'من يستحق {0}؟', 'Qui mérite {0} ?', '¿Quién merece {0}?', 'Quem merece {0}?', '{0} کون ہونا چاہیے؟', '{0} कौन होना चाहिए?', 'Sino ang dapat maging {0}?', '{0} को हुनुपर्छ?', '{0} কে হওয়া উচিত?'],
  voteUntil: ['You can change your vote until {0}. Nobody sees who you chose.', 'يمكنك تغيير صوتك حتى {0}. لا يرى أحد من اخترت.', 'Vous pouvez changer votre vote jusqu’au {0}. Personne ne voit votre choix.', 'Puedes cambiar tu voto hasta el {0}. Nadie ve a quién elegiste.', 'Pode mudar o seu voto até {0}. Ninguém vê a sua escolha.', 'آپ {0} تک اپنا ووٹ بدل سکتے ہیں۔ کوئی نہیں دیکھتا کہ آپ نے کسے چنا۔', 'आप {0} तक वोट बदल सकते हैं। कोई नहीं देखता कि आपने किसे चुना।', 'Maaari mong baguhin ang boto mo hanggang {0}. Walang makakakita kung sino ang pinili mo.', 'तपाईं {0} सम्म मत बदल्न सक्नुहुन्छ। तपाईंले कसलाई छान्नुभयो कसैले देख्दैन।', '{0} পর্যন্ত ভোট বদলাতে পারবেন। আপনি কাকে বেছেছেন কেউ দেখবে না।'],
  voteNone: ['There is no vote open right now.', 'لا يوجد تصويت مفتوح الآن.', 'Aucun vote en cours.', 'No hay ninguna votación abierta.', 'Não há nenhuma votação aberta.', 'ابھی کوئی ووٹنگ کھلی نہیں۔', 'अभी कोई वोट खुला नहीं है।', 'Walang bukas na botohan ngayon.', 'अहिले कुनै मतदान खुला छैन।', 'এখন কোনো ভোট চলছে না।'],
  voteFor: ['Vote', 'صوّت', 'Voter', 'Votar', 'Votar', 'ووٹ دیں', 'वोट दें', 'Bumoto', 'मत दिनुहोस्', 'ভোট দিন'],
  voteMine: ['Your vote', 'صوتك', 'Votre vote', 'Tu voto', 'O seu voto', 'آپ کا ووٹ', 'आपका वोट', 'Boto mo', 'तपाईंको मत', 'আপনার ভোট'],
  search: ['Search by name', 'البحث بالاسم', 'Rechercher par nom', 'Buscar por nombre', 'Pesquisar por nome', 'نام سے تلاش کریں', 'नाम से खोजें', 'Maghanap ayon sa pangalan', 'नामबाट खोज्नुहोस्', 'নাম দিয়ে খুঁজুন'],
  winner: ['{0}: {1}', '{0}: {1}', '{0} : {1}', '{0}: {1}', '{0}: {1}', '{0}: {1}', '{0}: {1}', '{0}: {1}', '{0}: {1}', '{0}: {1}'],
  goalsNone: ['No challenge is running right now.', 'لا يوجد تحدٍ جارٍ الآن.', 'Aucun défi en cours.', 'No hay ningún reto en marcha.', 'Não há nenhum desafio a decorrer.', 'ابھی کوئی چیلنج جاری نہیں۔', 'अभी कोई चुनौती नहीं चल रही।', 'Walang hamon ngayon.', 'अहिले कुनै चुनौती चलिरहेको छैन।', 'এখন কোনো চ্যালেঞ্জ চলছে না।'],
  goalYou: ['Your challenge', 'تحديك', 'Votre défi', 'Tu reto', 'O seu desafio', 'آپ کا چیلنج', 'आपकी चुनौती', 'Hamon mo', 'तपाईंको चुनौती', 'আপনার চ্যালেঞ্জ'],
  goalAll: ['Community goal', 'هدف المجتمع', 'Objectif de la communauté', 'Meta de la comunidad', 'Objetivo da comunidade', 'کمیونٹی کا ہدف', 'समुदाय का लक्ष्य', 'Layunin ng komunidad', 'समुदायको लक्ष्य', 'কমিউনিটির লক্ষ্য'],
  goalOf: ['{0} of {1}, until {2}', '{0} من {1}، حتى {2}', '{0} sur {1}, jusqu’au {2}', '{0} de {1}, hasta el {2}', '{0} de {1}, até {2}', '{1} میں سے {0}، {2} تک', '{1} में से {0}, {2} तक', '{0} sa {1}, hanggang {2}', '{1} मध्ये {0}, {2} सम्म', '{1}টির মধ্যে {0}টি, {2} পর্যন্ত'],
  goalDone: ['Done', 'تم', 'Terminé', 'Hecho', 'Concluído', 'مکمل', 'पूरा', 'Tapos na', 'पूरा भयो', 'সম্পন্ন'],
  reward: ['Reward: {0}', 'الجائزة: {0}', 'Récompense : {0}', 'Premio: {0}', 'Prémio: {0}', 'انعام: {0}', 'इनाम: {0}', 'Gantimpala: {0}', 'पुरस्कार: {0}', 'পুরস্কার: {0}'],
  sqMake: ['Start a squad', 'أنشئ فريقًا', 'Créer une équipe', 'Crear un equipo', 'Criar uma equipa', 'اسکواڈ بنائیں', 'स्क्वाड बनाएँ', 'Gumawa ng squad', 'स्क्वाड बनाउनुहोस्', 'স্কোয়াড বানান'],
  sqName: ['Squad name', 'اسم الفريق', 'Nom de l’équipe', 'Nombre del equipo', 'Nome da equipa', 'اسکواڈ کا نام', 'स्क्वाड का नाम', 'Pangalan ng squad', 'स्क्वाडको नाम', 'স্কোয়াডের নাম'],
  sqJoin: ['Join with a code', 'انضم برمز', 'Rejoindre avec un code', 'Unirse con un código', 'Entrar com um código', 'کوڈ سے شامل ہوں', 'कोड से जुड़ें', 'Sumali gamit ang code', 'कोडबाट जोडिनुहोस्', 'কোড দিয়ে যোগ দিন'],
  sqCode: ['Squad code', 'رمز الفريق', 'Code de l’équipe', 'Código del equipo', 'Código da equipa', 'اسکواڈ کوڈ', 'स्क्वाड कोड', 'Code ng squad', 'स्क्वाड कोड', 'স্কোয়াড কোড'],
  sqShare: ['Share the code', 'شارك الرمز', 'Partager le code', 'Compartir el código', 'Partilhar o código', 'کوڈ شیئر کریں', 'कोड साझा करें', 'Ibahagi ang code', 'कोड साझा गर्नुहोस्', 'কোড শেয়ার করুন'],
  sqShareMsg: ['Join my MicroMobility squad {0} with the code {1} on the Community page.', 'انضم إلى فريقي {0} في مايكروموبيليتي بالرمز {1} من صفحة المجتمع.', 'Rejoins mon équipe MicroMobility {0} avec le code {1} sur la page Communauté.', 'Únete a mi equipo de MicroMobility {0} con el código {1} en la página Comunidad.', 'Entra na minha equipa MicroMobility {0} com o código {1} na página Comunidade.', 'کمیونٹی صفحے پر کوڈ {1} سے میرے MicroMobility اسکواڈ {0} میں شامل ہوں۔', 'समुदाय पेज पर कोड {1} से मेरे MicroMobility स्क्वाड {0} में जुड़ें।', 'Sumali sa MicroMobility squad kong {0} gamit ang code na {1} sa Community page.', 'समुदाय पृष्ठमा कोड {1} बाट मेरो MicroMobility स्क्वाड {0} मा जोडिनुहोस्।', 'কমিউনিটি পাতায় {1} কোড দিয়ে আমার MicroMobility স্কোয়াড {0}-এ যোগ দিন।'],
  sqLeave: ['Leave the squad', 'مغادرة الفريق', 'Quitter l’équipe', 'Salir del equipo', 'Sair da equipa', 'اسکواڈ چھوڑیں', 'स्क्वाड छोड़ें', 'Umalis sa squad', 'स्क्वाड छोड्नुहोस्', 'স্কোয়াড ছাড়ুন'],
  sure: ['Tap again to confirm', 'اضغط مرة أخرى للتأكيد', 'Touchez encore pour confirmer', 'Toca otra vez para confirmar', 'Toque novamente para confirmar', 'تصدیق کے لیے دوبارہ ٹیپ کریں', 'पुष्टि के लिए फिर टैप करें', 'I-tap muli para kumpirmahin', 'पुष्टि गर्न फेरि ट्याप गर्नुहोस्', 'নিশ্চিত করতে আবার ট্যাপ করুন'],
  sqBoard: ['Squads this month', 'الفرق هذا الشهر', 'Les équipes ce mois-ci', 'Equipos este mes', 'Equipas este mês', 'اس مہینے کے اسکواڈ', 'इस महीने के स्क्वाड', 'Mga squad ngayong buwan', 'यो महिनाका स्क्वाड', 'এই মাসের স্কোয়াড'],
  sqRow: ['{0} members, {1} sessions', '{0} أعضاء، {1} نشاط', '{0} membres, {1} sessions', '{0} miembros, {1} sesiones', '{0} membros, {1} sessões', '{0} ارکان، {1} سیشن', '{0} सदस्य, {1} सत्र', '{0} miyembro, {1} session', '{0} सदस्य, {1} सत्र', '{0} সদস্য, {1}টি সেশন'],
  sqErrName: ['A squad name is 2 to 30 characters.', 'يتكون اسم الفريق من 2 إلى 30 حرفًا.', 'Le nom compte de 2 à 30 caractères.', 'El nombre tiene de 2 a 30 caracteres.', 'O nome tem de 2 a 30 caracteres.', 'نام 2 سے 30 حروف کا ہو۔', 'नाम 2 से 30 अक्षरों का हो।', 'Ang pangalan ay 2 hanggang 30 titik.', 'नाम 2 देखि 30 अक्षरको हुनुपर्छ।', 'নাম 2 থেকে 30 অক্ষরের হবে।'],
  sqErrTaken: ['Another squad has that name.', 'هناك فريق آخر بهذا الاسم.', 'Une autre équipe porte ce nom.', 'Otro equipo tiene ese nombre.', 'Outra equipa tem esse nome.', 'یہ نام کسی اور اسکواڈ کا ہے۔', 'यह नाम दूसरे स्क्वाड का है।', 'May ibang squad na may ganyang pangalan.', 'यो नाम अर्को स्क्वाडको हो।', 'এই নামে আরেকটি স্কোয়াড আছে।'],
  sqErrCode: ['That code is not right.', 'هذا الرمز غير صحيح.', 'Ce code n’est pas bon.', 'Ese código no es correcto.', 'Esse código não está certo.', 'یہ کوڈ درست نہیں۔', 'यह कोड सही नहीं है।', 'Mali ang code na iyan.', 'यो कोड मिलेन।', 'এই কোডটি সঠিক নয়।'],
  sqErrFull: ['That squad is full.', 'هذا الفريق مكتمل.', 'Cette équipe est complète.', 'Ese equipo está completo.', 'Essa equipa está cheia.', 'یہ اسکواڈ بھر چکا ہے۔', 'यह स्क्वाड भर चुका है।', 'Puno na ang squad na iyan.', 'यो स्क्वाड भरिएको छ।', 'এই স্কোয়াড পূর্ণ।'],
  phPost: ['Post a photo', 'انشر صورة', 'Publier une photo', 'Publicar una foto', 'Publicar uma foto', 'تصویر پوسٹ کریں', 'फ़ोटो पोस्ट करें', 'Mag-post ng larawan', 'फोटो पोस्ट गर्नुहोस्', 'ছবি পোস্ট করুন'],
  phFile: ['Choose a photo', 'اختر صورة', 'Choisir une photo', 'Elegir una foto', 'Escolher uma foto', 'تصویر چنیں', 'फ़ोटो चुनें', 'Pumili ng larawan', 'फोटो छान्नुहोस्', 'ছবি বেছে নিন'],
  phCaption: ['Caption (optional)', 'تعليق (اختياري)', 'Légende (facultatif)', 'Pie de foto (opcional)', 'Legenda (opcional)', 'عنوان (اختیاری)', 'कैप्शन (वैकल्पिक)', 'Caption (opsyonal)', 'क्याप्सन (ऐच्छिक)', 'ক্যাপশন (ঐচ্ছিক)'],
  phAck: ['Everyone in this photo agreed to it being shared with community members.', 'وافق كل من في هذه الصورة على مشاركتها مع أعضاء المجتمع.', 'Toutes les personnes sur cette photo acceptent qu’elle soit partagée avec les membres.', 'Todas las personas de esta foto aceptan compartirla con los miembros.', 'Todas as pessoas nesta foto aceitam que seja partilhada com os membros.', 'اس تصویر میں موجود سب لوگ اسے کمیونٹی ارکان سے شیئر کرنے پر راضی ہیں۔', 'इस फ़ोटो में मौजूद सभी लोग इसे समुदाय के सदस्यों से साझा करने पर सहमत हैं।', 'Pumayag ang lahat ng nasa larawan na ibahagi ito sa mga miyembro.', 'यो फोटोमा भएका सबै जना समुदायका सदस्यसँग साझा गर्न सहमत छन्।', 'এই ছবির সবাই কমিউনিটির সদস্যদের সাথে এটি শেয়ার করতে সম্মত।'],
  phAckReq: ['Please choose a photo and tick the box first.', 'يرجى اختيار صورة وتحديد المربع أولًا.', 'Choisissez une photo et cochez la case.', 'Elige una foto y marca la casilla.', 'Escolha uma foto e marque a caixa.', 'پہلے تصویر چنیں اور خانے پر نشان لگائیں۔', 'पहले फ़ोटो चुनें और बॉक्स पर निशान लगाएँ।', 'Pumili muna ng larawan at lagyan ng tsek ang kahon.', 'पहिले फोटो छानेर बाकसमा चिन्ह लगाउनुहोस्।', 'আগে ছবি বেছে নিয়ে বক্সে টিক দিন।'],
  phWait: ['Our staff check every photo first. Yours waiting: {0}', 'يراجع فريقنا كل صورة أولًا. صورك المنتظرة: {0}', 'Notre équipe vérifie chaque photo. Les vôtres en attente : {0}', 'Nuestro equipo revisa cada foto. Tus fotos en espera: {0}', 'A nossa equipa verifica cada foto. As suas em espera: {0}', 'ہمارا عملہ ہر تصویر پہلے دیکھتا ہے۔ آپ کی زیر انتظار: {0}', 'हमारा स्टाफ़ हर फ़ोटो पहले जाँचता है। आपकी प्रतीक्षा में: {0}', 'Sinusuri muna ng staff ang bawat larawan. Naghihintay na sa iyo: {0}', 'हाम्रा कर्मचारीले हरेक फोटो पहिले जाँच्छन्। तपाईंका पर्खाइमा: {0}', 'আমাদের স্টাফ প্রতিটি ছবি আগে দেখেন। আপনার অপেক্ষমাণ: {0}'],
  phLimit: ['You have reached the limit for now. Please try again tomorrow.', 'بلغت الحد المسموح حاليًا. يرجى المحاولة غدًا.', 'Limite atteinte pour le moment. Réessayez demain.', 'Has llegado al límite por ahora. Inténtalo mañana.', 'Atingiu o limite por agora. Tente amanhã.', 'ابھی حد پوری ہو گئی۔ کل دوبارہ کوشش کریں۔', 'अभी सीमा पूरी हो गई। कल फिर कोशिश करें।', 'Naabot mo na ang limit sa ngayon. Subukan bukas.', 'अहिलेलाई सीमा पुग्यो। भोलि प्रयास गर्नुहोस्।', 'আপাতত সীমা পূর্ণ। আগামীকাল চেষ্টা করুন।'],
  phNone: ['No photos yet.', 'لا توجد صور بعد.', 'Pas encore de photos.', 'Aún no hay fotos.', 'Ainda não há fotos.', 'ابھی کوئی تصویر نہیں۔', 'अभी कोई फ़ोटो नहीं।', 'Wala pang larawan.', 'अहिले कुनै फोटो छैन।', 'এখনও কোনো ছবি নেই।'],
  phClap: ['Applaud', 'تصفيق', 'Applaudir', 'Aplaudir', 'Aplaudir', 'تالی', 'तालियाँ', 'Palakpak', 'ताली', 'হাততালি'],
  phRemove: ['Ask to take down', 'اطلب الإزالة', 'Demander le retrait', 'Pedir que se retire', 'Pedir remoção', 'ہٹانے کی درخواست', 'हटाने का अनुरोध', 'Hilinging alisin', 'हटाउन अनुरोध', 'সরানোর অনুরোধ'],
  phDelete: ['Delete my photo', 'احذف صورتي', 'Supprimer ma photo', 'Eliminar mi foto', 'Eliminar a minha foto', 'میری تصویر حذف کریں', 'मेरी फ़ोटो हटाएँ', 'Burahin ang larawan ko', 'मेरो फोटो मेट्नुहोस्', 'আমার ছবি মুছুন'],
  more: ['Show more', 'عرض المزيد', 'Afficher plus', 'Mostrar más', 'Mostrar mais', 'مزید دکھائیں', 'और दिखाएँ', 'Ipakita pa', 'थप देखाउनुहोस्', 'আরও দেখান'],
  yrTitle: ['Your {0} with MicroMobility', 'عامك {0} مع مايكروموبيليتي', 'Votre année {0} avec MicroMobility', 'Tu {0} con MicroMobility', 'O seu {0} com a MicroMobility', 'MicroMobility کے ساتھ آپ کا {0}', 'MicroMobility के साथ आपका {0}', 'Ang {0} mo kasama ang MicroMobility', 'MicroMobility सँग तपाईंको {0}', 'MicroMobility-র সাথে আপনার {0}'],
  yrSessions: ['Sessions', 'الأنشطة', 'Sessions', 'Sesiones', 'Sessões', 'سیشن', 'सत्र', 'Mga session', 'सत्र', 'সেশন'],
  yrSat: ['Saturday rides', 'رحلات السبت', 'Sorties du samedi', 'Salidas de sábado', 'Passeios de sábado', 'ہفتے کی سواریاں', 'शनिवार राइड', 'Saturday ride', 'शनिबारे राइड', 'শনিবারের রাইড'],
  yrKinds: ['Kinds of event', 'أنواع الفعاليات', 'Types d’événements', 'Tipos de evento', 'Tipos de evento', 'تقریبات کی اقسام', 'कार्यक्रमों के प्रकार', 'Uri ng event', 'कार्यक्रमका प्रकार', 'ইভেন্টের ধরন'],
  yrKudos: ['Kudos received', 'التقدير المستلم', 'Bravos reçus', 'Aplausos recibidos', 'Aplausos recebidos', 'ملی داد', 'मिली शाबाशी', 'Natanggap na kudos', 'पाएको स्याबासी', 'পাওয়া বাহবা'],
  yrBadges: ['Badges from our staff', 'شارات من فريقنا', 'Badges de notre équipe', 'Insignias de nuestro equipo', 'Emblemas da nossa equipa', 'ہمارے عملے کے بیج', 'हमारे स्टाफ़ के बैज', 'Mga badge mula sa staff', 'हाम्रा कर्मचारीका ब्याज', 'আমাদের স্টাফের ব্যাজ'],
  yrFirst: ['First of the year: {0}', 'الأول هذا العام: {0}', 'Première de l’année : {0}', 'La primera del año: {0}', 'A primeira do ano: {0}', 'سال کا پہلا: {0}', 'साल का पहला: {0}', 'Una sa taon: {0}', 'वर्षको पहिलो: {0}', 'বছরের প্রথম: {0}'],
  yrShare: ['Share my year', 'شارك عامي', 'Partager mon année', 'Compartir mi año', 'Partilhar o meu ano', 'میرا سال شیئر کریں', 'मेरा साल साझा करें', 'Ibahagi ang taon ko', 'मेरो वर्ष साझा गर्नुहोस्', 'আমার বছর শেয়ার করুন'],
  yrShareMsg: ['My {0} with MicroMobility: {1} sessions, {2} Saturday rides, {3} kudos.', 'عامي {0} مع مايكروموبيليتي: {1} نشاط، {2} رحلة سبت، {3} تقدير.', 'Mon année {0} avec MicroMobility : {1} sessions, {2} sorties du samedi, {3} bravos.', 'Mi {0} con MicroMobility: {1} sesiones, {2} salidas de sábado, {3} aplausos.', 'O meu {0} com a MicroMobility: {1} sessões, {2} passeios de sábado, {3} aplausos.', 'MicroMobility کے ساتھ میرا {0}: {1} سیشن، ہفتے کی {2} سواریاں، {3} داد۔', 'MicroMobility के साथ मेरा {0}: {1} सत्र, {2} शनिवार राइड, {3} शाबाशी।', 'Ang {0} ko kasama ang MicroMobility: {1} session, {2} Saturday ride, {3} kudos.', 'MicroMobility सँग मेरो {0}: {1} सत्र, {2} शनिबारे राइड, {3} स्याबासी।', 'MicroMobility-র সাথে আমার {0}: {1}টি সেশন, {2}টি শনিবারের রাইড, {3}টি বাহবা।'],
};
function _hT(k) {
  const row = HUB_T[k] || [''], i = HUB_LANGS.indexOf(S.lang);
  return row[i < 0 ? 0 : i] || row[0];
}
function _hF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _hT(k)); }
function _hPick(x, en, ar) { return String((x && ((S.lang === 'ar' && x[ar]) || x[en])) || ''); }
function _hCust() { return S.loggedIn || getSession(); }
function _hDate(d) { const s = String(d || '').slice(0, 10); return /^\d{4}-\d\d-\d\d$/.test(s) ? shortDate(s) : ''; }
function _hTok(c) { return { p_id: c.id, p_token: c.session_token }; }

// The overview: read when the page opens and after a change, kept two minutes otherwise.
async function _hubFetch(force) {
  const c = _hCust(); if (!c || !sb || S._hubBusy) return;
  const h = S._hub;
  if (!force && h && h.forId === c.id && h.d && Date.now() - h.at < 12e4) return;
  S._hubBusy = true;
  let r; try { r = await sb.rpc('hub_overview', _hTok(c)); } catch (e) { r = { error: e }; }
  S._hubBusy = false;
  const d = r && !r.error && r.data && r.data.ok === true ? r.data : null;
  S._hub = { forId: c.id, at: Date.now(), d };
  if (S.custTab === 'members') _hubRender();
}
const _HUB_TABS = ['list', 'kudos', 'vote', 'goals', 'squads', 'photos', 'year'];
function _hubTab(k) {
  S._hubTab = _HUB_TABS.includes(k) ? k : 'list';
  if (S._hubTab === 'photos' && !S._hubPh) _phLoad();
  _hubRender();
}
function _hubRender() {
  const nav = document.getElementById('hub-nav'), main = document.getElementById('mb-main'), body = document.getElementById('hub-body'), top = document.getElementById('hub-top');
  if (!nav || !main || !body) return;
  const h = S._hub, d = h && h.d;
  if (!h) _hubFetch();
  const tab = S._hubTab || 'list', tabs = _HUB_TABS.filter((k) => k !== 'year' || (d && d.year && Number(d.year.rides) > 0));
  nav.innerHTML = tabs.map((k) => `<button type="button" class="hub-tab${k === tab ? ' on' : ''}" aria-pressed="${k === tab}" data-on-click="${_on('_hubTab', k)}">${_hT('tab' + k[0].toUpperCase() + k.slice(1))}</button>`).join('');
  if (top) top.innerHTML = d && tab === 'list' ? [d.buddy ? _hF('buddy', esc(d.buddy)) : '', d.welcoming && d.welcoming.length ? _hF('welcoming', d.welcoming.map(esc).join(', ')) : ''].filter(Boolean).map((x) => `<div class="hub-note">${x}</div>`).join('') : '';
  main.hidden = tab !== 'list'; body.hidden = tab === 'list';
  if (tab === 'list') return;
  if (tab !== 'photos' && !d) {
    body.innerHTML = h ? `<div class="am-meta">${_hT('err')}</div><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_hubRetry')}">${_hT('retry')}</button>` : `<div class="am-meta">${_hT('loading')}</div>`;
    return;
  }
  const keep = document.activeElement && document.activeElement.id;
  body.innerHTML = tab === 'kudos' ? _kuHtml(d) : tab === 'vote' ? _voHtml(d) : tab === 'goals' ? _goHtml(d) : tab === 'squads' ? _sqHtml(d) : tab === 'photos' ? _phHtml() : _yrHtml(d);
  if (keep) { const el = document.getElementById(keep); if (el && el !== document.activeElement) try { el.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  if (tab === 'photos') _phImgs();
}
function _hubRetry() { S._hub = null; _hubRender(); _hubFetch(true); }
async function _hubCall(fn, args, errs) {
  const c = _hCust(); if (!c) return false;
  let r; try { r = await sb.rpc(fn, { ..._hTok(c), ...args }); } catch (e) { r = { error: e }; }
  if (r && !r.error && r.data && r.data.ok === true) return true;
  const code = r && r.data && r.data.error;
  toast(_hT((errs && errs[code]) || 'err'), 'error');
  return false;
}

// ── Kudos ──────────────────────────────────────────────────────────────
function _kuHtml(d) {
  const t = d.together, ppl = t && Array.isArray(t.people) ? t.people : [];
  return `<div class="hub-big">${_hF('kudosGot', Number(d.kudos_got) || 0)}</div>
    ${ppl.length ? `<h2 class="hub-h">${_hF('kudosFrom', _hDate(t.date))}</h2>${ppl.map((p) => `<div class="hub-row"><span><bdi>${esc(p.name)}</bdi></span>
      ${p.given ? `<span class="am-meta hub-given">${_hT('kudosGiven')}</span>` : `<button type="button" class="btn-secondary hub-act" data-on-click="${_on('_kuGive', t.session, p.ref)}">${_hT('kudosGive')}</button>`}</div>`).join('')}`
    : `<div class="am-meta">${_hT('kudosNone')}</div>`}`;
}
async function _kuGive(sess, ref) {
  if (S._hubWorking) return; S._hubWorking = true;
  const ok = await _hubCall('hub_kudos', { p_session: sess, p_ref: ref });
  S._hubWorking = false;
  if (!ok) return;
  const t = S._hub && S._hub.d && S._hub.d.together, p = t && t.people.find((x) => x.ref === ref);
  if (p) p.given = true;
  if (S._mb) S._mb.at = 0; // the list's counts: read again next time
  _hubRender();
}

// ── Rider of the Month ─────────────────────────────────────────────────
function _voHtml(d) {
  const r = d.round, w = d.last_winner;
  const won = w ? `<div class="hub-note">${_hF('winner', esc(_hPick(w, 'label', 'label_ar')), `<strong><bdi>${esc(w.name || '')}</bdi></strong>`)}</div>` : '';
  if (!r) return won + `<div class="am-meta">${_hT('voteNone')}</div>`;
  const q = String(S._voQ || '').trim().toLowerCase(), rows = (S._mb && S._mb.rows || []).filter((m) => !m.me && m.ref && (!q || String(m.name || '').toLowerCase().includes(q) || m.ref === r.mine));
  rows.sort((a, b) => (b.ref === r.mine) - (a.ref === r.mine));
  return won + `<h2 class="hub-h">${_hF('voteAsk', esc(_hPick(r, 'label', 'label_ar')))}</h2><div class="am-meta">${_hF('voteUntil', _hDate(r.closes_on))}</div>
    <input id="vo-q" type="search" class="search-input mb-q" aria-label="${esc(_hT('search'))}" placeholder="${esc(_hT('search'))}" value="${esc(S._voQ || '')}" data-on-input="${_on('_voQ', _P('value'))}">
    <div id="vo-rows">${rows.slice(0, 30).map((m) => `<div class="hub-row"><span><bdi>${esc(m.name)}</bdi></span>
      ${m.ref === r.mine ? `<span class="am-meta hub-given">${_hT('voteMine')}</span>` : `<button type="button" class="btn-secondary hub-act" data-on-click="${_on('_voCast', r.id, m.ref)}">${_hT('voteFor')}</button>`}</div>`).join('')}</div>`;
}
function _voQ(v) { S._voQ = v; const d = S._hub && S._hub.d; if (d) _hubRender(); }
async function _voCast(id, ref) {
  if (S._hubWorking) return; S._hubWorking = true;
  const ok = await _hubCall('hub_vote', { p_round: id, p_ref: ref });
  S._hubWorking = false;
  if (!ok) return;
  S._hub.d.round.mine = ref; _hubRender();
}

// ── Challenges and the community goal ──────────────────────────────────
function _goHtml(d) {
  const list = Array.isArray(d.goals) ? d.goals : [];
  if (!list.length) return `<div class="am-meta">${_hT('goalsNone')}</div>`;
  return list.map((g) => {
    const n = Number(g.progress) || 0, tg = Number(g.target) || 1, pct = Math.min(100, Math.round(n / tg * 100)), rw = _hPick(g, 'reward', 'reward_ar');
    return `<div class="hub-card"><div class="am-meta">${_hT(g.kind === 'goal' ? 'goalAll' : 'goalYou')}</div>
      <strong class="hub-name"><bdi>${esc(_hPick(g, 'name', 'name_ar'))}</bdi></strong>
      <div class="hub-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${tg}" aria-valuenow="${Math.min(n, tg)}" aria-label="${esc(_hPick(g, 'name', 'name_ar'))}"><span data-cssv="${_cssv({ '--w': pct + '%' })}"></span></div>
      <div class="am-meta">${n >= tg ? _hT('goalDone') + ' · ' : ''}${_hF('goalOf', n, tg, _hDate(g.ends_on))}</div>
      ${rw ? `<div class="am-meta">${_hF('reward', esc(rw))}</div>` : ''}</div>`;
  }).join('');
}

// ── Squads ─────────────────────────────────────────────────────────────
const _SQ_ERR = { name: 'sqErrName', taken: 'sqErrTaken', code: 'sqErrCode', full: 'sqErrFull' };
function _sqHtml(d) {
  const s = d.squad, board = Array.isArray(d.board) ? d.board : [];
  const mine = s ? `<div class="hub-card"><strong class="hub-name"><bdi>${esc(s.name)}</bdi></strong>
      <div class="am-meta">${_hT('sqCode')}: <strong dir="ltr">${esc(s.code)}</strong></div>
      <div class="am-meta">${(s.members || []).map(esc).join(', ')}</div>
      <button type="button" class="btn-primary hub-wide" data-on-click="${_on('_sqShare')}">${_hT('sqShare')}</button>
      <button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_sqLeave')}">${S._sqSure ? _hT('sure') : _hT('sqLeave')}</button></div>`
    : `<div class="hub-card"><label class="hub-lbl" for="sq-name">${_hT('sqName')}</label><input id="sq-name" type="text" maxlength="30" class="search-input hub-input">
        <button type="button" class="btn-primary hub-wide" data-on-click="${_on('_sqMake')}">${_hT('sqMake')}</button>
        <label class="hub-lbl" for="sq-code">${_hT('sqCode')}</label><input id="sq-code" type="text" maxlength="6" dir="ltr" autocapitalize="characters" class="search-input hub-input">
        <button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_sqJoin')}">${_hT('sqJoin')}</button></div>`;
  return mine + (board.length ? `<h2 class="hub-h">${_hT('sqBoard')}</h2>${board.map((b, i) => `<div class="hub-row${b.mine ? ' on' : ''}"><span>${i + 1}. <bdi>${esc(b.name)}</bdi></span><span class="am-meta">${_hF('sqRow', Number(b.members) || 0, Number(b.rides) || 0)}</span></div>`).join('')}` : '');
}
async function _sqAfter(ok) { S._sqSure = false; if (ok) { await _hubFetch(true); } _hubRender(); }
async function _sqMake() {
  const el = document.getElementById('sq-name'), v = el ? el.value : '';
  await _sqAfter(await _hubCall('hub_squad_create', { p_name: v }, _SQ_ERR));
}
async function _sqJoin() {
  const el = document.getElementById('sq-code'), v = el ? el.value : '';
  await _sqAfter(await _hubCall('hub_squad_join', { p_code: v }, _SQ_ERR));
}
async function _sqLeave() {
  if (!S._sqSure) { S._sqSure = true; _hubRender(); return; }
  await _sqAfter(await _hubCall('hub_squad_leave', {}));
}
async function _hShare(text) {
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
}
function _sqShare() { const s = S._hub && S._hub.d && S._hub.d.squad; if (s) _hShare(_hF('sqShareMsg', s.name, s.code)); }

// ── The photo wall ─────────────────────────────────────────────────────
// The list carries no pictures: each is asked for by itself, one at a time, and kept for the visit.
async function _phLoad(more) {
  const c = _hCust(); if (!c || S._phBusy) return;
  S._phBusy = true;
  const list = S._hubPh && S._hubPh.photos || [], before = more && list.length ? list[list.length - 1].at : null;
  let r; try { r = await sb.rpc('hub_photos_list', { ..._hTok(c), p_before: before }); } catch (e) { r = { error: e }; }
  S._phBusy = false;
  const d = r && !r.error && r.data && r.data.ok === true ? r.data : null;
  if (d) S._hubPh = { pending: Number(d.pending) || 0, photos: more ? [...list, ...d.photos] : d.photos, end: d.photos.length < 12 };
  else if (!S._hubPh) S._hubPh = { err: true, photos: [] };
  if (S.custTab === 'members' && S._hubTab === 'photos') _hubRender();
}
async function _phImgs() {
  const c = _hCust(), p = S._hubPh; if (!c || !p || S._phImgBusy) return;
  S._phImgBusy = true; S._phImg = S._phImg || {};
  for (const x of p.photos) {
    if (x.id in S._phImg) { _phImgPut(x.id); continue; }
    let r; try { r = await sb.rpc('hub_photo_img', { ..._hTok(c), p_photo: x.id }); } catch (e) { r = { error: e }; }
    const u = r && !r.error && typeof r.data === 'string' && r.data.startsWith('data:image/jpeg;') ? r.data : '';
    if (u) S._phImg[x.id] = u;
    _phImgPut(x.id);
    if (S._hubTab !== 'photos') break;
  }
  S._phImgBusy = false;
}
function _phImgPut(id) {
  const u = S._phImg && S._phImg[id], el = u && document.querySelector(`img[data-ph="${CSS.escape(id)}"]`);
  if (el && !el.src) el.src = u;
}
function _phHtml() {
  const p = S._hubPh;
  if (!p) return `<div class="am-meta">${_hT('loading')}</div>`;
  if (p.err) return `<div class="am-meta">${_hT('err')}</div><button type="button" class="btn-primary hub-wide" data-on-click="${_on('_phRetry')}">${_hT('retry')}</button>`;
  const form = `<div class="hub-card"><label class="hub-lbl" for="ph-file">${_hT('phFile')}</label><input id="ph-file" type="file" accept="image/*">
      <label class="hub-lbl" for="ph-cap">${_hT('phCaption')}</label><input id="ph-cap" type="text" maxlength="140" class="search-input hub-input">
      <label class="tt-hide"><input type="checkbox" id="ph-ack"><span>${_hT('phAck')}</span></label>
      <button type="button" class="btn-primary hub-wide" data-on-click="${_on('_phPost')}">${_hT('phPost')}</button>
      <div class="am-meta">${_hF('phWait', p.pending || 0)}</div></div>`;
  const wall = p.photos.map((x) => `<figure class="hub-photo"><img data-ph="${esc(x.id)}" alt="${esc(x.caption || '')}">
      <figcaption>${x.caption ? `<div><bdi>${esc(x.caption)}</bdi></div>` : ''}${x.by ? `<div class="am-meta"><bdi>${esc(x.by)}</bdi></div>` : ''}
      <div class="hub-photo-acts"><button type="button" class="btn-secondary hub-act${x.reacted ? ' on' : ''}" aria-pressed="${!!x.reacted}" data-on-click="${_on('_phClap', x.id)}">${_hT('phClap')} ${Number(x.reacts) || 0}</button>
      ${x.mine ? `<button type="button" class="btn-secondary hub-act" data-on-click="${_on('_phDel', x.id)}">${S._phSure === x.id ? _hT('sure') : _hT('phDelete')}</button>`
    : `<button type="button" class="btn-secondary hub-act" data-on-click="${_on('_phReport', x.id)}">${S._phSure === x.id ? _hT('sure') : _hT('phRemove')}</button>`}</div></figcaption></figure>`).join('');
  return form + (wall || `<div class="am-meta">${_hT('phNone')}</div>`) + (p.photos.length && !p.end ? `<button type="button" class="btn-secondary hub-wide" data-on-click="${_on('_phMore')}">${_hT('more')}</button>` : '');
}
function _phRetry() { S._hubPh = null; _hubRender(); _phLoad(); }
function _phMore() { _phLoad(true); }
// A small JPEG, at most 1000 px, under the 200,000 characters the database takes.
function _phShrink(file) {
  return new Promise((ok, no) => {
    const u = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      URL.revokeObjectURL(u);
      let w = im.naturalWidth, h = im.naturalHeight, side = 1000, q = 0.72, out = '';
      for (let i = 0; i < 8; i++) {
        const k = Math.min(1, side / Math.max(w, h)), cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w * k)); cv.height = Math.max(1, Math.round(h * k));
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        out = cv.toDataURL('image/jpeg', q);
        if (out.length < 190000) return ok(out);
        if (q > 0.5) q -= 0.1; else side = Math.round(side * 0.8);
      }
      no(new Error('too big'));
    };
    im.onerror = () => { URL.revokeObjectURL(u); no(new Error('not an image')); };
    im.src = u;
  });
}
async function _phPost() {
  const f = document.getElementById('ph-file'), cap = document.getElementById('ph-cap'), ack = document.getElementById('ph-ack'), file = f && f.files && f.files[0];
  if (!file || !ack || !ack.checked) { toast(_hT('phAckReq'), 'error'); return; }
  if (S._hubWorking) return; S._hubWorking = true;
  let img = ''; try { img = await _phShrink(file); } catch (e) { S._hubWorking = false; toast(_hT('err'), 'error'); return; }
  const ok = await _hubCall('hub_photo_post', { p_img: img, p_caption: cap ? cap.value : '', p_ack: true }, { limit: 'phLimit' });
  S._hubWorking = false;
  if (!ok) return;
  S._hubPh.pending = (S._hubPh.pending || 0) + 1; _hubRender();
}
async function _phClap(id) {
  const p = S._hubPh, x = p && p.photos.find((y) => y.id === id); if (!x) return;
  const on = !x.reacted, ok = await _hubCall('hub_photo_react', { p_photo: id, p_on: on });
  if (!ok) return;
  x.reacted = on; x.reacts = Math.max(0, (Number(x.reacts) || 0) + (on ? 1 : -1)); _hubRender();
}
async function _phOff(fn, id, args) {
  if (S._phSure !== id) { S._phSure = id; _hubRender(); return; }
  S._phSure = null;
  const ok = await _hubCall(fn, { p_photo: id, ...args });
  if (ok) S._hubPh.photos = S._hubPh.photos.filter((y) => y.id !== id);
  _hubRender();
}
function _phReport(id) { return _phOff('hub_photo_report', id, { p_reason: '' }); }
function _phDel(id) { return _phOff('hub_photo_delete', id, {}); }

// ── The year in review (December and January) ──────────────────────────
function _yrHtml(d) {
  const y = d.year; if (!y) return '';
  const st = (k, v) => `<div class="hub-stat"><strong>${Number(v) || 0}</strong><span>${_hT(k)}</span></div>`;
  return `<div class="hub-card"><h2 class="hub-h">${_hF('yrTitle', y.year)}</h2><div class="hub-stats">${st('yrSessions', y.rides)}${st('yrSat', y.saturdays)}${st('yrKinds', y.kinds)}${st('yrKudos', y.kudos)}${st('yrBadges', y.badges)}</div>
    ${y.first ? `<div class="am-meta">${_hF('yrFirst', _hDate(y.first))}</div>` : ''}
    <button type="button" class="btn-primary hub-wide" data-on-click="${_on('_yrShare')}">${_hT('yrShare')}</button></div>`;
}
function _yrShare() { const y = S._hub && S._hub.d && S._hub.d.year; if (y) _hShare(_hF('yrShareMsg', y.year, Number(y.rides) || 0, Number(y.saturdays) || 0, Number(y.kudos) || 0)); }
