import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChildInviteClaim } from './auth/ChildInviteClaim'
import { ParentCloudAuth } from './auth/ParentCloudAuth'
import { useCloudSession } from './auth/useCloudSession'
import { CloudFamilyControls } from './components/CloudFamilyControls'
import { CloudPinRecovery } from './components/CloudPinRecovery'
import { CloudSyncStatus } from './components/CloudSyncStatus'
import { Icon, type IconName } from './components/Icon'
import { Modal } from './components/Modal'
import { TimerFinishedModal } from './components/TimerFinishedModal'
import { signOutCloud } from './cloud/api'
import { parseHashRoute, type CloudRoute } from './cloud/routes'
import { useCloudMissionApp } from './cloud/useCloudMissionApp'
import { useCloudSync } from './cloud/useCloudSync'
import { useMissionApp, type Feedback } from './hooks/useMissionApp'
import { dismissPwaUpdate, subscribePwaUpdate, type PwaUpdateAction } from './lib/pwaUpdate'
import { ParentScreen } from './screens/ParentScreen'
import { ProgressScreen } from './screens/ProgressScreen'
import { TimerScreen } from './screens/TimerScreen'
import { TodayScreen } from './screens/TodayScreen'
import type { AppState, ThemePreference } from './types'

type LocalTab = 'today' | 'timer' | 'progress' | 'parent'
type ChildTab = Exclude<LocalTab, 'parent'>
const PARENT_IDLE_MS = 5 * 60 * 1000

const localNavigation: { id: LocalTab; label: string; icon: IconName }[] = [
  { id: 'today', label: 'Сегодня', icon: 'today' },
  { id: 'timer', label: 'Таймер', icon: 'timer' },
  { id: 'progress', label: 'Прогресс', icon: 'progress' },
  { id: 'parent', label: 'Родителю', icon: 'parent' },
]

const childNavigation = localNavigation.filter((item): item is typeof item & { id: ChildTab } => item.id !== 'parent')

function useHashRoute(): CloudRoute {
  const [route, setRoute] = useState(() => parseHashRoute())
  useEffect(() => {
    const update = () => setRoute(parseHashRoute())
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  return route
}

function useNow(activeTimer: AppState['activeTimer']): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), activeTimer ? 250 : 15_000)
    return () => window.clearInterval(interval)
  }, [activeTimer])
  return now
}

function useTheme(preference: ThemePreference): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      document.documentElement.dataset.theme = preference === 'system' ? media.matches ? 'dark' : 'light' : preference
    }
    applyTheme()
    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [preference])
}

function useParentSessionLock(unlocked: boolean, setUnlocked: (value: boolean) => void): void {
  useEffect(() => {
    const lockOnBackground = () => {
      if (document.visibilityState === 'hidden') setUnlocked(false)
    }
    document.addEventListener('visibilitychange', lockOnBackground)
    window.addEventListener('pagehide', lockOnBackground)
    return () => {
      document.removeEventListener('visibilitychange', lockOnBackground)
      window.removeEventListener('pagehide', lockOnBackground)
    }
  }, [setUnlocked])

  useEffect(() => {
    if (!unlocked) return
    let timeout = 0
    const armLock = () => {
      window.clearTimeout(timeout)
      timeout = window.setTimeout(() => setUnlocked(false), PARENT_IDLE_MS)
    }
    const events = ['pointerdown', 'keydown', 'touchstart'] as const
    events.forEach((eventName) => window.addEventListener(eventName, armLock, { passive: true }))
    armLock()
    return () => {
      window.clearTimeout(timeout)
      events.forEach((eventName) => window.removeEventListener(eventName, armLock))
    }
  }, [setUnlocked, unlocked])
}

export default function App() {
  const route = useHashRoute()
  const [pwaUpdateAction, setPwaUpdateAction] = useState<PwaUpdateAction | null>(null)
  useEffect(() => subscribePwaUpdate((action) => setPwaUpdateAction(() => action)), [])

  if (route.kind === 'local') {
    return <LocalMissionApp pwaUpdateAction={pwaUpdateAction} setPwaUpdateAction={setPwaUpdateAction} />
  }

  return (
    <div className="appShell">
      <a className="skipLink" href="#main-content">К основному содержимому</a>
      <PwaUpdateBanner action={pwaUpdateAction} onChange={setPwaUpdateAction} />
      {route.kind === 'landing' && <LandingScreen />}
      {route.kind === 'not-found' && <RouteNotFound />}
      {(route.kind === 'parent' || route.kind === 'child' || route.kind === 'join') && <CloudPortal route={route} />}
    </div>
  )
}

