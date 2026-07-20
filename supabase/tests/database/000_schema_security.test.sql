begin;

create extension if not exists pgtap with schema extensions;

select plan(25);

select extensions.has_table('public', 'families', 'families table exists');
select extensions.has_table('public', 'family_members', 'family_members table exists');
select extensions.has_table('public', 'tasks', 'tasks table exists');
select extensions.has_table('public', 'daily_task_states', 'daily task state table exists');
select extensions.has_table('public', 'reward_transactions', 'append-only reward ledger exists');
select extensions.has_table('public', 'timer_sessions', 'timer session table exists');
select extensions.has_table('public', 'history_days', 'history table exists');
select extensions.has_table('public', 'rpc_operations', 'idempotency table exists');

select extensions.has_function('public', 'get_family_snapshot', array[]::text[], 'snapshot RPC exists');
select extensions.has_function(
  'public', 'submit_task', array['text', 'integer', 'text'], 'child submission RPC exists'
);
select extensions.has_function(
  'public', 'review_task', array['uuid', 'text', 'text'], 'parent review RPC exists'
);
select extensions.has_function(
  'public', 'start_timer', array['integer', 'text'], 'timer start RPC exists'
);

select extensions.ok(
  (select bool_and(c.relrowsecurity)
   from pg_catalog.pg_class as c
   join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in (
       'families', 'family_members', 'family_settings', 'parent_secrets', 'tasks',
       'daily_family_states', 'daily_task_states', 'reward_transactions',
       'timer_sessions', 'history_days', 'activity_events', 'family_invites', 'rpc_operations'
     )),
  'RLS is enabled on every cloud table'
);

select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.reward_transactions', 'INSERT'),
  'authenticated clients cannot insert ledger rows directly'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.reward_transactions', 'UPDATE'),
  'authenticated clients cannot update ledger rows directly'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.reward_transactions', 'DELETE'),
  'authenticated clients cannot delete ledger rows directly'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.parent_secrets', 'SELECT'),
  'parent PIN digest table is not directly readable'
);
select extensions.ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.family_invites', 'SELECT'),
  'invite digest table is not directly readable'
);

select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated', 'public.get_family_snapshot()', 'EXECUTE'
  ),
  'authenticated sessions can execute snapshot RPC'
);
select extensions.ok(
  pg_catalog.has_function_privilege(
    'authenticated', 'public.submit_task(text,integer,text)', 'EXECUTE'
  ),
  'authenticated sessions can execute child submission RPC'
);

select extensions.ok(
  exists (
    select 1 from pg_catalog.pg_trigger
    where tgname = 'reward_transactions_append_only' and not tgisinternal
  ),
  'append-only reward ledger trigger is installed'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'reward_transactions_award_revision_unique'
  ),
  'one award per task approval revision is enforced'
);
select extensions.ok(
  exists (
    select 1
    from pg_catalog.pg_indexes
    where schemaname = 'public'
      and indexname = 'timer_sessions_one_active_per_family'
  ),
  'only one active timer per family is enforced'
);
select extensions.ok(
  not exists (
    select 1
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, array[]::text[])) as cfg
        where cfg like 'search_path=%'
      )
  ),
  'every SECURITY DEFINER function pins search_path'
);

select extensions.ok(
  not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'family_invites'
      and column_name in ('token', 'raw_token', 'invite_code')
  ),
  'invite plaintext is not persisted'
);

select * from extensions.finish();
rollback;
