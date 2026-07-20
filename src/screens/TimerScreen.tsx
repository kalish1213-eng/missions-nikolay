import { useEffect, useState, type CSSProperties } from 'react'
import { getDayMetrics, getMinimumProgress, getRemainingRequiredTasks } from '../lib/domain'
import { formatTimer, getTimerSnapshot } from '../lib/timer'
import type { AppState } from '../types'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'

export function TimerScreen({ state, now, onStart, onStop, onGoToday }: {
  state: AppState
  now: number
  onStart: (seconds: number) => void
  onStop: () => void
  onGoToday: () => void
}) {
  const metrics = getDayMetrics(state, now)
  const minimum = getMinimumProgress(state)
  const remainingRequired = getRemainingRequiredTasks(state)
  const maxSeconds = metrics.remainingSeconds
  const [selectedSeconds, setSelectedSeconds] = useState(() => Math.min(10 * 60, maxSeconds))
  const [confirmStop, setConfirmStop] = useState(false)

  useEffect(() => {
    if (!state.activeTimer && (selectedSeconds <= 0 || selectedSeconds > maxSeconds)) {
      setSelectedSeconds(Math.min(10 * 60, maxSeconds))
    }
  }, [maxSeconds, selectedSeconds, state.activeTimer])

  if (state.activeTimer) {
    const snapshot = getTimerSnapshot(state.activeTimer, now)
    const progress = state.activeTimer.durationSeconds ? snapshot.remainingSeconds / state.activeTimer.durationSeconds : 0
    return (
      <main className="screen timerScreen timerScreen--active" id="main-content">
        <header className="simpleHeader"><span className="eyebrow">Телефонное время</span><h1>Таймер запущен</h1><p>Приложение считает время и подаст сигнал в конце.</p></header>
        <section className="timerActiveCard">
          <div className="timerOrb" role="timer" aria-live="off" aria-label={`Осталось ${formatTimer(snapshot.remainingSeconds)}`} style={{ '--timer-progress': `${progress * 360}deg` } as CSSProperties}>
            <div className="timerOrb__inside">
              <Icon name="bolt" />
              <strong>{formatTimer(snapshot.remainingSeconds)}</strong>
              <span>осталось</span>
            </div>
          </div>
          <div className="timerFacts">
            <div><span>Выбрано</span><strong>{Math.ceil(state.activeTimer.durationSeconds / 60)} мин</strong></div>
            <div><span>Прошло</span><strong>{formatTimer(snapshot.elapsedSeconds)}</strong></div>
          </div>
          <p className="infoNote"><Icon name="clock" />Можно закрыть вкладку: при возвращении остаток пересчитается по реальному времени.</p>
          <p className="timerDisclaimer">Приложение считает время, но не блокирует телефон автоматически.</p>
          <button type="button" className="button button--dangerGhost" onClick={() => setConfirmStop(true)}>Остановить раньше</button>
        </section>
        {confirmStop && (
          <Modal title="Остановить таймер?" onClose={() => setConfirmStop(false)}>
            <p>Спишется только уже прошедшее время. Неиспользованный остаток вернётся в запас.</p>
            <div className="modalActions">
              <button type="button" className="button button--secondary" onClick={() => setConfirmStop(false)}>Продолжить</button>
              <button type="button" className="button button--danger" onClick={() => { onStop(); setConfirmStop(false) }}>Остановить</button>
            </div>
          </Modal>
        )}
      </main>
    )
  }

  if (!minimum.met) {
    return (
      <main className="screen timerScreen" id="main-content">
        <header className="simpleHeader"><span className="eyebrow">Телефонное время</span><h1>Таймер</h1><p>Заработанное время появится здесь.</p></header>
        <section className="lockedCard">
          <div className="lockedCard__icon"><Icon name="lock" /></div>
          <span className="eyebrow">Доступ закрыт</span>
          <h2>Сначала выполни обязательные миссии</h2>
          <p>Подтверждено {minimum.done} из {minimum.total}. Таймер откроется после решения родителя по всем ключевым миссиям.</p>
          <ul className="lockedCard__remaining">
            {remainingRequired.map((task) => <li key={task.id}>{task.title} <span>— {state.today.taskStates[task.id]?.status === 'pending' ? 'ждёт родителя' : 'нужно выполнить'}</span></li>)}
          </ul>
          <button type="button" className="button button--primary" onClick={onGoToday}>Посмотреть миссии</button>
        </section>
      </main>
    )
  }

  const presets = [10, 15, 20, 30]
  const allMinutes = Math.max(0, Math.floor(maxSeconds / 60))
  const allDisplay = maxSeconds > 0 && maxSeconds < 60 ? formatTimer(maxSeconds) : `${allMinutes} мин`
  return (
    <main className="screen timerScreen" id="main-content">
      <header className="simpleHeader"><span className="eyebrow">Телефонное время</span><h1>Выбери время</h1><p>Потрать часть запаса сейчас или возьми весь остаток.</p></header>
      <section className="timerBalance">
        <div className="timerBalance__icon"><Icon name="bolt" /></div>
        <div><span>Доступно сегодня</span><strong>{maxSeconds > 0 && maxSeconds < 60 ? allDisplay : allMinutes} {maxSeconds >= 60 && <small>мин</small>}</strong></div>
      </section>

      {maxSeconds <= 0 ? (
        <section className="emptyCard"><span>⏳</span><h2>Запас закончился</h2><p>Новые подтверждённые миссии добавят время в пределах дневного лимита.</p></section>
      ) : (
        <section className="timerPicker" aria-labelledby="timer-duration-title">
          <h2 id="timer-duration-title">Сколько минут?</h2>
          <div className="timeOptions">
            {presets.map((minutes) => (
              <button
                type="button"
                key={minutes}
                disabled={minutes * 60 > maxSeconds}
                className={selectedSeconds === minutes * 60 ? 'is-selected' : ''}
                aria-pressed={selectedSeconds === minutes * 60}
                onClick={() => setSelectedSeconds(minutes * 60)}
              >
                <strong>{minutes}</strong><span>мин</span>
              </button>
            ))}
            <button
              type="button"
              className={`timeOptions__all ${selectedSeconds === maxSeconds ? 'is-selected' : ''}`}
              aria-pressed={selectedSeconds === maxSeconds}
              onClick={() => setSelectedSeconds(maxSeconds)}
            >
              <Icon name="sparkle" /><span>Весь остаток</span><strong>{allDisplay}</strong>
            </button>
          </div>
          <button type="button" className="button button--primary button--start" disabled={selectedSeconds < 1 || selectedSeconds > maxSeconds} onClick={() => onStart(selectedSeconds)}>
            <Icon name="timer" /> {selectedSeconds === maxSeconds ? 'Запустить весь остаток' : `Запустить на ${Math.max(1, Math.floor(selectedSeconds / 60))} мин`}
          </button>
          <p className="timerDisclaimer">Приложение считает время, но не блокирует телефон автоматически.</p>
        </section>
      )}
    </main>
  )
}
