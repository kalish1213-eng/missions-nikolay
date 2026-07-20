import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PIN_HASH, REQUIRED_TASK_IDS, STORAGE_KEY, createDefaultState } from '../data/defaults'
import {
  adjustXp,
  approveTask,
  getDayMetrics,
  getMinimumProgress,
  getRemainingRequiredTasks,
  getStreak,
  getTotalXp,
  rejectTask,
  rolloverTo,
  setPushUpCount,
  startTimer,
  submitTask,
  undoApproval,
  updateSettings,
} from '../lib/domain'
import { isValidDayKey } from '../lib/date'
import { generatePinSalt, hashPin, verifyPin } from '../lib/security'
import { decodeStoredState, loadAppState, saveAppState } from '../lib/storage'
import type { AppState, RewardTransaction } from '../types'

const DAY = '2026-07-20'
const NEXT_DAY = '2026-07-21'

function localDate(key: string, hours = 12, minutes = 0, seconds = 0): Date {
  const [year, month, date] = key.split('-').map(Number)
  return new Date(year, month - 1, date, hours, minutes, seconds, 0)
}

const NOW = localDate(DAY).getTime()

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(String(key), String(value)) }
}

function submitAndApprove(state: AppState, taskId: string, at: number): AppState {
  const pending = submitTask(state, taskId, at)
  if (pending.error) throw new Error(pending.error)
  const approved = approveTask(pending.state, taskId, at + 1)
  if (approved.error) throw new Error(approved.error)
  return approved.state
}

function unlockPhone(): AppState {
  return REQUIRED_TASK_IDS.reduce((state, taskId, index) => submitAndApprove(state, taskId, NOW + index * 10), createDefaultState(localDate(DAY)))
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage(), writable: true })
})

