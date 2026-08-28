import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArtifactSpec, seedSelection, serializeArtifact, type ArtifactSpec } from './artifact.ts'

const valid: unknown = {
  type: 'decision',
  title: 'Make "Needs Input" visible',
  subtitle: 'Five compact treatments',
  groups: [
    {
      id: 'width',
      label: 'Width',
      select: 'single',
      options: [
        { id: 'wide', label: 'Wide' },
        { id: 'narrow', label: 'Narrow' }
      ],
      default: 'wide'
    },
    {
      id: 'theme',
      label: 'Theme',
      select: 'multi',
      options: [
        { id: 'light', label: 'Light' },
        { id: 'dark', label: 'Dark' }
      ]
    }
  ],
  items: [
    { id: 'signal-rail', title: 'Signal rail', note: '4px edge + dot', recommended: true },
    { id: 'inverted-lead', title: 'Inverted lead' }
  ]
}

test('parseArtifactSpec: accepts a well-formed spec', () => {
  const spec = parseArtifactSpec(valid)
  assert.ok(spec)
  assert.equal(spec.groups.length, 2)
  assert.equal(spec.items?.length, 2)
  assert.equal(spec.groups[0].default, 'wide')
})

test('parseArtifactSpec: rejects broken specs (graceful fallback)', () => {
  assert.equal(parseArtifactSpec(null), null)
  assert.equal(parseArtifactSpec({ type: 'nope', title: 'x', groups: [] }), null)
  assert.equal(parseArtifactSpec({ type: 'decision', title: 'x', groups: [] }), null) // empty groups
  assert.equal(
    parseArtifactSpec({ type: 'decision', title: 'x', groups: [{ id: 'g', label: 'G', select: 'single', options: [] }] }),
    null
  ) // empty options
  assert.equal(parseArtifactSpec({ type: 'decision', title: 42, groups: [] }), null)
})

test('seedSelection: seeds defaults + recommended pick', () => {
  const spec = parseArtifactSpec(valid) as ArtifactSpec
  const sel = seedSelection(spec)
  assert.deepEqual(sel.groups.width, ['wide'])
  assert.deepEqual(sel.groups.theme, [])
  assert.equal(sel.pick, 'signal-rail')
  assert.deepEqual(sel.shortlist, ['signal-rail'])
})

test('serializeArtifact: builds a readable follow-up message', () => {
  const spec = parseArtifactSpec(valid) as ArtifactSpec
  const msg = serializeArtifact(spec, {
    groups: { width: ['narrow'], theme: ['light'] },
    shortlist: ['signal-rail', 'inverted-lead'],
    pick: 'signal-rail'
  })
  assert.match(msg, /Width: Narrow/)
  assert.match(msg, /Theme: Light/)
  assert.match(msg, /Shortlisted: Signal rail, Inverted lead/)
  assert.match(msg, /Pick: Signal rail/)
})
