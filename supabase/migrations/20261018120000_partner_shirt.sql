-- A Defe booking says whether the rider already has a Defe shirt (the owner, 2026-10-18: "include a
-- question that asks if the person signing up has received a Defe Shirt on the 22nd of October? If they
-- don't have a shirt, I just want to know what size they are ... we want to give the shirts to people
-- who haven't received them instead of people getting two shirts"). Asked on micromobility.sa/defe only.
--
--  1. queue_entries.partner_ask: the partner page's own answers, {shirt_got: true} or
--     {shirt_got: false, shirt: 'XS'|'S'|'M'|'L'|'XL'|'XXL'}; null on every other booking.
--  2. partner_book(...) takes entry.ask, checks it (BAD_INPUT 'ask', SHIRT_SIZE when no shirt and no
--     size) and hands it to the insert through the GUC mm.partner_ask, the way mm.partner carries the
--     partner. An entry without ask books as before (a page opened before this change).
--  3. _partner_ask_fill (BEFORE INSERT, after queue_entries_community_gate by name): writes the answer
--     only on the partner booking partner_book is making; any other insert gets null.
--
-- Undo:
--   drop trigger if exists queue_entries_partner_ask on public.queue_entries;
--   drop function if exists public._partner_ask_fill();
--   alter table public.queue_entries drop column if exists partner_ask;
--   (and partner_book as 20261017120000 has it)

begin;

alter table public.queue_entries add column if not exists partner_ask jsonb;
alter table public.queue_entries drop constraint if exists queue_entries_partner_ask_object;
alter table public.queue_entries add constraint queue_entries_partner_ask_object
  check (partner_ask is null or jsonb_typeof(partner_ask) = 'object');
comment on column public.queue_entries.partner_ask is
  'A partner page''s own answers: {shirt_got, shirt} (Defe shirt, 20261018120000); null on every other booking.';

create or replace function public._partner_ask_fill()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare pb text[]; a text;
begin
  pb := string_to_array(coalesce(current_setting('mm.partner', true), ''), '|');
  a := nullif(current_setting('mm.partner_ask', true), '');
  if a is not null and cardinality(pb) = 3 and pb[1] = new.session_id and new.partner = pb[2] then
    new.partner_ask := a::jsonb;
  else
    new.partner_ask := null;
  end if;
  return new;
end $function$;

drop trigger if exists queue_entries_partner_ask on public.queue_entries;
create trigger queue_entries_partner_ask before insert on public.queue_entries
  for each row execute function public._partner_ask_fill();

create or replace function public.partner_book(p_id text, p_token text, p_partner text, p_code text, p_entry jsonb)
 returns table(id text, queue_num integer, status text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare sp session_partners%rowtype; r record; _code boolean; _name text; _ask jsonb; _got text; _size text;
begin
  if not _cust_token_ok(p_id, p_token) then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'entry';
  end if;
  -- The partner page's question (Defe shirt, 20261018120000): had one on 22 October, or the size wanted.
  if p_entry ? 'ask' and jsonb_typeof(p_entry->'ask') <> 'null' then
    if jsonb_typeof(p_entry->'ask') <> 'object' then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'ask';
    end if;
    _got := p_entry->'ask'->>'shirt_got';
    if _got is null or _got not in ('true', 'false') then
      raise exception 'BAD_INPUT' using errcode = '22023', detail = 'ask';
    end if;
    if _got = 'true' then
      _ask := jsonb_build_object('shirt_got', true);
    else
      _size := upper(btrim(coalesce(p_entry->'ask'->>'shirt', '')));
      if _size not in ('XS', 'S', 'M', 'L', 'XL', 'XXL') then
        raise exception 'SHIRT_SIZE' using errcode = 'P0001';
      end if;
      _ask := jsonb_build_object('shirt_got', false, 'shirt', _size);
    end if;
  end if;
  sp := _partner_session(p_partner);
  if sp.session_id is null then
    raise exception 'PARTNER_CLOSED' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('partner:' || sp.session_id || ':' || sp.partner));
  if _partner_live(sp.session_id, sp.partner, false) >= sp.places then
    raise exception 'PARTNER_FULL' using errcode = 'P0001';
  end if;
  _code := sp.code_needed;
  if _code then
    if sp.code is null or lower(btrim(coalesce(p_code, ''))) <> lower(sp.code) then
      raise exception 'BAD_CODE' using errcode = 'P0001';
    end if;
    if sp.code_limit is not null and _partner_live(sp.session_id, sp.partner, true) >= sp.code_limit then
      raise exception 'CODE_USED_UP' using errcode = 'P0001';
    end if;
  end if;
  select c.name into _name from customers c where c.id = p_id;
  perform set_config('mm.partner', sp.session_id || '|' || sp.partner || '|' || case when _code then '1' else '0' end, true);
  perform set_config('mm.partner_ask', coalesce(_ask::text, ''), true);
  for r in
    select * from customer_create_booking(p_id, p_token, jsonb_build_array(
      (p_entry - 'promo_code' - 'group_id' - 'run_km' - 'share_ok' - 'ask')
      || jsonb_build_object('session_id', sp.session_id, 'name', coalesce(_name, ''))))
  loop
    id := r.id; queue_num := r.queue_num; status := r.status;
    return next;
  end loop;
  perform set_config('mm.partner', '', true);
  perform set_config('mm.partner_ask', '', true);
end $function$;
revoke all on function public.partner_book(text, text, text, text, jsonb) from public;
grant execute on function public.partner_book(text, text, text, text, jsonb) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261018120000', 'partner_shirt')
on conflict (version) do nothing;

commit;

-- Check (read only): the column, the trigger, and partner_book still a definer with its search_path.
select (select count(*) from information_schema.columns
         where table_name = 'queue_entries' and column_name = 'partner_ask') as col,
       (select count(*) from pg_trigger where tgname = 'queue_entries_partner_ask') as trg,
       (select prosecdef from pg_proc where oid = 'public.partner_book(text,text,text,text,jsonb)'::regprocedure) as definer,
       (select proconfig from pg_proc where oid = 'public.partner_book(text,text,text,text,jsonb)'::regprocedure) as settings;
