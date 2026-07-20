import { useEffect, useRef, useState, type FormEvent } from 'react'
import { verifyPin } from '../lib/security'
import type { AppState, Task, ThemePreference } from '../types'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'

interface ParentActions {
  approveTask: (taskId: string) => boolean
  rejectTask: (taskId: string) => boolean
  undoApproval: (taskId: string) => boolean
  updateSettings: (values: { xpToMinutes?: number; dailyLimitMinutes?: number; carryOver?: boolean; theme?: ThemePreference }) => boolean
  updateTask: (taskId: string, values: { xp?: number; hidden?: boolean }) => boolean
  addTask: (title: string, xp: number) => boolean
  adjustXp: (delta: number, reason: string) => boolean
  resetToday: () => boolean
  changePin: (pin: string) => Promise<void>
}

export function ParentScreen({ state, unlocked, onUnlock, onLock, actions }: {
  state: AppState
  unlocked: boolean
  onUnlock: () => void
  onLock: () => void
  actions: ParentActions
}) {
  if (!unlocked) return <PinGate pinHash={state.settings.pinHash} pinSalt={state.settings.pinSalt} onUnlock={onUnlock} />
  return <ParentDashboard state={state} actions={actions} onLock={onLock} />
}

function PinGate({ pinHash, pinSalt, onUnlock }: { pinHash: string; pinSalt: string; onUnlock: () => void }) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!/^\d{4}$/.test(pin)) {
      setError('Введите четыре цифры')
      return
    }
    setChecking(true)
    const valid = await verifyPin(pin, pinHash, pinSalt)
    setChecking(false)
    if (valid) onUnlock()
    else {
      setError('PIN не подошёл. Попробуйте ещё раз.')
      setPin('')
      inputRef.current?.focus()
    }
  }

  return (
    <main className="screen pinScreen" id="main-content">
      <section className="pinCard">
        <div className="pinCard__icon"><Icon name="shield" /></div>
        <span className="eyebrow">Только для взрослых</span>
        <h1>Родительский режим</h1>
        <p>Введите четырёхзначный PIN, чтобы проверять миссии и менять настройки.</p>
        <form onSubmit={submit}>
          <label htmlFor="parent-pin">PIN-код</label>
          <div className="pinDots" aria-hidden="true">
            {[0, 1, 2, 3].map((index) => <span key={index} className={pin.length > index ? 'is-filled' : ''} />)}
          </div>
          <input
            ref={inputRef}
            id="parent-pin"
            className="pinInput"
            type="password"
            inputMode="numeric"
            autoComplete="current-password"
            maxLength={4}
            pattern="[0-9]{4}"
            value={pin}
            onChange={(event) => { setPin(event.target.value.replace(/\D/g, '').slice(0, 4)); setError('') }}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'pin-error' : undefined}
          />
          {error && <p className="formError" id="pin-error" role="alert">{error}</p>}
          <button type="submit" className="button button--primary" disabled={checking || pin.length !== 4}>{checking ? 'Проверяем…' : 'Войти'}</button>
        </form>
        <p className="securityNote"><Icon name="lock" />PIN защищает настройки на этом устройстве, но не заменяет системный родительский контроль.</p>
      </section>
    </main>
  )
}

const submittedTime = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' })
const operationTime = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

function formatSubmittedAt(value?: number): string {
  return value ? `Отправлено в ${submittedTime.format(value)}` : 'Время отправки не записано'
}

