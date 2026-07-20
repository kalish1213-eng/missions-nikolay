import type { AppState, PushUpCount, ThemePreference } from './index'

export type CloudRole = 'parent' | 'child'

export type CloudAction =
  | 'read_family'
  | 'create_family'
  | 'create_invite'
  | 'accept_invite'
  | 'submit_task'
  | 'review_task'
  | 'reverse_approval'
  | 'manage_tasks'
  | 'manage_settings'
  | 'adjust_xp'
  | 'revoke_child_device'
  | 'delete_family'
  | 'start_timer'
  | 'stop_timer'

export interface CloudMembership {
  id: string
  familyId: string
  userId?: string
  role: CloudRole
  displayName: string
}

export interface CloudFamily {
  id: string
  name: string
  timezone: string
}

export interface CloudSnapshotMeta {
  serverNow: number
  revision: number
  membership: CloudMembership
  family: CloudFamily
  childName: string
  dailyStateIds: Record<string, string>
}

/**
 * The database snapshot is intentionally represented as unknown at the RPC
 * boundary. snapshotToAppState validates and normalises the JSON before any
 * existing screen receives it.
 */
export interface CloudSnapshot {
  appState: AppState
  meta: CloudSnapshotMeta
}

export interface CloudMutationResult {
  ok?: boolean
  operationId?: string
  replayed?: boolean
  revision?: number
}

export interface ChildInviteResult extends CloudMutationResult {
  token: string
  expiresAt: number
}

export interface CloudRpcArguments {
  create_family: {
    p_child_name: string
    p_pin_hash: string
    p_pin_salt: string
  }
  create_child_invite: {
    p_expires_minutes: number
    p_idempotency_key: string
  }
  claim_child_invite: {
    p_token: string
    p_display_name: string
    p_idempotency_key: string
  }
  get_family_snapshot: Record<string, never>
  submit_task: {
    p_task_id: string
    p_selected_pushups: PushUpCount | null
    p_idempotency_key: string
  }
  review_task: {
    p_daily_state_id: string
    p_decision: 'approved' | 'rejected'
    p_idempotency_key: string
  }
  undo_approval: {
    p_daily_state_id: string
    p_reason: string
    p_idempotency_key: string
  }
  add_custom_task: {
    p_title: string
    p_xp: number
    p_idempotency_key: string
  }
  update_task: {
    p_task_id: string
    p_xp: number | null
    p_active: boolean | null
    p_idempotency_key: string
  }
  update_family_settings: {
    p_xp_to_minutes: number | null
    p_daily_limit_minutes: number | null
    p_carry_over_enabled: boolean | null
    p_theme: ThemePreference | null
    p_pin_hash: string | null
    p_pin_salt: string | null
    p_idempotency_key: string
  }
  adjust_xp: {
    p_delta: number
    p_reason: string
    p_idempotency_key: string
  }
  start_timer: {
    p_duration_seconds: number
    p_idempotency_key: string
  }
  stop_timer: {
    p_idempotency_key: string
  }
  reset_today: {
    p_idempotency_key: string
  }
  change_parent_pin: {
    p_pin_hash: string
    p_pin_salt: string
    p_idempotency_key: string
  }
  revoke_child_device: {
    p_idempotency_key: string
  }
  delete_family: {
    p_confirmation: string
  }
}

export interface CloudRpcResults {
  create_family: unknown
  create_child_invite: ChildInviteResult
  claim_child_invite: CloudMutationResult
  get_family_snapshot: unknown
  submit_task: CloudMutationResult
  review_task: CloudMutationResult
  undo_approval: CloudMutationResult
  add_custom_task: CloudMutationResult
  update_task: CloudMutationResult
  update_family_settings: CloudMutationResult
  adjust_xp: CloudMutationResult
  start_timer: CloudMutationResult
  stop_timer: CloudMutationResult
  reset_today: CloudMutationResult
  change_parent_pin: CloudMutationResult
  revoke_child_device: CloudMutationResult
  delete_family: CloudMutationResult
}

export type CloudRpcName = keyof CloudRpcArguments

export interface ChildSubmitOutboxItem {
  kind: 'submit_task'
  operationId: string
  taskId: string
  pushupCount: PushUpCount | null
  createdAt: number
  attempts: number
}

export type CloudSyncPhase = 'disabled' | 'loading' | 'syncing' | 'synced' | 'offline' | 'error'

export interface CloudSyncViewState {
  phase: CloudSyncPhase
  lastSyncedAt: number | null
  queuedOperations: number
  error: string | null
}
