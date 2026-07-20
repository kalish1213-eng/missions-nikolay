import type { AppState, DailyProgress, Task } from '../types'
import { dayKey } from '../lib/date'

export const SCHEMA_VERSION = 3
export const STORAGE_KEY = 'missions-nikolay:state:v2'
export const STORAGE_BACKUP_KEY = 'missions-nikolay:backup:v2'
export const DEFAULT_PIN_SALT = 'missions-nikolay::'
export const DEFAULT_PIN_HASH = '51944a923dd11528f8923e3595727a2295932a5c3fbd10e2baae2ef6aa00e1cc'

export const REQUIRED_TASK_IDS = ['teeth-morning', 'make-bed', 'homework'] as const

export const DEFAULT_TASKS: Task[] = [
  { id: 'teeth-morning', title: 'Почистить зубы утром', icon: '☀️', xp: 5, required: true, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'teeth-evening', title: 'Почистить зубы вечером', icon: '🌙', xp: 5, required: false, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'make-bed', title: 'Заправить кровать', icon: '🛏️', xp: 5, required: true, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'homework', title: 'Сделать школьную домашнюю работу', icon: '📘', xp: 20, required: true, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'trash', title: 'Вынести мусор', icon: '♻️', xp: 10, required: false, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'reading', title: 'Почитать книгу 20 минут', icon: '📚', xp: 15, required: false, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'clean-room', title: 'Убрать комнату', icon: '✨', xp: 15, required: false, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'backpack', title: 'Собрать школьный рюкзак', icon: '🎒', xp: 10, required: false, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'good-deed', title: 'Сделать доброе дело без просьбы', icon: '💛', xp: 20, required: false, builtIn: true, kind: 'standard', hidden: false, createdAt: 0 },
  { id: 'pushups', title: 'Отжимания', icon: '💪', xp: 5, required: false, builtIn: true, kind: 'pushups', hidden: false, createdAt: 0 },
]

export function createDailyProgress(tasks: Task[], key: string, carryInMinutes = 0): DailyProgress {
  return {
    dayKey: key,
    carryInMinutes,
    usedSeconds: 0,
    taskStates: Object.fromEntries(
      tasks.map((task) => [
        task.id,
        {
          taskId: task.id,
          status: 'todo' as const,
          approvalRevision: 0,
          ...(task.kind === 'pushups' ? { selectedPushUps: 10 as const } : {}),
        },
      ]),
    ),
    activity: [],
  }
}

export function createDefaultState(now = new Date()): AppState {
  const key = dayKey(now)
  const tasks = DEFAULT_TASKS.map((task) => ({ ...task }))
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    currentDayKey: key,
    settings: {
      xpToMinutes: 2,
      dailyLimitMinutes: 90,
      carryOver: false,
      theme: 'system',
      pinHash: DEFAULT_PIN_HASH,
      pinSalt: DEFAULT_PIN_SALT,
      hasChangedPin: false,
    },
    tasks,
    today: createDailyProgress(tasks, key),
    history: [],
    transactions: [],
    activeTimer: null,
    timerNotice: null,
    onboardingSeen: false,
  }
}
