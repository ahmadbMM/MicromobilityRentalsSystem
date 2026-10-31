-- ============================================================================
-- A question for one rider (2026-11-01): staff put a question on an account, the rider is asked it
-- in a pop-up the next time the app or the website opens signed in, and types an answer in a box.
--
--   public.rider_questions  one row per question: whose account, the question, who asked and when,
--                           and the answer with its time once given. Staff only: RLS under is_staff();
--                           anon has no grant at all. Staff add a question with a plain insert.
--   customer_questions(p_id, p_token)
--                           token-checked, the rider's own open questions, oldest first, as
--                           [{id, question}] (an empty array when there are none), or null for a bad
--                           token. Answered questions never come back.
--   customer_question_answer(p_id, p_token, p_qid, p_answer)
--                           token-checked; saves the answer once on the rider's own open question and
--                           returns true, false for a bad token or a question that is not theirs or is
--                           already answered. An empty answer, or one over 1000 characters, is refused.
--
-- "Later" on the pop-up saves nothing: the question is asked again on the next visit until answered.
-- The page works before this is applied: the call fails and no pop-up shows.
--
-- Rollback:
--   drop function if exists public.customer_question_answer(text, text, bigint, text);
--   drop function if exists public.customer_questions(text, text);
--   drop table if exists public.rider_questions;
-- Idempotent: safe to re-run.
-- ============================================================================
begin;

create table if not exists public.rider_questions (
  id           bigint generated always as identity primary key,
  customer_id  text not null references public.customers(id) on delete cascade,
  question     text not null check (length(btrim(question)) between 1 and 500),
  asked_at     timestamptz not null default now(),
  asked_by     text check (asked_by is null or length(asked_by) <= 120),
  answer       text check (answer is null or length(answer) between 1 and 1000),
  answered_at  timestamptz,
  constraint rider_questions_answered check ((answer is null) = (answered_at is null))
);
create index if not exists rider_questions_open on public.rider_questions (customer_id, asked_at)
  where answered_at is null;
comment on table public.rider_questions is 'staff questions to one rider, asked in a pop-up; the rider reads and answers only through customer_questions / customer_question_answer';
alter table public.rider_questions enable row level security;
drop policy if exists "rider questions staff read" on public.rider_questions;
create policy "rider questions staff read" on public.rider_questions for select to authenticated
  using ((select public.is_staff()));
drop policy if exists "rider questions staff insert" on public.rider_questions;
create policy "rider questions staff insert" on public.rider_questions for insert to authenticated
  with check ((select public.is_staff()));
drop policy if exists "rider questions staff update" on public.rider_questions;
create policy "rider questions staff update" on public.rider_questions for update to authenticated
  using ((select public.is_staff())) with check ((select public.is_staff()));
drop policy if exists "rider questions staff delete" on public.rider_questions;
create policy "rider questions staff delete" on public.rider_questions for delete to authenticated
  using ((select public.is_staff()));
revoke all on public.rider_questions from anon, authenticated;
grant select, insert, update, delete on public.rider_questions to authenticated;

create or replace function public.customer_questions(p_id text, p_token text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'extensions'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then return null; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', q.id, 'question', q.question) order by q.asked_at, q.id)
                     from rider_questions q
                    where q.customer_id = p_id and q.answered_at is null), '[]'::jsonb);
end $function$;
revoke all on function public.customer_questions(text, text) from public;
grant execute on function public.customer_questions(text, text) to anon, authenticated;

create or replace function public.customer_question_answer(p_id text, p_token text, p_qid bigint, p_answer text)
 returns boolean
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_a text := btrim(coalesce(p_answer, ''));
begin
  if not _cust_token_ok(p_id, p_token) then return false; end if;
  if length(v_a) not between 1 and 1000 then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'answer';
  end if;
  update rider_questions
     set answer = v_a, answered_at = now()
   where id = p_qid and customer_id = p_id and answered_at is null;
  return found;
end $function$;
revoke all on function public.customer_question_answer(text, text, bigint, text) from public;
grant execute on function public.customer_question_answer(text, text, bigint, text) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261101030000', 'rider_questions')
on conflict (version) do nothing;

commit;

-- Check: RLS on, both functions token-checked definers, nothing open to anon.
-- select relrowsecurity from pg_class where oid = 'public.rider_questions'::regclass;
-- select proname, prosecdef from pg_proc where proname in ('customer_questions','customer_question_answer');
-- Then run supabase/checks/security-attributes.sql.
--
-- Ask a rider (staff, SQL editor):
--   insert into rider_questions (customer_id, question, asked_by)
--   select id, '<the question>', '<your name>' from customers where lower(btrim(email)) = '<their email>';
-- Read the answers:
--   select q.asked_at, c.name, q.question, q.answer, q.answered_at
--     from rider_questions q join customers c on c.id = q.customer_id order by q.asked_at desc;
