-- ============================================================================
-- Every community member gives their Instagram (the owner, 2026-10-09: "force all community members to
-- add their instagram accounts for whoever who hasn't have it").
--
--  _customer_asks asks 'instagram' of an account holding a live Community tag (tag_saturday) with no
--  Instagram handle on file, beside the member's birth date, nationality and WhatsApp. That one rule
--  makes the booking app's check-up open at sign-in with no way past it but Log out
--  (customer_fix_fields), customer_fix_save take the handle (it already does, under the account page's
--  rule), and customer_create_booking refuse the member's next booking meanwhile (FIX_FIRST).
--  customer_fix_save no longer clears a member's Instagram on "I don't have one" (the answer staff's
--  flag on a handle offers): for a member it is required, as the first emergency contact is.
--  Patched in place from the live definitions.
--
-- Rollback: replace each block below back to its anchor.
-- Idempotent (skipped when the functions already carry '(20261009235000)').
-- Run supabase/checks/security-attributes.sql after.
-- ============================================================================

begin;

create or replace function pg_temp._once(def text, a text, b text) returns text language plpgsql as $f$
begin
  if (length(def) - length(replace(def, a, ''))) / length(a) <> 1 then
    raise exception 'anchor not found exactly once: %', left(a, 90);
  end if;
  return replace(def, a, b);
end $f$;

do $asks$
declare d text;
begin
  d := pg_get_functiondef('public._customer_asks(text)'::regprocedure);
  if position('(20261009235000)' in d) > 0 then
    raise notice '_customer_asks already asks a member for Instagram; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$      f := f || 'whatsapp'::text;
    end if;
$a$,
$b$      f := f || 'whatsapp'::text;
    end if;
    -- and their Instagram (20261009235000)
    if coalesce(btrim(c.socials->>'instagram'),'') = '' and not ('instagram' = any(f)) then
      f := f || 'instagram'::text;
    end if;
$b$);
  execute d;
end $asks$;
revoke execute on function public._customer_asks(text) from public, anon, authenticated;

do $save$
declare d text;
begin
  d := pg_get_functiondef('public.customer_fix_save(text,text,jsonb)'::regprocedure);
  if position('(20261009235000)' in d) > 0 then
    raise notice 'customer_fix_save already keeps a member''s Instagram; nothing to do';
    return;
  end if;
  d := pg_temp._once(d,
$a$        when 'instagram', 'x', 'tiktok', 'linkedin' then
          update customers set socials = nullif(coalesce(socials,'{}'::jsonb) - k, '{}'::jsonb) where id = p_id;$a$,
$b$        when 'instagram', 'x', 'tiktok', 'linkedin' then
          -- a community member's Instagram is required: never cleared here (20261009235000)
          if k = 'instagram' and exists (select 1 from customer_tags ct
                                          where ct.customer_id = p_id and ct.tag_id = 'tag_saturday'
                                            and _ctag_active(ct.starts_at, ct.expires_at)) then
            continue;
          end if;
          update customers set socials = nullif(coalesce(socials,'{}'::jsonb) - k, '{}'::jsonb) where id = p_id;$b$);
  execute d;
end $save$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261009235000', 'community_instagram_required')
on conflict (version) do nothing;

notify pgrst, 'reload schema';

commit;

-- Check (read-only), after:
--   select p.proname, p.prosecdef, position('(20261009235000)' in pg_get_functiondef(p.oid)) > 0
--     from pg_proc p where p.oid in ('public._customer_asks(text)'::regprocedure,
--                                    'public.customer_fix_save(text,text,jsonb)'::regprocedure);   -- t, t twice
