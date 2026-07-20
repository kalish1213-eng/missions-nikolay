import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Feedback } from '../hooks/useMissionApp'
import { generatePinSalt, hashPin } from '../lib/security'
import type { AppState, PushUpCount, ThemePreference } from '../types'
import { runIdempotentIntent, runIdempotentPayloadIntent } from './idempotency'
import { callCloudRpc } from './rpc'
import type { UseCloudSyncResult } from './useCloudSync'

export function useCloudMissionApp(sync: UseCloudSyncResult) {
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [selectedPushUps, setSelectedPushUps] = useState<PushUpCount>(10)
  const [optimisticPending, setOptimisticPending] = useState<Set<string>>(() => new Set())
  const snapshot = sync.snapshot

  useEffect(() => {
    if (!snapshot) return
    setOptimisticPending((current) => {
      const next = new Set([...current].filter((taskId) => snapshot.appState.today.taskStates[taskId]?.status === 'todo'))
      return next.size === current.size ? current : next
    })
  }, [snapshot])

  const state = useMemo<AppState | null>(() => {
    if (!snapshot) return null
    const next = structuredClone(snapshot.appState)
    const pushups = next.today.taskStates.pushups
    if (pushups?.status === 'todo') pushups.selectedPushUps = selectedPushUps
    for (const taskId of optimisticPending) {
      const daily = next.today.taskStates[taskId]
      if (daily?.status === 'todo') {
        daily.status = 'pending'
        daily.submittedAt = Date.now()
      }
    }
    return next
  }, [optimisticPending, selectedPushUps, snapshot])

  const notify = useCallback((kind: Feedback['kind'], message: string) => {
    setFeedback({ kind, message, id: Date.now() })
  }, [])

  const run = useCallback((intent: string, operation: (operationId: string) => Promise<unknown>, success: string): boolean => {
    void runIdempotentIntent(intent, operation)
      .then(async () => {
        await sync.refresh()
        notify('success', success)
      })
      .catch((reason: unknown) => notify('error', reason instanceof Error ? reason.message : 'Операция не выполнена'))
    return true
  }, [notify, sync])

  const dailyStateId = useCallback((taskId: string): string | null => {
    const id = snapshot?.meta.dailyStateIds[taskId]
    if (!id) notify('error', 'Заявка на проверку ещё не синхронизирована')
    return id ?? null
  }, [notify, snapshot?.meta.dailyStateIds])

  return {
    state,
    feedback,
    clearFeedback: () => setFeedback(null),
    actions: {
      submitTask: (taskId: string) => {
        if (!state || state.today.taskStates[taskId]?.status !== 'todo' || optimisticPending.has(taskId)) return false
        const pushupCount = state.tasks.find((task) => task.id === taskId)?.kind === 'pushups' ? selectedPushUps : null
        setOptimisticPending((current) => new Set(current).add(taskId))
        void sync.submitTask(taskId, pushupCount).then(() => {
          notify(navigator.onLine ? 'success' : 'info', navigator.onLine ? 'Миссия отправлена на проверку' : 'Миссия сохранена и отправится при появлении сети')
        }).catch((reason: unknown) => notify('error', reason instanceof Error ? reason.message : 'Не удалось сохранить миссию'))
        return true
      },
      setPushUps: (count: PushUpCount) => { setSelectedPushUps(count); return true },
      approveTask: (taskId: string) => {
        const id = dailyStateId(taskId)
        return id ? run(`review-task:${id}`, (operationId) => callCloudRpc('review_task', { p_daily_state_id: id, p_decision: 'approved', p_idempotency_key: operationId }), 'Миссия подтверждена') : false
      },
      rejectTask: (taskId: string) => {
        const id = dailyStateId(taskId)
        return id ? run(`reject-task:${id}`, (operationId) => callCloudRpc('review_task', { p_daily_state_id: id, p_decision: 'rejected', p_idempotency_key: operationId }), 'Миссия возвращена Николаю') : false
      },
      undoApproval: (taskId: string) => {
        const id = dailyStateId(taskId)
        return id ? run(`undo-approval:${id}`, (operationId) => callCloudRpc('undo_approval', { p_daily_state_id: id, p_reason: 'Отменено родителем', p_idempotency_key: operationId }), 'Подтверждение отменено') : false
      },
      startTimer: (seconds: number) => run('start-timer', (operationId) => callCloudRpc('start_timer', { p_duration_seconds: seconds, p_idempotency_key: operationId }), 'Таймер запущен'),
      stopTimer: () => run('stop-timer', (operationId) => callCloudRpc('stop_timer', { p_idempotency_key: operationId }), 'Таймер остановлен'),
      acknowledgeTimer: () => undefined,
      updateSettings: (values: { xpToMinutes?: number; dailyLimitMinutes?: number; carryOver?: boolean; theme?: ThemePreference }) => run(
        'update-family-settings',
        (operationId) => callCloudRpc('update_family_settings', {
          p_xp_to_minutes: values.xpToMinutes ?? null,
          p_daily_limit_minutes: values.dailyLimitMinutes ?? null,
          p_carry_over_enabled: values.carryOver ?? null,
          p_theme: values.theme ?? null,
          p_pin_hash: null,
          p_pin_salt: null,
          p_idempotency_key: operationId,
        }),
        'Настройки сохранены',
      ),
      updateTask: (taskId: string, values: { xp?: number; hidden?: boolean }) => run(
        `update-task:${taskId}`,
        (operationId) => callCloudRpc('update_task', {
          p_task_id: taskId,
          p_xp: values.xp ?? null,
          p_active: values.hidden === undefined ? null : !values.hidden,
          p_idempotency_key: operationId,
        }),
        'Миссия обновлена',
      ),
      addTask: (title: string, xp: number) => run('add-custom-task', (operationId) => callCloudRpc('add_custom_task', { p_title: title, p_xp: xp, p_idempotency_key: operationId }), 'Новая миссия добавлена'),
      adjustXp: (delta: number, reason: string) => run('adjust-xp', (operationId) => callCloudRpc('adjust_xp', { p_delta: delta, p_reason: reason, p_idempotency_key: operationId }), 'XP скорректирован'),
      resetToday: () => run('reset-today', (operationId) => callCloudRpc('reset_today', { p_idempotency_key: operationId }), 'Сегодняшний день сброшен'),
      changePin: async (pin: string) => {
        try {
          await runIdempotentPayloadIntent('change-parent-pin', {
            createPayload: async () => {
              const pinSalt = generatePinSalt()
              return { pinSalt, pinHash: await hashPin(pin, pinSalt) }
            },
            matches: async (payload) => await hashPin(pin, payload.pinSalt) === payload.pinHash,
            send: (payload, operationId) => callCloudRpc('change_parent_pin', {
              p_pin_hash: payload.pinHash,
              p_pin_salt: payload.pinSalt,
              p_idempotency_key: operationId,
            }),
          })
          await sync.refresh()
          notify('success', 'Новый PIN сохранён')
        } catch (reason) {
          notify('error', reason instanceof Error ? reason.message : 'Не удалось сохранить PIN')
        }
      },
      markOnboardingSeen: () => undefined,
    },
  }
}
