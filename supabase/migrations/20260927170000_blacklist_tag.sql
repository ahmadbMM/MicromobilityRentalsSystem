-- The blacklist tag (2026-09-27): a locked system tag staff put on an account that is not fit to
-- be in the community. The app wears it black with the white mark struck through
-- (TAG_BRANDS.blacklist in app.src.html), points it out when the Community tag is granted to its
-- holder or an application of theirs is approved, and offers to drop the Community tag when it
-- is granted. Data only: no schema change, no grant change.
insert into public.tags (id, slug, name, color, description, auto_grant, locked, created_at)
values ('tag_blacklist', 'blacklist', 'Blacklist', '#0b0b0b',
        'Not fit to be in the community. Shown black on the account; granting Community or approving an application asks again.',
        false, true, (extract(epoch from now()) * 1000)::bigint)
on conflict (id) do nothing;
