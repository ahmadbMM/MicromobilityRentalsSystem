// Safety feedback, the rider's side (the user, 2026-11-21: "i dont want it to be an incident report but more of a way we
// can gather info and feedback on how we can make our services better and safer and more responsive"; migration
// 20261121400000). One page, Account > Safety feedback (/account/safety, ?b=<booking entry> names the booking: the
// My bookings card's button and the website's link both land here):
//   - a booking it can be sent about (ended, within 7 days, not cancelled or a no-show; safety_mine.entries): the rider it
//     is about (the account's own entries on that session), what happened (with an injury where and how serious), before
//     the ride, the cause and what would have prevented it (not when nothing happened), our response (three drawn star
//     rows, first aid with Not needed, a comment), ideas, the required tick and Send (safety_send);
//   - one sent already: what it was about, its state (Received / Followed up / Closed) and the team's reply;
//   - neither (no ?b=, or a booking past its 7 days): the bookings it can still be sent about and the rider's own.
// The database answers every refusal as {ok:false, error}; each one is said in the rider's words (_sfrErr).
// A file of its own, fetched when first needed, with its words in eleven languages; the build stamps its address (SFY_V).
// What it takes from the page comes in window._sfyDeps (app.src.html _sfyLoad), the read itself included (_sfyMineGet:
// the My bookings card shows the same answer). Hand-written, not generated.
/* global S, sb, esc, _on, _EL, getSession */
const SFR_LANGS = ['en', 'ar', 'fr', 'es', 'pt', 'ur', 'hi', 'tl', 'ne', 'bn', 'ms'];
const SFR_T = {
  intro: ['Tell us how safe this felt and how our team looked after you. It helps us make every ride safer and respond faster.', 'أخبرنا كم شعرت بالأمان وكيف اعتنى بك فريقنا. يساعدنا ذلك على جعل كل جولة أكثر أماناً والاستجابة أسرع.', 'Dites-nous si vous vous êtes senti en sécurité et comment notre équipe s’est occupée de vous. Cela nous aide à rendre chaque sortie plus sûre et à réagir plus vite.', 'Cuéntanos qué tan seguro te sentiste y cómo te atendió nuestro equipo. Nos ayuda a que cada salida sea más segura y a responder más rápido.', 'Diga-nos quão seguro se sentiu e como a nossa equipa cuidou de si. Ajuda-nos a tornar cada passeio mais seguro e a responder mais depressa.', 'ہمیں بتائیں کہ آپ نے کتنا محفوظ محسوس کیا اور ہماری ٹیم نے آپ کا کیسے خیال رکھا۔ اس سے ہمیں ہر رائیڈ کو زیادہ محفوظ بنانے اور جلد جواب دینے میں مدد ملتی ہے۔', 'हमें बताएँ कि आपने कितना सुरक्षित महसूस किया और हमारी टीम ने आपका कैसे ध्यान रखा। इससे हमें हर राइड को ज़्यादा सुरक्षित बनाने और जल्दी मदद करने में सहायता मिलती है।', 'Sabihin sa amin kung gaano ka naging ligtas at kung paano ka inalagaan ng aming team. Tumutulong ito para gawing mas ligtas ang bawat ride at mas mabilis kaming tumugon.', 'तपाईं कति सुरक्षित महसुस गर्नुभयो र हाम्रो टोलीले तपाईंको कसरी हेरचाह गर्‍यो, हामीलाई भन्नुहोस्। यसले हरेक सवारीलाई अझ सुरक्षित बनाउन र छिटो सहयोग गर्न मद्दत गर्छ।', 'আপনি কতটা নিরাপদ বোধ করেছেন এবং আমাদের দল কীভাবে আপনার যত্ন নিয়েছে, আমাদের জানান। এতে প্রতিটি রাইড আরও নিরাপদ করতে এবং দ্রুত সাড়া দিতে আমাদের সুবিধা হয়।', 'Beritahu kami betapa selamat anda rasa dan bagaimana pasukan kami menjaga anda. Ia membantu kami menjadikan setiap kayuhan lebih selamat dan bertindak lebih pantas.'],
  who: ['Who is this about?', 'عمّن هذه الملاحظات؟', 'De qui s’agit-il ?', '¿De quién se trata?', 'De quem se trata?', 'یہ کس کے بارے میں ہے؟', 'यह किसके बारे में है?', 'Tungkol kanino ito?', 'यो कसको बारेमा हो?', 'এটি কার সম্পর্কে?', 'Tentang siapa?'],
  q1: ['What happened?', 'ماذا حدث؟', 'Que s’est-il passé ?', '¿Qué pasó?', 'O que aconteceu?', 'کیا ہوا؟', 'क्या हुआ?', 'Ano ang nangyari?', 'के भयो?', 'কী হয়েছিল?', 'Apa yang berlaku?'],
  k_none: ['Nothing happened', 'لم يحدث شيء', 'Rien ne s’est passé', 'No pasó nada', 'Não aconteceu nada', 'کچھ نہیں ہوا', 'कुछ नहीं हुआ', 'Walang nangyari', 'केही भएन', 'কিছুই হয়নি', 'Tiada apa-apa berlaku'],
  k_near_miss: ['A near miss', 'كاد يقع حادث', 'J’ai failli avoir un accident', 'Casi tuve un accidente', 'Quase tive um acidente', 'حادثہ ہوتے ہوتے بچا', 'दुर्घटना होते-होते बची', 'Muntik nang maaksidente', 'दुर्घटना हुँदाहुँदै जोगियो', 'অল্পের জন্য দুর্ঘটনা এড়ানো গেছে', 'Hampir berlaku kemalangan'],
  k_unsafe: ['I felt unsafe', 'شعرت بعدم الأمان', 'Je ne me suis pas senti en sécurité', 'No me sentí seguro', 'Não me senti seguro', 'میں نے خود کو غیر محفوظ محسوس کیا', 'मुझे असुरक्षित लगा', 'Hindi ako nakaramdam ng kaligtasan', 'मलाई असुरक्षित लाग्यो', 'আমি নিরাপদ বোধ করিনি', 'Saya rasa tidak selamat'],
  k_fall: ['A fall', 'سقوط', 'Une chute', 'Una caída', 'Uma queda', 'گر گئے', 'गिर गए', 'Natumba', 'लडियो', 'পড়ে গিয়েছিলাম', 'Terjatuh'],
  k_crash: ['A crash', 'اصطدام', 'Une collision', 'Un choque', 'Uma colisão', 'ٹکر', 'टक्कर', 'Bumangga', 'ठोक्कियो', 'ধাক্কা লেগেছিল', 'Perlanggaran'],
  k_injury: ['An injury', 'إصابة', 'Une blessure', 'Una lesión', 'Uma lesão', 'چوٹ', 'चोट', 'Nasaktan', 'चोट', 'আঘাত', 'Kecederaan'],
  parts: ['Where were you hurt?', 'أين أُصبت؟', 'Où avez-vous été blessé ?', '¿Dónde te lastimaste?', 'Onde se magoou?', 'آپ کو کہاں چوٹ لگی؟', 'आपको कहाँ चोट लगी?', 'Saan ka nasaktan?', 'तपाईंलाई कहाँ चोट लाग्यो?', 'কোথায় আঘাত পেয়েছেন?', 'Di mana anda cedera?'],
  p_head: ['Head', 'الرأس', 'Tête', 'Cabeza', 'Cabeça', 'سر', 'सिर', 'Ulo', 'टाउको', 'মাথা', 'Kepala'],
  p_face: ['Face', 'الوجه', 'Visage', 'Cara', 'Rosto', 'چہرہ', 'चेहरा', 'Mukha', 'अनुहार', 'মুখ', 'Muka'],
  p_neck: ['Neck', 'الرقبة', 'Cou', 'Cuello', 'Pescoço', 'گردن', 'गर्दन', 'Leeg', 'घाँटी', 'ঘাড়', 'Leher'],
  p_shoulder: ['Shoulder', 'الكتف', 'Épaule', 'Hombro', 'Ombro', 'کندھا', 'कंधा', 'Balikat', 'काँध', 'কাঁধ', 'Bahu'],
  p_arm: ['Arm or elbow', 'الذراع أو المرفق', 'Bras ou coude', 'Brazo o codo', 'Braço ou cotovelo', 'بازو یا کہنی', 'बाँह या कोहनी', 'Braso o siko', 'पाखुरा वा कुहिनो', 'হাত বা কনুই', 'Lengan atau siku'],
  p_hand: ['Hand or wrist', 'اليد أو المعصم', 'Main ou poignet', 'Mano o muñeca', 'Mão ou pulso', 'ہاتھ یا کلائی', 'हाथ या कलाई', 'Kamay o pulso', 'हात वा नाडी', 'হাত বা কব্জি', 'Tangan atau pergelangan'],
  p_chest: ['Chest or ribs', 'الصدر أو الأضلاع', 'Poitrine ou côtes', 'Pecho o costillas', 'Peito ou costelas', 'سینہ یا پسلیاں', 'छाती या पसलियाँ', 'Dibdib o tadyang', 'छाती वा करङ', 'বুক বা পাঁজর', 'Dada atau rusuk'],
  p_back: ['Back', 'الظهر', 'Dos', 'Espalda', 'Costas', 'کمر', 'पीठ', 'Likod', 'ढाड', 'পিঠ', 'Belakang'],
  p_hip: ['Hip', 'الورك', 'Hanche', 'Cadera', 'Anca', 'کولہا', 'कूल्हा', 'Balakang', 'कम्मर', 'নিতম্ব', 'Pinggul'],
  p_leg: ['Leg', 'الساق', 'Jambe', 'Pierna', 'Perna', 'ٹانگ', 'पैर (टाँग)', 'Binti', 'खुट्टा', 'পা', 'Kaki'],
  p_knee: ['Knee', 'الركبة', 'Genou', 'Rodilla', 'Joelho', 'گھٹنا', 'घुटना', 'Tuhod', 'घुँडा', 'হাঁটু', 'Lutut'],
  p_foot: ['Foot or ankle', 'القدم أو الكاحل', 'Pied ou cheville', 'Pie o tobillo', 'Pé ou tornozelo', 'پاؤں یا ٹخنہ', 'पंजा या टखना', 'Paa o bukung-bukong', 'पाउ वा गोलीगाँठो', 'পায়ের পাতা বা গোড়ালি', 'Kaki atau buku lali'],
  p_other: ['Somewhere else', 'مكان آخر', 'Ailleurs', 'En otro lugar', 'Noutro sítio', 'کہیں اور', 'कहीं और', 'Sa ibang bahagi', 'अन्य ठाउँमा', 'অন্য কোথাও', 'Bahagian lain'],
  sev: ['How serious was it?', 'ما مدى خطورتها؟', 'Quelle gravité ?', '¿Qué tan grave fue?', 'Qual foi a gravidade?', 'یہ کتنی سنگین تھی؟', 'यह कितनी गंभीर थी?', 'Gaano ito kalala?', 'यो कति गम्भीर थियो?', 'এটি কতটা গুরুতর ছিল?', 'Betapa serius?'],
  s_minor: ['Minor, no treatment', 'بسيطة، دون علاج', 'Légère, sans soins', 'Leve, sin tratamiento', 'Ligeira, sem tratamento', 'معمولی، علاج کی ضرورت نہیں', 'मामूली, इलाज नहीं चाहिए', 'Maliit, walang gamutan', 'सामान्य, उपचार चाहिएन', 'সামান্য, চিকিৎসা লাগেনি', 'Ringan, tiada rawatan'],
  s_first_aid: ['First aid at the ride', 'إسعافات أولية في المكان', 'Premiers secours sur place', 'Primeros auxilios en el lugar', 'Primeiros socorros no local', 'موقع پر ابتدائی طبی امداد', 'मौके पर प्राथमिक उपचार', 'First aid sa lugar', 'घटनास्थलमै प्राथमिक उपचार', 'ঘটনাস্থলে প্রাথমিক চিকিৎসা', 'Bantuan kecemasan di lokasi'],
  s_clinic: ['Saw a clinic or doctor', 'زرت عيادة أو طبيباً', 'Vu un médecin ou une clinique', 'Fui a una clínica o médico', 'Fui a uma clínica ou médico', 'کلینک یا ڈاکٹر کے پاس گئے', 'क्लिनिक या डॉक्टर के पास गए', 'Nagpatingin sa klinika o doktor', 'क्लिनिक वा डाक्टरकहाँ गएँ', 'ক্লিনিক বা ডাক্তারের কাছে গিয়েছি', 'Berjumpa klinik atau doktor'],
  s_hospital: ['Went to hospital', 'ذهبت إلى المستشفى', 'Allé à l’hôpital', 'Fui al hospital', 'Fui ao hospital', 'ہسپتال گئے', 'अस्पताल गए', 'Nagpunta sa ospital', 'अस्पताल गएँ', 'হাসপাতালে গিয়েছি', 'Ke hospital'],
  q2: ['Before the ride', 'قبل الجولة', 'Avant la sortie', 'Antes de la salida', 'Antes do passeio', 'رائیڈ سے پہلے', 'राइड से पहले', 'Bago ang ride', 'सवारी अघि', 'রাইডের আগে', 'Sebelum kayuhan'],
  brief: ['Was the safety briefing clear?', 'هل كان شرح السلامة واضحاً؟', 'Les consignes de sécurité étaient-elles claires ?', '¿Fueron claras las indicaciones de seguridad?', 'As instruções de segurança foram claras?', 'کیا حفاظتی ہدایات واضح تھیں؟', 'क्या सुरक्षा निर्देश साफ़ थे?', 'Malinaw ba ang safety briefing?', 'के सुरक्षा निर्देशन स्पष्ट थियो?', 'নিরাপত্তা নির্দেশনা কি স্পষ্ট ছিল?', 'Adakah taklimat keselamatan jelas?'],
  helmet: ['Did your helmet fit well?', 'هل كانت الخوذة مناسبة لك؟', 'Votre casque était-il bien ajusté ?', '¿Te quedaba bien el casco?', 'O capacete ficou-lhe bem?', 'کیا ہیلمٹ ٹھیک فٹ تھا؟', 'क्या हेलमेट ठीक से फिट था?', 'Tama ba ang sukat ng helmet mo?', 'के हेल्मेट ठिकसँग मिल्यो?', 'হেলমেট কি ঠিকমতো ফিট ছিল?', 'Adakah topi keledar anda muat?'],
  bike: ['Was the bike the right size and in good shape?', 'هل كانت الدراجة بالمقاس المناسب وفي حالة جيدة؟', 'Le vélo était-il à la bonne taille et en bon état ?', '¿La bici era de tu talla y estaba en buen estado?', 'A bicicleta era do tamanho certo e estava em bom estado?', 'کیا سائیکل صحیح سائز کی اور اچھی حالت میں تھی؟', 'क्या साइकिल सही साइज़ की और अच्छी हालत में थी?', 'Tama ba ang sukat ng bike at maayos ba ito?', 'के साइकल सही साइजको र राम्रो अवस्थामा थियो?', 'সাইকেলটি কি সঠিক মাপের ও ভালো অবস্থায় ছিল?', 'Adakah basikal saiz yang betul dan dalam keadaan baik?'],
  ready: ['Did you feel ready for the route?', 'هل شعرت بأنك مستعد للمسار؟', 'Vous sentiez-vous prêt pour le parcours ?', '¿Te sentiste preparado para la ruta?', 'Sentiu-se preparado para o percurso?', 'کیا آپ راستے کے لیے تیار محسوس کر رہے تھے؟', 'क्या आप रूट के लिए तैयार महसूस कर रहे थे?', 'Handa ka ba sa ruta?', 'के तपाईं बाटोका लागि तयार महसुस गर्नुहुन्थ्यो?', 'আপনি কি রুটের জন্য প্রস্তুত বোধ করেছিলেন?', 'Adakah anda rasa bersedia untuk laluan itu?'],
  a_yes: ['Yes', 'نعم', 'Oui', 'Sí', 'Sim', 'ہاں', 'हाँ', 'Oo', 'हो', 'হ্যাঁ', 'Ya'],
  a_partly: ['Partly', 'جزئياً', 'En partie', 'En parte', 'Em parte', 'کسی حد تک', 'कुछ हद तक', 'Medyo', 'केही हदसम्म', 'আংশিক', 'Sebahagian'],
  a_no: ['No', 'لا', 'Non', 'No', 'Não', 'نہیں', 'नहीं', 'Hindi', 'होइन', 'না', 'Tidak'],
  b_none: ['There was no briefing', 'لم يكن هناك شرح', 'Il n’y a pas eu de consignes', 'No hubo indicaciones', 'Não houve instruções', 'کوئی ہدایات نہیں دی گئیں', 'कोई निर्देश नहीं दिए गए', 'Walang briefing', 'कुनै निर्देशन थिएन', 'কোনো নির্দেশনা ছিল না', 'Tiada taklimat'],
  h_none: ['I did not wear one', 'لم أرتدِ خوذة', 'Je n’en portais pas', 'No llevé casco', 'Não usei', 'میں نے نہیں پہنا', 'मैंने नहीं पहना', 'Hindi ako nagsuot', 'मैले लगाइनँ', 'আমি পরিনি', 'Saya tidak memakainya'],
  q3: ['What caused it?', 'ما السبب؟', 'Qu’est-ce qui l’a causé ?', '¿Qué lo causó?', 'O que o causou?', 'اس کی وجہ کیا تھی؟', 'इसकी वजह क्या थी?', 'Ano ang naging sanhi?', 'यसको कारण के थियो?', 'এর কারণ কী ছিল?', 'Apa puncanya?'],
  c_bike_condition: ['The bike’s condition', 'حالة الدراجة', 'L’état du vélo', 'El estado de la bici', 'O estado da bicicleta', 'سائیکل کی حالت', 'साइकिल की हालत', 'Kondisyon ng bike', 'साइकलको अवस्था', 'সাইকেলের অবস্থা', 'Keadaan basikal'],
  c_bike_size: ['The bike’s size', 'مقاس الدراجة', 'La taille du vélo', 'La talla de la bici', 'O tamanho da bicicleta', 'سائیکل کا سائز', 'साइकिल का साइज़', 'Sukat ng bike', 'साइकलको साइज', 'সাইকেলের মাপ', 'Saiz basikal'],
  c_route: ['The route or road surface', 'المسار أو سطح الطريق', 'Le parcours ou la chaussée', 'La ruta o el pavimento', 'O percurso ou o piso', 'راستہ یا سڑک کی سطح', 'रास्ता या सड़क की सतह', 'Ruta o kalsada', 'बाटो वा सडकको सतह', 'রুট বা রাস্তার উপরিভাগ', 'Laluan atau permukaan jalan'],
  c_other_people: ['Other people or vehicles', 'أشخاص آخرون أو مركبات', 'D’autres personnes ou véhicules', 'Otras personas o vehículos', 'Outras pessoas ou veículos', 'دوسرے لوگ یا گاڑیاں', 'दूसरे लोग या गाड़ियाँ', 'Ibang tao o sasakyan', 'अरू मान्छे वा सवारी साधन', 'অন্য মানুষ বা যানবাহন', 'Orang lain atau kenderaan'],
  c_speed: ['Speed', 'السرعة', 'La vitesse', 'La velocidad', 'A velocidade', 'رفتار', 'रफ़्तार', 'Bilis', 'गति', 'গতি', 'Kelajuan'],
  c_weather: ['The weather', 'الطقس', 'La météo', 'El clima', 'O tempo', 'موسم', 'मौसम', 'Panahon', 'मौसम', 'আবহাওয়া', 'Cuaca'],
  c_other: ['Something else', 'شيء آخر', 'Autre chose', 'Otra cosa', 'Outra coisa', 'کچھ اور', 'कुछ और', 'Iba pa', 'अरू केही', 'অন্য কিছু', 'Lain-lain'],
  prevent: ['What would have prevented it?', 'ما الذي كان سيمنع حدوثه؟', 'Qu’est-ce qui l’aurait évité ?', '¿Qué lo habría evitado?', 'O que o teria evitado?', 'کس چیز سے اسے روکا جا سکتا تھا؟', 'इसे किस चीज़ से रोका जा सकता था?', 'Ano sana ang nakapigil dito?', 'के कुराले यसलाई रोक्न सक्थ्यो?', 'কী করলে এটি এড়ানো যেত?', 'Apa yang boleh mengelakkannya?'],
  q4: ['How did our team respond?', 'كيف كانت استجابة فريقنا؟', 'Comment notre équipe a-t-elle réagi ?', '¿Cómo respondió nuestro equipo?', 'Como respondeu a nossa equipa?', 'ہماری ٹیم نے کیسے ردعمل دیا؟', 'हमारी टीम ने कैसे मदद की?', 'Paano tumugon ang aming team?', 'हाम्रो टोलीले कसरी सहयोग गर्‍यो?', 'আমাদের দল কীভাবে সাড়া দিয়েছে?', 'Bagaimana pasukan kami bertindak?'],
  r_speed: ['How quickly we came to help', 'سرعة وصولنا للمساعدة', 'La rapidité de notre aide', 'Lo rápido que llegamos a ayudar', 'A rapidez com que viemos ajudar', 'ہم کتنی جلدی مدد کو پہنچے', 'हम कितनी जल्दी मदद को पहुँचे', 'Gaano kami kabilis tumulong', 'हामी कति छिटो सहयोग गर्न आयौं', 'আমরা কত দ্রুত সাহায্য করতে এসেছি', 'Betapa pantas kami datang membantu'],
  r_care: ['How well we looked after you', 'مدى اعتنائنا بك', 'La façon dont nous avons pris soin de vous', 'Qué tan bien te cuidamos', 'Como cuidámos de si', 'ہم نے آپ کا کتنا اچھا خیال رکھا', 'हमने आपका कितना अच्छा ध्यान रखा', 'Gaano ka namin inalagaan', 'हामीले तपाईंको कति राम्रो हेरचाह गर्‍यौं', 'আমরা আপনার কতটা ভালো যত্ন নিয়েছি', 'Betapa baik kami menjaga anda'],
  r_fa: ['First aid', 'الإسعافات الأولية', 'Premiers secours', 'Primeros auxilios', 'Primeiros socorros', 'ابتدائی طبی امداد', 'प्राथमिक उपचार', 'First aid', 'प्राथमिक उपचार', 'প্রাথমিক চিকিৎসা', 'Bantuan kecemasan'],
  fa_na: ['Not needed', 'لم تكن مطلوبة', 'Pas nécessaires', 'No fueron necesarios', 'Não foram precisos', 'ضرورت نہیں پڑی', 'ज़रूरत नहीं पड़ी', 'Hindi kailangan', 'आवश्यक परेन', 'প্রয়োজন হয়নি', 'Tidak perlu'],
  starsOf: ['{0} out of 5', '{0} من 5', '{0} sur 5', '{0} de 5', '{0} em 5', '5 میں سے {0}', '5 में से {0}', '{0} sa 5', '5 मध्ये {0}', '5-এর মধ্যে {0}', '{0} daripada 5'],
  comment: ['Anything about how we responded?', 'هل لديك ما تقوله عن استجابتنا؟', 'Quelque chose à dire sur notre réaction ?', '¿Algo sobre cómo respondimos?', 'Algo sobre como respondemos?', 'ہمارے ردعمل کے بارے میں کچھ کہنا ہے؟', 'हमारी मदद के बारे में कुछ कहना है?', 'May masasabi ka ba sa aming pagtugon?', 'हाम्रो सहयोगबारे केही भन्नु छ?', 'আমাদের সাড়া দেওয়া নিয়ে কিছু বলবেন?', 'Ada apa-apa tentang tindakan kami?'],
  q5: ['How can we make our rides safer?', 'كيف نجعل جولاتنا أكثر أماناً؟', 'Comment rendre nos sorties plus sûres ?', '¿Cómo podemos hacer nuestras salidas más seguras?', 'Como podemos tornar os nossos passeios mais seguros?', 'ہم اپنی رائیڈز کو زیادہ محفوظ کیسے بنا سکتے ہیں؟', 'हम अपनी राइड्स को और सुरक्षित कैसे बना सकते हैं?', 'Paano namin gagawing mas ligtas ang aming mga ride?', 'हामी आफ्ना सवारीहरू अझ सुरक्षित कसरी बनाउन सक्छौं?', 'আমরা কীভাবে আমাদের রাইড আরও নিরাপদ করতে পারি?', 'Bagaimana kami boleh menjadikan kayuhan lebih selamat?'],
  optional: ['optional', 'اختياري', 'facultatif', 'opcional', 'opcional', 'اختیاری', 'वैकल्पिक', 'opsyonal', 'ऐच्छिक', 'ঐচ্ছিক', 'pilihan'],
  consent: ['I agree MicroMobility may use this to improve safety and follow up with me.', 'أوافق على أن تستخدم MicroMobility هذه المعلومات لتحسين السلامة والتواصل معي للمتابعة.', 'J’accepte que MicroMobility utilise ces informations pour améliorer la sécurité et me recontacter.', 'Acepto que MicroMobility use esto para mejorar la seguridad y hacerme seguimiento.', 'Aceito que a MicroMobility use isto para melhorar a segurança e entrar em contacto comigo.', 'میں اتفاق کرتا ہوں کہ MicroMobility اسے حفاظت بہتر بنانے اور مجھ سے رابطہ کرنے کے لیے استعمال کر سکتی ہے۔', 'मैं सहमत हूँ कि MicroMobility इसका उपयोग सुरक्षा बेहतर करने और मुझसे संपर्क करने के लिए कर सकती है।', 'Pumapayag akong gamitin ito ng MicroMobility para mapabuti ang kaligtasan at makipag-ugnayan sa akin.', 'म सहमत छु कि MicroMobility ले यसलाई सुरक्षा सुधार्न र मसँग सम्पर्क गर्न प्रयोग गर्न सक्छ।', 'আমি সম্মত যে MicroMobility এটি নিরাপত্তা উন্নত করতে এবং আমার সঙ্গে যোগাযোগ করতে ব্যবহার করতে পারে।', 'Saya bersetuju MicroMobility boleh menggunakan ini untuk meningkatkan keselamatan dan menghubungi saya.'],
  send: ['Send feedback', 'أرسل الملاحظات', 'Envoyer', 'Enviar', 'Enviar', 'بھیجیں', 'भेजें', 'Ipadala', 'पठाउनुहोस्', 'পাঠান', 'Hantar'],
  sent: ['Thank you. Our team will read it and follow up with you if needed.', 'شكراً لك. سيقرؤها فريقنا ويتواصل معك عند الحاجة.', 'Merci. Notre équipe va la lire et vous recontactera si besoin.', 'Gracias. Nuestro equipo la leerá y te contactará si hace falta.', 'Obrigado. A nossa equipa vai lê-la e contactá-lo se for preciso.', 'شکریہ۔ ہماری ٹیم اسے پڑھے گی اور ضرورت ہو تو آپ سے رابطہ کرے گی۔', 'धन्यवाद। हमारी टीम इसे पढ़ेगी और ज़रूरत हो तो आपसे संपर्क करेगी।', 'Salamat. Babasahin ito ng aming team at makikipag-ugnayan sa iyo kung kailangan.', 'धन्यवाद। हाम्रो टोलीले यो पढ्नेछ र आवश्यक परे तपाईंलाई सम्पर्क गर्नेछ।', 'ধন্যবাদ। আমাদের দল এটি পড়বে এবং প্রয়োজনে আপনার সঙ্গে যোগাযোগ করবে।', 'Terima kasih. Pasukan kami akan membacanya dan menghubungi anda jika perlu.'],
  st_new: ['Received', 'تم الاستلام', 'Reçu', 'Recibido', 'Recebido', 'موصول', 'मिल गया', 'Natanggap', 'प्राप्त भयो', 'পাওয়া গেছে', 'Diterima'],
  st_followed: ['Followed up', 'تمت المتابعة', 'Suivi effectué', 'Con seguimiento', 'Acompanhado', 'پیروی کی گئی', 'फ़ॉलो-अप हुआ', 'Na-follow up', 'फलो-अप भयो', 'ফলো-আপ হয়েছে', 'Telah disusuli'],
  st_closed: ['Closed', 'مغلقة', 'Clôturé', 'Cerrado', 'Encerrado', 'بند', 'बंद', 'Sarado', 'बन्द', 'বন্ধ', 'Ditutup'],
  reply: ['Reply from our team', 'رد من فريقنا', 'Réponse de notre équipe', 'Respuesta de nuestro equipo', 'Resposta da nossa equipa', 'ہماری ٹیم کا جواب', 'हमारी टीम का जवाब', 'Sagot ng aming team', 'हाम्रो टोलीको जवाफ', 'আমাদের দলের উত্তর', 'Balasan pasukan kami'],
  mineH: ['Your safety feedback', 'ملاحظاتك عن السلامة', 'Vos retours sur la sécurité', 'Tus comentarios de seguridad', 'Os seus comentários de segurança', 'آپ کی حفاظتی رائے', 'आपकी सुरक्षा प्रतिक्रिया', 'Ang iyong safety feedback', 'तपाईंको सुरक्षा प्रतिक्रिया', 'আপনার নিরাপত্তা মতামত', 'Maklum balas keselamatan anda'],
  dueH: ['Bookings you can tell us about', 'حجوزات يمكنك إخبارنا عنها', 'Réservations dont vous pouvez nous parler', 'Reservas sobre las que puedes contarnos', 'Reservas sobre as quais nos pode falar', 'بکنگز جن کے بارے میں آپ بتا سکتے ہیں', 'बुकिंग जिनके बारे में आप बता सकते हैं', 'Mga booking na maaari mong ikuwento', 'बुकिङहरू जसबारे तपाईं भन्न सक्नुहुन्छ', 'যে বুকিংগুলো নিয়ে আপনি জানাতে পারেন', 'Tempahan yang boleh anda ceritakan'],
  dueNone: ['Nothing from the last 7 days to tell us about.', 'لا شيء من آخر 7 أيام لتخبرنا عنه.', 'Rien des 7 derniers jours à nous signaler.', 'Nada de los últimos 7 días que contarnos.', 'Nada dos últimos 7 dias para nos contar.', 'پچھلے 7 دنوں میں بتانے کے لیے کچھ نہیں۔', 'पिछले 7 दिनों में बताने के लिए कुछ नहीं।', 'Walang maikukuwento mula sa nakaraang 7 araw.', 'पछिल्ला 7 दिनमा भन्नुपर्ने केही छैन।', 'গত 7 দিনে জানানোর মতো কিছু নেই।', 'Tiada apa-apa daripada 7 hari lalu untuk diceritakan.'],
  tell: ['Tell us', 'أخبرنا', 'Nous en parler', 'Cuéntanos', 'Conte-nos', 'ہمیں بتائیں', 'हमें बताएँ', 'Ikuwento', 'हामीलाई भन्नुहोस्', 'আমাদের জানান', 'Beritahu kami'],
  another: ['Tell us about another rider on this booking', 'أخبرنا عن راكب آخر في هذا الحجز', 'Parlez-nous d’un autre participant de cette réservation', 'Cuéntanos sobre otra persona de esta reserva', 'Fale-nos de outra pessoa desta reserva', 'اس بکنگ کے کسی اور رائیڈر کے بارے میں بتائیں', 'इस बुकिंग के किसी दूसरे राइडर के बारे में बताएँ', 'Ikuwento ang ibang rider sa booking na ito', 'यो बुकिङका अर्को सवारबारे भन्नुहोस्', 'এই বুকিংয়ের অন্য কোনো রাইডার সম্পর্কে জানান', 'Ceritakan tentang penunggang lain dalam tempahan ini'],
  late: ['Safety feedback can be sent until 7 days after a ride ends.', 'يمكن إرسال ملاحظات السلامة حتى 7 أيام بعد انتهاء الجولة.', 'Vous pouvez envoyer un retour jusqu’à 7 jours après la fin d’une sortie.', 'Puedes enviar comentarios hasta 7 días después de que termine una salida.', 'Pode enviar comentários até 7 dias depois do fim de um passeio.', 'حفاظتی رائے رائیڈ ختم ہونے کے 7 دن بعد تک بھیجی جا سکتی ہے۔', 'सुरक्षा प्रतिक्रिया राइड खत्म होने के 7 दिन बाद तक भेजी जा सकती है।', 'Maaaring magpadala ng safety feedback hanggang 7 araw matapos ang ride.', 'सवारी सकिएको 7 दिनसम्म सुरक्षा प्रतिक्रिया पठाउन सकिन्छ।', 'রাইড শেষ হওয়ার 7 দিন পর পর্যন্ত নিরাপত্তা মতামত পাঠানো যায়।', 'Maklum balas keselamatan boleh dihantar sehingga 7 hari selepas kayuhan tamat.'],
  errKind: ['Pick what happened.', 'اختر ما حدث.', 'Choisissez ce qui s’est passé.', 'Elige qué pasó.', 'Escolha o que aconteceu.', 'منتخب کریں کہ کیا ہوا۔', 'चुनें कि क्या हुआ।', 'Piliin kung ano ang nangyari.', 'के भयो छान्नुहोस्।', 'কী হয়েছিল বেছে নিন।', 'Pilih apa yang berlaku.'],
  errSev: ['Say how serious the injury was.', 'حدّد مدى خطورة الإصابة.', 'Indiquez la gravité de la blessure.', 'Indica qué tan grave fue la lesión.', 'Indique a gravidade da lesão.', 'بتائیں کہ چوٹ کتنی سنگین تھی۔', 'बताएँ कि चोट कितनी गंभीर थी।', 'Sabihin kung gaano kalala ang pinsala.', 'चोट कति गम्भीर थियो भन्नुहोस्।', 'আঘাত কতটা গুরুতর ছিল জানান।', 'Nyatakan betapa serius kecederaan itu.'],
  errConsent: ['Tick the box to send it.', 'ضع علامة في المربع لإرسالها.', 'Cochez la case pour l’envoyer.', 'Marca la casilla para enviarlo.', 'Marque a caixa para enviar.', 'بھیجنے کے لیے خانے پر نشان لگائیں۔', 'भेजने के लिए बॉक्स पर टिक करें।', 'Lagyan ng tsek ang kahon para maipadala.', 'पठाउन बाकसमा चिनो लगाउनुहोस्।', 'পাঠাতে বাক্সে টিক দিন।', 'Tandakan kotak untuk menghantarnya.'],
  errEntry: ['This booking cannot take safety feedback.', 'لا يمكن إرسال ملاحظات سلامة عن هذا الحجز.', 'Cette réservation ne peut pas recevoir de retour.', 'Esta reserva no admite comentarios de seguridad.', 'Esta reserva não aceita comentários de segurança.', 'اس بکنگ پر حفاظتی رائے نہیں بھیجی جا سکتی۔', 'इस बुकिंग पर सुरक्षा प्रतिक्रिया नहीं भेजी जा सकती।', 'Hindi maaaring magpadala ng safety feedback para sa booking na ito.', 'यो बुकिङमा सुरक्षा प्रतिक्रिया पठाउन मिल्दैन।', 'এই বুকিংয়ে নিরাপত্তা মতামত পাঠানো যায় না।', 'Tempahan ini tidak boleh menerima maklum balas keselamatan.'],
  errEarly: ['You can send it once the ride has ended.', 'يمكنك إرسالها بعد انتهاء الجولة.', 'Vous pourrez l’envoyer une fois la sortie terminée.', 'Podrás enviarlo cuando termine la salida.', 'Pode enviar quando o passeio terminar.', 'رائیڈ ختم ہونے کے بعد آپ اسے بھیج سکتے ہیں۔', 'राइड खत्म होने के बाद आप इसे भेज सकते हैं।', 'Maaari mo itong ipadala kapag tapos na ang ride.', 'सवारी सकिएपछि पठाउन सक्नुहुन्छ।', 'রাইড শেষ হলে আপনি এটি পাঠাতে পারবেন।', 'Anda boleh menghantarnya selepas kayuhan tamat.'],
  errLate: ['It is more than 7 days since this ride ended.', 'مرّ أكثر من 7 أيام على انتهاء هذه الجولة.', 'Cette sortie s’est terminée il y a plus de 7 jours.', 'Han pasado más de 7 días desde que terminó esta salida.', 'Passaram mais de 7 dias desde o fim deste passeio.', 'اس رائیڈ کو ختم ہوئے 7 دن سے زیادہ ہو گئے ہیں۔', 'इस राइड को खत्म हुए 7 दिन से ज़्यादा हो गए हैं।', 'Mahigit 7 araw na mula nang matapos ang ride na ito.', 'यो सवारी सकिएको 7 दिनभन्दा बढी भयो।', 'এই রাইড শেষ হওয়ার পর 7 দিনের বেশি হয়ে গেছে।', 'Sudah lebih 7 hari sejak kayuhan ini tamat.'],
  errDup: ['Feedback about this rider on this booking was sent already.', 'سبق إرسال ملاحظات عن هذا الراكب في هذا الحجز.', 'Un retour sur ce participant pour cette réservation a déjà été envoyé.', 'Ya se enviaron comentarios sobre esta persona en esta reserva.', 'Já foram enviados comentários sobre esta pessoa nesta reserva.', 'اس بکنگ پر اس رائیڈر کی رائے پہلے ہی بھیجی جا چکی ہے۔', 'इस बुकिंग पर इस राइडर की प्रतिक्रिया पहले ही भेजी जा चुकी है।', 'Naipadala na ang feedback tungkol sa rider na ito sa booking na ito.', 'यो बुकिङमा यो सवारको प्रतिक्रिया पहिल्यै पठाइसकिएको छ।', 'এই বুকিংয়ে এই রাইডারের মতামত আগেই পাঠানো হয়েছে।', 'Maklum balas tentang penunggang ini dalam tempahan ini sudah dihantar.'],
  errInvalid: ['Something in the form could not be read. Check it and try again.', 'تعذّرت قراءة شيء في النموذج. راجعه وحاول مرة أخرى.', 'Une partie du formulaire n’a pas pu être lue. Vérifiez et réessayez.', 'No se pudo leer algo del formulario. Revísalo e inténtalo de nuevo.', 'Não foi possível ler algo no formulário. Verifique e tente de novo.', 'فارم میں کچھ پڑھا نہیں جا سکا۔ دیکھ کر دوبارہ کوشش کریں۔', 'फ़ॉर्म में कुछ पढ़ा नहीं जा सका। जाँचें और फिर कोशिश करें।', 'May bahagi ng form na hindi mabasa. Suriin at subukang muli.', 'फारमको केही भाग पढ्न सकिएन। जाँचेर फेरि प्रयास गर्नुहोस्।', 'ফর্মের কিছু অংশ পড়া যায়নি। দেখে আবার চেষ্টা করুন।', 'Sebahagian borang tidak dapat dibaca. Semak dan cuba lagi.'],
  errSignin: ['Sign in again to send it.', 'سجّل الدخول مرة أخرى لإرسالها.', 'Reconnectez-vous pour l’envoyer.', 'Vuelve a iniciar sesión para enviarlo.', 'Inicie sessão de novo para enviar.', 'بھیجنے کے لیے دوبارہ سائن ان کریں۔', 'भेजने के लिए फिर से साइन इन करें।', 'Mag-sign in muli para maipadala.', 'पठाउन फेरि साइन इन गर्नुहोस्।', 'পাঠাতে আবার সাইন ইন করুন।', 'Log masuk semula untuk menghantarnya.'],
  errNet: ['It could not be sent. Check your connection and try again.', 'تعذّر الإرسال. تحقق من اتصالك وحاول مرة أخرى.', 'L’envoi a échoué. Vérifiez votre connexion et réessayez.', 'No se pudo enviar. Revisa tu conexión e inténtalo de nuevo.', 'Não foi possível enviar. Verifique a ligação e tente de novo.', 'بھیجا نہیں جا سکا۔ اپنا کنکشن چیک کر کے دوبارہ کوشش کریں۔', 'भेजा नहीं जा सका। अपना कनेक्शन जाँचें और फिर कोशिश करें।', 'Hindi naipadala. Suriin ang koneksyon at subukang muli.', 'पठाउन सकिएन। जडान जाँचेर फेरि प्रयास गर्नुहोस्।', 'পাঠানো যায়নি। সংযোগ দেখে আবার চেষ্টা করুন।', 'Tidak dapat dihantar. Semak sambungan anda dan cuba lagi.'],
  errLoad: ['Your bookings could not be loaded.', 'تعذّر تحميل حجوزاتك.', 'Vos réservations n’ont pas pu être chargées.', 'No se pudieron cargar tus reservas.', 'Não foi possível carregar as suas reservas.', 'آپ کی بکنگز لوڈ نہیں ہو سکیں۔', 'आपकी बुकिंग लोड नहीं हो सकीं।', 'Hindi ma-load ang iyong mga booking.', 'तपाईंका बुकिङ लोड हुन सकेनन्।', 'আপনার বুকিং লোড করা যায়নি।', 'Tempahan anda tidak dapat dimuatkan.'],
  retry: ['Try again', 'حاول مرة أخرى', 'Réessayer', 'Reintentar', 'Tentar de novo', 'دوبارہ کوشش کریں', 'फिर कोशिश करें', 'Subukang muli', 'फेरि प्रयास गर्नुहोस्', 'আবার চেষ্টা করুন', 'Cuba lagi'],
  noDb: ['Safety feedback is not available yet.', 'ملاحظات السلامة غير متاحة بعد.', 'Les retours sur la sécurité ne sont pas encore disponibles.', 'Los comentarios de seguridad aún no están disponibles.', 'Os comentários de segurança ainda não estão disponíveis.', 'حفاظتی رائے ابھی دستیاب نہیں۔', 'सुरक्षा प्रतिक्रिया अभी उपलब्ध नहीं है।', 'Hindi pa available ang safety feedback.', 'सुरक्षा प्रतिक्रिया अहिले उपलब्ध छैन।', 'নিরাপত্তা মতামত এখনও চালু হয়নি।', 'Maklum balas keselamatan belum tersedia.'],
};
const SFR_KINDS = ['none', 'near_miss', 'unsafe', 'fall', 'crash', 'injury'];
const SFR_HURT = ['fall', 'crash', 'injury'];
const SFR_PARTS = ['head', 'face', 'neck', 'shoulder', 'arm', 'hand', 'chest', 'back', 'hip', 'leg', 'knee', 'foot', 'other'];
const SFR_SEV = ['minor', 'first_aid', 'clinic', 'hospital'];
const SFR_CAUSES = ['bike_condition', 'bike_size', 'route', 'other_people', 'speed', 'weather', 'other'];
// The before-the-ride questions: the field, its question, its answers (the word key of each).
const SFR_BEFORE = [['brief', 'brief', [['yes', 'a_yes'], ['partly', 'a_partly'], ['no', 'a_no'], ['none', 'b_none']]],
  ['helm', 'helmet', [['yes', 'a_yes'], ['no', 'a_no'], ['none', 'h_none']]],
  ['bike', 'bike', [['yes', 'a_yes'], ['no', 'a_no']]],
  ['ready', 'ready', [['yes', 'a_yes'], ['partly', 'a_partly'], ['no', 'a_no']]]];
