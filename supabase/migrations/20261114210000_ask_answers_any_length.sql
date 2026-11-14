-- ============================================================================
-- Ask: a written answer (word cloud, open answers, questions from people) takes any length (the user, 2026-11-14:
-- "allow me to write unlimited amount of characters not limited"; the farm-ideas word cloud stopped people at 25
-- characters, and several of its answers sat at 23 to 25).
--
-- For these three kinds a question's config.max_len is no longer read. One answer stops only at a ceiling of 2000
-- characters, which nobody typing an idea reaches; it is there so a pasted book cannot fill every page's results.
-- Nothing on screen names it. The typed quiz (quiz_text keeps its own max_len, 5 to 80) and the short form's fields
-- are unchanged.
--   1. ask_answers.body: at most 2000 characters (was 500). On production, 2026-11-14, the longest was 26.
--   2. ask_send: the written kinds' length rule reads 2000 instead of max_len. Patched in place from its LIVE text
--      (pg_get_functiondef), that one line and nothing else, so SECURITY DEFINER, the search_path, the grants and the
--      rest of the body stay as production has them. It refuses to run when the old line is not there exactly once,
--      and does nothing when the new line already is (run twice, nothing happens).
--   3. max_len comes off every cloud / open / qa question's config (the staff app no longer writes it; on
--      production one question had it: farm-ideas, 25). The question trigger moves each page's version, so open
--      pages read the question again.
-- _ask_config_err still accepts a max_len on these kinds (an older staff app may still send one); nothing reads it.
--
-- Safe before the apps: an older page still caps its box at the question's old max_len, or 25 / 200 when there is
-- none, and the database takes anything up to 2000.
-- Undo: put the 500 check back; re-run ask_send from 20261113010000_ask.sql (section with "create or replace
-- function public.ask_send").
-- ============================================================================
begin;

alter table public.ask_answers drop constraint if exists ask_answers_body_check;
alter table public.ask_answers add constraint ask_answers_body_check check (body is null or char_length(body) between 1 and 2000);

do $patch$
declare
  v_def  text := pg_get_functiondef('public.ask_send(bigint,text,text,jsonb,text)'::regprocedure);
  v_old  text := 'if char_length(v_text) > _ask_int(c, ''max_len'', case when q.kind = ''cloud'' then 25 else 200 end) then return jsonb_build_object(''ok'', false, ''error'', ''long''); end if;';
  v_new  text := 'if char_length(v_text) > 2000 then return jsonb_build_object(''ok'', false, ''error'', ''long''); end if; -- any length, 2026-11-14 (a ceiling nobody types to)';
  v_hits integer;
begin
  if strpos(v_def, v_new) > 0 then return; end if;
  v_hits := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  if v_hits <> 1 then raise exception 'ask_send: the length line is there % times, not once', v_hits; end if;
  execute replace(v_def, v_old, v_new);
end $patch$;

update public.ask_questions set config = config - 'max_len' where kind in ('cloud', 'open', 'qa') and config ? 'max_len';

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114210000', 'ask_answers_any_length')
on conflict (version) do nothing;

commit;

-- Check (read-only):
--   select version, name from supabase_migrations.schema_migrations where version = '20261114210000';
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'ask_answers_body_check';
--   select strpos(pg_get_functiondef(p.oid), 'v_text) > 2000 then') > 0 as patched,
--          strpos(pg_get_functiondef(p.oid), '''max_len'', case when q.kind') = 0 as old_gone,
--          p.prosecdef as definer, p.proconfig
--     from pg_proc p where p.oid = 'public.ask_send(bigint,text,text,jsonb,text)'::regprocedure;
--   select count(*) as max_len_left from ask_questions where kind in ('cloud', 'open', 'qa') and config ? 'max_len';
