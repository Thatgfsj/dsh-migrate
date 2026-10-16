/**
 * Minimal, dependency-free ZIP reader/writer.
 *
 * Why hand-rolled: the deliverable is a single `.zip` that must open on Linux,
 * Windows and macOS, and the target machine may have no `zip`/7-Zip at all.
 * `node:zlib` gives us raw deflate; headers, the central directory and the
 * ZIP64 records are ~400 lines of well-specified binary format.
 *
 * Design notes
 * - Local headers carry **known** sizes (no data descriptors): each file payload
 *   is deflated into a temp file first, so memory stays bounded for multi-GB
 *   media while `unzip -t` / Explorer / Finder all stay happy.
 * - Method 8 (deflate) is used only when it actually shrinks the payload,
 *   otherwise method 0 (store) — videos are already compressed.
 * - UNIX mode bits travel in the external attributes, which is how executable
 *   bits and symlinks survive. Windows ignores them, so the manifest keeps an
 *   authoritative copy as well.
 * - Entry names are validated against `..`/`.` parts to make extraction
 *   zip-slip safe.
 *
 * @module dsh-migrate/core/zip
 */

import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  chmod, copyFile, lstat, mkdir, open, readdir, readlink, realpath, rm, stat, symlink,
} from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  createDeflateRaw, createInflateRaw, crc32 as zlibCrc32, deflateRawSync, inflateRawSync,
} from 'node:zlib'

// ---------------------------------------------------------------- constants

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const ZIP64_EOCD_SIG = 0x06064b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP64_EXTRA_ID = 0x0001

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

const UINT32_MAX = 0xffffffff
const UINT16_MAX = 0xffff

/** UNIX file-type bits (`st_mode`). */
export const S_IFMT = 0o170000
export const S_IFREG = 0o100000
export const S_IFDIR = 0o040000
export const S_IFLNK = 0o120000

// ------------------------------------------------------------------- crc32

let crcTable = null

function table() {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  return crcTable
}

/**
 * CRC-32 (IEEE 802.3). Uses the platform implementation when available.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(buffer) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(buffer) >>> 0
  const t = table()
  let c = UINT32_MAX
  for (let i = 0; i < buffer.length; i++) c = t[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ UINT32_MAX) >>> 0
}

function crc32Combine(previous, chunk) {
  if (typeof zlibCrc32 === 'function') return zlibCrc32(chunk, previous) >>> 0
  const t = table()
  let c = (previous ^ UINT32_MAX) >>> 0
  for (let i = 0; i < chunk.length; i++) c = t[(c ^ chunk[i]) & 0xff] ^ (c >>> 8)
  return (c ^ UINT32_MAX) >>> 0
}

/** A Writable that only counts bytes and CRCs them (no output). */
class CountingSink extends Writable {
  constructor() {
    super()
    this.count = 0
    this.crc = 0
  }

  _write(chunk, _encoding, callback) {
    this.count += chunk.length
    this.crc = crc32Combine(this.crc, chunk)
    callback()
  }
}

/** A Transform that CRC-checks in flight and forwards the chunks. */
class ThroughputCounter extends Transform {
  constructor() {
    super()
    this.count = 0
    this.crc = 0
  }

  _transform(chunk, _encoding, callback) {
    this.count += chunk.length
    this.crc = crc32Combine(this.crc, chunk)
    callback(null, chunk)
  }
}

// ------------------------------------------------------------- dos time/date

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function dosToDate(time, date) {
  return new Date(
    1980 + ((date >> 9) & 0x7f),
    ((date >> 5) & 0x0f) - 1,
    date & 0x1f,
    (time >> 11) & 0x1f,
    (time >> 5) & 0x3f,
    (time & 0x1f) * 2,
  )
}

// ------------------------------------------------------------------- writer

