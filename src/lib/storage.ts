import { DEFAULT_TASKS, SCHEMA_VERSION, STORAGE_BACKUP_KEY, STORAGE_KEY, createDefaultState } from '../data/defaults'
import { rolloverTo } from './domain'
import { dayKey, isValidDayKey } from './date'
import type { AppState, DailyTaskState, HistoryDay, RewardTransaction, Task, TaskStatus } from '../types'

const VALID_STATUSES = new Set<TaskStatus>(['todo', 'pending', 'approved', 'rejected'])
const PIN_HASH_PATTERN = /^[0-9a-f]{64}$/
const VALID_THEMES = new Set(['system', 'light', 'dark'])

function finite(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function sanitizeTasks(value: unknown): Task[] {
  const loaded = Array.isArray(value) ? value : []
  const loadedById = new Map(
    loaded
      .map(object)
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item.id === 'string'))
      .map((item) => [item.id as string, item]),
  )
  const standard = DEFAULT_TASKS.map((fallback) => {
    const item = loadedById.get(fallback.id)
    return {
      ...fallback,
      title: typeof item?.title === 'string' ? item.title.slice(0, 80) : fallback.title,
      xp: Math.round(finite(item?.xp, fallback.xp, 1, 500)),
      hidden: fallback.required ? false : Boolean(item?.hidden),
    }
  })
  const custom = loaded
    .map(object)
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item.id === 'string' && String(item.id).startsWith('custom-')))
    .map((item) => ({
      id: String(item.id),
      title: typeof item.title === 'string' ? item.title.trim().slice(0, 80) : 'Семейная миссия',
      icon: '⭐',
      xp: Math.round(finite(item.xp, 10, 1, 500)),
      required: false,
      builtIn: false,
      kind: 'custom' as const,
      hidden: Boolean(item.hidden),
      createdAt: finite(item.createdAt, 0),
    }))
  return [...standard, ...custom]
}

function sanitizeTaskState(value: unknown, task: Task): DailyTaskState {
  const item = object(value)
  const status = VALID_STATUSES.has(item?.status as TaskStatus) ? (item?.status as TaskStatus) : 'todo'
  const pushUps = [10, 20, 30, 40, 50].includes(Number(item?.selectedPushUps))
    ? (Number(item?.selectedPushUps) as 10 | 20 | 30 | 40 | 50)
    : 10
  return {
    taskId: task.id,
    status,
    approvalRevision: Math.round(finite(item?.approvalRevision, 0, 0, 1000)),
    ...(task.kind === 'pushups' ? { selectedPushUps: pushUps } : {}),
    ...(typeof item?.submittedXp === 'number' ? { submittedXp: finite(item.submittedXp, task.xp, 0, 500) } : {}),
    ...(typeof item?.submittedAt === 'number' ? { submittedAt: finite(item.submittedAt, 0) } : {}),
    ...(typeof item?.resolvedAt === 'number' ? { resolvedAt: finite(item.resolvedAt, 0) } : {}),
    ...(typeof item?.activeAwardId === 'string' ? { activeAwardId: item.activeAwardId } : {}),
  }
}

function sanitizeTransactions(value: unknown): RewardTransaction[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  return value.flatMap((raw) => {
    const item = object(raw)
    if (!item) return []
    const id = typeof item?.id === 'string' ? item.id : ''
    const type = item?.type
    if (!id || ids.has(id) || !['award', 'reversal', 'manual', 'reset'].includes(String(type))) return []
    if (!isValidDayKey(item?.dayKey)) return []
    if (!Number.isFinite(item?.xpDelta) || !Number.isFinite(item?.minutesDelta)) return []
    ids.add(id)
    return [{
      id,
      dayKey: item.dayKey,
      type: type as RewardTransaction['type'],
      xpDelta: finite(item.xpDelta, 0, -100_000, 100_000),
      minutesDelta: finite(item.minutesDelta, 0, -100_000, 100_000),
      createdAt: finite(item.createdAt, 0),
      ...(typeof item.taskId === 'string' ? { taskId: item.taskId } : {}),
      ...(typeof item.reason === 'string' ? { reason: item.reason.slice(0, 250) } : {}),
      ...(typeof item.reversesTransactionId === 'string' ? { reversesTransactionId: item.reversesTransactionId } : {}),
    }]
  })
}

function sanitizeHistory(value: unknown): HistoryDay[] {
  if (!Array.isArray(value)) return []
  const byDay = new Map<string, HistoryDay>()
  value.forEach((raw) => {
    const item = object(raw)
    if (!item || !isValidDayKey(item.dayKey)) return
    byDay.set(item.dayKey, {
      dayKey: item.dayKey,
      xpEarned: finite(item.xpEarned, 0),
      minutesEarned: finite(item.minutesEarned, 0),
      minutesUsed: finite(item.minutesUsed, 0),
      completedTasks: finite(item.completedTasks, 0),
      pushUps: finite(item.pushUps, 0),
      minimumMet: Boolean(item.minimumMet),
      carriedOutMinutes: finite(item.carriedOutMinutes, 0),
    })
  })
  return [...byDay.values()].sort((a, b) => a.dayKey.localeCompare(b.dayKey)).slice(-365)
}

