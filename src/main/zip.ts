// Reading a zip, for the files that are one.
//
// A .pptx (and .docx, and .xlsx) is a zip of XML parts, so previewing one
// starts here. Node already ships the only hard part — raw deflate, in zlib —
// and the rest is the central directory, which is a fixed-width record we can
// walk. That is cheaper than a dependency: nothing here is compiled, nothing
// needs rebuilding per Electron version, and the browser build gets it too.
//
// Only what an Office part uses is supported: stored (0) and deflated (8)
// entries in a non-zip64 archive. Anything else is skipped rather than guessed
// at — a partial map is what the caller wants, since it asks for four parts out
// of a hundred.

import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

// The end-of-central-directory record is 22 bytes plus a comment of up to 64K,
// and it is the only way in: a zip is read back to front.
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - (22 + 0xffff))
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i
  }
  return -1
}

/**
 * The archive's entries, by name.
 *
 * `want` decides what to decompress: the whole central directory is walked
 * either way (it is a few kilobytes), but a 40MB deck's images are not inflated
 * to read its text.
 */
export function readZip(buf: Buffer, want?: (name: string) => boolean): Map<string, Buffer> {
  const out = new Map<string, Buffer>()
  const eocd = findEocd(buf)
  if (eocd < 0) return out

  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) break
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (want && !want(name)) continue
    // 0xffffffff in a size or an offset means the real value lives in a zip64
    // extra field. Office writes those only past 4GB; skip rather than misread.
    if (compressed === 0xffffffff || local === 0xffffffff) continue
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL_SIG) continue

    // The local header repeats the name and carries its own extra field, whose
    // length differs from the central one — this is why we re-read it here.
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const end = start + compressed
    if (end > buf.length) continue

    try {
      const raw = buf.subarray(start, end)
      out.set(name, method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : Buffer.alloc(0))
    } catch {
      /* one corrupt part must not lose the rest of the deck */
    }
  }
  return out
}
