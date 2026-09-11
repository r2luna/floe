// Turn a failed `git worktree add` into something a person can act on.
//
// git's refusals are accurate and unreadable ("cannot lock ref ... exists;
// cannot create ..."), and by the time one crosses Electron's IPC it has grown
// two more prefixes. The form that asked for the worktree is the only place
// that can explain it, so this maps the raw text to a sentence, git's own
// words, and — where one exists — a name that would have worked.

/** A refused worktree, as the form shows it. */
export interface WorktreeFailure {
  /** One sentence saying what git refused and why. */
  why: string
  /** Git's own words, kept verbatim — what you'd paste into a search. */
  raw: string
  /** A branch name that avoids the problem, when there is an obvious one. */
  suggestion?: string
}

/**
 * The git line out of whatever wrapped it. An IPC rejection arrives as
 * "Error invoking remote method 'worktrees:create': Error: Command failed:
 * git -C … \nfatal: …" — only the last line is git talking.
 */
function gitSays(message: string): string {
  const lines = message
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const loud = lines.filter((l) => l.startsWith('fatal:') || l.startsWith('error:'))
  if (loud.length) return loud.join(' ')
  const last = lines[lines.length - 1] ?? message.trim()
  return last
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(Error|Uncaught Error):\s*/, '')
    .replace(/^Command failed: git\b.*$/, 'git failed')
}

/** `refs/heads/feat` → `feat`. */
const short = (ref: string): string => ref.replace(/^refs\/heads\//, '')

/**
 * Diagnose a failed creation of `branch`.
 *
 * `message` is the raw error — from git, from IPC, or one of createWorktree's
 * own throws. Anything unrecognised still gets through: the fallback shows
 * git's line rather than swallowing it, because a message you can't parse is
 * still a message you can read.
 */
export function diagnoseWorktreeFailure(branch: string, message: string): WorktreeFailure {
  const raw = gitSays(message)

  // A branch is a FILE under .git/refs/heads. So `feat` and `feat/x` can never
  // both exist: one of them would have to be a directory. git reports it the
  // same way whichever side you hit it from.
  const clash = raw.match(/cannot lock ref '([^']+)': '([^']+)' exists/)
  if (clash) {
    const wanted = short(clash[1])
    const blocker = short(clash[2])
    const flat = branch.replace(/\//g, '-')
    // Blocked by a PARENT (`feat` blocking `feat/x`): flattening the name is a
    // real way out. Blocked by a CHILD (`feat/x` blocking `feat`), the name you
    // typed is the short one — there is nothing to flatten, so no suggestion.
    return blocker.length < wanted.length
      ? {
          why: `The branch ${blocker} already exists, so nothing can be created under ${blocker}/ — git keeps branches as files, and ${blocker} cannot be a file and a folder at once. Rename or delete ${blocker} first.`,
          raw,
          suggestion: flat === branch ? undefined : flat
        }
      : {
          why: `The branch ${blocker} already exists, so ${wanted} cannot — git keeps branches as files, and ${wanted} would have to be a folder to hold ${blocker}. Rename or delete ${blocker} first.`,
          raw
        }
  }

  const used = raw.match(/'([^']+)' is already used by worktree at '([^']+)'/)
  if (used) {
    return { why: `The branch ${used[1]} is already checked out at ${used[2]}.`, raw }
  }

  const invalid = raw.match(/invalid reference: (\S+)/)
  if (invalid) {
    return { why: `There is no ref named ${invalid[1]} here to branch from.`, raw }
  }

  if (/not a valid branch name|invalid branch name|invalid ref/i.test(raw)) {
    return { why: `git will not accept ${branch} as a branch name.`, raw }
  }

  // createWorktree's own throws — already in the app's voice, so they ARE the
  // sentence, and repeating them underneath as "git's words" would be noise.
  if (/^(Worktree already exists|Cannot derive a branch name)/.test(raw)) {
    return { why: raw, raw: '' }
  }

  if (/already exists/.test(raw)) {
    return { why: `Something is already at that path — ${branch} cannot be created over it.`, raw }
  }

  return { why: 'git refused to create the worktree.', raw }
}
