import type { CloudSyncViewState } from '../types/cloud'

const labels: Record<CloudSyncViewState['phase'], string> = {
  disabled: 'Облако не настроено',
  loading: 'Загружаем данные',
  syncing: 'Синхронизируем',
  synced: 'Синхронизировано',
  offline: 'Нет сети — изменения в очереди',
  error: 'Ошибка синхронизации',
}

export function CloudSyncStatus({ phase, lastSyncedAt, queuedOperations, error }: CloudSyncViewState) {
  const detail = phase === 'synced' && lastSyncedAt
    ? ` в ${new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(lastSyncedAt)}`
    : ''
  return (
    <aside className={`cloudSyncStatus cloudSyncStatus--${phase}`} role={phase === 'error' ? 'alert' : 'status'} aria-live="polite">
      <span aria-hidden="true">{phase === 'synced' ? '✓' : phase === 'offline' ? '↻' : '●'}</span>
      <span>{labels[phase]}{detail}{queuedOperations > 0 ? ` · в очереди: ${queuedOperations}` : ''}</span>
      {error && <small>{error}</small>}
    </aside>
  )
}
