import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyDelta, createDrawing, listDrawings, mergeElements, promoteDrawing, readDrawing, watchDraw } from './index.ts'
import type { DrawElement, DrawScene } from '../../shared/types.ts'

const el = (id: string, version: number, extra: Partial<DrawElement> = {}): DrawElement => ({
  id,
  type: 'rectangle',
  version,
  versionNonce: 100,
  updated: Date.now(),
  ...extra
})

const sceneOf = (elements: DrawElement[]): DrawScene => ({
  type: 'excalidraw',
  version: 2,
  source: 'test',
  elements,
  appState: {},
  files: {}
})

function withWorktree(files: Record<string, string>, body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'floe-draw-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, content)
    }
    body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// --- mergeElements ---------------------------------------------------------

test('the higher version wins', () => {
  const out = mergeElements([el('a', 3, { x: 1 })], { upserts: [el('a', 4, { x: 2 })] })
  assert.equal(out.length, 1)
  assert.equal(out[0].x, 2)
  // …and the loser really does lose: an older write cannot undo a newer one.
  const back = mergeElements([el('a', 4, { x: 2 })], { upserts: [el('a', 3, { x: 1 })] })
  assert.equal(back[0].x, 2)
})

test('a tie is broken by the higher versionNonce', () => {
  const mine = el('a', 5, { versionNonce: 10, x: 1 })
  const theirs = el('a', 5, { versionNonce: 11, x: 2 })
  assert.equal(mergeElements([mine], { upserts: [theirs] })[0].x, 2)
  assert.equal(mergeElements([theirs], { upserts: [mine] })[0].x, 2, 'and it is symmetric')
})

test('a delete competes by version like any other upsert', () => {
  // The agent's erase (v4) lands over the user's edit (v3): gone.
  const erased = mergeElements([el('a', 3)], { upserts: [el('a', 4, { isDeleted: true })] })
  assert.equal(erased[0].isDeleted, true)
  // A stale erase (v2) does not undo a newer edit (v3).
  const kept = mergeElements([el('a', 3)], { upserts: [el('a', 2, { isDeleted: true })] })
  assert.equal(kept[0].isDeleted, undefined)
})

test('an unseen element is appended, and order is otherwise stable', () => {
  const out = mergeElements([el('a', 1), el('b', 1)], { upserts: [el('c', 1), el('a', 2)] })
  assert.deepEqual(out.map((e) => e.id), ['a', 'b', 'c'])
})

test('only tombstones older than a day are purged', () => {
  const now = Date.now()
  const day = 24 * 60 * 60 * 1000
  const scene = [
    el('fresh', 2, { isDeleted: true, updated: now - 60_000 }),
    el('stale', 2, { isDeleted: true, updated: now - day - 1 }),
    el('alive', 1, { updated: now - day * 30 })
  ]
  const out = mergeElements(scene, { upserts: [] }, now)
  assert.deepEqual(out.map((e) => e.id), ['fresh', 'alive'], 'a live element is never aged out')
})

// --- files -----------------------------------------------------------------

test('lists both sources, with a live element count', () => {
  const draft = JSON.stringify(sceneOf([el('a', 1), el('b', 1, { isDeleted: true })]))
  withWorktree(
    { '.floe/draw/scratch.excalidraw': draft, 'specs/draw/flow.excalidraw': JSON.stringify(sceneOf([el('a', 1)])) },
    (root) => {
      const rows = listDrawings(root, 'draw')
      assert.deepEqual(rows.map((r) => r.relPath), ['specs/draw/flow.excalidraw', '.floe/draw/scratch.excalidraw'])
      assert.equal(rows[0].group, 'draw', 'a spec drawing is grouped by its folder')
      assert.equal(rows[1].elements, 1, 'a tombstone is not an element anyone can see')
    }
  )
})

test('a corrupt scene is an error, never an empty one', () => {
  // An empty scene here would be autosaved back over the user's drawing.
  withWorktree({ '.floe/draw/broken.excalidraw': '{"type":"nope"}' }, (root) => {
    assert.throws(() => readDrawing(root, '.floe/draw/broken.excalidraw'), /not an Excalidraw scene/)
    assert.equal(listDrawings(root)[0].elements, 0, 'but the list still renders the row')
  })
})

