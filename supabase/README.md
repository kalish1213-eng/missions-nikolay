# Supabase contract

The browser uses an authenticated Supabase session (an anonymous Auth session is still
the `authenticated` PostgreSQL role). It never receives a service-role key and has no
direct write grants. All mutations below derive the actor and family from `auth.uid()`.

Every mutation that accepts `p_idempotency_key` requires a Web Crypto random value of
16–200 characters (a UUID v4 is sufficient). Reusing a key with the same canonical
payload returns the saved JSON response; reusing it with a different operation or
payload raises SQLSTATE `22023`.

## Setup and membership

- `create_family(p_child_name text, p_pin_hash text, p_pin_salt text)`
- `create_child_invite(p_expires_minutes integer, p_idempotency_key text)` →
  `{ inviteId, expiresAt, oneTime, token }`
- `claim_child_invite(p_token text, p_display_name text, p_idempotency_key text)`
- Compatibility aliases: `bootstrap_parent(...)`, `accept_child_invite(...)`.

The invite token is deterministically reconstructed from the parent's random operation
key on retries. PostgreSQL persists only its SHA-256 digest. A new invite revokes any
older unused invite, and claiming is transactional, expiring, and one-time. Claiming a
replacement invite also revokes the previous active child membership; the old device
then fails both RLS reads and role-gated RPCs.

## Mutations

- Child: `submit_task(p_task_id, p_selected_pushups, p_idempotency_key)`
- Parent: `review_task(p_daily_state_id, 'approved'|'rejected', p_idempotency_key)`
- Parent: `undo_approval(p_daily_state_id, p_reason, p_idempotency_key)`
- Parent: `add_custom_task(p_title, p_xp, p_idempotency_key)`
- Parent: `update_task(p_task_id, p_xp, p_active, p_idempotency_key)`
- Parent: `update_family_settings(p_xp_to_minutes, p_daily_limit_minutes,
  p_carry_over_enabled, p_theme, p_pin_hash, p_pin_salt, p_idempotency_key)`
- Parent: `change_parent_pin(p_pin_hash, p_pin_salt, p_idempotency_key)`
- Parent: `adjust_xp(p_delta, p_reason, p_idempotency_key)`
- Parent: `reset_today(p_idempotency_key)`
- Parent: `revoke_child_device(p_idempotency_key)`
- Child: `start_timer(p_duration_seconds, p_idempotency_key)`
- Child: `stop_timer(p_idempotency_key)`

## Family deletion

`delete_family(p_confirmation text)` is parent-only and requires the exact current
family name (available as `snapshot.meta.familyName`). It removes the family row and all
dependent memberships, settings, tasks, states, events, invites, operation records,
ledger entries, timers, and history in one transaction. Supabase Auth identities are not
deleted; after the cascade they no longer have access to family data. The append-only
ledger trigger permits deletion only under this transaction-local family deletion guard.

Task review amounts are read from the locked submission row. The child cannot choose an
XP amount, approve, reverse, edit tasks/settings, or insert ledger rows. The reward
ledger is append-only; approval revisions, reversal targets, operation hashes, and a
single-active-timer partial index enforce conflict safety independently of the UI.

## Snapshot

`get_family_snapshot()` returns an AppState-compatible JSON document plus `meta`:

```text
{
  schemaVersion, revision, currentDayKey,
  meta: { familyId, familyName, role, memberId, displayName, childName,
          revision, serverTime },
  settings: { xpToMinutes, dailyLimitMinutes, carryOver, theme,
              pinHash?, pinSalt?, hasChangedPin? },
  tasks: [{ id, title, icon, xp, required, builtIn, kind, hidden, createdAt }],
  today: { dayKey, carryInMinutes, usedSeconds, taskStates: { [taskId]: {...} },
           activity: [...] },
  history, transactions, activeTimer, timerNotice: null, onboardingSeen: true
}
```

PIN fields are added only for a parent member. All timestamps in the snapshot and RPC
responses are epoch milliseconds. Rollover, carry-over summaries, and expired timer
settlement run on the server before a snapshot or mutation.

## Local verification

With Supabase CLI and Docker available:

```powershell
supabase start
supabase db reset
supabase test db
```

The pgTAP suite checks the schema, RLS, grants, RPC exposure, immutable-ledger trigger,
uniqueness guards, invite digest storage, and pinned `search_path` on definer functions.
