# Supabase migrations — workflow

All schema changes from now on live here as timestamped SQL files managed by the
[Supabase CLI](https://supabase.com/docs/guides/local-development/overview). One-time setup:

```bash
npm i -g supabase          # or: brew install supabase/tap/supabase
supabase login
supabase link --project-ref qpffkzmsfyilicwcsszz
```

## Capture the baseline (do this once, before the first new migration)

Production already has a schema built up from hand-run scripts (see `sql/applied/`).
Snapshot it so every future diff is relative to reality:

```bash
supabase db dump --schema public -f supabase/migrations/00000000000000_baseline.sql
```

Commit that file. It is a record, not something to run on prod (prod already matches it).

## Making a change

```bash
supabase migration new add_thing        # creates supabase/migrations/<timestamp>_add_thing.sql
# write the SQL in that file (additive-only house rule: new tables/columns/policies,
# no destructive rewrites of live tables)
supabase db push                        # applies pending migrations to the linked project
```

Test on the staging project first (`ariyvnxeywozmwxmylhb`): `supabase link` to staging,
`db push`, verify the app, then re-link and push to prod. Commit the migration file in the
same PR as the app change that needs it.

## Rules

1. Never edit an applied migration — write a new one.
2. Additive-only against live tables (matches the platform house rule).
3. Anything touching RLS/policies follows the SECURITY-RUNBOOK staging-first procedure.
4. The dashboard SQL editor is for reading, not schema changes.
