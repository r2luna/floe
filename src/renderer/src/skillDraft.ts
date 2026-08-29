// The one-way channel from a skill command to the skills panel.
//
// Creating and renaming are things you do IN the list — pick a scope under the
// `+`, type the name on the row — so the panel owns the flow. But the commands
// that start it are reached three ways (the `n`/`r` keys, the header button, the
// right-click menu), and a registry command must not close over React state.
//
// So the panel registers a sink while it is mounted and the command calls this.
// A request that arrives before the panel is up is HELD rather than dropped:
// `skill.new` from the command palette opens the panel and asks in the same
// breath, and the panel mounts a frame later. Same shape as `sendToTerminal`.

export type SkillDraft = { kind: 'new' } | { kind: 'rename'; name: string }

let sink: ((draft: SkillDraft) => void) | null = null
let waiting: SkillDraft | null = null

/** The panel takes over while it is mounted. Returns its unsubscribe. */
export function onSkillDraft(fn: (draft: SkillDraft) => void): () => void {
  sink = fn
  if (waiting) {
    const held = waiting
    waiting = null
    fn(held)
  }
  return () => {
    if (sink === fn) sink = null
  }
}

/** Ask the panel to start a draft — from a key, the header button, or the menu. */
export function startSkillDraft(draft: SkillDraft): void {
  // Only one is ever pending: two requests before the panel mounts means the
  // second is what the user asked for last.
  if (sink) sink(draft)
  else waiting = draft
}
