import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export function LocalQrInvite({ value, label = 'QR-код приглашения' }: { value: string; label?: string }) {
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    setSource(null)
    setError(false)
    void QRCode.toDataURL(value, { errorCorrectionLevel: 'M', margin: 2, width: 256 })
      .then((url) => { if (active) setSource(url) })
      .catch(() => { if (active) setError(true) })
    return () => { active = false }
  }, [value])

  if (error) return <p className="formError" role="alert">Не удалось создать QR-код. Используйте ссылку.</p>
  if (!source) return <p role="status">Создаём QR-код на устройстве…</p>
  return <img src={source} width="256" height="256" alt={label} />
}