describe('stage 2 product regressions', () => {
  it.each([
    { xp: 44, raw: 88, available: 88 },
    { xp: 45, raw: 90, available: 90 },
    { xp: 46, raw: 92, available: 90 },
  ])('keeps $xp XP while applying the exact daily cap', ({ xp, raw, available }) => {
    const adjusted = adjustXp(createDefaultState(localDate(DAY)), xp, 'Граница дневного лимита', NOW)
    expect(adjusted.error).toBeUndefined()
    expect(getDayMetrics(adjusted.state, NOW)).toMatchObject({ xpEarned: xp, rawEarnedMinutes: raw, budgetSeconds: available * 60 })
    expect(getTotalXp(adjusted.state)).toBe(xp)
  })

  it('returns exact remaining required mission names and pending state', () => {
    let state = createDefaultState(localDate(DAY))
    state = submitAndApprove(state, 'teeth-morning', NOW)
    state = submitAndApprove(state, 'make-bed', NOW + 10)
    state = submitTask(state, 'homework', NOW + 20).state
    expect(getRemainingRequiredTasks(state).map((task) => task.title)).toEqual(['Сделать школьную домашнюю работу'])
    expect(state.today.taskStates.homework.status).toBe('pending')
  })

  it('allows a rejected mission to be submitted again without an early award', () => {
    const initial = createDefaultState(localDate(DAY))
    const pending = submitTask(initial, 'homework', NOW).state
    const rejected = rejectTask(pending, 'homework', NOW + 1).state
    const resubmitted = submitTask(rejected, 'homework', NOW + 2).state
    expect(resubmitted.today.taskStates.homework.status).toBe('pending')
    expect(resubmitted.transactions).toHaveLength(0)
    expect(getTotalXp(resubmitted)).toBe(0)
  })

  it('persists one push-up award and archives the selected count', () => {
    let state = setPushUpCount(createDefaultState(localDate(DAY)), 30).state
    state = submitTask(state, 'pushups', NOW).state
    saveAppState(state)
    const pendingReload = loadAppState(localDate(DAY)).state
    expect(pendingReload.today.taskStates.pushups).toMatchObject({ status: 'pending', selectedPushUps: 30, submittedXp: 15 })
    expect(setPushUpCount(pendingReload, 20).error).toBeDefined()
    state = approveTask(pendingReload, 'pushups', NOW + 1).state
    saveAppState(state)
    const approvedReload = loadAppState(localDate(DAY)).state
    expect(approveTask(approvedReload, 'pushups', NOW + 2).error).toBeDefined()
    expect(approvedReload.transactions.filter((item) => item.type === 'award' && item.taskId === 'pushups')).toHaveLength(1)
    expect(rolloverTo(approvedReload, localDate(NEXT_DAY)).history.at(-1)?.pushUps).toBe(30)
  })

  it('undoes a persisted push-up award once and keeps an audit reversal', () => {
    let state = setPushUpCount(createDefaultState(localDate(DAY)), 40).state
    state = submitAndApprove(state, 'pushups', NOW)
    saveAppState(state)
    const undone = undoApproval(loadAppState(localDate(DAY)).state, 'pushups', NOW + 100)
    expect(undone.state.today.taskStates.pushups.status).toBe('pending')
    expect(undone.state.transactions.filter((item) => item.type === 'reversal')).toHaveLength(1)
    expect(undoApproval(undone.state, 'pushups', NOW + 101).error).toBeDefined()
    expect(getTotalXp(undone.state)).toBe(0)
  })

  it('does not stop an active timer when future reward settings or theme change', () => {
    const started = startTimer(unlockPhone(), 600, NOW).state
    const updated = updateSettings(started, { xpToMinutes: 3, carryOver: true, theme: 'dark' }, NOW + 120_000).state
    expect(updated.activeTimer?.id).toBe(started.activeTimer?.id)
    expect(updated.today.usedSeconds).toBe(0)
    expect(updated.settings).toMatchObject({ xpToMinutes: 3, carryOver: true, theme: 'dark' })
  })

  it('can correct lifetime XP even when the current day has no positive XP', () => {
    const state = createDefaultState(localDate(DAY))
    const historic: RewardTransaction = { id: 'historic', dayKey: '2026-07-19', type: 'manual', xpDelta: 50, minutesDelta: 100, reason: 'История', createdAt: NOW - 86_400_000 }
    state.transactions.push(historic)
    const corrected = adjustXp(state, -10, 'Исправление общей суммы', NOW)
    expect(corrected.error).toBeUndefined()
    expect(getTotalXp(corrected.state)).toBe(40)
    expect(corrected.state.transactions.at(-1)).toMatchObject({ xpDelta: -10, minutesDelta: -20 })
  })

  it('calculates streak relative to state.currentDayKey, not the system date', () => {
    const state = createDefaultState(localDate('2025-01-10'))
    state.history = [{ dayKey: '2025-01-09', xpEarned: 30, minutesEarned: 60, minutesUsed: 20, completedTasks: 3, pushUps: 0, minimumMet: true, carriedOutMinutes: 0 }]
    expect(getStreak(state)).toBe(1)
  })

  it('rejects impossible calendar dates and safely restores the current day', () => {
    expect(isValidDayKey('2026-02-29')).toBe(false)
    expect(isValidDayKey('2026-99-99')).toBe(false)
    const raw = JSON.stringify({ ...createDefaultState(localDate(DAY)), currentDayKey: '9999-99-99' })
    expect(decodeStoredState(raw, localDate(DAY))?.currentDayKey).toBe(DAY)
  })

  it('downgrades an orphaned approved status so it cannot unlock the timer', () => {
    const state = createDefaultState(localDate(DAY))
    state.today.taskStates.homework = { taskId: 'homework', status: 'approved', approvalRevision: 1, submittedAt: NOW, activeAwardId: 'missing-award' }
    const restored = decodeStoredState(JSON.stringify(state), localDate(DAY))
    expect(restored?.today.taskStates.homework.status).toBe('pending')
    expect(restored && getMinimumProgress(restored).met).toBe(false)
  })

  it('keeps an unread timer-finished notice across reload', () => {
    const state = createDefaultState(localDate(DAY))
    state.timerNotice = { sessionId: 'timer:finished', finishedAt: NOW }
    saveAppState(state)
    expect(loadAppState(localDate(DAY)).state.timerNotice).toEqual(state.timerNotice)
  })

  it('deduplicates history days and discards a timer from another day', () => {
    const state = createDefaultState(localDate(DAY))
    state.history = [
      { dayKey: '2026-07-19', xpEarned: 10, minutesEarned: 20, minutesUsed: 10, completedTasks: 1, pushUps: 0, minimumMet: false, carriedOutMinutes: 0 },
      { dayKey: '2026-07-19', xpEarned: 20, minutesEarned: 40, minutesUsed: 20, completedTasks: 2, pushUps: 10, minimumMet: true, carriedOutMinutes: 0 },
    ]
    state.activeTimer = { id: 'wrong-day', dayKey: NEXT_DAY, startedAt: NOW, endsAt: NOW + 600_000, durationSeconds: 600, accountedSeconds: 0, lastObservedAt: NOW }
    const restored = decodeStoredState(JSON.stringify(state), localDate(DAY))
    expect(restored?.history).toHaveLength(1)
    expect(restored?.history[0].xpEarned).toBe(20)
    expect(restored?.activeTimer).toBeNull()
  })

  it('uses a per-install salt after changing PIN and stores no plaintext PIN', async () => {
    const saltA = generatePinSalt()
    const saltB = generatePinSalt()
    const digest = await hashPin('9876', saltA)
    expect(saltA).not.toBe(saltB)
    expect(await verifyPin('9876', digest, saltA)).toBe(true)
    expect(await verifyPin('9876', digest, saltB)).toBe(false)
    const state = createDefaultState(localDate(DAY))
    state.settings.pinHash = digest
    state.settings.pinSalt = saltA
    state.settings.hasChangedPin = true
    saveAppState(state)
    expect(localStorage.getItem(STORAGE_KEY)).not.toContain('9876')
  })

  it('falls back from a non-hex PIN hash instead of locking out the parent', () => {
    const state = createDefaultState(localDate(DAY))
    state.settings.pinHash = 'z'.repeat(64)
    const restored = decodeStoredState(JSON.stringify(state), localDate(DAY))
    expect(restored?.settings.pinHash).toBe(DEFAULT_PIN_HASH)
  })

  it('starts and accounts for a returned sub-minute remainder', () => {
    const state = unlockPhone()
    state.today.usedSeconds = getDayMetrics(state, NOW).budgetSeconds - 45
    const started = startTimer(state, 45, NOW)
    expect(started.error).toBeUndefined()
    expect(started.state.activeTimer?.durationSeconds).toBe(45)
  })
})
