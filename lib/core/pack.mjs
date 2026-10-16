/**
 * 打包大肥鱼 — pack a DSH home into a single self-describing zip.
 *
 * Pipeline: scan -> secret self-check -> hash -> archive -> verify.
 * The archive contains exactly the scanned entries (never a re-walk), so what the
 * manifest lists is what the zip holds.
 *
 * @module dsh-migrate/core/pack
 */

import { mkdir, readFile, readdir, rm, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { scanHome } from './inventory.mjs'
import { buildManifest, collectSourceInfo, hashEntries, MANIFEST_ENTRY, sha256File } from './manifest.mjs'
import { assertArchiveIsClean, TOOLS_PREFIX } from './policy.mjs'
import { scanEntriesForSecrets } from './sensitive.mjs'
import { verifyZip, ZipWriter } from './zip.mjs'

// Re-exported so callers keep one import for "pack and its policy".
export { assertArchiveIsClean } from './policy.mjs'

/** Ordered phases with their slice of the overall progress bar. */
export const PACK_PHASES = [
  { phase: 'scan', from: 0, to: 10, label: '扫描 DSH home' },
  { phase: 'secrets', from: 10, to: 25, label: '密钥自检' },
  { phase: 'hash', from: 25, to: 50, label: '计算 sha256' },
  { phase: 'archive', from: 50, to: 95, label: '写入 zip' },
  { phase: 'verify', from: 95, to: 100, label: '校验归档' },
]

/** Errors thrown by the packer, with a machine-readable code. */
export class PackError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'PackError'
    this.code = code
    Object.assign(this, details)
  }
}

/** Build a progress emitter that maps phase-local progress onto 0-100. */
export function createProgress(onProgress) {
  return (phase, done = 0, total = 0, extra = {}) => {
    if (!onProgress) return
    const slice = PACK_PHASES.find((item) => item.phase === phase)
    const fraction = total > 0 ? Math.min(1, done / total) : 0
    const percent = slice ? Math.round(slice.from + (slice.to - slice.from) * fraction) : 0
    onProgress({ phase, label: slice?.label ?? phase, percent, done, total, ...extra })
  }
}

/**
 * Collect the files embedded for the target machine: the standalone restore tool
 * and a copy of this plugin (so the new machine can bootstrap itself).
 *
 * @param {{ toolingDir?: string, pluginDir?: string }} input
 * @returns {Promise<Array<{name: string, source: string, size: number, mode: number, mtime: string}>>}
 */
export async function collectTooling(input = {}) {
  const { toolingDir, pluginDir } = input
  const files = []
  const walk = async (source, name) => {
    const info = await stat(source)
    if (info.isFile()) {
      files.push({ name, source, size: info.size, mode: info.mode & 0o7777, mtime: info.mtime.toISOString() })
      return
    }
    if (!info.isDirectory()) return
    for (const child of (await readdir(source)).sort()) await walk(join(source, child), `${name}/${child}`)
  }
  if (toolingDir) {
    for (const child of (await readdir(toolingDir)).sort()) {
      await walk(join(toolingDir, child), `${TOOLS_PREFIX}/${child}`)
    }
  }
  if (pluginDir) {
    const manifest = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8'))
    const wanted = new Set(['package.json', ...(manifest.files ?? [])])
    for (const entry of [...wanted].sort()) await walk(join(pluginDir, entry), `${TOOLS_PREFIX}/plugin/${entry}`)
  }
  return files
}

async function assertFreeSpace(directory, neededBytes) {
  try {
    const info = await statfs(directory)
    const free = Number(info.bavail) * Number(info.bsize)
    if (Number.isFinite(free) && free < neededBytes * 1.1) {
      throw new PackError('DISK_SPACE', `not enough free space in ${directory}: need about ${neededBytes} bytes, have ${free}`, { free, needed: neededBytes })
    }
  } catch (error) {
    if (error instanceof PackError) throw error
    // statfs is best-effort: unsupported filesystems must not block a pack.
  }
}

/**
 * Pack a DSH home.
 *
 * @param {object} options
 * @param {string} options.home absolute DSH home
 * @param {string} options.outPath destination .zip
 * @param {boolean} [options.includeModels] include re-downloadable model caches
 * @param {boolean} [options.includeWorkspace] include workspace plugin sources (added by the caller)
 * @param {{name: string, version: string|null}} [options.generator]
 * @param {(event: object) => void} [options.onProgress]
 * @param {boolean} [options.verify] run a full CRC/sha pass over the produced zip
 * @param {() => Date} [options.now]
 * @returns {Promise<object>} pack report
 */
