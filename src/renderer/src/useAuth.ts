import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AuthStatus,
  ClaudeAuthEvent,
  ClaudeStats,
  HarnessUsage,
  UsageStats
} from '../../shared/types'
import { parseResetHint } from '../../shared/resets'

export interface Auth {
  status: AuthStatus | null // null until the first read comes back
  /** Lifetime stats for that account. Read once beside the status. */
  stats: ClaudeStats | null
  /**
   * How much allowance each runtime has left, keyed by runtime id — Claude
   * included, under 'claude'. The account panel is the one place that asks,
   * because asking spawns (see main/localAgents.localUsage).
   */
  usage: Record<string, HarnessUsage>
  /**
   * Whether Claude's own probe is still out. It spawns a `claude` and takes
   * seconds, so without this the row sits blank long enough to read as a
   * runtime that reports nothing — which is what Codex's row looks like when
   * it genuinely reports nothing.
   */
  usageBusy: boolean
  /** Lifetime history for the other runtimes, keyed by runtime id. */
  harnessStats: Record<string, ClaudeStats>
  /** The consent URL, while a login is waiting for its code. */
  url?: string
  busy: boolean
  error?: string
  login: (mode?: 'claudeai' | 'console') => void
  paste: (code: string) => void
  cancel: () => void
  logout: () => void
  reload: () => void
}

/**
 * The Claude account this app's CLI runs as — read once, then driven by the
 * login flow's events (see main/claudeAuth.ts).
 *
 * The flow always needs the code from the consent page: there is no loopback
 * callback to complete it silently, so `url` staying set is the panel's cue to
 * ask for the paste.
 */
export function useAuth(): Auth {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [stats, setStats] = useState<ClaudeStats | null>(null)
  const [usage, setUsage] = useState<Record<string, HarnessUsage>>({})
  const [usageBusy, setUsageBusy] = useState(false)
  // How many probes are still out. A count, not a boolean: the main process
  // answers a second request while the first is running by handing back its
  // cached reading at once, so the fast one would otherwise clear the flag
  // while the slow one — the one actually fetching — is still going.
  const probes = useRef(0)
  const [harnessStats, setHarnessStats] = useState<Record<string, ClaudeStats>>({})
  const [url, setUrl] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const reload = useCallback(() => {
    void window.floe.claude.authStatus().then(setStatus)
    // Signing in or out changes whose stats these are, so both are read from
    // the same place — the panel never shows one account's numbers under
    // another's name.
    void window.floe.claude.stats().then(setStats)
    // Claude's windows and the other runtimes' come from different places but
    // mean the same thing, so they are merged into one shape here rather than
    // in the panel — the panel should not know who reports what.
    void window.floe.claude.localStats().then(setHarnessStats)
    void window.floe.claude.localUsage().then((others) =>
      setUsage((prev) => ({ ...prev, ...others }))
    )
    const showClaude = (u: UsageStats | null): boolean => {
      if (!u) return false
      const windows: HarnessUsage['windows'] = []
      if (u.session) windows.push({ label: '5h', usedPercent: u.session.pct, resetsAt: parseResetHint(u.session.resetsAt) })
      if (u.week) windows.push({ label: 'week', usedPercent: u.week.pct, resetsAt: parseResetHint(u.week.resetsAt) })
      if (!windows.length) return false
      setUsage((prev) => ({ ...prev, claude: { windows } }))
      return true
    }
    // Paint the last reading first — it costs no spawn and is seconds old at
    // worst — then replace it with the fresh one when the probe lands.
    probes.current += 1
    setUsageBusy(true)
    void window.floe.stats.lastUsage().then(showClaude)
    void window.floe.stats
      .refreshUsage()
      .then(showClaude)
      .finally(() => {
        probes.current -= 1
        if (probes.current === 0) setUsageBusy(false)
      })
  }, [])

  useEffect(reload, [reload])

  useEffect(() => {
    return window.floe.claude.onAuthEvent((event: ClaudeAuthEvent) => {
      if (event.kind === 'url') return setUrl(event.url)
      // Every other event ends the flow, so the shared teardown runs first and
      // only the message differs.
      setBusy(false)
      setUrl(undefined)
      if (event.kind === 'signed-in') {
        setError(undefined)
        reload()
      } else if (event.kind === 'timeout') {
        setError('Timed out waiting for the code')
      } else {
        setError(event.message)
      }
    })
  }, [reload])

  return {
    status,
    stats,
    usage,
    usageBusy,
    harnessStats,
    url,
    busy,
    error,
    login: (mode = 'claudeai') => {
      setError(undefined)
      setBusy(true)
      void window.floe.claude.login(mode)
    },
    paste: (code) => void window.floe.claude.pasteLoginCode(code),
    cancel: () => {
      setBusy(false)
      setUrl(undefined)
      void window.floe.claude.cancelLogin()
    },
    logout: () => {
      void window.floe.claude.logout().then(reload)
    },
    reload
  }
}
