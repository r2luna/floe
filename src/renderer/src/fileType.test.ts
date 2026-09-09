import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileType } from './fileType.ts'

test('extensions decide the common cases', () => {
  assert.equal(fileType('src/main/agent.ts'), 'ts')
  assert.equal(fileType('src/App.tsx'), 'ts')
  assert.equal(fileType('scripts/build.mjs'), 'js')
  assert.equal(fileType('setup.sh'), 'shell')
  assert.equal(fileType('docs/plan.MD'), 'markdown')
})

test('whole names beat extensions', () => {
  assert.equal(fileType('package.json'), 'package')
  assert.equal(fileType('pnpm-lock.yaml'), 'lock')
  assert.equal(fileType('a/b/Dockerfile'), 'docker')
})

test('dotfiles are names, not extensions', () => {
  assert.equal(fileType('.env'), 'config')
  assert.equal(fileType('deploy/.env.production'), 'config')
  assert.equal(fileType('.gitignore'), 'git')
})

test('README is a prefix, whatever it is written in', () => {
  assert.equal(fileType('README'), 'book')
  assert.equal(fileType('README.md'), 'book')
  assert.equal(fileType('readme.rst'), 'book')
})

test('an unknown file is a plain page', () => {
  assert.equal(fileType('bin/floe'), 'file')
  assert.equal(fileType('notes.wat'), 'file')
})