/** Reject absolute, drive-qualified and zip-slip entry names. */
export function normalizeEntryName(name) {
  const cleaned = String(name).replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned === '') throw new Error('zip entry name must not be empty')
  if (/^[a-zA-Z]:/.test(cleaned)) throw new Error(`unsafe zip entry name: ${name}`)
  if (cleaned.split('/').some((part) => part === '..' || part === '.')) {
    throw new Error(`unsafe zip entry name: ${name}`)
  }
  return cleaned
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (error) => (error ? reject(error) : resolve()))
  })
}

/**
 * Streaming ZIP writer.
 *
 * ```js
 * const zip = await ZipWriter.create('/tmp/out.zip')
 * await zip.addTree('/home/me/.dsh', { prefix: 'payload' })
 * const summary = await zip.close()
 * ```
 */
export class ZipWriter {
  #stream
  #offset = 0
  #entries = []
  #closed = false

  constructor(stream) {
    this.#stream = stream
  }

  /** @param {string} outPath destination archive */
  static async create(outPath) {
    await mkdir(dirname(outPath), { recursive: true })
    return new ZipWriter(createWriteStream(outPath))
  }

  /** Number of entries written so far. */
  get entryCount() {
    return this.#entries.length
  }

  /** Bytes written so far (including headers). */
  get bytesWritten() {
    return this.#offset
  }

  #assertOpen() {
    if (this.#closed) throw new Error('zip writer is already closed')
  }

  async #write(buffer) {
    await writeChunk(this.#stream, buffer)
    this.#offset += buffer.length
  }

