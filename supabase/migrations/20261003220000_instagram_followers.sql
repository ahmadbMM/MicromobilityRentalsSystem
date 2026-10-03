-- Instagram follower counts, seen by staff only (the owner, 2026-10-03: "extract the amount of
-- followers on insta each account has and add it as an info that only staff can see").
--
-- One row per account that has an Instagram handle in customers.socials. The number comes from
-- one of two places:
--   * 'auto'  - functions/api/ig-followers.js asks Instagram's Business Discovery API (our own
--               business account looks the handle up). It only answers for Business and Creator
--               accounts; a personal or missing account is status 'unavailable' and keeps any
--               number staff typed.
--   * 'staff' - a staffer typed it (the account is personal, or the API is not set up).
-- The row remembers the handle it was counted for: when the rider changes their handle the app
-- stops showing the old number and the next check counts the new one.
--
-- Staff-only, like customer_badges: nothing here is readable or writable by anon, and the server
-- function writes with the calling staffer's own token (no service key).
--
-- Rollback: drop table if exists public.customer_ig_followers;
-- Idempotent.

create table if not exists public.customer_ig_followers (
  customer_id text primary key references public.customers(id) on delete cascade,
  handle      text not null check (handle ~ '^[A-Za-z0-9._]{1,30}$'),
  followers   integer check (followers is null or followers between 0 and 2000000000),
  source      text check (source is null or source in ('auto','staff')),
  counted_at  timestamptz,
  status      text not null default 'ok' check (status in ('ok','unavailable','error')),
  tried_at    timestamptz,
  updated_by  text check (char_length(updated_by) <= 60)
);
create index if not exists customer_ig_followers_tried_idx on public.customer_ig_followers (tried_at);

alter table public.customer_ig_followers enable row level security;

drop policy if exists "staff full" on public.customer_ig_followers;
create policy "staff full" on public.customer_ig_followers for all to authenticated
  using ((select is_staff())) with check ((select is_staff()));

revoke all on public.customer_ig_followers from public, anon;
grant select, insert, update, delete on public.customer_ig_followers to authenticated;

