#!/usr/bin/env node
/**
 * 释放大肥鱼（独立版，不依赖 DSH 插件）
 *
 * 用法：先把 zip 解压到任意目录，然后
 *
 *   node dsh-migrate-tools/restore.mjs --yes
 *
 * 它默认操作“自己所在目录的上一层”（也就是解压出来的归档根目录），
 * 读取 manifest.json、逐文件校验 sha256、备份现有 home、写入新 home、
 * 重写绝对路径、复扫残留，最后打印报告。
 *
 * 只用 Node 标准库。默认是 dry-run —— 不加 --yes 不会写任何东西。
 *
 * 选项：
 *   --root <dir>        解压后的归档根目录（默认：本脚本所在目录的上一层）
 *   --home <dir>        目标 DSH home（默认：$DSH_HOME 或 ~/.dsh）
 *   --merge             写进已存在的 home，而不是整体替换
 *   --yes               真的写入
 *   --keep-incompatible 不跳过平台绑定项（默认跳过）
 *   --json              以 JSON 打印结果
 */

import { copyFile, chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUPPORTED_SCHEMA = 1
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PLATFORM_FAMILY = { linux: 'linux', win32: 'windows', darwin: 'darwin' }
const PLATFORM_TOKENS = ['linux-x64', 'linux-arm64', 'linux-arm', 'linux-musl', 'linux-gnu', 'linux',
  'darwin-x64', 'darwin-arm64', 'darwin', 'macos', 'win32-x64', 'win32-arm64', 'win32', 'windows']

function parseArgs(argv) {
  const options = { merge: false, yes: false, json: false, keepIncompatible: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--root') options.root = argv[++index]
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--merge') options.merge = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--json') options.json = true
    else if (arg === '--keep-incompatible') options.keepIncompatible = true
    else if (arg === '-h' || arg === '--help') options.help = true
    else if (arg.startsWith('--')) fail(`未知选项：${arg}`)
  }
  return options
}

function fail(message, code = 1) {
  console.error(`restore: ${message}`)
  process.exit(code)
}

function log(quiet, ...args) {
  if (!quiet) console.log(...args)
}

function stamp(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

async function sha256(path) {
  const hash = createHash('sha256')
  await new Promise((resolve_, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve_)
  })
  return hash.digest('hex')
}

async function exists(path) {
  try { await lstat(path); return true } catch { return false }
}

function platformOf(entry) {
  const name = String(entry.path).toLowerCase().split('/').pop() ?? ''
  for (const token of PLATFORM_TOKENS) {
    if (name.includes(token)) return token.startsWith('linux') ? 'linux' : token.startsWith('darwin') || token === 'macos' ? 'darwin' : 'windows'
  }
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot) : ''
  if (['.node', '.so', '.dylib', '.dll', '.exe', '.pdb'].includes(extension)) return 'binary'
  return null
}

