import type { TimerSession } from '../types'

export interface TimerSnapshot {
  elapsedSeconds: number
  remainingSeconds: number
  finished: boolean
}

export function getTimerSnapshot(session: TimerSession, now: number): TimerSnapshot {
  const wallElapsed = Math.floor((Math.min(now, session.endsAt) - session.startedAt) / 1000)
  const safeElapsed = Math.min(session.durationSeconds, Math.max(session.accountedSeconds, wallElapsed, 0))
  return {
    elapsedSeconds: safeElapsed,
    remainingSeconds: Math.max(0, session.durationSeconds - safeElapsed),
    finished: safeElapsed >= session.durationSeconds || now >= session.endsAt,
  }
}

export function formatTimer(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}
