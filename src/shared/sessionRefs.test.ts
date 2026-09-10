import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collapseSessionRefs,
  expandSessionRefs,
  hasSessionRef,
  sessionSlug,
  wrapSessionRef,
  type SessionRef
} from './sessionRefs.ts'

const sessions: Record<string, SessionRef> = {
  'plugin-system-v2': {
    id: 'a1b2c3',
    harness: 'codex',
    title: 'plugin system v2',
    worktreePath: '/tmp/floe/wt/plugins'
  },
  'the-"merge"-bug': {
    id: 'd4e5f6',
    harness: 'claude',
    title: 'the "merge" bug',
    worktreePath: '/tmp/floe/wt/merge'
  }
}
const resolve = (slug: string): SessionRef | null => sessions[slug] ?? null

test('a known token expands to the id and the harness', () => {
  const out = expandSessionRefs('look at #plugin-system-v2 please', resolve)
  assert.ok(out.includes('a1b2c3'))
  assert.ok(out.includes('codex'))
  assert.ok(out.includes('/tmp/floe/wt/plugins'))
  assert.ok(out.startsWith('look at <floe-session '))
  assert.ok(out.endsWith(' please'))
})

test('a token naming no session is left alone', () => {
  // Which is also what keeps the same menu's file references intact: `#`
  // writes both, and only one of them is ours to rewrite.
  assert.equal(expandSessionRefs('#nobody', resolve), '#nobody')
  assert.equal(expandSessionRefs('see #src/main/turn.ts', resolve), 'see #src/main/turn.ts')
  assert.equal(expandSessionRefs('## Heading\ntext', resolve), '## Heading\ntext')
})

test('only at the start of a word', () => {
  assert.equal(expandSessionRefs('issue1#plugin-system-v2', resolve), 'issue1#plugin-system-v2')
})

test('two references in one message stay two blocks', () => {
  const out = expandSessionRefs('#plugin-system-v2 and #the-"merge"-bug', resolve)
  assert.equal(out.match(/<floe-session /g)?.length, 2)
  assert.equal(collapseSessionRefs(out), '#plugin-system-v2 and #the-"merge"-bug')
})

test('collapsing puts the message back the way it was typed', () => {
  const typed = 'compare #plugin-system-v2 with what we did'
  const sent = expandSessionRefs(typed, resolve)
  assert.notEqual(sent, typed)
  assert.ok(hasSessionRef(sent))
  assert.equal(collapseSessionRefs(sent), typed)
})

test('a quote in the title survives the round trip', () => {
  // The slug is a title, so it can hold the character that would end the
  // attribute carrying it.
  const sent = wrapSessionRef('the-"merge"-bug', sessions['the-"merge"-bug'])
  assert.ok(!sent.includes('ref="the-"'))
  assert.equal(collapseSessionRefs(sent), '#the-"merge"-bug')
})

test('plain text carries no expansion', () => {
  assert.equal(hasSessionRef('nothing here'), false)
  assert.equal(collapseSessionRefs('nothing here'), 'nothing here')
})

test('the slug is the title with its spaces closed up', () => {
  assert.equal(sessionSlug('plugin system v2'), 'plugin-system-v2')
  assert.equal(sessionSlug('two  spaces\nand a break'), 'two-spaces-and-a-break')
})