test('a path outside the worktree is refused, one merely outside the curated dirs is not', () => {
  withWorktree(
    {
      '.floe/draw/ok.excalidraw': JSON.stringify(sceneOf([])),
      'brain/notes/fluxo.excalidraw': JSON.stringify(sceneOf([el('a', 1)]))
    },
    (root) => {
      assert.throws(() => readDrawing(root, '../../etc/passwd.excalidraw'), /outside the worktree/)
      assert.throws(() => readDrawing(root, '.floe/draw/notes.md'), /not a drawing/)
      // A drawing next to the note it illustrates opens like any other.
      assert.equal(readDrawing(root, 'brain/notes/fluxo.excalidraw').elements.length, 1)
    }
  )
})

test('applyDelta merges into the file and hands back what it wrote', () => {
  withWorktree({ '.floe/draw/s.excalidraw': JSON.stringify(sceneOf([el('a', 1, { x: 0 })])) }, (root) => {
    const rel = '.floe/draw/s.excalidraw'
    applyDelta(root, rel, { upserts: [el('a', 2, { x: 9 }), el('b', 1)] })
    const onDisk = JSON.parse(readFileSync(join(root, rel), 'utf8')) as DrawScene
    assert.deepEqual(onDisk.elements.map((e) => e.id), ['a', 'b'])
    assert.equal(onDisk.elements[0].x, 9)
    assert.equal(onDisk.type, 'excalidraw', 'still a scene any tool can open')
  })
})

test('two writes in a row cannot lose each other', () => {
  // The D5 case: the canvas autosaves an element the agent never saw, while the
  // agent writes one the canvas never saw. Both survive, because neither sends
  // a whole scene.
  withWorktree({ '.floe/draw/s.excalidraw': JSON.stringify(sceneOf([])) }, (root) => {
    const rel = '.floe/draw/s.excalidraw'
    applyDelta(root, rel, { upserts: [el('user-stroke', 1)] })
    const after = applyDelta(root, rel, { upserts: [el('agent-box', 1)] })
    assert.deepEqual(after.elements.map((e) => e.id), ['user-stroke', 'agent-box'])
  })
})

test('a new drawing lands in the project by default', () => {
  // specs/, not the gitignored scratch dir: a drawing is part of the work, so it
  // travels with the branch and turns up in the commit.
  withWorktree({ 'specs/draw/spec.md': '# spec' }, (root) => {
    const spec = createDrawing(root, 'flow', 'spec', 'draw')
    assert.equal(spec.relPath, 'specs/draw/flow.excalidraw', 'into the branch’s own spec folder')
    assert.equal(spec.group, 'draw')
    assert.deepEqual(readDrawing(root, spec.relPath).elements, [])

    // The escape hatch is explicit now.
    assert.equal(createDrawing(root, 'sketch', 'draft').relPath, '.floe/draw/sketch.excalidraw')
    // No double extension when the caller already spelled it out.
    assert.equal(createDrawing(root, 'named.excalidraw', 'draft').relPath, '.floe/draw/named.excalidraw')
  })
})

test('with no branch named, the worktree says which one it is on', () => {
  // A caller that has not looked up the branch still gets the right folder —
  // read straight off .git, because createDrawing may not yield.
  withWorktree({ '.git/HEAD': 'ref: refs/heads/feat/DOS-42\n', 'specs/dos-42/spec.md': '# spec' }, (root) => {
    assert.equal(createDrawing(root, 'flow').relPath, 'specs/dos-42/flow.excalidraw')
  })
})

test('a detached HEAD still gets a folder rather than an error', () => {
  withWorktree({ '.git/HEAD': 'a1b2c3d4\n' }, (root) => {
    assert.equal(createDrawing(root, 'flow').relPath, 'specs/draw/flow.excalidraw')
  })
})

test('promoting moves a draft into the project, and is idempotent', () => {
  withWorktree(
    { '.git/HEAD': 'ref: refs/heads/draw\n', '.floe/draw/s.excalidraw': JSON.stringify(sceneOf([el('a', 1)])) },
    (root) => {
      const moved = promoteDrawing(root, '.floe/draw/s.excalidraw')
      assert.equal(moved.relPath, 'specs/draw/s.excalidraw')
      assert.equal(moved.elements, 1, 'the drawing came with it, not just the name')
      // A move, not a copy: two homes is how the committed version and the one
      // you keep editing quietly drift apart.
      assert.throws(() => readDrawing(root, '.floe/draw/s.excalidraw'), /ENOENT/)
      // Promoting what is already there is the state you asked for, not an error.
      assert.equal(promoteDrawing(root, moved.relPath).relPath, moved.relPath)
    }
  )
})

