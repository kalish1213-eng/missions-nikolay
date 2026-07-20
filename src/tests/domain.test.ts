import { beforeEach, describe, expect, it } from 'vitest'
import {
  REQUIRED_TASK_IDS,
  SCHEMA_VERSION,
  STORAGE_BACKUP_KEY,
  STORAGE_KEY,
  createDefaultState,
} from '../data/defaults'
import {
  acknowledgeTimerNotice,
  approveTask,
  getDayMetrics,
  getDayRewardTotals,
  getLevel,
  getMinimumProgress,
  getPushUpXp,
  getTotalXp,
  rolloverTo,
  setPushUpCount,
  settleTimer,
  startTimer,
  submitTask,
  undoApproval,
  xpToMinutes,
} from '../lib/domain'
import { decodeStoredState, loadAppState, saveAppState } from '../lib/storage'
import { formatTimer, getTimerSnapshot } from '../lib/timer'
import type { AppState, PushUpCount, RewardTransaction, TimerSession } from '../types'

const DAY = '2026-07-20'

function localDate(key: string, hours = 12, minutes = 0, seconds = 0): Date {
  const [year, month, date] = key.split('-').map(Number)
  return new Date(year, month - 1, date, hours, minutes, seconds, 0)
}

const NOW = localDate(DAY).getTime()

function addTransaction(
  state: AppState,
  values: Partial<RewardTransaction> & Pick<RewardTransaction, 'xpDelta' | 'minutesDelta'>,
): AppState {
  const next = structuredClone(state)
  const index = next.transactions.length + 1
  next.transactions.push({
    id: values.id ?? `fixture:${index}`,
    dayKey: values.dayKey ?? next.currentDayKey,
    type: values.type ?? 'award',
    xpDelta: values.xpDelta,
    minutesDelta: values.minutesDelta,
    createdAt: values.createdAt ?? NOW + index,
    ...(values.taskId ? { taskId: values.taskId } : {}),
    ...(values.reason ? { reason: values.reason } : {}),
    ...(values.reversesTransactionId ? { reversesTransactionId: values.reversesTransactionId } : {}),
  })
  return next
}

function submitAndApprove(state: AppState, taskId: string, now: number): AppState {
  const submitted = submitTask(state, taskId, now)
  if (submitted.error) throw new Error(submitted.error)
  const approved = approveTask(submitted.state, taskId, now + 1)
  if (approved.error) throw new Error(approved.error)
  return approved.state
}

function unlockPhone(state = createDefaultState(localDate(DAY)), now = NOW): AppState {
  return REQUIRED_TASK_IDS.reduce(
    (current, taskId, index) => submitAndApprove(current, taskId, now + index * 10),
    state,
  )
}

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

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: new MemoryStorage(),
    writable: true,
  })
})

describe('XP conversion and daily budget', () => {
  it('converts XP using the configured rate and floors fractional minutes', () => {
    expect(xpToMinutes(5, 2)).toBe(10)
    expect(xpToMinutes(7, 1.5)).toBe(10)
    expect(xpToMinutes(4, 0.25)).toBe(1)
  })

  it('uses safe bounds for invalid XP and rates', () => {
    expect(xpToMinutes(-5, 2)).toBe(0)
    expect(xpToMinutes(Number.NaN, 2)).toBe(0)
    expect(xpToMinutes(5, Number.NaN)).toBe(10)
    expect(xpToMinutes(4, -100)).toBe(1)
  })

  it('caps the spendable budget while preserving raw earned minutes', () => {
    const state = addTransaction(createDefaultState(localDate(DAY)), {
      xpDelta: 50,
      minutesDelta: 100,
    })

    expect(getDayMetrics(state, NOW)).toEqual({
      xpEarned: 50,
      rawEarnedMinutes: 100,
      budgetSeconds: 90 * 60,
      usedSeconds: 0,
      remainingSeconds: 90 * 60,
    })
  })

  it('combines carry-over and earned minutes under the same daily limit', () => {
    let state = createDefaultState(localDate(DAY))
    state = structuredClone(state)
    state.settings.dailyLimitMinutes = 60
    state.today.carryInMinutes = 30
    state.today.usedSeconds = 10 * 60
    state = addTransaction(state, { xpDelta: 20, minutesDelta: 40 })

    const metrics = getDayMetrics(state, NOW)
    expect(metrics.rawEarnedMinutes).toBe(40)
    expect(metrics.budgetSeconds).toBe(60 * 60)
    expect(metrics.usedSeconds).toBe(10 * 60)
    expect(metrics.remainingSeconds).toBe(50 * 60)
  })

  it('never exposes a negative remaining balance after a correction', () => {
    let state = createDefaultState(localDate(DAY))
    state = addTransaction(state, { xpDelta: 5, minutesDelta: 10 })
    state.today.usedSeconds = 15 * 60

    expect(getDayMetrics(state, NOW).remainingSeconds).toBe(0)
  })
})

