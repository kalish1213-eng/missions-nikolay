import { beforeEach, describe, expect, it } from 'vitest'
import { REQUIRED_TASK_IDS, createDefaultState } from '../data/defaults'
import {
  approveTask,
  getDayMetrics,
  getDayRewardTotals,
  getMinimumProgress,
  getTotalXp,
  rolloverTo,
  settleTimer,
  startTimer,
  submitTask,
  undoApproval,
} from '../lib/domain'
import { loadAppState, saveAppState } from '../lib/storage'
import { getTimerSnapshot } from '../lib/timer'
import type { AppState } from '../types'

const DAY = '2026-07-20'

function localDate(key: string, hours = 12, minutes = 0, seconds = 0): Date {
  const [year, month, date] = key.split('-').map(Number)
  return new Date(year, month - 1, date, hours, minutes, seconds, 0)
}

const NOW = localDate(DAY).getTime()

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(String(key), String(value))
  }
}

function submittedRequired(state = createDefaultState(localDate(DAY))): AppState {
  return REQUIRED_TASK_IDS.reduce((current, taskId, index) => {
    const result = submitTask(current, taskId, NOW + index * 1_000)
    if (result.error) throw new Error(result.error)
    return result.state
  }, state)
}

function approvedRequired(state = createDefaultState(localDate(DAY))): AppState {
  return REQUIRED_TASK_IDS.reduce((current, taskId, index) => {
    const submitted = submitTask(current, taskId, NOW + index * 2_000)
    if (submitted.error) throw new Error(submitted.error)
    const approved = approveTask(submitted.state, taskId, NOW + index * 2_000 + 1)
    if (approved.error) throw new Error(approved.error)
    return approved.state
  }, state)
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
    writable: true,
  })
})

