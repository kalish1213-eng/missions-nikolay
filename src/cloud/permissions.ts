import type { CloudRole } from '../types/cloud'

const parentActions = new Set<string>([
  'get_family_snapshot',
  'create_child_invite',
  'review_task',
  'undo_approval',
  'add_custom_task',
  'update_task',
  'update_family_settings',
  'adjust_xp',
  'reset_today',
  'change_parent_pin',
  'revoke_child_device',
  'delete_family',
])

const childActions = new Set<string>([
  'get_family_snapshot',
  'submit_task',
  'start_timer',
  'stop_timer',
])

/** UI affordance only. PostgreSQL RLS and RPC checks remain authoritative. */
export function canPerform(role: CloudRole | null | undefined, operation: string): boolean {
  if (operation === 'claim_child_invite' || operation === 'create_family') return role == null
  if (role === 'parent') return parentActions.has(operation)
  if (role === 'child') return childActions.has(operation)
  return false
}
