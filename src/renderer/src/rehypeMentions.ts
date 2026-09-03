// `@codex` painted as a handle inside the assistant's markdown, too.
//
// The chat already draws handles in what YOU typed (MentionText in panels.tsx),
// and until now the model's side did not: its text goes through react-markdown,
// which has no idea what a nick is. So the one word you scan the line for —
// who this is addressed to — read as ordinary prose exactly when the model was
// the one addressing someone, which is the case that matters most now that a
// reply opening with `@codex` is really handed to codex (see shared/relay.ts).
//
// A rehype pass rather than a `components` override, because handles live in
// text nodes and react-markdown only lets you replace elements.

import { splitMentions } from './mentions.ts'
import { nickColor } from './nickColor.ts'

/** Nothing inside these is prose: a handle there is a literal, not an address. */
const SKIP = new Set(['code', 'pre', 'a'])

interface Node {
  type: string
  tagName?: string
  value?: string
  children?: Node[]
}

function chip(text: string, nick: string): Node {
  return {
    type: 'element',
    tagName: 'span',
    properties: { className: ['irc-mention'], style: `color: ${nickColor(nick)}` },
    children: [{ type: 'text', value: text }]
  } as Node
}

function walk(node: Node): void {
  if (!node.children) return
  if (node.tagName && SKIP.has(node.tagName)) return
  const out: Node[] = []
  for (const child of node.children) {
    if (child.type !== 'text' || typeof child.value !== 'string') {
      walk(child)
      out.push(child)
      continue
    }
    const parts = splitMentions(child.value)
    // The common case: no handle in this run. Push the node back as it was
    // rather than rebuilding an identical one.
    if (parts.length === 1 && parts[0].nick === undefined) {
      out.push(child)
      continue
    }
    for (const part of parts) {
      out.push(part.nick === undefined ? { type: 'text', value: part.text } : chip(part.text, part.nick))
    }
  }
  node.children = out
}

/** The plugin itself — `rehypePlugins={[rehypeMentions]}`. */
export function rehypeMentions() {
  return (tree: Node): void => walk(tree)
}
