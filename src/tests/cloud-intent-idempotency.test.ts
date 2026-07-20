import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runIdempotentIntent, runIdempotentPayloadIntent } from '../cloud/idempotency'
import { CloudRpcError } from '../cloud/rpc'

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  readonly values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

describe('durable cloud mutation intents', () => {
  const originalWindow = globalThis.window

  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { localStorage: new MemoryStorage() },
    })
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    vi.restoreAllMocks()
  })

  it('reuses the operation id after a lost response and clears it after success', async () => {
    const operationIds: string[] = []
    await expect(runIdempotentIntent('award:task-1', async (operationId) => {
      operationIds.push(operationId)
      throw new Error('network response lost')
    })).rejects.toThrow('network response lost')

    await runIdempotentIntent('award:task-1', async (operationId) => {
      operationIds.push(operationId)
      return { replayed: true }
    })
    await runIdempotentIntent('award:task-1', async (operationId) => {
      operationIds.push(operationId)
      return { replayed: false }
    })

    expect(operationIds[1]).toBe(operationIds[0])
    expect(operationIds[2]).not.toBe(operationIds[1])
  })

  it('retains generated payload such as a PIN salt across a retry', async () => {
    const attempts: Array<{ id: string; salt: string }> = []
    const createPayload = vi.fn(async () => ({ salt: 'stable-salt', digest: 'digest' }))
    const options = {
      createPayload,
      matches: (payload: { salt: string }) => payload.salt === 'stable-salt',
      send: async (payload: { salt: string; digest: string }, operationId: string) => {
        attempts.push({ id: operationId, salt: payload.salt })
        if (attempts.length === 1) throw new Error('timeout')
        return true
      },
    }

    await expect(runIdempotentPayloadIntent('change-pin', options)).rejects.toThrow('timeout')
    await expect(runIdempotentPayloadIntent('change-pin', options)).resolves.toBe(true)

    expect(createPayload).toHaveBeenCalledTimes(1)
    expect(attempts[1]).toEqual(attempts[0])
  })

  it('clears a terminal validation failure so corrected input gets a new id', async () => {
    const operationIds: string[] = []
    await expect(runIdempotentIntent('settings', async (operationId) => {
      operationIds.push(operationId)
      throw new CloudRpcError('invalid value', '22023', false)
    })).rejects.toThrow('invalid value')
    await runIdempotentIntent('settings', async (operationId) => {
      operationIds.push(operationId)
      return true
    })
    expect(operationIds[1]).not.toBe(operationIds[0])
  })
})
