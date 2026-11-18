-- ============================================================================
-- Suggest a ride (Community features round, 2026-11-18; the user's pick from the list, "do 1 3 4 5 7 8 9", item 5:
-- "Suggest a ride: a member sends staff a route, a breakfast spot or an idea, and sees only their own suggestions, each
-- marked Planned or Done. When one happens, an Updates entry tells them.").
--
--  1. ride_suggestions: one row per suggestion. kind route | breakfast | idea | other, the member's text (3 to 500
--     characters), status new | planned | done | closed, staff's reply to the member (up to 300, optional), when it was
--     sent, when its status last changed and which staff user changed it, and `told`: the statuses the member has
--     already had an Updates row for. Staff read it (policy "staff read", _staff_mod('community')); nobody writes it
--     directly: members through ride_suggest, staff through staff_ride_suggestion_set. Members never see anyone
--     else's row: every rider read is their own token's accounts (_accts_of).
--  2. push_words 'sugplan' and 'sugdone' in all ten languages: "We're planning your suggestion" and "We made your
--     suggestion happen", with the first 60 characters of the member's own text as {0}.
--  3. _updates_suggestion (trigger before update of status): a change to planned or to done writes ONE row to the
--     member's Updates list, the way _updates_note writes a staff line (20261114080300): a push_outbox row with key and
--     args, so customer_updates says it in the language the page is in; tag hub-sug-<id>-<status>, so it is a Community
--     message (the gate pushes it only to a member who switched Community on; push is dormant anyway). Never twice for
--     the same status (`told`, and push_outbox's own unique tag); never "planned" after "done". It leads to the
--     suggestions page (/members?src=push&hv=suggest). A staff change is never refused for a message.
--  4. ride_suggest(p_id, p_token, p_kind, p_body): active Community members only; at most 3 in 24 hours and 10 still
--     new per person (their accounts together). Answers {ok, row} or {ok: false, error}: denied, member, invalid,
--     day, open (the page says each in words).
--     ride_suggestions_mine(p_id, p_token): the person's own rows, newest first, at most 50; a closed one reads as
--     'sent', as a new one does (the member sees Sent, Planned or Done).
--  5. staff_ride_suggestion_set(p_sid, p_status, p_reply): Community editors only (_staff_mod('community', true));
--     p_status null keeps the status, p_reply null keeps the reply ('' clears it). Answers the row.
--
-- No function is rebuilt: customer_updates (20261114080300) already says a push_outbox row with a key in the page's
-- language through _updates_text, and lists a hub-sug- row as kind 'info'.
--
-- Rollback:
--   drop trigger if exists ride_suggestions_updates on public.ride_suggestions;
--   drop function if exists public.staff_ride_suggestion_set(bigint, text, text), public.ride_suggestions_mine(text, text),
--     public.ride_suggest(text, text, text, text), public._updates_suggestion();
--   delete from public.push_words where key in ('sugplan', 'sugdone');
--   (the table is kept: it holds what members sent; drop it only if the feature is given up for good)
-- Idempotent. Run supabase/checks/security-attributes.sql after.
-- Tested on a local Postgres 17 with stubs (scratch-c/stubs.sql), applied twice.
-- ============================================================================

begin;
set local lock_timeout = '5s';

do $need$
begin
  if to_regclass('public.push_words') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'push_outbox' and column_name = 'key') then
    raise exception 'ride_suggestions: apply the Community reach migrations and the Updates list (20261114080300) first';
  end if;
end $need$;


/* -- 1. the table -------------------------------------------------------------------------------- */
create table if not exists public.ride_suggestions (
  id          bigint generated always as identity primary key,
  customer_id text not null references public.customers (id) on update cascade on delete cascade,
  kind        text not null check (kind in ('route', 'breakfast', 'idea', 'other')),
  body        text not null check (char_length(btrim(body)) between 3 and 500),
  status      text not null default 'new' check (status in ('new', 'planned', 'done', 'closed')),
  reply       text check (reply is null or char_length(reply) between 1 and 300),
  created_at  timestamptz not null default now(),
  status_at   timestamptz,
  staff_user  uuid,
  told        text[] not null default '{}' check (told <@ array['planned', 'done']::text[])
);
comment on table public.ride_suggestions is
  'Suggest a ride (20261118210500): a Community member''s route, breakfast spot or idea for staff, its status (new, planned, done, closed) and staff''s reply. Members read only their own (ride_suggestions_mine); staff read it under _staff_mod(''community'') and change it through staff_ride_suggestion_set. told: the statuses the member already had an Updates row for.';
