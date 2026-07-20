import { useState } from 'react'
import { runIdempotentIntent } from '../cloud/idempotency'
import { callCloudRpc } from '../cloud/rpc'
import { buildChildInviteUrl } from '../cloud/routes'
import { LocalQrInvite } from './LocalQrInvite'

interface ActiveInvite {
  url: string
  expiresAt: number
}

function applicationBaseUrl(): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = ''
  return url.toString()
}

export function CloudInviteManager({ expiresMinutes = 60 }: { expiresMinutes?: number }) {
  const [invite, setInvite] = useState<ActiveInvite | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const createInvite = async () => {
    setBusy(true)
    setCopied(false)
    setError(null)
    try {
      const result = await runIdempotentIntent('create-child-invite', (operationId) =>
        callCloudRpc('create_child_invite', {
          p_expires_minutes: expiresMinutes,
          p_idempotency_key: operationId,
        }),
      )
      setInvite({ url: buildChildInviteUrl(applicationBaseUrl(), result.token), expiresAt: result.expiresAt })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось создать приглашение')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.url)
      setCopied(true)
    } catch {
      setError('Не удалось скопировать автоматически. Выделите ссылку вручную.')
    }
  }

  return (
    <section className="parentSection" aria-labelledby="cloud-invite-title">
      <div className="sectionTitleRow"><div><span className="eyebrow">Детское устройство</span><h2 id="cloud-invite-title">Одноразовое приглашение</h2></div></div>
      <p>Новая ссылка отменяет предыдущую. После подключения постоянный секрет в адресе не остаётся.</p>
      <button className="button button--secondary" type="button" disabled={busy} onClick={() => { void createInvite() }}>
        {busy ? 'Создаём…' : invite ? 'Создать новую ссылку' : 'Создать приглашение'}
      </button>
      {invite && (
        <div>
          <LocalQrInvite value={invite.url} />
          <label><span className="srOnly">Ссылка приглашения</span><input readOnly value={invite.url} onFocus={(event) => event.currentTarget.select()} /></label>
          <div className="cloudInviteActions">
            <button className="button button--primary" type="button" onClick={() => { void copy() }}>{copied ? 'Скопировано' : 'Скопировать ссылку'}</button>
            <a className="button button--secondary" href={invite.url} target="_blank" rel="noreferrer">Открыть</a>
          </div>
          <p><small>Открывайте на другом устройстве или в отдельном профиле браузера: родительская и детская сессии не должны делить одно хранилище сайта.</small></p>
          <p><small>Действует до {new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(invite.expiresAt)}.</small></p>
        </div>
      )}
      {error && <p className="formError" role="alert">{error}</p>}
    </section>
  )
}
