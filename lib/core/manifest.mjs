/**
 * Manifest construction for a 大肥鱼 archive.
 *
 * The manifest is the archive's contract with the target machine: it records what
 * was packed, from which machine, with which runtimes, plus a sha256 for every
 * payload file and the platform-bound items that will *not* be valid elsewhere.
 * Everything in it is measured at pack time — never hardcoded.
 *
 * @module dsh-migrate/core/manifest
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { arch, hostname, platform, release } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

/** Name of the manifest entry inside the archive. */
export const MANIFEST_ENTRY = 'manifest.json'

/** Bumped whenever the manifest shape changes incompatibly. */
export const MANIFEST_SCHEMA_VERSION = 1

const execFileAsync = promisify(execFile)

/**
 * Streaming sha256 of a file.
 *
 * @param {string} path
 * @returns {Promise<string>} lowercase hex digest
 */
export async function sha256File(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** e.g. `linux-x64` — the key used to describe platform-bound payloads. */
export function platformKey(target = process) {
  return `${target.platform}-${target.arch}`
}

async function probeVersion(command, args = ['--version']) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5000, windowsHide: true })
    return String(stdout).trim().split('\n')[0] || null
  } catch {
    return null
  }
}

/**
 * Describe the machine the archive was produced on.
 *
 * @param {string} home DSH home that was scanned
 * @param {{ generator?: {name: string, version: string} }} [extra]
 */
export async function collectSourceInfo(home, extra = {}) {
  const [pnpm, dsh] = await Promise.all([probeVersion('pnpm'), probeVersion('dsh')])
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    platformKey: platformKey(),
    osRelease: release(),
    node: process.versions.node,
    pnpm,
    dsh,
    home,
    generator: extra.generator ?? null,
  }
}

/**
 * Hash every file entry, with bounded concurrency.
 *
 * @param {string} home
 * @param {Array<object>} entries inventory entries (type === 'file')
 * @param {{ concurrency?: number, onProgress?: (done:number,total:number)=>void }} [options]
 * @returns {Promise<{entries: Array<object>, bytes: number, totalBytes: number}>}
 */
export async function hashEntries(home, entries, options = {}) {
  const { concurrency = 8, onProgress } = options
  const files = entries.filter((entry) => entry.type === 'file')
  const totalBytes = files.reduce((sum, entry) => sum + entry.size, 0)
  const hashed = new Array(files.length)
  let cursor = 0
  let done = 0
  let bytes = 0

  const worker = async () => {
    for (;;) {
      const index = cursor++
      if (index >= files.length) return
      const entry = files[index]
      hashed[index] = { ...entry, sha256: await sha256File(join(home, entry.path)) }
      done++
      bytes += entry.size
      onProgress?.(done, files.length, bytes, totalBytes)
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, files.length || 1)) }, worker))
  return { entries: hashed, bytes, totalBytes }
}

/**
 * Assemble the manifest object.
 *
 * @param {object} input
 * @returns {object} JSON-serialisable manifest
 */
export function buildManifest(input) {
  const {
    scan, hashedEntries, source, archiveName, scope, sensitiveScan, createdAt = new Date().toISOString(),
  } = input

  const platformBound = hashedEntries
    .filter((entry) => entry.platformBound?.length)
    .map((entry) => ({ path: entry.path, platforms: entry.platformBound, evidence: entry.platformEvidence ?? '' }))

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    entry: MANIFEST_ENTRY,
    generator: source.generator ?? { name: 'dsh-migrate', version: null },
    createdAt,
    archive: { name: archiveName, compression: 'deflate-or-store', zip64: true },
    source,
    scope: {
      includeModels: scope?.includeModels === true,
      includeWorkspace: scope?.includeWorkspace === true,
      excludeWorkspacePaths: scope?.excludeWorkspacePaths ?? [],
    },
    totals: {
      files: hashedEntries.filter((entry) => entry.type === 'file').length,
      bytes: hashedEntries.reduce((sum, entry) => sum + entry.size, 0),
      bytesByCategory: scan.totals.byCategory,
      excluded: scan.excluded.length,
      optional: scan.optional.length,
      platformBound: platformBound.length,
    },
    entries: hashedEntries.map((entry) => ({
      path: entry.path,
      category: entry.category,
      type: entry.type,
      size: entry.size,
      mode: entry.mode,
      mtime: entry.mtime,
      sha256: entry.sha256 ?? null,
      ...(entry.symlinkTarget ? { symlinkTarget: entry.symlinkTarget } : {}),
      ...(entry.platformBound ? { platformBound: entry.platformBound } : {}),
      ...(entry.platformEvidence ? { platformEvidence: entry.platformEvidence } : {}),
    })),
    platformBound,
    excluded: scan.excluded,
    optional: scan.optional,
    warnings: scan.warnings,
    rewriteSources: input.rewriteSources ?? [source.home],
    sensitiveScan: {
      clean: (sensitiveScan?.findings?.length ?? 0) === 0,
      scanned: sensitiveScan?.scanned ?? 0,
      skipped: sensitiveScan?.skipped?.length ?? 0,
      findings: sensitiveScan?.findings ?? [],
    },
  }
}

/**
 * Light structural validation, used by the importer before trusting a manifest.
 *
 * @param {unknown} manifest
 * @returns {{ok: boolean, errors: string[]}}
 */
export function validateManifest(manifest) {
  const errors = []
  const value = /** @type {any} */ (manifest)
  if (value === null || typeof value !== 'object') return { ok: false, errors: ['manifest is not an object'] }
  if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    errors.push(`unsupported manifest schemaVersion: ${value.schemaVersion}`)
  }
  if (!value.source || typeof value.source !== 'object') errors.push('missing source block')
  if (!Array.isArray(value.entries)) errors.push('entries must be an array')
  else {
    for (const entry of value.entries) {
      if (typeof entry?.path !== 'string') { errors.push('entry without a path'); break }
      if (entry.type === 'file' && typeof entry.sha256 !== 'string') {
        errors.push(`entry ${entry.path} has no sha256`); break
      }
    }
  }
  if (value.sensitiveScan && value.sensitiveScan.clean !== true) {
    errors.push('manifest records a non-clean secret scan')
  }
  return { ok: errors.length === 0, errors }
}