function CloudPortal({ route }: { route: Extract<CloudRoute, { kind: 'parent' | 'child' | 'join' }> }) {
  const cloudSession = useCloudSession()
  const sync = useCloudSync({
    enabled: route.kind === 'parent' || route.kind === 'child',
    userId: cloudSession.session?.user.id ?? null,
  })
  const mission = useCloudMissionApp(sync)
  const [childTab, setChildTab] = useState<ChildTab>('today')
  const [parentUnlocked, setParentUnlocked] = useState(false)
  const now = useNow(mission.state?.activeTimer ?? null)
  const theme = mission.state?.settings.theme ?? 'system'
  useTheme(theme)
  useParentSessionLock(parentUnlocked, setParentUnlocked)

  const refresh = sync.refresh
  const onParentReady = useCallback(() => { void refresh() }, [refresh])
  const syncView = useMemo(() => ({
    phase: sync.phase,
    lastSyncedAt: sync.lastSyncedAt,
    queuedOperations: sync.queuedOperations,
    error: sync.error,
  }), [sync.error, sync.lastSyncedAt, sync.phase, sync.queuedOperations])

  if (route.kind === 'join') {
    return <ChildInviteClaim token={route.inviteToken} onJoined={() => window.dispatchEvent(new Event('hashchange'))} />
  }

  if (route.kind === 'parent') {
    return (
      <ParentCloudAuth onReady={onParentReady} readyContent={(initialSnapshot) => {
        const state = mission.state ?? initialSnapshot.appState
        return (
          <>
            <ParentScreen
              state={state}
              now={now}
              unlocked={parentUnlocked}
              onUnlock={() => setParentUnlocked(true)}
              onLock={() => setParentUnlocked(false)}
              actions={mission.actions}
              pinRecovery={<CloudPinRecovery refresh={sync.refresh} />}
              cloudTools={(
                <CloudFamilyControls
                  familyName={initialSnapshot.meta.family.name}
                  sync={syncView}
                  refresh={sync.refresh}
                />
              )}
            />
            <FeedbackToast feedback={mission.feedback} onClose={mission.clearFeedback} />
          </>
        )
      }} />
    )
  }

  if (cloudSession.loading) return <CloudMessage title="Подключаем устройство" message="Проверяем защищённую детскую сессию…" />
  if (!cloudSession.session) {
    return <CloudMessage title="Устройство не подключено" message="Откройте на этом устройстве одноразовую ссылку или QR-код из родительского интерфейса." error={cloudSession.error} />
  }
  if (!mission.state) {
    return (
      <CloudMessage
        title={sync.phase === 'error' ? 'Доступ устройства недействителен' : 'Загружаем миссии'}
        message={sync.phase === 'error' ? 'Попросите родителя создать новую ссылку подключения.' : 'Получаем актуальные данные семьи…'}
        error={sync.error}
        allowSignOut
      />
    )
  }
  if (sync.snapshot?.meta.membership.role !== 'child') {
    return <CloudMessage title="Открыта родительская сессия" message="Детский и родительский режимы используют разные устройства или профили браузера." allowSignOut />
  }

  const changeChildTab = (next: ChildTab) => {
    setChildTab(next)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
  }

  return (
    <>
      <div className="cloudStatusDock"><CloudSyncStatus {...syncView} /></div>
      {childTab === 'today' && <TodayScreen state={mission.state} now={now} onSubmit={mission.actions.submitTask} onPushUps={mission.actions.setPushUps} onOpenTimer={() => changeChildTab('timer')} />}
      {childTab === 'timer' && <TimerScreen state={mission.state} now={now} onStart={mission.actions.startTimer} onStop={mission.actions.stopTimer} onGoToday={() => changeChildTab('today')} />}
      {childTab === 'progress' && <ProgressScreen state={mission.state} now={now} />}
      <BottomNavigation navigation={childNavigation} active={childTab} activeTimer={Boolean(mission.state.activeTimer)} onChange={changeChildTab} childOnly />
      <FeedbackToast feedback={mission.feedback} onClose={mission.clearFeedback} />
      {mission.state.timerNotice && <TimerFinishedModal onClose={mission.actions.acknowledgeTimer} />}
    </>
  )
}

