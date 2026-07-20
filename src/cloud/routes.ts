export type CloudRoute =
  | { kind: 'landing' }
  | { kind: 'parent' }
  | { kind: 'child' }
  | { kind: 'local' }
  | { kind: 'join'; inviteToken: string }
  | { kind: 'not-found' }

export function isSafeInviteToken(value: string): boolean {
  return value.length >= 20 && value.length <= 512 && /^[A-Za-z0-9._~-]+$/.test(value)
}

export function parseHashRoute(hash = window.location.hash): CloudRoute {
  const path = hash.replace(/^#/, '').replace(/^\/+/, '')
  if (!path) return { kind: 'landing' }

  const [segment, encodedToken, ...rest] = path.split('/')
  if ((segment === 'parent' || segment === 'setup') && !encodedToken) return { kind: 'parent' }
  if (segment === 'child' && !encodedToken) return { kind: 'child' }
  if (segment === 'local' && !encodedToken) return { kind: 'local' }
  if (segment !== 'join' && segment !== 'invite') return { kind: 'not-found' }
  if (!encodedToken || rest.length > 0) return { kind: 'not-found' }

  try {
    const inviteToken = decodeURIComponent(encodedToken)
    return isSafeInviteToken(inviteToken) ? { kind: 'join', inviteToken } : { kind: 'not-found' }
  } catch {
    return { kind: 'not-found' }
  }
}

export function routeHash(route: Exclude<CloudRoute, { kind: 'join' } | { kind: 'not-found' }>): string {
  return route.kind === 'landing' ? '#/' : `#/${route.kind}`
}

export function buildChildInviteUrl(baseUrl: string, token: string): string {
  if (!isSafeInviteToken(token)) throw new Error('Некорректный токен приглашения')
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = `/join/${encodeURIComponent(token)}`
  return url.toString()
}

/** Removes the one-time token from browser history so Back cannot reveal it. */
export function clearInviteTokenFromAddress(destination: '#/child' | '#/parent' = '#/child'): void {
  const clean = new URL(window.location.href)
  clean.hash = destination
  window.history.replaceState(window.history.state, '', clean)
}
