// How much the agent is allowed to do — the one setting that changes what a
// turn can touch, and until now the only one nobody could set.
//
// Every harness has this concept and every harness spells it differently:
// Claude has `--permission-mode`, codex has a sandbox plus a collaboration
// mode, gemini has `--approval-mode`, opencode has an agent name. So the
// vocabulary is Claude's (it is already the type the IPC layer carries) and
// each runtime translates it at the point it builds its own arguments.
//
// A harness that cannot do a mode does not get a bad approximation of it: the
// mode is simply not offered, and picking that harness snaps the choice to the
// nearest thing it can honestly do.

import type { PermissionMode } from './types.ts'

export interface ModeInfo {
  id: PermissionMode
  /** What the picker and the composer chip say. Claude's ids are jargon. */
  label: string
  hint: string
}

/** Ordered lightest → heaviest. `nearestMode` walks this order. */
export const MODES: ModeInfo[] = [
  { id: 'plan', label: 'plan', hint: 'Reads and plans. Nothing on disk changes.' },
  { id: 'default', label: 'ask', hint: 'Asks before each tool that acts.' },
  { id: 'acceptEdits', label: 'auto', hint: 'Edits this worktree without asking.' },
  { id: 'skip', label: 'bypass', hint: 'No prompts, no sandbox. Anything goes.' }
]

export const DEFAULT_MODE: PermissionMode = 'default'

/**
 * What each runtime can actually do, not what we wish it did.
 *
 *  - claude    — all four, natively.
 *  - codex     — no "ask": its approval requests travel a channel we answer
 *                with a flat decline, so a mode that asks would wedge the turn.
 *  - gemini    — no "plan": `--approval-mode` has no read-only setting.
 *  - opencode  — `--agent plan|build`, and nothing that loosens the sandbox.
 *  - lmstudio  — an HTTP chat completion. No tools, so no mode to set.
 *  - ollama    — same.
 */
const SUPPORTED: Record<string, PermissionMode[]> = {
  claude: ['plan', 'default', 'acceptEdits', 'skip'],
  codex: ['plan', 'acceptEdits', 'skip'],
  gemini: ['default', 'acceptEdits', 'skip'],
  opencode: ['plan', 'acceptEdits'],
  lmstudio: [],
  ollama: []
}

/** The modes a runtime offers. Empty means the runtime has no tools at all. */
export function modesFor(provider?: string): PermissionMode[] {
  return SUPPORTED[provider ?? 'claude'] ?? SUPPORTED.claude
}

export function supportsMode(provider: string | undefined, mode: PermissionMode): boolean {
  return modesFor(provider).includes(mode)
}

/**
 * The closest mode this runtime can honestly do.
 *
 * Ties break toward the safer (lighter) mode: switching to codex with "ask"
 * picked lands on "plan", never on "auto". Nobody should get a wider blast
 * radius than they asked for because they changed harness.
 */
export function nearestMode(mode: PermissionMode, provider?: string): PermissionMode {
  const offered = modesFor(provider)
  // A runtime with no tools still has to send something down a channel typed
  // `PermissionMode`; it is ignored on the way out.
  if (!offered.length) return DEFAULT_MODE
  if (offered.includes(mode)) return mode
  const want = MODES.findIndex((m) => m.id === mode)
  const rank = (id: PermissionMode): number => {
    const at = MODES.findIndex((m) => m.id === id)
    // Distance first, then prefer the lighter side of a tie.
    return Math.abs(at - want) * 2 + (at > want ? 1 : 0)
  }
  return [...offered].sort((a, b) => rank(a) - rank(b))[0]
}

/** The label a mode shows as, for the composer chip and the menu. */
export function modeLabel(mode: PermissionMode): string {
  return MODES.find((m) => m.id === mode)?.label ?? mode
}

/**
 * The id behind a written mode name — `auto` → `acceptEdits`.
 *
 * floe.toml and the picker say "auto"; the CLIs say "acceptEdits". Nobody
 * should have to type a camel-cased flag name into a config file, so the file
 * takes the label and this turns it back. Ids are accepted too, so a config
 * written against the wire names still reads.
 */
export function modeFromLabel(label: string): PermissionMode | undefined {
  // "full" was the label for `skip` before the rename to "bypass"; configs and
  // saved choices written against it still have to read.
  if (label === 'full') return 'skip'
  return MODES.find((m) => m.label === label || m.id === label)?.id
}
