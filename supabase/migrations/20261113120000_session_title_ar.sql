-- ============================================================================
-- A session's Arabic name (the owner's pick Q9 a on the Experiences theming page, 2026-11-13: "An Arabic name field on
-- the session form"). Staff type a session's name in English ("Petromin's Wednesdays", "Triathlon Pool Session") and the
-- Arabic page showed it in English. sessions.title_ar holds the Arabic name: the session form asks it under the name, and
-- the booking app and the website show it on Arabic pages in place of title (every other language keeps title, and a
-- session with neither is named by its kind in the page's own language). The breakfast spot's breakfast_name_ar
-- (20261004130000) is the precedent.
--
-- One nullable column, nothing else: list_sessions returns sessions%rowtype (setof sessions), so riders and the website
-- receive it with no function change, and anon/authenticated already hold table-level SELECT on sessions; staff write it
-- under the existing "staff insert" / "staff update" policies. The app offers the field only once a row carries the
-- column, so the order of this script and the app's deploy does not matter. Idempotent.
--
-- Rollback:
--   alter table public.sessions drop column if exists title_ar;
-- ============================================================================

begin;

alter table public.sessions add column if not exists title_ar text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessions_title_ar_len' and conrelid = 'public.sessions'::regclass) then
    alter table public.sessions add constraint sessions_title_ar_len check (title_ar is null or char_length(title_ar) <= 60);
  end if;
end $$;

comment on column public.sessions.title_ar is 'The session''s name in Arabic, shown on Arabic pages in place of title (2026-11-13).';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261113120000', 'session_title_ar')
on conflict (version) do nothing;

commit;

-- Check (read only): the column is there, nullable text, and list_sessions hands it out.
select column_name, data_type, is_nullable from information_schema.columns
 where table_schema = 'public' and table_name = 'sessions' and column_name = 'title_ar';
select count(*) filter (where title_ar is not null) as named_in_arabic, count(*) as sessions from public.sessions;