  /**
   * Add one entry.
   *
   * @param {object} entry
   * @param {string} entry.name archive path ('/'-separated)
   * @param {'file'|'dir'|'symlink'} [entry.type]
   * @param {string} [entry.source] absolute source path (files)
   * @param {Buffer|string} [entry.content] literal payload (symlinks, small files)
   * @param {number} [entry.mode] UNIX permission bits
   * @param {Date} [entry.mtime]
   * @param {(bytes:number)=>void} [entry.onProgress] called once the payload is read
   */
  async add(entry) {
    this.#assertOpen()
    const name = normalizeEntryName(entry.name)
    const type = entry.type ?? 'file'
    const mode = entry.mode ?? (type === 'dir' ? 0o755 : 0o644)
    const mtime = entry.mtime ?? new Date()

    if (type === 'dir') {
      await this.#writeEntry({
        name: name.endsWith('/') ? name : `${name}/`,
        method: METHOD_STORE,
        crc: 0,
        compressedSize: 0,
        size: 0,
        unixMode: S_IFDIR | (mode & 0o7777),
        mtime,
      })
      return
    }

    if (type === 'symlink') {
      const target = Buffer.from(String(entry.content ?? entry.source ?? ''), 'utf8')
      await this.#writeEntry({
        name,
        method: METHOD_STORE,
        crc: crc32(target),
        compressedSize: target.length,
        size: target.length,
        unixMode: S_IFLNK | 0o777,
        mtime,
        payload: { kind: 'buffer', buffer: target },
      })
      return
    }

    const payload = entry.content !== undefined
      ? { kind: 'buffer', buffer: Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8') }
      : { kind: 'file', source: entry.source }
    await this.#writeEntry({
      name,
      method: METHOD_DEFLATE,
      crc: 0,
      compressedSize: 0,
      size: 0,
      unixMode: S_IFREG | (mode & 0o7777),
      mtime,
      payload,
      onProgress: entry.onProgress,
    })
  }

  /** Convenience wrapper: `addFile('a/b.txt', '/real/b.txt')`. */
  addFile(name, source, options = {}) {
    return this.add({ ...options, name, type: 'file', source })
  }

  /** Convenience wrapper: `addDirectory('payload/')`. */
  addDirectory(name, options = {}) {
    return this.add({ ...options, name, type: 'dir' })
  }

  async #writeEntry({ name, method, crc, compressedSize, size, unixMode, mtime, payload, onProgress }) {
    const nameBytes = Buffer.from(name, 'utf8')
    let chosenMethod = method
    let payloadSource = null
    let tmpPath = null

    try {
      if (payload?.kind === 'buffer') {
        const raw = payload.buffer
        const deflated = deflateRawSync(raw, { level: 6 })
        chosenMethod = deflated.length < raw.length ? METHOD_DEFLATE : METHOD_STORE
        crc = crc32(raw)
        size = raw.length
        payloadSource = { kind: 'buffer', buffer: chosenMethod === METHOD_DEFLATE ? deflated : raw }
        compressedSize = payloadSource.buffer.length
        onProgress?.(raw.length)
      } else if (payload?.kind === 'file') {
        const sink = new ThroughputCounter()
        const tmp = join(tmpdir(), `dsh-migrate-zip-${process.pid}-${randomBytes(6).toString('hex')}`)
        tmpPath = tmp
        await pipeline(createReadStream(payload.source), sink, createDeflateRaw({ level: 6 }), createWriteStream(tmp))
        const rawSize = sink.count
        const deflatedSize = (await stat(tmp)).size
        crc = sink.crc
        size = rawSize
        if (deflatedSize < rawSize) {
          chosenMethod = METHOD_DEFLATE
          compressedSize = deflatedSize
          payloadSource = { kind: 'tmp', path: tmp }
        } else {
          chosenMethod = METHOD_STORE
          compressedSize = rawSize
          payloadSource = { kind: 'file', source: payload.source }
        }
        onProgress?.(rawSize)
      }

      const header = buildLocalHeader({ nameBytes, method: chosenMethod, crc, compressedSize, size, unixMode, mtime })
      const offset = this.#offset
      await this.#write(header)
      const payloadOffset = this.#offset

      if (payloadSource?.kind === 'buffer') {
        await this.#write(payloadSource.buffer)
      } else if (payloadSource) {
        // Manual copy: `pipeline(..., dest, { end: false })` leaks listeners on the
        // shared output stream when thousands of entries are appended.
        for await (const chunk of createReadStream(payloadSource.path ?? payloadSource.source)) {
          await this.#write(chunk)
        }
        if (this.#offset - payloadOffset !== compressedSize) {
          throw new Error(`internal error: wrote ${this.#offset - payloadOffset} bytes for ${name}, expected ${compressedSize}`)
        }
      }

      this.#entries.push({ name, nameBytes, method: chosenMethod, crc, compressedSize, size, unixMode, mtime, offset })
    } finally {
      if (tmpPath) await rm(tmpPath, { force: true })
    }
  }

  /**
   * Add a directory tree recursively.
   *
   * @param {string} sourceDir
   * @param {{ prefix?: string, filter?: (relative:string, absolute:string)=>boolean,
   *           onProgress?: (bytes:number)=>void, followSymlinks?: boolean }} [options]
   *   `followSymlinks` defaults to true: symlinked payloads are materialized as
   *   real files so the archive stays portable. `false` stores symlink entries.
   */
  async addTree(sourceDir, options = {}) {
    const { prefix = '', filter, onProgress, followSymlinks = true } = options
    const walk = async (absolute, relative) => {
      const info = await lstat(absolute)
      const target = relative ? (prefix ? posix.join(prefix, relative) : relative) : prefix

      if (info.isDirectory()) {
        if (target) await this.add({ name: target, type: 'dir', mode: info.mode & 0o7777, mtime: info.mtime })
        const children = (await readdir(absolute)).sort()
        for (const child of children) {
          const childRelative = relative ? posix.join(relative, child) : child
          const childAbsolute = join(absolute, child)
          if (filter && !filter(childRelative, childAbsolute)) continue
          await walk(childAbsolute, childRelative)
        }
        return
      }

      if (info.isSymbolicLink()) {
        if (followSymlinks) {
          const resolved = await realpath(absolute)
          const info2 = await stat(resolved)
          if (info2.isDirectory()) {
            await walk(resolved, relative)
            return
          }
          await this.addFile(target, resolved, { mode: info2.mode & 0o7777, mtime: info2.mtime, onProgress })
          return
        }
        await this.add({ name: target, type: 'symlink', content: await readlink(absolute), mtime: info.mtime })
        return
      }

      if (info.isFile()) {
        await this.addFile(target, absolute, { mode: info.mode & 0o7777, mtime: info.mtime, onProgress })
      }
    }
    await walk(sourceDir, '')
  }

  /** Write the central directory and finish the archive. */
  async close() {
    this.#assertOpen()
    const cdStart = this.#offset
    for (const entry of this.#entries) await this.#write(buildCentralHeader(entry))
    const cdSize = this.#offset - cdStart
    await this.#write(buildEndOfCentralDirectory({ entryCount: this.#entries.length, cdSize, cdStart }))
    this.#stream.end()
    await once(this.#stream, 'finish')
    this.#closed = true
    return { entries: this.#entries.length, bytes: this.#offset }
  }
}

function buildLocalHeader({ nameBytes, method, crc, compressedSize, size, unixMode, mtime }) {
  const { time, date } = dosDateTime(mtime)
  const needsZip64 = size >= UINT32_MAX || compressedSize >= UINT32_MAX
  const extra = needsZip64 ? zip64Extra([size, compressedSize]) : Buffer.alloc(0)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(LOCAL_HEADER_SIG, 0)
  header.writeUInt16LE(needsZip64 ? 45 : 20, 4)
  header.writeUInt16LE(0x800, 6) // UTF-8 file names (bit 11)
  header.writeUInt16LE(method, 8)
  header.writeUInt16LE(time, 10)
  header.writeUInt16LE(date, 12)
  header.writeUInt32LE(crc >>> 0, 14)
  header.writeUInt32LE(needsZip64 ? UINT32_MAX : compressedSize, 18)
  header.writeUInt32LE(needsZip64 ? UINT32_MAX : size, 22)
  header.writeUInt16LE(nameBytes.length, 26)
  header.writeUInt16LE(extra.length, 28)
  return Buffer.concat([header, nameBytes, extra])
}

function buildCentralHeader(entry) {
  const { nameBytes, method, crc, compressedSize, size, unixMode, mtime, offset, name } = entry
  const { time, date } = dosDateTime(mtime)
  const isDir = name.endsWith('/')
  const needsZip64Size = size >= UINT32_MAX || compressedSize >= UINT32_MAX
  const needsZip64Offset = offset >= UINT32_MAX
  const fields = []
  if (needsZip64Size) fields.push(size, compressedSize)
  if (needsZip64Offset) fields.push(offset)
  const extra = fields.length > 0 ? zip64Extra(fields) : Buffer.alloc(0)
  const needsZip64 = needsZip64Size || needsZip64Offset

  const header = Buffer.alloc(46)
  header.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
  header.writeUInt16LE((3 << 8) | (needsZip64 ? 45 : 20), 4) // made by: UNIX
  header.writeUInt16LE(needsZip64 ? 45 : 20, 6)
  header.writeUInt16LE(0x800, 8)
  header.writeUInt16LE(method, 10)
  header.writeUInt16LE(time, 12)
  header.writeUInt16LE(date, 14)
  header.writeUInt32LE(crc >>> 0, 16)
  header.writeUInt32LE(needsZip64Size ? UINT32_MAX : compressedSize, 20)
  header.writeUInt32LE(needsZip64Size ? UINT32_MAX : size, 24)
  header.writeUInt16LE(nameBytes.length, 28)
  header.writeUInt16LE(extra.length, 30)
  header.writeUInt16LE(0, 32) // comment length
  header.writeUInt16LE(0, 34) // disk number
  header.writeUInt16LE(0, 36) // internal attributes
  header.writeUInt32LE((((unixMode >>> 0) << 16) | (isDir ? 0x10 : 0)) >>> 0, 38)
  header.writeUInt32LE(needsZip64Offset ? UINT32_MAX : offset, 42)
  return Buffer.concat([header, nameBytes, extra])
}

function zip64Extra(values) {
  const body = Buffer.alloc(8 * values.length)
  values.forEach((value, index) => body.writeBigUInt64LE(BigInt(value), index * 8))
  const header = Buffer.alloc(4)
  header.writeUInt16LE(ZIP64_EXTRA_ID, 0)
  header.writeUInt16LE(body.length, 2)
  return Buffer.concat([header, body])
}

function buildEndOfCentralDirectory({ entryCount, cdSize, cdStart }) {
  const parts = []
  if (entryCount >= UINT16_MAX || cdSize >= UINT32_MAX || cdStart >= UINT32_MAX) {
    const record = Buffer.alloc(56)
    record.writeUInt32LE(ZIP64_EOCD_SIG, 0)
    record.writeBigUInt64LE(BigInt(44), 4)
    record.writeUInt16LE((3 << 8) | 45, 12)
    record.writeUInt16LE(45, 14)
    record.writeUInt32LE(0, 16)
    record.writeUInt32LE(0, 20)
    record.writeBigUInt64LE(BigInt(entryCount), 24)
    record.writeBigUInt64LE(BigInt(entryCount), 32)
    record.writeBigUInt64LE(BigInt(cdSize), 40)
    record.writeBigUInt64LE(BigInt(cdStart), 48)
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(ZIP64_LOCATOR_SIG, 0)
    locator.writeUInt32LE(0, 4)
    locator.writeBigUInt64LE(BigInt(cdStart + cdSize), 8)
    locator.writeUInt32LE(1, 16)
    parts.push(record, locator)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(Math.min(entryCount, UINT16_MAX), 8)
  eocd.writeUInt16LE(Math.min(entryCount, UINT16_MAX), 10)
  eocd.writeUInt32LE(Math.min(cdSize, UINT32_MAX), 12)
  eocd.writeUInt32LE(Math.min(cdStart, UINT32_MAX), 16)
  eocd.writeUInt16LE(0, 20)
  parts.push(eocd)
  return Buffer.concat(parts)
}

// ------------------------------------------------------------------- reader

function findSignature(buffer, signature) {
  for (let i = buffer.length - 4; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === signature) return i
  }
  return -1
}

/**
 * Read the central directory of a ZIP file.
 *
 * @param {string} zipPath
 * @returns {Promise<{entries: Array<object>, comment: string}>}
 */
export async function listZip(zipPath) {
  const handle = await open(zipPath, 'r')
  try {
    const { size } = await handle.stat()
    if (size < 22) throw new Error(`not a zip file (too small): ${zipPath}`)
    const tailLength = Math.min(size, 66 * 1024)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, size - tailLength)
    const eocdIndex = findSignature(tail, EOCD_SIG)
    if (eocdIndex < 0) throw new Error(`not a zip file (no end-of-central-directory record): ${zipPath}`)

    let entryCount = tail.readUInt16LE(eocdIndex + 10)
    let cdSize = tail.readUInt32LE(eocdIndex + 12)
    let cdOffset = tail.readUInt32LE(eocdIndex + 16)
    const commentLength = tail.readUInt16LE(eocdIndex + 20)
    const comment = tail.subarray(eocdIndex + 22, eocdIndex + 22 + commentLength).toString('utf8')

    if (entryCount === UINT16_MAX || cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
      const locatorIndex = findSignature(tail, ZIP64_LOCATOR_SIG)
      if (locatorIndex >= 0) {
        const eocd64Offset = Number(tail.readBigUInt64LE(locatorIndex + 8))
        const header = Buffer.alloc(56)
        await handle.read(header, 0, 56, eocd64Offset)
        if (header.readUInt32LE(0) === ZIP64_EOCD_SIG) {
          entryCount = Number(header.readBigUInt64LE(32))
          cdSize = Number(header.readBigUInt64LE(40))
          cdOffset = Number(header.readBigUInt64LE(48))
        }
      }
    }

    const cd = Buffer.alloc(cdSize)
    if (cdSize > 0) await handle.read(cd, 0, cdSize, cdOffset)

    const entries = []
    let cursor = 0
    for (let index = 0; index < entryCount && cursor + 46 <= cd.length; index++) {
      if (cd.readUInt32LE(cursor) !== CENTRAL_HEADER_SIG) {
        throw new Error(`corrupt central directory at entry ${index} in ${zipPath}`)
      }
      const madeBy = cd.readUInt16LE(cursor + 4)
      const flags = cd.readUInt16LE(cursor + 8)
      const method = cd.readUInt16LE(cursor + 10)
      const time = cd.readUInt16LE(cursor + 12)
      const date = cd.readUInt16LE(cursor + 14)
      const crc = cd.readUInt32LE(cursor + 16)
      let compressedSize = cd.readUInt32LE(cursor + 20)
      let uncompressedSize = cd.readUInt32LE(cursor + 24)
      const nameLength = cd.readUInt16LE(cursor + 28)
      const extraLength = cd.readUInt16LE(cursor + 30)
      const commentLen = cd.readUInt16LE(cursor + 32)
      const externalAttributes = cd.readUInt32LE(cursor + 38)
      let localOffset = cd.readUInt32LE(cursor + 42)
      const name = cd.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
      const extra = cd.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)

      if (compressedSize === UINT32_MAX || uncompressedSize === UINT32_MAX || localOffset === UINT32_MAX) {
        let pointer = 0
        while (pointer + 4 <= extra.length) {
          const id = extra.readUInt16LE(pointer)
          const length = extra.readUInt16LE(pointer + 2)
          const body = extra.subarray(pointer + 4, pointer + 4 + length)
          if (id === ZIP64_EXTRA_ID) {
            let at = 0
            if (uncompressedSize === UINT32_MAX) { uncompressedSize = Number(body.readBigUInt64LE(at)); at += 8 }
            if (compressedSize === UINT32_MAX) { compressedSize = Number(body.readBigUInt64LE(at)); at += 8 }
            if (localOffset === UINT32_MAX) { localOffset = Number(body.readBigUInt64LE(at)); at += 8 }
          }
          pointer += 4 + length
        }
      }

      const mode = (madeBy >> 8) === 3 ? (externalAttributes >>> 16) & 0xffff : undefined
      entries.push({
        name,
        method,
        crc,
        compressedSize,
        uncompressedSize,
        localOffset,
        flags,
        mode,
        isDirectory: name.endsWith('/') || (mode !== undefined && (mode & S_IFMT) === S_IFDIR),
        isSymlink: mode !== undefined && (mode & S_IFMT) === S_IFLNK,
        mtime: dosToDate(time, date),
      })
      cursor += 46 + nameLength + extraLength + commentLen
    }
    return { entries, comment }
  } finally {
    await handle.close()
  }
}

