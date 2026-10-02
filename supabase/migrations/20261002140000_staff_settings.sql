-- A Settings page for every staff account (the owner, 2026-10-02: "add a settings page in the staff
-- website to let them choose which notifications to allow and deny and make them able to change
-- their name email and password from there too and to add a picture").
--
-- staff gains three fields of the account's own:
--   display_name  the name the account goes by (it was only in auth user_metadata.op_name)
--   photo         a small square picture (256 px): its address in the photos bucket, or a data URL
--   nt_off        the bell's kinds this account has turned off
-- The table keeps its one policy (staff read self); nobody writes it directly. Two functions write
-- the caller's own row, and only that:
--   staff_my_settings(p_name, p_photo, p_set_photo, p_nt_off)  name, picture, notifications
--   staff_set_own_email(p_password, p_email)                     the sign-in email, after the
--                                                                current password checks out
-- The password itself changes through Supabase Auth (updateUser) once the app has checked the
-- current one, as the existing dialog does.

alter table public.staff add column if not exists display_name text;
alter table public.staff add column if not exists photo text;
alter table public.staff add column if not exists nt_off text[] not null default '{}';

-- Name, picture and notifications. A null argument leaves that field as it is; the picture is
-- cleared with p_set_photo = true and p_photo null. The new name also becomes the account's
-- op_name (what a new device restores at the operator gate) and renames the account's own entry
-- in the team's name list, when it had one and the new name is free, so its PIN goes with it.
create or replace function public.staff_my_settings(p_name text default null, p_photo text default null,
                                                    p_set_photo boolean default false, p_nt_off text[] default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  _uid uuid := auth.uid(); _old text; _new text; _off text[];
begin
  if _uid is null or not exists (select 1 from staff where user_id = _uid) then
    raise exception 'NOT_STAFF' using errcode = '42501';
  end if;
  if p_name is not null then
    _new := left(btrim(regexp_replace(p_name, '\s+', ' ', 'g')), 40);
    if length(_new) < 2 then raise exception 'BAD_NAME' using errcode = '22023'; end if;
    select coalesce(nullif(btrim(s.display_name), ''), nullif(btrim(u.raw_user_meta_data->>'op_name'), ''))
      into _old from staff s join auth.users u on u.id = s.user_id where s.user_id = _uid;
    update staff set display_name = _new where user_id = _uid;
    update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('op_name', _new)
     where id = _uid;
    if _old is not null and _old <> _new
       and not exists (select 1 from team_members where lower(name) = lower(_new)) then
      update team_members set name = _new where name = _old;
    end if;
  end if;
  if p_set_photo then
    -- the photos bucket's own address (where the app uploads it), or a small data URL when the upload failed
    if p_photo is not null
       and p_photo !~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/photos/p/[A-Za-z0-9_-]{1,64}\.jpg$'
       and (p_photo !~ '^data:image/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$' or length(p_photo) > 200000) then
      raise exception 'BAD_PHOTO' using errcode = '22023';
    end if;
    update staff set photo = p_photo where user_id = _uid;
  end if;
  if p_nt_off is not null then
    select coalesce(array_agg(distinct k), '{}') into _off
      from unnest(p_nt_off) k where k in ('long','ws','apps','learn','bday','msgs','attn','lowrate','stock');
    update staff set nt_off = _off where user_id = _uid;
  end if;
  return (select jsonb_build_object('display_name', display_name, 'photo', photo, 'nt_off', nt_off)
            from staff where user_id = _uid);
end $function$;

-- The sign-in email. The current password is checked here, against the account's own hash, so a
-- device left signed in cannot hand the account to someone else's address. The address must be
-- free; the change is immediate (no confirmation mail: the project sends none).
create or replace function public.staff_set_own_email(p_password text, p_email text)
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  _uid uuid := auth.uid(); _hash text; _email text := lower(btrim(coalesce(p_email, '')));
begin
  if _uid is null or not exists (select 1 from staff where user_id = _uid) then
    raise exception 'NOT_STAFF' using errcode = '42501';
  end if;
  select encrypted_password into _hash from auth.users where id = _uid;
  if _hash is null or coalesce(p_password, '') = '' or extensions.crypt(p_password, _hash) <> _hash then
    raise exception 'BAD_PASSWORD' using errcode = '28P01';
  end if;
  if _email !~ '^[^[:space:]@<>"''()]+@[^[:space:]@<>"''()]+\.[^[:space:]@<>"''()]+$' or length(_email) > 120 then
    raise exception 'BAD_EMAIL' using errcode = '22023';
  end if;
  if exists (select 1 from auth.users where lower(email) = _email and id <> _uid) then
    raise exception 'EMAIL_TAKEN' using errcode = '23505';
  end if;
  update auth.users set email = _email, email_confirmed_at = coalesce(email_confirmed_at, now()),
         email_change = '', email_change_token_new = '', email_change_token_current = '', updated_at = now()
   where id = _uid;
  update auth.identities set identity_data = coalesce(identity_data, '{}'::jsonb) || jsonb_build_object('email', _email),
         updated_at = now()
   where user_id = _uid and provider = 'email';
  return _email;
end $function$;

revoke all on function public.staff_my_settings(text, text, boolean, text[]) from public, anon;
revoke all on function public.staff_set_own_email(text, text) from public, anon;
grant execute on function public.staff_my_settings(text, text, boolean, text[]) to authenticated;
grant execute on function public.staff_set_own_email(text, text) to authenticated;

-- Check: both run as their owner.
do $chk$
begin
  if not (select bool_and(prosecdef) from pg_proc where oid in
      ('public.staff_my_settings(text,text,boolean,text[])'::regprocedure, 'public.staff_set_own_email(text,text)'::regprocedure)) then
    raise exception 'staff settings functions are not SECURITY DEFINER';
  end if;
end $chk$;
