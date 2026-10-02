-- The owner, 2026-10-03: a rider can change their password whenever they like, and see their own
-- desk purchases, in the booking app's My Account and the website's Account section alike.
--
-- customer_change_password(p_id, p_token, p_current, p_new) -> the new session token
--   Signed-in riders only (the session token). An account with a password must give it
--   (BAD_PASSWORD); an account that never had one (Google/Apple only) sets one without. The new one
--   follows the forced-change rules: 8+ characters, a capital letter, a digit (WEAK_PASSWORD), not
--   the current one (SAME_PASSWORD). Five wrong current passwords lock changes for 15 minutes
--   (LOCKED; login_throttle key 'pwchange:<id>', the sign-in throttle's table). A change mints a new
--   token, so every other device is signed out, and clears a pending forced change.
--
-- customer_purchases(p_id, p_token) -> jsonb array, newest first
--   The rider's own desk sales (cashier_sales.customer_id): what, how many, price, how paid, the
--   ride it was at, and whether it was voided or refunded. Customers cannot read cashier_sales
--   itself (staff-only); this is the one door, token-checked.

create or replace function public.customer_change_password(p_id text, p_token text, p_current text, p_new text)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare c customers%rowtype; tok text; ident text; thr login_throttle%rowtype; nfails int; has_pwd boolean;
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'BAD_TOKEN' using errcode = '28000'; end if;
  ident := 'pwchange:' || p_id;
  select * into thr from login_throttle where identifier = ident;
  if thr.locked_until is not null and thr.locked_until > now() then
    raise exception 'LOCKED' using errcode = 'P0001';
  end if;
  select * into c from customers where id = p_id for update;
  has_pwd := left(coalesce(c.password_hash, ''), 2) = '$2' or left(coalesce(c.password_hash, ''), 7) = 'sha256:';
  if has_pwd and not _cust_pwd_ok(c.password_hash, coalesce(p_current, '')) then
    nfails := (case when thr.locked_until is not null and thr.locked_until <= now() then 0 else coalesce(thr.fails, 0) end) + 1;
    insert into login_throttle(identifier, fails, locked_until)
      values (ident, nfails, case when nfails >= 5 then now() + interval '15 minutes' else null end)
      on conflict (identifier) do update set fails = excluded.fails, locked_until = excluded.locked_until;
    raise exception 'BAD_PASSWORD' using errcode = '28P01';
  end if;
  if length(coalesce(p_new, '')) < 8 or p_new !~ '[A-Z]' or p_new !~ '[0-9]' then
    raise exception 'WEAK_PASSWORD' using errcode = '22023';
  end if;
  if has_pwd and _cust_pwd_ok(c.password_hash, p_new) then raise exception 'SAME_PASSWORD' using errcode = '22023'; end if;
  delete from login_throttle where identifier = ident;
  tok := encode(gen_random_bytes(24), 'hex');
  update customers set password_hash = crypt(p_new, gen_salt('bf')), session_token = tok, must_change_pwd = false
   where id = p_id;
  return tok;
end $function$;

create or replace function public.customer_purchases(p_id text, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not _cust_token_ok(p_id, p_token) then raise exception 'BAD_TOKEN' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', s.id, 'at', s.created_at, 'name', s.name, 'category', s.category, 'qty', s.qty,
             'price', s.price, 'pay', s.pay, 'receipt_id', s.receipt_id,
             'session_date', se.session_date, 'session_title', se.title,
             'voided', s.voided_at is not null, 'refunded', s.refunded_at is not null)
           order by s.created_at desc)
      from cashier_sales s left join sessions se on se.id = s.session_id
     where s.customer_id = p_id), '[]'::jsonb);
end $function$;

revoke all on function public.customer_change_password(text, text, text, text) from public;
revoke all on function public.customer_purchases(text, text) from public;
grant execute on function public.customer_change_password(text, text, text, text) to anon, authenticated;
grant execute on function public.customer_purchases(text, text) to anon, authenticated;
