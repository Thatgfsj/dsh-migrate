/**
 * Discovery-based inventory of a DSH home.
 *
 * Hard rule from the product owner: **everything inside a plugin directory is
 * packed, no per-machine special cases**. Nothing here hardcodes a profile name,
 * a file size, a media file or a workspace path — the scan reports what is
 * actually on disk, and the manifest records it.
 *
 * The only exclusions are policy, not heuristics:
 * - secrets (API keys, credentials) — never packed, no flag to enable it
 * - session data (sessions / attachments / session storages / logs)
 * - regenerated files (`cordis.yml` is rewritten at every boot)
 * - local historical backups and OS junk
 *
 * @module dsh-migrate/core/inventory
 */

import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'

/** Category labels used across the manifest and reports. */
export const CATEGORY = {
  context: 'context',
  skills: 'skills',
  profile: 'profile',
  plugin: 'plugin',
  artifact: 'artifact',
  optional: 'optional',
}

/**
 * Path rules, evaluated top-down against the path relative to the DSH home
 * (always '/'-separated). The first match wins.
 */
const RULES = [
  // --- never pack secrets -------------------------------------------------
  { re: /^\.credentials/, action: 'exclude', category: 'secret', reason: '凭据/密钥：绝不打包（无开关）' },
  { re: /^\.dsh-migrate-secrets/, action: 'exclude', category: 'secret', reason: '凭据/密钥：绝不打包（无开关）' },

  // --- session data -------------------------------------------------------
  { re: /^sessions(\/|$)/, action: 'exclude', category: 'data', reason: '会话数据（按用户要求不迁移）' },
  { re: /^attachments(\/|$)/, action: 'exclude', category: 'data', reason: '附件数据' },
  { re: /^logs(\/|$)/, action: 'exclude', category: 'data', reason: '启动/运行日志' },

  // --- storages: keep the workspace registry, drop session payloads -------
  { re: /^storages\/workspace\.json$/, action: 'include', category: CATEGORY.context, reason: '工作区注册表（配置，非会话数据）' },
  // prune:false — one level is still walked so the workspace.json exception above
  // can win while the session payload next to it is dropped.
  { re: /^storages(\/|$)/, action: 'exclude', category: 'data', reason: '会话存储数据', prune: false },

  // --- regenerated --------------------------------------------------------
  { re: /^profiles\/[^/]+\/cordis\.yml$/, action: 'exclude', category: 'regenerated', reason: '启动时会被重写' },
  { re: /^profiles\/[^/]+\/\.plugin-manager\/logs(\/|$)/, action: 'exclude', category: 'log', reason: '插件管理器日志' },

  // --- local history / OS junk -------------------------------------------
  { re: /^\.dsh-rollback-/, action: 'exclude', category: 'backup', reason: '本机历史回滚备份' },
  { re: /^\.manual-backup-/, action: 'exclude', category: 'backup', reason: '本机手工备份' },
  { re: /(^|\/)\.DS_Store$/, action: 'exclude', category: 'junk', reason: 'macOS 目录元数据' },
  { re: /(^|\/)Thumbs\.db$/, action: 'exclude', category: 'junk', reason: 'Windows 缩略图缓存' },
  { re: /(^|\/)desktop\.ini$/, action: 'exclude', category: 'junk', reason: 'Windows 目录元数据' },
  { re: /(^|\/)__MACOSX(\/|$)/, action: 'exclude', category: 'junk', reason: 'Finder 解压残留' },

  // --- model caches (re-downloadable) ------------------------------------
  { re: /^speech-to-text(\/|$)/, action: 'optional', category: CATEGORY.optional, reason: '语音模型缓存，可重新下载', flag: 'includeModels' },

  // --- content ------------------------------------------------------------
  { re: /^skills(\/|$)/, action: 'include', category: CATEGORY.skills },
  { re: /^plugins(\/|$)/, action: 'include', category: CATEGORY.plugin },
  { re: /^profiles(\/|$)/, action: 'include', category: CATEGORY.profile },
  { re: /^artifacts(\/|$)/, action: 'include', category: CATEGORY.artifact },
]