create index if not exists ride_suggestions_customer on public.ride_suggestions (customer_id, created_at desc);
create index if not exists ride_suggestions_status on public.ride_suggestions (status, created_at desc);
alter table public.ride_suggestions enable row level security;
revoke all on public.ride_suggestions from public, anon, authenticated;
grant select on public.ride_suggestions to authenticated;
drop policy if exists "staff read" on public.ride_suggestions;
create policy "staff read" on public.ride_suggestions for select using ((select _staff_mod('community')));


/* -- 2. the words -------------------------------------------------------------------------------- */
-- {0} is the start of the member's own text, as they wrote it, in whatever language they wrote it.
insert into public.push_words (key, lang, title, body) values
  ('sugplan', 'en', 'We''re planning your suggestion', '“{0}”'),
  ('sugplan', 'ar', 'نخطط الآن لاقتراحك', '«{0}»'),
  ('sugplan', 'fr', 'Nous préparons votre suggestion', '« {0} »'),
  ('sugplan', 'es', 'Estamos planificando tu sugerencia', '«{0}»'),
  ('sugplan', 'pt', 'Estamos planejando a sua sugestão', '“{0}”'),
  ('sugplan', 'ur', 'ہم آپ کی تجویز پر منصوبہ بندی کر رہے ہیں', '“{0}”'),
  ('sugplan', 'hi', 'हम आपके सुझाव की योजना बना रहे हैं', '“{0}”'),
  ('sugplan', 'tl', 'Pinaplano na namin ang mungkahi mo', '“{0}”'),
  ('sugplan', 'ne', 'हामी तपाईंको सुझावको योजना बनाउँदैछौं', '“{0}”'),
  ('sugplan', 'bn', 'আমরা আপনার পরামর্শ নিয়ে পরিকল্পনা করছি', '“{0}”'),
  ('sugdone', 'en', 'We made your suggestion happen', '“{0}”'),
  ('sugdone', 'ar', 'نفّذنا اقتراحك', '«{0}»'),
  ('sugdone', 'fr', 'Votre suggestion a vu le jour', '« {0} »'),
  ('sugdone', 'es', 'Tu sugerencia se hizo realidad', '«{0}»'),
  ('sugdone', 'pt', 'A sua sugestão virou realidade', '“{0}”'),
  ('sugdone', 'ur', 'ہم نے آپ کی تجویز پر عمل کر دیا', '“{0}”'),
  ('sugdone', 'hi', 'हमने आपका सुझाव पूरा किया', '“{0}”'),
  ('sugdone', 'tl', 'Natupad na namin ang mungkahi mo', '“{0}”'),
  ('sugdone', 'ne', 'हामीले तपाईंको सुझाव पूरा गर्‍यौं', '“{0}”'),
  ('sugdone', 'bn', 'আমরা আপনার পরামর্শ বাস্তবায়ন করেছি', '“{0}”')
on conflict (key, lang) do update set title = excluded.title, body = excluded.body;


/* -- 3. planned or done: one row on the member's Updates list ----------------------------------- */
create or replace function public._updates_suggestion()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare v_key text; v_txt text; t record;
begin
  if new.status not in ('planned', 'done') or new.status = any(new.told) then return new; end if;
  if new.status = 'planned' and 'done' = any(new.told) then return new; end if; -- already told it happened
  begin
    v_key := case new.status when 'planned' then 'sugplan' else 'sugdone' end;
    v_txt := btrim(regexp_replace(new.body, '\s+', ' ', 'g'));
    if char_length(v_txt) > 60 then v_txt := rtrim(left(v_txt, 59)) || '…'; end if;
    -- _updates_text reads an argument starting 'kind:' as a session kind's name; the member's text is never one
    if v_txt like 'kind:%' then v_txt := 'K' || substr(v_txt, 2); end if;
    select * into t from _push_text(new.customer_id, v_key, array[v_txt]);
    insert into push_outbox (customer_id, tag, title, body, url, cat, key, args)
    values (new.customer_id, 'hub-sug-' || new.id || '-' || new.status, left(coalesce(t.title, 'MicroMobility'), 120),
            left(coalesce(t.body, v_txt), 300), '/members?src=push&hv=suggest', 'community', v_key, array[v_txt])
    on conflict (customer_id, tag) do nothing;
    new.told := array_append(new.told, new.status);
  exception when others then
    null; -- a staff change is never refused for a message
  end;
  return new;
