import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TranscriptItem } from '../../main/claudeSessions.ts'
import { setUserNick, speakerKey } from './models.ts'
import { actOwner, answeringWho, isAct, lastSpeaker, whoOf } from './speakers.ts'

setUserNick('rafael')

const user = (text = 'do it'): TranscriptItem => ({ role: 'user', text })
const bot = (model = 'claude-opus-5'): TranscriptItem => ({ role: 'assistant', text: 'done', model })
const bash = (): TranscriptItem => ({ role: 'tool', name: 'Bash', summary: 'ls' })
const typed = (): TranscriptItem => ({ role: 'tool', name: '/deploy', by: 'user' })

const key = (item: TranscriptItem): string => speakerKey(whoOf(item))

test('a tool call is the agent working', () => {
  assert.equal(isAct(bash()), true)
  assert.equal(isAct({ role: 'subagent', agentType: 'Explore' }), true)
})

test('a slash command you typed is not', () => {
  // The bug: it reloads as a tool row like any other, so without `by` the log
  // would head your own `/deploy` with the model's nick.
  assert.equal(isAct(typed()), false)
})

test('an image is neither — it belongs to whatever put it there', () => {
  // Attached images are pushed right after your message; a tool's images follow
  // the tool row that read them. Either way the header above is already right.
  assert.equal(isAct({ role: 'image', data: 'x' }), false)
})

test('calls that follow your message belong to whoever answers them', () => {
  // The reported bug: tool calls printed under the user's own header, so the
  // transcript read as if the user had run them.
  const items = [user(), bash(), bash(), bot()]
  assert.equal(speakerKey(actOwner(items, 1) as never), key(bot()))
})

test('a turn killed before it said anything still credits the agent', () => {
  const items = [user(), bot(), user(), bash()]
  assert.equal(speakerKey(actOwner(items, 3) as never), key(bot()))
})

test('with nobody to read it off, the work is credited to whoever is answering', () => {
  const pending = whoOf(bot('claude-sonnet-5'))
  const items = [user(), bash()]
  assert.equal(speakerKey(actOwner(items, 1, pending) as never), speakerKey(pending))
})

test('the model answering now is the streaming tail', () => {
  const who = answeringWho([user(), bot()], { role: 'assistant', text: '', model: 'gpt-5.6-sol' })
  assert.equal(who.host, 'gpt-5.6-sol')
})

test('with nothing streaming it is whoever answered last', () => {
  assert.equal(answeringWho([user(), bot()]).host, 'opus-5')
})

test('and in a session nobody has answered yet, the picker', () => {
  const who = answeringWho([user()], undefined, { model: 'haiku', effort: 'low' })
  assert.equal(speakerKey(who), 'claude!low@haiku')
})

test('the tail continues the run its tool calls opened', () => {
  // Both sides have to agree or one answer prints two headers: the Log heads
  // the calls with the agent, so the text that follows must not head again.
  const pending = whoOf(bot())
  assert.equal(lastSpeaker([user(), bash()], pending), speakerKey(pending))
})

test('a message of yours with nothing after it is still you', () => {
  assert.equal(lastSpeaker([bot(), user()], whoOf(bot())), key(user()))
})

test('a command you typed does not hand the floor to the model', () => {
  assert.equal(lastSpeaker([user(), typed()], whoOf(bot())), key(user()))
})

test('work after the agent spoke stays in the agent run', () => {
  assert.equal(lastSpeaker([user(), bot(), bash()], whoOf(bot())), key(bot()))
})

test('an empty transcript has no speaker to continue', () => {
  assert.equal(lastSpeaker([], whoOf(bot())), null)
})

test('a quoted voice does not get credited with the work around it', () => {
  // A subagent's report reloads as an assistant line carrying `from`. It is not
  // this session answering, so the calls beside it are not its calls.
  const report: TranscriptItem = { role: 'assistant', from: 'explore', text: 'found it' }
  const items = [user(), bash(), report, bot()]
  assert.equal(speakerKey(actOwner(items, 1) as never), key(bot()))
  assert.equal(answeringWho([user(), bot(), report]).host, 'opus-5')
})
