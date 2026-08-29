// Moving a project between groups, with the keyboard.
//
// The panel shows groups in a fixed order and `j`/`k` walk the moving project
// through them, so the two things this needs are that order and a clamped step.
// Both are pure, and live here rather than in App, because "which group is one
// below Personal" is a rule worth testing without a lane, a panel or a DOM.

import { DEFAULT_GROUP } from '../../shared/types.ts'

/**
 * Every group the move can land in, in the order the panel draws them.
 *
 * Empty groups are included even though the list normally hides them: while a
 * move is running they are drawn, since a group you cannot see is one you
 * cannot move into — and an empty group with no way in would never fill up.
 */
export function moveTargets(groups: { name: string }[], groupNames: string[]): string[] {
  // Deduped, because the two sources overlap: `groupNames` holds every group the
  // app knows about, drawn or not, so a group with projects in it appears in
  // both. A name listed twice is two headings and two copies of the row being
  // carried — React keys the sections by name, and the duplicates survive the
  // move as stale sections.
  const seen = new Set<string>()
  const targets: string[] = []
  for (const name of [DEFAULT_GROUP, ...groups.map((g) => g.name), ...groupNames]) {
    if (seen.has(name)) continue
    seen.add(name)
    targets.push(name)
  }
  return targets
}

/**
 * The group `delta` steps from `from`. Clamped, not wrapped: holding `j` should
 * stop at the bottom rather than reappear at the top, which is what makes the
 * preview readable while you hold the key.
 */
export function stepGroup(targets: string[], from: string, delta: number): string {
  const at = targets.indexOf(from)
  if (at === -1) return targets[0] ?? from
  return targets[Math.max(0, Math.min(at + delta, targets.length - 1))] ?? from
}
