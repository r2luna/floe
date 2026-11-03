import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Terminal } from '@xterm/xterm'
import { disposeTerminal } from './xtermDispose.ts'

const fakeCanvas = (calls: string[], webgl: boolean) => ({
  getContext: () =>
    webgl
      ? {
          getExtension: (name: string) => ({
            loseContext: () => calls.push(`lose ${name}`)
          })
        }
      : null
})

const fakeTerm = (calls: string[], canvases: unknown[] | null) =>
  ({
    element: canvases && { querySelectorAll: () => canvases },
    dispose: () => calls.push('dispose')
  }) as unknown as Terminal

test('disposeTerminal loses the WebGL context after the dispose', () => {
  const calls: string[] = []
  disposeTerminal(fakeTerm(calls, [fakeCanvas(calls, false), fakeCanvas(calls, true)]))
  assert.deepEqual(calls, ['dispose', 'lose WEBGL_lose_context'])
})

test('disposeTerminal still disposes a terminal that never opened', () => {
  const calls: string[] = []
  disposeTerminal(fakeTerm(calls, null))
  assert.deepEqual(calls, ['dispose'])
})
