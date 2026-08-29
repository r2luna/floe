// The keymap, resolved.
//
// The rules themselves live in `shared/defaultKeymap.ts` as data, so the app can
// print them into `~/.config/floe/keybindings.toml` and read the user's version
// back. What stays here is the seam the renderer calls: a pure function from a
// key press to a command id, with no DOM in sight, which is what keeps every
// rule — which modifier wins, what a chord does, what a bare letter means while
// you are typing — testable without a browser.

import { DEFAULT_KEYMAP } from '../../shared/defaultKeymap.ts'
import {
  compileKeymap,
  resolveIn,
  type CompiledBind,
  type KeyContext,
  type KeyInput,
  type Resolved
} from '../../shared/keymap.ts'

export type { KeyContext, KeyInput, Resolved }

const defaults = compileKeymap(DEFAULT_KEYMAP)

// The bindings in force. Starts as the defaults so the app is usable before the
// main process has read the user's file, and is swapped once for the merged set
// (see `setKeymap`) rather than threaded through every call site.
let active: CompiledBind[] = defaults

/** Install the user's bindings. Called once at boot, and again on a file change. */
export function setKeymap(binds: CompiledBind[] | null): void {
  active = binds && binds.length ? binds : defaults
}

/**
 * A key resolves to a COMMAND ID, never to behaviour. That is what keeps the
 * keymap, the command palette and the MCP `run_command` tool describing the
 * same app: all three name commands from the registry in commands.ts.
 */
export function resolveKey(e: KeyInput, ctx: KeyContext = {}): Resolved | null {
  return resolveIn(active, e, ctx)
}