async function entryDataStart(handle, entry) {
  const header = Buffer.alloc(30)
  await handle.read(header, 0, 30, entry.localOffset)
  if (header.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
    throw new Error(`bad local header for ${entry.name}`)
  }
  const nameLength = header.readUInt16LE(26)
  const extraLength = header.readUInt16LE(28)
  return entry.localOffset + 30 + nameLength + extraLength
}

async function hashEntry(handle, entry, zipPath) {
  // A zero-length payload has no byte range to read; its CRC is 0 by definition.
  if (entry.compressedSize === 0) return { bytes: 0, crc: 0 }
  const start = await entryDataStart(handle, entry)
  const end = start + entry.compressedSize - 1
  const source = createReadStream(zipPath, { start, end })
  const sink = new CountingSink()
  if (entry.method === METHOD_STORE) await pipeline(source, sink)
  else if (entry.method === METHOD_DEFLATE) await pipeline(source, createInflateRaw(), sink)
  else throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`)
  return { bytes: sink.count, crc: sink.crc }
}

async function readEntryBuffer(handle, entry) {
  const start = await entryDataStart(handle, entry)
  const compressed = Buffer.alloc(entry.compressedSize)
  if (entry.compressedSize > 0) await handle.read(compressed, 0, entry.compressedSize, start)
  if (entry.method === METHOD_STORE) return compressed
  if (entry.method === METHOD_DEFLATE) return inflateRawSync(compressed)
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`)
}