const SFR_MAX = 1000;
function _sfrL(r) { const i = SFR_LANGS.indexOf(S.lang); return r[i < 0 ? 0 : i] || r[0] || ''; }
function _sfrT(k) { return _sfrL(SFR_T[k] || []); }
function _sfrDep() { return window._sfyDeps || {}; }
function _sfrIc(k, px) { const d = _sfrDep(); return d.ic ? d.ic(k, px) : ''; }
function _sfrDate(v) { const d = _sfrDep(); return d.date ? d.date(v) : String(v || '').slice(0, 10); }
// The words a refusal is said in: each error the database answers with, else the network's.
const SFR_ERR = { signin: 'errSignin', consent: 'errConsent', kind: 'errKind', severity: 'errSev', invalid: 'errInvalid', entry: 'errEntry', early: 'errEarly', late: 'errLate', dup: 'errDup' };
function _sfrErr(code) { return _sfrT(SFR_ERR[code] || 'errNet'); }
// The language the words are in, by their script, else the page's (as the testimonial's _tstLang).
function _sfrLang(s) {
  const l = S.lang || 'en';
  if (/[؀-ۿ]/.test(s)) return l === 'ur' ? 'ur' : 'ar';
  if (/[ऀ-ॿ]/.test(s)) return l === 'ne' ? 'ne' : 'hi';
  if (/[ঀ-৿]/.test(s)) return 'bn';
  return SFR_LANGS.includes(l) ? l : 'en';
}
function _sfrStar(on, px) {
  return `<svg aria-hidden="true" class="tst-star${on ? ' on' : ''}" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.7l-5.12 2.7.98-5.72L3.7 9.64l5.75-.84z"/></svg>`;
}
function _sfrSessName(x) { const t = S.lang === 'ar' && x.title_ar ? x.title_ar : x.title; return t || ''; }
function _sfrStLbl(st) { return _sfrT(st === 'followed' ? 'st_followed' : st === 'closed' ? 'st_closed' : 'st_new'); }
function _sfrSt(st) { return `<span class="tst-st sfy-st sfy-st-${esc(st || 'new')}">${esc(_sfrStLbl(st))}</span>`; }

// ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────
// S._sfyM (the page's, _sfyMineGet): {id: the account, d: safety_mine's answer, at, busy, err ('' | 'net' | 'gone')}.
// S._sfyEntry: the booking entry the page was opened for ('' none). S._sfyF: the form, kept through repaints.
function _sfrM(c) { return c && S._sfyM && S._sfyM.id === c.id ? S._sfyM : null; }
function _sfrForm(c, eid) {
  let F = S._sfyF;
  if (F && F.id === c.id && F.eid !== eid && !F.sent) F.eid = eid; // another rider of the same booking picked: the answers stay
  if (!F || F.id !== c.id || F.eid !== eid) {
    F = S._sfyF = { id: c.id, eid, kind: '', parts: [], sev: '', brief: '', helm: '', bike: '', ready: '', causes: [], prevent: '', rs: 0, rc: 0, rf: 0, fna: false,
      com: '', ideas: '', consent: false, busy: false, err: '', sent: false };
  }
  return F;
}
function _sfrPage() {
  const h = document.getElementById('sfy-page'), c = S.loggedIn || getSession();
  if (!h || !c) return;
  if (!c.session_token) { h.innerHTML = `<p class="tst-note">${esc(_sfrT('errSignin'))}</p>`; return; }
  const M = _sfrM(c), dep = _sfrDep();
  if ((!M || !M.d || Date.now() - M.at > 6e4) && dep.mine) dep.mine(c).then(() => _sfrPaint()); // read at most once a minute
  _sfrPaint();
}
function _sfrReload() { const c = S.loggedIn || getSession(), dep = _sfrDep(); if (!c || !dep.mine) return; dep.mine(c, true).then(() => _sfrPaint()); _sfrPaint(); }
// Draw the page from what S holds. fk: the control to give the focus back to (a pill just tapped is drawn again).
function _sfrPaint(fk) {
  const h = document.getElementById('sfy-page'), c = S.loggedIn || getSession(), M = _sfrM(c);
  if (!h || !M) return;
  if (!M.d) {
    h.innerHTML = M.busy ? (_sfrDep().skel ? _sfrDep().skel() : '') : M.err === 'gone' ? `<p class="tst-note">${esc(_sfrT('noDb'))}</p>`
      : `<div class="tst-note">${esc(_sfrT('errLoad'))} <button type="button" class="btn-secondary tst-retry" data-on-click="${_on('_sfrReload')}">${esc(_sfrT('retry'))}</button></div>`;
    return;
  }
  const d = M.d, eid = String(S._sfyEntry || ''), items = d.items || [], entries = d.entries || [];
  const due = entries.find((x) => String(x.entry_id) === eid), sent = items.find((x) => String(x.entry_id) === eid);
  const F = S._sfyF && S._sfyF.id === c.id && S._sfyF.sent && S._sfyF.eid === eid ? S._sfyF : null;
  let body;
  if (F) body = _sfrSentHtml(F, d);
  else if (due) body = _sfrFormHtml(_sfrForm(c, eid), d, due);
  else if (sent) body = _sfrItemHtml(sent, true) + _sfrAnotherHtml(d, sent.session_id);
  else body = (eid ? `<p class="tst-note sfy-late">${esc(_sfrT('late'))}</p>` : '') + _sfrHomeHtml(d);
  h.innerHTML = body;
  if (fk) { const el = h.querySelector(`[data-fk="${fk}"]`); if (el) try { el.focus({ preventScroll: true }); } catch (_) {} }
}
// ── The form ─────────────────────────────────────────────────────────────────────────────────────────────────────
function _sfrPills(fk, label, opts, on, multi, F) {
  const id = 'sfy-l-' + fk;
  return `<div class="tst-f"><span class="tst-lbl" id="${id}">${label}</span>
    <div class="tst-pills" role="group" aria-labelledby="${id}">${opts.map(([v, l]) => {
    const sel = multi ? on.includes(v) : on === v;
    return `<button type="button" class="tst-pill${sel ? ' on' : ''}" aria-pressed="${sel}" data-fk="${fk}-${v}"${F.busy ? ' disabled' : ''} data-on-click="${_on('_sfrPick', fk, v)}">${esc(l)}</button>`;
  }).join('')}</div></div>`;
}
function _sfrStarsRow(fk, label, n, F, na) {
  const id = 'sfy-l-' + fk;
  return `<div class="tst-f"><span class="tst-lbl" id="${id}">${esc(label)}</span>
    <div class="sfy-stars"><div class="tst-starpick" role="radiogroup" aria-labelledby="${id}">${[1, 2, 3, 4, 5].map((v) => `<button type="button" class="tst-sb" role="radio" aria-checked="${n === v}" aria-label="${esc(_sfrT('starsOf').replace('{0}', v))}" data-fk="${fk}-${v}"${F.busy ? ' disabled' : ''} data-on-click="${_on('_sfrPick', fk, v)}">${_sfrStar(v <= n, 30)}</button>`).join('')}</div>
    ${na ? `<button type="button" class="tst-pill${F.fna ? ' on' : ''}" aria-pressed="${!!F.fna}" data-fk="fna"${F.busy ? ' disabled' : ''} data-on-click="${_on('_sfrPick', 'fna', 1)}">${esc(_sfrT('fa_na'))}</button>` : ''}</div></div>`;
}
function _sfrText(fk, label, v, F) {
  return `<div class="tst-f"><label class="tst-lbl" for="sfy-${fk}">${esc(label)} <span class="tst-opt">(${esc(_sfrT('optional'))})</span></label>
    <textarea id="sfy-${fk}" class="tst-ta sfy-ta" dir="auto" rows="3" maxlength="${SFR_MAX}"${F.busy ? ' disabled' : ''} data-on-input="${_on('_sfrType', fk, _EL)}">${esc(v || '')}</textarea></div>`;
}
function _sfrFormHtml(F, d, due) {
  const same = (d.entries || []).filter((x) => String(x.session_id) === String(due.session_id));
  const hurt = SFR_HURT.includes(F.kind), dep = _sfrDep(), sn = _sfrSessName(due);
  const who = same.length > 1 ? _sfrPills('who', esc(_sfrT('who')), same.map((x) => [String(x.entry_id), x.name || '—']), F.eid, false, F) : '';
  const before = SFR_BEFORE.map(([k, q, a]) => _sfrPills(k, esc(_sfrT(q)), a.map(([v, w]) => [v, _sfrT(w)]), F[k], false, F)).join('');
  return `<section class="form-section acc-pg-card sfy-card" id="sfy-card">
    <div class="sfy-for">${_sfrIc('shield', 18)}<span><b><bdi>${esc(sn || _sfrDate(due.date))}</bdi></b>${sn ? ` · <bdi>${esc(_sfrDate(due.date))}</bdi>` : ''}${same.length > 1 ? '' : due.name ? ` · <bdi>${esc(due.name)}</bdi>` : ''}</span></div>
    <p class="tst-note sfy-intro">${esc(_sfrT('intro'))}</p>
    ${who}
    ${_sfrPills('kind', esc(_sfrT('q1')) + ' <span class="cu-req">*</span>', SFR_KINDS.map((k) => [k, _sfrT('k_' + k)]), F.kind, false, F)}
    ${hurt ? _sfrPills('parts', esc(_sfrT('parts')) + ` <span class="tst-opt">(${esc(_sfrT('optional'))})</span>`, SFR_PARTS.map((k) => [k, _sfrT('p_' + k)]), F.parts, true, F)
      + _sfrPills('sev', esc(_sfrT('sev')) + (F.kind === 'injury' ? ' <span class="cu-req">*</span>' : ''), SFR_SEV.map((k) => [k, _sfrT('s_' + k)]), F.sev, false, F) : ''}
    <h3 class="tst-h sfy-q">${esc(_sfrT('q2'))}</h3>
    ${before}
    ${F.kind && F.kind !== 'none' ? `${_sfrPills('causes', esc(_sfrT('q3')) + ` <span class="tst-opt">(${esc(_sfrT('optional'))})</span>`, SFR_CAUSES.map((k) => [k, _sfrT('c_' + k)]), F.causes, true, F)}
    ${_sfrText('prevent', _sfrT('prevent'), F.prevent, F)}` : ''}
    <h3 class="tst-h sfy-q">${esc(_sfrT('q4'))}</h3>
    ${_sfrStarsRow('rs', _sfrT('r_speed'), F.rs, F)}${_sfrStarsRow('rc', _sfrT('r_care'), F.rc, F)}${_sfrStarsRow('rf', _sfrT('r_fa'), F.rf, F, true)}
    ${_sfrText('com', _sfrT('comment'), F.com, F)}
    ${_sfrText('ideas', _sfrT('q5'), F.ideas, F)}
    <div class="tst-f tst-consent">${dep.tick ? dep.tick('sfy-ok', !!F.consent, esc(_sfrT('consent')), '_sfrOk', true) : ''}</div>
    ${F.err ? `<div class="tst-err" role="alert">${esc(F.err)}</div>` : ''}
    <button type="button" class="btn-primary tst-send sfy-send" data-fk="send"${F.busy ? ' disabled aria-busy="true"' : ''} data-on-click="${_on('_sfrSend')}">${esc(_sfrT('send'))}</button>
  </section>`;
}
// A tap on a pill or a star. Lists (parts, causes) toggle; one-answer questions take the tap, and a second tap on the
// same answer takes it back (they are all optional but what happened).
function _sfrPick(fk, v) {
  const F = S._sfyF; if (!F || F.busy) return;
  const s = String(v);
  if (fk === 'who') { S._sfyEntry = s; F.eid = s; F.err = ''; return _sfrPaint('who-' + s); }
  if (fk === 'parts' || fk === 'causes') { const L = F[fk]; const i = L.indexOf(s); if (i < 0) L.push(s); else L.splice(i, 1); }
  else if (fk === 'rs' || fk === 'rc' || fk === 'rf') { const n = Number(v) || 0; F[fk] = F[fk] === n ? 0 : n; if (fk === 'rf' && F.rf) F.fna = false; }
  else if (fk === 'fna') { F.fna = !F.fna; if (F.fna) F.rf = 0; }
  else if (fk === 'kind') { F.kind = s; if (!SFR_HURT.includes(s)) { F.parts = []; F.sev = ''; } if (s === 'none') F.causes = []; }
  else if (['sev', 'brief', 'helm', 'bike', 'ready'].includes(fk)) F[fk] = F[fk] === s ? '' : s;
  else return;
  F.err = '';
  _sfrPaint(fk === 'fna' ? 'fna' : fk + '-' + s);
}
function _sfrType(fk, el) { const F = S._sfyF; if (!F || !el || !['prevent', 'com', 'ideas'].includes(fk)) return; F[fk] = el.value; }
function _sfrOk() {
  const F = S._sfyF; if (!F || F.busy) return;
  F.consent = !F.consent; const d = _sfrDep(); if (d.tickSet) d.tickSet('sfy-ok', F.consent);
  if (F.err) { F.err = ''; const e = document.querySelector('#sfy-card .tst-err'); if (e) e.remove(); }
}
// What the form lacks before it is sent ('' when nothing): what happened, how serious an injury was, the tick.
function _sfrCheck(F) {
  if (!SFR_KINDS.includes(F.kind)) return _sfrT('errKind');
  if (F.kind === 'injury' && !SFR_SEV.includes(F.sev)) return _sfrT('errSev');
  if (!F.consent) return _sfrT('errConsent');
  return '';
}
// The answers as safety_send takes them: only what belongs with what happened, empty answers left out as null.
function _sfrData(F) {
  const hurt = SFR_HURT.includes(F.kind), none = F.kind === 'none', tx = (v) => String(v || '').trim().slice(0, SFR_MAX) || null;
  const words = [F.prevent, F.com, F.ideas].filter(Boolean).join(' ');
  return { kind: F.kind, injury_parts: hurt ? F.parts.slice() : [], injury_severity: hurt && F.sev ? F.sev : null,
    briefing: F.brief || null, helmet_ok: F.helm || null, bike_ok: F.bike || null, ready: F.ready || null,
    causes: none ? [] : F.causes.slice(), prevent: none ? null : tx(F.prevent),
    rate_speed: F.rs || null, rate_care: F.rc || null, rate_first_aid: F.fna ? null : F.rf || null,
    resp_comment: tx(F.com), ideas: tx(F.ideas), consent: !!F.consent, lang: _sfrLang(words) };
}
async function _sfrSend() {
  const F = S._sfyF, c = S.loggedIn || getSession(); if (!F || F.busy || !c) return;
  const miss = _sfrCheck(F);
  if (miss) { F.err = miss; _sfrPaint('send'); return; }
  if (_sfrDep().offline && _sfrDep().offline()) return;
  F.busy = true; F.err = ''; _sfrPaint();
  let r;
  try { r = await sb.rpc('safety_send', { p_id: c.id, p_token: c.session_token, p_entry: F.eid, p_data: _sfrData(F) }); } catch (e) { r = { error: e }; }
  F.busy = false;
  const d = r && !r.error ? r.data : null;
  if (d && d.ok === true) {
    F.sent = true;
    const dep = _sfrDep();
    if (dep.mine) await dep.mine(c, true);
    if (dep.cards) dep.cards();
    _sfrPaint();
    const s = document.getElementById('sfy-sent'); if (s) try { s.focus({ preventScroll: true }); } catch (_) {}
    return;
  }
  F.err = d && d.error ? _sfrErr(d.error) : r && r.error && _sfrDep().absent && _sfrDep().absent(r.error) ? _sfrT('noDb') : _sfrT('errNet');
  if (d && (d.error === 'dup' || d.error === 'late' || d.error === 'entry') && _sfrDep().mine) _sfrDep().mine(c, true); // the page's list follows
  _sfrPaint('send');
}
// ── Sent, one item, the page's home ─────────────────────────────────────────────────────────────────────────────
function _sfrSentHtml(F, d) {
  const it = (d.items || []).find((x) => String(x.entry_id) === F.eid);
  return `<section class="form-section acc-pg-card sfy-card" id="sfy-card">
    <p class="tst-sent" id="sfy-sent" tabindex="-1" role="status">${_sfrIc('check', 18)}<span>${esc(_sfrT('sent'))}</span></p>
    ${it ? _sfrItemHtml(it, false) : ''}</section>${_sfrAnotherHtml(d, it ? it.session_id : null)}`;
}
function _sfrItemHtml(x, card) {
  const sn = _sfrSessName(x), what = _sfrT('k_' + x.kind);
  const inner = `<div class="tst-item-h"><b>${esc(what)}</b>${_sfrSt(x.status)}</div>
    <div class="tst-item-m"><bdi>${esc([sn, _sfrDate(x.date || x.created_at), x.rider_name].filter(Boolean).join(' · '))}</bdi></div>
    ${x.staff_reply ? `<div class="sfy-reply"><span class="tst-lbl">${esc(_sfrT('reply'))}${x.replied_at ? ` · <bdi>${esc(_sfrDate(x.replied_at))}</bdi>` : ''}</span><p dir="auto">${esc(x.staff_reply)}</p></div>` : ''}`;
  return card ? `<section class="form-section acc-pg-card sfy-card tst-item sfy-item" data-eid="${esc(String(x.entry_id))}">${inner}</section>` : `<div class="sfy-item" data-eid="${esc(String(x.entry_id))}">${inner}</div>`;
}
// The other riders of the same booking still to be told about, after one was sent.
function _sfrAnotherHtml(d, sid) {
  const more = sid == null ? [] : (d.entries || []).filter((x) => String(x.session_id) === String(sid));
  if (!more.length) return '';
  return `<div class="sfy-more"><h3 class="tst-h">${esc(_sfrT('another'))}</h3><ul class="tst-list">${more.map(_sfrDueLi).join('')}</ul></div>`;
}
function _sfrDueLi(x) {
  const sn = _sfrSessName(x);
  return `<li class="tst-item sfy-due"><div class="tst-item-h"><span><b><bdi>${esc(sn || _sfrDate(x.date))}</bdi></b>${sn ? ` · <bdi>${esc(_sfrDate(x.date))}</bdi>` : ''}${x.name ? ` · <bdi>${esc(x.name)}</bdi>` : ''}</span>
    <button type="button" class="btn-sm btn-primary sfy-tell" data-on-click="${_on('_sfrOpen', String(x.entry_id))}">${esc(_sfrT('tell'))}</button></div></li>`;
}
function _sfrHomeHtml(d) {
  const due = d.entries || [], items = d.items || [];
  return `<section class="form-section acc-pg-card sfy-card"><p class="tst-note sfy-intro">${esc(_sfrT('intro'))}</p>
    <h3 class="tst-h">${esc(_sfrT('dueH'))}</h3>
    ${due.length ? `<ul class="tst-list">${due.map(_sfrDueLi).join('')}</ul>` : `<p class="tst-note sfy-none">${esc(_sfrT('dueNone'))}</p>`}</section>
    ${items.length ? `<div class="tst-mine sfy-mine"><h3 class="tst-h">${esc(_sfrT('mineH'))}</h3><ul class="tst-list">${items.map((x) => `<li class="tst-item">${_sfrItemHtml(x, false)}</li>`).join('')}</ul></div>` : ''}`;
}
function _sfrOpen(eid) {
  S._sfyEntry = String(eid || ''); S._sfyF = null; _sfrPaint();
  const h = document.getElementById('sfy-page'); if (h) try { h.scrollIntoView({ block: 'start' }); } catch (_) {}
}
window._sfrPage = _sfrPage;
