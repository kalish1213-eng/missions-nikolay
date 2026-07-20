-- Missions Nikolay: normalized, tenant-isolated cloud data model.
-- No production family or child data is seeded by this migration.

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create type public.family_role as enum ('parent', 'child');
create type public.task_kind as enum ('standard', 'pushups', 'custom');
create type public.task_status as enum ('todo', 'pending', 'approved', 'rejected');
create type public.reward_transaction_type as enum ('award', 'reversal', 'manual', 'reset');
create type public.timer_status as enum ('active', 'finished', 'stopped', 'cancelled');
create type public.activity_type as enum (
  'submitted', 'approved', 'rejected', 'reversed', 'manual', 'timer', 'reset', 'settings'
);
create type public.theme_preference as enum ('system', 'light', 'dark');

create table public.families (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 80),
  child_name text not null check (char_length(btrim(child_name)) between 1 and 80),
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.family_role not null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  constraint family_members_user_unique unique (user_id),
  constraint family_members_family_user_unique unique (family_id, user_id)
);

create index family_members_active_family_idx
  on public.family_members (family_id, role)
  where revoked_at is null;

create unique index family_members_one_active_child
  on public.family_members (family_id)
  where role = 'child' and revoked_at is null;

create table public.family_settings (
  family_id uuid primary key references public.families(id) on delete cascade,
  xp_to_minutes numeric(6,2) not null default 2
    check (xp_to_minutes between 0.25 and 20),
  daily_limit_minutes integer not null default 90
    check (daily_limit_minutes between 10 and 360),
  carry_over_enabled boolean not null default false,
  timezone text not null default 'Europe/Minsk'
    check (char_length(timezone) between 1 and 64),
  theme public.theme_preference not null default 'system',
  updated_at timestamptz not null default clock_timestamp()
);

