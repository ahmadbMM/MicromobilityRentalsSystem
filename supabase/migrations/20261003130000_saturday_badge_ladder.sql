-- The Saturday social ride ladder (the owner, 2026-10-03): badges at 1, 5, 10, 25, 50 and 100
-- completed Saturday social rides (ride days). Slipstream stays at 5; Paceline moves from 15 to 10
-- and Peloton from 30 to 25; Rolling Start (1), Grand Tour (50) and Hall of Fame (100) are new.
-- The app and the website count them (_mrBadges / lib/ride-record.ts); these rows put them in the
-- catalogue, so a rider sees the ones still to earn. Hall of Fame is drawn in the app's special
-- finish, which the table cannot hold: 'gold' here, as Race Ready.
insert into public.badges (id, slug, icon, color, name, name_ar, description, description_ar, system, auto, sort)
values
  ('bd_rolling_start', 'rolling_start', 'wind', 'teal',   'Rolling Start', 'الانطلاقة المتحركة', 'Your first community ride', 'أول رحلة مجتمعية', true, true, 225),
  ('bd_grand_tour',    'grand_tour',    'wind', 'purple', 'Grand Tour',    'الطواف الكبير',     '50 community rides',        '50 رحلة مجتمعية',  true, true, 252),
  ('bd_hall_of_fame',  'hall_of_fame',  'wind', 'gold',   'Hall of Fame',  'قاعة المشاهير',     '100 community rides',       '100 رحلة مجتمعية', true, true, 254)
on conflict (slug) do update set icon = excluded.icon, color = excluded.color, name = excluded.name, name_ar = excluded.name_ar,
  description = excluded.description, description_ar = excluded.description_ar, system = true, auto = true, retired = false, sort = excluded.sort;

update public.badges set description = '10 community rides', description_ar = '10 رحلات مجتمعية' where slug = 'paceline';
update public.badges set description = '25 community rides', description_ar = '25 رحلة مجتمعية' where slug = 'peloton';