end $$;
revoke all on function public._updates_suggestion() from public, anon, authenticated;
drop trigger if exists ride_suggestions_updates on public.ride_suggestions;
create trigger ride_suggestions_updates before update of status on public.ride_suggestions
  for each row when (old.status is distinct from new.status) execute function public._updates_suggestion();


/* -- 4. the member's two calls ------------------------------------------------------------------- */
-- One row as the member sees it: a closed suggestion reads as sent, like a new one.
create or replace function public.ride_suggest(p_id text, p_token text, p_kind text, p_body text)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_body text := btrim(coalesce(p_body, '')); v_accts text[]; r ride_suggestions%rowtype;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  if not _member_active(p_id) then return jsonb_build_object('ok', false, 'error', 'member'); end if;
  if p_kind is null or p_kind not in ('route', 'breakfast', 'idea', 'other') or char_length(v_body) not between 3 and 500 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  v_accts := _accts_of(p_id);
  -- one person's sends one at a time, so two taps at once cannot pass the limits together
  perform pg_advisory_xact_lock(hashtext('ride_suggest:' || p_id));
  if (select count(*) from ride_suggestions s where s.customer_id = any(v_accts) and s.created_at > now() - interval '1 day') >= 3 then
    return jsonb_build_object('ok', false, 'error', 'day');
  end if;
  if (select count(*) from ride_suggestions s where s.customer_id = any(v_accts) and s.status = 'new') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'open');
  end if;
  insert into ride_suggestions (customer_id, kind, body) values (p_id, p_kind, v_body) returning * into r;
  return jsonb_build_object('ok', true, 'row', jsonb_build_object('id', r.id, 'kind', r.kind, 'body', r.body, 'status', 'sent',
    'reply', null, 'at', r.created_at, 'day', to_char(r.created_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD')));
end $$;
revoke all on function public.ride_suggest(text, text, text, text) from public;
grant execute on function public.ride_suggest(text, text, text, text) to anon, authenticated;

create or replace function public.ride_suggestions_mine(p_id text, p_token text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_rows jsonb;
begin
  if p_id is null or p_token is null or not _cust_token_ok(p_id, p_token) then return jsonb_build_object('ok', false, 'error', 'denied'); end if;
  select coalesce(jsonb_agg(x.j order by x.created_at desc, x.id desc), '[]'::jsonb) into v_rows
    from (select s.created_at, s.id, jsonb_build_object(
                   'id', s.id, 'kind', s.kind, 'body', s.body,
                   'status', case when s.status in ('planned', 'done') then s.status else 'sent' end,
                   'reply', s.reply, 'at', s.created_at,
                   'day', to_char(s.created_at at time zone 'Asia/Riyadh', 'YYYY-MM-DD')) as j
            from ride_suggestions s
           where s.customer_id = any(_accts_of(p_id))
           order by s.created_at desc, s.id desc
           limit 50) x;
  return jsonb_build_object('ok', true, 'rows', v_rows);
end $$;
revoke all on function public.ride_suggestions_mine(text, text) from public;
grant execute on function public.ride_suggestions_mine(text, text) to anon, authenticated;


/* -- 5. staff ------------------------------------------------------------------------------------ */
create or replace function public.staff_ride_suggestion_set(p_sid bigint, p_status text default null, p_reply text default null)
returns jsonb
language plpgsql volatile security definer set search_path to 'public'
as $$
declare r ride_suggestions%rowtype; v_reply text := btrim(p_reply);
begin
  if not (select _staff_mod('community', true)) then raise exception 'FORBIDDEN' using errcode = '42501'; end if;
  if (p_status is not null and p_status not in ('new', 'planned', 'done', 'closed')) or char_length(coalesce(v_reply, '')) > 300 then
    raise exception 'BAD_INPUT' using errcode = '22023';
  end if;
  update ride_suggestions s
     set status = coalesce(p_status, s.status),
         status_at = case when p_status is not null and p_status <> s.status then now() else s.status_at end,
         reply = case when p_reply is null then s.reply else nullif(v_reply, '') end,
         staff_user = auth.uid()
   where s.id = p_sid
  returning * into r;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', r.id, 'customer_id', r.customer_id, 'kind', r.kind, 'body', r.body, 'status', r.status,
                            'reply', r.reply, 'created_at', r.created_at, 'status_at', r.status_at);
end $$;
revoke all on function public.staff_ride_suggestion_set(bigint, text, text) from public, anon;
grant execute on function public.staff_ride_suggestion_set(bigint, text, text) to authenticated;


/* -- 6. checks ----------------------------------------------------------------------------------- */
do $chk$
declare f text;
begin
  foreach f in array array['public._updates_suggestion()', 'public.ride_suggest(text,text,text,text)',
                           'public.ride_suggestions_mine(text,text)', 'public.staff_ride_suggestion_set(bigint,text,text)'] loop
    if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                     and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
      raise exception '% is missing, or lost SECURITY DEFINER or its search_path', f;
    end if;
  end loop;
  if has_function_privilege('anon', 'public._updates_suggestion()', 'execute') or has_function_privilege('authenticated', 'public._updates_suggestion()', 'execute') then
    raise exception '_updates_suggestion is executable by a client';
  end if;
  if has_function_privilege('anon', 'public.staff_ride_suggestion_set(bigint,text,text)', 'execute') then
    raise exception 'staff_ride_suggestion_set is executable by anon';
  end if;
  if not has_function_privilege('anon', 'public.ride_suggest(text,text,text,text)', 'execute')
     or not has_function_privilege('anon', 'public.ride_suggestions_mine(text,text)', 'execute') then
    raise exception 'a rider call is not executable by anon';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ride_suggestions'::regclass) then raise exception 'ride_suggestions has no RLS'; end if;
  if has_table_privilege('anon', 'public.ride_suggestions', 'select') or has_table_privilege('authenticated', 'public.ride_suggestions', 'insert')
     or has_table_privilege('authenticated', 'public.ride_suggestions', 'update') or has_table_privilege('authenticated', 'public.ride_suggestions', 'delete') then
    raise exception 'ride_suggestions is writable by a client, or readable by anon';
  end if;
  if (select count(*) from public.push_words where key in ('sugplan', 'sugdone')) <> 20 then raise exception 'the suggestion words are not all there'; end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118210500', 'ride_suggestions')
on conflict (version) do nothing;

commit;

notify pgrst, 'reload schema';

-- check (read only): the table with RLS and its one policy, the four functions definers, the trigger, the words, the ledger.
-- select (select relrowsecurity from pg_class where oid = 'public.ride_suggestions'::regclass) as rls_true,
--        (select count(*) from pg_policies where schemaname = 'public' and tablename = 'ride_suggestions') as policies_1,
--        (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
--          and proname in ('_updates_suggestion', 'ride_suggest', 'ride_suggestions_mine', 'staff_ride_suggestion_set')) as definer_4,
--        has_function_privilege('anon', 'public.ride_suggest(text,text,text,text)', 'execute') as anon_suggest_true,
--        has_function_privilege('anon', 'public.staff_ride_suggestion_set(bigint,text,text)', 'execute') as anon_staff_false,
--        has_table_privilege('anon', 'public.ride_suggestions', 'select') as anon_table_false,
--        (select count(*) from pg_trigger where tgname = 'ride_suggestions_updates') as trigger_1,
--        (select count(*) from public.push_words where key in ('sugplan', 'sugdone')) as words_20,
--        (select name from supabase_migrations.schema_migrations where version = '20261118210500') as ledger;