describe('required minimum and reward lifecycle', () => {
  it('counts only approved visible required missions', () => {
    const state = createDefaultState(localDate(DAY))
    expect(getMinimumProgress(state)).toEqual({ done: 0, total: 3, met: false })

    const partial = structuredClone(state)
    partial.today.taskStates['teeth-morning'].status = 'approved'
    partial.today.taskStates['make-bed'].status = 'approved'
    partial.today.taskStates.homework.status = 'pending'
    expect(getMinimumProgress(partial)).toEqual({ done: 2, total: 3, met: false })

    partial.today.taskStates.homework.status = 'approved'
    expect(getMinimumProgress(partial)).toEqual({ done: 3, total: 3, met: true })
  })

  it('does not award XP until a parent approves the pending mission', () => {
    const initial = createDefaultState(localDate(DAY))
    const submitted = submitTask(initial, 'trash', NOW)

    expect(submitted.error).toBeUndefined()
    expect(submitted.state.today.taskStates.trash.status).toBe('pending')
    expect(getDayRewardTotals(submitted.state)).toEqual({ xp: 0, minutes: 0 })

    const approved = approveTask(submitted.state, 'trash', NOW + 1)
    expect(approved.reward).toEqual({ xp: 10, minutes: 20 })
    expect(approved.state.today.taskStates.trash.status).toBe('approved')
    expect(getDayRewardTotals(approved.state)).toEqual({ xp: 10, minutes: 20 })
  })

  it('makes approval idempotent for repeated and stale invocations', () => {
    const pending = submitTask(createDefaultState(localDate(DAY)), 'reading', NOW).state
    const first = approveTask(pending, 'reading', NOW + 1)
    const staleDuplicate = approveTask(pending, 'reading', NOW + 2)
    const sequentialDuplicate = approveTask(first.state, 'reading', NOW + 3)

    expect(first.state.transactions).toHaveLength(1)
    expect(staleDuplicate.state.transactions).toHaveLength(1)
    expect(staleDuplicate.state.transactions[0].id).toBe(first.state.transactions[0].id)
    expect(sequentialDuplicate.error).toBeDefined()
    expect(sequentialDuplicate.state).toBe(first.state)
    expect(getDayRewardTotals(sequentialDuplicate.state)).toEqual({ xp: 15, minutes: 30 })
  })

  it('undoes the exact original award even after the conversion rate changes', () => {
    const pending = submitTask(createDefaultState(localDate(DAY)), 'trash', NOW).state
    const approved = approveTask(pending, 'trash', NOW + 1).state
    const changed = structuredClone(approved)
    changed.settings.xpToMinutes = 7

    const undone = undoApproval(changed, 'trash', NOW + 2)
    expect(undone.error).toBeUndefined()
    expect(undone.state.today.taskStates.trash.status).toBe('pending')
    expect(undone.state.transactions).toHaveLength(2)
    expect(undone.state.transactions[1]).toMatchObject({
      id: `reversal:${approved.transactions[0].id}`,
      type: 'reversal',
      xpDelta: -10,
      minutesDelta: -20,
      reversesTransactionId: approved.transactions[0].id,
    })
    expect(getDayRewardTotals(undone.state)).toEqual({ xp: 0, minutes: 0 })
    expect(getTotalXp(undone.state)).toBe(0)
  })

  it('does not reverse twice and can award a new approval revision later', () => {
    const approved = submitAndApprove(createDefaultState(localDate(DAY)), 'trash', NOW)
    const undone = undoApproval(approved, 'trash', NOW + 2).state
    const duplicateUndo = undoApproval(undone, 'trash', NOW + 3)

    expect(duplicateUndo.error).toBeDefined()
    expect(duplicateUndo.state.transactions).toHaveLength(2)

    const approvedAgain = approveTask(undone, 'trash', NOW + 4)
    expect(approvedAgain.error).toBeUndefined()
    expect(approvedAgain.state.today.taskStates.trash.approvalRevision).toBe(2)
    expect(approvedAgain.state.transactions.map((transaction) => transaction.id)).toContain(
      `award:${DAY}:trash:2`,
    )
    expect(getDayRewardTotals(approvedAgain.state)).toEqual({ xp: 10, minutes: 20 })
  })

  it('settles an active timer before undoing a required award', () => {
    const unlocked = unlockPhone()
    const startedAt = NOW + 1_000
    const started = startTimer(unlocked, 10 * 60, startedAt).state
    const undone = undoApproval(started, 'homework', startedAt + 120_000)

    expect(undone.state.activeTimer).toBeNull()
    expect(undone.state.today.usedSeconds).toBe(120)
    expect(getMinimumProgress(undone.state).met).toBe(false)
    expect(getDayMetrics(undone.state, startedAt + 120_000).remainingSeconds).toBe(18 * 60)
  })
})

