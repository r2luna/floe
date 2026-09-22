import { createContext } from 'react'

/**
 * How a shell block gets run. Provided by the chat panel (it knows the
 * worktree the terminal should open in); null anywhere else, and then the
 * block simply has no run button. A context rather than a prop threaded
 * through Log/Entry — Log is memoised on its items and a callback prop would
 * defeat that.
 *
 * Lives outside MessageBody.tsx so panels.tsx can keep this import static
 * while MessageBody itself (react-markdown and friends) loads lazily.
 */
export const RunInTerminal = createContext<((command: string) => void) | null>(null)

/**
 * Show what a message names — an HTML file, a URL — as a page.
 *
 * A page of this worktree opens in the file reader, which draws it; anything
 * else goes to the browser panel. Provided by the chat panel (it knows the
 * worktree a path is written against); absent where there is no worktree to
 * resolve one.
 */
export const PreviewInBrowser = createContext<((command: string) => void) | null>(null)