/**
 * Verify every entry: deflate integrity, CRC and declared size.
 *
 * @param {string} zipPath
 * @returns {Promise<{ok: boolean, entries: number, errors: string[], bytes: number}>}
 */
export async function verifyZip(zipPath) {
  const { entries } = await listZip(zipPath)
  const handle = await open(zipPath, 'r')
  const errors = []
  let bytes = 0
  try {
    for (const entry of entries) {
      if (entry.isDirectory) continue
      try {
        const data = await hashEntry(handle, entry, zipPath)
        if (data.crc !== entry.crc) errors.push(`CRC mismatch: ${entry.name}`)
        if (data.bytes !== entry.uncompressedSize) errors.push(`size mismatch: ${entry.name}`)
        bytes += data.bytes
      } catch (error) {
        errors.push(`${entry.name}: ${error.message}`)
      }
    }
  } finally {
    await handle.close()
  }
  return { ok: errors.length === 0, entries: entries.length, errors, bytes }
}

/**
 * Extract a ZIP into `destDir`.
 *
 * @param {string} zipPath
 * @param {string} destDir
 * @param {{ entries?: Array<object>, filter?: (entry:object)=>boolean,
 *           onEntry?: (entry:object, dest:string)=>void, preserveLinks?: boolean }} [options]
 * @returns {Promise<string[]>} extracted entry names
 */
