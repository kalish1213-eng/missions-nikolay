import { CloudRpcError, newIdempotencyKey } from './rpc'

interface StoredIntent<Payload = unknown> {
  operationId: string
  payload?: Payload
}

const PREFIX = 'missions-nikolay:cloud-intent:'
const memoryFallback = new Map<string, string>()

function storageKey(scope: string): string {
  return `${PREFIX}${encodeURIComponent(scope)}`
}

function read(scope: string): StoredIntent | null {
  const key = storageKey(scope)
  let serialized = memoryFallback.get(key) ?? null
  try {
    serialized = window.localStorage.getItem(key) ?? serialized
  } catch {
    // Private browsing can deny localStorage; the in-memory fallback still
    // protects retries for the lifetime of the current page.
  }
  if (!serialized) return null
  try {
    const parsed = JSON.parse(serialized) as Partial<StoredIntent>
    return typeof parsed.operationId === 'string' && parsed.operationId.length >= 16
      ? parsed as StoredIntent
      : null
  } catch {
    return null
  }
}

function write(scope: string, intent: StoredIntent): void {
  const key = storageKey(scope)
  const serialized = JSON.stringify(intent)
  memoryFallback.set(key, serialized)
  try {
    window.localStorage.setItem(key, serialized)
  } catch {
    // See read(): memory is an intentional, bounded fallback.
  }
}

function clear(scope: string, operationId: string): void {
  const key = storageKey(scope)
  if (read(scope)?.operationId !== operationId) return
  memoryFallback.delete(key)
  try {
    window.localStorage.removeItem(key)
  } catch {
    // Nothing else to do when storage is unavailable.
  }
}

function clearOnTerminalError(scope: string, operationId: string, error: unknown): void {
  if (error instanceof CloudRpcError && !error.retryable) clear(scope, operationId)
}

/**
 * Keeps one operation id until a response is observed. If the network drops
 * after the server commits, the user's next click replays the same RPC rather
 * than creating a duplicate award, task, adjustment or invite.
 */
export async function runIdempotentIntent<Result>(
  scope: string,
  send: (operationId: string) => Promise<Result>,
): Promise<Result> {
  const existing = read(scope)
  const operationId = existing?.operationId ?? newIdempotencyKey()
  if (!existing) write(scope, { operationId })
  try {
    const result = await send(operationId)
    clear(scope, operationId)
    return result
  } catch (error) {
    clearOnTerminalError(scope, operationId, error)
    throw error
  }
}

export async function runIdempotentPayloadIntent<Payload, Result>(
  scope: string,
  options: {
    createPayload: () => Promise<Payload>
    matches?: (payload: Payload) => boolean | Promise<boolean>
    send: (payload: Payload, operationId: string) => Promise<Result>
  },
): Promise<Result> {
  let intent = read(scope) as StoredIntent<Payload> | null
  if (intent?.payload === undefined || (options.matches && !(await options.matches(intent.payload)))) {
    if (intent) clear(scope, intent.operationId)
    intent = {
      operationId: newIdempotencyKey(),
      payload: await options.createPayload(),
    }
    write(scope, intent)
  }
  try {
    const result = await options.send(intent.payload as Payload, intent.operationId)
    clear(scope, intent.operationId)
    return result
  } catch (error) {
    clearOnTerminalError(scope, intent.operationId, error)
    throw error
  }
}
