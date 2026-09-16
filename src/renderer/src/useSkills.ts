import { useCallback, useEffect, useState } from 'react'
import type { Skill } from '../../main/config/skills'

/**
 * The skills a worktree can use, kept current while the panel is open.
 *
 * A hook rather than state in App, for the reason the plans and settings panels
 * own theirs: the Skills panel is the only reader. It reloads on three signals
 * because there are three writers — the panel itself (through `reload`), an
 * editor or an agent writing the file (the config watcher, which is recursive
 * and so sees `skills/` too), and anything that happened while the window was
 * in the background.
 */
/**
 * Tell every open skills list to refetch. For writes the config watcher cannot
 * see: an import lands in the repo's `.floe/skills`, outside the config dir.
 */
export const SKILLS_CHANGED = 'floe:skills-changed'
export const skillsChanged = (): void => void window.dispatchEvent(new Event(SKILLS_CHANGED))

export interface Skills {
  all: Skill[]
  loading: boolean
  error?: string
  reload: () => void
}

export function useSkills(worktreePath?: string): Skills {
  const [all, setAll] = useState<Skill[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string>()
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    const stop = window.floe.config.onChange(reload)
    window.addEventListener('focus', reload)
    window.addEventListener(SKILLS_CHANGED, reload)
    return () => {
      stop()
      window.removeEventListener('focus', reload)
      window.removeEventListener(SKILLS_CHANGED, reload)
    }
  }, [reload])

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(undefined)
    window.floe.skills
      .list(worktreePath)
      .then((list) => live && setAll(list))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false))
    // Guard the late reply: switching project quickly must not land one
    // project's skills in a panel already showing another's.
    return () => {
      live = false
    }
  }, [worktreePath, tick])

  return { all, loading, error, reload }
}