describe('push-ups and levels', () => {
  it.each<[PushUpCount, number]>([
    [10, 5],
    [20, 10],
    [30, 15],
    [40, 20],
    [50, 25],
  ])('maps %i push-ups to %i XP', (count, xp) => {
    expect(getPushUpXp(count)).toBe(xp)
  })

  it('locks the submitted push-up count until the parent decides', () => {
    const initial = createDefaultState(localDate(DAY))
    const selected = setPushUpCount(initial, 50).state
    const pending = submitTask(selected, 'pushups', NOW).state
    const changedWhilePending = setPushUpCount(pending, 20)

    expect(changedWhilePending.error).toBeDefined()
    expect(changedWhilePending.state.today.taskStates.pushups.submittedXp).toBe(25)
    expect(changedWhilePending.state.today.taskStates.pushups.selectedPushUps).toBe(50)
    const approved = approveTask(changedWhilePending.state, 'pushups', NOW + 1)
    expect(approved.reward).toEqual({ xp: 25, minutes: 50 })

    const blockedChange = setPushUpCount(approved.state, 30)
    expect(blockedChange.error).toBeDefined()
    expect(blockedChange.state.today.taskStates.pushups.selectedPushUps).toBe(50)
  })

  it('rejects an invalid runtime push-up value', () => {
    const result = setPushUpCount(createDefaultState(localDate(DAY)), 15 as PushUpCount)
    expect(result.error).toBeDefined()
    expect(result.state.today.taskStates.pushups.selectedPushUps).toBe(10)
  })

  it.each([
    { xp: -10, level: 1, floor: 0, next: 100, progress: 0 },
    { xp: 0, level: 1, floor: 0, next: 100, progress: 0 },
    { xp: 99, level: 1, floor: 0, next: 100, progress: 0.99 },
    { xp: 100, level: 2, floor: 100, next: 250, progress: 0 },
    { xp: 249, level: 2, floor: 100, next: 250, progress: 149 / 150 },
    { xp: 250, level: 3, floor: 250, next: 500, progress: 0 },
    { xp: 500, level: 4, floor: 500, next: 1000, progress: 0 },
    { xp: 999, level: 4, floor: 500, next: 1000, progress: 499 / 500 },
    { xp: 1000, level: 5, floor: 1000, next: null, progress: 1 },
  ])('resolves the level boundary for $xp XP', ({ xp, level, floor, next, progress }) => {
    const info = getLevel(xp)
    expect(info.level).toBe(level)
    expect(info.floorXp).toBe(floor)
    expect(info.nextXp).toBe(next)
    expect(info.progress).toBeCloseTo(progress)
  })
})

