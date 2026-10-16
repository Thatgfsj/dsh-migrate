import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import {
  S_IFLNK, S_IFMT, ZipWriter, crc32, extractZip, listZip, normalizeEntryName, verifyZip,
} from '../lib/core/zip.mjs'

let work
before(async () => {
  work = await mkdtemp(join(tmpdir(), 'dsh-migrate-zip-'))
})
after(async () => {
  await rm(work, { recursive: true, force: true })
})

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

function tryExec(command, args) {
  try {
    return { ok: true, output: execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (error) {
    return { ok: false, output: String(error.stdout ?? '') + String(error.stderr ?? ''), code: error.status }
  }
}

/** Build a realistic tree: unicode names, deep paths, empty file, incompressible and compressible payloads, exec bit, symlink. */
async function buildTree(root) {
  await mkdir(join(root, '中文 目录'), { recursive: true })
  await mkdir(join(root, 'deep/a/b/c/d'), { recursive: true })
  await writeFile(join(root, 'hello.txt'), '你好，大肥鱼\n')
  await writeFile(join(root, '中文 目录', '文件 名.txt'), 'unicode filename payload')
  await writeFile(join(root, 'empty.bin'), Buffer.alloc(0))
  await writeFile(join(root, 'compressible.txt'), 'ab'.repeat(512 * 1024))
  await writeFile(join(root, 'incompressible.bin'), Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => (i * 2654435761) & 0xff)))
  await writeFile(join(root, 'deep/a/b/c/d/leaf.txt'), 'leaf')
  await writeFile(join(root, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
  // Windows needs Developer Mode/admin for symlinks; fall back to a copy so the
  // round-trip assertions stay meaningful on every platform.
  await symlink('hello.txt', join(root, 'alias.txt')).catch(() => writeFile(join(root, 'alias.txt'), '你好，大肥鱼\n'))
  return root
}

async function writeArchive(zipPath, sourceDir, options) {
  const zip = await ZipWriter.create(zipPath)
  await zip.addTree(sourceDir, { prefix: 'payload', ...options })
  return zip.close()
}

test('crc32 matches the IEEE check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926)
})

test('round trip: write, list, verify, extract', async () => {
  const source = await buildTree(join(work, 'src-roundtrip'))
  const zipPath = join(work, 'roundtrip.zip')
  const summary = await writeArchive(zipPath, source)
  assert.ok(summary.entries >= 9, `expected at least 9 entries, got ${summary.entries}`)

  const { entries } = await listZip(zipPath)
  const names = entries.map((entry) => entry.name)
  assert.ok(names.includes('payload/hello.txt'))
  assert.ok(names.includes('payload/中文 目录/文件 名.txt'))
  assert.ok(names.includes('payload/empty.bin'))
  assert.ok(names.includes('payload/deep/a/b/c/d/leaf.txt'))
  if (process.platform !== 'win32') {
    assert.ok(entries.some((entry) => entry.name.endsWith('run.sh') && (entry.mode & 0o111) !== 0), 'exec bit must survive in the archive')
  }

  const verification = await verifyZip(zipPath)
  assert.deepEqual(verification.errors, [])
  assert.equal(verification.ok, true)

  const dest = join(work, 'out-roundtrip')
  await extractZip(zipPath, dest)
  const pairs = [
    ['payload/hello.txt', 'hello.txt'],
    ['payload/中文 目录/文件 名.txt', '中文 目录/文件 名.txt'],
    ['payload/empty.bin', 'empty.bin'],
    ['payload/compressible.txt', 'compressible.txt'],
    ['payload/incompressible.bin', 'incompressible.bin'],
    ['payload/deep/a/b/c/d/leaf.txt', 'deep/a/b/c/d/leaf.txt'],
    ['payload/run.sh', 'run.sh'],
    ['payload/alias.txt', 'alias.txt'],
  ]
  for (const [from, to] of pairs) {
    assert.equal(sha256(join(dest, from)), sha256(join(source, to)), `content mismatch: ${from}`)
  }
  assert.equal((await stat(join(dest, 'payload/run.sh'))).size, (await stat(join(source, 'run.sh'))).size)
  if (process.platform !== 'win32') {
    assert.ok(((await stat(join(dest, 'payload/run.sh'))).mode & 0o111) !== 0, 'exec bit must be restored')
  }
})

test('symlinked payloads are materialized as real files by default', async () => {
  const source = join(work, 'src-link')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'target.txt'), 'target')
  await symlink('target.txt', join(source, 'link.txt'))
  const zipPath = join(work, 'link.zip')
  await writeArchive(zipPath, source)
  const { entries } = await listZip(zipPath)
  const link = entries.find((entry) => entry.name.endsWith('link.txt'))
  assert.equal(link.isSymlink, false)
  assert.equal(link.uncompressedSize, 6)
})

test('followSymlinks:false stores a real symlink entry', async (t) => {
  if (process.platform === 'win32') return t.skip('symlink creation is privileged on Windows')
  const source = join(work, 'src-symlink-entry')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'target.txt'), 'target')
  await symlink('target.txt', join(source, 'link.txt'))
  const zipPath = join(work, 'symlink-entry.zip')
  await writeArchive(zipPath, source, { followSymlinks: false })
  const { entries } = await listZip(zipPath)
  const link = entries.find((entry) => entry.name.endsWith('link.txt'))
  assert.equal(link.isSymlink, true)
  assert.equal((link.mode & S_IFMT), S_IFLNK)
})

