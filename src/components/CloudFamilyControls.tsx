import { useMemo, useState } from 'react'
import { signOutCloud } from '../cloud/api'
import { runIdempotentIntent } from '../cloud/idempotency'
import { callCloudRpc } from '../cloud/rpc'
import type { CloudSyncViewState } from '../types/cloud'
import { CloudInviteManager } from './CloudInviteManager'
import { CloudSyncStatus } from './CloudSyncStatus'

function routeUrl(hash: '#/parent' | '#/child'): string {
  const url = new URL(window.location.href)
  url.search = ''
  url.hash = hash.slice(1)
  return url.toString()
}

export function CloudFamilyControls({
  familyName,
  sync,
  refresh,
}: {
  familyName: string
  sync: CloudSyncViewState
  refresh: () => Promise<unknown>
}) {
  const parentUrl = useMemo(() => routeUrl('#/parent'), [])
  const [copied, setCopied] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [familyConfirmation, setFamilyConfirmation] = useState('')
  const [busy, setBusy] = useState<'revoke' | 'delete' | 'signout' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const copyParentLink = async () => {
    try {
      await navigator.clipboard.writeText(parentUrl)
      setCopied(true)
    } catch {
      setError('Не удалось скопировать автоматически. Выделите ссылку вручную.')
    }
  }

  const revokeChild = async () => {
    setBusy('revoke')
    setError(null)
    try {
      await runIdempotentIntent('revoke-child-device', (operationId) =>
        callCloudRpc('revoke_child_device', { p_idempotency_key: operationId }),
      )
      await refresh()
      setConfirmRevoke(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось отключить детское устройство')
    } finally {
      setBusy(null)
    }
  }

  const signOut = async () => {
    setBusy('signout')
    setError(null)
    try {
      await signOutCloud()
      window.location.hash = '/parent'
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось выйти')
    } finally {
      setBusy(null)
    }
  }

  const deleteFamily = async () => {
    if (familyConfirmation !== familyName) return
    setBusy('delete')
    setError(null)
    try {
      await callCloudRpc('delete_family', { p_confirmation: familyConfirmation })
      await signOutCloud()
      window.location.hash = '/'
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось удалить семейные данные')
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <CloudSyncStatus {...sync} />
      <CloudInviteManager />

      <section className="parentSection cloudLinkCard" aria-labelledby="parent-link-title">
        <div className="sectionTitleRow"><div><span className="eyebrow">Это устройство</span><h2 id="parent-link-title">Ссылка родителя</h2></div></div>
        <p>Открывайте её только в браузере, где выполнен родительский вход.</p>
        <label><span className="srOnly">Ссылка родителя</span><input readOnly value={parentUrl} onFocus={(event) => event.currentTarget.select()} /></label>
        <button className="button button--secondary" type="button" onClick={() => { void copyParentLink() }}>{copied ? 'Скопировано' : 'Скопировать'}</button>
      </section>

      <section className="parentSection" aria-labelledby="device-access-title">
        <div className="sectionTitleRow"><div><span className="eyebrow">Безопасность</span><h2 id="device-access-title">Доступ устройств</h2></div></div>
        <p>Отключение немедленно отзывает детскую сессию и все открытые приглашения. Для повторного подключения понадобится новая ссылка.</p>
        {!confirmRevoke ? (
          <button className="button button--dangerGhost" type="button" onClick={() => setConfirmRevoke(true)}>Отключить детское устройство</button>
        ) : (
          <div className="cloudConfirmRow" role="group" aria-label="Подтверждение отключения">
            <button className="button button--secondary" type="button" onClick={() => setConfirmRevoke(false)}>Отмена</button>
            <button className="button button--danger" type="button" disabled={busy === 'revoke'} onClick={() => { void revokeChild() }}>{busy === 'revoke' ? 'Отключаем…' : 'Да, отключить'}</button>
          </div>
        )}
        <button className="button button--lockMode" type="button" disabled={busy !== null} onClick={() => { void signOut() }}>{busy === 'signout' ? 'Выходим…' : 'Выйти из облачной учётной записи'}</button>
      </section>

      <section className="parentSection dangerZone" aria-labelledby="delete-family-title">
        <details>
          <summary id="delete-family-title"><span>Удалить семейные данные</span></summary>
          <p>Будут безвозвратно удалены миссии, история, награды, настройки и доступ устройств. Учётная запись email останется.</p>
          <label className="cloudDeleteConfirm"><span>Введите точное название: <strong>{familyName}</strong></span><input value={familyConfirmation} onChange={(event) => setFamilyConfirmation(event.target.value)} autoComplete="off" /></label>
          <button className="button button--danger" type="button" disabled={familyConfirmation !== familyName || busy === 'delete'} onClick={() => { void deleteFamily() }}>{busy === 'delete' ? 'Удаляем…' : 'Удалить семейное пространство'}</button>
        </details>
      </section>
      {error && <p className="formError cloudControlError" role="alert">{error}</p>}
    </>
  )
}