describe('timer calculations and transitions', () => {
  const startedAt = 1_000_000
  const session: TimerSession = {
    id: 'timer:test',
    dayKey: DAY,
    startedAt,
    endsAt: startedAt + 600_000,
    durationSeconds: 600,
    accountedSeconds: 0,
    lastObservedAt: startedAt,
  }

  it('derives elapsed time from wall-clock timestamps', () => {
    expect(getTimerSnapshot(session, startedAt - 5_000)).toEqual({
      elapsedSeconds: 0,
      remainingSeconds: 600,
      finished: false,
    })
    expect(getTimerSnapshot(session, startedAt + 125_999)).toEqual({
      elapsedSeconds: 125,
      remainingSeconds: 475,
      finished: false,
    })
    expect(getTimerSnapshot(session, session.endsAt)).toEqual({
      elapsedSeconds: 600,
      remainingSeconds: 0,
      finished: true,
    })
  })

  it('never refunds checkpointed time after the system clock moves backwards', () => {
    const checkpointed = { ...session, accountedSeconds: 180, lastObservedAt: startedAt + 180_000 }
    expect(getTimerSnapshot(checkpointed, startedAt + 30_000)).toEqual({
      elapsedSeconds: 180,
      remainingSeconds: 420,
      finished: false,
    })
  })

  it('formats countdown values without negative output', () => {
    expect(formatTimer(0)).toBe('00:00')
    expect(formatTimer(-20)).toBe('00:00')
    expect(formatTimer(61)).toBe('01:01')
    expect(formatTimer(61.2)).toBe('01:02')
    expect(formatTimer(3_600)).toBe('60:00')
  })

  it('blocks starting before the minimum, with insufficient time, or beside another timer', () => {
    const locked = createDefaultState(localDate(DAY))
    expect(startTimer(locked, 600, NOW).error).toBeDefined()

    const unlocked = unlockPhone()
    expect(startTimer(unlocked, Number.NaN, NOW).error).toBeDefined()
    expect(startTimer(unlocked, 0, NOW).error).toBeDefined()
    expect(startTimer(unlocked, 60 * 60 + 1, NOW).error).toBeDefined()

    const running = startTimer(unlocked, 600, NOW)
    expect(running.error).toBeUndefined()
    expect(startTimer(running.state, 600, NOW + 1).error).toBeDefined()
  })

  it('checkpoints an active timer and charges only elapsed time on early stop', () => {
    const running = startTimer(unlockPhone(), 600, NOW).state
    const checkpoint = settleTimer(running, NOW + 125_000)

    expect(checkpoint.state.activeTimer?.accountedSeconds).toBe(125)
    expect(checkpoint.state.today.usedSeconds).toBe(0)

    const stopped = settleTimer(checkpoint.state, NOW + 185_000, true)
    expect(stopped.state.activeTimer).toBeNull()
    expect(stopped.state.today.usedSeconds).toBe(185)
    expect(stopped.state.timerNotice).toBeNull()
    expect(getDayMetrics(stopped.state, NOW + 185_000).remainingSeconds).toBe(60 * 60 - 185)
  })

  it('finishes after a reload-compatible timestamp calculation and exposes one notice', () => {
    const running = startTimer(unlockPhone(), 600, NOW).state
    const reloaded = structuredClone(running)
    const finished = settleTimer(reloaded, NOW + 600_000)

    expect(finished.state.activeTimer).toBeNull()
    expect(finished.state.today.usedSeconds).toBe(600)
    expect(finished.state.timerNotice).toEqual({
      sessionId: `timer:${DAY}:${NOW}`,
      finishedAt: NOW + 600_000,
    })

    const acknowledged = acknowledgeTimerNotice(finished.state)
    expect(acknowledged.timerNotice).toBeNull()
    expect(acknowledgeTimerNotice(acknowledged)).toBe(acknowledged)
  })

  it('ends at local midnight and returns the unelapsed selected duration', () => {
    const unlocked = unlockPhone()
    const lateStart = localDate(DAY, 23, 55).getTime()
    const midnight = localDate('2026-07-21', 0).getTime()
    const running = startTimer(unlocked, 600, lateStart)

    expect(running.state.activeTimer?.endsAt).toBe(midnight)
    const finished = settleTimer(running.state, midnight)
    expect(finished.state.today.usedSeconds).toBe(300)
    expect(finished.state.activeTimer).toBeNull()
  })
})

