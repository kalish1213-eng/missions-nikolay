import { useState, type FormEvent } from 'react'
import { runIdempotentPayloadIntent } from '../cloud/idempotency'
import { callCloudRpc } from '../cloud/rpc'
import { generatePinSalt, hashPin } from '../lib/security'

export function CloudPinRecovery({ refresh }: { refresh: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false)
  const [pin, setPin] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!/^\d{4}$/.test(pin)) return setError('PIN должен состоять из четырёх цифр')
    if (pin !== confirmation) return setError('PIN-коды не совпадают')
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await runIdempotentPayloadIntent('recover-parent-pin', {
        createPayload: async () => {
          const pinSalt = generatePinSalt()
          return { pinSalt, pinHash: await hashPin(pin, pinSalt) }
        },
        matches: async (payload) => await hashPin(pin, payload.pinSalt) === payload.pinHash,
        send: (payload, operationId) => callCloudRpc('change_parent_pin', {
          p_pin_hash: payload.pinHash,
          p_pin_salt: payload.pinSalt,
          p_idempotency_key: operationId,
        }),
      })
      await refresh()
      setPin('')
      setConfirmation('')
      setMessage('PIN изменён. Введите новый PIN в поле выше.')
      setOpen(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось восстановить PIN')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cloudPinRecovery">
      {!open ? (
        <button type="button" onClick={() => { setOpen(true); setMessage(null) }}>Забыли PIN?</button>
      ) : (
        <form className="settingsForm" onSubmit={submit}>
          <p>Основная защита — текущая авторизованная email-сессия. Задайте новый локальный PIN.</p>
          <label><span>Новый PIN</span><input required type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
          <label><span>Повторите PIN</span><input required type="password" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} value={confirmation} onChange={(event) => setConfirmation(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
          {error && <p className="formError" role="alert">{error}</p>}
          <div className="cloudConfirmRow">
            <button className="button button--secondary" type="button" onClick={() => setOpen(false)}>Отмена</button>
            <button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Сохраняем…' : 'Сменить PIN'}</button>
          </div>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  )
}
