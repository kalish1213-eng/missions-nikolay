import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { getCloudSession, observeCloudSession } from '../cloud/api'
import { isCloudConfigured } from '../cloud/client'

export interface CloudSessionState {
  session: Session | null
  loading: boolean
  error: string | null
}

export function useCloudSession(): CloudSessionState {
  const configured = isCloudConfigured()
  const [state, setState] = useState<CloudSessionState>({
    session: null,
    loading: configured,
    error: configured ? null : 'Облачная синхронизация не настроена',
  })

  useEffect(() => {
    if (!configured) return
    let active = true
    void getCloudSession()
      .then((session) => { if (active) setState({ session, loading: false, error: null }) })
      .catch((error: unknown) => {
        if (active) setState({ session: null, loading: false, error: error instanceof Error ? error.message : 'Не удалось проверить вход' })
      })
    const subscription = observeCloudSession((_event, session) => {
      if (active) setState({ session, loading: false, error: null })
    })
    return () => {
      active = false
      void subscription.unsubscribe()
    }
  }, [configured])

  return state
}
