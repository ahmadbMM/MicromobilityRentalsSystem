-- ============================================================================
-- 20261119001000_bh18_ambassador_board
--
-- The public ambassador board on micromobility.sa/ambassadors (ambassador_board, open to anyone) showed other riders'
-- first names, their personal ambassador codes and how many times each code was used (bug hunt 2026-11-18,
-- web-components2-1). The owner, 2026-11-18: the board does not show other riders' names or codes. ambassador_board now
-- answers an empty list: the website draws no board for an empty list, and nobody can read the names or codes through
-- the API either. Its signature and grants are unchanged, so nothing that calls it breaks.
-- Copied from 20260924180000_ambassadors_club.sql (its only definition). No data is changed.
-- Rollback: re-run the definition from 20260924180000.
-- ============================================================================

begin;
set local lock_timeout = '5s';

create or replace function public.ambassador_board()
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- No other rider's name, code or use count to the public (the owner, 2026-11-18; bh18 web-components2-1) (20261119001000)
  return '[]'::jsonb;
end $function$;
revoke all on function public.ambassador_board() from public;
grant execute on function public.ambassador_board() to anon, authenticated;

do $chk$
begin
  if not exists (select 1 from pg_proc p where p.oid = 'public.ambassador_board()'::regprocedure and p.prosecdef
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'ambassador_board lost SECURITY DEFINER or its search_path';
  end if;
end $chk$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119001000', 'bh18_ambassador_board')
on conflict (version) do nothing;

commit;

-- check: select public.ambassador_board() = '[]'::jsonb, (select count(*) from supabase_migrations.schema_migrations where version = '20261119001000');
