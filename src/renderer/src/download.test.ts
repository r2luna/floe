import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_DOWNLOAD_BYTES, SLICE, pullFile } from './download.ts'
import type { FileChunk } from '../../shared/types.ts'

/** A file on "another machine", answering the way main/files.ts does. */
function machineWith(bytes: Buffer, name = 'demo.bin') {
  const reads: Array<[number, number]> = []
  const read = async (start: number, length: number): Promise<FileChunk | null> => {
    reads.push([start, length])
    const slice = bytes.subarray(start, Math.min(start + length, bytes.length))
    return { name, size: bytes.length, start, end: start + slice.length - 1, base64: slice.toString('base64') }
  }
  return { read, reads }
}

test('a file that fits in one slice comes across whole', async () => {
  const bytes = Buffer.from('hello there')
  const { read, reads } = machineWith(bytes)
  const got = await pullFile(read)
  assert.equal(got.name, 'demo.bin')
  assert.equal(Buffer.from(got.base64, 'base64').toString(), 'hello there')
  assert.deepEqual(reads, [[0, SLICE]])
})

test('the slices join back into the same bytes, padding and all', async () => {
  // Two full slices and a short one — the case where joining base64 naively
  // would corrupt everything after the first piece if SLICE were not a
  // multiple of 3.
  const bytes = Buffer.alloc(SLICE * 2 + 7)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251
  const { read, reads } = machineWith(bytes)

  const got = await pullFile(read)
  assert.equal(reads.length, 3)
  assert.deepEqual(Buffer.from(got.base64, 'base64'), bytes)
})

test('an empty file is a download, not a hang', async () => {
  const { read, reads } = machineWith(Buffer.alloc(0))
  const got = await pullFile(read)
  assert.equal(got.base64, '')
  assert.equal(reads.length, 1)
})

test('a file that vanished mid-pull fails instead of opening half of it', async () => {
  let call = 0
  const read = async (start: number): Promise<FileChunk | null> => {
    if (call++ === 0) {
      const head = Buffer.alloc(SLICE)
      return { name: 'x.bin', size: SLICE * 2, start, end: SLICE - 1, base64: head.toString('base64') }
    }
    return null
  }
  await assert.rejects(pullFile(read), /not there any more/)
})

test('a slice short of the end of the file is refused, not joined', async () => {
  // Mid-file shortness would pad, and every byte after it would decode wrong —
  // an opened file that blames itself for the corruption.
  const read = async (start: number): Promise<FileChunk | null> => ({
    name: 'x.bin',
    size: SLICE * 2,
    start,
    end: start + 9,
    base64: Buffer.alloc(10).toString('base64')
  })
  await assert.rejects(pullFile(read), /read short/)
})

test('a file too big to hold in the tab is refused up front', async () => {
  const read = async (start: number): Promise<FileChunk | null> => ({
    name: 'huge.bin',
    size: MAX_DOWNLOAD_BYTES + 1,
    start,
    end: start + 2,
    base64: Buffer.alloc(3).toString('base64')
  })
  await assert.rejects(pullFile(read), /too big to bring across/)
})
