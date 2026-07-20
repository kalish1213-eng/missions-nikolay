export function dayKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function dateFromDayKey(key: string): Date {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function nextDayKey(key: string): string {
  const date = dateFromDayKey(key)
  date.setDate(date.getDate() + 1)
  return dayKey(date)
}

export function previousDayKey(key: string): string {
  const date = dateFromDayKey(key)
  date.setDate(date.getDate() - 1)
  return dayKey(date)
}

export function isValidDayKey(key: unknown): key is string {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const parsed = dateFromDayKey(key)
  return Number.isFinite(parsed.getTime()) && dayKey(parsed) === key
}

export function endOfDayMs(key: string): number {
  const next = dateFromDayKey(nextDayKey(key))
  return next.getTime()
}

export function formatLongDate(key: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(dateFromDayKey(key))
}

export function formatShortDate(key: string): string {
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' }).format(dateFromDayKey(key))
}

export function lastDayKeys(count: number, from = new Date()): string[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(from)
    date.setHours(12, 0, 0, 0)
    date.setDate(date.getDate() - (count - index - 1))
    return dayKey(date)
  })
}