export async function extractZip(zipPath, destDir, options = {}) {
  const { entries = (await listZip(zipPath)).entries, filter, onEntry, preserveLinks = true } = options
  const handle = await open(zipPath, 'r')
  const written = []
  try {
    for (const entry of entries) {
      if (filter && !filter(entry)) continue
      const destination = join(destDir, ...entry.name.split('/').filter(Boolean))
      if (entry.isDirectory) {
        await mkdir(destination, { recursive: true })
        onEntry?.(entry, destination)
        written.push(entry.name)
        continue
      }
      await mkdir(dirname(destination), { recursive: true })

      if (entry.isSymlink && preserveLinks) {
        const target = (await readEntryBuffer(handle, entry)).toString('utf8')
        await rm(destination, { force: true })
        await symlink(target, destination).catch(async () => {
          // Windows without Developer Mode: materialize the target when possible.
          const source = join(dirname(destination), target)
          const info = await stat(source).catch(() => null)
          if (info?.isFile()) await copyFile(source, destination)
          else await copyFile(join(dirname(destination), target), destination).catch(() => {})
        })
      } else {
        const counter = await streamEntryToFile(handle, entry, destination, zipPath)
        if (counter.crc !== entry.crc || counter.count !== entry.uncompressedSize) {
          await rm(destination, { force: true })
          throw new Error(`CRC/size mismatch while extracting: ${entry.name}`)
        }
      }

      if (entry.mode !== undefined && process.platform !== 'win32' && !entry.isSymlink) {
        await chmod(destination, entry.mode & 0o7777).catch(() => {})
      }
      onEntry?.(entry, destination)
      written.push(entry.name)
    }
  } finally {
    await handle.close()
  }
  return written
}

async function streamEntryToFile(handle, entry, destination, zipPath) {
  if (entry.compressedSize === 0) {
    await writeFile(destination, Buffer.alloc(0))
    return { count: 0, crc: 0 }
  }
  const start = await entryDataStart(handle, entry)
  const end = start + entry.compressedSize - 1
  const source = createReadStream(zipPath, { start, end })
  const counter = new ThroughputCounter()
  const sink = createWriteStream(destination)
  if (entry.method === METHOD_STORE) await pipeline(source, counter, sink)
  else if (entry.method === METHOD_DEFLATE) await pipeline(source, createInflateRaw(), counter, sink)
  else {
    await rm(destination, { force: true })
    throw new Error(`unsupported compression method ${entry.method}`)
  }
  return counter
}
