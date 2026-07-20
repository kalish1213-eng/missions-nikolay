import { formatShortDate, lastDayKeys } from '../lib/date'
import { getDayMetrics, getLevel, getMinimumProgress, getStreak, getTotalXp } from '../lib/domain'
import type { AppState, HistoryDay } from '../types'
import { Icon } from '../components/Icon'
import { ProgressBar } from '../components/ProgressBar'

export function ProgressScreen({ state, now }: { state: AppState; now: number }) {
  const totalXp = getTotalXp(state)
  const level = getLevel(totalXp)
  const todayMetrics = getDayMetrics(state, now)
  const today: HistoryDay = {
    dayKey: state.currentDayKey,
    xpEarned: todayMetrics.xpEarned,
    minutesEarned: todayMetrics.rawEarnedMinutes,
    minutesUsed: Math.ceil(todayMetrics.usedSeconds / 60),
    completedTasks: Object.values(state.today.taskStates).filter((task) => task.status === 'approved').length,
    pushUps: state.today.taskStates.pushups?.status === 'approved' ? state.today.taskStates.pushups.selectedPushUps ?? 0 : 0,
    minimumMet: getMinimumProgress(state).met,
    carriedOutMinutes: 0,
  }
  const allDays = [...state.history.filter((day) => day.dayKey !== state.currentDayKey), today]
  const byKey = new Map(allDays.map((day) => [day.dayKey, day]))
  const lastSeven = lastDayKeys(7).map((key) => byKey.get(key) ?? { dayKey: key, xpEarned: 0, minutesEarned: 0, minutesUsed: 0, completedTasks: 0, pushUps: 0, minimumMet: false, carriedOutMinutes: 0 })
  const maxXp = Math.max(20, ...lastSeven.map((day) => day.xpEarned))
  const totals = allDays.reduce((sum, day) => ({
    minutesEarned: sum.minutesEarned + day.minutesEarned,
    minutesUsed: sum.minutesUsed + day.minutesUsed,
    tasks: sum.tasks + day.completedTasks,
    pushUps: sum.pushUps + day.pushUps,
  }), { minutesEarned: 0, minutesUsed: 0, tasks: 0, pushUps: 0 })
  const bestPushUps = Math.max(0, ...allDays.map((day) => day.pushUps))
  const recentHistory = [...allDays].sort((a, b) => b.dayKey.localeCompare(a.dayKey)).slice(0, 30)

  return (
    <main className="screen progressScreen" id="main-content">
      <header className="simpleHeader"><span className="eyebrow">Карта достижений</span><h1>Прогресс героя</h1><p>Каждая подтверждённая миссия усиливает твой уровень.</p></header>

      <section className="levelCard">
        <div className="levelCard__badge"><Icon name="sparkle" /><strong>{level.level}</strong></div>
        <div className="levelCard__copy">
          <span className="eyebrow">Текущий уровень</span><h2>{level.name}</h2>
          <div className="levelCard__numbers"><strong>{totalXp} XP</strong><span>{level.nextXp ? `ещё ${level.nextXp - totalXp} XP` : 'максимальный ранг'}</span></div>
          <ProgressBar value={level.progress} label="Прогресс уровня" />
        </div>
      </section>

      <section className="chartCard" aria-labelledby="chart-title">
        <div className="sectionTitleRow"><div><span className="eyebrow">Последние 7 дней</span><h2 id="chart-title">XP по дням</h2></div><span className="chartCard__total">{lastSeven.reduce((sum, day) => sum + day.xpEarned, 0)} XP</span></div>
        <div className="barChart" role="img" aria-label={lastSeven.map((day) => `${formatShortDate(day.dayKey)}: ${day.xpEarned} XP`).join('; ')}>
          {lastSeven.map((day) => (
            <div className="barChart__item" key={day.dayKey}>
              <span className="barChart__value">{day.xpEarned}</span>
              <div className="barChart__track"><span style={{ height: `${Math.max(day.xpEarned ? 10 : 3, day.xpEarned / maxXp * 100)}%` }} /></div>
              <span className="barChart__label">{formatShortDate(day.dayKey)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="statGrid" aria-label="Общая статистика">
        <article><span className="statGrid__icon statGrid__icon--lime"><Icon name="bolt" /></span><strong>{totals.minutesEarned}</strong><p>мин заработано</p></article>
        <article><span className="statGrid__icon statGrid__icon--violet"><Icon name="clock" /></span><strong>{totals.minutesUsed}</strong><p>мин использовано</p></article>
        <article><span className="statGrid__icon statGrid__icon--orange">✓</span><strong>{totals.tasks}</strong><p>миссий готово</p></article>
        <article><span className="statGrid__icon statGrid__icon--pink">🔥</span><strong>{getStreak(state)}</strong><p>дней серия</p></article>
        <article><span className="statGrid__icon statGrid__icon--blue">💪</span><strong>{totals.pushUps}</strong><p>всего отжиманий</p></article>
        <article><span className="statGrid__icon statGrid__icon--gold">🏆</span><strong>{bestPushUps}</strong><p>лучший результат</p></article>
      </section>

      <section className="historySection">
        <div className="sectionHeading"><div><span className="eyebrow">Дневник экспедиции</span><h2>История по дням</h2></div></div>
        <div className="historyList">
          {recentHistory.map((day) => (
            <article className="historyDay" key={day.dayKey}>
              <div className={`historyDay__mark ${day.minimumMet ? 'is-complete' : ''}`}>{day.minimumMet ? '✓' : '·'}</div>
              <div><strong>{day.dayKey === state.currentDayKey ? 'Сегодня' : formatShortDate(day.dayKey)}</strong><span>{day.completedTasks} миссий · {day.pushUps} отжиманий</span></div>
              <div><strong>+{day.xpEarned} XP</strong><span>{day.minutesUsed}/{day.minutesEarned} мин</span></div>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}
