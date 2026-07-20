import type { PushUpCount } from '../types'
import type { ChildSubmitOutboxItem } from '../types/cloud'

export interface OutboxStorage {
  read(): string | null
  write(value: string): void
}

export interface FlushResult {
  sent: number
  remaining: number
}

function isPushUpCount(value: unknown): value is PushUpCount {
  return value === 10 || value === 20 || value === 30 || value === 40 || value === 50
}

function isOutboxItem(value: unknown): value is ChildSubmitOutboxItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<ChildSubmitOutboxItem>
  return item.kind === 'submit_task'
    && typeof item.operationId === 'string'
    && item.operationId.length > 0
    && typeof item.taskId === 'string'
    && item.taskId.length > 0
    && (item.pushupCount === null || isPushUpCount(item.pushupCount))
    && typeof item.createdAt === 'number'
    && Number.isFinite(item.createdAt)
    && typeof item.attempts === 'number'
    && Number.isInteger(item.attempts)
    && item.attempts >= 0
}

function decodeItems(serialized: string | null): ChildSubmitOutboxItem[] {
  if (!serialized) return []
  try {
    const parsed: unknown = JSON.parse(serialized)
    return Array.isArray(parsed) ? parsed.filter(isOutboxItem).slice(0, 100) : []
  } catch {
    return []
  }
}

export function createMemoryOutboxStorage(initial: ChildSubmitOutboxItem[] = []): OutboxStorage {
  let serialized = JSON.stringify(initial)
  return {
    read: () => serialized,
    write: (value) => { serialized = value },
  }
}

export function createLocalOutboxStorage(
  scope: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
): OutboxStorage {
  const safeScope = scope.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 160)
  const key = `missions-nikolay:cloud-outbox:${safeScope}`
  return {
    read: () => storage.getItem(key),
    write: (value) => storage.setItem(key, value),
  }
}

/**
 * A tiny durable FIFO. An operation id is created once at enqueue time and is
 * reused for every retry, allowing the server RPC to be truly idempotent.
 */
export class CloudOutbox {
  readonly #storage: OutboxStorage
  readonly #createId: () => string

  constructor(storage: OutboxStorage, createId: () => string = () => crypto.randomUUID()) {
    this.#storage = storage
    this.#createId = createId
  }

  list(): ChildSubmitOutboxItem[] {
    return decodeItems(this.#storage.read())
  }

  get size(): number {
    return this.list().length
  }

  enqueueTask(taskId: string, pushupCount: PushUpCount | null = null): ChildSubmitOutboxItem {
    const cleanTaskId = taskId.trim()
    if (!cleanTaskId) throw new Error('Не указана миссия')
    const items = this.list()
    const item: ChildSubmitOutboxItem = {
      kind: 'submit_task',
      operationId: this.#createId(),
      taskId: cleanTaskId,
      pushupCount,
      createdAt: Date.now(),
      attempts: 0,
    }
    items.push(item)
    this.#save(items)
    return item
  }

  remove(operationId: string): void {
    this.#save(this.list().filter((item) => item.operationId !== operationId))
  }

  async flush(send: (item: ChildSubmitOutboxItem) => Promise<unknown>): Promise<FlushResult> {
    let sent = 0
    for (const current of this.list()) {
      const latest = this.list().find((item) => item.operationId === current.operationId)
      if (!latest) continue
      latest.attempts += 1
      this.#replace(latest)
      try {
        await send(latest)
        this.remove(latest.operationId)
        sent += 1
      } catch {
        break
      }
    }
    return { sent, remaining: this.size }
  }

  clear(): void {
    this.#save([])
  }

  #replace(updated: ChildSubmitOutboxItem): void {
    this.#save(this.list().map((item) => item.operationId === updated.operationId ? updated : item))
  }

  #save(items: ChildSubmitOutboxItem[]): void {
    this.#storage.write(JSON.stringify(items.slice(-100)))
  }
}