/** Platform tokens that make a binary/payload machine-specific. */
const PLATFORM_TOKENS = [
  'linux-x64', 'linux-arm64', 'linux-arm', 'linux-ia32', 'linux-musl', 'linux-gnu', 'linux',
  'darwin-x64', 'darwin-arm64', 'darwin', 'macos', 'osx',
  'win32-x64', 'win32-arm64', 'win32-ia32', 'win32', 'windows',
  'musl', 'glibc',
]

const BINARY_EXTENSIONS = new Set(['.node', '.so', '.dylib', '.dll', '.exe', '.pdb', '.a', '.lib', '.bin'])

/** Decide what to do with a home-relative path. */
export function classify(relativePath) {
  const path = relativePath.split('\\').join('/')
  for (const rule of RULES) {
    if (rule.re.test(path)) {
      return { action: rule.action, category: rule.category, reason: rule.reason, flag: rule.flag, prune: rule.prune }
    }
  }
  // Anything else at the top level is context (AGENTS.md, plugin state files,
  // whale-* resources, unknown future files) — pack it and say so in the report.
  return { action: 'include', category: CATEGORY.context, reason: '未分类的 home 顶层内容（按上下文打包）' }
}

/**
 * Heuristically decide whether a file is bound to one platform.
 *
 * @param {{ path: string, mode?: number, magic?: string|null, size?: number }} file
 * @param {string} sourcePlatform e.g. `linux-x64`
 * @returns {{ bound: boolean, platforms: string[], evidence: string }}
 */
export function detectPlatformBinding(file, sourcePlatform) {
  const name = file.path.toLowerCase()
  const basename = name.split('/').pop() ?? name
  const extension = basename.includes('.') ? basename.slice(basename.lastIndexOf('.')) : ''
  const platforms = new Set()
  const evidence = []

  for (const token of PLATFORM_TOKENS) {
    if (basename.includes(token)) {
      platforms.add(token)
      evidence.push('文件名含 ' + token)
      break
    }
  }
  if (BINARY_EXTENSIONS.has(extension)) {
    evidence.push('扩展名 ' + extension)
    platforms.add(sourcePlatform)
  }
  if (file.magic === 'elf' || file.magic === 'pe' || file.magic === 'macho') {
    evidence.push('二进制魔数 ' + file.magic)
    platforms.add(sourcePlatform)
  }
  if (platforms.size === 0 && file.mode !== undefined && (file.mode & 0o111) !== 0 && extension === '') {
    evidence.push('无可执行扩展名但带执行位')
    platforms.add(sourcePlatform)
  }

  return { bound: platforms.size > 0, platforms: [...platforms], evidence: evidence.join('；') }
}

