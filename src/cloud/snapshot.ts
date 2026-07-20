import type {
  ActivityEvent,
  AppState,
  DailyTaskState,
  HistoryDay,
  PushUpCount,
  RewardTransaction,
  Task,
  TaskStatus,
  ThemePreference,
  TimerSession,
} from '../types'
import type { CloudRole, CloudSnapshot } from '../types/cloud'

type JsonRecord = Record<string, unknown>

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Некорректный снимок: ${label}`)
  return value as JsonRecord
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Некорректный снимок: ${label}`)
  return value
}

function string(value: unknown, label: string, fallback?: string): string {
  if (typeof value === 'string') return value
  if (fallback !== undefined) return fallback
  throw new Error(`Некорректный снимок: ${label}`)
}

function number(value: unknown, label: string, fallback?: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (fallback !== undefined) return fallback
  throw new Error(`Некорректный снимок: ${label}`)
}

function boolean(value: unknown, label: string, fallback?: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (fallback !== undefined) return fallback
  throw new Error(`Некорректный снимок: ${label}`)
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value === 'string' && values.includes(value as T)) return value as T
  throw new Error(`Некорректный снимок: ${label}`)
}

function taskFromJson(value: unknown): Task {
  const task = record(value, 'task')
  return {
    id: string(task.id, 'task.id'),
    title: string(task.title, 'task.title'),
    icon: string(task.icon, 'task.icon', '⭐'),
    xp: number(task.xp, 'task.xp'),
    required: boolean(task.required, 'task.required'),
    builtIn: boolean(task.builtIn, 'task.builtIn'),
    kind: oneOf(task.kind, ['standard', 'pushups', 'custom'] as const, 'task.kind'),
    hidden: boolean(task.hidden, 'task.hidden'),
    createdAt: number(task.createdAt, 'task.createdAt'),
  }
}

function dailyStateFromJson(value: unknown, fallbackTaskId: string): { state: DailyTaskState; databaseId?: string } {
  const daily = record(value, 'today.taskStates')
  const selected = optionalNumber(daily.selectedPushUps)
  const selectedPushUps = selected === 10 || selected === 20 || selected === 30 || selected === 40 || selected === 50
    ? selected as PushUpCount
    : undefined
  return {
    databaseId: optionalString(daily.id),
    state: {
      taskId: string(daily.taskId, 'today.taskStates.taskId', fallbackTaskId),
      status: oneOf(daily.status, ['todo', 'pending', 'approved', 'rejected'] as const, 'today.taskStates.status') as TaskStatus,
      ...(selectedPushUps ? { selectedPushUps } : {}),
      ...(optionalNumber(daily.submittedXp) !== undefined ? { submittedXp: optionalNumber(daily.submittedXp) } : {}),
      ...(optionalNumber(daily.submittedAt) !== undefined ? { submittedAt: optionalNumber(daily.submittedAt) } : {}),
      ...(optionalNumber(daily.resolvedAt) !== undefined ? { resolvedAt: optionalNumber(daily.resolvedAt) } : {}),
      approvalRevision: number(daily.approvalRevision, 'today.taskStates.approvalRevision', 0),
      ...(optionalString(daily.activeAwardId) ? { activeAwardId: optionalString(daily.activeAwardId) } : {}),
    },
  }
}

function activityFromJson(value: unknown): ActivityEvent {
  const event = record(value, 'today.activity')
  return {
    id: string(event.id, 'activity.id'),
    type: oneOf(event.type, ['submitted', 'approved', 'rejected', 'reversed', 'manual', 'timer', 'reset', 'settings'] as const, 'activity.type'),
    message: string(event.message, 'activity.message'),
    createdAt: number(event.createdAt, 'activity.createdAt'),
  }
}

function historyFromJson(value: unknown): HistoryDay {
  const day = record(value, 'history')
  return {
    dayKey: string(day.dayKey, 'history.dayKey'),
    xpEarned: number(day.xpEarned, 'history.xpEarned', 0),
    minutesEarned: number(day.minutesEarned, 'history.minutesEarned', 0),
    minutesUsed: number(day.minutesUsed, 'history.minutesUsed', 0),
    completedTasks: number(day.completedTasks, 'history.completedTasks', 0),
    pushUps: number(day.pushUps, 'history.pushUps', 0),
    minimumMet: boolean(day.minimumMet, 'history.minimumMet', false),
    carriedOutMinutes: number(day.carriedOutMinutes, 'history.carriedOutMinutes', 0),
  }
}

