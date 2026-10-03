-- ============================================================================
-- fnb_login without the per-network meter.
--
-- The venue portal signs in from its Cloudflare Worker, so every venue reaches the database
-- from the Worker's address: _ip_gate('fnb_login', 30, 10 min) would count ALL venues as one
-- network, and 30 tries anywhere would lock every venue out for ten minutes. The Worker meters
-- sign-ins per real address (Cloudflare rate limiter), and each login still locks after 8 wrong
-- passwords for 15 minutes (login_throttle 'fnb:<login>'), the same rule customer_login keeps.
--
-- Rollback: re-run fnb_login from 20261003150000_fnb_partners.sql.
-- Idempotent.
-- ============================================================================

create or replace function public.fnb_login(p_login text, p_pwd text)
returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $$
declare k text := _fnb_login_key(p_login); u fnb_users%rowtype; thr login_throttle%rowtype; nf int; tok text;
begin
  if k is null or coalesce(p_pwd, '') = '' then raise exception 'BAD_LOGIN' using errcode = '28000'; end if;
  select * into thr from login_throttle where identifier = 'fnb:' || k;
  if thr.locked_until is not null and thr.locked_until > now() then raise exception 'LOCKED' using errcode = 'P0001'; end if;
  select x.* into u from fnb_users x join fnb_venues v on v.id = x.venue_id
   where x.login = k and x.active and v.status <> 'ended';
  if not found or u.password_hash is null or crypt(p_pwd, u.password_hash) <> u.password_hash then
    nf := (case when (thr.locked_until is not null and thr.locked_until <= now()) or thr.updated_at < now() - interval '1 day'
                then 0 else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until, updated_at)
      values ('fnb:' || k, nf, case when nf >= 8 then now() + interval '15 minutes' end, now())
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until, updated_at = excluded.updated_at;
    -- Answered, not raised: an exception would undo the failure count above (as customer_login does).
    return jsonb_build_object('error', 'BAD_LOGIN');
  end if;
  delete from login_throttle where identifier = 'fnb:' || k;
  tok := coalesce(nullif(u.session_token, ''), encode(gen_random_bytes(24), 'hex'));
  update fnb_users set session_token = tok, last_login_at = now() where id = u.id;
  return jsonb_build_object('id', u.id, 'token', tok, 'must_change', u.must_change_pwd);
end $$;

revoke all on function public.fnb_login(text, text) from public;
grant execute on function public.fnb_login(text, text) to anon, authenticated;
