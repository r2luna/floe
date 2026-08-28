import { useEffect, useState } from 'react'
import type { LocalAgent } from '../../shared/types'

/**
 * The other AI runtimes installed on this machine, read once per window.
 *
 * Once: installing a CLI mid-session is rare enough that re-probing on every
 * menu open would be work done for nobody. Reopening the app re-reads it.
 */
export function useLocalAgents(): LocalAgent[] {
  const [agents, setAgents] = useState<LocalAgent[]>([])
  useEffect(() => {
    void window.rookery.claude
      .localAgents()
      .then(setAgents)
      .catch(() => setAgents([]))
  }, [])
  return agents
}
