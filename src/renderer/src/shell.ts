// Colouring a shell command, for the bash rows in the transcript.
//
// Not Shiki: those rows are one line each, there are dozens of them in a
// session, and loading a WASM grammar to paint `ls -la` would cost more than
// the whole panel. This is the small subset that actually reads differently — the
// program, its flags, quoted strings, and the plumbing (pipes, redirects) — and
// it is a pure function of the string, so it is tested without a DOM.

export interface ShellToken {
  text: string
  /** The class the row paints it with, or '' for plain text. */
  cls: string
}

// Order matters: a quoted string swallows everything inside it, and `2>/dev/null`
// must match as one redirect before `2` reads as an argument.
const TOKEN =
  /("[^"]*"?|'[^']*'?)|(\|\||&&|[|;&])|(\d?>>?[^\s|;&]*|<[^\s|;&]*)|(--?[A-Za-z][\w-]*)|([^\s|;&<>"']+)/g

/**
 * Split a command into coloured tokens.
 *
 * The one piece of grammar here: the first word of the line, and the first word
 * after any operator, is the program being run. That is what makes the `find` in
 * `ls foo; find .` read as a command rather than as another argument.
 */
export function highlightShell(command: string): ShellToken[] {
  const out: ShellToken[] = []
  let last = 0
  let atStart = true
  TOKEN.lastIndex = 0
  let m: RegExpExecArray | null

  const push = (text: string, cls: string): void => {
    if (!text) return
    // Runs of the same class merge, so a row of plain arguments is one span
    // rather than one per word.
    const prev = out[out.length - 1]
    if (prev && prev.cls === cls) prev.text += text
    else out.push({ text, cls })
  }

  while ((m = TOKEN.exec(command))) {
    if (m.index > last) push(command.slice(last, m.index), '')
    const [, str, op, redir, flag, word] = m
    if (str !== undefined) push(str, 'sh-str')
    else if (op !== undefined) {
      push(op, 'sh-op')
      // What follows an operator is a new command.
      atStart = true
      last = m.index + m[0].length
      continue
    } else if (redir !== undefined) push(redir, 'sh-op')
    else if (flag !== undefined) push(flag, 'sh-flag')
    else if (word !== undefined) {
      push(word, atStart ? 'sh-cmd' : /^\d+([.,]\d+)*[a-z]?$/.test(word) ? 'sh-num' : '')
      // `sudo cmd` and `env FOO=1 cmd`: the word after them is still the program
      // being run, so the highlight follows it instead of stopping at the first
      // token of the line.
      atStart = word === 'sudo' || word === 'env' || word === 'time' || /^\w+=/.test(word)
    }
    last = m.index + m[0].length
  }
  if (last < command.length) push(command.slice(last), '')
  return out
}
