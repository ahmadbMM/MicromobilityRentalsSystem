// The distance leaderboards (the user, 2026-11-27: a leaderboard of the longest single ride with badges that move to whoever
// rides further, shared on social media; then "add a leaderboard for distance lifetime and distance year to date and let
// customers apply to it manually by add image or pdf that proves it and staff approves it"). Migration 20261127180000.
//
// Riders: the page opened from the Community tab's Leaderboard part and from /leaderboard (a link anyone may open, signed
// in or not). Four boards (Longest ride, This month, Lifetime, This year), men and women apart; only members are ranked,
// and a row shows a name only for a rider who switched it on (customers.board_public; "Member" otherwise). The signed-in
// rider sees their own place, the switch, Share (the picture is drawn by badge-share.js, kind 'dist') and Add a distance:
// one ride, or a total over dates, with a picture or a PDF as proof, for staff to approve. Nothing about anyone else but
// the place, the distance and an opted-in name; no count of riders.
// Staff: the Distance leaderboards section under Analytics > Leaderboard (_dbdStaff): the boards with full names, the
// claims waiting (proof, the km to count, a reply, Approve / Decline), Add a distance for an account, the entries with
// Remove. Gold, Silver and Bronze (lr_gold / lr_silver / lr_bronze) follow the database (_lr_podium_sync).
// A file of its own, fetched on the first open (_dbdLoad in app.src.html), with its own words in all eleven languages.
// Hand-written, not generated; the build stamps its address (DBD_V).
/* global S, sb, esc, _on, _P, toast, getSession, _locale, _bdgMedal, _bdgDay, _cuIc, _shrLoad, todayStr */
const DBD_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms'];
const DBD_T = {
  title: ['Leaderboards', 'لوحات المتصدرين', 'Classements', 'Clasificaciones', 'Classificações', 'لیڈر بورڈز', 'लीडरबोर्ड', 'Mga Leaderboard', 'लिडरबोर्ड', 'লিডারবোর্ড', 'Papan Pendahulu'],
  longest: ['Longest ride', 'أطول رحلة', 'Plus longue sortie', 'Ruta más larga', 'Pedalada mais longa', 'سب سے لمبی سواری', 'सबसे लंबी सवारी', 'Pinakamahabang biyahe', 'सबैभन्दा लामो सवारी', 'দীর্ঘতম রাইড', 'Kayuhan terpanjang'],
  month: ['This month', 'هذا الشهر', 'Ce mois-ci', 'Este mes', 'Este mês', 'اس مہینے', 'इस महीने', 'Ngayong buwan', 'यो महिना', 'এই মাসে', 'Bulan ini'],
  lifetime: ['Lifetime', 'كل الأوقات', 'Depuis le début', 'Total', 'Total', 'اب تک', 'अब तक', 'Kabuuan', 'अहिलेसम्म', 'সর্বমোট', 'Sepanjang masa'],
  year: ['This year', 'هذا العام', 'Cette année', 'Este año', 'Este ano', 'اس سال', 'इस साल', 'Ngayong taon', 'यो वर्ष', 'এই বছর', 'Tahun ini'],
  monthP: ['Longest ride this month', 'أطول رحلة هذا الشهر', 'Plus longue sortie du mois', 'Ruta más larga del mes', 'Pedalada mais longa do mês', 'اس مہینے کی سب سے لمبی سواری', 'इस महीने की सबसे लंबी सवारी', 'Pinakamahabang biyahe ngayong buwan', 'यो महिनाको सबैभन्दा लामो सवारी', 'এই মাসের দীর্ঘতম রাইড', 'Kayuhan terpanjang bulan ini'],
  lifetimeP: ['Kilometres ridden', 'الكيلومترات المقطوعة', 'Kilomètres parcourus', 'Kilómetros recorridos', 'Quilómetros percorridos', 'طے کیے گئے کلومیٹر', 'तय किए गए किलोमीटर', 'Kilometrong nabiyahe', 'पार गरिएका किलोमिटर', 'চালানো কিলোমিটার', 'Kilometer dikayuh'],
  yearP: ['Kilometres this year', 'كيلومترات هذا العام', 'Kilomètres cette année', 'Kilómetros este año', 'Quilómetros este ano', 'اس سال کے کلومیٹر', 'इस साल के किलोमीटर', 'Kilometro ngayong taon', 'यो वर्षका किलोमिटर', 'এই বছরের কিলোমিটার', 'Kilometer tahun ini'],
  men: ['Men', 'الرجال', 'Hommes', 'Hombres', 'Homens', 'مرد', 'पुरुष', 'Lalaki', 'पुरुष', 'পুরুষ', 'Lelaki'],
  women: ['Women', 'النساء', 'Femmes', 'Mujeres', 'Mulheres', 'خواتین', 'महिलाएँ', 'Babae', 'महिला', 'নারী', 'Wanita'],
  you: ['You', 'أنت', 'Vous', 'Tú', 'Você', 'آپ', 'आप', 'Ikaw', 'तपाईं', 'আপনি', 'Anda'],
  member: ['Member', 'عضو', 'Membre', 'Miembro', 'Membro', 'رکن', 'सदस्य', 'Miyembro', 'सदस्य', 'সদস্য', 'Ahli'],
  km: ['{0} km', '{0} كم', '{0} km', '{0} km', '{0} km', '{0} کلومیٹر', '{0} किमी', '{0} km', '{0} किमी', '{0} কিমি', '{0} km'],
  onlyMembers: ['Only community members are ranked.', 'يُرتَّب أعضاء المجتمع فقط.', 'Seuls les membres de la communauté sont classés.', 'Solo se clasifica a los miembros de la comunidad.', 'Só os membros da comunidade são classificados.', 'صرف کمیونٹی کے اراکین کی درجہ بندی ہوتی ہے۔', 'केवल कम्युनिटी के सदस्यों की रैंकिंग होती है।', 'Mga miyembro lang ng komunidad ang nira-rank.', 'समुदायका सदस्यहरूको मात्र स्थान तोकिन्छ।', 'শুধু কমিউনিটির সদস্যদের র‍্যাঙ্ক করা হয়।', 'Hanya ahli komuniti yang disenaraikan.'],
  nameSw: ['Show my name on the leaderboards', 'إظهار اسمي في لوحات المتصدرين', 'Afficher mon nom dans les classements', 'Mostrar mi nombre en las clasificaciones', 'Mostrar o meu nome nas classificações', 'لیڈر بورڈز پر میرا نام دکھائیں', 'लीडरबोर्ड पर मेरा नाम दिखाएँ', 'Ipakita ang pangalan ko sa mga leaderboard', 'लिडरबोर्डमा मेरो नाम देखाउनुहोस्', 'লিডারবোর্ডে আমার নাম দেখান', 'Tunjukkan nama saya di papan pendahulu'],
  nameSwSub: ['Your first name and the first letter of your last name', 'اسمك الأول وأول حرف من اسم عائلتك', 'Votre prénom et l’initiale de votre nom', 'Tu nombre y la inicial de tu apellido', 'O seu primeiro nome e a inicial do apelido', 'آپ کا پہلا نام اور آخری نام کا پہلا حرف', 'आपका पहला नाम और उपनाम का पहला अक्षर', 'Ang unang pangalan mo at unang titik ng apelyido', 'तपाईंको पहिलो नाम र थरको पहिलो अक्षर', 'আপনার প্রথম নাম ও পদবির প্রথম অক্ষর', 'Nama pertama dan huruf pertama nama akhir anda'],
  add: ['Add a distance', 'إضافة مسافة', 'Ajouter une distance', 'Añadir una distancia', 'Adicionar uma distância', 'فاصلہ شامل کریں', 'दूरी जोड़ें', 'Magdagdag ng distansya', 'दूरी थप्नुहोस्', 'দূরত্ব যোগ করুন', 'Tambah jarak'],
  kRide: ['One ride', 'رحلة واحدة', 'Une sortie', 'Una ruta', 'Uma pedalada', 'ایک سواری', 'एक सवारी', 'Isang biyahe', 'एउटा सवारी', 'একটি রাইড', 'Satu kayuhan'],
  kTotal: ['A total over dates', 'مجموع خلال فترة', 'Un total sur une période', 'Un total en un periodo', 'Um total num período', 'مدت کا کل فاصلہ', 'एक अवधि का कुल', 'Kabuuan sa mga petsa', 'अवधिको जम्मा', 'একটি সময়ের মোট', 'Jumlah dalam tempoh'],
  cKm: ['Distance (km)', 'المسافة (كم)', 'Distance (km)', 'Distancia (km)', 'Distância (km)', 'فاصلہ (کلومیٹر)', 'दूरी (किमी)', 'Distansya (km)', 'दूरी (किमी)', 'দূরত্ব (কিমি)', 'Jarak (km)'],
  cDay: ['Day of the ride', 'يوم الرحلة', 'Jour de la sortie', 'Día de la ruta', 'Dia da pedalada', 'سواری کا دن', 'सवारी का दिन', 'Araw ng biyahe', 'सवारीको दिन', 'রাইডের দিন', 'Hari kayuhan'],
  cFrom: ['From', 'من', 'Du', 'Desde', 'De', 'سے', 'से', 'Mula', 'देखि', 'থেকে', 'Dari'],
  cTo: ['To', 'إلى', 'Au', 'Hasta', 'Até', 'تک', 'तक', 'Hanggang', 'सम्म', 'পর্যন্ত', 'Hingga'],
  cNote: ['Comment (optional)', 'تعليق (اختياري)', 'Commentaire (facultatif)', 'Comentario (opcional)', 'Comentário (opcional)', 'تبصرہ (اختیاری)', 'टिप्पणी (वैकल्पिक)', 'Komento (opsyonal)', 'टिप्पणी (ऐच्छिक)', 'মন্তব্য (ঐচ্ছিক)', 'Komen (pilihan)'],
  cProof: ['Proof: a picture or a PDF', 'الإثبات: صورة أو ملف PDF', 'Preuve : une image ou un PDF', 'Prueba: una imagen o un PDF', 'Prova: uma imagem ou um PDF', 'ثبوت: تصویر یا PDF', 'प्रमाण: चित्र या PDF', 'Patunay: larawan o PDF', 'प्रमाण: तस्बिर वा PDF', 'প্রমাণ: ছবি বা PDF', 'Bukti: gambar atau PDF'],
  cPick: ['Choose a file', 'اختر ملفًا', 'Choisir un fichier', 'Elegir un archivo', 'Escolher um ficheiro', 'فائل منتخب کریں', 'फ़ाइल चुनें', 'Pumili ng file', 'फाइल छान्नुहोस्', 'ফাইল বেছে নিন', 'Pilih fail'],
  cChange: ['Change file', 'تغيير الملف', 'Changer de fichier', 'Cambiar archivo', 'Mudar de ficheiro', 'فائل بدلیں', 'फ़ाइल बदलें', 'Palitan ang file', 'फाइल बदल्नुहोस्', 'ফাইল বদলান', 'Tukar fail'],
  cSend: ['Send for approval', 'إرسال للموافقة', 'Envoyer pour validation', 'Enviar para aprobación', 'Enviar para aprovação', 'منظوری کے لیے بھیجیں', 'मंज़ूरी के लिए भेजें', 'Ipadala para maaprubahan', 'स्वीकृतिका लागि पठाउनुहोस्', 'অনুমোদনের জন্য পাঠান', 'Hantar untuk kelulusan'],
  cSent: ['Sent. Our team will check it.', 'تم الإرسال. سيراجعه فريقنا.', 'Envoyé. Notre équipe va le vérifier.', 'Enviado. Nuestro equipo lo revisará.', 'Enviado. A nossa equipa vai verificar.', 'بھیج دیا گیا۔ ہماری ٹیم اسے دیکھے گی۔', 'भेज दिया गया। हमारी टीम इसे देखेगी।', 'Naipadala. Titingnan ito ng aming team.', 'पठाइयो। हाम्रो टोलीले जाँच गर्नेछ।', 'পাঠানো হয়েছে। আমাদের দল দেখে নেবে।', 'Dihantar. Pasukan kami akan menyemaknya.'],
  cancel: ['Cancel', 'إلغاء', 'Annuler', 'Cancelar', 'Cancelar', 'منسوخ کریں', 'रद्द करें', 'Kanselahin', 'रद्द गर्नुहोस्', 'বাতিল', 'Batal'],
  eKm: ['Enter 1 to 300 km for one ride, or up to 50,000 km for a total.', 'أدخل من 1 إلى 300 كم لرحلة واحدة، أو حتى 50,000 كم للمجموع.', 'Saisissez 1 à 300 km pour une sortie, ou jusqu’à 50 000 km pour un total.', 'Introduce de 1 a 300 km para una ruta, o hasta 50.000 km para un total.', 'Indique 1 a 300 km para uma pedalada, ou até 50 000 km para um total.', 'ایک سواری کے لیے 1 سے 300 کلومیٹر، یا کل کے لیے 50,000 کلومیٹر تک لکھیں۔', 'एक सवारी के लिए 1 से 300 किमी, या कुल के लिए 50,000 किमी तक लिखें।', 'Maglagay ng 1 hanggang 300 km para sa isang biyahe, o hanggang 50,000 km para sa kabuuan.', 'एउटा सवारीका लागि 1 देखि 300 किमी, वा जम्माका लागि 50,000 किमीसम्म लेख्नुहोस्।', 'একটি রাইডের জন্য 1 থেকে 300 কিমি, বা মোটের জন্য 50,000 কিমি পর্যন্ত লিখুন।', 'Masukkan 1 hingga 300 km untuk satu kayuhan, atau sehingga 50,000 km untuk jumlah.'],
  eDate: ['Check the dates: none can be after today.', 'تحقق من التواريخ: لا يمكن أن يكون أي منها بعد اليوم.', 'Vérifiez les dates : aucune ne peut être après aujourd’hui.', 'Revisa las fechas: ninguna puede ser posterior a hoy.', 'Verifique as datas: nenhuma pode ser depois de hoje.', 'تاریخیں دیکھیں: کوئی بھی آج کے بعد کی نہیں ہو سکتی۔', 'तारीखें देखें: कोई भी आज के बाद की नहीं हो सकती।', 'Suriin ang mga petsa: walang puwedeng lampas ngayong araw.', 'मितिहरू जाँच्नुहोस्: कुनै पनि आजपछिको हुन सक्दैन।', 'তারিখগুলো দেখুন: কোনোটিই আজকের পরে হতে পারে না।', 'Semak tarikh: tiada yang boleh selepas hari ini.'],
  eProof: ['Add a picture or a PDF (2 MB at most) that shows the distance.', 'أضف صورة أو ملف PDF (2 ميغابايت كحد أقصى) يُظهر المسافة.', 'Ajoutez une image ou un PDF (2 Mo maximum) montrant la distance.', 'Añade una imagen o un PDF (2 MB como máximo) que muestre la distancia.', 'Adicione uma imagem ou um PDF (2 MB no máximo) que mostre a distância.', 'ایسی تصویر یا PDF (زیادہ سے زیادہ 2 MB) شامل کریں جس میں فاصلہ نظر آئے۔', 'ऐसा चित्र या PDF (अधिकतम 2 MB) जोड़ें जिसमें दूरी दिखे।', 'Magdagdag ng larawan o PDF (hanggang 2 MB) na nagpapakita ng distansya.', 'दूरी देखिने तस्बिर वा PDF (बढीमा 2 MB) थप्नुहोस्।', 'দূরত্ব দেখা যায় এমন ছবি বা PDF (সর্বোচ্চ 2 MB) যোগ করুন।', 'Tambah gambar atau PDF (maksimum 2 MB) yang menunjukkan jarak.'],
  eLimit: ['You have 3 waiting already. Our team will answer them first.', 'لديك 3 بانتظار المراجعة. سيرد فريقنا عليها أولًا.', 'Vous en avez déjà 3 en attente. Notre équipe y répondra d’abord.', 'Ya tienes 3 pendientes. Nuestro equipo las responderá primero.', 'Já tem 3 em espera. A nossa equipa responde-lhes primeiro.', 'آپ کی 3 پہلے سے زیرِ انتظار ہیں۔ ہماری ٹیم پہلے ان کا جواب دے گی۔', 'आपकी 3 पहले से प्रतीक्षा में हैं। हमारी टीम पहले उनका जवाब देगी।', 'May 3 ka nang naghihintay. Sasagutin muna ng aming team ang mga iyon.', 'तपाईंका 3 पहिले नै पर्खाइमा छन्। हाम्रो टोलीले पहिले तिनको जवाफ दिनेछ।', 'আপনার 3টি আগে থেকেই অপেক্ষায় আছে। আমাদের দল আগে সেগুলোর উত্তর দেবে।', 'Anda sudah ada 3 yang menunggu. Pasukan kami akan menjawabnya dahulu.'],
  eNet: ['Something went wrong. Please try again.', 'حدث خطأ. يرجى المحاولة مرة أخرى.', 'Une erreur s’est produite. Veuillez réessayer.', 'Algo salió mal. Inténtalo de nuevo.', 'Algo correu mal. Tente novamente.', 'کچھ غلط ہو گیا۔ دوبارہ کوشش کریں۔', 'कुछ गलत हो गया। फिर कोशिश करें।', 'May nangyaring mali. Subukang muli.', 'केही गडबड भयो। फेरि प्रयास गर्नुहोस्।', 'কিছু ভুল হয়েছে। আবার চেষ্টা করুন।', 'Ada yang tidak kena. Sila cuba lagi.'],
  retry: ['Try again', 'حاول مرة أخرى', 'Réessayer', 'Reintentar', 'Tentar novamente', 'دوبارہ کوشش کریں', 'फिर कोशिश करें', 'Subukang muli', 'फेरि प्रयास गर्नुहोस्', 'আবার চেষ্টা করুন', 'Cuba lagi'],
  mine: ['Your distances', 'مسافاتك', 'Vos distances', 'Tus distancias', 'As suas distâncias', 'آپ کے فاصلے', 'आपकी दूरियाँ', 'Ang iyong mga distansya', 'तपाईंका दूरीहरू', 'আপনার দূরত্ব', 'Jarak anda'],
  stWait: ['Waiting', 'قيد المراجعة', 'En attente', 'Pendiente', 'Em espera', 'زیرِ انتظار', 'प्रतीक्षा में', 'Naghihintay', 'पर्खाइमा', 'অপেক্ষায়', 'Menunggu'],
  stOk: ['Approved', 'تمت الموافقة', 'Validée', 'Aprobada', 'Aprovada', 'منظور', 'मंज़ूर', 'Naaprubahan', 'स्वीकृत', 'অনুমোদিত', 'Diluluskan'],
  stNo: ['Declined', 'مرفوضة', 'Refusée', 'Rechazada', 'Recusada', 'نامنظور', 'अस्वीकृत', 'Tinanggihan', 'अस्वीकृत', 'প্রত্যাখ্যাত', 'Ditolak'],
  stStaff: ['Added by our team', 'أضافها فريقنا', 'Ajoutée par notre équipe', 'Añadida por nuestro equipo', 'Adicionada pela nossa equipa', 'ہماری ٹیم نے شامل کیا', 'हमारी टीम ने जोड़ा', 'Idinagdag ng aming team', 'हाम्रो टोलीले थपेको', 'আমাদের দল যোগ করেছে', 'Ditambah oleh pasukan kami'],
  withdraw: ['Take back', 'سحب', 'Retirer', 'Retirar', 'Retirar', 'واپس لیں', 'वापस लें', 'Bawiin', 'फिर्ता लिनुहोस्', 'ফিরিয়ে নিন', 'Tarik balik'],
  loadErr: ['We could not load the leaderboard.', 'تعذّر تحميل لوحة المتصدرين.', 'Impossible de charger le classement.', 'No se pudo cargar la clasificación.', 'Não foi possível carregar a classificação.', 'لیڈر بورڈ لوڈ نہیں ہو سکا۔', 'लीडरबोर्ड लोड नहीं हो सका।', 'Hindi ma-load ang leaderboard.', 'लिडरबोर्ड लोड हुन सकेन।', 'লিডারবোর্ড লোড করা যায়নি।', 'Papan pendahulu tidak dapat dimuatkan.'],
  // staff
  sTitle: ['Distance leaderboards', 'لوحات المسافات', 'Classements des distances', 'Clasificaciones de distancia', 'Classificações de distância', 'فاصلے کے لیڈر بورڈز', 'दूरी के लीडरबोर्ड', 'Mga leaderboard ng distansya', 'दूरीका लिडरबोर्ड', 'দূরত্বের লিডারবোর্ড', 'Papan pendahulu jarak'],
  sMembers: ['Members only', 'الأعضاء فقط', 'Membres seulement', 'Solo miembros', 'Só membros', 'صرف اراکین', 'केवल सदस्य', 'Mga miyembro lang', 'सदस्य मात्र', 'শুধু সদস্য', 'Ahli sahaja'],
  sWaiting: ['Waiting for approval', 'بانتظار الموافقة', 'En attente de validation', 'Pendientes de aprobación', 'À espera de aprovação', 'منظوری کے منتظر', 'मंज़ूरी की प्रतीक्षा', 'Naghihintay ng pag-apruba', 'स्वीकृतिको पर्खाइमा', 'অনুমোদনের অপেক্ষায়', 'Menunggu kelulusan'],
  sEntries: ['Distances entered', 'المسافات المُدخلة', 'Distances saisies', 'Distancias introducidas', 'Distâncias registadas', 'درج کیے گئے فاصلے', 'दर्ज दूरियाँ', 'Mga naitalang distansya', 'दर्ता गरिएका दूरी', 'লেখা দূরত্ব', 'Jarak yang direkodkan'],
  sAcct: ['Account', 'الحساب', 'Compte', 'Cuenta', 'Conta', 'اکاؤنٹ', 'खाता', 'Account', 'खाता', 'অ্যাকাউন্ট', 'Akaun'],
  sFind: ['Search by name or phone', 'ابحث بالاسم أو الجوال', 'Rechercher par nom ou téléphone', 'Buscar por nombre o teléfono', 'Pesquisar por nome ou telefone', 'نام یا فون سے تلاش کریں', 'नाम या फ़ोन से खोजें', 'Hanapin ayon sa pangalan o telepono', 'नाम वा फोनले खोज्नुहोस्', 'নাম বা ফোন দিয়ে খুঁজুন', 'Cari dengan nama atau telefon'],
  sApprove: ['Approve', 'موافقة', 'Valider', 'Aprobar', 'Aprovar', 'منظور کریں', 'मंज़ूर करें', 'Aprubahan', 'स्वीकृत गर्नुहोस्', 'অনুমোদন', 'Luluskan'],
  sDecline: ['Decline', 'رفض', 'Refuser', 'Rechazar', 'Recusar', 'نامنظور کریں', 'अस्वीकार करें', 'Tanggihan', 'अस्वीकार गर्नुहोस्', 'প্রত্যাখ্যান', 'Tolak'],
  sRemove: ['Remove', 'حذف', 'Supprimer', 'Quitar', 'Remover', 'ہٹائیں', 'हटाएँ', 'Alisin', 'हटाउनुहोस्', 'সরান', 'Buang'],
  sRemoveQ: ['Remove this distance? The boards and badges follow at once.', 'حذف هذه المسافة؟ تتغير اللوحات والأوسمة فورًا.', 'Supprimer cette distance ? Les classements et badges suivent aussitôt.', '¿Quitar esta distancia? Las clasificaciones y las insignias cambian al momento.', 'Remover esta distância? As classificações e conquistas mudam de imediato.', 'یہ فاصلہ ہٹائیں؟ لیڈر بورڈ اور بیج فوراً بدل جائیں گے۔', 'यह दूरी हटाएँ? लीडरबोर्ड और बैज तुरंत बदल जाएँगे।', 'Alisin ang distansyang ito? Agad na susunod ang mga leaderboard at badge.', 'यो दूरी हटाउने? लिडरबोर्ड र ब्याज तुरुन्तै बदलिन्छन्।', 'এই দূরত্ব সরাবেন? লিডারবোর্ড ও ব্যাজ সঙ্গে সঙ্গে বদলাবে।', 'Buang jarak ini? Papan pendahulu dan lencana berubah serta-merta.'],
  sReply: ['Reply to the rider (optional)', 'رد على العميل (اختياري)', 'Réponse au cycliste (facultatif)', 'Respuesta al ciclista (opcional)', 'Resposta ao ciclista (opcional)', 'رائیڈر کو جواب (اختیاری)', 'राइडर को जवाब (वैकल्पिक)', 'Sagot sa rider (opsyonal)', 'राइडरलाई जवाफ (ऐच्छिक)', 'রাইডারকে উত্তর (ঐচ্ছিক)', 'Balasan kepada penunggang (pilihan)'],
  sKmCount: ['km to count', 'الكيلومترات المحتسبة', 'km retenus', 'km que cuentan', 'km a contar', 'شمار ہونے والے کلومیٹر', 'गिने जाने वाले किमी', 'km na bibilangin', 'गनिने किमी', 'গণনার কিমি', 'km dikira'],
  sProof: ['View proof', 'عرض الإثبات', 'Voir la preuve', 'Ver la prueba', 'Ver a prova', 'ثبوت دیکھیں', 'प्रमाण देखें', 'Tingnan ang patunay', 'प्रमाण हेर्नुहोस्', 'প্রমাণ দেখুন', 'Lihat bukti'],
  sProofT: ['Proof', 'الإثبات', 'Preuve', 'Prueba', 'Prova', 'ثبوت', 'प्रमाण', 'Patunay', 'प्रमाण', 'প্রমাণ', 'Bukti'],
  sOpenPdf: ['Open the PDF', 'فتح ملف PDF', 'Ouvrir le PDF', 'Abrir el PDF', 'Abrir o PDF', 'PDF کھولیں', 'PDF खोलें', 'Buksan ang PDF', 'PDF खोल्नुहोस्', 'PDF খুলুন', 'Buka PDF'],
  sSrcSes: ['Session', 'جلسة', 'Séance', 'Sesión', 'Sessão', 'سیشن', 'सत्र', 'Session', 'सत्र', 'সেশন', 'Sesi'],
  sSrcEnt: ['Entered', 'مُدخلة', 'Saisie', 'Introducida', 'Registada', 'درج', 'दर्ज', 'Naitala', 'दर्ता', 'লেখা', 'Direkod'],
  sPub: ['Name shown', 'الاسم ظاهر', 'Nom affiché', 'Nombre visible', 'Nome visível', 'نام دکھایا', 'नाम दिखता है', 'Nakikita ang pangalan', 'नाम देखिन्छ', 'নাম দেখানো', 'Nama ditunjukkan'],
  sNotMember: ['Not a member', 'ليس عضوًا', 'Pas membre', 'No es miembro', 'Não é membro', 'رکن نہیں', 'सदस्य नहीं', 'Hindi miyembro', 'सदस्य होइन', 'সদস্য নন', 'Bukan ahli'],
  sTotalHint: ['A total should not include sessions already counted here.', 'يجب ألا يشمل المجموع جلسات محتسبة هنا مسبقًا.', 'Un total ne doit pas inclure des séances déjà comptées ici.', 'Un total no debe incluir sesiones ya contadas aquí.', 'Um total não deve incluir sessões já contadas aqui.', 'کل میں وہ سیشن شامل نہ ہوں جو یہاں پہلے سے شمار ہیں۔', 'कुल में वे सत्र शामिल न हों जो यहाँ पहले से गिने गए हैं।', 'Hindi dapat kasama sa kabuuan ang mga session na nabilang na rito.', 'जम्मामा यहाँ पहिले नै गनिएका सत्र नराख्नुहोस्।', 'মোটে এখানে আগে গোনা সেশন যেন না থাকে।', 'Jumlah tidak patut termasuk sesi yang sudah dikira di sini.'],
  sSaved: ['Saved', 'تم الحفظ', 'Enregistré', 'Guardado', 'Guardado', 'محفوظ ہو گیا', 'सहेजा गया', 'Na-save', 'सेभ भयो', 'সেভ হয়েছে', 'Disimpan'],
  sNote: ['Note', 'ملاحظة', 'Note', 'Nota', 'Nota', 'نوٹ', 'नोट', 'Tala', 'नोट', 'নোট', 'Nota'],
  sPodium: ['Gold, Silver and Bronze go to the three longest single rides staff entered or approved, men and women apart.', 'تذهب الذهبية والفضية والبرونزية لأطول ثلاث رحلات منفردة أدخلها الفريق أو وافق عليها، للرجال والنساء كل على حدة.', 'Or, Argent et Bronze vont aux trois plus longues sorties saisies ou validées par l’équipe, hommes et femmes à part.', 'Oro, Plata y Bronce van a las tres rutas más largas que el equipo introdujo o aprobó, hombres y mujeres por separado.', 'Ouro, Prata e Bronze vão para as três pedaladas mais longas registadas ou aprovadas pela equipa, homens e mulheres à parte.', 'گولڈ، سلور اور برونز ٹیم کی درج یا منظور کردہ تین سب سے لمبی سواریوں کو، مرد اور خواتین الگ۔', 'गोल्ड, सिल्वर और ब्रॉन्ज़ टीम द्वारा दर्ज या मंज़ूर तीन सबसे लंबी सवारियों को, पुरुष और महिलाएँ अलग।', 'Ang Gold, Silver at Bronze ay para sa tatlong pinakamahabang biyaheng itinala o inaprubahan ng team, hiwalay ang lalaki at babae.', 'गोल्ड, सिल्भर र ब्रोन्ज टोलीले दर्ता वा स्वीकृत गरेका तीन सबैभन्दा लामो सवारीलाई, पुरुष र महिला छुट्टै।', 'গোল্ড, সিলভার ও ব্রোঞ্জ দলের লেখা বা অনুমোদিত তিনটি দীর্ঘতম রাইডে, পুরুষ ও নারী আলাদা।', 'Emas, Perak dan Gangsa untuk tiga kayuhan terpanjang yang direkod atau diluluskan pasukan, lelaki dan wanita berasingan.'],
};
function _dT(k) { const row = DBD_T[k] || [''], i = DBD_LANGS.indexOf(S.lang); return row[i < 0 ? 0 : i] || row[0]; }
function _dF(k, ...v) { return v.reduce((s, x, i) => s.split('{' + i + '}').join(String(x)), _dT(k)); }
const _DBD_EL = { '@': 'this' }, _DBD_EV = { '@': 'event' };
const DBD_BOARDS = ['longest', 'month', 'lifetime', 'year'];
const DBD_PDF_MAX = 2 * 1024 * 1024;
const DBD_LINK = 'experiences.micromobility.sa/leaderboard';
function _dbdLent() { return window._dbdDeps || {}; }
function _dbdW(k, d) { const dep = _dbdLent(); let w = null; try { w = dep.words && dep.words(); } catch (_) {} return (w && w[k]) || d; }
function _dbdCust() { const c = S.loggedIn || (typeof getSession === 'function' ? getSession() : null); return c && c.id && c.session_token ? c : null; }
// A distance as the page writes it: a whole number without its point, else one decimal; Latin digits in every language.
function _dbdNum(v) { const n = Math.round((Number(v) || 0) * 10) / 10; return Number.isInteger(n) ? String(n) : n.toFixed(1); }
function _dbdKm(v) { return _dF('km', _dbdNum(v)); }
// A typed number: Arabic and Persian digits and a comma for the point are read too.
function _dbdRead(v) {
  const s = String(v == null ? '' : v).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 1632)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 1776)).replace(/[٫,]/g, '.').trim();
  return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
}
const DBD_MEDAL = { 1: ['lr1', 'gold'], 2: ['lr2', 'silver'], 3: ['lr3', 'orange'] };
function _dbdMedal(n, cls) { const m = DBD_MEDAL[n]; return m && typeof _bdgMedal === 'function' ? _bdgMedal(m[0], m[1], cls) : ''; }