export function decodeStoredState(raw: string | null, now = new Date()): AppState | null {
  if (!raw) return null
  try {
    const parsed = object(JSON.parse(raw))
    if (!parsed) return null
    const version = finite(parsed.schemaVersion ?? parsed.version, 1, 1, 10_000)
    if (version > SCHEMA_VERSION) return null
    const fallback = createDefaultState(now)
    const tasks = sanitizeTasks(parsed.tasks)
    const settings = object(parsed.settings)
    const currentDayKey = isValidDayKey(parsed.currentDayKey) ? parsed.currentDayKey : dayKey(now)
    const today = object(parsed.today)
    const rawTaskStates = object(today?.taskStates) ?? {}
    const state: AppState = {
      ...fallback,
      schemaVersion: SCHEMA_VERSION,
      revision: Math.round(finite(parsed.revision, 0, 0)),
      currentDayKey,
      tasks,
      settings: {
        xpToMinutes: finite(settings?.xpToMinutes, 2, 0.25, 20),
        dailyLimitMinutes: Math.round(finite(settings?.dailyLimitMinutes, 90, 10, 360)),
        carryOver: Boolean(settings?.carryOver),
        theme: VALID_THEMES.has(String(settings?.theme)) ? settings?.theme as AppState['settings']['theme'] : fallback.settings.theme,
        pinHash: typeof settings?.pinHash === 'string' && PIN_HASH_PATTERN.test(settings.pinHash) ? settings.pinHash : fallback.settings.pinHash,
        pinSalt: typeof settings?.pinSalt === 'string' && settings.pinSalt.length >= 8 && settings.pinSalt.length <= 128
          ? settings.pinSalt
          : fallback.settings.pinSalt,
        hasChangedPin: Boolean(settings?.hasChangedPin && typeof settings?.pinHash === 'string' && PIN_HASH_PATTERN.test(settings.pinHash)),
      },
      today: {
        dayKey: currentDayKey,
        carryInMinutes: finite(today?.carryInMinutes, 0, 0, 360),
        usedSeconds: Math.round(finite(today?.usedSeconds, 0, 0, 24 * 60 * 60)),
        taskStates: Object.fromEntries(tasks.map((task) => [task.id, sanitizeTaskState(rawTaskStates[task.id], task)])),
        activity: Array.isArray(today?.activity)
          ? today.activity.flatMap((raw) => {
              const item = object(raw)
              return item && typeof item.id === 'string' && typeof item.message === 'string'
                ? [{
                    id: item.id,
                    type: ['submitted', 'approved', 'rejected', 'reversed', 'manual', 'timer', 'reset', 'settings'].includes(String(item.type))
                      ? item.type as AppState['today']['activity'][number]['type']
                      : 'settings' as const,
                    message: item.message.slice(0, 200),
                    createdAt: finite(item.createdAt, 0),
                  }]
                : []
            }).slice(0, 100)
          : [],
      },
      history: sanitizeHistory(parsed.history),
      transactions: sanitizeTransactions(parsed.transactions),
      activeTimer: (() => {
        const timer = object(parsed.activeTimer)
        if (!timer || typeof timer.id !== 'string' || !isValidDayKey(timer.dayKey) || timer.dayKey !== currentDayKey) return null
        const durationSeconds = Math.round(finite(timer.durationSeconds, 0, 1, 24 * 60 * 60))
        const startedAt = finite(timer.startedAt, 0)
        const endsAt = finite(timer.endsAt, 0)
        if (!durationSeconds || !startedAt || endsAt <= startedAt) return null
        return {
          id: timer.id,
          dayKey: timer.dayKey,
          startedAt,
          endsAt,
          durationSeconds,
          accountedSeconds: Math.round(finite(timer.accountedSeconds, 0, 0, durationSeconds)),
          lastObservedAt: finite(timer.lastObservedAt, startedAt),
        }
      })(),
      timerNotice: (() => {
        const notice = object(parsed.timerNotice)
        return notice && typeof notice.sessionId === 'string' && typeof notice.finishedAt === 'number'
          ? { sessionId: notice.sessionId.slice(0, 160), finishedAt: finite(notice.finishedAt, 0) }
          : null
      })(),
      onboardingSeen: Boolean(parsed.onboardingSeen),
    }

    const reversedAwardIds = new Set(
      state.transactions
        .filter((transaction) => transaction.type === 'reversal' && transaction.reversesTransactionId)
        .map((transaction) => transaction.reversesTransactionId as string),
    )
    const activeAwards = new Map(
      state.transactions
        .filter((transaction) =>
          transaction.type === 'award'
          && transaction.dayKey === currentDayKey
          && transaction.taskId
          && !reversedAwardIds.has(transaction.id),
        )
        .map((transaction) => [transaction.id, transaction]),
    )
    state.tasks.forEach((task) => {
      const daily = state.today.taskStates[task.id]
      const award = daily.activeAwardId ? activeAwards.get(daily.activeAwardId) : undefined
      const hasValidApproval = Boolean(award && award.taskId === task.id)
      if (daily.status === 'approved' && !hasValidApproval) {
        daily.status = daily.submittedAt ? 'pending' : 'todo'
        daily.resolvedAt = undefined
        daily.activeAwardId = undefined
      } else if (daily.status !== 'approved') {
        daily.activeAwardId = undefined
      }
    })
    return rolloverTo(state, now)
  } catch {
    return null
  }
}

export function loadAppState(now = new Date()): { state: AppState; recovered: boolean } {
  const primary = decodeStoredState(localStorage.getItem(STORAGE_KEY), now)
  if (primary) return { state: primary, recovered: false }
  const backup = decodeStoredState(localStorage.getItem(STORAGE_BACKUP_KEY), now)
  if (backup) return { state: backup, recovered: true }
  return { state: createDefaultState(now), recovered: Boolean(localStorage.getItem(STORAGE_KEY)) }
}

export function saveAppState(state: AppState): void {
  try {
    const previous = localStorage.getItem(STORAGE_KEY)
    if (previous && decodeStoredState(previous)) localStorage.setItem(STORAGE_BACKUP_KEY, previous)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // Safari private mode and full storage can reject writes; the in-memory app remains usable.
  }
}
