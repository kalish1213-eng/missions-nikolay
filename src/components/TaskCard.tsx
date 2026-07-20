import type { DailyTaskState, PushUpCount, Task } from '../types'
import { getPushUpXp } from '../lib/domain'
import { Icon } from './Icon'

const statusText = {
  todo: 'Не выполнено',
  pending: 'Ждёт родителя',
  approved: 'Подтверждено',
  rejected: 'Нужно попробовать ещё раз',
}

export function TaskCard({ task, daily, onSubmit, onPushUps }: {
  task: Task
  daily: DailyTaskState
  onSubmit: () => void
  onPushUps?: (count: PushUpCount) => void
}) {
  const xp = task.kind === 'pushups' ? getPushUpXp(daily.selectedPushUps ?? 10) : task.xp
  const canSubmit = daily.status === 'todo' || daily.status === 'rejected'

  return (
    <article className={`taskCard taskCard--${daily.status} ${task.required ? 'taskCard--required' : ''} ${task.kind === 'pushups' ? 'taskCard--pushups' : ''}`}>
      <div className="taskCard__top">
        <div className="taskCard__icon" aria-hidden="true">{task.icon}</div>
        <div className="taskCard__copy">
          <div className="taskCard__titleRow">
            <h3>{task.title}</h3>
            <span className="xpChip">+{xp} XP</span>
          </div>
          <div className="taskCard__meta">
            {task.required && <span className="requiredChip"><Icon name="shield" />Обязательно</span>}
            <div className={`status status--${daily.status}`}>
              {daily.status === 'approved' && <Icon name="check" />}
              {daily.status === 'pending' && <span className="status__pulse" />}
              {statusText[daily.status]}
            </div>
          </div>
        </div>
      </div>

      {task.kind === 'pushups' && canSubmit && (
        <div className="pushupChooser" role="group" aria-label="Выберите количество отжиманий">
          {([10, 20, 30, 40, 50] as PushUpCount[]).map((count) => (
            <button
              key={count}
              type="button"
              className={daily.selectedPushUps === count ? 'is-selected' : ''}
              aria-pressed={daily.selectedPushUps === count}
              aria-label={`${count} отжиманий`}
              onClick={() => onPushUps?.(count)}
            >
              {count}
            </button>
          ))}
        </div>
      )}

      {canSubmit && (
        <button type="button" className="button button--task" onClick={onSubmit}>
          {daily.status === 'rejected' ? 'Готово, проверить снова' : 'Я выполнил'}
        </button>
      )}
      {daily.status === 'pending' && task.kind === 'pushups' && (
        <p className="taskCard__hint">Отправлено: {daily.selectedPushUps} отжиманий. Количество зафиксировано до решения родителя.</p>
      )}
    </article>
  )
}