-- Parent PIN material is separated so child-readable settings never expose it.
-- pin_hash is a client-produced salted SHA-256 digest; plaintext PIN never reaches PostgreSQL.
create table public.parent_secrets (
  family_id uuid primary key references public.families(id) on delete cascade,
  pin_hash text not null check (pin_hash ~ '^[0-9a-f]{64}$'),
  pin_salt text not null check (char_length(pin_salt) between 8 and 200),
  has_changed_pin boolean not null default true,
  updated_at timestamptz not null default clock_timestamp()
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  client_id text not null check (client_id ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  title text not null check (char_length(btrim(title)) between 2 and 80),
  icon text not null default '⭐' check (char_length(icon) between 1 and 16),
  xp integer not null check (xp between 1 and 500),
  required boolean not null default false,
  built_in boolean not null default false,
  task_type public.task_kind not null default 'custom',
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint tasks_family_client_unique unique (family_id, client_id),
  constraint tasks_pushups_shape check (
    (task_type = 'pushups' and client_id = 'pushups') or task_type <> 'pushups'
  )
);

create index tasks_family_order_idx on public.tasks (family_id, active, sort_order, created_at);

create table public.daily_family_states (
  family_id uuid not null references public.families(id) on delete cascade,
  local_date date not null,
  carry_in_minutes integer not null default 0 check (carry_in_minutes >= 0),
  used_seconds integer not null default 0 check (used_seconds >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (family_id, local_date)
);

create table public.daily_task_states (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  task_id uuid not null references public.tasks(id) on delete cascade,
  local_date date not null,
  status public.task_status not null default 'todo',
  pushup_count integer check (pushup_count in (10, 20, 30, 40, 50)),
  submitted_xp integer check (submitted_xp between 0 and 500),
  requested_by uuid references public.family_members(id),
  requested_at timestamptz,
  reviewed_by uuid references public.family_members(id),
  reviewed_at timestamptz,
  approval_revision integer not null default 0 check (approval_revision >= 0),
  active_award_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint daily_task_states_family_task_date_unique unique (family_id, task_id, local_date),
  constraint daily_task_states_submission_shape check (
    (status = 'todo' and requested_at is null)
    or (status <> 'todo' and requested_at is not null and submitted_xp is not null)
  )
);

create index daily_task_states_family_date_status_idx
  on public.daily_task_states (family_id, local_date, status);

create table public.reward_transactions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  local_date date not null,
  task_id uuid references public.tasks(id) on delete set null,
  daily_task_state_id uuid references public.daily_task_states(id) on delete restrict,
  transaction_type public.reward_transaction_type not null,
  xp_delta integer not null check (xp_delta between -10000 and 10000),
  minutes_delta integer not null check (minutes_delta between -200000 and 200000),
  reason text check (reason is null or char_length(btrim(reason)) between 1 and 240),
  created_by uuid not null references public.family_members(id),
  reverses_transaction_id uuid references public.reward_transactions(id) on delete restrict,
  approval_revision integer check (approval_revision is null or approval_revision > 0),
  operation_key_hash bytea not null,
  created_at timestamptz not null default clock_timestamp(),
  constraint reward_transactions_family_operation_unique unique (family_id, operation_key_hash),
  constraint reward_transactions_award_shape check (
    transaction_type <> 'award'
    or (task_id is not null and daily_task_state_id is not null and xp_delta >= 0
        and minutes_delta >= 0 and approval_revision is not null)
  ),
  constraint reward_transactions_reversal_shape check (
    transaction_type <> 'reversal'
    or (reverses_transaction_id is not null and xp_delta <= 0 and minutes_delta <= 0)
  )
);

create unique index reward_transactions_award_revision_unique
  on public.reward_transactions (daily_task_state_id, approval_revision)
  where transaction_type = 'award';

create unique index reward_transactions_reversal_unique
  on public.reward_transactions (reverses_transaction_id)
  where transaction_type = 'reversal';

alter table public.daily_task_states
  add constraint daily_task_states_active_award_fk
  foreign key (active_award_id) references public.reward_transactions(id) on delete restrict;

create index reward_transactions_family_date_idx
  on public.reward_transactions (family_id, local_date, created_at);

create table public.timer_sessions (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  local_date date not null,
  started_by uuid not null references public.family_members(id),
  started_at timestamptz not null,
  ends_at timestamptz not null,
  planned_seconds integer not null check (planned_seconds between 1 and 21600),
  stopped_at timestamptz,
  used_seconds integer check (used_seconds is null or used_seconds >= 0),
  status public.timer_status not null default 'active',
  stop_reason text check (stop_reason is null or char_length(stop_reason) <= 120),
  start_operation_hash bytea not null,
  stop_operation_hash bytea,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint timer_sessions_family_start_operation_unique unique (family_id, start_operation_hash),
  constraint timer_sessions_time_order check (ends_at > started_at),
  constraint timer_sessions_terminal_shape check (
    (status = 'active' and stopped_at is null and used_seconds is null)
    or (status <> 'active' and stopped_at is not null and used_seconds is not null)
  )
);

create unique index timer_sessions_one_active_per_family
  on public.timer_sessions (family_id)
  where status = 'active';

create index timer_sessions_family_date_idx
  on public.timer_sessions (family_id, local_date, started_at);

create table public.history_days (
  family_id uuid not null references public.families(id) on delete cascade,
  local_date date not null,
  earned_xp integer not null default 0,
  earned_minutes integer not null default 0,
  used_minutes integer not null default 0 check (used_minutes >= 0),
  completed_tasks integer not null default 0 check (completed_tasks >= 0),
  pushup_count integer not null default 0 check (pushup_count >= 0),
  minimum_met boolean not null default false,
  carried_out_minutes integer not null default 0 check (carried_out_minutes >= 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (family_id, local_date)
);

create table public.activity_events (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  local_date date not null,
  event_type public.activity_type not null,
  message text not null check (char_length(message) between 1 and 300),
  created_by uuid references public.family_members(id),
  created_at timestamptz not null default clock_timestamp()
);

create index activity_events_family_date_idx
  on public.activity_events (family_id, local_date, created_at desc);

create table public.family_invites (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete cascade,
  token_digest bytea not null unique,
  created_by uuid not null references public.family_members(id),
  claimed_by uuid references public.family_members(id),
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint family_invites_expiry_order check (expires_at > created_at),
  constraint family_invites_claim_shape check (
    (used_at is null and claimed_by is null) or (used_at is not null and claimed_by is not null)
  )
);

create index family_invites_active_idx
  on public.family_invites (family_id, expires_at)
  where used_at is null and revoked_at is null;

-- Raw idempotency keys are never stored. A repeated key with a different operation or
-- canonical JSON payload is rejected; completed responses are replayed verbatim.
create table public.rpc_operations (
  actor_user_id uuid not null references auth.users(id) on delete cascade,
  operation_key_hash bytea not null,
  operation_name text not null check (operation_name ~ '^[a-z][a-z0-9_]{1,79}$'),
  payload_hash bytea not null,
  family_id uuid references public.families(id) on delete cascade,
  response jsonb,
  created_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key (actor_user_id, operation_key_hash),
  constraint rpc_operations_completion_shape check (
    (response is null and completed_at is null) or (response is not null and completed_at is not null)
  )
);

create index rpc_operations_created_at_idx on public.rpc_operations (created_at);

comment on table public.reward_transactions is
  'Append-only XP/minute ledger. UPDATE and DELETE are rejected by trigger.';
comment on column public.family_invites.token_digest is
  'SHA-256 digest of the short-lived, one-time invite token; plaintext token is never persisted.';
comment on column public.rpc_operations.operation_key_hash is
  'SHA-256 digest of the client idempotency key; the raw key is never persisted.';

create function private.deny_reward_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
     and pg_catalog.current_setting('missions_nikolay.deleting_family', true) = old.family_id::text then
    return old;
  end if;
  raise exception using
    errcode = '55000',
    message = 'reward ledger is append-only';
end;
$$;

create trigger reward_transactions_append_only
before update or delete on public.reward_transactions
for each row execute function private.deny_reward_mutation();
