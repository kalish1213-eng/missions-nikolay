import type { AuthChangeEvent, Session, Subscription, User } from '@supabase/supabase-js'
import { getSupabaseClient } from './client'
import { clearInviteTokenFromAddress } from './routes'
import { runIdempotentIntent } from './idempotency'
import { callCloudRpc } from './rpc'
import { snapshotToAppState } from './snapshot'
import type { CloudMembership, CloudSnapshot } from '../types/cloud'

export async function getCloudSession(): Promise<Session | null> {
  const { data, error } = await getSupabaseClient().auth.getSession()
  if (error) throw error
  return data.session
}

export function observeCloudSession(
  listener: (event: AuthChangeEvent, session: Session | null) => void,
): Subscription {
  return getSupabaseClient().auth.onAuthStateChange(listener).data.subscription
}

function parentRedirectUrl(): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = '/parent'
  return url.toString()
}

export async function sendParentMagicLink(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(normalized)) throw new Error('Введите корректный email')
  const { error } = await getSupabaseClient().auth.signInWithOtp({
    email: normalized,
    options: { emailRedirectTo: parentRedirectUrl(), shouldCreateUser: true },
  })
  if (error) throw error
}

export async function ensureAnonymousSession(): Promise<User> {
  const existing = await getCloudSession()
  if (existing) return existing.user
  const { data, error } = await getSupabaseClient().auth.signInAnonymously()
  if (error) throw error
  if (!data.user) throw new Error('Не удалось создать защищённую детскую сессию')
  return data.user
}

export async function signOutCloud(): Promise<void> {
  const { error } = await getSupabaseClient().auth.signOut({ scope: 'local' })
  if (error) throw error
}

export async function loadCloudSnapshot(): Promise<CloudSnapshot> {
  return snapshotToAppState(await callCloudRpc('get_family_snapshot', {}))
}

export async function loadCurrentMembership(): Promise<CloudMembership | null> {
  try {
    return (await loadCloudSnapshot()).meta.membership
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    if (code === 'P0002' || code === 'PGRST116' || code === '42501') return null
    throw error
  }
}

export async function claimChildInvite(token: string, displayName: string): Promise<CloudSnapshot> {
  await ensureAnonymousSession()
  await runIdempotentIntent('claim-child-invite', (operationId) =>
    callCloudRpc('claim_child_invite', {
      p_token: token,
      p_display_name: displayName.trim(),
      p_idempotency_key: operationId,
    }),
  )
  clearInviteTokenFromAddress('#/child')
  return loadCloudSnapshot()
}
