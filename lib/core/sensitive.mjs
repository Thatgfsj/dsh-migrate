/**
 * Secret scanning for the packer.
 *
 * The owner's rule is absolute: **no API key ever leaves the machine**. Credential
 * files are excluded by policy in `inventory.mjs`; this module is the second line
 * of defence — after the archive is assembled we scan every text-ish payload and
 * abort the pack if anything key-shaped survived.
 *
 * Matches are reported **masked**: the report must never re-print a secret.
 *
 * @module dsh-migrate/core/sensitive
 */

import { open } from 'node:fs/promises'

/** Patterns that indicate a credential. Order matters only for readability. */
export const SECRET_PATTERNS = [
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, what: 'OpenAI 风格密钥' },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,})\b/g, what: 'GitHub token' },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'AWS access key' },
  { id: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, what: '私钥块' },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, what: 'Slack token' },
  {
    id: 'assigned-secret',
    re: /(?:^|[^A-Za-z0-9_])(api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})["']?/gi,
    what: '赋值形式的密钥',
  },
]

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.svgz', '.pdf', '.zip', '.gz', '.tgz',
  '.xz', '.bz2', '.7z', '.rar', '.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.node', '.so', '.dylib', '.dll', '.exe', '.pdb', '.a', '.lib', '.woff', '.woff2', '.ttf', '.otf',
  '.wasm', '.sqlite', '.db', '.onnx', '.bin', '.pt', '.safetensors',
])

/** Default per-file scan budget: bigger files are reported as skipped, not read. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Mask a match so reports never contain the credential itself. */
export function mask(value) {
  const text = String(value)
  if (text.length <= 8) return '*'.repeat(text.length)
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(12, text.length - 4))}`
}

function looksBinary(buffer) {
  const probe = buffer.subarray(0, 512)
  return probe.includes(0)
}

/**
 * Scan one file.
 *
 * @param {string} path
 * @param {{ maxBytes?: number, size?: number }} [options]
 * @returns {Promise<{findings: Array<object>, skipped?: string}>}
 */
export async function scanFileForSecrets(path, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, size } = options
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (BINARY_EXTENSIONS.has(extension)) return { findings: [], skipped: 'binary-extension' }
  if (size !== undefined && size > maxBytes) return { findings: [], skipped: 'too-large' }

  const handle = await open(path, 'r')
  const findings = []
  try {
    const stat = await handle.stat()
    if (stat.size > maxBytes) return { findings: [], skipped: 'too-large' }
    const buffer = Buffer.alloc(stat.size)
    if (stat.size > 0) await handle.read(buffer, 0, stat.size, 0)
    if (looksBinary(buffer)) return { findings: [], skipped: 'binary-content' }

    const text = buffer.toString('utf8')
    for (const pattern of SECRET_PATTERNS) {
      pattern.re.lastIndex = 0
      for (const match of text.matchAll(pattern.re)) {
        const line = text.slice(0, match.index).split('\n').length
        findings.push({
          path,
          pattern: pattern.id,
          what: pattern.what,
          line,
          masked: mask(match[0]),
        })
      }
    }
  } finally {
    await handle.close()
  }
  return { findings }
}

/**
 * Scan a set of inventory entries.
 *
 * @param {string} home DSH home the entries are relative to
 * @param {Array<{path: string, size: number, type: string}>} entries
 * @param {{ maxBytes?: number, onProgress?: (done:number,total:number)=>void }} [options]
 * @returns {Promise<{findings: Array<object>, scanned: number, skipped: Array<object>}>}
 */
export async function scanEntriesForSecrets(home, entries, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, onProgress } = options
  const { join } = await import('node:path')
  const findings = []
  const skipped = []
  let scanned = 0
  const files = entries.filter((entry) => entry.type === 'file')
  for (const entry of files) {
    const absolute = join(home, entry.path)
    let result
    try {
      result = await scanFileForSecrets(absolute, { maxBytes, size: entry.size })
    } catch (error) {
      skipped.push({ path: entry.path, reason: `unreadable: ${error.code ?? error.message}` })
      continue
    }
    if (result.skipped) {
      skipped.push({ path: entry.path, reason: result.skipped })
    } else {
      scanned++
      for (const finding of result.findings) findings.push({ ...finding, path: entry.path })
    }
    onProgress?.(scanned + skipped.length, files.length)
  }
  return { findings, scanned, skipped }
}