describe('critical user flows', () => {
  it('submits all three required missions and restores their pending state', () => {
    const submitted = submittedRequired()
    saveAppState(submitted)

    const restored = loadAppState(localDate(DAY, 12, 5))

    expect(restored.recovered).toBe(false)
    expect(REQUIRED_TASK_IDS.map((taskId) => restored.state.today.taskStates[taskId].status)).toEqual([
      'pending',
      'pending',
      'pending',
    ])
    expect(REQUIRED_TASK_IDS.map((taskId) => restored.state.today.taskStates[taskId].submittedAt)).toEqual([
      NOW,
      NOW + 1_000,
      NOW + 2_000,
    ])
    expect(restored.state.transactions).toHaveLength(0)
    expect(getMinimumProgress(restored.state).met).toBe(false)
  })

  it('persists parent approvals, rewards, and the unlocked minimum', () => {
    const approved = REQUIRED_TASK_IDS.reduce((current, taskId, index) => {
      const result = approveTask(current, taskId, NOW + 10_000 + index)
      if (result.error) throw new Error(result.error)
      return result.state
    }, submittedRequired())
    saveAppState(approved)

    const restored = loadAppState(localDate(DAY, 12, 10)).state

    expect(REQUIRED_TASK_IDS.map((taskId) => restored.today.taskStates[taskId].status)).toEqual([
      'approved',
      'approved',
      'approved',
    ])
    expect(getMinimumProgress(restored).met).toBe(true)
    expect(getDayRewardTotals(restored)).toEqual({ xp: 30, minutes: 60 })
    expect(restored.transactions.map((transaction) => transaction.id)).toEqual([
      `award:${DAY}:teeth-morning:1`,
      `award:${DAY}:make-bed:1`,
      `award:${DAY}:homework:1`,
    ])
  })

  it('starts one timer and rejects a second timer without changing the running session', () => {
    const ready = approvedRequired()
    const started = startTimer(ready, 10 * 60, NOW + 20_000)
    if (started.error) throw new Error(started.error)

    const secondStart = startTimer(started.state, 5 * 60, NOW + 21_000)

    expect(secondStart.error).toBeDefined()
    expect(secondStart.state).toBe(started.state)
    expect(secondStart.state.activeTimer).toEqual(started.state.activeTimer)
    expect(secondStart.state.activeTimer?.durationSeconds).toBe(600)
    expect(getDayRewardTotals(secondStart.state)).toEqual({ xp: 30, minutes: 60 })
  })

  it('recovers a saved timer at 125 and 185 seconds and charges the real elapsed time', () => {
    const started = startTimer(approvedRequired(), 10 * 60, NOW)
    if (started.error) throw new Error(started.error)
    saveAppState(started.state)

    const restoredAt125 = loadAppState(new Date(NOW + 125_000)).state
    expect(getTimerSnapshot(restoredAt125.activeTimer!, NOW + 125_000)).toMatchObject({
      elapsedSeconds: 125,
      remainingSeconds: 475,
    })
    const checkpoint = settleTimer(restoredAt125, NOW + 125_000)
    expect(checkpoint.state.activeTimer?.accountedSeconds).toBe(125)
    saveAppState(checkpoint.state)

    const restoredAt185 = loadAppState(new Date(NOW + 185_000)).state
    expect(getTimerSnapshot(restoredAt185.activeTimer!, NOW + 185_000)).toMatchObject({
      elapsedSeconds: 185,
      remainingSeconds: 415,
    })
    const stopped = settleTimer(restoredAt185, NOW + 185_000, true)
    saveAppState(stopped.state)

    const finalReload = loadAppState(new Date(NOW + 185_000)).state
    expect(finalReload.activeTimer).toBeNull()
    expect(finalReload.today.usedSeconds).toBe(185)
    expect(getDayMetrics(finalReload, NOW + 185_000).remainingSeconds).toBe(60 * 60 - 185)
  })

  it('settles an active timer before undo and creates one persistent reversal only', () => {
    const startedAt = NOW + 30_000
    const running = startTimer(approvedRequired(), 10 * 60, startedAt)
    if (running.error) throw new Error(running.error)

    const undone = undoApproval(running.state, 'homework', startedAt + 120_000)
    if (undone.error) throw new Error(undone.error)
    saveAppState(undone.state)

    const restored = loadAppState(new Date(startedAt + 120_000)).state
    const duplicateUndo = undoApproval(restored, 'homework', startedAt + 121_000)
    const reversals = duplicateUndo.state.transactions.filter(
      (transaction) => transaction.id === `reversal:award:${DAY}:homework:1`,
    )

    expect(restored.activeTimer).toBeNull()
    expect(restored.today.usedSeconds).toBe(120)
    expect(restored.today.taskStates.homework.status).toBe('pending')
    expect(getMinimumProgress(restored).met).toBe(false)
    expect(getDayRewardTotals(restored)).toEqual({ xp: 10, minutes: 20 })
    expect(getDayMetrics(restored, startedAt + 120_000).remainingSeconds).toBe(18 * 60)
    expect(duplicateUndo.error).toBeDefined()
    expect(reversals).toHaveLength(1)
  })

  it('recalculates an active timer after reload and rolls it into the next day once', () => {
    const ready = structuredClone(approvedRequired())
    ready.settings.carryOver = true
    const started = startTimer(ready, 10 * 60, NOW)
    if (started.error) throw new Error(started.error)
    saveAppState(started.state)

    const recalculated = loadAppState(new Date(NOW + 185_000)).state
    expect(getDayMetrics(recalculated, NOW + 185_000)).toMatchObject({
      usedSeconds: 185,
      remainingSeconds: 60 * 60 - 185,
    })
    saveAppState(recalculated)

    const nextDay = loadAppState(localDate('2026-07-21')).state
    const repeated = rolloverTo(nextDay, localDate('2026-07-21', 18))

    expect(nextDay.currentDayKey).toBe('2026-07-21')
    expect(nextDay.activeTimer).toBeNull()
    expect(nextDay.history).toHaveLength(1)
    expect(nextDay.history[0]).toMatchObject({
      dayKey: DAY,
      xpEarned: 30,
      minutesEarned: 60,
      minutesUsed: 10,
      minimumMet: true,
      carriedOutMinutes: 50,
    })
    expect(nextDay.today.carryInMinutes).toBe(50)
    expect(getDayRewardTotals(nextDay)).toEqual({ xp: 0, minutes: 0 })
    expect(getTotalXp(nextDay)).toBe(30)
    expect(repeated).toBe(nextDay)
    expect(repeated.history).toHaveLength(1)
  })
})
