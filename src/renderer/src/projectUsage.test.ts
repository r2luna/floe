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

test('the most used project comes first', () => {
  resetProjectUsage()
  noteProjectUse('/b')
  noteProjectUse('/c')
  noteProjectUse('/c')
  assert.deepEqual(byUsage(['/a', '/b', '/c'], id), ['/c', '/b', '/a'])
})

test('projects never used keep the order they were given in', () => {
  resetProjectUsage()
  noteProjectUse('/z')
  assert.deepEqual(byUsage(['/x', '/y', '/z', '/w'], id), ['/z', '/x', '/y', '/w'])
})

test('the counts are saved to localStorage', () => {
  resetProjectUsage()
  noteProjectUse('/a')
  assert.deepEqual(JSON.parse(store.get('floe.projectUsage') ?? '{}'), { '/a': 1 })
})