// ── The rider's page ─────────────────────────────────────────────────────────────────────────────────────
function _dbdState() { return S._dbd || (S._dbd = { b: 'longest', g: '', cache: {}, mine: null }); }
function _dbdKey(b, g) { return b + ':' + g; }
async function _dbdFetch(b, g) {
  const D = _dbdState(), c = _dbdCust(), key = _dbdKey(b, g);
  const tok = (D.tok = (D.tok || 0) + 1);
  let r;
  try { r = await sb.rpc('distance_board', { p_board: b, p_gender: g, p_id: c ? c.id : null, p_token: c ? c.session_token : null }); } catch (e) { r = { error: e }; }
  const a = r && !r.error && r.data;
  D.cache[key] = a && a.ok ? { at: Date.now(), rows: Array.isArray(a.rows) ? a.rows : [], me: a.me || null, forId: c ? c.id : '' } : { at: Date.now(), err: true };
  if (D.tok === tok || D.b + ':' + D.g === key) _dbdPaint();
}
async function _dbdMineFetch() {
  const D = _dbdState(), c = _dbdCust(); if (!c) { D.mine = null; return; }
  let r;
  try { r = await sb.rpc('customer_distances', { p_id: c.id, p_token: c.session_token }); } catch (e) { r = { error: e }; }
  const a = r && !r.error && r.data;
  if (a && a.ok) { D.mine = { ...a, forId: c.id }; _dbdPaint(); }
}
function _dbdOpen(opts) {
  const D = _dbdState(), c = _dbdCust();
  const o = opts || {};
  if (o.board && DBD_BOARDS.includes(o.board)) D.b = o.board;
  if (!D.g) D.g = c && c.gender === 'female' ? 'female' : c && c.gender === 'male' ? 'male' : 'male';
  D.open = true; D.from = document.activeElement;
  _dbdPaint();
  const box = document.querySelector('#dbd-page .dbd-box'); if (box) try { box.focus({ preventScroll: true }); } catch (_) {}
  const hit = D.cache[_dbdKey(D.b, D.g)];
  if (!hit || hit.err || Date.now() - hit.at > 6e4 || hit.forId !== (c ? c.id : '')) _dbdFetch(D.b, D.g);
  if (c) _dbdMineFetch();
}
function _dbdClose() {
  const D = _dbdState(); D.open = false;
  const el = document.getElementById('dbd-page'); if (el) el.remove();
  document.body.classList.remove('dbd-on');
  const dep = _dbdLent(); try { if (dep.closed) dep.closed(); } catch (_) {}
  const f = D.from; D.from = null; try { if (f && f.isConnected) f.focus(); } catch (_) {}
}
function _dbdSet(k, v) {
  const D = _dbdState();
  if (k === 'b' && DBD_BOARDS.includes(v)) D.b = v; else if (k === 'g' && (v === 'male' || v === 'female')) D.g = v; else return;
  const c = _dbdCust(), hit = D.cache[_dbdKey(D.b, D.g)];
  _dbdPaint();
  if (!hit || hit.err || Date.now() - hit.at > 6e4 || hit.forId !== (c ? c.id : '')) _dbdFetch(D.b, D.g);
}
function _dbdRetry() { const D = _dbdState(); delete D.cache[_dbdKey(D.b, D.g)]; _dbdPaint(); _dbdFetch(D.b, D.g); }
function _dbdBoardName(b) { return _dT(b === 'month' ? 'month' : b === 'lifetime' ? 'lifetime' : b === 'year' ? 'year' : 'longest'); }
function _dbdSwitch(k, list, on) {
  return `<div class="dbd-sw" role="group">${list.map(([v, w]) => `<button type="button" class="dbd-sb${v === on ? ' active' : ''}" aria-pressed="${v === on}" data-on-click="${_on('_dbdSet', k, v)}">${esc(w)}</button>`).join('')}</div>`;
}
function _dbdRowsHtml(hit) {
  if (!hit) return `<div class="dbd-wait" role="status"></div>`;
  if (hit.err) return `<div class="dbd-err" role="alert"><span>${esc(_dT('loadErr'))}</span><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_dbdRetry')}">${esc(_dT('retry'))}</button></div>`;
  if (!hit.rows.length) return '';
  return `<ol class="dbd-list">${hit.rows.map((r) => `<li class="dbd-row${r.mine ? ' mine' : ''}">
      <span class="dbd-r">${esc(String(r.r))}</span>
      <span class="dbd-md">${r.medal ? _dbdMedal(r.medal, 'dbd-medal') : ''}</span>
      <bdi class="dbd-nm">${esc(r.mine ? _dT('you') : r.name || _dT('member'))}</bdi>
      <span class="dbd-km" dir="ltr">${esc(_dbdKm(r.km))}</span></li>`).join('')}</ol>`;
}
function _dbdMineHtml(c, hit) {
  const D = _dbdState(), M = D.mine && D.mine.forId === c.id ? D.mine : null, me = hit && !hit.err ? hit.me : null;
  const pub = me ? !!me.public : M ? !!M.public : false, member = me ? !!me.member : M ? !!M.member : true;
  const val = D.b === 'lifetime' ? M && M.lifetime : D.b === 'year' ? M && M.year : D.b === 'longest' ? M && M.best : me && me.km;
  const ranked = me && me.r;
  return `<div class="dbd-me">
      <div class="dbd-me-top">
        <div class="dbd-me-place">${ranked ? `<span class="dbd-me-r">#${esc(String(me.r))}</span>` : ''}${D.b === 'longest' && M && M.medal ? _dbdMedal(M.medal, 'dbd-medal') : ''}</div>
        <div class="dbd-me-km" dir="ltr">${val ? esc(_dbdKm(ranked ? me.km : val)) : ''}</div>
      </div>
      ${member ? '' : `<p class="dbd-note">${esc(_dT('onlyMembers'))}</p>`}
      <label class="cw-sw dbd-pub" for="dbd-pub"><input type="checkbox" role="switch" id="dbd-pub"${pub ? ' checked' : ''} data-on-change="${_on('_dbdPub', _P('checked'))}"><span class="cw-sw-box" aria-hidden="true"></span><span class="cw-sw-txt"><b>${esc(_dT('nameSw'))}</b><small>${esc(_dT('nameSwSub'))}</small></span></label>
      <div class="dbd-acts">
        ${ranked ? `<button type="button" class="btn-primary" data-on-click="${_on('_dbdShare')}">${_cuIc('share', 16)}<span>${esc(_dbdW('share', 'Share'))}</span></button>` : ''}
        <button type="button" class="btn-secondary" data-on-click="${_on('_dbdClaimOpen')}">${_cuIc('plus', 16)}<span>${esc(_dT('add'))}</span></button>
      </div>
    </div>`;
}
function _dbdClaimsHtml(c) {
  const D = _dbdState(), M = D.mine && D.mine.forId === c.id ? D.mine : null, L = M && Array.isArray(M.claims) ? M.claims : [];
  if (!L.length) return '';
  const st = (x) => x.source === 'staff' ? _dT('stStaff') : x.status === 'approved' ? _dT('stOk') : x.status === 'declined' ? _dT('stNo') : _dT('stWait');
  return `<div class="dbd-mine"><h3 class="dbd-h">${esc(_dT('mine'))}</h3><ul class="dbd-cl">${L.map((x) => `<li class="dbd-ci st-${esc(x.source === 'staff' ? 'staff' : x.status)}">
      <div class="dbd-ci-t"><b dir="ltr">${esc(_dbdKm(x.km))}</b> <span>${esc(x.kind === 'total' ? _dT('kTotal') : _dT('kRide'))}</span></div>
      <div class="dbd-ci-d">${esc(x.kind === 'total' && x.from ? _bdgDay(x.from + 'T12:00:00Z') + ' – ' + _bdgDay(x.d + 'T12:00:00Z') : _bdgDay(x.d + 'T12:00:00Z'))}</div>
      <div class="dbd-ci-s"><span class="dbd-pill">${esc(st(x))}</span>${x.reply ? ` <bdi class="dbd-reply">${esc(x.reply)}</bdi>` : ''}${x.status === 'pending' && x.source === 'claim' ? ` <button type="button" class="btn-sm btn-secondary" data-on-click="${_on('_dbdWithdraw', x.id)}">${esc(_dT('withdraw'))}</button>` : ''}</div>
    </li>`).join('')}</ul></div>`;
}
function _dbdPaint() {
  const D = _dbdState(); if (!D.open) return;
  const c = _dbdCust(), hit = D.cache[_dbdKey(D.b, D.g)];
  let el = document.getElementById('dbd-page');
  const was = el && el.querySelector('.dbd-body'), top = was ? was.scrollTop : 0;
  if (!el) {
    el = document.createElement('div'); el.id = 'dbd-page'; el.className = 'dbd-page';
    el.addEventListener('click', (e) => { if (e.target === el) _dbdClose(); });
    document.body.appendChild(el); document.body.classList.add('dbd-on');
  }
  const sub = D.b === 'month' ? _dT('monthP') : D.b === 'lifetime' ? _dT('lifetimeP') : D.b === 'year' ? _dT('yearP') : '';
  el.innerHTML = `<div class="dbd-box" role="dialog" aria-modal="true" aria-labelledby="dbd-title" tabindex="-1">
    <div class="dbd-head"><h2 id="dbd-title" class="dbd-title">${esc(_dT('title'))}</h2><button type="button" class="chrome-x x-close" aria-label="${esc(_dbdW('close', 'Close'))}" data-on-click="${_on('_dbdClose')}">&times;</button></div>
    <div class="dbd-body">
      ${_dbdSwitch('b', DBD_BOARDS.map((b) => [b, _dbdBoardName(b)]), D.b)}
      ${_dbdSwitch('g', [['male', _dT('men')], ['female', _dT('women')]], D.g)}
      ${sub ? `<p class="dbd-sub">${esc(sub)}</p>` : ''}
      ${c ? _dbdMineHtml(c, hit) : ''}
      ${_dbdRowsHtml(hit)}
      ${c ? _dbdClaimsHtml(c) : ''}
    </div></div>`;
  const b = el.querySelector('.dbd-body'); if (b && top) b.scrollTop = top;
}
async function _dbdPub(on) {
  const c = _dbdCust(); if (!c) return;
  let r;
  try { r = await sb.rpc('customer_board_public', { p_id: c.id, p_token: c.session_token, p_on: !!on }); } catch (e) { r = { error: e }; }
  const a = r && !r.error && r.data;
  if (!a || !a.ok) { toast(_dT('eNet'), 'error'); _dbdPaint(); return; }
  const D = _dbdState(); D.cache = {}; if (D.mine) D.mine.public = !!on;
  _dbdPaint(); _dbdFetch(D.b, D.g);
}
// The picture: the board's name, the distance, the place and the board's gender; the medal for a podium place on the
// longest ride, else the road; the leaderboard's address at its foot (badge-share.js draws it and hands it to the share sheet).
function _dbdShare() {
  const D = _dbdState(), c = _dbdCust(), hit = D.cache[_dbdKey(D.b, D.g)], me = hit && !hit.err ? hit.me : null;
  if (!c || !me || !me.r || typeof _shrLoad !== 'function') return;
  const M = D.mine && D.mine.forId === c.id ? D.mine : null, medal = D.b === 'longest' && M && M.medal ? DBD_MEDAL[M.medal] : null;
  const label = D.b === 'month' ? _dT('monthP') : D.b === 'lifetime' ? _dT('lifetimeP') : D.b === 'year' ? _dT('yearP') : _dT('longest');
  _shrLoad({ kind: 'dist', sub0: {
    label, name: _dbdKm(me.km), level: '#' + me.r + ' · ' + _dT(D.g === 'female' ? 'women' : 'men'), date: '',
    medal: medal ? { icon: medal[0], color: medal[1] } : { icon: 'road', color: 'green' },
    file: 'micromobility-' + D.b, foot: DBD_LINK,
  } });
}
async function _dbdWithdraw(id) {
  const c = _dbdCust(); if (!c) return;
  let r;
  try { r = await sb.rpc('customer_distance_withdraw', { p_id: c.id, p_token: c.session_token, p_claim: id }); } catch (e) { r = { error: e }; }
  if (!r || r.error) { toast(_dT('eNet'), 'error'); return; }
  _dbdMineFetch();
}

// ── Add a distance (a claim) ─────────────────────────────────────────────────────────────────────────────
function _dbdClaimOpen() {
  if (!_dbdCust()) return;
  S._dbdC = { kind: 'ride', km: '', d: todayStr(), from: '', note: '', proof: null, err: '', busy: false };
  _dbdClaimPaint();
  const f = document.getElementById('dbd-c-km'); if (f) try { f.focus(); } catch (_) {}
}
function _dbdClaimClose() { const m = document.getElementById('confirm-modal'); if (m && S._dbdC) { m.style.display = 'none'; m.innerHTML = ''; } S._dbdC = null; }
function _dbdClaimIn(k, el) { const d = S._dbdC; if (!d || d.busy) return; d[k] = String(el.value || ''); }
function _dbdClaimKind(v) { const d = S._dbdC; if (!d || d.busy || (v !== 'ride' && v !== 'total')) return; d.kind = v; d.err = ''; _dbdClaimPaint(); }
function _dbdClaimPaint() {
  const d = S._dbdC, m = document.getElementById('confirm-modal'); if (!d || !m) return;
  const off = d.busy ? ' disabled' : '', pf = d.proof, today = todayStr();
  const radio = (v, w) => `<button type="button" class="dbd-sb${d.kind === v ? ' active' : ''}" aria-pressed="${d.kind === v}"${off} data-on-click="${_on('_dbdClaimKind', v)}">${esc(w)}</button>`;
  m.style.display = 'block';
  m.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_on_backdropOnly', _DBD_EV, _DBD_EL, '_dbdClaimClose')}">
    <div class="confirm-box dbd-c" role="dialog" aria-modal="true" aria-labelledby="dbd-c-title">
      <div class="cmy-rej-head"><div id="dbd-c-title" class="chrome-dt">${esc(_dT('add'))}</div>
        <button type="button" data-on-click="${_on('_dbdClaimClose')}" aria-label="${esc(_dbdW('close', 'Close'))}" class="chrome-x x-close"${off}>&times;</button></div>
      <div class="dbd-sw dbd-kinds" role="group" aria-labelledby="dbd-c-title">${radio('ride', _dT('kRide'))}${radio('total', _dT('kTotal'))}</div>
      <div class="form-group"><label for="dbd-c-km">${esc(_dT('cKm'))}</label><input id="dbd-c-km" type="text" inputmode="decimal" maxlength="8" dir="ltr" value="${esc(d.km)}"${off} data-on-input="${_on('_dbdClaimIn', 'km', _DBD_EL)}"></div>
      ${d.kind === 'total' ? `<div class="form-row"><div class="form-group"><label for="dbd-c-from">${esc(_dT('cFrom'))}</label><input id="dbd-c-from" type="date" max="${today}" value="${esc(d.from)}"${off} data-on-input="${_on('_dbdClaimIn', 'from', _DBD_EL)}"></div>
        <div class="form-group"><label for="dbd-c-d">${esc(_dT('cTo'))}</label><input id="dbd-c-d" type="date" max="${today}" value="${esc(d.d)}"${off} data-on-input="${_on('_dbdClaimIn', 'd', _DBD_EL)}"></div></div>`
      : `<div class="form-group"><label for="dbd-c-d">${esc(_dT('cDay'))}</label><input id="dbd-c-d" type="date" max="${today}" value="${esc(d.d)}"${off} data-on-input="${_on('_dbdClaimIn', 'd', _DBD_EL)}"></div>`}
      <div class="form-group bdr-proof"><label for="dbd-c-file">${esc(_dT('cProof'))}</label>
        ${pf ? `<div class="bdr-file">${pf.kind === 'image' ? `<img class="bdr-thumb" src="${esc(pf.url)}" alt="">` : `<span class="bdr-doc">${_cuIc('doc', 22)}</span>`}<bdi class="bdr-fname">${esc(pf.name)}</bdi></div>` : ''}
        <label class="btn-secondary vt-pick"><input type="file" id="dbd-c-file" accept="image/*,application/pdf,.pdf" class="sr-only"${off} data-on-change="${_on('_dbdClaimFile', _DBD_EL)}">${_cuIc('plus', 16)}<span>${esc(_dT(pf ? 'cChange' : 'cPick'))}</span></label></div>
      <div class="form-group"><label for="dbd-c-note">${esc(_dT('cNote'))}</label><textarea id="dbd-c-note" rows="2" maxlength="300"${off} data-on-input="${_on('_dbdClaimIn', 'note', _DBD_EL)}">${esc(d.note)}</textarea></div>
      ${d.err ? `<div class="pg-net" role="alert">${esc(d.err)}</div>` : ''}
      <div class="cmy-rej-act">
        <button type="button" class="btn-secondary"${off} data-on-click="${_on('_dbdClaimClose')}">${esc(_dT('cancel'))}</button>
        <button type="button" class="btn-primary" id="dbd-c-send"${off} data-on-click="${_on('_dbdClaimSend')}">${esc(_dT('cSend'))}</button>
      </div></div></div>`;
}
// A picture is made small as a badge request's is (the long side 1600 px, a JPEG under ~2.5 MB); a PDF goes as it is,
// 2 MB at most, once its first bytes say PDF.
function _dbdClaimFile(el) {
  const d = S._dbdC, f = el && el.files && el.files[0]; if (!d || !f || d.busy) return;
  const bad = () => { if (S._dbdC !== d) return; d.err = _dT('eProof'); _dbdClaimPaint(); }, put = (p) => { if (S._dbdC !== d) return; d.proof = p; d.err = ''; _dbdClaimPaint(); };
  const name = String(f.name || '').slice(-120), rd = new FileReader(); rd.onerror = bad;
  if (/^application\/pdf$/i.test(f.type || '') || (!/^image\//.test(f.type || '') && /\.pdf$/i.test(name))) {
    if (f.size > DBD_PDF_MAX) { bad(); return; }
    rd.onload = () => { const s = String(rd.result || ''), b = s.slice(s.indexOf(',') + 1); if (!/^JVBER/.test(b)) { bad(); return; } put({ url: 'data:application/pdf;base64,' + b, kind: 'pdf', name: name || 'proof.pdf' }); };
    rd.readAsDataURL(f); return;
  }
  if (!/^image\//.test(f.type || '')) { bad(); return; }
  rd.onload = () => {
    const im = new Image(); im.onerror = bad;
    im.onload = () => {
      let w = im.naturalWidth, h = im.naturalHeight; const k = Math.min(1, 1600 / Math.max(w, h, 1)); w = Math.round(w * k); h = Math.round(h * k);
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); cx.drawImage(im, 0, 0, w, h);
      let q = 0.82, u = cv.toDataURL('image/jpeg', q); while (u.length > 2500000 && q > 0.4) { q -= 0.12; u = cv.toDataURL('image/jpeg', q); }
      put({ url: u, kind: 'image', name: name || 'proof.jpg' });
    };
    im.src = rd.result;
  };
  rd.readAsDataURL(f);
}
async function _dbdClaimSend() {
  const d = S._dbdC, c = _dbdCust(); if (!d || d.busy || !c) return;
  const km = _dbdRead(d.km), max = d.kind === 'total' ? 50000 : 300, today = todayStr(), ymd = /^\d{4}-\d\d-\d\d$/;
  const fail = (k) => { d.err = _dT(k); _dbdClaimPaint(); };
  if (!(km >= 1 && km <= max)) return fail('eKm');
  if (!ymd.test(d.d) || d.d > today || (d.kind === 'total' && (!ymd.test(d.from) || d.from > d.d))) return fail('eDate');
  if (!d.proof) return fail('eProof');
  d.busy = true; d.err = ''; _dbdClaimPaint();
  let r;
  try {
    r = await sb.rpc('customer_distance_claim', { p_id: c.id, p_token: c.session_token, p_kind: d.kind, p_km: Math.round(km * 10) / 10, p_date: d.d,
      p_from: d.kind === 'total' ? d.from : null, p_note: String(d.note || '').trim() || null, p_proof: d.proof.url, p_proof_name: d.proof.name });
  } catch (e) { r = { error: e }; }
  if (S._dbdC !== d) return;
  d.busy = false;
  const a = r && !r.error && r.data, e = a && a.ok === false && a.error;
  if (!a || a.ok !== true) return fail(e === 'km' ? 'eKm' : e === 'date' ? 'eDate' : e === 'proof' ? 'eProof' : e === 'limit' ? 'eLimit' : 'eNet');
  _dbdClaimClose(); toast(_dT('cSent'), 'success');
  _dbdMineFetch();
}

// ── Staff: Analytics > Leaderboard > Distance leaderboards ──────────────────────────────────────────────
// dep: what the staff page lends (_dbdStaffMount): find(q) -> accounts, name(id), open(id) the account window, can() the
// right to change, ask(text, fn) a confirm.
function _dbdSt() { return S._dbdS || (S._dbdS = { b: 'longest', g: 'female', members: true, board: null, rows: null, at: 0, err: false, km: {}, reply: {} }); }
let _dbdHost = null, _dbdDep = null;
function _dbdStaff(host, dep) {
  _dbdHost = host; _dbdDep = dep || {};
  const T = _dbdSt();
  _dbdStPaint();
  if (!T.rows || Date.now() - T.at > 6e4) _dbdStLoad();
}
async function _dbdStLoad() {
  const T = _dbdSt(), tok = (T.tok = (T.tok || 0) + 1);
  let b, r;
  try {
    [b, r] = await Promise.all([
      sb.rpc('staff_distance_board', { p_board: T.b, p_gender: T.g, p_members: T.members }),
      sb.from('ride_distances').select('id,customer_id,kind,km,date_from,ride_date,source,status,note,proof_kind,created_at,created_by,decided_at,decided_by,reply').order('created_at', { ascending: false }).limit(200),
    ]);
  } catch (e) { b = { error: e }; }
  if (T.tok !== tok) return;
  T.at = Date.now();
  T.err = !b || !!b.error || !r || !!r.error;
  if (!T.err) { T.board = Array.isArray(b.data) ? b.data : []; T.rows = r.data || []; }
  _dbdStPaint();
}
function _dbdStSet(k, v) {
  const T = _dbdSt();
  if (k === 'b' && DBD_BOARDS.includes(v)) T.b = v; else if (k === 'g' && (v === 'male' || v === 'female')) T.g = v; else if (k === 'members') T.members = !!v; else return;
  T.board = null; _dbdStPaint(); _dbdStLoad();
}
function _dbdStIn(k, id, el) { const T = _dbdSt(); (T[k] = T[k] || {})[id] = String(el.value || ''); }
function _dbdStName(id) { const n = _dbdDep && _dbdDep.name ? _dbdDep.name(id) : ''; return n || String(id); }
function _dbdStPaint() {
  const h = _dbdHost; if (!h || !h.isConnected) return;
  const T = _dbdSt(), can = !_dbdDep.can || _dbdDep.can();
  const sw = (k, list, on) => `<div class="filter-row cmy-mb6">${list.map(([v, w]) => `<button type="button" class="filter-pill${v === on ? ' active' : ''}" aria-pressed="${v === on}" data-on-click="${_on('_dbdStSet', k, v)}">${esc(w)}</button>`).join('')}</div>`;
  const wait = (T.rows || []).filter((x) => x.status === 'pending'), done = (T.rows || []).filter((x) => x.status !== 'pending').slice(0, 40);
  const kmTxt = (x) => _dbdKm(x.km) + ' · ' + (x.kind === 'total' ? _dT('kTotal') + ' · ' + x.date_from + ' – ' + x.ride_date : _dT('kRide') + ' · ' + x.ride_date);
  h.innerHTML = `<h2 class="dbd-st-title"><span>${esc(_dT('sTitle'))}</span>${can ? `<button type="button" class="btn-sm btn-primary" data-on-click="${_on('_dbdStAddOpen')}">${esc(_dT('add'))}</button>` : ''}</h2>
    <p class="dbd-st-hint">${esc(_dT('sPodium'))}</p>
    ${T.err ? `<div class="dbd-err" role="alert"><span>${esc(_dT('loadErr'))}</span><button type="button" class="btn-secondary btn-sm" data-on-click="${_on('_dbdStLoad')}">${esc(_dT('retry'))}</button></div>` : ''}
    ${wait.length ? `<h3 class="dbd-h">${esc(_dT('sWaiting'))} <span class="tab-badge">${wait.length}</span></h3>
    <div class="dbd-st-wait">${wait.map((x) => `<div class="dbd-st-c">
      <div class="dbd-st-ct"><button type="button" class="link-btn" data-on-click="${_on('_dbdStAcct', x.customer_id)}"><bdi>${esc(_dbdStName(x.customer_id))}</bdi></button> <span dir="ltr">${esc(kmTxt(x))}</span></div>
      ${x.note ? `<div class="dbd-st-note"><bdi>${esc(x.note)}</bdi></div>` : ''}
      ${x.kind === 'total' ? `<div class="dbd-st-hint">${esc(_dT('sTotalHint'))}</div>` : ''}
      <div class="dbd-st-cf">
        ${x.proof_kind ? `<button type="button" class="btn-sm btn-secondary" data-on-click="${_on('_dbdStProof', x.id)}">${_cuIc(x.proof_kind === 'pdf' ? 'doc' : 'eye', 14)}<span>${esc(_dT('sProof'))}</span></button>` : ''}
        <label class="dbd-st-l"><span>${esc(_dT('sKmCount'))}</span><input type="text" inputmode="decimal" maxlength="8" dir="ltr" value="${esc((T.km || {})[x.id] != null ? T.km[x.id] : _dbdNum(x.km))}" data-on-input="${_on('_dbdStIn', 'km', x.id, _DBD_EL)}"${can ? '' : ' disabled'}></label>
        <input type="text" class="dbd-st-reply" maxlength="140" placeholder="${esc(_dT('sReply'))}" aria-label="${esc(_dT('sReply'))}" value="${esc((T.reply || {})[x.id] || '')}" data-on-input="${_on('_dbdStIn', 'reply', x.id, _DBD_EL)}"${can ? '' : ' disabled'}>
        ${can ? `<button type="button" class="btn-sm btn-primary" data-on-click="${_on('_dbdStAnswer', x.id, true)}">${esc(_dT('sApprove'))}</button><button type="button" class="btn-sm btn-secondary" data-on-click="${_on('_dbdStAnswer', x.id, false)}">${esc(_dT('sDecline'))}</button>` : ''}
      </div></div>`).join('')}</div>` : ''}
    ${sw('b', DBD_BOARDS.map((b) => [b, _dbdBoardName(b)]), T.b)}
    <div class="filter-row cmy-mb6">${[['male', _dT('men')], ['female', _dT('women')]].map(([v, w]) => `<button type="button" class="filter-pill${v === T.g ? ' active' : ''}" aria-pressed="${v === T.g}" data-on-click="${_on('_dbdStSet', 'g', v)}">${esc(w)}</button>`).join('')}
      <button type="button" class="filter-pill dbd-st-mem${T.members ? ' active' : ''}" aria-pressed="${T.members}" data-on-click="${_on('_dbdStSet', 'members', !T.members)}">${esc(_dT('sMembers'))}</button></div>
    ${T.board ? `<table class="data-table dbd-st-t"><tbody>${T.board.map((r) => `<tr><td class="dbd-st-r">${esc(String(r.r))}</td>
      <td><button type="button" class="link-btn" data-on-click="${_on('_dbdStAcct', r.id)}"><bdi>${esc(r.name || '')}</bdi></button>${r.member ? '' : ` <span class="dbd-pill">${esc(_dT('sNotMember'))}</span>`}${r.public ? ` <span class="dbd-pill">${esc(_dT('sPub'))}</span>` : ''}</td>
      <td dir="ltr">${esc(_dbdKm(r.km))}</td><td>${esc(r.src === 'entry' ? _dT('sSrcEnt') : _dT('sSrcSes'))}</td><td dir="ltr">${esc(String(r.d || ''))}</td></tr>`).join('')}</tbody></table>`
      : T.err ? '' : `<div class="dbd-wait" role="status"></div>`}
    ${done.length ? `<h3 class="dbd-h">${esc(_dT('sEntries'))}</h3><table class="data-table dbd-st-t"><tbody>${done.map((x) => `<tr>
      <td><button type="button" class="link-btn" data-on-click="${_on('_dbdStAcct', x.customer_id)}"><bdi>${esc(_dbdStName(x.customer_id))}</bdi></button></td>
      <td dir="ltr">${esc(kmTxt(x))}</td>
      <td><span class="dbd-pill">${esc(x.source === 'staff' ? _dT('stStaff') : x.status === 'approved' ? _dT('stOk') : _dT('stNo'))}</span>${x.decided_by ? ` <bdi>${esc(x.decided_by)}</bdi>` : ''}</td>
      <td>${can && x.status === 'approved' ? `<button type="button" class="btn-sm btn-secondary" data-on-click="${_on('_dbdStRemove', x.id)}">${esc(_dT('sRemove'))}</button>` : ''}</td></tr>`).join('')}</tbody></table>` : ''}`;
}
function _dbdStAcct(id) { if (_dbdDep && _dbdDep.open) _dbdDep.open(id); }
async function _dbdStAnswer(id, ok) {
  const T = _dbdSt(), raw = (T.km || {})[id], km = raw == null || raw === '' ? null : _dbdRead(raw);
  if (raw != null && raw !== '' && !(km >= 1)) { toast(_dT('eKm'), 'error'); return; }
  let r;
  try { r = await sb.rpc('staff_distance_answer', { p_id: id, p_ok: !!ok, p_km: km == null ? null : Math.round(km * 10) / 10, p_reply: String((T.reply || {})[id] || '').trim() || null }); } catch (e) { r = { error: e }; }
  const a = r && !r.error && r.data;
  if (!a || !a.ok) { toast(a && a.error === 'km' ? _dT('eKm') : _dT('eNet'), 'error'); _dbdStLoad(); return; }
  toast(_dT('sSaved'), 'success');
  if (T.km) delete T.km[id]; if (T.reply) delete T.reply[id];
  if (_dbdDep.done) try { _dbdDep.done(); } catch (_) {}
  _dbdStLoad();
}
function _dbdStRemove(id) {
  const go = async () => {
    let r;
    try { r = await sb.rpc('staff_distance_remove', { p_id: id }); } catch (e) { r = { error: e }; }
    if (!r || r.error || !r.data || !r.data.ok) { toast(_dT('eNet'), 'error'); }
    else toast(_dT('sSaved'), 'success');
    if (_dbdDep.done) try { _dbdDep.done(); } catch (_) {}
    _dbdStLoad();
  };
  if (_dbdDep.ask) _dbdDep.ask(_dT('sRemoveQ'), go); else go();
}
let _dbdPfUrl = null;
async function _dbdStProof(id) {
  const m = document.getElementById('confirm-modal'); if (!m) return;
  if (_dbdPfUrl) { try { URL.revokeObjectURL(_dbdPfUrl); } catch (_) {} _dbdPfUrl = null; }
  const paint = (inner) => { m.style.display = 'block'; m.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_on_backdropOnly', _DBD_EV, _DBD_EL, '_dbdStProofClose')}"><div class="confirm-box vt-rc-box dbd-pf" role="dialog" aria-modal="true" aria-labelledby="dbd-pf-t">
    <div class="cmy-rej-head"><div id="dbd-pf-t" class="chrome-dt">${esc(_dT('sProofT'))}</div><button type="button" data-on-click="${_on('_dbdStProofClose')}" aria-label="${esc(_dbdW('close', 'Close'))}" class="chrome-x x-close">&times;</button></div>${inner}</div></div>`; };
  paint('<div class="vt-rc-wait"></div>');
  let x;
  try { x = await sb.from('ride_distances').select('proof,proof_name').eq('id', id).maybeSingle(); } catch (e) { x = { error: e }; }
  if (!m.querySelector('.dbd-pf')) return;
  if (!x || x.error) { paint(`<div class="vt-rc-wait">${esc(_dT('eNet'))}</div>`); return; }
  const u = String((x.data && x.data.proof) || ''), nm = String((x.data && x.data.proof_name) || '').replace(/[\\/:*?"<>|]+/g, '_') || 'proof-' + id;
  if (/^data:image\/(jpeg|png|webp);base64,/.test(u)) { paint(`<img class="vt-rc-img" src="${esc(u)}" alt="${esc(_dT('sProofT'))}">`); return; }
  let href = '';
  if (/^data:application\/pdf;base64,/.test(u)) try { const s = atob(u.slice(u.indexOf(',') + 1)), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); href = URL.createObjectURL(new Blob([a], { type: 'application/pdf' })); } catch (_) {}
  if (!href) { paint(`<div class="vt-rc-wait">${esc(_dT('eNet'))}</div>`); return; }
  _dbdPfUrl = href;
  paint(`<div class="bdr-pf-doc">${_cuIc('doc', 40)}<bdi>${esc(nm)}</bdi></div><div class="vt-rc-act"><a class="btn-primary" href="${esc(href)}" target="_blank" rel="noopener">${esc(_dT('sOpenPdf'))}</a></div>`);
}
function _dbdStProofClose() { const m = document.getElementById('confirm-modal'); if (m) { m.style.display = 'none'; m.innerHTML = ''; } }
// Add a distance for an account: one ride or a total, approved at once.
function _dbdStAddOpen() {
  S._dbdA = { q: '', id: '', kind: 'ride', km: '', d: todayStr(), from: '', note: '', busy: false };
  _dbdStAddPaint();
  const f = document.getElementById('dbd-a-q'); if (f) try { f.focus(); } catch (_) {}
}
function _dbdStAddClose() { const m = document.getElementById('confirm-modal'); if (m && S._dbdA) { m.style.display = 'none'; m.innerHTML = ''; } S._dbdA = null; }
function _dbdStAddIn(k, el) {
  const A = S._dbdA; if (!A || A.busy) return; A[k] = String(el.value || '');
  if (k === 'q') { A.id = ''; _dbdStAddHits(); }
}
function _dbdStAddKind(v) { const A = S._dbdA; if (!A || A.busy || (v !== 'ride' && v !== 'total')) return; A.kind = v; _dbdStAddPaint(); }
function _dbdStAddPick(id) { const A = S._dbdA; if (!A) return; A.id = String(id); A.q = _dbdStName(id); _dbdStAddPaint(); }
function _dbdStAddHits() {
  const A = S._dbdA, box = document.getElementById('dbd-a-hits'); if (!A || !box) return;
  const L = A.q.trim().length < 2 || !_dbdDep.find ? [] : _dbdDep.find(A.q).slice(0, 8);
  box.innerHTML = L.map((c) => `<button type="button" class="dbd-hit" data-on-click="${_on('_dbdStAddPick', c.id)}"><bdi>${esc(c.name || '')}</bdi> <span dir="ltr">${esc(c.phone || '')}</span></button>`).join('');
}
function _dbdStAddPaint() {
  const A = S._dbdA, m = document.getElementById('confirm-modal'); if (!A || !m) return;
  const off = A.busy ? ' disabled' : '', today = todayStr();
  const radio = (v, w) => `<button type="button" class="dbd-sb${A.kind === v ? ' active' : ''}" aria-pressed="${A.kind === v}"${off} data-on-click="${_on('_dbdStAddKind', v)}">${esc(w)}</button>`;
  m.style.display = 'block';
  m.innerHTML = `<div class="modal-backdrop" data-on-click="${_on('_on_backdropOnly', _DBD_EV, _DBD_EL, '_dbdStAddClose')}">
    <div class="confirm-box dbd-c" role="dialog" aria-modal="true" aria-labelledby="dbd-a-title">
      <div class="cmy-rej-head"><div id="dbd-a-title" class="chrome-dt">${esc(_dT('add'))}</div><button type="button" data-on-click="${_on('_dbdStAddClose')}" aria-label="${esc(_dbdW('close', 'Close'))}" class="chrome-x x-close">&times;</button></div>
      <div class="form-group"><label for="dbd-a-q">${esc(_dT('sAcct'))}</label><input id="dbd-a-q" type="search" placeholder="${esc(_dT('sFind'))}" value="${esc(A.q)}"${off} data-on-input="${_on('_dbdStAddIn', 'q', _DBD_EL)}">
        <div id="dbd-a-hits" class="dbd-hits"></div></div>
      <div class="dbd-sw dbd-kinds" role="group" aria-labelledby="dbd-a-title">${radio('ride', _dT('kRide'))}${radio('total', _dT('kTotal'))}</div>
      <div class="form-group"><label for="dbd-a-km">${esc(_dT('cKm'))}</label><input id="dbd-a-km" type="text" inputmode="decimal" maxlength="8" dir="ltr" value="${esc(A.km)}"${off} data-on-input="${_on('_dbdStAddIn', 'km', _DBD_EL)}"></div>
      ${A.kind === 'total' ? `<div class="form-row"><div class="form-group"><label for="dbd-a-from">${esc(_dT('cFrom'))}</label><input id="dbd-a-from" type="date" max="${today}" value="${esc(A.from)}"${off} data-on-input="${_on('_dbdStAddIn', 'from', _DBD_EL)}"></div>
        <div class="form-group"><label for="dbd-a-d">${esc(_dT('cTo'))}</label><input id="dbd-a-d" type="date" max="${today}" value="${esc(A.d)}"${off} data-on-input="${_on('_dbdStAddIn', 'd', _DBD_EL)}"></div></div>
        <p class="dbd-st-hint">${esc(_dT('sTotalHint'))}</p>`
      : `<div class="form-group"><label for="dbd-a-d">${esc(_dT('cDay'))}</label><input id="dbd-a-d" type="date" max="${today}" value="${esc(A.d)}"${off} data-on-input="${_on('_dbdStAddIn', 'd', _DBD_EL)}"></div>`}
      <div class="form-group"><label for="dbd-a-note">${esc(_dT('sNote'))}</label><input id="dbd-a-note" type="text" maxlength="300" value="${esc(A.note)}"${off} data-on-input="${_on('_dbdStAddIn', 'note', _DBD_EL)}"></div>
      <div class="cmy-rej-act"><button type="button" class="btn-secondary"${off} data-on-click="${_on('_dbdStAddClose')}">${esc(_dT('cancel'))}</button>
        <button type="button" class="btn-primary" id="dbd-a-save"${off} data-on-click="${_on('_dbdStAddSave')}">${esc(_dT('add'))}</button></div>
    </div></div>`;
  if (A.q && !A.id) _dbdStAddHits();
}
async function _dbdStAddSave() {
  const A = S._dbdA; if (!A || A.busy) return;
  const km = _dbdRead(A.km), max = A.kind === 'total' ? 50000 : 300, today = todayStr(), ymd = /^\d{4}-\d\d-\d\d$/;
  if (!A.id) { toast(_dT('sFind'), 'error'); return; }
  if (!(km >= 1 && km <= max)) { toast(_dT('eKm'), 'error'); return; }
  if (!ymd.test(A.d) || A.d > today || (A.kind === 'total' && (!ymd.test(A.from) || A.from > A.d))) { toast(_dT('eDate'), 'error'); return; }
  A.busy = true; _dbdStAddPaint();
  let r;
  try { r = await sb.rpc('staff_distance_add', { p_customer: A.id, p_kind: A.kind, p_km: Math.round(km * 10) / 10, p_date: A.d, p_from: A.kind === 'total' ? A.from : null, p_note: A.note.trim() || null, p_session: null }); } catch (e) { r = { error: e }; }
  if (S._dbdA !== A) return;
  A.busy = false;
  const a = r && !r.error && r.data;
  if (!a || !a.ok) { toast(a && a.error === 'km' ? _dT('eKm') : a && a.error === 'date' ? _dT('eDate') : _dT('eNet'), 'error'); _dbdStAddPaint(); return; }
  _dbdStAddClose(); toast(_dT('sSaved'), 'success');
  if (_dbdDep.done) try { _dbdDep.done(); } catch (_) {}
  _dbdStLoad();
}

window._dbdOpen = _dbdOpen;
window._dbdStaff = _dbdStaff;
