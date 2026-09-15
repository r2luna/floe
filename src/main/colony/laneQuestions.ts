// Whether a question from a lane is one nobody is going to answer.
//
// A lane's question normally IS the board's needs-you band: the card holds its
// spot until the user answers. On an autonomous task there is nobody to answer
// it, so a question asked anyway would park the card for as long as nobody
// looks. Both harnesses ask this before they surface one.

import { colonyConfig } from '../config/colony'
import { getCreatedSession } from '../sessionStore'
import { taskForSession } from './store'

/** What an autonomous lane hears instead of an answer. */
export const LANE_ANSWERS_ITSELF =
  'Nobody will answer this question: the task is on an autonomous colony board, and no user or manager is watching its lanes. ' +
  'Do not ask again. Take the recommended option — the brief\'s Decisions and Still open sections first, then the codebase and its ' +
  'conventions — record it in your artifact as (assumed), and keep going.'

/**
 * True when the session behind `key` is the lane currently running an
 * autonomous task. `key` may be the Floe session id or the harness's own.
 */
export function laneAnswersItself(key: string): boolean {
  const id = getCreatedSession(key)?.id ?? key
  const task = taskForSession(id)
  if (!task) return false
  // The task's own flag first, so a stated answer never reads the board files.
  return task.autonomous ?? colonyConfig(task.project).autonomous
}
