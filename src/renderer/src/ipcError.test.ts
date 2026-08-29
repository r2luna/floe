import assert from 'node:assert/strict'
import test from 'node:test'
import { reason } from './ipcError.ts'

test('an IPC rejection reads as the sentence the main process wrote', () => {
  const err = new Error(`Error invoking remote method 'skills:create': Error: "example" already exists`)
  assert.equal(reason(err), '"example" already exists')
})

test('the error class inside the wrapper goes too, whatever it is', () => {
  const err = new Error(`Error invoking remote method 'skills:rename': TypeError: name is not a string`)
  assert.equal(reason(err), 'name is not a string')
})

test('a local error is left exactly as it was written', () => {
  // Not everything shown to the user crossed IPC, and a message that happens to
  // start with "Error: " is the caller's own wording — trimming it would edit a
  // sentence nobody wrapped.
  assert.equal(reason(new Error('Error: could not read the file')), 'Error: could not read the file')
  assert.equal(reason(new Error('no editor configured')), 'no editor configured')
})

test('something that is not an Error still says something', () => {
  assert.equal(reason('plain string'), 'plain string')
  assert.equal(reason(new Error('   ')), 'something went wrong')
  assert.equal(reason(undefined), 'undefined')
})
