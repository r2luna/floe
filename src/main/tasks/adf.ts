// Jira REST v3 returns rich text (e.g. an issue's `description`) as ADF — a
// nested JSON doc, not markdown — so a ReactMarkdown pane renders nothing unless
// we convert it. Walk the tree and emit markdown for the common node set.
// ponytail: covers text+marks, headings, lists, code, quotes, rules, links,
// mentions, emoji; exotic nodes (tables, media, panels) degrade to their inline
// text. Extend the switch if a real description needs more.
interface AdfNode {
  type: string
  text?: string
  content?: AdfNode[]
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  attrs?: Record<string, unknown>
}

function adfInline(node: AdfNode): string {
  if (node.type === 'text') {
    let t = node.text ?? ''
    for (const m of node.marks ?? []) {
      if (m.type === 'strong') t = `**${t}**`
      else if (m.type === 'em') t = `*${t}*`
      else if (m.type === 'code') t = `\`${t}\``
      else if (m.type === 'strike') t = `~~${t}~~`
      else if (m.type === 'link' && m.attrs?.href) t = `[${t}](${m.attrs.href})`
    }
    return t
  }
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'mention') return String(node.attrs?.text ?? '')
  if (node.type === 'emoji') return String(node.attrs?.text ?? node.attrs?.shortName ?? '')
  if (node.type === 'inlineCard' || node.type === 'card') return String(node.attrs?.url ?? '')
  return (node.content ?? []).map(adfInline).join('')
}

function adfBlocks(nodes: AdfNode[], depth = 0): string {
  const out: string[] = []
  for (const node of nodes) {
    switch (node.type) {
      case 'paragraph':
        out.push((node.content ?? []).map(adfInline).join(''))
        break
      case 'heading': {
        const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)))
        out.push('#'.repeat(level) + ' ' + (node.content ?? []).map(adfInline).join(''))
        break
      }
      case 'bulletList':
      case 'orderedList': {
        const ordered = node.type === 'orderedList'
        const pad = '  '.repeat(depth)
        const items = (node.content ?? []).map((li, i) => {
          const marker = ordered ? `${i + 1}.` : '-'
          const lines = adfBlocks(li.content ?? [], depth + 1).split('\n')
          return lines.map((l, idx) => (idx === 0 ? `${pad}${marker} ${l}` : `${pad}  ${l}`)).join('\n')
        })
        out.push(items.join('\n'))
        break
      }
      case 'codeBlock':
        out.push('```\n' + (node.content ?? []).map((c) => c.text ?? '').join('') + '\n```')
        break
      case 'blockquote':
        out.push(
          adfBlocks(node.content ?? [], depth)
            .split('\n')
            .map((l) => '> ' + l)
            .join('\n')
        )
        break
      case 'rule':
        out.push('---')
        break
      default:
        out.push((node.content ?? []).map(adfInline).join(''))
    }
  }
  return out.filter((s) => s.length > 0).join('\n\n')
}

export function adfToMarkdown(adf: unknown): string {
  if (!adf || typeof adf !== 'object') return typeof adf === 'string' ? adf : ''
  const doc = adf as AdfNode
  if (!Array.isArray(doc.content)) return ''
  return adfBlocks(doc.content).trim()
}
