import { DEFAULT_PIN_SALT } from '../data/defaults'

export function generatePinSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hashPin(pin: string, salt = DEFAULT_PIN_SALT): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}${pin}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyPin(pin: string, expectedHash: string, salt = DEFAULT_PIN_SALT): Promise<boolean> {
  if (!/^\d{4}$/.test(pin)) return false
  return (await hashPin(pin, salt)) === expectedHash
}
