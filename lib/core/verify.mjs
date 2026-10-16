/**
 * 释放前的校验 — verify a 大肥鱼 archive before anything is written to disk.
 *
 * Checks, in order: zip structure, manifest presence + schema, payload/manifest
 * agreement, per-file sha256, policy compliance, and what will *not* work on this
 * machine (platform-bound binaries, runtime version drift).
 *
 * @module dsh-migrate/core/verify
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sha256File } from './manifest.mjs'
import { MANIFEST_ENTRY, validateManifest } from './manifest.mjs'
import { assertArchiveIsClean } from './policy.mjs'
import { extractZip, listZip } from './zip.mjs'

/** Error thrown when an archive cannot be trusted. */
export class VerifyError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'VerifyError'
    this.code = code
    Object.assign(this, details)
  }
}

/**
 * Read and parse the manifest out of an archive.
 *
 * @param {string} zipPath
 * @returns {Promise<{manifest: object, entry: object}>}
 */
export async function readManifest(zipPath) {
  const { entries } = await listZip(zipPath)
  const entry = entries.find((item) => item.name === MANIFEST_ENTRY)
  if (!entry) throw new VerifyError('MANIFEST_MISSING', `archive has no ${MANIFEST_ENTRY}: ${zipPath}`)
  const temp = await mkdtemp(join(tmpdir(), 'dsh-migrate-manifest-'))
  try {
    await extractZip(zipPath, temp, { entries: [entry] })
    const text = await readFile(join(temp, MANIFEST_ENTRY), 'utf8')
    let manifest
    try {
      manifest = JSON.parse(text)
    } catch (error) {
      throw new VerifyError('MANIFEST_INVALID', `${MANIFEST_ENTRY} is not valid JSON: ${error.message}`)
    }
    return { manifest, entry }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

/**
 * Describe what a manifest's platform-bound payloads mean for the current machine.
 *
 * @param {object} manifest
 * @param {string} targetPlatform e.g. \`win32-x64\`
 */
export function platformReport(manifest, targetPlatform = `${process.platform}-${process.arch}`) {
  const targetFamily = targetPlatform.split('-')[0]
  const compatible = []
  const incompatible = []
  for (const item of manifest.platformBound ?? []) {
    const families = item.platforms.map((value) => String(value).toLowerCase())
    const exact = families.includes(targetPlatform.toLowerCase())
    const family = families.includes(targetFamily.toLowerCase())
    if (exact || family) compatible.push(item)
    else incompatible.push({ ...item, target: targetPlatform })
  }
  return { target: targetPlatform, compatible, incompatible }
}

/**
 * Compare the runtimes recorded in the manifest with this machine.
 *
 * @param {object} manifest
 * @param {{dsh?: string|null, pnpm?: string|null, node?: string}} [local]
 */
export function runtimeReport(manifest, local = {}) {
  const source = manifest.source ?? {}
  const warnings = []
  const info = []
  if (local.dsh && source.dsh && local.dsh !== source.dsh) {
    warnings.push(`DSH 版本不同：归档来自 ${source.dsh}，本机是 ${local.dsh}；请先安装 ${source.dsh} 或自行承担差异`)
  }
  if (!local.dsh && source.dsh) info.push(`归档记录的 DSH 版本：${source.dsh}（本机未检测到 dsh）`)
  if (local.node && source.node && local.node.split('.')[0] !== String(source.node).split('.')[0]) {
    warnings.push(`Node 主版本不同：归档来自 ${source.node}，本机是 ${local.node}`)
  }
  if (local.pnpm && source.pnpm && local.pnpm !== source.pnpm) {
    info.push(`pnpm 版本不同：归档来自 ${source.pnpm}，本机是 ${local.pnpm}`)
  }
  return { warnings, info }
}

/**
 * Verify an archive end to end.
 *
 * @param {string} zipPath
 * @param {{ targetPlatform?: string, local?: object, hash?: boolean, extractDir?: string, onProgress?: (event: object) => void }} [options]
 * @returns {Promise<object>} verification report; throws only for unreadable archives
 */
export async function verifyArchive(zipPath, options = {}) {
  const {
    targetPlatform = `${process.platform}-${process.arch}`,
    local = {},
    hash = true,
    onProgress,
  } = options

  const errors = []
  const warnings = []

  const { entries } = await listZip(zipPath)
  const { manifest } = await readManifest(zipPath)

  const structure = validateManifest(manifest)
  errors.push(...structure.errors)

  const allowOptional = manifest.scope?.includeModels === true
  try {
    assertArchiveIsClean(entries, { allowOptional })
  } catch (error) {
    errors.push(error.message)
  }

  const payloadNames = entries.filter((entry) => !entry.isDirectory && entry.name !== MANIFEST_ENTRY).map((entry) => entry.name).sort()
  const manifestNames = (manifest.entries ?? []).filter((entry) => entry.type === 'file').map((entry) => entry.path).sort()
  const missing = manifestNames.filter((name) => !payloadNames.includes(name))
  const extra = payloadNames.filter((name) => !manifestNames.includes(name))
  if (missing.length > 0) errors.push(`归档缺少 manifest 声明的文件：${missing.slice(0, 5).join(', ')}`)
  if (extra.length > 0) errors.push(`归档存在 manifest 未声明的文件：${extra.slice(0, 5).join(', ')}`)

  let hashed = 0
  let hashErrors = 0
  if (hash && structure.ok && missing.length === 0) {
    const workdir = options.extractDir ?? (await mkdtemp(join(tmpdir(), 'dsh-migrate-verify-')))
    const temporary = options.extractDir === undefined
    try {
      await extractZip(zipPath, workdir, {
        entries: entries.filter((entry) => !entry.isDirectory && entry.name !== MANIFEST_ENTRY),
      })
      for (const entry of manifest.entries ?? []) {
        if (entry.type !== 'file') continue
        const actual = await sha256File(join(workdir, entry.path))
        hashed++
        if (actual !== entry.sha256) {
          hashErrors++
          if (hashErrors <= 5) errors.push(`sha256 不一致：${entry.path}`)
        }
        onProgress?.({ phase: 'hash', done: hashed, total: manifestNames.length, current: entry.path })
      }
    } finally {
      if (temporary) await rm(workdir, { recursive: true, force: true })
    }
  }

  const platform = platformReport(manifest, targetPlatform)
  const runtime = runtimeReport(manifest, local)
  warnings.push(...runtime.warnings)
  if (platform.incompatible.length > 0) {
    warnings.push(`${platform.incompatible.length} 个平台绑定项在本机（${targetPlatform}）不适用，需要重建：${platform.incompatible.slice(0, 5).map((item) => item.path).join(', ')}`)
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info: runtime.info,
    manifest,
    archive: { path: zipPath, entries: entries.length, payloadFiles: payloadNames.length },
    hashed,
    platform,
    runtime,
  }
}
