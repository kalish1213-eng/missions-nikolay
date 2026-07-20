import { useCallback, useEffect, useRef, useState } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { getSupabaseClient } from './client'
import { callCloudRpc } from './rpc'
import { loadCloudSnapshot } from './api'
import { loadCachedCloudSnapshot, saveCachedCloudSnapshot } from './cache'
import { CloudOutbox, createLocalOutboxStorage } from './outbox'
import type { PushUpCount } from '../types'
import type { CloudSnapshot, CloudSyncViewState } from '../types/cloud'

const REALTIME_TABLES = [
  'family_settings',
  'tasks',
  'daily_task_states',
  'daily_family_states',
  'reward_transactions',
  'timer_sessions',
  'activity_events',
  'history_days',
] as const

interface UseCloudSyncOptions {
  enabled: boolean
  userId: string | null
  pollMs?: number
}

export interface UseCloudSyncResult extends CloudSyncViewState {
  snapshot: CloudSnapshot | null
  refresh: () => Promise<CloudSnapshot | null>
  submitTask: (taskId: string, pushupCount?: PushUpCount | null) => Promise<void>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось синхронизировать данные'
}

export function useCloudSync({ enabled, userId, pollMs = 30_000 }: UseCloudSyncOptions): UseCloudSyncResult {
  const scope = userId ?? 'signed-out'
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(() => enabled && userId ? loadCachedCloudSnapshot(scope) : null)
  const [view, setView] = useState<CloudSyncViewState>({
    phase: enabled ? 'loading' : 'disabled',
    lastSyncedAt: null,
    queuedOperations: 0,
    error: null,
  })
  const refreshInFlight = useRef<Promise<CloudSnapshot | null> | null>(null)
  const outboxRef = useRef<CloudOutbox | null>(null)
  const snapshotRef = useRef<CloudSnapshot | null>(snapshot)

  useEffect(() => {
    if (!enabled || !userId) {
      outboxRef.current = null
      snapshotRef.current = null
      setSnapshot(null)
      setView({ phase: enabled ? 'loading' : 'disabled', lastSyncedAt: null, queuedOperations: 0, error: null })
      return
    }
    const outbox = new CloudOutbox(createLocalOutboxStorage(userId))
    outboxRef.current = outbox
    const cached = loadCachedCloudSnapshot(userId)
    snapshotRef.current = cached
    setSnapshot(cached)
    setView((current) => ({ ...current, phase: navigator.onLine ? 'loading' : 'offline', queuedOperations: outbox.size }))
  }, [enabled, userId])

  const flushOutbox = useCallback(async () => {
    const outbox = outboxRef.current
    if (!outbox || !navigator.onLine) return
    const result = await outbox.flush((item) => callCloudRpc('submit_task', {
      p_task_id: item.taskId,
      p_selected_pushups: item.pushupCount,
      p_idempotency_key: item.operationId,
    }))
    setView((current) => ({ ...current, queuedOperations: result.remaining }))
  }, [])

  const refresh = useCallback(async (): Promise<CloudSnapshot | null> => {
    if (!enabled || !userId) return null
    if (!navigator.onLine) {
      setView((current) => ({ ...current, phase: 'offline', queuedOperations: outboxRef.current?.size ?? 0 }))
      return snapshotRef.current
    }
    if (refreshInFlight.current) return refreshInFlight.current

    const operation = (async () => {
      setView((current) => ({ ...current, phase: 'syncing', error: null }))
      try {
        await flushOutbox()
        const next = await loadCloudSnapshot()
        saveCachedCloudSnapshot(userId, next)
        snapshotRef.current = next
        setSnapshot(next)
        setView({
          phase: 'synced',
          lastSyncedAt: Date.now(),
          queuedOperations: outboxRef.current?.size ?? 0,
          error: null,
        })
        return next
      } catch (error) {
        setView((current) => ({
          ...current,
          phase: navigator.onLine ? 'error' : 'offline',
          queuedOperations: outboxRef.current?.size ?? 0,
          error: errorMessage(error),
        }))
        return null
      } finally {
        refreshInFlight.current = null
      }
    })()
    refreshInFlight.current = operation
    return operation
  }, [enabled, flushOutbox, userId])

  const submitTask = useCallback(async (taskId: string, pushupCount: PushUpCount | null = null) => {
    const outbox = outboxRef.current
    if (!outbox) throw new Error('Детская сессия ещё не готова')
    outbox.enqueueTask(taskId, pushupCount)
    setView((current) => ({
      ...current,
      phase: navigator.onLine ? 'syncing' : 'offline',
      queuedOperations: outbox.size,
    }))
    if (navigator.onLine) await refresh()
  }, [refresh])

  useEffect(() => {
    if (!enabled || !userId) return
    void refresh()
    const interval = window.setInterval(() => { void refresh() }, Math.max(10_000, pollMs))
    const onOnline = () => { void refresh() }
    const onOffline = () => setView((current) => ({ ...current, phase: 'offline' }))
    const onVisibility = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [enabled, pollMs, refresh, userId])

  useEffect(() => {
    const familyId = snapshot?.meta.family.id
    if (!enabled || !userId || !familyId) return
    const client = getSupabaseClient()
    let channel: RealtimeChannel = client.channel(`family:${familyId}:${crypto.randomUUID()}`)
    let debounce = 0
    const scheduleRefresh = () => {
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => { void refresh() }, 250)
    }
    for (const table of REALTIME_TABLES) {
      channel = channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table, filter: `family_id=eq.${familyId}` },
        scheduleRefresh,
      )
    }
    channel.subscribe()
    return () => {
      window.clearTimeout(debounce)
      void client.removeChannel(channel)
    }
  }, [enabled, refresh, snapshot?.meta.family.id, userId])

  return { ...view, snapshot, refresh, submitTask }
}
