import { useState, type FormEvent } from 'react'
import { claimChildInvite } from '../cloud/api'
import { clearInviteTokenFromAddress, isSafeInviteToken } from '../cloud/routes'
import type { CloudSnapshot } from '../types/cloud'

export function ChildInviteClaim({ token, onJoined }: { token: string; onJoined: (snapshot: CloudSnapshot) => void }) {
  const [name, setName] = useState('Николай')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const validToken = isSafeInviteToken(token)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!validToken) return
    setBusy(true)
    setError(null)
    try {
      onJoined(await claimChildInvite(token, name))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось принять приглашение')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="screen pinScreen" id="main-content">
      <section className="pinCard">
        <span className="eyebrow">Одноразовое приглашение</span>
        <h1>Подключить детское устройство</h1>
        {validToken ? (
          <form className="settingsForm" onSubmit={submit}>
            <label><span>Имя</span><input required minLength={1} maxLength={80} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} /></label>
            {error && <p className="formError" role="alert">{error}</p>}
            <button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Подключаем…' : 'Подключить'}</button>
          </form>
        ) : <p className="formError" role="alert">Ссылка повреждена. Попросите родителя создать новую.</p>}
        <button className="button button--secondary" type="button" onClick={() => clearInviteTokenFromAddress('#/child')}>Не подключать</button>
        <p className="securityNote">Ссылка сработает один раз и не сохраняется в приложении после подключения.</p>
      </section>
    </main>
  )
}