describe('daily rollover and carry-over', () => {
  it('is idempotent for the same or an earlier calendar day', () => {
    const state = createDefaultState(localDate(DAY))
    expect(rolloverTo(state, localDate(DAY, 23, 59))).toBe(state)
    expect(rolloverTo(state, localDate('2026-07-19'))).toBe(state)
  })

  it('archives the previous day, resets daily state, and preserves lifetime XP', () => {
    let state = submitAndApprove(createDefaultState(localDate(DAY)), 'trash', NOW)
    state = structuredClone(state)
    state.today.usedSeconds = 10 * 60

    const rolled = rolloverTo(state, localDate('2026-07-21'))
    expect(rolled.currentDayKey).toBe('2026-07-21')
    expect(rolled.history).toHaveLength(1)
    expect(rolled.history[0]).toMatchObject({
      dayKey: DAY,
      xpEarned: 10,
      minutesEarned: 20,
      minutesUsed: 10,
      carriedOutMinutes: 0,
    })
    expect(Object.values(rolled.today.taskStates).every((task) => task.status === 'todo')).toBe(true)
    expect(getDayRewardTotals(rolled)).toEqual({ xp: 0, minutes: 0 })
    expect(getTotalXp(rolled)).toBe(10)
  })

  it('carries only unused available minutes when enabled', () => {
    let state = submitAndApprove(createDefaultState(localDate(DAY)), 'trash', NOW)
    state = structuredClone(state)
    state.settings.carryOver = true
    state.today.usedSeconds = 5 * 60

    const rolled = rolloverTo(state, localDate('2026-07-21'))
    expect(rolled.history[0].carriedOutMinutes).toBe(15)
    expect(rolled.today.carryInMinutes).toBe(15)
    expect(getDayMetrics(rolled, localDate('2026-07-21').getTime()).remainingSeconds).toBe(15 * 60)
  })

  it('handles a multi-day gap without multiplying or losing carry-over', () => {
    let state = submitAndApprove(createDefaultState(localDate(DAY)), 'trash', NOW)
    state = structuredClone(state)
    state.settings.carryOver = true
    state.today.usedSeconds = 5 * 60

    const rolled = rolloverTo(state, localDate('2026-07-23'))
    expect(rolled.currentDayKey).toBe('2026-07-23')
    expect(rolled.history.map((day) => day.dayKey)).toEqual([
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
    ])
    expect(rolled.history.map((day) => day.carriedOutMinutes)).toEqual([15, 15, 15])
    expect(rolled.today.carryInMinutes).toBe(15)
  })

  it('settles a timer only up to midnight before archiving the old day', () => {
    const unlocked = unlockPhone()
    const lateStart = localDate(DAY, 23, 55).getTime()
    const running = startTimer(unlocked, 600, lateStart).state

    const rolled = rolloverTo(running, localDate('2026-07-21', 12))
    expect(rolled.activeTimer).toBeNull()
    expect(rolled.history[0].minutesUsed).toBe(5)
    expect(rolled.today.usedSeconds).toBe(0)
  })

  it('does not duplicate an archived day on repeated reconciliation', () => {
    const first = rolloverTo(createDefaultState(localDate(DAY)), localDate('2026-07-21'))
    const repeated = rolloverTo(first, localDate('2026-07-21', 18))
    expect(repeated).toBe(first)
    expect(repeated.history.filter((item) => item.dayKey === DAY)).toHaveLength(1)
  })
})