export async function pack(options) {
  const {
    home,
    outPath,
    includeModels = false,
    includeWorkspace = false,
    generator = { name: 'dsh-migrate', version: null },
    tooling: toolingInput,
    strictSecrets = false,
    onProgress,
    verify = true,
    now = () => new Date(),
  } = options ?? {}

  if (!home) throw new PackError('INVALID_ARGUMENT', 'pack: home is required')
  if (!outPath) throw new PackError('INVALID_ARGUMENT', 'pack: outPath is required')
  if (!String(outPath).toLowerCase().endsWith('.zip')) {
    throw new PackError('INVALID_ARGUMENT', `pack: outPath must end with .zip, got ${outPath}`)
  }

  const startedAt = Date.now()
  const emit = createProgress(onProgress)

  emit('scan', 0, 1)
  const scan = await scanHome(home, { includeModels, sourcePlatform: `${process.platform}-${process.arch}` })
  if (scan.entries.length === 0) {
    throw new PackError('EMPTY_HOME', `nothing to pack: no packable entries found under ${home}`)
  }
  emit('scan', 1, 1, { files: scan.entries.length, bytes: scan.totals.bytes })

  emit('secrets', 0, 1)
  const sensitiveScan = await scanEntriesForSecrets(home, scan.entries, {
    onProgress: (done, total) => emit('secrets', done, total),
  })
  // High-confidence hits are always fatal. Low-confidence hits (generic
  // `api_key = <value>` shapes that plausibly are literal secrets) are reported and
  // only fatal in strict mode — see issue #35 for why.
  const fatal = [...sensitiveScan.findings, ...(strictSecrets ? sensitiveScan.suspicious : [])]
  if (fatal.length > 0) {
    const list = fatal.slice(0, 10).map((finding) => `${finding.path}:${finding.line} (${finding.pattern}, ${finding.masked})`)
    throw new PackError(
      'SECRET_FOUND',
      `refusing to pack: ${fatal.length} credential-like value(s) found -> ${list.join('; ')}`,
      { findings: fatal, suspicious: sensitiveScan.suspicious },
    )
  }
  const secretWarnings = sensitiveScan.suspicious.map(
    (finding) => `可疑（低置信度，未中止）：${finding.path}:${finding.line} (${finding.pattern}, ${finding.masked})`,
  )
  emit('secrets', 1, 1)

  emit('hash', 0, 1)
  const { entries: hashedEntries } = await hashEntries(home, scan.entries, {
    onProgress: (done, total, bytes, totalBytes) => emit('hash', bytes, totalBytes, { files: done, filesTotal: total }),
  })
  emit('hash', 1, 1)

  // Embedded tooling (restore tool + plugin copy) is hashed like any other payload
  // and then listed separately, so it can never be mistaken for home content.
  const toolingFiles = await collectTooling(toolingInput ?? {})
  const tooling = []
  for (const file of toolingFiles) {
    tooling.push({ path: file.name, size: file.size, sha256: await sha256File(file.source) })
  }

  const source = await collectSourceInfo(home, { generator })
  const archiveName = outPath.split(/[\\/]/).pop()
  const manifest = buildManifest({
    scan,
    hashedEntries,
    source,
    archiveName,
    scope: { includeModels, includeWorkspace },
    sensitiveScan: { ...sensitiveScan, strict: strictSecrets },
    tooling,
    createdAt: now().toISOString(),
    rewriteSources: [home],
  })
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const estimatedBytes = manifest.totals.bytes + manifestBytes.length + 4096
  await mkdir(dirname(outPath), { recursive: true })
  await assertFreeSpace(dirname(outPath), estimatedBytes)

  const files = hashedEntries.filter((entry) => entry.type === 'file').sort((a, b) => (a.path < b.path ? -1 : 1))
  const directories = new Set()
  for (const entry of [...files, ...toolingFiles]) {
    // payload entries carry .path, tooling entries carry .name
    const parts = (entry.path ?? entry.name).split('/')
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'))
  }

  emit('archive', 0, files.length)
  let summary
  try {
    const zip = await ZipWriter.create(outPath)
    await zip.add({ name: MANIFEST_ENTRY, type: 'file', content: manifestBytes })
    for (const directory of [...directories].sort()) {
      await zip.add({ name: directory, type: 'dir' })
    }
    let writtenBytes = 0
    for (const [index, entry] of files.entries()) {
      await zip.addFile(entry.path, join(home, entry.path), {
        mode: entry.mode,
        mtime: new Date(entry.mtime),
        onProgress: (bytes) => { writtenBytes += bytes },
      })
      emit('archive', index + 1, files.length, { current: entry.path, writtenBytes })
    }
    for (const file of toolingFiles) {
      await zip.addFile(file.name, file.source, { mode: file.mode, mtime: new Date(file.mtime) })
    }
    summary = await zip.close()
  } catch (error) {
    // Never leave a half-written archive behind (cancellation, full disk, unreadable payload).
    await rm(outPath, { force: true }).catch(() => {})
    throw error
  }
  const { size } = await stat(outPath)

  emit('verify', 0, 1)
  let verification = { ok: true, checked: false }
  if (verify) {
    const listed = await import('./zip.mjs').then((module) => module.listZip(outPath))
    assertArchiveIsClean(listed.entries, { allowOptional: includeModels })
    const result = await verifyZip(outPath)
    if (!result.ok) {
      throw new PackError('VERIFY_FAILED', `archive failed verification: ${result.errors.slice(0, 5).join('; ')}`, { errors: result.errors })
    }
    verification = { ok: true, checked: true, entries: result.entries, bytes: result.bytes }
  } else {
    const listed = await import('./zip.mjs').then((module) => module.listZip(outPath))
    assertArchiveIsClean(listed.entries, { allowOptional: includeModels })
  }
  emit('verify', 1, 1)

  const expectedEntries = files.length + toolingFiles.length + directories.size + 1
  if (summary.entries !== expectedEntries) {
    throw new PackError('ENTRY_MISMATCH', `zip holds ${summary.entries} entries, expected ${expectedEntries}`)
  }

  return {
    ok: true,
    zipPath: outPath,
    archiveName,
    bytes: size,
    durationMs: Date.now() - startedAt,
    manifest,
    verification,
    sensitiveScan: {
      scanned: sensitiveScan.scanned,
      skipped: sensitiveScan.skipped.length,
      findings: sensitiveScan.findings.length,
      suspicious: sensitiveScan.suspicious.length,
      strict: strictSecrets,
    },
    report: {
      files: files.length,
      directories: directories.size,
      bytesPacked: manifest.totals.bytes,
      excluded: scan.excluded.length,
      optional: scan.optional.length,
      platformBound: manifest.platformBound.length,
      warnings: [...scan.warnings, ...secretWarnings],
    },
  }
}
