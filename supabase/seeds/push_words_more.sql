-- The push texts in the eight languages after English and Arabic (2026-11-13, the Community tab reach build, R18).
-- push_words (key, lang, title, body) comes with migration 20261114000200_push_consent.sql, which seeds en and ar;
-- run this after it. {0} and {1} are filled by the server when it queues a push:
--   remind     {0} = the session's name, {1} = the gather time      (My rides, the evening before at 21:00 KSA)
--   change     {0} = the session's name                             (My rides, start, meeting point or status changed)
--   challenge  no placeholder                                       (Community, the 1st at 10:00 KSA)
--   recap      {0} = the riders that Saturday                       (Community, members who rode)
-- The words are the app's own (i18n/<code>.json: ride, ticket, Community; member-hub.js HUB_T: challenge).
-- ne and bn use Latin digits only (there are none here beyond the placeholders). Safe to run again.
insert into public.push_words (key, lang, title, body) values
  ('remind',    'fr', 'Sortie demain',                     '{0}, rendez-vous à {1}'),
  ('change',    'fr', 'Votre sortie a changé',             '{0} : ouvrez votre billet pour voir les nouveaux détails'),
  ('challenge', 'fr', 'Votre nouveau défi est prêt',       'Ouvrez Communauté pour voir le défi du mois'),
  ('recap',     'fr', 'Le récap du samedi est là',         '{0} cyclistes étaient de sortie ce samedi'),

  ('remind',    'es', 'Salida mañana',                     '{0}, nos vemos a las {1}'),
  ('change',    'es', 'Tu salida ha cambiado',             '{0}: abre tu entrada para ver los nuevos detalles'),
  ('challenge', 'es', 'Tu nuevo reto está listo',          'Abre Comunidad para ver el reto de este mes'),
  ('recap',     'es', 'Ya está el resumen del sábado',     '{0} ciclistas salieron este sábado'),

  ('remind',    'pt', 'Passeio amanhã',                    '{0}, encontro às {1}'),
  ('change',    'pt', 'O seu passeio mudou',               '{0}: abra o seu ingresso para ver os novos detalhes'),
  ('challenge', 'pt', 'O seu novo desafio está pronto',    'Abra Comunidade para ver o desafio deste mês'),
  ('recap',     'pt', 'O resumo de sábado chegou',         '{0} ciclistas saíram neste sábado'),

  ('remind',    'ur', 'کل رائیڈ ہے',                        '{0}، {1} بجے ملیں'),
  ('change',    'ur', 'آپ کی رائیڈ میں تبدیلی ہوئی ہے',       '{0}: نئی تفصیلات کے لیے اپنا ٹکٹ کھولیں'),
  ('challenge', 'ur', 'آپ کا نیا چیلنج تیار ہے',              'اس مہینے کا چیلنج دیکھنے کے لیے کمیونٹی کھولیں'),
  ('recap',     'ur', 'ہفتے کے دن کا خلاصہ آ گیا ہے',          'اس ہفتے کے دن {0} رائیڈرز آئے'),

  ('remind',    'hi', 'कल राइड है',                         '{0}, {1} बजे मिलें'),
  ('change',    'hi', 'आपकी राइड बदल गई है',                 '{0}: नई जानकारी के लिए अपना टिकट खोलें'),
  ('challenge', 'hi', 'आपकी नई चुनौती तैयार है',              'इस महीने की चुनौती देखने के लिए समुदाय खोलें'),
  ('recap',     'hi', 'शनिवार का सार आ गया है',               'इस शनिवार {0} राइडर आए'),

  ('remind',    'tl', 'May ride bukas',                    '{0}, magkita tayo nang {1}'),
  ('change',    'tl', 'Nagbago ang ride mo',               '{0}: buksan ang ticket mo para sa mga bagong detalye'),
  ('challenge', 'tl', 'Handa na ang bago mong hamon',      'Buksan ang Komunidad para makita ang hamon ngayong buwan'),
  ('recap',     'tl', 'Narito na ang recap ng Sabado',     '{0} rider ang sumama ngayong Sabado'),

  ('remind',    'ne', 'भोलि राइड छ',                         '{0}, {1} मा भेटौं'),
  ('change',    'ne', 'तपाईंको राइड परिवर्तन भएको छ',            '{0}: नयाँ विवरणका लागि आफ्नो टिकट खोल्नुहोस्'),
  ('challenge', 'ne', 'तपाईंको नयाँ चुनौती तयार छ',              'यो महिनाको चुनौती हेर्न समुदाय खोल्नुहोस्'),
  ('recap',     'ne', 'शनिबारको सारांश आयो',                  'यो शनिबार {0} राइडर आए'),

  ('remind',    'bn', 'আগামীকাল রাইড',                       '{0}, {1}-এ দেখা হবে'),
  ('change',    'bn', 'আপনার রাইডে পরিবর্তন হয়েছে',            '{0}: নতুন তথ্যের জন্য আপনার টিকিট খুলুন'),
  ('challenge', 'bn', 'আপনার নতুন চ্যালেঞ্জ প্রস্তুত',            'এই মাসের চ্যালেঞ্জ দেখতে কমিউনিটি খুলুন'),
  ('recap',     'bn', 'শনিবারের সারসংক্ষেপ এসে গেছে',          'এই শনিবার {0} জন রাইডার এসেছিলেন')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;