describe('storage decoding, recovery, and persistence', () => {
  it('returns null for missing, malformed, non-object, and future-version payloads', () => {
    expect(decodeStoredState(null, localDate(DAY))).toBeNull()
    expect(decodeStoredState('{not-json', localDate(DAY))).toBeNull()
    expect(decodeStoredState('[]', localDate(DAY))).toBeNull()
    expect(
      decodeStoredState(JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1 }), localDate(DAY)),
    ).toBeNull()
  })

  it('migrates and sanitizes recoverable fields without propagating corrupt values', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      revision: -10,
      currentDayKey: DAY,
      settings: {
        xpToMinutes: 'broken',
        dailyLimitMinutes: 9_999,
        carryOver: true,
        pinHash: 'visible-pin',
      },
      tasks: [
        { id: 'teeth-morning', title: 'Morning', xp: -100, hidden: true },
        { id: 'custom-1', title: '  Custom mission  ', xp: 9_999, hidden: false },
      ],
      today: {
        carryInMinutes: -20,
        usedSeconds: 'broken',
        taskStates: {
          'teeth-morning': { status: 'corrupt', approvalRevision: -1 },
        },
        activity: [{ id: 'bad' }],
      },
      transactions: [
        {
          id: 'award:valid',
          dayKey: DAY,
          type: 'award',
          xpDelta: 5,
          minutesDelta: 10,
          createdAt: NOW,
        },
        {
          id: 'award:valid',
          dayKey: DAY,
          type: 'award',
          xpDelta: 5,
          minutesDelta: 10,
          createdAt: NOW,
        },
        {
          id: 'award:invalid',
          dayKey: 'not-a-date',
          type: 'award',
          xpDelta: 'five',
          minutesDelta: 10,
          createdAt: NOW,
        },
      ],
      activeTimer: {
        id: 'broken-timer',
        dayKey: DAY,
        startedAt: NOW,
        endsAt: NOW - 1,
        durationSeconds: 600,
      },
    })

    const state = decodeStoredState(raw, localDate(DAY))
    expect(state).not.toBeNull()
    expect(state?.schemaVersion).toBe(SCHEMA_VERSION)
    expect(state?.revision).toBe(0)
    expect(state?.settings.xpToMinutes).toBe(2)
    expect(state?.settings.dailyLimitMinutes).toBe(360)
    expect(state?.settings.carryOver).toBe(true)
    expect(state?.today.carryInMinutes).toBe(0)
    expect(state?.today.usedSeconds).toBe(0)
    expect(state?.today.taskStates['teeth-morning'].status).toBe('todo')
    expect(state?.tasks.find((task) => task.id === 'teeth-morning')).toMatchObject({
      required: true,
      hidden: false,
      xp: 1,
    })
    expect(state?.tasks.find((task) => task.id === 'custom-1')).toMatchObject({
      xp: 500,
      required: false,
    })
    expect(state?.transactions).toHaveLength(1)
    expect(state?.activeTimer).toBeNull()
  })

  it('restores a valid active timer and derives progress from real time', () => {
    const running = startTimer(unlockPhone(), 600, NOW).state
    const restored = decodeStoredState(JSON.stringify(running), new Date(NOW + 125_000))
    const activeTimer = restored?.activeTimer

    expect(activeTimer).not.toBeNull()
    if (!activeTimer) throw new Error('Active timer was not restored')
    expect(getTimerSnapshot(activeTimer, NOW + 125_000)).toEqual({
      elapsedSeconds: 125,
      remainingSeconds: 475,
      finished: false,
    })
  })

  it('restores a valid backup when primary storage is corrupt', () => {
    const backup = createDefaultState(localDate(DAY))
    backup.onboardingSeen = true
    localStorage.setItem(STORAGE_KEY, '{corrupt')
    localStorage.setItem(STORAGE_BACKUP_KEY, JSON.stringify(backup))

    const loaded = loadAppState(localDate(DAY))
    expect(loaded.recovered).toBe(true)
    expect(loaded.state.onboardingSeen).toBe(true)
    expect(loaded.state.currentDayKey).toBe(DAY)
  })

  it('uses safe defaults and reports recovery when all persisted data is corrupt', () => {
    localStorage.setItem(STORAGE_KEY, '{corrupt')
    localStorage.setItem(STORAGE_BACKUP_KEY, '[]')

    const loaded = loadAppState(localDate(DAY))
    expect(loaded.recovered).toBe(true)
    expect(loaded.state.schemaVersion).toBe(SCHEMA_VERSION)
    expect(loaded.state.currentDayKey).toBe(DAY)
    expect(loaded.state.tasks).toHaveLength(10)
  })

  it('does not report recovery for a clean first launch', () => {
    const loaded = loadAppState(localDate(DAY))
    expect(loaded.recovered).toBe(false)
    expect(loaded.state.currentDayKey).toBe(DAY)
  })

  it('backs up the previous valid snapshot before saving a new state', () => {
    const previous = createDefaultState(localDate(DAY))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(previous))
    const next = structuredClone(previous)
    next.revision = 7
    next.onboardingSeen = true

    saveAppState(next)

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({
      revision: 7,
      onboardingSeen: true,
    })
    expect(JSON.parse(localStorage.getItem(STORAGE_BACKUP_KEY) ?? '{}')).toMatchObject({
      revision: 0,
      onboardingSeen: false,
    })
  })

  it('keeps the in-memory app usable when storage rejects writes', () => {
    const rejectingStorage = new MemoryStorage()
    rejectingStorage.setItem = () => {
      throw new Error('quota exceeded')
    }
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: rejectingStorage,
      writable: true,
    })

    expect(() => saveAppState(createDefaultState(localDate(DAY)))).not.toThrow()
  })
})
