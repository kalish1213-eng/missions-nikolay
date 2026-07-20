import { getSupabaseClient } from './client'
import type { CloudRpcArguments, CloudRpcName, CloudRpcResults } from '../types/cloud'

export class CloudRpcError extends Error {
  readonly code: string | null
  readonly retryable: boolean

  constructor(message: string, code: string | null, retryable: boolean) {
    super(message)
    this.name = 'CloudRpcError'
    this.code = code
    this.retryable = retryable
  }
}

function isRetryableCode(code: string | undefined): boolean {
  return !code || code === 'PGRST000' || code === 'PGRST001' || code.startsWith('08') || code === '57014'
}

export async function callCloudRpc<Name extends CloudRpcName>(
  name: Name,
  args: CloudRpcArguments[Name],
): Promise<CloudRpcResults[Name]> {
  const client = getSupabaseClient()
  const { data, error } = await client.rpc(name, args)
  if (error) {
    throw new CloudRpcError(error.message || 'Облачная операция не выполнена', error.code ?? null, isRetryableCode(error.code))
  }
  return data as CloudRpcResults[Name]
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID()
}
