-- ============================================================================
-- A partner booking needs the account's date of birth, nationality and Instagram (the owner,
-- 2026-10-23: "ask them for their instagram accounts and dob and nationalities" ... "make sure that
-- accounts that are already existing adds them if they hadn't before"). micromobility.sa/defe asks
-- the three of every rider and saves them on the account before booking (site 05f47f1); partner_book
-- now refuses an account without any of them with FIX_FIRST, so no partner booking is made without
-- them whatever sends it. partner_book is otherwise as 20261023120000 has it.
-- Rollback: partner_book as 20261023120000_partner_codes.sql has it.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.partner_book(p_id text, p_token text, p_partner text, p_code text, p_entry jsonb)
 returns table(id text, queue_num integer, status text)
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare sp session_partners%rowtype; pc session_partner_codes%rowtype; r record; _code boolean;
        _name text; _ask jsonb; _got text; _size text;
begin
  if not _cust_token_ok(p_id, p_token) then
    raise exception 'STALE_SESSION' using errcode = 'P0001';
  end if;
  if p_entry is null or jsonb_typeof(p_entry) <> 'object' then
    raise exception 'BAD_INPUT' using errcode = '22023', detail = 'entry';
  end if;
  -- Every partner booking's account has a date of birth, a nationality and an Instagram (the owner,
  -- 2026-10-23): the page asks them of every rider and saves them first; an account still without one
  -- is sent back to the details (FIX_FIRST, which the page answers by opening them).
  if not exists (select 1 from customers c
                  where c.id = p_id
                    and nullif(btrim(coalesce(c.birth_date, '')), '') is not null
                    and nullif(btrim(coalesce(c.nationality, '')), '') is not null
                    and nullif(btrim(coalesce(c.socials->>'instagram', '')), '') is not null) then
    raise exception 'FIX_FIRST' using errcode = 'P0001', detail = 'birth_date,nationality,instagram';
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
  -- One booking at a time per partner ride: the places and each code's places are counted under it.
  perform pg_advisory_xact_lock(hashtext('partner:' || sp.session_id || ':' || sp.partner));
  if _partner_live(sp.session_id, sp.partner, false) >= sp.places then
    raise exception 'PARTNER_FULL' using errcode = 'P0001';
  end if;
  _code := sp.code_needed;
  if _code then
    -- One of the ride's codes (20261023120000), each with its own places.
    select * into pc from session_partner_codes c
     where c.session_id = sp.session_id and c.partner = sp.partner
       and lower(c.code) = lower(btrim(coalesce(p_code, '')));
    if pc.code is null then
      raise exception 'BAD_CODE' using errcode = 'P0001';
    end if;
    if _partner_code_live(sp.session_id, sp.partner, pc.code) >= pc.places then
      raise exception 'CODE_USED_UP' using errcode = 'P0001';
    end if;
  end if;
  select c.name into _name from customers c where c.id = p_id;
  perform set_config('mm.partner', sp.session_id || '|' || sp.partner || '|' || case when _code then '1' else '0' end, true);
  perform set_config('mm.partner_ask', coalesce(_ask::text, ''), true);
  perform set_config('mm.partner_code', case when _code then pc.code else '' end, true);
  for r in
    select * from customer_create_booking(p_id, p_token, jsonb_build_array(
      (p_entry - 'promo_code' - 'group_id' - 'run_km' - 'share_ok' - 'ask')
      || jsonb_build_object('session_id', sp.session_id, 'name', coalesce(_name, ''))))
  loop
    -- No waitlist for a partner (the owner, 2026-10-23): a place, or nothing at all.
    if r.status = 'waitlist' then
      raise exception 'PARTNER_FULL' using errcode = 'P0001';
    end if;
    id := r.id; queue_num := r.queue_num; status := r.status;
    return next;
  end loop;
  perform set_config('mm.partner', '', true);
  perform set_config('mm.partner_ask', '', true);
  perform set_config('mm.partner_code', '', true);
end $function$;
revoke all on function public.partner_book(text, text, text, text, jsonb) from public;
grant execute on function public.partner_book(text, text, text, text, jsonb) to anon, authenticated;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261023170000', 'partner_needs_details')
on conflict (version) do nothing;

commit;

-- Check (read only): the check is in, partner_book still a definer with its search_path.
select prosecdef as definer, proconfig as settings, prosrc like '%FIX_FIRST%' as checks_details
  from pg_proc where oid = 'public.partner_book(text,text,text,text,jsonb)'::regprocedure;