/** Read the first bytes of a file to recognise common executable formats. */
async function sniffMagic(path) {
  try {
    const { open } = await import('node:fs/promises')
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(4)
      const { bytesRead } = await handle.read(buffer, 0, 4, 0)
      if (bytesRead < 4) return null
      if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) return 'elf'
      if (buffer[0] === 0x4d && buffer[1] === 0x5a) return 'pe'
      const be = buffer.readUInt32BE(0)
      const le = buffer.readUInt32LE(0)
      if ([0xfeedface, 0xfeedfacf, 0xcafebabe, 0xbebafeca].includes(be) || [0xfeedface, 0xfeedfacf].includes(le)) return 'macho'
      return null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

/**
 * Scan a DSH home.
 *
 * @param {string} home absolute DSH home path
 * @param {{ includeModels?: boolean, sourcePlatform?: string, maxEntries?: number }} [options]
 * @returns {Promise<object>} a JSON-serialisable inventory
 */
export async function scanHome(home, options = {}) {
  const { includeModels = false, sourcePlatform = `${process.platform}-${process.arch}` } = options
  const entries = []
  const excluded = []
  const optional = []
  const warnings = []
  const seenDirectories = new Set()

  const push = (entry) => {
    entries.push(entry)
  }

  const walk = async (relative) => {
    const absolute = join(home, relative)
    const decision = classify(relative)

    if (decision.action === 'exclude') {
      excluded.push({ path: relative, category: decision.category ?? 'other', reason: decision.reason ?? '策略排除' })
      if (decision.prune === false) {
        // Descend one level so a nested keep-rule (storages/workspace.json) can match.
        let info
        try {
          info = await lstat(absolute)
        } catch {
          return
        }
        if (info.isDirectory() && !info.isSymbolicLink()) {
          for (const child of (await readdir(absolute)).sort()) await walk(posix.join(relative, child))
        }
      }
      return
    }
    if (decision.action === 'optional' && !includeModels) {
      optional.push({ path: relative, reason: decision.reason, flag: decision.flag ?? 'includeModels' })
      return
    }

    let info
    try {
      info = await lstat(absolute)
    } catch (error) {
      warnings.push(`无法读取 ${relative}: ${error.code ?? error.message}`)
      return
    }

    if (info.isSymbolicLink()) {
      let target
      try {
        target = await realpath(absolute)
      } catch (error) {
        warnings.push(`软链目标不可解析，跳过 ${relative}: ${error.code ?? error.message}`)
        return
      }
      if (seenDirectories.has(target)) {
        warnings.push(`软链回环，跳过 ${relative}`)
        return
      }
      const resolved = await stat(target)
      if (resolved.isDirectory()) {
        seenDirectories.add(target)
        for (const child of (await readdir(absolute)).sort()) await walk(posix.join(relative, child))
        return
      }
      push({
        path: relative,
        category: decision.category,
        type: 'file',
        size: resolved.size,
        mode: resolved.mode & 0o7777,
        mtime: resolved.mtime.toISOString(),
        symlinkTarget: await readlink(absolute).catch(() => target),
      })
      return
    }

    if (info.isDirectory()) {
      const children = (await readdir(absolute)).sort()
      for (const child of children) await walk(posix.join(relative, child))
      return
    }

    if (info.isFile()) {
      push({
        path: relative,
        category: decision.category,
        type: 'file',
        size: info.size,
        mode: info.mode & 0o7777,
        mtime: info.mtime.toISOString(),
      })
    }
  }

  const top = (await readdir(home, { withFileTypes: true })).map((entry) => entry.name).sort()
  for (const name of top) await walk(name)

  // Platform binding pass (extra syscall per candidate file only).
  for (const entry of entries) {
    const candidate = BINARY_EXTENSIONS.has(entry.path.slice(entry.path.lastIndexOf('.')))
      || /(^|[\/._-])(linux|darwin|win32|windows|macos|musl|glibc)([\/._-]|$)/i.test(entry.path)
      || (entry.mode & 0o111) !== 0
    if (!candidate) continue
    const magic = await sniffMagic(join(home, entry.path))
    const binding = detectPlatformBinding({ ...entry, magic }, sourcePlatform)
    if (binding.bound) {
      entry.platformBound = binding.platforms
      entry.platformEvidence = binding.evidence
    }
  }

  const bytesByCategory = {}
  for (const entry of entries) {
    bytesByCategory[entry.category] = (bytesByCategory[entry.category] ?? 0) + entry.size
  }

  return {
    home,
    sourcePlatform,
    scannedAt: new Date().toISOString(),
    entries,
    excluded,
    optional,
    warnings,
    totals: {
      files: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      byCategory: bytesByCategory,
      platformBound: entries.filter((entry) => entry.platformBound).length,
      excluded: excluded.length,
      optional: optional.length,
    },
  }
}
