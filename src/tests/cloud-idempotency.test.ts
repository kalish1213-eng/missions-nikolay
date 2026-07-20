import { describe, expect, it } from 'vitest'

interface MockRpcResult {
  operationId: string
  replayed: boolean
  revision: number
  awardedXp: number
}

/**
 * Small transaction-shaped RPC double. It models the server contract expected
 * by the outbox: operation IDs are unique per mutation and the committed result
 * is replayed after a timeout instead of applying the side effect twice.
 */
function createIdempotentRpcMock() {
  const committed = new Map<string, Omit<MockRpcResult, 'replayed'>>()
  const inFlight = new Map<string, Promise<Omit<MockRpcResult, 'replayed'>>>()
  let revision = 0
  let totalAwardedXp = 0

  async function execute(
    operationId: string,
    options: { disconnectAfterCommit?: boolean } = {},
  ): Promise<MockRpcResult> {
    const replay = committed.get(operationId)
    if (replay) return { ...replay, replayed: true }

    const concurrent = inFlight.get(operationId)
    if (concurrent) return { ...(await concurrent), replayed: true }

    const transaction = Promise.resolve().then(() => {
      const existing = committed.get(operationId)
      if (existing) return existing

      revision += 1
      totalAwardedXp += 10
      const result = { operationId, revision, awardedXp: 10 }
      committed.set(operationId, result)
      return result
    })

    inFlight.set(operationId, transaction)

    try {
      const result = await transaction
      if (options.disconnectAfterCommit) throw new Error('network response lost after commit')
      return { ...result, replayed: false }
    } finally {
      inFlight.delete(operationId)
    }
  }

  return {
    execute,
    get totalAwardedXp() {
      return totalAwardedXp
    },
  }
}

describe('idempotent cloud mutation contract', () => {
  it('replays a committed result when the first response was lost', async () => {
    const rpc = createIdempotentRpcMock()
    const operationId = '11111111-1111-4111-8111-111111111111'

    await expect(rpc.execute(operationId, { disconnectAfterCommit: true })).rejects.toThrow(
      'network response lost',
    )

    await expect(rpc.execute(operationId)).resolves.toEqual({
      operationId,
      replayed: true,
      revision: 1,
      awardedXp: 10,
    })
    expect(rpc.totalAwardedXp).toBe(10)
  })

  it('serializes concurrent requests carrying the same operation ID', async () => {
    const rpc = createIdempotentRpcMock()
    const operationId = '22222222-2222-4222-8222-222222222222'
    const [first, duplicate] = await Promise.all([
      rpc.execute(operationId),
      rpc.execute(operationId),
    ])

    expect(first).toMatchObject({ operationId, replayed: false, revision: 1 })
    expect(duplicate).toMatchObject({ operationId, replayed: true, revision: 1 })
    expect(rpc.totalAwardedXp).toBe(10)
  })

  it('applies independent operation IDs independently', async () => {
    const rpc = createIdempotentRpcMock()

    await rpc.execute('33333333-3333-4333-8333-333333333333')
    await rpc.execute('44444444-4444-4444-8444-444444444444')

    expect(rpc.totalAwardedXp).toBe(20)
  })
})