function CloudMessage({ title, message, error, allowSignOut = false }: { title: string; message: string; error?: string | null; allowSignOut?: boolean }) {
  const [busy, setBusy] = useState(false)
  const clearSession = async () => {
    setBusy(true)
    try {
      await signOutCloud()
      window.location.hash = '/child'
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="screen pinScreen" id="main-content">
      <section className="pinCard cloudAuthCard">
        <span className="eyebrow">Облачный режим</span>
        <h1>{title}</h1>
        <p>{message}</p>
        {error && <p className="formError" role="alert">{error}</p>}
        {allowSignOut && <button className="button button--secondary" type="button" disabled={busy} onClick={() => { void clearSession() }}>{busy ? 'Очищаем…' : 'Очистить сессию устройства'}</button>}
        <a className="button button--lockMode" href="#/">На стартовый экран</a>
      </section>
    </main>
  )
}

function LandingScreen() {
  return (
    <main className="screen cloudLanding" id="main-content">
      <header className="cloudLanding__hero">
        <span className="eyebrow">Семейная PWA</span>
        <h1>Миссии Николая</h1>
        <p>Одна семья, два защищённых интерфейса и общие данные на разных устройствах.</p>
      </header>
      <section className="cloudLanding__grid" aria-label="Выберите интерфейс">
        <article className="cloudPortalCard cloudPortalCard--child">
          <span aria-hidden="true">⚡</span>
          <h2>Николаю</h2>
          <p>Миссии, XP, доступные минуты, прогресс и таймер. Для первого входа нужна ссылка родителя.</p>
          <a className="button button--primary" href="#/child">Открыть детский интерфейс</a>
        </article>
        <article className="cloudPortalCard cloudPortalCard--parent">
          <span aria-hidden="true">🛡️</span>
          <h2>Родителю</h2>
          <p>Вход по email, локальный PIN, подтверждения, настройки и подключение детского устройства.</p>
          <a className="button button--secondary" href="#/parent">Открыть родительский интерфейс</a>
        </article>
      </section>
      <aside className="localModeNote">
        <strong>Старые локальные данные не отправляются в облако автоматически.</strong>
        <span>Нужен прежний автономный демо-режим?</span>
        <a href="#/local">Открыть локальную версию</a>
      </aside>
    </main>
  )
}

function RouteNotFound() {
  return <CloudMessage title="Страница не найдена" message="Проверьте ссылку или вернитесь на стартовый экран." />
}

function LocalMissionApp({ pwaUpdateAction, setPwaUpdateAction }: { pwaUpdateAction: PwaUpdateAction | null; setPwaUpdateAction: (action: PwaUpdateAction | null) => void }) {
  const { state, feedback, clearFeedback, actions } = useMissionApp()
  const [tab, setTab] = useState<LocalTab>('today')
  const [parentUnlocked, setParentUnlocked] = useState(false)
  const now = useNow(state.activeTimer)
  useTheme(state.settings.theme)
  useParentSessionLock(parentUnlocked, setParentUnlocked)

  const changeTab = (next: LocalTab) => {
    if (next !== 'parent') setParentUnlocked(false)
    setTab(next)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' })
  }

  return (
    <div className="appShell">
      <a className="skipLink" href="#main-content">К основному содержимому</a>
      <PwaUpdateBanner action={pwaUpdateAction} onChange={setPwaUpdateAction} />
      {tab === 'today' && <TodayScreen state={state} now={now} onSubmit={actions.submitTask} onPushUps={actions.setPushUps} onOpenTimer={() => changeTab('timer')} />}
      {tab === 'timer' && <TimerScreen state={state} now={now} onStart={actions.startTimer} onStop={actions.stopTimer} onGoToday={() => changeTab('today')} />}
      {tab === 'progress' && <ProgressScreen state={state} now={now} />}
      {tab === 'parent' && <ParentScreen state={state} now={now} unlocked={parentUnlocked} onUnlock={() => setParentUnlocked(true)} onLock={() => setParentUnlocked(false)} actions={actions} />}
      <BottomNavigation navigation={localNavigation} active={tab} activeTimer={Boolean(state.activeTimer)} onChange={changeTab} />
      <FeedbackToast feedback={feedback} onClose={clearFeedback} />
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

function BottomNavigation<Tab extends string>({ navigation, active, activeTimer, onChange, childOnly = false }: {
  navigation: { id: Tab; label: string; icon: IconName }[]
  active: Tab
  activeTimer: boolean
  onChange: (tab: Tab) => void
  childOnly?: boolean
}) {
  return (
    <nav className={`bottomNav${childOnly ? ' bottomNav--child' : ''}`} aria-label="Основная навигация">
      {navigation.map((item) => (
        <button type="button" key={item.id} className={active === item.id ? 'is-active' : ''} aria-current={active === item.id ? 'page' : undefined} onClick={() => onChange(item.id)}>
          <span className="bottomNav__icon"><Icon name={item.icon} />{item.id === 'timer' && activeTimer && <i aria-label="Таймер активен" />}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  )
}

function FeedbackToast({ feedback, onClose }: { feedback: Feedback | null; onClose: () => void }) {
  if (!feedback) return null
  return (
    <div className={`toast toast--${feedback.kind}`} role={feedback.kind === 'error' ? 'alert' : 'status'} aria-live={feedback.kind === 'error' ? 'assertive' : 'polite'} onClick={onClose}>
      <span>{feedback.kind === 'success' ? '✦' : feedback.kind === 'error' ? '!' : 'i'}</span>
      <p>{feedback.message}</p>
      <button type="button" aria-label="Закрыть сообщение" onClick={onClose}>×</button>
    </div>
  )
}

function PwaUpdateBanner({ action, onChange }: { action: PwaUpdateAction | null; onChange: (action: PwaUpdateAction | null) => void }) {
  if (!action) return null
  return (
    <aside className="updatePrompt" role="status" aria-live="polite">
      <div className="updatePrompt__copy"><strong>Доступно обновление</strong><span>Установите новую версию, когда будете готовы.</span></div>
      <div className="updatePrompt__actions">
        <button type="button" className="button button--primary" onClick={() => { dismissPwaUpdate(); onChange(null); action() }}>Обновить</button>
        <button type="button" className="button button--secondary" onClick={() => { dismissPwaUpdate(); onChange(null) }}>Позже</button>
      </div>
    </aside>
  )
}
