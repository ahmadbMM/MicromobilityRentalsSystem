-- ============================================================================
-- F&B partners: the venue's feedback after a Saturday breakfast.
--
-- The owner's ask (2026-10-03): a venue can give its feedback after a breakfast it hosted.
--  1. fnb_feedback - one row per confirmed booking: a 1-5 rating, how many riders came,
--     what went well, what we could do better, who sent it. Staff read it (is_staff()).
--  2. fnb_feedback_save(uid, token, booking, rating, turnout, went_well, improve) - the venue's
--     own CONFIRMED booking, from the breakfast's day (Riyadh) for 14 days; saving again within
--     the window edits it.
--  3. fnb_calendar answers each own booking's feedback too (mine.feedback, null when none) and
--     whether the window is open (mine.feedback_open). Rebuilt from 20261003150000 with only
--     that added.
--
-- Rollback:
--   drop function if exists public.fnb_feedback_save(bigint, text, bigint, integer, integer, text, text);
--   drop table if exists public.fnb_feedback;
--   then re-run fnb_calendar from 20261003150000_fnb_partners.sql.
-- Idempotent.
-- ============================================================================

create table if not exists public.fnb_feedback (
  booking_id   bigint primary key references public.fnb_bookings(id) on delete cascade,
  venue_id     bigint not null references public.fnb_venues(id) on delete cascade,
  day          date not null,
  rating       integer not null check (rating between 1 and 5),
  turnout      integer check (turnout is null or turnout between 0 and 1000),
  went_well    text not null default '' check (length(went_well) <= 1000),
  improve      text not null default '' check (length(improve) <= 1000),
  submitted_by bigint references public.fnb_users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists fnb_feedback_venue on public.fnb_feedback(venue_id, day desc);
create index if not exists fnb_feedback_day on public.fnb_feedback(day desc);

alter table public.fnb_feedback enable row level security;
drop policy if exists "fnb_feedback staff read" on public.fnb_feedback;
create policy "fnb_feedback staff read" on public.fnb_feedback for select to authenticated using ((select public.is_staff()));
revoke all on public.fnb_feedback from anon, authenticated;
grant select on public.fnb_feedback to authenticated;

create or replace function public.fnb_feedback_save(p_uid bigint, p_token text, p_booking bigint, p_rating integer,
                                                    p_turnout integer default null, p_went_well text default '',
                                                    p_improve text default '')
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token); b fnb_bookings%rowtype; today date := _fnb_today(); f fnb_feedback%rowtype;
begin
  select * into b from fnb_bookings where id = p_booking and venue_id = u.venue_id;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if b.status <> 'confirmed' then raise exception 'NOT_CONFIRMED' using errcode = 'P0001'; end if;
  if today < b.day then raise exception 'TOO_EARLY' using errcode = 'P0001'; end if;
  if today > b.day + 14 then raise exception 'TOO_LATE' using errcode = 'P0001'; end if;
  if p_rating is null or p_rating not between 1 and 5 then raise exception 'BAD_RATING' using errcode = '22023'; end if;
  insert into fnb_feedback as x (booking_id, venue_id, day, rating, turnout, went_well, improve, submitted_by)
  values (b.id, b.venue_id, b.day, p_rating, p_turnout, left(coalesce(p_went_well, ''), 1000), left(coalesce(p_improve, ''), 1000), u.id)
  on conflict (booking_id) do update set rating = excluded.rating, turnout = excluded.turnout,
     went_well = excluded.went_well, improve = excluded.improve, submitted_by = excluded.submitted_by, updated_at = now()
  returning * into f;
  return to_jsonb(f) - 'submitted_by';
end $$;

-- fnb_calendar, as in 20261003150000, with mine.feedback and mine.feedback_open added.
create or replace function public.fnb_calendar(p_uid bigint, p_token text, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare u fnb_users%rowtype := _fnb_user(p_uid, p_token); today date := _fnb_today();
begin
  if p_to < p_from or p_to - p_from > 400 then raise exception 'BAD_RANGE' using errcode = '22023'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'day', d.day, 'state', d.state, 'reason', case when d.state = 'closed' then d.reason else '' end,
      'mine', (select jsonb_build_object('id', b.id, 'status', b.status, 'kind', b.kind, 'series_id', b.series_id,
                                         'note', b.note, 'staff_note', b.staff_note,
                                         'feedback', (select to_jsonb(f) - 'submitted_by' from fnb_feedback f where f.booking_id = b.id),
                                         'feedback_open', b.status = 'confirmed' and today between b.day and b.day + 14)
                 from fnb_bookings b where b.day = d.day and b.venue_id = u.venue_id
                 order by (b.status in ('pending','confirmed')) desc, b.updated_at desc limit 1),
      'taken', (select count(*) from fnb_bookings b where b.day = d.day and b.status = 'confirmed'
                                                       and b.venue_id <> u.venue_id) >= d.capacity,
      'riders', case when exists(select 1 from fnb_bookings b where b.day = d.day and b.venue_id = u.venue_id and b.status = 'confirmed')
                     then (select count(*) from queue_entries q join sessions s on s.id = q.session_id
                            where s.session_date = d.day::text and s.event_kind = 'community'
                              and coalesce(s.ride_kind, 'saturday') = 'saturday' and s.status <> 'deleted'
                              and q.status in ('waiting','done') and coalesce(q.approval, '') <> 'rejected') end
    ) order by d.day)
    from fnb_dates d where d.day between p_from and p_to), '[]'::jsonb);
end $$;

revoke all on function public.fnb_feedback_save(bigint, text, bigint, integer, integer, text, text) from public;
grant execute on function public.fnb_feedback_save(bigint, text, bigint, integer, integer, text, text) to anon, authenticated;
revoke all on function public.fnb_calendar(bigint, text, date, date) from public;
grant execute on function public.fnb_calendar(bigint, text, date, date) to anon, authenticated;
