/**
 * 释放大肥鱼 — unpack a verified archive into a DSH home.
 *
 * Safety rules baked in:
 * - nothing is written before the archive passes `verifyArchive()`;
 * - the existing home is renamed aside (never merged silently) unless `merge` is set;
 * - path rewriting runs on the staged copy, then a residual scan must come back clean;
 * - a failure rolls the previous home back into place.
 *
 * @module dsh-migrate/core/release
 */

import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rename, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'

import { promisify } from 'node:util'

import { stamp } from './artifact-name.mjs'
import { assertArchiveIsClean, TOOLS_PREFIX } from './policy.mjs'
import { applyRewritePlan, buildRewriteRules, findResiduals } from './rewrite.mjs'
import { verifyArchive } from './verify.mjs'
import { extractZip, listZip } from './zip.mjs'

const execFileAsync = promisify(execFile)

/** How long the post-release `--dump-config` probe may take before giving up. */
const POST_INSTALL_TIMEOUT_MS = 30_000

export { TOOLS_PREFIX } from './policy.mjs'

/** Ordered phases with their slice of the overall progress bar. */
export const RELEASE_PHASES = [
  { phase: 'verify', from: 0, to: 20, label: '校验归档' },
  { phase: 'stage', from: 20, to: 50, label: '解包到暂存区' },
  { phase: 'plan', from: 50, to: 60, label: '计算释放计划' },
  { phase: 'backup', from: 60, to: 70, label: '备份现有 home' },
  { phase: 'write', from: 70, to: 95, label: '写入新 home' },
  { phase: 'check', from: 95, to: 100, label: '残留检查' },
]

/** Errors thrown by the release pipeline. */
export class ReleaseError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'ReleaseError'
    this.code = code
    Object.assign(this, details)
  }
}

/** Progress emitter mapping phase-local progress onto 0-100. */
export function createReleaseProgress(onProgress) {
  return (phase, done = 0, total = 0, extra = {}) => {
    if (!onProgress) return
    const slice = RELEASE_PHASES.find((item) => item.phase === phase)
    const fraction = total > 0 ? Math.min(1, done / total) : 0
    const percent = slice ? Math.round(slice.from + (slice.to - slice.from) * fraction) : 0
    onProgress({ phase, label: slice?.label ?? phase, percent, done, total, ...extra })
  }
}

/** Where a release should land: `$DSH_HOME` or `~/.dsh`. */
export function defaultTargetHome(env = process.env, home = homedir()) {
  return env?.DSH_HOME && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh')
}

