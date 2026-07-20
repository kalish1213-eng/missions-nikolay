import { formatLongDate } from '../lib/date'
import { getDayMetrics, getLevel, getMinimumProgress, getRemainingRequiredTasks, getTotalXp } from '../lib/domain'
import type { AppState, PushUpCount } from '../types'
import { Icon } from '../components/Icon'
import { ProgressBar } from '../components/ProgressBar'
import { TaskCard } from '../components/TaskCard'

export function TodayScreen({ state, now, onSubmit, onPushUps, onOpenTimer }: {
  state: AppState
  now: number
  onSubmit: (taskId: string) => void
  onPushUps: (count: PushUpCount) => void
  onOpenTimer: () => void
}) {
  const metrics = getDayMetrics(state, now)
  const minimum = getMinimumProgress(state)
  const level = getLevel(getTotalXp(state))
  const requiredTasks = state.tasks.filter((task) => task.required && !task.hidden)
  const regularTasks = state.tasks.filter((task) => !task.required && task.kind !== 'pushups' && !task.hidden)
  const pushups = state.tasks.find((task) => task.kind === 'pushups' && !task.hidden)
  const remainingRequired = getRemainingRequiredTasks(state)
  const remainingMinutes = Math.floor(metrics.remainingSeconds / 60)
  const usedMinutes = Math.ceil(metrics.usedSeconds / 60)
  const budgetMinutes = Math.floor(metrics.budgetSeconds / 60)
  const limitReached = state.today.carryInMinutes + metrics.rawEarnedMinutes >= state.settings.dailyLimitMinutes
  const remainingLabel = metrics.remainingSeconds > 0 && metrics.remainingSeconds < 60 ? '<1 мин' : `${remainingMinutes} мин`

  return (
    <main className="screen todayScreen" id="main-content">
      <header className="hero">
        <div className="hero__copy">
          <span className="eyebrow">Экспедиция на сегодня</span>
          <h1>Привет, Николай!</h1>
          <p className="hero__date">{formatLongDate(state.currentDayKey)}</p>
          <span className="levelPill"><Icon name="sparkle" /> Ур. {level.level} · {level.name}</span>
        </div>
        <div className="avatar" aria-label="Аватар героя Николая">
          <span className="avatar__orbit" />
          <span className="avatar__face">Н</span>
          <span className="avatar__bolt"><Icon name="bolt" /></span>
        </div>
      </header>

      <section className="energyCard" aria-labelledby="energy-title">
        <div className="energyCard__top">
          <div>
            <span className="eyebrow" id="energy-title">Запас энергии</span>
            <div className="energyCard__value"><strong>{remainingMinutes}</strong><span>мин</span></div>
            <p>осталось на сегодня</p>
          </div>
          <div className="energyCore" aria-hidden="true"><Icon name="bolt" /></div>
        </div>
        <ProgressBar value={metrics.budgetSeconds ? metrics.remainingSeconds / metrics.budgetSeconds : 0} label="Оставшееся экранное время" tone="lime" />
        <div className="metricRow">
          <div><span>XP сегодня</span><strong>{metrics.xpEarned}</strong></div>
          <div><span>По XP</span><strong>{metrics.rawEarnedMinutes} мин</strong></div>
          <div><span>Доступно сегодня</span><strong>{budgetMinutes} мин</strong></div>
          <div><span>Использовано</span><strong>{usedMinutes} мин</strong></div>
        </div>
        {limitReached && <p className="limitNotice" role="status">Дневной лимит телефона достигнут. XP продолжают копиться для нового уровня. Минуты сверх лимита сегодня использовать нельзя.</p>}
      </section>

      <section className={`minimumCard ${minimum.met ? 'minimumCard--done' : ''}`}>
        <div className="minimumCard__icon"><Icon name={minimum.met ? 'check' : 'shield'} /></div>
        <div className="minimumCard__copy">
          <div className="sectionTitleRow">
            <div><span className="eyebrow">Обязательный минимум</span><h2>{minimum.done} из {minimum.total} миссий</h2></div>
            <span className="minimumCard__count">{minimum.done}/{minimum.total}</span>
          </div>
          <ProgressBar value={minimum.total ? minimum.done / minimum.total : 0} label="Обязательные миссии" tone={minimum.met ? 'lime' : 'orange'} />
          {minimum.met ? (
            <p>Доступ к таймеру открыт. Отличная работа!</p>
          ) : (
            <div className="minimumCard__remaining">
              <strong>Осталось:</strong>
              <ul>
                {remainingRequired.map((task) => (
                  <li key={task.id}>{task.title} <span>— {state.today.taskStates[task.id]?.status === 'pending' ? 'ждёт родителя' : 'нужно выполнить'}</span></li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </section>

      <button
        type="button"
        className="button button--primary button--phone"
        onClick={onOpenTimer}
        disabled={!minimum.met || metrics.remainingSeconds <= 0}
      >
        <Icon name={minimum.met ? 'timer' : 'lock'} />
        <span>{minimum.met ? metrics.remainingSeconds > 0 ? 'Начать время с телефоном' : 'Запас на сегодня использован' : 'Таймер пока закрыт'}</span>
        {minimum.met && metrics.remainingSeconds > 0 && <strong>{remainingLabel}</strong>}
      </button>
      <p className="timerTrustNote"><Icon name="clock" />Приложение считает время, но не блокирует телефон автоматически.</p>

      <section className="missionSection" aria-labelledby="main-missions">
        <div className="sectionHeading"><div><span className="eyebrow">Сначала главное</span><h2 id="main-missions">Ключевые миссии</h2></div><span>🛡️</span></div>
        <div className="taskList">
          {requiredTasks.map((task) => <TaskCard key={task.id} task={task} daily={state.today.taskStates[task.id]} onSubmit={() => onSubmit(task.id)} />)}
        </div>
      </section>

      <section className="missionSection" aria-labelledby="bonus-missions">
        <div className="sectionHeading"><div><span className="eyebrow">Дополнительный заряд</span><h2 id="bonus-missions">Бонусные миссии</h2></div><span>⚡</span></div>
        <div className="taskList">
          {regularTasks.map((task) => <TaskCard key={task.id} task={task} daily={state.today.taskStates[task.id]} onSubmit={() => onSubmit(task.id)} />)}
        </div>
      </section>

      {pushups && (
        <section className="missionSection" aria-labelledby="strength-mission">
          <div className="sectionHeading"><div><span className="eyebrow">Одно испытание</span><h2 id="strength-mission">Сила героя</h2></div><span>💪</span></div>
          <TaskCard task={pushups} daily={state.today.taskStates[pushups.id]} onSubmit={() => onSubmit(pushups.id)} onPushUps={onPushUps} />
        </section>
      )}
    </main>
  )
}