function ParentDashboard({ state, actions, onLock }: { state: AppState; actions: ParentActions; onLock: () => void }) {
  const pending = state.tasks.filter((task) => state.today.taskStates[task.id]?.status === 'pending')
  const approved = state.tasks.filter((task) => state.today.taskStates[task.id]?.status === 'approved')
  const [xpRate, setXpRate] = useState(String(state.settings.xpToMinutes))
  const [limit, setLimit] = useState(String(state.settings.dailyLimitMinutes))
  const [taskTitle, setTaskTitle] = useState('')
  const [taskXp, setTaskXp] = useState('10')
  const [adjustment, setAdjustment] = useState('')
  const [reason, setReason] = useState('')
  const [newPin, setNewPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [pinError, setPinError] = useState('')
  const [resetOpen, setResetOpen] = useState(false)
  const [undoTask, setUndoTask] = useState<Task | null>(null)
  const operations = state.transactions
    .filter((transaction) => ['reversal', 'manual', 'reset'].includes(transaction.type))
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 30)
  const undoAward = undoTask
    ? state.transactions.find((transaction) => transaction.id === state.today.taskStates[undoTask.id]?.activeAwardId)
    : undefined

  const saveRewards = (event: FormEvent) => {
    event.preventDefault()
    actions.updateSettings({ xpToMinutes: Number(xpRate), dailyLimitMinutes: Number(limit) })
  }
  const addTask = (event: FormEvent) => {
    event.preventDefault()
    if (actions.addTask(taskTitle, Number(taskXp))) {
      setTaskTitle('')
      setTaskXp('10')
    }
  }
  const adjust = (event: FormEvent) => {
    event.preventDefault()
    if (actions.adjustXp(Number(adjustment), reason)) {
      setAdjustment('')
      setReason('')
    }
  }
  const savePin = async (event: FormEvent) => {
    event.preventDefault()
    if (!/^\d{4}$/.test(newPin)) return setPinError('PIN должен состоять из четырёх цифр')
    if (newPin !== confirmPin) return setPinError('PIN-коды не совпадают')
    await actions.changePin(newPin)
    setNewPin('')
    setConfirmPin('')
    setPinError('')
  }

  return (
    <main className="screen parentScreen" id="main-content">
      <header className="parentHeader">
        <div><span className="eyebrow">Панель управления</span><h1>Родителю</h1><p>Сегодня · {pending.length} ждут проверки</p></div>
        <button type="button" className="iconButton" onClick={onLock} aria-label="Выйти из родительского режима"><Icon name="lock" /></button>
      </header>

      {!state.settings.hasChangedPin && (
        <section className="pinReminder">
          <Icon name="shield" />
          <div><strong>Замените стартовый PIN</strong><p>Так Николай не сможет случайно открыть настройки. Новый код можно задать ниже.</p></div>
          <a href="#pin-settings">Изменить</a>
        </section>
      )}

      <section className="parentSection" aria-labelledby="pending-title">
        <div className="sectionTitleRow"><div><span className="eyebrow">Требует решения</span><h2 id="pending-title">Ожидают проверки</h2></div><span className="countBadge">{pending.length}</span></div>
        {pending.length === 0 ? (
          <div className="emptyInline"><span>✓</span><div><strong>Очередь пуста</strong><p>Новые выполненные миссии появятся здесь.</p></div></div>
        ) : (
          <div className="reviewList">
            {pending.map((task) => {
              const daily = state.today.taskStates[task.id]
              return (
                <article className="reviewCard" key={task.id}>
                  <div className="reviewCard__info">
                    <span>{task.icon}</span>
                    <div>
                      <h3>{task.title}</h3>
                      <p>{task.kind === 'pushups' ? `${daily.selectedPushUps} отжиманий · ` : ''}+{daily.submittedXp ?? task.xp} XP</p>
                      <time dateTime={daily.submittedAt ? new Date(daily.submittedAt).toISOString() : undefined}>{formatSubmittedAt(daily.submittedAt)}</time>
                    </div>
                  </div>
                  <div className="reviewCard__actions">
                    <button type="button" className="button button--approve" onClick={() => actions.approveTask(task.id)}><Icon name="check" />Подтвердить</button>
                    <button type="button" className="button button--reject" onClick={() => actions.rejectTask(task.id)}>Отклонить</button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {approved.length > 0 && (
        <section className="parentSection">
          <div className="sectionTitleRow"><div><span className="eyebrow">Уже начислено</span><h2>Подтверждено сегодня</h2></div></div>
          <div className="approvedList">
            {approved.map((task) => (
              <article key={task.id}><span>{task.icon}</span><div><strong>{task.title}</strong><small>Награда начислена</small></div><button type="button" onClick={() => setUndoTask(task)}>Отменить</button></article>
            ))}
          </div>
        </section>
      )}

      <section className="parentSection">
        <details open>
          <summary><span><Icon name="clock" />Журнал за сегодня</span><small>{state.today.activity.length}</small></summary>
          {state.today.activity.length ? (
            <div className="activityList">
              {state.today.activity.map((event) => <div key={event.id}><span>{new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(event.createdAt)}</span><p>{event.message}</p></div>)}
            </div>
          ) : <p className="detailsEmpty">Действий сегодня ещё не было.</p>}
        </details>
      </section>

      <section className="parentSection">
        <details open={operations.length > 0}>
          <summary><span><Icon name="progress" />История корректировок</span><small>{operations.length}</small></summary>
          {operations.length ? (
            <div className="operationList">
              {operations.map((transaction) => {
                const task = state.tasks.find((item) => item.id === transaction.taskId)
                const title = transaction.type === 'reversal'
                  ? `Отмена награды${task ? `: ${task.title}` : ''}`
                  : transaction.type === 'reset'
                    ? 'Сброс сегодняшнего дня'
                    : transaction.reason || 'Ручная корректировка XP'
                return (
                  <article key={transaction.id}>
                    <div><strong>{title}</strong><time dateTime={new Date(transaction.createdAt).toISOString()}>{operationTime.format(transaction.createdAt)}</time></div>
                    <span className={transaction.xpDelta < 0 ? 'is-negative' : ''}>{transaction.xpDelta > 0 ? '+' : ''}{transaction.xpDelta} XP · {transaction.minutesDelta > 0 ? '+' : ''}{transaction.minutesDelta} мин</span>
                  </article>
                )
              })}
            </div>
          ) : <p className="detailsEmpty">Отмен и ручных корректировок пока не было.</p>}
        </details>
      </section>

      <section className="parentSection settingsStack">
        <div className="sectionTitleRow"><div><span className="eyebrow">Правила семьи</span><h2>Настройки</h2></div><Icon name="settings" /></div>

        <details open>
          <summary><span><Icon name="bolt" />Награды и лимит</span></summary>
          <form className="settingsForm" onSubmit={saveRewards}>
            <label><span>Минут за 1 XP</span><input type="number" min="0.25" max="20" step="0.25" value={xpRate} onChange={(event) => setXpRate(event.target.value)} /></label>
            <label><span>Дневной лимит, минут</span><input type="number" min="10" max="360" step="5" value={limit} onChange={(event) => setLimit(event.target.value)} /></label>
            <label><span>Тема приложения</span><select value={state.settings.theme} onChange={(event) => actions.updateSettings({ theme: event.target.value as ThemePreference })}><option value="system">Как на устройстве</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></label>
            <label className="toggleRow"><span><strong>Перенос остатка</strong><small>Неиспользованные минуты перейдут на завтра в пределах лимита</small></span><input type="checkbox" checked={state.settings.carryOver} onChange={(event) => actions.updateSettings({ carryOver: event.target.checked })} /></label>
            <p className="formHint">Новая формула применяется к будущим подтверждениям. Старые награды сохраняются.</p>
            <button type="submit" className="button button--secondary">Сохранить правила</button>
          </form>
        </details>

        <details>
          <summary><span><Icon name="today" />Миссии и стоимость</span><small>{state.tasks.length}</small></summary>
          <div className="taskSettings">
            {state.tasks.map((task) => (
              <article key={task.id} className={task.hidden ? 'is-hidden' : ''}>
                <span className="taskSettings__icon">{task.icon}</span>
                <div><strong>{task.title}</strong><small>{task.required ? 'Обязательная' : task.kind === 'pushups' ? 'Фиксированная шкала' : task.builtIn ? 'Стандартная' : 'Добавлена родителем'}</small></div>
                {task.kind !== 'pushups' && <label><span className="srOnly">XP для {task.title}</span><input type="number" min="1" max="500" defaultValue={task.xp} onBlur={(event) => actions.updateTask(task.id, { xp: Number(event.target.value) })} /><em>XP</em></label>}
                <button type="button" disabled={task.required} onClick={() => actions.updateTask(task.id, { hidden: !task.hidden })}>{task.required ? <Icon name="lock" /> : task.hidden ? 'Показать' : 'Скрыть'}</button>
              </article>
            ))}
          </div>
          <form className="addTaskForm" onSubmit={addTask}>
            <h3>Добавить бытовую миссию</h3>
            <label><span>Название</span><input required minLength={2} maxLength={80} value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Например, полить цветы" /></label>
            <label><span>Награда XP</span><input required type="number" min="1" max="500" value={taskXp} onChange={(event) => setTaskXp(event.target.value)} /></label>
            <button type="submit" className="button button--secondary"><Icon name="plus" />Добавить миссию</button>
          </form>
        </details>

        <details>
          <summary><span><Icon name="sparkle" />Ручная корректировка XP</span></summary>
          <form className="settingsForm" onSubmit={adjust}>
            <label><span>Изменение XP</span><input required type="number" min="-10000" max="10000" value={adjustment} onChange={(event) => setAdjustment(event.target.value)} placeholder="Например, 10 или -5" /></label>
            <label><span>Причина — обязательно</span><textarea required maxLength={250} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="За что меняем баланс" /></label>
            <button type="submit" className="button button--secondary">Применить корректировку</button>
          </form>
        </details>

        <details id="pin-settings" open={!state.settings.hasChangedPin}>
          <summary><span><Icon name="lock" />Сменить PIN</span></summary>
          <form className="settingsForm" onSubmit={savePin}>
            <label><span>Новый PIN</span><input required type="password" inputMode="numeric" autoComplete="new-password" minLength={4} maxLength={4} pattern="[0-9]{4}" value={newPin} aria-invalid={Boolean(pinError)} aria-describedby={pinError ? 'pin-settings-error' : undefined} onChange={(event) => { setNewPin(event.target.value.replace(/\D/g, '').slice(0, 4)); setPinError('') }} /></label>
            <label><span>Повторите PIN</span><input required type="password" inputMode="numeric" autoComplete="new-password" minLength={4} maxLength={4} pattern="[0-9]{4}" value={confirmPin} aria-invalid={Boolean(pinError)} aria-describedby={pinError ? 'pin-settings-error' : undefined} onChange={(event) => { setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 4)); setPinError('') }} /></label>
            {pinError && <p className="formError" id="pin-settings-error" role="alert">{pinError}</p>}
            <button type="submit" className="button button--secondary">Сохранить новый PIN</button>
          </form>
        </details>

        <details className="dangerZone">
          <summary><span>Опасная зона</span></summary>
          <p>Сброс удалит сегодняшние статусы, начисления и использованное время. Общая история прошлых дней сохранится.</p>
          <button type="button" className="button button--dangerGhost" onClick={() => setResetOpen(true)}>Сбросить сегодняшний день</button>
        </details>
      </section>

      <p className="sessionNote"><Icon name="lock" />Режим закроется при уходе с экрана или через 5 минут бездействия.</p>
      <button type="button" className="button button--lockMode" onClick={onLock}><Icon name="lock" />Выйти из родительского режима</button>

      {undoTask && (
        <Modal title="Отменить подтверждение?" onClose={() => setUndoTask(null)}>
          <p>Награда за «{undoTask.title}» будет отменена:</p>
          <ul className="impactList">
            <li><strong>{Math.abs(undoAward?.xpDelta ?? 0)} XP</strong> будут списаны.</li>
            <li>Доступные минуты будут пересчитаны на <strong>{Math.abs(undoAward?.minutesDelta ?? 0)} мин</strong>.</li>
            <li>Общий опыт и уровень будут скорректированы.</li>
            <li>Запись об отмене останется в истории корректировок.</li>
          </ul>
          {state.activeTimer && <p className="modalNote">Активный таймер остановится и учтёт только уже прошедшее время.</p>}
          <div className="modalActions"><button type="button" className="button button--secondary" onClick={() => setUndoTask(null)}>Не отменять</button><button type="button" className="button button--danger" onClick={() => { actions.undoApproval(undoTask.id); setUndoTask(null) }}>Отменить награду</button></div>
        </Modal>
      )}
      {resetOpen && (
        <Modal title="Сбросить сегодняшний день?" onClose={() => setResetOpen(false)} urgent>
          <p>Это действие нельзя отменить. Миссии снова станут невыполненными, а сегодняшние XP и минуты обнулятся.</p>
          <div className="modalActions"><button type="button" className="button button--secondary" onClick={() => setResetOpen(false)}>Назад</button><button type="button" className="button button--danger" onClick={() => { actions.resetToday(); setResetOpen(false) }}>Да, сбросить</button></div>
        </Modal>
      )}
    </main>
  )
}
