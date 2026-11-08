// The Integrations rows in Settings: what is saved, and a way to save more. The
// status never holds a key, so nothing here can show one back.
import { useCallback, useEffect, useState } from 'react'
import type { IntegrationStatus } from '../../main/integrations'
import type { SourceId } from '../../shared/worktreeSource'

export interface Integrations {
  status: IntegrationStatus | null
  set: (source: SourceId, field: string, value: string) => void
  error: string | null
}

export function useIntegrations(): Integrations {
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.floe.integrations.status().then(setStatus)
  }, [])

  const set = useCallback((source: SourceId, field: string, value: string) => {
    setError(null)
    void window.floe.integrations
      .set(source, field, value)
      .then(setStatus)
      .catch((e: Error) => setError(e.message))
  }, [])

  return { status, set, error }
}
