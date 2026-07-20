import { describe, expect, it } from 'vitest'
import {
  CloudOutbox,
  createMemoryOutboxStorage,
  type OutboxStorage,
} from '../cloud/outbox'

function sequentialIds() {
  let sequence = 0
  return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
}

describe('child submit outbox', () => {
  it('keeps one operation ID across a failed send and its retry', async () => {
    const outbox = new CloudOutbox(createMemoryOutboxStorage(), sequentialIds())
    const queued = outbox.enqueueTask('task-reading')
    const attempts: Array<{ operationId: string; attempts: number }> = []

    const first = await outbox.flush(async (item) => {
      attempts.push({ operationId: item.operationId, attempts: item.attempts })
      throw new Error('offline')
    })
    const second = await outbox.flush(async (item) => {
      attempts.push({ operationId: item.operationId, attempts: item.attempts })
    })

    expect(first).toEqual({ sent: 0, remaining: 1 })
    expect(second).toEqual({ sent: 1, remaining: 0 })
    expect(attempts).toEqual([
      { operationId: queued.operationId, attempts: 1 },
      { operationId: queued.operationId, attempts: 2 },
    ])
  })

  it('flushes FIFO and stops after the first failure', async () => {
    const outbox = new CloudOutbox(createMemoryOutboxStorage(), sequentialIds())
    outbox.enqueueTask('first')
    outbox.enqueueTask('second', 20)
    outbox.enqueueTask('third')
    const firstPass: string[] = []

    const partial = await outbox.flush(async (item) => {
      firstPass.push(item.taskId)
      if (item.taskId === 'second') throw new Error('temporary failure')
    })

    expect(firstPass).toEqual(['first', 'second'])
    expect(partial).toEqual({ sent: 1, remaining: 2 })
    expect(outbox.list().map((item) => [item.taskId, item.attempts])).toEqual([
      ['second', 1],
      ['third', 0],
    ])

    const retryPass: string[] = []
    await expect(outbox.flush(async (item) => {
      retryPass.push(item.taskId)
    })).resolves.toEqual({ sent: 2, remaining: 0 })
    expect(retryPass).toEqual(['second', 'third'])
  })

  it('replays an idempotent RPC after a response is lost without duplicating XP', async () => {
    const outbox = new CloudOutbox(createMemoryOutboxStorage(), sequentialIds())
    const queued = outbox.enqueueTask('task-exercise', 30)
    const committed = new Map<string, { awardedXp: number }>()
    let totalAwardedXp = 0
    let loseFirstResponse = true

    const idempotentRpc = async (operationId: string) => {
      const existing = committed.get(operationId)
      if (existing) return { ...existing, replayed: true }

      totalAwardedXp += 10
      const result = { awardedXp: 10 }
      committed.set(operationId, result)
      if (loseFirstResponse) {
        loseFirstResponse = false
        throw new Error('connection closed after commit')
      }
      return { ...result, replayed: false }
    }

    await outbox.flush((item) => idempotentRpc(item.operationId))
    expect(outbox.size).toBe(1)
    expect(totalAwardedXp).toBe(10)

    await expect(outbox.flush((item) => idempotentRpc(item.operationId))).resolves.toEqual({
      sent: 1,
      remaining: 0,
    })
    expect(committed.has(queued.operationId)).toBe(true)
    expect(totalAwardedXp).toBe(10)
  })

  it('ignores malformed or tampered records read from local storage', () => {
    const storage: OutboxStorage = {
      read: () => JSON.stringify([
        { kind: 'submit_task', operationId: '', taskId: 'empty-id', createdAt: 1, attempts: 0 },
        { kind: 'submit_task', operationId: 'valid', taskId: 'task', pushupCount: 15, createdAt: 1, attempts: 0 },
        { kind: 'other', operationId: 'wrong-kind', taskId: 'task', pushupCount: null, createdAt: 1, attempts: 0 },
      ]),
      write: () => undefined,
    }

    expect(new CloudOutbox(storage, sequentialIds()).list()).toEqual([])
  })

  it('rejects an empty task and supports explicit removal and clear', () => {
    const outbox = new CloudOutbox(createMemoryOutboxStorage(), sequentialIds())
    expect(() => outbox.enqueueTask('   ')).toThrow()

    const first = outbox.enqueueTask('first')
    outbox.enqueueTask('second')
    outbox.remove(first.operationId)
    expect(outbox.list().map((item) => item.taskId)).toEqual(['second'])

    outbox.clear()
    expect(outbox.size).toBe(0)
  })
})
