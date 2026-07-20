import { createDailyProgress } from '../data/defaults'
import { dayKey, endOfDayMs, nextDayKey, previousDayKey } from './date'
import { getTimerSnapshot } from './timer'
import type {
  AppState,
  DayMetrics,
  HistoryDay,
  LevelInfo,
  PushUpCount,
  RewardTransaction,
  Task,
  TransitionResult,
  UserSettings,
} from '../types'

const PUSH_UP_XP: Record<PushUpCount, number> = { 10: 5, 20: 10, 30: 15, 40: 20, 50: 25 }
const PUSH_UP_COUNTS = new Set<number>([10, 20, 30, 40, 50])

function copyState(state: AppState): AppState {
  return structuredClone(state)
}

function bump(state: AppState): AppState {
  state.revision += 1
  return state
}

function eventId(state: AppState, now: number, type: string): string {
  return `${type}:${now}:${state.revision + 1}`
}

function log(state: AppState, type: Parameters<AppState['today']['activity']['push']>[0]['type'], message: string, now: number): void {
  state.today.activity.unshift({ id: eventId(state, now, type), type, message, createdAt: now })
  state.today.activity = state.today.activity.slice(0, 100)
}

function safeNumber(value: number, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

export function xpToMinutes(xp: number, minutesPerXp: number): number {
  const safeXp = safeNumber(xp, 0, 0, 100_000)
  const safeRate = safeNumber(minutesPerXp, 2, 0.25, 20)
  return Math.max(0, Math.floor(safeXp * safeRate))
}

function isPushUpCount(count: number): count is PushUpCount {
  return Number.isInteger(count) && PUSH_UP_COUNTS.has(count)
}

export function getPushUpXp(count: number): number {
  return isPushUpCount(count) ? PUSH_UP_XP[count] : 0
}

export function getDayTransactions(state: AppState, key = state.currentDayKey): RewardTransaction[] {
  return state.transactions.filter((transaction) => transaction.dayKey === key)
}

export function getDayRewardTotals(state: AppState, key = state.currentDayKey): { xp: number; minutes: number } {
  return getDayTransactions(state, key).reduce(
    (total, transaction) => ({
      xp: total.xp + transaction.xpDelta,
      minutes: total.minutes + transaction.minutesDelta,
    }),
    { xp: 0, minutes: 0 },
  )
}

export function getTotalXp(state: AppState): number {
  return Math.max(0, state.transactions.reduce((total, transaction) => total + transaction.xpDelta, 0))
}

export function getMinimumProgress(state: AppState): { done: number; total: number; met: boolean } {
  const required = state.tasks.filter((task) => task.required && !task.hidden)
  const done = required.filter((task) => state.today.taskStates[task.id]?.status === 'approved').length
  return { done, total: required.length, met: required.length > 0 && done === required.length }
}

export function getRemainingRequiredTasks(state: AppState): Task[] {
  return state.tasks.filter(
    (task) => task.required && !task.hidden && state.today.taskStates[task.id]?.status !== 'approved',
  )
}

export function getDayMetrics(state: AppState, now = Date.now()): DayMetrics {
  const reward = getDayRewardTotals(state)
  const rawEarnedMinutes = Math.max(0, reward.minutes)
  const budgetSeconds = Math.min(
    state.settings.dailyLimitMinutes * 60,
    (Math.max(0, state.today.carryInMinutes) + rawEarnedMinutes) * 60,
  )
  const activeSeconds = state.activeTimer ? getTimerSnapshot(state.activeTimer, now).elapsedSeconds : 0
  const usedSeconds = Math.max(0, state.today.usedSeconds + activeSeconds)
  return {
    xpEarned: Math.max(0, reward.xp),
    rawEarnedMinutes,
    budgetSeconds,
    usedSeconds,
    remainingSeconds: Math.max(0, budgetSeconds - usedSeconds),
  }
}

export function getLevel(totalXp: number): LevelInfo {
  const xp = Math.max(0, totalXp)
  const levels = [
    { name: 'Новичок', floor: 0, next: 100 },
    { name: 'Помощник', floor: 100, next: 250 },
    { name: 'Чемпион', floor: 250, next: 500 },
    { name: 'Герой', floor: 500, next: 1000 },
    { name: 'Супергерой семьи', floor: 1000, next: null },
  ] as const
  const index = xp >= 1000 ? 4 : xp >= 500 ? 3 : xp >= 250 ? 2 : xp >= 100 ? 1 : 0
  const current = levels[index]
  const progress = current.next === null ? 1 : (xp - current.floor) / (current.next - current.floor)
  return { name: current.name, level: index + 1, floorXp: current.floor, nextXp: current.next, progress }
}

export function submitTask(state: AppState, taskId: string, now = Date.now()): TransitionResult {
  const task = state.tasks.find((item) => item.id === taskId && !item.hidden)
  const daily = state.today.taskStates[taskId]
  if (!task || !daily) return { state, error: 'Миссия не найдена' }
  if (daily.status === 'approved') return { state, error: 'Миссия уже подтверждена' }
  if (daily.status === 'pending' && task.kind !== 'pushups') return { state, error: 'Миссия уже ждёт подтверждения' }

  const next = copyState(state)
  const target = next.today.taskStates[taskId]
  target.status = 'pending'
  target.submittedAt = now
  target.resolvedAt = undefined
  target.submittedXp = task.kind === 'pushups' ? getPushUpXp(target.selectedPushUps ?? 10) : task.xp
  log(next, 'submitted', `${task.title} — отправлено на проверку`, now)
  return { state: bump(next) }
}

export function setPushUpCount(state: AppState, count: PushUpCount): TransitionResult {
  const daily = state.today.taskStates.pushups
  if (!isPushUpCount(count)) return { state, error: 'Выберите 10, 20, 30, 40 или 50 отжиманий' }
  if (!daily || daily.status === 'approved') return { state, error: 'Сегодня отжимания уже подтверждены' }
  if (daily.status === 'pending') return { state, error: 'Количество уже отправлено родителю' }
  const next = copyState(state)
  const target = next.today.taskStates.pushups
  target.selectedPushUps = count
  return { state: bump(next) }
}

export function approveTask(state: AppState, taskId: string, now = Date.now()): TransitionResult {
  const task = state.tasks.find((item) => item.id === taskId)
  const daily = state.today.taskStates[taskId]
  if (!task || !daily) return { state, error: 'Миссия не найдена' }
  if (daily.status !== 'pending') return { state, error: 'Эта миссия не ожидает проверки' }

  const next = copyState(state)
  const target = next.today.taskStates[taskId]
  const revision = target.approvalRevision + 1
  const awardId = `award:${next.currentDayKey}:${taskId}:${revision}`
  if (next.transactions.some((transaction) => transaction.id === awardId)) {
    return { state, error: 'Награда уже начислена' }
  }

  const xp = Math.max(0, target.submittedXp ?? task.xp)
  const minutes = xpToMinutes(xp, next.settings.xpToMinutes)
  target.status = 'approved'
  target.resolvedAt = now
  target.approvalRevision = revision
  target.activeAwardId = awardId
  next.transactions.push({
    id: awardId,
    dayKey: next.currentDayKey,
    type: 'award',
    xpDelta: xp,
    minutesDelta: minutes,
    taskId,
    createdAt: now,
  })
  log(next, 'approved', `${task.title} — подтверждено, +${xp} XP`, now)
  return { state: bump(next), reward: { xp, minutes } }
}

export function rejectTask(state: AppState, taskId: string, now = Date.now()): TransitionResult {
  const task = state.tasks.find((item) => item.id === taskId)
  const daily = state.today.taskStates[taskId]
  if (!task || !daily) return { state, error: 'Миссия не найдена' }
  if (daily.status !== 'pending') return { state, error: 'Эта миссия не ожидает проверки' }
  const next = copyState(state)
  next.today.taskStates[taskId].status = 'rejected'
  next.today.taskStates[taskId].resolvedAt = now
  log(next, 'rejected', `${task.title} — отклонено`, now)
  return { state: bump(next) }
}

export function settleTimer(state: AppState, now = Date.now(), stopEarly = false): TransitionResult {
  if (!state.activeTimer) return { state, error: 'Активного таймера нет' }
  const snapshot = getTimerSnapshot(state.activeTimer, now)
  if (!snapshot.finished && !stopEarly) {
    if (snapshot.elapsedSeconds === state.activeTimer.accountedSeconds) return { state }
    const checkpoint = copyState(state)
    if (checkpoint.activeTimer) {
      checkpoint.activeTimer.accountedSeconds = snapshot.elapsedSeconds
      checkpoint.activeTimer.lastObservedAt = Math.max(checkpoint.activeTimer.lastObservedAt, now)
    }
    return { state: bump(checkpoint) }
  }

  const next = copyState(state)
  const session = next.activeTimer
  if (!session) return { state }
  next.today.usedSeconds += snapshot.elapsedSeconds
  next.activeTimer = null
  if (snapshot.finished && !stopEarly) {
    next.timerNotice = { sessionId: session.id, finishedAt: now }
    log(next, 'timer', `Время с телефоном завершено: ${Math.ceil(snapshot.elapsedSeconds / 60)} мин`, now)
  } else {
    log(next, 'timer', `Таймер остановлен: использовано ${Math.ceil(snapshot.elapsedSeconds / 60)} мин`, now)
  }
  return { state: bump(next) }
}

export function undoApproval(state: AppState, taskId: string, now = Date.now()): TransitionResult {
  const task = state.tasks.find((item) => item.id === taskId)
  const daily = state.today.taskStates[taskId]
  if (!task || !daily?.activeAwardId || daily.status !== 'approved') {
    return { state, error: 'Активное подтверждение не найдено' }
  }
  const award = state.transactions.find((transaction) => transaction.id === daily.activeAwardId && transaction.type === 'award')
  if (!award) return { state, error: 'Транзакция награды не найдена' }
  const reversalId = `reversal:${award.id}`
  if (state.transactions.some((transaction) => transaction.id === reversalId)) {
    return { state, error: 'Подтверждение уже отменено' }
  }

  let base = state
  if (base.activeTimer) base = settleTimer(base, now, true).state
  const next = copyState(base)
  const target = next.today.taskStates[taskId]
  target.status = 'pending'
  target.resolvedAt = now
  target.activeAwardId = undefined
  next.transactions.push({
    id: reversalId,
    dayKey: next.currentDayKey,
    type: 'reversal',
    xpDelta: -award.xpDelta,
    minutesDelta: -award.minutesDelta,
    taskId,
    createdAt: now,
    reversesTransactionId: award.id,
  })
  log(next, 'reversed', `${task.title} — подтверждение отменено`, now)
  return { state: bump(next) }
}

export function startTimer(state: AppState, selectedSeconds: number, now = Date.now()): TransitionResult {
  if (!getMinimumProgress(state).met) return { state, error: 'Сначала выполни обязательные миссии' }
  if (state.activeTimer) return { state, error: 'Один таймер уже запущен' }
  if (!Number.isFinite(selectedSeconds)) return { state, error: 'Некорректное время таймера' }
  const seconds = Math.floor(selectedSeconds)
  const available = getDayMetrics(state, now).remainingSeconds
  if (seconds <= 0 || seconds > available) return { state, error: 'Недостаточно доступного времени' }

  const next = copyState(state)
  const id = `timer:${next.currentDayKey}:${now}`
  next.activeTimer = {
    id,
    dayKey: next.currentDayKey,
    startedAt: now,
    endsAt: Math.min(now + seconds * 1000, endOfDayMs(next.currentDayKey)),
    durationSeconds: seconds,
    accountedSeconds: 0,
    lastObservedAt: now,
  }
  next.timerNotice = null
  log(next, 'timer', `Запущен таймер на ${Math.ceil(seconds / 60)} мин`, now)
  return { state: bump(next) }
}

export function acknowledgeTimerNotice(state: AppState): AppState {
  if (!state.timerNotice) return state
  const next = copyState(state)
  next.timerNotice = null
  return bump(next)
}

export function adjustXp(state: AppState, requestedDelta: number, reason: string, now = Date.now()): TransitionResult {
  const cleanReason = reason.trim()
  if (!cleanReason) return { state, error: 'Укажите причину корректировки' }
  if (!Number.isFinite(requestedDelta) || requestedDelta === 0) return { state, error: 'Укажите ненулевое количество XP' }
  const totalXp = getTotalXp(state)
  const minAllowed = -totalXp
  const delta = Math.trunc(Math.max(minAllowed, Math.min(10_000, requestedDelta)))
  if (delta === 0) return { state, error: 'XP не может стать отрицательным' }
  let base = state
  if (delta < 0 && state.activeTimer) base = settleTimer(state, now, true).state
  const next = copyState(base)
  const minutes = delta >= 0 ? xpToMinutes(delta, next.settings.xpToMinutes) : -xpToMinutes(Math.abs(delta), next.settings.xpToMinutes)
  next.transactions.push({
    id: `manual:${next.currentDayKey}:${now}:${next.revision + 1}`,
    dayKey: next.currentDayKey,
    type: 'manual',
    xpDelta: delta,
    minutesDelta: minutes,
    reason: cleanReason,
    createdAt: now,
  })
  log(next, 'manual', `${delta > 0 ? '+' : ''}${delta} XP — ${cleanReason}`, now)
  return { state: bump(next), reward: delta > 0 ? { xp: delta, minutes } : undefined }
}

export function updateSettings(state: AppState, values: Partial<Pick<UserSettings, 'xpToMinutes' | 'dailyLimitMinutes' | 'carryOver' | 'theme'>>, now = Date.now()): TransitionResult {
  const next = copyState(state)
  if (values.xpToMinutes !== undefined) next.settings.xpToMinutes = safeNumber(values.xpToMinutes, 2, 0.25, 20)
  if (values.dailyLimitMinutes !== undefined) next.settings.dailyLimitMinutes = Math.round(safeNumber(values.dailyLimitMinutes, 90, 10, 360))
  if (values.carryOver !== undefined) next.settings.carryOver = Boolean(values.carryOver)
  if (values.theme !== undefined && ['system', 'light', 'dark'].includes(values.theme)) next.settings.theme = values.theme
  log(next, 'settings', 'Настройки наград обновлены', now)
  return { state: bump(next) }
}

export function updateTask(state: AppState, taskId: string, values: Partial<Pick<Task, 'xp' | 'hidden'>>, now = Date.now()): TransitionResult {
  const task = state.tasks.find((item) => item.id === taskId)
  if (!task) return { state, error: 'Миссия не найдена' }
  if (values.hidden && task.required) return { state, error: 'Обязательную миссию нельзя скрыть' }
  const next = copyState(state)
  const target = next.tasks.find((item) => item.id === taskId)
  if (!target) return { state }
  if (values.xp !== undefined && target.kind !== 'pushups') target.xp = Math.round(safeNumber(values.xp, target.xp, 1, 500))
  if (values.hidden !== undefined) target.hidden = Boolean(values.hidden)
  log(next, 'settings', `${target.title} — настройки изменены`, now)
  return { state: bump(next) }
}

export function addCustomTask(state: AppState, title: string, xp: number, now = Date.now()): TransitionResult {
  const cleanTitle = title.trim().replace(/\s+/g, ' ').slice(0, 80)
  if (cleanTitle.length < 2) return { state, error: 'Введите название миссии' }
  const next = copyState(state)
  const id = `custom-${now}-${next.revision + 1}`
  const task: Task = {
    id,
    title: cleanTitle,
    icon: '⭐',
    xp: Math.round(safeNumber(xp, 10, 1, 500)),
    required: false,
    builtIn: false,
    kind: 'custom',
    hidden: false,
    createdAt: now,
  }
  next.tasks.push(task)
  next.today.taskStates[id] = { taskId: id, status: 'todo', approvalRevision: 0 }
  log(next, 'settings', `Добавлена миссия «${cleanTitle}»`, now)
  return { state: bump(next) }
}

export function changePinHash(state: AppState, pinHash: string, pinSalt: string, now = Date.now()): AppState {
  const next = copyState(state)
  next.settings.pinHash = pinHash
  next.settings.pinSalt = pinSalt
  next.settings.hasChangedPin = true
  log(next, 'settings', 'PIN родителя изменён', now)
  return bump(next)
}

export function resetToday(state: AppState, now = Date.now()): TransitionResult {
  let base = state
  if (base.activeTimer) base = settleTimer(base, now, true).state
  const next = copyState(base)
  const totals = getDayRewardTotals(next)
  if (totals.xp !== 0 || totals.minutes !== 0) {
    next.transactions.push({
      id: `reset:${next.currentDayKey}:${now}`,
      dayKey: next.currentDayKey,
      type: 'reset',
      xpDelta: -totals.xp,
      minutesDelta: -totals.minutes,
      reason: 'Сброс сегодняшнего дня',
      createdAt: now,
    })
  }
  const carry = next.today.carryInMinutes
  next.today = createDailyProgress(next.tasks, next.currentDayKey, carry)
  next.timerNotice = null
  log(next, 'reset', 'Сегодняшний день сброшен родителем', now)
  return { state: bump(next) }
}

function historyFromCurrent(state: AppState): HistoryDay {
  const metrics = getDayMetrics(state, endOfDayMs(state.currentDayKey))
  const pushups = state.today.taskStates.pushups
  return {
    dayKey: state.currentDayKey,
    xpEarned: metrics.xpEarned,
    minutesEarned: metrics.rawEarnedMinutes,
    minutesUsed: Math.ceil(metrics.usedSeconds / 60),
    completedTasks: Object.values(state.today.taskStates).filter((task) => task.status === 'approved').length,
    pushUps: pushups?.status === 'approved' ? pushups.selectedPushUps ?? 0 : 0,
    minimumMet: getMinimumProgress(state).met,
    carriedOutMinutes: state.settings.carryOver ? Math.floor(metrics.remainingSeconds / 60) : 0,
  }
}

export function rolloverTo(state: AppState, targetDate = new Date()): AppState {
  const targetKey = dayKey(targetDate)
  if (state.currentDayKey >= targetKey) return state
  let next = copyState(state)
  if (next.activeTimer) next = settleTimer(next, endOfDayMs(next.currentDayKey), true).state

  let archive = historyFromCurrent(next)
  if (!next.history.some((day) => day.dayKey === archive.dayKey)) next.history.push(archive)
  let carry = archive.carriedOutMinutes
  let cursor = nextDayKey(next.currentDayKey)
  let guard = 0

  while (cursor < targetKey && guard < 3700) {
    const blank = createDailyProgress(next.tasks, cursor, carry)
    next.currentDayKey = cursor
    next.today = blank
    archive = historyFromCurrent(next)
    if (!next.history.some((day) => day.dayKey === cursor)) next.history.push(archive)
    carry = archive.carriedOutMinutes
    cursor = nextDayKey(cursor)
    guard += 1
  }

  next.currentDayKey = targetKey
  next.today = createDailyProgress(next.tasks, targetKey, next.settings.carryOver ? carry : 0)
  next.activeTimer = null
  next.timerNotice = null
  next.history = next.history.sort((a, b) => a.dayKey.localeCompare(b.dayKey)).slice(-365)
  return bump(next)
}

export function getStreak(state: AppState): number {
  const successful = new Set(state.history.filter((day) => day.minimumMet).map((day) => day.dayKey))
  const currentMet = getMinimumProgress(state).met
  let cursor = currentMet ? state.currentDayKey : previousDayKey(state.currentDayKey)
  if (currentMet) successful.add(state.currentDayKey)
  let streak = 0
  while (successful.has(cursor) && streak < 3650) {
    streak += 1
    cursor = previousDayKey(cursor)
  }
  return streak
}
