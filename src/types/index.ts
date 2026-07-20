export type TaskStatus = 'todo' | 'pending' | 'approved' | 'rejected'
export type PushUpCount = 10 | 20 | 30 | 40 | 50
export type ThemePreference = 'system' | 'light' | 'dark'

export interface Task {
  id: string
  title: string
  icon: string
  xp: number
  required: boolean
  builtIn: boolean
  kind: 'standard' | 'pushups' | 'custom'
  hidden: boolean
  createdAt: number
}

export interface DailyTaskState {
  taskId: string
  status: TaskStatus
  selectedPushUps?: PushUpCount
  submittedXp?: number
  submittedAt?: number
  resolvedAt?: number
  approvalRevision: number
  activeAwardId?: string
}

export interface UserSettings {
  xpToMinutes: number
  dailyLimitMinutes: number
  carryOver: boolean
  theme: ThemePreference
  pinHash: string
  pinSalt: string
  hasChangedPin: boolean
}

export interface TimerSession {
  id: string
  dayKey: string
  startedAt: number
  endsAt: number
  durationSeconds: number
  accountedSeconds: number
  lastObservedAt: number
}

export interface RewardTransaction {
  id: string
  dayKey: string
  type: 'award' | 'reversal' | 'manual' | 'reset'
  xpDelta: number
  minutesDelta: number
  createdAt: number
  taskId?: string
  reason?: string
  reversesTransactionId?: string
}

export interface ActivityEvent {
  id: string
  type: 'submitted' | 'approved' | 'rejected' | 'reversed' | 'manual' | 'timer' | 'reset' | 'settings'
  message: string
  createdAt: number
}

export interface DailyProgress {
  dayKey: string
  carryInMinutes: number
  usedSeconds: number
  taskStates: Record<string, DailyTaskState>
  activity: ActivityEvent[]
}

export interface HistoryDay {
  dayKey: string
  xpEarned: number
  minutesEarned: number
  minutesUsed: number
  completedTasks: number
  pushUps: number
  minimumMet: boolean
  carriedOutMinutes: number
}

export interface TimerNotice {
  sessionId: string
  finishedAt: number
}

export interface AppState {
  schemaVersion: number
  revision: number
  currentDayKey: string
  settings: UserSettings
  tasks: Task[]
  today: DailyProgress
  history: HistoryDay[]
  transactions: RewardTransaction[]
  activeTimer: TimerSession | null
  timerNotice: TimerNotice | null
  onboardingSeen: boolean
}

export interface DayMetrics {
  xpEarned: number
  rawEarnedMinutes: number
  budgetSeconds: number
  usedSeconds: number
  remainingSeconds: number
}

export interface LevelInfo {
  name: string
  level: number
  floorXp: number
  nextXp: number | null
  progress: number
}

export interface TransitionResult {
  state: AppState
  error?: string
  reward?: { xp: number; minutes: number }
}
