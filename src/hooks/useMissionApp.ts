import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  acknowledgeTimerNotice,
  addCustomTask,
  adjustXp,
  approveTask,
  changePinHash,
  rejectTask,
  resetToday,
  rolloverTo,
  setPushUpCount,
  settleTimer,
  startTimer,
  submitTask,
  undoApproval,
  updateSettings,
  updateTask,
} from '../lib/domain'
import { generatePinSalt, hashPin } from '../lib/security'
import { loadAppState, saveAppState } from '../lib/storage'
import { STORAGE_KEY } from '../data/defaults'
import type { AppState, PushUpCount, TransitionResult } from '../types'

export interface Feedback {
  kind: 'success' | 'error' | 'info'
  message: string
  id: number
}

export function useMissionApp() {
  const initial = useMemo(() => loadAppState(), [])
  const [state, setState] = useState<AppState>(initial.state)
  const [feedback, setFeedback] = useState<Feedback | null>(() =>
    initial.recovered ? { kind: 'info', message: 'Данные восстановлены из безопасной копии', id: Date.now() } : null,
  )

  const notify = useCallback((kind: Feedback['kind'], message: string) => {
    setFeedback({ kind, message, id: Date.now() })
  }, [])

  const commit = useCallback((result: TransitionResult, successMessage?: string) => {
    if (result.state !== state) setState(result.state)
    if (result.error) notify('error', result.error)
    else if (result.reward) notify('success', `Отлично! +${result.reward.xp} XP и +${result.reward.minutes} мин`)
    else if (successMessage) notify('success', successMessage)
    return !result.error
  }, [notify, state])

  useEffect(() => {
    saveAppState(state)
  }, [state])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return
      const loaded = loadAppState().state
      setState((current) => loaded.revision > current.revision ? loaded : current)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    const reconcile = () => {
      setState((current) => {
        let next = rolloverTo(current, new Date())
        if (next.activeTimer) next = settleTimer(next, Date.now()).state
        return next
      })
    }
    const interval = window.setInterval(reconcile, 1000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') reconcile()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', reconcile)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', reconcile)
    }
  }, [])

  useEffect(() => {
    if (!feedback) return
    const timeout = window.setTimeout(() => setFeedback(null), 4200)
    return () => window.clearTimeout(timeout)
  }, [feedback])

  return {
    state,
    feedback,
    clearFeedback: () => setFeedback(null),
    actions: {
      submitTask: (taskId: string) => commit(submitTask(state, taskId)),
      setPushUps: (count: PushUpCount) => commit(setPushUpCount(state, count)),
      approveTask: (taskId: string) => commit(approveTask(state, taskId)),
      rejectTask: (taskId: string) => commit(rejectTask(state, taskId), 'Миссия возвращена Николаю'),
      undoApproval: (taskId: string) => commit(undoApproval(state, taskId), 'Подтверждение отменено'),
      startTimer: (seconds: number) => commit(startTimer(state, seconds), 'Таймер запущен'),
      stopTimer: () => commit(settleTimer(state, Date.now(), true), 'Неиспользованное время вернулось в запас'),
      acknowledgeTimer: () => setState((current) => acknowledgeTimerNotice(current)),
      updateSettings: (values: Parameters<typeof updateSettings>[1]) => commit(updateSettings(state, values), 'Настройки сохранены'),
      updateTask: (taskId: string, values: Parameters<typeof updateTask>[2]) => commit(updateTask(state, taskId, values)),
      addTask: (title: string, xp: number) => commit(addCustomTask(state, title, xp), 'Новая миссия добавлена'),
      adjustXp: (delta: number, reason: string) => commit(adjustXp(state, delta, reason), 'XP скорректирован'),
      resetToday: () => commit(resetToday(state), 'Сегодняшний день сброшен'),
      changePin: async (pin: string) => {
        const salt = generatePinSalt()
        const digest = await hashPin(pin, salt)
        setState((current) => changePinHash(current, digest, salt))
        notify('success', 'Новый PIN сохранён')
      },
      markOnboardingSeen: () => setState((current) => ({ ...current, revision: current.revision + 1, onboardingSeen: true })),
    },
  }
}
