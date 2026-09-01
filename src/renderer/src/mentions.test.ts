import test from 'node:test'
import assert from 'node:assert/strict'
import { rosterOf, splitMentions } from './mentions.ts'
import type { TranscriptItem } from '../../main/claudeSessions.ts'

test('a handle is split out of the sentence around it', () => {
  assert.deepEqual(splitMentions('pede pro @codex revisar'), [
    { text: 'pede pro ' },
    { text: '@codex', nick: 'codex' },
    { text: ' revisar' }
  ])
})

test('an address is not a handle', () => {
  assert.deepEqual(splitMentions('manda pro rafael@lunardelli.me'), [
    { text: 'manda pro rafael@lunardelli.me' }
  ])
})

test('two handles in one line are two chips', () => {
  assert.deepEqual(
    splitMentions('@explore-3fa9 e @floe-8f acharam a mesma coisa').filter((p) => p.nick),
    [
      { text: '@explore-3fa9', nick: 'explore-3fa9' },
      { text: '@floe-8f', nick: 'floe-8f' }
    ]
  )
})

const roster = (items: TranscriptItem[]) =>
  rosterOf(items, { you: 'pinguim', model: 'claude', runtimes: ['codex'] }).map((h) => [h.nick, h.kind])

test('the channel always holds you and whoever is answering', () => {
  assert.deepEqual(roster([]), [
    ['pinguim', 'you'],
    ['claude', 'model'],
    ['codex', 'runtime']
  ])
})

test('everyone who spoke is addressable, newest first', () => {
  const items: TranscriptItem[] = [
    { role: 'user', text: 'faz aí' },
    { role: 'subagent', toolUseId: 'toolu_aa3f', agentType: 'Explore', summary: 'mapear', harness: 'claude' },
    { role: 'assistant', from: 'explore-aa3f', text: 'achei' },
    { role: 'user', from: 'floe-8f', text: 'não mexe em skills.ts' }
  ]
  assert.deepEqual(roster(items), [
    ['pinguim', 'you'],
    ['claude', 'model'],
    ['floe-8f', 'session'],
    ['explore-aa3f', 'agent'],
    ['codex', 'runtime']
  ])
})

test('a runtime that already spoke is listed once, as itself', () => {
  const items: TranscriptItem[] = [
    { role: 'subagent', toolUseId: 'codex:k:1', agentType: 'codex', harness: 'codex', summary: 'revisar' },
    { role: 'assistant', from: 'codex', text: 'P1 — o replay não guarda subagentes' }
  ]
  assert.deepEqual(roster(items), [
    ['pinguim', 'you'],
    ['claude', 'model'],
    ['codex', 'agent']
  ])
})