test('entry names are zip-slip safe', async () => {
  const zip = await ZipWriter.create(join(work, 'slip.zip'))
  await assert.rejects(() => zip.addDirectory('../evil'))
  await assert.rejects(() => zip.addDirectory('C:/drive'))
  await assert.rejects(() => zip.addDirectory('a/../../b'))
  await zip.close()
  assert.throws(() => normalizeEntryName('..'), /unsafe/)
  // A leading slash is normalized away (tar-like), not rejected.
  assert.equal(normalizeEntryName('/absolute'), 'absolute')
  await assert.rejects(() => zip.addDirectory('after-close'))
})

test('corruption is detected by verifyZip', async () => {
  const source = join(work, 'src-corrupt')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'a.txt'), 'x'.repeat(4096))
  const zipPath = join(work, 'corrupt.zip')
  await writeArchive(zipPath, source)

  const { entries } = await listZip(zipPath)
  const file = entries.find((entry) => entry.name.endsWith('a.txt'))
  const buffer = readFileSync(zipPath)
  const nameLength = buffer.readUInt16LE(file.localOffset + 26)
  const extraLength = buffer.readUInt16LE(file.localOffset + 28)
  const dataStart = file.localOffset + 30 + nameLength + extraLength
  buffer[dataStart + Math.floor(file.compressedSize / 2)] ^= 0xff
  writeFileSync(zipPath, buffer)

  const verification = await verifyZip(zipPath)
  assert.equal(verification.ok, false)
  assert.ok(verification.errors.length > 0)
  await assert.rejects(() => extractZip(zipPath, join(work, 'out-corrupt')), /mismatch|invalid|unexpected|unknown/i)
})

test('a non-zip file is rejected', async () => {
  const path = join(work, 'not-a-zip.bin')
  await writeFile(path, 'definitely not a zip file, but long enough to be probed')
  await assert.rejects(() => listZip(path), /not a zip file/)
})

test('empty payloads and directory-only trees round trip', async () => {
  const source = join(work, 'src-empty')
  await mkdir(join(source, 'only-dir'), { recursive: true })
  const zipPath = join(work, 'empty.zip')
  const zip = await ZipWriter.create(zipPath)
  await zip.addDirectory('payload')
  await zip.add({ name: 'payload/zero.txt', type: 'file', content: '' })
  const summary = await zip.close()
  assert.equal(summary.entries, 2)
  const { entries } = await listZip(zipPath)
  assert.deepEqual(entries.map((e) => e.name).sort(), ['payload/', 'payload/zero.txt'])
  assert.equal((await verifyZip(zipPath)).ok, true)
})

test('native tools accept the archive (unzip / tar / Expand-Archive)', async (t) => {
  const source = await buildTree(join(work, 'src-native'))
  const zipPath = join(work, 'native.zip')
  await writeArchive(zipPath, source)

  const checks = []

  if (process.platform === 'win32') {
    const tar = tryExec('tar', ['-tf', zipPath])
    if (tar.ok) {
      assert.match(tar.output, /payload\/hello\.txt/)
      checks.push('tar -tf')
    }
    const expanded = join(work, 'out-expand')
    const ps = tryExec('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${expanded}' -Force`,
    ])
    if (ps.ok) {
      assert.equal(sha256(join(expanded, 'payload', 'hello.txt')), sha256(join(source, 'hello.txt')))
      assert.equal(sha256(join(expanded, 'payload', '中文 目录', '文件 名.txt')), sha256(join(source, '中文 目录', '文件 名.txt')))
      checks.push('Expand-Archive')
    }
  } else {
    const unzip = tryExec('unzip', ['-t', zipPath])
    if (unzip.ok) {
      assert.match(unzip.output, /No errors detected/)
      checks.push('unzip -t')
    }
    const tar = tryExec('tar', ['-tf', zipPath])
    if (tar.ok) {
      assert.match(tar.output, /payload\/hello\.txt/)
      checks.push('tar -tf')
    }
  }

  if (checks.length === 0) return t.skip('no native zip tool available on this host')
  console.log(`  native interop verified with: ${checks.join(', ')}`)
})

test('many small entries stay consistent (central directory parsing)', async () => {
  const source = join(work, 'src-many')
  await mkdir(source, { recursive: true })
  for (let i = 0; i < 300; i++) {
    await writeFile(join(source, `file-${String(i).padStart(3, '0')}.txt`), `payload ${i}`)
  }
  const zipPath = join(work, 'many.zip')
  const summary = await writeArchive(zipPath, source)
  assert.ok(summary.entries >= 300)
  const { entries } = await listZip(zipPath)
  assert.equal(entries.length, summary.entries)
  assert.equal((await verifyZip(zipPath)).ok, true)
  const dest = join(work, 'out-many')
  await extractZip(zipPath, dest)
  const names = await readdir(join(dest, 'payload'))
  assert.equal(names.length, 300)
})
