import type { CloudSnapshot } from '../types/cloud'

interface CacheEnvelope {
  version: 1
  savedAt: number
  snapshot: CloudSnapshot
}

function cacheKey(scope: string): string {
  const safeScope = scope.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)
  return `missions-nikolay:cloud-cache:${safeScope}`
}

function looksLikeSnapshot(value: unknown): value is CloudSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CloudSnapshot>
  return typeof candidate.appState === 'object'
    && candidate.appState !== null
    && typeof candidate.meta === 'object'
    && candidate.meta !== null
}

export function loadCachedCloudSnapshot(
  scope: string,
  storage: Pick<Storage, 'getItem'> = window.localStorage,
): CloudSnapshot | null {
  try {
    const raw = storage.getItem(cacheKey(scope))
    if (!raw) return null
    const envelope = JSON.parse(raw) as Partial<CacheEnvelope>
    if (envelope.version !== 1 || !looksLikeSnapshot(envelope.snapshot)) return null
    return envelope.snapshot
  } catch {
    return null
  }
}

export function saveCachedCloudSnapshot(
  scope: string,
  snapshot: CloudSnapshot,
  storage: Pick<Storage, 'setItem'> = window.localStorage,
): void {
  const envelope: CacheEnvelope = { version: 1, savedAt: Date.now(), snapshot }
  try {
    storage.setItem(cacheKey(scope), JSON.stringify(envelope))
  } catch {
    // A full/private storage area must not break the online application.
  }
}

export function clearCachedCloudSnapshot(
  scope: string,
  storage: Pick<Storage, 'removeItem'> = window.localStorage,
): void {
  storage.removeItem(cacheKey(scope))
}
