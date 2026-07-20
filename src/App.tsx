import { useEffect, useState } from 'react'
import { Icon, type IconName } from './components/Icon'
import { Modal } from './components/Modal'
import { TimerFinishedModal } from './components/TimerFinishedModal'
import { useMissionApp } from './hooks/useMissionApp'
import { dismissPwaUpdate, subscribePwaUpdate, type PwaUpdateAction } from './lib/pwaUpdate'
import { ParentScreen } from './screens/ParentScreen'
import { ProgressScreen } from './screens/ProgressScreen'
import { TimerScreen } from './screens/TimerScreen'
import { TodayScreen } from './screens/TodayScreen'

type Tab = 'today' | 'timer' | 'progress' | 'parent'
const PARENT_IDLE_MS = 5 * 60 * 1000

const navigation: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'today', label: 'Сегодня', icon: 'today' },
  { id: 'timer', label: 'Таймер', icon: 'timer' },
  { id: 'progress', label: 'Прогресс', icon: 'progress' },
  { id: 'parent', label: 'Родителю', icon: 'parent' },
]

export default function App() {
  const { state, feedback, clearFeedback, actions } = useMissionApp()
  const [tab, setTab] = useState<Tab>('today')
  const [now, setNow] = useState(Date.now())
  const [parentUnlocked, setParentUnlocked] = useState(false)
  const [pwaUpdateAction, setPwaUpdateAction] = useState<PwaUpdateAction | null>(null)

  useEffect(() => subscribePwaUpdate((action) => setPwaUpdateAction(() => action)), [])

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), state.activeTimer ? 250 : 15_000)
    return () => window.clearInterval(interval)
  }, [state.activeTimer])

  useEffect(() => {
    const lockOnBackground = () => {
      if (document.visibilityState === 'hidden') setParentUnlocked(false)
    }
    document.addEventListener('visibilitychange', lockOnBackground)
    window.addEventListener('pagehide', lockOnBackground)
    return () => {
      document.removeEventListener('visibilitychange', lockOnBackground)
      window.removeEventListener('pagehide', lockOnBackground)
    }
  }, [])

  useEffect(() => {
    if (!parentUnlocked) return
    let timeout = 0
    const armLock = () => {
      window.clearTimeout(timeout)
      timeout = window.setTimeout(() => setParentUnlocked(false), PARENT_IDLE_MS)
    }
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    events.forEach((eventName) => window.addEventListener(eventName, armLock, { passive: true }))
    armLock()
    return () => {
      window.clearTimeout(timeout)
      events.forEach((eventName) => window.removeEventListener(eventName, armLock))
    }
  }, [parentUnlocked])

  useEffect(() => {
    const preference = state.settings.theme
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      document.documentElement.dataset.theme = preference === 'system' ? media.matches ? 'dark' : 'light' : preference
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [state.settings.theme])

  const changeTab = (next: Tab) => {
    if (next !== 'parent') setParentUnlocked(false)
    setTab(next)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
  }

  return (
    <div className="appShell">
      <a className="skipLink" href="#main-content">К основному содержимому</a>
      {pwaUpdateAction && (
        <aside className="updatePrompt" role="status" aria-live="polite">
          <div className="updatePrompt__copy">
            <strong>Доступно обновление</strong>
            <span>Установите новую версию, когда будете готовы.</span>
          </div>
          <div className="updatePrompt__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                const applyUpdate = pwaUpdateAction
                dismissPwaUpdate()
                setPwaUpdateAction(null)
                applyUpdate()
              }}
            >
              Обновить
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                dismissPwaUpdate()
                setPwaUpdateAction(null)
              }}
            >
              Позже
            </button>
          </div>
        </aside>
      )}
      {tab === 'today' && <TodayScreen state={state} now={now} onSubmit={actions.submitTask} onPushUps={actions.setPushUps} onOpenTimer={() => changeTab('timer')} />}
      {tab === 'timer' && <TimerScreen state={state} now={now} onStart={actions.startTimer} onStop={actions.stopTimer} onGoToday={() => changeTab('today')} />}
      {tab === 'progress' && <ProgressScreen state={state} now={now} />}
      {tab === 'parent' && <ParentScreen state={state} unlocked={parentUnlocked} onUnlock={() => setParentUnlocked(true)} onLock={() => setParentUnlocked(false)} actions={actions} />}

      <nav className="bottomNav" aria-label="Основная навигация">
        {navigation.map((item) => (
          <button
            type="button"
            key={item.id}
            className={tab === item.id ? 'is-active' : ''}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => changeTab(item.id)}
          >
            <span className="bottomNav__icon"><Icon name={item.icon} />{item.id === 'timer' && state.activeTimer && <i aria-label="Таймер активен" />}</span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {feedback && (
        <div className={`toast toast--${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'} aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'} onClick={clearFeedback}>
          <span>{feedback.kind === 'success' ? '✦' : feedback.kind === 'error' ? '!' : 'i'}</span>
          <p>{feedback.message}</p>
          <button type="button" aria-label="Закрыть сообщение" onClick={clearFeedback}>×</button>
        </div>
      )}

      {!state.onboardingSeen && (
        <Modal title="Добро пожаловать в миссии!">
          <div className="onboardingArt"><span>Н</span><Icon name="bolt" /></div>
          <p>Николай отмечает выполненные задания, а родитель подтверждает их и выдаёт экранное время.</p>
          <div className="onboardingPin"><Icon name="shield" /><div><span>Стартовый PIN родителя</span><strong>1213</strong><small>После первого входа замените его в настройках</small></div></div>
          <div className="modalActions modalActions--stacked">
            <button type="button" className="button button--primary" onClick={() => { actions.markOnboardingSeen(); changeTab('parent') }}>Настроить родительский режим</button>
            <button type="button" className="button button--secondary" onClick={actions.markOnboardingSeen}>Начать позже</button>
          </div>
        </Modal>
      )}

      {state.timerNotice && <TimerFinishedModal onClose={actions.acknowledgeTimer} />}
    </div>
  )
}
