import { test } from 'node:test'
import assert from 'node:assert/strict'

import { byUsage, noteProjectUse, resetProjectUsage } from './projectUsage.ts'

const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
}

const id = (p: string): string => p

test('the most recently used project comes first', () => {
  resetProjectUsage()
  noteProjectUse('/b')
  noteProjectUse('/c')
  assert.deepEqual(byUsage(['/a', '/b', '/c'], id), ['/c', '/b', '/a'])
})

test('going back to an older project moves it to the top, however often the other was used', () => {
  resetProjectUsage()
  noteProjectUse('/b')
  noteProjectUse('/b')
  noteProjectUse('/c')
  noteProjectUse('/b')
  assert.deepEqual(byUsage(['/a', '/b', '/c'], id), ['/b', '/c', '/a'])
})

test('projects never used keep the order they were given in', () => {
  resetProjectUsage()
  noteProjectUse('/z')
  assert.deepEqual(byUsage(['/x', '/y', '/z', '/w'], id), ['/z', '/x', '/y', '/w'])
})

test('the order is saved to localStorage', () => {
  resetProjectUsage()
  noteProjectUse('/a')
  noteProjectUse('/b')
  assert.deepEqual(JSON.parse(store.get('floe.projectRecent') ?? '{}'), { '/a': 1, '/b': 2 })
})
