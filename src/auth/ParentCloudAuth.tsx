import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { sendParentMagicLink, loadCloudSnapshot, signOutCloud } from '../cloud/api'
import { runIdempotentPayloadIntent } from '../cloud/idempotency'
import { callCloudRpc } from '../cloud/rpc'
import { snapshotToAppState } from '../cloud/snapshot'
import { generatePinSalt, hashPin } from '../lib/security'
import type { CloudSnapshot } from '../types/cloud'
import { useCloudSession } from './useCloudSession'

export interface ParentCloudAuthProps {
  onReady: (snapshot: CloudSnapshot) => void
  readyContent?: (snapshot: CloudSnapshot) => ReactNode
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Операция не выполнена'
}

function isMissingMembership(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = 'code' in error ? String(error.code) : ''
  const text = error instanceof Error ? error.message.toLowerCase() : ''
  return code === '42501' && text.includes('membership')
}

function isExistingFamily(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && String(error.code) === '23505'
}

interface FamilySetupPayload {
  childName: string
  pinHash: string
  pinSalt: string
}

export function ParentCloudAuth({ onReady, readyContent }: ParentCloudAuthProps) {
  const { session, loading: sessionLoading, error: sessionError } = useCloudSession()
  const [email, setEmail] = useState('')
  const [mailSent, setMailSent] = useState(false)
  const [childName, setChildName] = useState('Николай')
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [snapshot, setSnapshot] = useState<CloudSnapshot | null>(null)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onReadyRef = useRef(onReady)

  useEffect(() => { onReadyRef.current = onReady }, [onReady])

  useEffect(() => {
    if (!session) {
      setSnapshot(null)
      setNeedsSetup(false)
      return
    }
    let active = true
    setBusy(true)
    void loadCloudSnapshot()
      .then((next) => {
        if (!active) return
        if (next.meta.membership.role !== 'parent') throw new Error('Эта сессия принадлежит детскому устройству')
        setSnapshot(next)
        setNeedsSetup(false)
        onReadyRef.current(next)
      })
      .catch((reason: unknown) => {
        if (!active) return
        if (isMissingMembership(reason)) {
          setNeedsSetup(true)
          setError(null)
        } else {
          setError(message(reason))
        }
      })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [session])

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await sendParentMagicLink(email)
      setMailSent(true)
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  const createFamily = async (event: FormEvent) => {
    event.preventDefault()
    if (childName.trim().length < 1) return setError('Введите имя ребёнка')
    if (!/^\d{4}$/.test(pin)) return setError('PIN должен состоять из четырёх цифр')
    if (pin !== confirmPin) return setError('PIN-коды не совпадают')
    setBusy(true)
    setError(null)
    try {
      const normalizedChildName = childName.trim()
      const result = await runIdempotentPayloadIntent<FamilySetupPayload, unknown>('create-family', {
        createPayload: async () => {
          const pinSalt = generatePinSalt()
          return { childName: normalizedChildName, pinSalt, pinHash: await hashPin(pin, pinSalt) }
        },
        matches: async (payload) => payload.childName === normalizedChildName
          && await hashPin(pin, payload.pinSalt) === payload.pinHash,
        send: (payload) => callCloudRpc('create_family', {
          p_child_name: payload.childName,
          p_pin_hash: payload.pinHash,
          p_pin_salt: payload.pinSalt,
        }),
      })
      const next = snapshotToAppState(result)
      setSnapshot(next)
      setNeedsSetup(false)
      setPin('')
      setConfirmPin('')
      onReady(next)
    } catch (reason) {
      if (isExistingFamily(reason)) {
        try {
          const next = await loadCloudSnapshot()
          if (next.meta.membership.role !== 'parent') throw reason
          setSnapshot(next)
          setNeedsSetup(false)
          onReady(next)
          return
        } catch {
          // Fall through to the original, more useful server error.
        }
      }
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    setError(null)
    try {
      await signOutCloud()
      setSnapshot(null)
      setNeedsSetup(false)
    } catch (reason) {
      setError(message(reason))
    } finally {
      setBusy(false)
    }
  }

  if (sessionLoading) return <CloudAuthCard title="Входим…"><p role="status">Проверяем защищённую сессию.</p></CloudAuthCard>
  if (!session) {
    return (
      <CloudAuthCard title="Вход для родителя">
        <p>Получите одноразовую ссылку на email. Пароль хранить не потребуется.</p>
        <form className="settingsForm" onSubmit={submitEmail}>
          <label><span>Email</span><input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Отправляем…' : 'Получить ссылку для входа'}</button>
        </form>
        {mailSent && <p role="status">Ссылка отправлена. Откройте её на этом устройстве.</p>}
        {(error || sessionError) && <p className="formError" role="alert">{error ?? sessionError}</p>}
      </CloudAuthCard>
    )
  }

  if (needsSetup) {
    return (
      <CloudAuthCard title="Создать семейное пространство">
        <p>Задайте имя ребёнка и локальный PIN для родительской панели.</p>
        <form className="settingsForm" onSubmit={createFamily}>
          <label><span>Имя ребёнка</span><input required minLength={1} maxLength={80} value={childName} onChange={(event) => setChildName(event.target.value)} /></label>
          <label><span>PIN из 4 цифр</span><input required type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" maxLength={4} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
          <label><span>Повторите PIN</span><input required type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" maxLength={4} value={confirmPin} onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, '').slice(0, 4))} /></label>
          {error && <p className="formError" role="alert">{error}</p>}
          <button className="button button--primary" type="submit" disabled={busy}>{busy ? 'Создаём…' : 'Создать пространство'}</button>
        </form>
        <button className="button button--secondary" type="button" onClick={() => { void signOut() }} disabled={busy}>Выйти</button>
      </CloudAuthCard>
    )
  }

  if (snapshot && readyContent) return <>{readyContent(snapshot)}</>
  return (
    <CloudAuthCard title={busy ? 'Загружаем семью…' : 'Родительская сессия готова'}>
      {error && <p className="formError" role="alert">{error}</p>}
      <button className="button button--secondary" type="button" onClick={() => { void signOut() }} disabled={busy}>Выйти</button>
    </CloudAuthCard>
  )
}

function CloudAuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="screen pinScreen" id="main-content">
      <section className="pinCard cloudAuthCard">
        <span className="eyebrow">Облачный режим</span>
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  )
}