function rewriteVariants(from, to) {
  const backFrom = from.replace(/\//g, '\\')
  const backTo = to.replace(/\//g, '\\')
  const escape = (value) => JSON.stringify(value).slice(1, -1)
  const seen = new Set()
  return [[from, to], [backFrom, backTo], [escape(backFrom), escape(backTo)], [escape(from), escape(to)]]
    .filter(([needle]) => { if (!needle || seen.has(needle)) return false; seen.add(needle); return true })
}

async function walkFiles(root, visit, seen = new Set()) {
  for (const entry of (await readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) { await walkFiles(absolute, visit, seen); continue }
    if (entry.isSymbolicLink()) {
      const info = await lstat(absolute)
      if (info.isDirectory() && !seen.has(absolute)) { seen.add(absolute); await walkFiles(absolute, visit, seen) }
      continue
    }
    await visit(absolute)
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(await readFile(fileURLToPath(import.meta.url), 'utf8').then((text) => text.split('*/')[0].replace(/^#![^\n]*\n/, '')))
    return
  }
  const quiet = options.json
  const root = resolve(options.root ?? join(SCRIPT_DIR, '..'))
  const targetHome = resolve(options.home ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))

  const manifestPath = join(root, 'manifest.json')
  if (!await exists(manifestPath)) fail(`找不到 manifest.json（--root 指向解压后的归档根目录）：${root}`)
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    fail(`manifest.json 不是合法 JSON：${error.message}`)
  }
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA) {
    fail(`manifest schemaVersion=${manifest.schemaVersion} 不受支持（本脚本支持 ${SUPPORTED_SCHEMA}）`)
  }

  const files = (manifest.entries ?? []).filter((entry) => entry.type === 'file')
  const here = PLATFORM_FAMILY[process.platform] ?? process.platform
  const skipped = []
  const hashErrors = []
  const kept = []
  for (const entry of files) {
    const family = platformOf(entry)
    if (!options.keepIncompatible && family && family !== 'binary' && family !== here) {
      skipped.push({ path: entry.path, reason: `平台绑定（${family}），本机是 ${here}` })
      continue
    }
    const absolute = join(root, ...entry.path.split('/'))
    if (!await exists(absolute)) { hashErrors.push({ path: entry.path, reason: '归档里缺少该文件' }); continue }
    if (entry.sha256) {
      const actual = await sha256(absolute)
      if (actual !== entry.sha256) { hashErrors.push({ path: entry.path, reason: 'sha256 不一致' }); continue }
    }
    kept.push(entry)
  }
  if (hashErrors.length > 0) {
    for (const item of hashErrors) console.error(`restore: 校验失败 ${item.path}: ${item.reason}`)
    fail(`归档校验未通过（${hashErrors.length} 个文件），已中止`)
  }

  const existingHome = await exists(targetHome)
  const backupPath = existingHome && !options.merge ? `${targetHome}.bak-${stamp()}` : null
  const summary = {
    ok: true, root, targetHome, dryRun: !options.yes, merge: options.merge,
    files: kept.length, skipped, hashErrors, backupPath, rewrite: { files: 0, hits: 0 }, residuals: [],
    source: manifest.source ?? null,
  }

  if (!options.yes) {
    log(quiet, `restore: dry-run（加 --yes 才会写入）`)
    log(quiet, `  root        : ${root}`)
    log(quiet, `  target home : ${targetHome}${existingHome ? '（已存在）' : ''}`)
    log(quiet, `  将写入      : ${kept.length} 个文件`)
    if (skipped.length) log(quiet, `  跳过        : ${skipped.length} 个平台绑定项`)
    if (backupPath) log(quiet, `  备份        : ${targetHome} -> ${backupPath}`)
    if (options.json) console.log(JSON.stringify(summary, null, 2))
    return
  }

  let movedAside = false
  try {
    if (backupPath) {
      await rename(targetHome, backupPath)
      movedAside = true
      log(quiet, `restore: 已备份 ${targetHome} -> ${backupPath}`)
    }
    for (const entry of kept) {
      const source = join(root, ...entry.path.split('/'))
      const destination = join(targetHome, ...entry.path.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await copyFile(source, destination)
      if (process.platform !== 'win32' && typeof entry.mode === 'number') await chmod(destination, entry.mode & 0o7777).catch(() => {})
      const info = await stat(source)
      await utimes(destination, info.atime, info.mtime).catch(() => {})
    }
    log(quiet, `restore: 已写入 ${kept.length} 个文件 -> ${targetHome}`)

    // 路径重写
    const oldHome = manifest.source?.home
    if (oldHome && resolve(oldHome) !== targetHome) {
      const variants = rewriteVariants(String(oldHome).replace(/\\/g, '/').replace(/\/+$/, ''), targetHome.replace(/\\/g, '/').replace(/\/+$/, ''))
      await walkFiles(targetHome, async (absolute) => {
        const dot = absolute.lastIndexOf('.')
        const extension = dot > 0 ? absolute.slice(dot).toLowerCase() : ''
        const textish = ['.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.txt', '.md', '.sh', '.cmd', '.bat', '.ps1', '.toml', '.ini', '.conf', '.lock'].includes(extension)
        if (!textish) return
        const info = await stat(absolute)
        if (info.size > 4 * 1024 * 1024) return
        const buffer = await readFile(absolute)
        if (buffer.subarray(0, 512).includes(0)) return
        const original = buffer.toString('utf8')
        let text = original
        let hits = 0
        for (const [needle, replacement] of variants) {
          const parts = text.split(needle)
          if (parts.length > 1) { hits += parts.length - 1; text = parts.join(replacement) }
        }
        if (hits === 0) return
        await writeFile(absolute, text, 'utf8')
        summary.rewrite.files++
        summary.rewrite.hits += hits
      })
      log(quiet, `restore: 路径重写 ${summary.rewrite.files} 个文件 / ${summary.rewrite.hits} 处`)
    }

    // 残留复扫
    const needles = [manifest.source?.home, ...(manifest.rewriteSources ?? [])].filter((value) => typeof value === 'string' && value.length > 1)
    if (needles.length > 0) {
      await walkFiles(targetHome, async (absolute) => {
        const dot = absolute.lastIndexOf('.')
        const extension = dot > 0 ? absolute.slice(dot).toLowerCase() : ''
        if (!['.json', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.txt', '.md', '.sh', '.cmd', '.bat', '.ps1', '.toml', '.ini', '.conf', '.lock'].includes(extension)) return
        const info = await stat(absolute)
        if (info.size > 4 * 1024 * 1024) return
        const buffer = await readFile(absolute)
        if (buffer.subarray(0, 512).includes(0)) return
        const text = buffer.toString('utf8')
        for (const needle of needles) {
          if (text.includes(needle)) summary.residuals.push({ path: relative(targetHome, absolute), needle })
        }
      })
    }
    if (summary.residuals.length > 0) {
      log(quiet, `restore: 警告 —— 仍有 ${summary.residuals.length} 处旧路径残留，可能需要手工重装插件`)
    }
  } catch (error) {
    if (movedAside) {
      await rm(targetHome, { recursive: true, force: true }).catch(() => {})
      await rename(backupPath, targetHome).catch(() => {})
      console.error('restore: 写入失败，已回滚到原 home')
    }
    fail(`写入失败：${error.message}`)
  }

  if (manifest.source?.dsh) {
    log(quiet, `restore: 归档记录的 DSH 版本为 ${manifest.source.dsh}，请确认本机装的是同一版本`)
  }
  log(quiet, 'restore: 完成。重启 DSH 后即为搬过来的环境；若插件未生效，重新执行 dsh plugin add。')
  if (options.json) console.log(JSON.stringify(summary, null, 2))
  if (summary.residuals.length > 0) process.exitCode = 0
}

main().catch((error) => fail(error?.stack ?? String(error)))
