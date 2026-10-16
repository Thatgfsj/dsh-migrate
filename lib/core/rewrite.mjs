/**
 * 路径重写 — make an archive's absolute paths point at the target machine.
 *
 * A profile's package.json can hold \`file:/home/<old-user>/...tgz\` dependencies
 * (measured on the reference machine), and patch files may embed absolute paths.
 * After extraction we rewrite those to the new home, in POSIX, Windows and
 * JSON-escaped spellings, then rescan for leftovers.
 *
 * @module dsh-migrate/core/rewrite
 */

import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Extensions treated as text when rewriting/scanning. */
export const DEFAULT_TEXT_EXTENSIONS = new Set([
  '.json', '.json5', '.yml', '.yaml', '.js', '.mjs', '.cjs', '.ts', '.txt', '.md', '.markdown',
  '.sh', '.bash', '.zsh', '.cmd', '.bat', '.ps1', '.toml', '.ini', '.cfg', '.conf', '.env', '.lock',
])

/** Default per-file budget for rewriting. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Convert Windows separators to '/', keeping a drive letter. */
export function toPosixPath(value) {
  return String(value).replace(/\\/g, '/')
}

/** Normalize a path prefix: POSIX separators, no trailing slash. */
export function normalizePrefix(value) {
  return toPosixPath(value).trim().replace(/\/+$/, '')
}

/**
 * Build rewrite rules from a source/target pair plus explicit extras.
 * Longest prefix first, so nested roots win over their parents.
 *
 * @param {{ from?: string, to?: string, extras?: Array<{from: string, to: string}> }} input
 * @returns {Array<{from: string, to: string}>}
 */
export function buildRewriteRules(input = {}) {
  const rules = []
  const push = (from, to) => {
    if (!from || !to) return
    const normalizedFrom = normalizePrefix(from)
    const normalizedTo = normalizePrefix(to)
    if (!normalizedFrom || normalizedFrom === normalizedTo) return
    if (rules.some((rule) => rule.from === normalizedFrom)) return
    rules.push({ from: normalizedFrom, to: normalizedTo })
  }
  push(input.from, input.to)
  for (const pair of input.extras ?? []) push(pair?.from, pair?.to)
  return rules.sort((a, b) => b.from.length - a.from.length)
}

/** All spellings of a rule that may appear in a config file. */
export function ruleVariants(rule) {
  const from = rule.from
  const to = rule.to
  const fromBackslash = from.replace(/\//g, '\\')
  const toBackslash = to.replace(/\//g, '\\')
  const variants = [
    [from, to],
    [fromBackslash, toBackslash],
    [JSON.stringify(fromBackslash).slice(1, -1), JSON.stringify(toBackslash).slice(1, -1)],
    [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)],
  ]
  const seen = new Set()
  return variants.filter(([a]) => {
    if (!a || seen.has(a)) return false
    seen.add(a)
    return true
  })
}

/**
 * Rewrite every rule occurrence in a text.
 *
 * @param {string} text
 * @param {Array<{from: string, to: string}>} rules
 * @returns {{text: string, hits: number}}
 */
export function rewriteText(text, rules) {
  let output = text
  let hits = 0
  for (const rule of rules) {
    for (const [needle, replacement] of ruleVariants(rule)) {
      const parts = output.split(needle)
      if (parts.length > 1) {
        hits += parts.length - 1
        output = parts.join(replacement)
      }
    }
  }
  return { text: output, hits }
}

function isTextCandidate(name, { extensions = DEFAULT_TEXT_EXTENSIONS, size = 0, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : ''
  if (extension && !extensions.has(extension)) return false
  if (size > maxBytes) return false
  return true
}

function looksBinary(buffer) {
  return buffer.subarray(0, 512).includes(0)
}

/** Walk a tree, depth-first, sorted, following symlinked directories once. */
async function walkFiles(root, visit, seen = new Set()) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolute = join(root, entry.name)
    if (entry.isDirectory()) {
      await walkFiles(absolute, visit, seen)
      continue
    }
    if (entry.isSymbolicLink()) {
      const info = await lstat(absolute)
      if (info.isDirectory()) {
        if (!seen.has(absolute)) {
          seen.add(absolute)
          await walkFiles(absolute, visit, seen)
        }
        continue
      }
    }
    await visit(absolute)
  }
}

/**
 * Rewrite files under a root in place.
 *
 * @param {string} root
 * @param {Array<{from: string, to: string}>} rules
 * @param {{ extensions?: Set<string>, maxBytes?: number, dryRun?: boolean, onFile?: (result: object) => void }} [options]
 * @returns {Promise<{files: Array<object>, hits: number, scanned: number}>}
 */
export async function applyRewritePlan(root, rules, options = {}) {
  const { dryRun = false, onFile, maxBytes = DEFAULT_MAX_BYTES, extensions = DEFAULT_TEXT_EXTENSIONS } = options
  const changed = []
  let scanned = 0
  let hits = 0
  await walkFiles(root, async (absolute) => {
    const info = await lstat(absolute)
    if (!info.isFile()) return
    if (!isTextCandidate(absolute, { extensions, size: info.size, maxBytes })) return
    const buffer = await readFile(absolute)
    if (looksBinary(buffer)) return
    scanned++
    const original = buffer.toString('utf8')
    const result = rewriteText(original, rules)
    if (result.hits === 0) return
    if (!dryRun) await writeFile(absolute, result.text, 'utf8')
    hits += result.hits
    const record = { path: absolute, hits: result.hits }
    changed.push(record)
    onFile?.(record)
  })
  return { files: changed, hits, scanned }
}

/**
 * Find leftover source prefixes anywhere under a root.
 *
 * @param {string} root
 * @param {string[]} needles
 * @param {{ extensions?: Set<string>, maxBytes?: number }} [options]
 * @returns {Promise<Array<{path: string, line: number, needle: string}>>}
 */
export async function findResiduals(root, needles, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, extensions = DEFAULT_TEXT_EXTENSIONS } = options
  const found = []
  const list = needles.filter((needle) => typeof needle === 'string' && needle.length > 1)
  if (list.length === 0) return found
  await walkFiles(root, async (absolute) => {
    const info = await lstat(absolute)
    if (!info.isFile()) return
    if (!isTextCandidate(absolute, { extensions, size: info.size, maxBytes })) return
    const buffer = await readFile(absolute)
    if (looksBinary(buffer)) return
    const text = buffer.toString('utf8')
    if (!list.some((needle) => text.includes(needle))) return
    const lines = text.split('\n')
    lines.forEach((content, index) => {
      for (const needle of list) {
        if (content.includes(needle)) found.push({ path: absolute, line: index + 1, needle })
      }
    })
  })
  return found
}