function transactionFromJson(value: unknown): RewardTransaction {
  const transaction = record(value, 'transactions')
  return {
    id: string(transaction.id, 'transaction.id'),
    dayKey: string(transaction.dayKey, 'transaction.dayKey'),
    type: oneOf(transaction.type, ['award', 'reversal', 'manual', 'reset'] as const, 'transaction.type'),
    xpDelta: number(transaction.xpDelta, 'transaction.xpDelta', 0),
    minutesDelta: number(transaction.minutesDelta, 'transaction.minutesDelta', 0),
    createdAt: number(transaction.createdAt, 'transaction.createdAt'),
    ...(optionalString(transaction.taskId) ? { taskId: optionalString(transaction.taskId) } : {}),
    ...(optionalString(transaction.reason) ? { reason: optionalString(transaction.reason) } : {}),
    ...(optionalString(transaction.reversesTransactionId) ? { reversesTransactionId: optionalString(transaction.reversesTransactionId) } : {}),
  }
}

function timerFromJson(value: unknown): TimerSession | null {
  if (value == null) return null
  const timer = record(value, 'activeTimer')
  return {
    id: string(timer.id, 'timer.id'),
    dayKey: string(timer.dayKey, 'timer.dayKey'),
    startedAt: number(timer.startedAt, 'timer.startedAt'),
    endsAt: number(timer.endsAt, 'timer.endsAt'),
    durationSeconds: number(timer.durationSeconds, 'timer.durationSeconds'),
    accountedSeconds: number(timer.accountedSeconds, 'timer.accountedSeconds', 0),
    lastObservedAt: number(timer.lastObservedAt, 'timer.lastObservedAt'),
  }
}

/** Strict tenant-safe boundary between untyped jsonb and the existing screens. */
export function snapshotToAppState(payload: unknown): CloudSnapshot {
  const root = record(payload, 'root')
  const meta = record(root.meta, 'meta')
  const settings = record(root.settings, 'settings')
  const today = record(root.today, 'today')
  const rawStates = record(today.taskStates, 'today.taskStates')
  const taskStates: Record<string, DailyTaskState> = {}
  const dailyStateIds: Record<string, string> = {}
  for (const [taskId, rawState] of Object.entries(rawStates)) {
    const parsed = dailyStateFromJson(rawState, taskId)
    taskStates[taskId] = parsed.state
    if (parsed.databaseId) dailyStateIds[taskId] = parsed.databaseId
  }

  const role = oneOf(meta.role, ['parent', 'child'] as const, 'meta.role') as CloudRole
  const theme = oneOf(settings.theme, ['system', 'light', 'dark'] as const, 'settings.theme') as ThemePreference
  const revision = number(root.revision, 'revision', number(meta.revision, 'meta.revision', 0))
  const pinHash = role === 'parent' ? string(settings.pinHash, 'settings.pinHash') : 'child-session'
  const pinSalt = role === 'parent' ? string(settings.pinSalt, 'settings.pinSalt') : 'child-session'

  const appState: AppState = {
    schemaVersion: number(root.schemaVersion, 'schemaVersion', 3),
    revision,
    currentDayKey: string(root.currentDayKey, 'currentDayKey'),
    settings: {
      xpToMinutes: number(settings.xpToMinutes, 'settings.xpToMinutes'),
      dailyLimitMinutes: number(settings.dailyLimitMinutes, 'settings.dailyLimitMinutes'),
      carryOver: boolean(settings.carryOver, 'settings.carryOver'),
      theme,
      pinHash,
      pinSalt,
      hasChangedPin: role === 'parent' && boolean(settings.hasChangedPin, 'settings.hasChangedPin', true),
    },
    tasks: array(root.tasks, 'tasks').map(taskFromJson),
    today: {
      dayKey: string(today.dayKey, 'today.dayKey'),
      carryInMinutes: number(today.carryInMinutes, 'today.carryInMinutes', 0),
      usedSeconds: number(today.usedSeconds, 'today.usedSeconds', 0),
      taskStates,
      activity: array(today.activity, 'today.activity').map(activityFromJson),
    },
    history: array(root.history, 'history').map(historyFromJson),
    transactions: array(root.transactions, 'transactions').map(transactionFromJson),
    activeTimer: timerFromJson(root.activeTimer),
    timerNotice: null,
    onboardingSeen: true,
  }

  const familyId = string(meta.familyId, 'meta.familyId')
  return {
    appState,
    meta: {
      serverNow: number(meta.serverTime, 'meta.serverTime', Date.now()),
      revision: number(meta.revision, 'meta.revision', revision),
      membership: {
        id: string(meta.memberId, 'meta.memberId'),
        familyId,
        role,
        displayName: string(meta.displayName, 'meta.displayName'),
      },
      family: {
        id: familyId,
        name: string(meta.familyName, 'meta.familyName', 'Семья Николая'),
        timezone: string(meta.timezone, 'meta.timezone', 'Europe/Minsk'),
      },
      childName: string(meta.childName, 'meta.childName', 'Николай'),
      dailyStateIds,
    },
  }
}