/** Backup directory used when the target home already exists. */
export function backupPathFor(targetHome, date = new Date()) {
  return `${targetHome}.bak-${stamp(date)}`
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/** Payload entries from a manifest (everything the release writes into the home). */
export function payloadEntries(manifest) {
  return (manifest.entries ?? []).filter((entry) => entry.type === 'file')
}

async function copyTree(source, target, { onFile, skip } = {}) {
  const copied = []
  const walk = async (from, to) => {
    const entries = await readdir(from, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const sourcePath = join(from, entry.name)
      const targetPath = join(to, entry.name)
      const relativePath = relative(source, sourcePath).split(sep).join('/')
      if (skip?.(relativePath)) continue
      if (entry.isDirectory()) {
        await mkdir(targetPath, { recursive: true })
        await walk(sourcePath, targetPath)
        continue
      }
      const info = await lstat(sourcePath)
      await mkdir(dirname(targetPath), { recursive: true })
      if (info.isSymbolicLink()) {
        const linkTarget = await readFile(sourcePath, 'utf8').catch(() => null)
        const real = linkTarget ?? null
        await rm(targetPath, { force: true })
        if (real !== null) await symlink(real, targetPath).catch(() => {})
      } else {
        await copyFile(sourcePath, targetPath)
        if (process.platform !== 'win32') await chmod(targetPath, info.mode & 0o7777).catch(() => {})
        await utimes(targetPath, info.atime, info.mtime).catch(() => {})
      }
      copied.push(relativePath)
      onFile?.(relativePath)
    }
  }
  await walk(source, target)
  return copied
}

/**
 * Release an archive into a DSH home.
 *
 * @param {object} options
 * @param {string} options.zipPath
 * @param {string} [options.targetHome] defaults to \`$DSH_HOME\` / \`~/.dsh\`
 * @param {boolean} [options.dryRun] default true — plan only, nothing written
 * @param {boolean} [options.merge] write into an existing home instead of replacing it
 * @param {boolean} [options.skipIncompatible] drop platform-bound payloads that cannot work here
 * @param {object} [options.local] local runtime versions for the drift report
 * @param {(event: object) => void} [options.onProgress]
 * @param {() => Date} [options.now]
 * @param {string} [options.stageDir] reuse a staging directory (tests)
 * @param {boolean} [options.checkPostInstall] run `--dump-config` against the released home (default true)
 * @param {number} [options.postInstallTimeoutMs] timeout for that self-check
 * @returns {Promise<object>} release report
 */
export async function release(options) {
  const {
    zipPath,
    targetHome = defaultTargetHome(),
    dryRun = true,
    merge = false,
    skipIncompatible = true,
    targetPlatform = `${process.platform}-${process.arch}`,
    local = {},
    bootstrap = true,
    profile,
    dshBin = 'dsh',
    checkPostInstall = true,
    postInstallTimeoutMs = POST_INSTALL_TIMEOUT_MS,
    onProgress,
    now = () => new Date(),
    stageDir,
  } = options ?? {}

  if (!zipPath) throw new ReleaseError('INVALID_ARGUMENT', 'release: zipPath is required')
  if (!targetHome || !targetHome.trim()) throw new ReleaseError('INVALID_ARGUMENT', 'release: targetHome is required')
  const startedAt = Date.now()
  const emit = createReleaseProgress(onProgress)

  emit('verify', 0, 1)
  const verification = await verifyArchive(zipPath, {
    local,
    targetPlatform,
    hash: true,
    onProgress: ({ done, total, current }) => emit('verify', done, total, { current }),
  })
  if (!verification.ok) {
    throw new ReleaseError('VERIFY_FAILED', `archive failed verification: ${verification.errors.slice(0, 5).join('; ')}`, { errors: verification.errors })
  }
  const manifest = verification.manifest
  const incompatible = new Set(
    skipIncompatible ? verification.platform.incompatible.map((entry) => entry.path) : [],
  )

  const staging = stageDir ?? (await mkdtempSafe())
  const temporaryStage = stageDir === undefined
  let backupPath = null
  let wrote = false

  try {
    emit('stage', 0, 1)
    const { entries } = await listZip(zipPath)
    const payloadNames = new Set(payloadEntries(manifest).map((entry) => entry.path))
    // Platform-bound payloads that cannot work on this machine are never staged,
    // so they cannot be copied by accident later in the pipeline.
    const wanted = entries.filter((entry) => !entry.isDirectory && payloadNames.has(entry.name) && !incompatible.has(entry.name))
    assertArchiveIsClean(entries, { allowOptional: manifest.scope?.includeModels === true })
    await extractZip(zipPath, staging, { entries: wanted })
    emit('stage', 1, 1, { files: wanted.length })

    const rules = buildRewriteRules({
      from: manifest.source?.home,
      to: targetHome,
      extras: (manifest.rewriteSources ?? [])
        .filter((source) => source !== manifest.source?.home)
        .map((source) => ({ from: source, to: source })),
    })
    const rewrite = await applyRewritePlan(staging, rules)
    emit('plan', 0, 1)

    const existingHome = await exists(targetHome)
    const planned = []
    for (const entry of payloadEntries(manifest)) {
      if (incompatible.has(entry.path)) {
        planned.push({ path: entry.path, action: 'skip', reason: '平台绑定项在本机不适用' })
        continue
      }
      const present = existingHome && (await exists(join(targetHome, entry.path)))
      if (merge || !existingHome) planned.push({ path: entry.path, action: 'create' })
      else planned.push({ path: entry.path, action: present ? 'overwrite' : 'create' })
    }
    emit('plan', 1, 1)

    const summary = {
      zipPath,
      targetHome,
      dryRun,
      merge,
      backupPath: null,
      created: planned.filter((item) => item.action === 'create').length,
      overwritten: planned.filter((item) => item.action === 'overwrite').length,
      skipped: planned.filter((item) => item.action === 'skip'),
      rewrite: { files: rewrite.files.length, hits: rewrite.hits },
      residuals: [],
      bootstrap: { attempted: false, reason: dryRun ? 'dry-run' : 'not-run', pluginPath: null },
      incompatible: verification.platform.incompatible,
      warnings: verification.warnings,
      info: verification.info,
      manifest,
      planned,
      durationMs: 0,
    }

    if (dryRun) {
      await writeFile(join(staging, '.dsh-migrate-dry-run'), 'plan only\n').catch(() => {})
      summary.durationMs = Date.now() - startedAt
      emit('check', 1, 1)
      return { ...summary, ok: true }
    }

    emit('backup', 0, 1)
    if (existingHome && !merge) {
      backupPath = backupPathFor(targetHome, now())
      await rename(targetHome, backupPath)
      summary.backupPath = backupPath
    }
    emit('backup', 1, 1)

    try {
      emit('write', 0, planned.length)
      let done = 0
      await copyTree(staging, targetHome, {
        skip: (relativePath) => relativePath === '.dsh-migrate-dry-run' || incompatible.has(relativePath),
        onFile: (relativePath) => { done++; emit('write', done, planned.length, { current: relativePath }) },
      })
      wrote = true
    } catch (error) {
      if (backupPath) {
        await rm(targetHome, { recursive: true, force: true }).catch(() => {})
        await rename(backupPath, targetHome).catch(() => {})
        summary.backupPath = null
      }
      throw error
    }
    emit('write', planned.length, planned.length)

    // The embedded plugin copy is a local plugin source: it belongs under
    // plugins/, never in the home root, and it makes the new machine self-sufficient.
    let pluginPath = null
    const pluginTooling = (manifest.tooling ?? []).filter((entry) => entry.path.startsWith(`${TOOLS_PREFIX}/plugin/`))
    if (pluginTooling.length > 0) {
      const wantedTooling = entries.filter((entry) => !entry.isDirectory && pluginTooling.some((item) => item.path === entry.name))
      if (wantedTooling.length > 0) {
        await extractZip(zipPath, staging, { entries: wantedTooling })
        const embedded = join(staging, TOOLS_PREFIX, 'plugin')
        pluginPath = join(targetHome, 'plugins', 'dsh-migrate')
        await rm(pluginPath, { recursive: true, force: true })
        await copyTree(embedded, pluginPath)
      }
    }
    summary.bootstrap = await runBootstrap({ targetHome, pluginPath, bootstrap, profile, dshBin })
    if (summary.bootstrap.attempted && summary.bootstrap.ok === false) {
      summary.warnings.push(`自动安装插件失败（可手动执行）：${summary.bootstrap.command} —— ${summary.bootstrap.error}`)
    }

    emit('check', 0, 1)
    summary.residuals = await findResiduals(targetHome, (manifest.rewriteSources ?? []).filter(Boolean))

    // #46: a restored profile can still lose a bundle (a dependency that no
    // longer resolves after a DSH upgrade). Ask the target home's dsh to compose
    // it and surface what it skips — the release is a success either way.
    //
    // Invariant: the diagnostic never writes to the released home. Only a profile
    // we know exists may be inspected: a guessed `web` would let
    // `dsh --profile web --dump-config` create it (0.2.1 does), which fakes a
    // clean result *and* breaks later bootstrap profile discovery.
    const discovered = await discoverProfiles(targetHome)
    const checkProfile = profile ?? summary.bootstrap?.profile ?? (discovered.length === 1 ? discovered[0] : null)
    if (checkPostInstall === false) {
      summary.postInstall = skippedPostInstall('释放后自检已关闭（checkPostInstall: false）', { profile: checkProfile, home: targetHome })
    } else if (checkProfile === null) {
      summary.postInstall = skippedPostInstall('未指定 profile，跳过释放后自检', { home: targetHome })
    } else {
      summary.postInstall = await postInstallCheck({ dshBin, targetHome, profile: checkProfile, timeoutMs: postInstallTimeoutMs })
    }
    emit('check', 1, 1)

    summary.ok = true
    summary.durationMs = Date.now() - startedAt
    summary.wrote = wrote
    return summary
  } finally {
    if (temporaryStage) await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Command used to register the embedded plugin on the target machine.
 *
 * @param {{ dshBin?: string, profile: string, pluginPath: string }} input
 */
export function bootstrapCommand(input) {
  const { dshBin = 'dsh', profile, pluginPath } = input
  return { command: dshBin, args: ['plugin', '--profile', profile, 'add', pluginPath] }
}

/**
 * Pull DSH's "this profile will not fully load" signals out of a `--dump-config`
 * run. Pure string work, so it is unit-tested without a DSH installation.
 *
 * @param {string} text combined stdout + stderr
 * @returns {{ skippedBundles: string[], missingPatches: string[] }}
 */
export function parseProfileDiagnostics(text) {
  const source = String(text ?? '')
  const skippedBundles = []
  for (const match of source.matchAll(/skipping profile bundle "([^"]+)"/g)) {
    if (!skippedBundles.includes(match[1])) skippedBundles.push(match[1])
  }
  const missingPatches = []
  for (const match of source.matchAll(/patch: entry[^\n]*not found/g)) {
    if (!missingPatches.includes(match[0])) missingPatches.push(match[0])
  }
  return { skippedBundles, missingPatches }
}

/** Uniform "the check did not run" result, so every caller can read one shape. */
function skippedPostInstall(warning, extra = {}) {
  return {
    checked: false, command: null, profile: null, home: null,
    skippedBundles: [], missingPatches: [], warnings: [warning], output: '',
    ...extra,
  }
}

/**
 * Ask the freshly restored home's own DSH to compose the profile and report the
 * bundles it could not resolve (#46). A missing or failing `dsh` degrades to
 * `checked: false` plus one warning: the release itself already succeeded and
 * must not be rolled back because a diagnostic command failed.
 *
 * Invariant: this check never writes to the released home. `dsh --profile X
 * --dump-config` initializes X when it is missing (0.2.1 does), so a guessed
 * profile would silently create state — faking a clean result and poisoning
 * later bootstrap profile discovery. Only an existing profile is ever inspected.
 *
 * @param {{ dshBin?: string, targetHome: string, profile: string, timeoutMs?: number }} input
 * @returns {Promise<{checked: boolean, command: string|null, profile: string|null, home: string|null, skippedBundles: string[], missingPatches: string[], warnings: string[], output: string}>}
 */
export async function postInstallCheck(input) {
  const { dshBin = 'dsh', targetHome, profile, timeoutMs = POST_INSTALL_TIMEOUT_MS } = input
  if (!profile) return skippedPostInstall('未指定 profile，跳过释放后自检', { home: targetHome })
  const args = ['--profile', profile, '--dump-config']
  const printable = [dshBin, ...args].join(' ')
  if (!(await exists(join(targetHome, 'profiles', profile, 'package.json')))) {
    return skippedPostInstall(`目标 home 没有 profile「${profile}」，跳过自检（诊断不会创建它）`, { command: printable, profile, home: targetHome })
  }
  let parsed = { skippedBundles: [], missingPatches: [] }
  let checked = false
  let reason = null
  let output = ''
  try {
    const result = await execFileAsync(dshBin, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      // Compose the home we just released, not the one running this process.
      env: { ...process.env, DSH_HOME: targetHome },
    })
    output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    parsed = parseProfileDiagnostics(output)
    checked = true
  } catch (error) {
    output = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
    parsed = parseProfileDiagnostics(output)
    reason = error?.code === 'ENOENT'
      ? `找不到命令 ${dshBin}`
      : error?.killed
        ? `自检超时（${timeoutMs / 1000}s）`
        : typeof error?.code === 'number'
          ? `自检命令退出码 ${error.code}`
          : String(error?.message ?? error)
  }
  const warnings = []
  if (parsed.skippedBundles.length > 0) {
    warnings.push(`DSH 跳过了 profile bundle：${parsed.skippedBundles.join('、')}（这些层没有生效）`)
  }
  if (parsed.missingPatches.length > 0) {
    warnings.push(`profile patch 目标缺失：${parsed.missingPatches.join('；')}`)
  }
  if (!checked) {
    warnings.push(`释放后自检未完成（${reason}）；请手动运行 ${printable} 确认有没有被跳过的层`)
  }
  return { checked, command: printable, profile, home: targetHome, ...parsed, warnings, output: output.slice(-4000) }
}


async function discoverProfiles(targetHome) {
  try {
    const entries = await readdir(join(targetHome, 'profiles'), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

async function runBootstrap({ targetHome, pluginPath, bootstrap = true, profile, dshBin = 'dsh' }) {
  if (bootstrap === false) return { attempted: false, reason: 'disabled', pluginPath }
  if (!pluginPath) return { attempted: false, reason: '归档未内嵌插件副本', pluginPath: null }
  const profiles = await discoverProfiles(targetHome)
  const chosen = profile ?? (profiles.length === 1 ? profiles[0] : null)
  if (!chosen) {
    return {
      attempted: false,
      reason: profiles.length === 0
        ? '目标 home 里没有 profile，稍后可手动安装'
        : `目标 home 有多个 profile（${profiles.join(', ')}），请手动执行`,
      pluginPath,
      profiles,
      command: `dsh plugin --profile <profile> add ${pluginPath}`,
    }
  }
  const { command, args } = bootstrapCommand({ dshBin, profile: chosen, pluginPath })
  const printable = [command, ...args].join(' ')
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 300000, windowsHide: true })
    return { attempted: true, ok: true, profile: chosen, pluginPath, command: printable, output: `${stdout}${stderr}`.slice(-2000) }
  } catch (error) {
    return { attempted: true, ok: false, profile: chosen, pluginPath, command: printable, error: error.message, output: String(error.stdout ?? '').slice(-2000) }
  }
}

async function mkdtempSafe() {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), 'dsh-migrate-release-'))
}
