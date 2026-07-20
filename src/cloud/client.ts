import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface CloudConfiguration {
  url: string
  publishableKey: string
}

let singleton: SupabaseClient | null = null

function readEnvironment(): Partial<CloudConfiguration> {
  return {
    url: import.meta.env.VITE_SUPABASE_URL?.trim(),
    publishableKey: (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY)?.trim(),
  }
}

export function getCloudConfiguration(): CloudConfiguration | null {
  const environment = readEnvironment()
  if (!environment.url || !environment.publishableKey) return null
  try {
    const url = new URL(environment.url)
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null
  } catch {
    return null
  }
  if (environment.publishableKey.startsWith('sb_secret_')) return null
  return { url: environment.url, publishableKey: environment.publishableKey }
}

export function isCloudConfigured(): boolean {
  return getCloudConfiguration() !== null
}

export function getSupabaseClient(): SupabaseClient {
  if (singleton) return singleton
  const config = getCloudConfiguration()
  if (!config) throw new Error('Облачная синхронизация не настроена')
  singleton = createClient(config.url, config.publishableKey, {
    auth: {
      flowType: 'pkce',
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'missions-nikolay:supabase-auth',
    },
    realtime: { params: { eventsPerSecond: 5 } },
  })
  return singleton
}

/** Test seam; production code should keep a single client for the whole tab. */
export function resetCloudClient(): void {
  singleton = null
}