test('promoting onto a name already taken refuses rather than overwrites', () => {
  withWorktree(
    {
      '.git/HEAD': 'ref: refs/heads/draw\n',
      '.floe/draw/s.excalidraw': JSON.stringify(sceneOf([el('mine', 1)])),
      'specs/draw/s.excalidraw': JSON.stringify(sceneOf([el('theirs', 1)]))
    },
    (root) => {
      assert.throws(() => promoteDrawing(root, '.floe/draw/s.excalidraw'), /already exists/)
      // And neither drawing was touched.
      assert.equal(readDrawing(root, 'specs/draw/s.excalidraw').elements[0].id, 'theirs')
      assert.equal(readDrawing(root, '.floe/draw/s.excalidraw').elements[0].id, 'mine')
    }
  )
})

// --- watching --------------------------------------------------------------

// Longer than the 150ms debounce, so "nothing arrived" really means nothing.
const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor(ready: () => boolean, ms = 4000): Promise<void> {
  const until = Date.now() + ms
  while (!ready()) {
    if (Date.now() > until) throw new Error('timed out waiting for draw:changed')
    await settle(20)
  }
}

test('watchDraw follows the active worktree and drops the one it left', async () => {
  const sent: Array<{ worktreePath: string }> = []
  const wc = {
    isDestroyed: () => false,
    send: (channel: string, payload: { worktreePath: string }) => {
      assert.equal(channel, 'draw:changed')
      sent.push(payload)
    }
  } as unknown as Parameters<typeof watchDraw>[0]

  const a = mkdtempSync(join(tmpdir(), 'floe-watch-a-'))
  const b = mkdtempSync(join(tmpdir(), 'floe-watch-b-'))
  // A worktree whose draft dir cannot be created watches nothing at all, which is
  // also how this test guarantees it leaves no watcher running behind it.
  const notADir = join(a, 'file')
  writeFileSync(notADir, 'not a directory')
  try {
    mkdirSync(join(a, 'specs/draw'), { recursive: true })
    watchDraw(wc, a)
    // A second call for the same worktree keeps the live watchers rather than
    // stacking a second pair on the same two directories.
    watchDraw(wc, a)
    // Creating the draft dir is itself a filesystem event; drop whatever it
    // produced so every assertion below is caused by a write we made.
    await settle()
    sent.length = 0

    // The draft dir is watched even though it did not exist when we asked —
    // watchDraw creates it, which is what makes the first drawing show up.
    writeFileSync(join(a, '.floe/draw/one.excalidraw'), '{}')
    await waitFor(() => sent.length > 0)
    assert.deepEqual(sent[0], { worktreePath: a }, 'the renderer is told which worktree changed')

    // specs/ is watched recursively: a drawing filed beside its spec counts too.
    sent.length = 0
    writeFileSync(join(a, 'specs/draw/flow.excalidraw'), '{}')
    await waitFor(() => sent.length > 0)
    assert.deepEqual(sent[0], { worktreePath: a })

    // Switching worktree retargets the one live watcher. b has no specs/ yet, so
    // that watcher is skipped and the draft one still covers it.
    watchDraw(wc, b)
    await settle()
    sent.length = 0
    writeFileSync(join(a, '.floe/draw/two.excalidraw'), '{}')
    await settle()
    assert.deepEqual(sent, [], 'the worktree we left is no longer watched')
    writeFileSync(join(b, '.floe/draw/one.excalidraw'), '{}')
    await waitFor(() => sent.length > 0)
    assert.deepEqual(sent[0], { worktreePath: b })

    sent.length = 0
    watchDraw(wc, notADir)
    writeFileSync(join(b, '.floe/draw/two.excalidraw'), '{}')
    await settle()
    assert.deepEqual(sent, [], 'the previous watchers were closed before it gave up')
  } finally {
    // Whatever failed above, nothing may still be watching when the test ends.
    watchDraw(wc, notADir)
    await settle()
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})
