/**
 * Secret scanning for the packer.
 *
 * The owner's rule is absolute: **no API key ever leaves the machine**. Two layers
 * enforce it:
 *
 * 1. \`inventory.mjs\` excludes credential *files* by path (\`.credentials*\`, \`.env\`,
 *    \`*.pem\`, ...) — they never even enter the scan below.
 * 2. This module scans every remaining text payload for key-shaped *values*, in two
 *    tiers:
 *
 *    - **high** (fatal): a value carrying a recognised key prefix (\`sk-\`, \`ghp_\`,
 *      \`AKIA\`, \`xox\`) or a PEM private-key block.
 *    - **low** (reported): the generic \`api_key = <value>\` shape, and only when the
 *      value plausibly *is* a literal secret. \`config.apiKey\`, \`process.env.X\`,
 *      \`this.req.secret\`, \`<placeholder>\`, \`changeme\` and friends are not.
 *
 * Rationale: the first tier must never ship; the second tier appears in third-party
 * source and documentation everywhere, and treating it as fatal made a real DSH home
 * unpackable (issue #35). Reports always print **masked** values.
 *
 * @module dsh-migrate/core/sensitive
 */

import { open } from 'node:fs/promises'

/** Patterns that indicate a credential, with their severity. */
export const SECRET_PATTERNS = [
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, what: 'OpenAI 风格密钥', severity: 'high' },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,})\b/g, what: 'GitHub token', severity: 'high' },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'AWS access key', severity: 'high' },
  // A real PEM block carries a long base64 body; a bare header in a README is a mention.
  {
    id: 'private-key-block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,64}?[A-Za-z0-9+/=\r\n]{256,}/g,
    what: '私钥块（含完整 base64 主体）',
    severity: 'high',
  },
  {
    id: 'private-key-header',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    what: '私钥头（可能只是文档示例）',
    severity: 'low',
  },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, what: 'Slack token', severity: 'high' },
  {
    id: 'assigned-secret',
    // The key name may itself be quoted (JSON/config style: \"api_key\": \"...\").
    re: /(?:^|[^A-Za-z0-9_])(api[_-]?key|apikey|secret|client[_-]?secret|access[_-]?token|auth[_-]?token|password|passwd)["']?\s*[:=]\s*["']?([A-Za-z0-9_\-./+]{12,})["']?/gi,
    what: '赋值形式的密钥',
    severity: 'low',
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

// Values that look like a *reference* to a secret rather than a secret.
const REFERENCE = /(process\.env|import\.meta|env\.|config\.|this\.|\$\{)/i
// Values that are obviously placeholders.
const PLACEHOLDER = /^(<[^>]*>|x{3,}|\*+|-+|none|null|undefined|true|false|0|changeme|change-me|redacted|placeholder|dummy|sample|todo|your[-_].*)$/i

/**
 * Does this matched value plausibly *be* a literal secret?
 *
 * Only used for the low-confidence tier, so it is deliberately conservative: a
 * false negative costs a warning, never a leak — high-confidence patterns abort
 * regardless.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function looksLikeLiteralSecret(value) {
  const text = String(value ?? '')
  if (text.length < 12) return false
  if (REFERENCE.test(text)) return false
  if (PLACEHOLDER.test(text)) return false
  // Dotted identifier chains such as `this.req.secret` / `config.apiKey`.
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z0-9_$]+)+$/.test(text)) return false
  const hasLetter = /[a-z]/i.test(text)
  const hasDigit = /\d/.test(text)
  const hasSymbol = /[^A-Za-z0-9]/.test(text)
  const mixedCase = /[a-z]/.test(text) && /[A-Z]/.test(text)
  if (!hasLetter) return false
  if (hasDigit) return true
  if (hasSymbol && text.length >= 16) return true
  return mixedCase && text.length >= 20
}

function looksBinary(buffer) {
  return buffer.subarray(0, 512).includes(0)
}

/**
 * Scan one file.
 *
 * @param {string} path
 * @param {{ maxBytes?: number, size?: number }} [options]
 * @returns {Promise<{findings: Array<object>, suspicious: Array<object>, skipped?: string}>}
 */
export async function scanFileForSecrets(path, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, size } = options
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  if (BINARY_EXTENSIONS.has(extension)) return { findings: [], suspicious: [], skipped: 'binary-extension' }
  if (size !== undefined && size > maxBytes) return { findings: [], suspicious: [], skipped: 'too-large' }

  const handle = await open(path, 'r')
  const findings = []
  const suspicious = []
  try {
    const info = await handle.stat()
    if (info.size > maxBytes) return { findings: [], suspicious: [], skipped: 'too-large' }
    const buffer = Buffer.alloc(info.size)
    if (info.size > 0) await handle.read(buffer, 0, info.size, 0)
    if (looksBinary(buffer)) return { findings: [], suspicious: [], skipped: 'binary-content' }

    const text = buffer.toString('utf8')
    for (const pattern of SECRET_PATTERNS) {
      pattern.re.lastIndex = 0
      for (const match of text.matchAll(pattern.re)) {
        const line = text.slice(0, match.index).split('\n').length
        const record = {
          path,
          pattern: pattern.id,
          what: pattern.what,
          severity: pattern.severity,
          line,
          masked: mask(match[0]),
        }
        if (pattern.severity === 'high') findings.push(record)
        else if (looksLikeLiteralSecret(match[2] ?? match[0])) suspicious.push(record)
      }
    }
  } finally {
    await handle.close()
  }
  // A real PEM block already produced a fatal finding; don't also warn about its header.
  const hasPemBlock = findings.some((finding) => finding.pattern === 'private-key-block')
  return {
    findings,
    suspicious: hasPemBlock ? suspicious.filter((item) => item.pattern !== 'private-key-header') : suspicious,
  }
}

/**
 * Scan a set of inventory entries.
 *
 * @param {string} home DSH home the entries are relative to
 * @param {Array<{path: string, size: number, type: string}>} entries
 * @param {{ maxBytes?: number, onProgress?: (done:number,total:number)=>void }} [options]
 * @returns {Promise<{findings: Array<object>, suspicious: Array<object>, scanned: number, skipped: Array<object>}>}
 */
export async function scanEntriesForSecrets(home, entries, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, onProgress } = options
  const { join } = await import('node:path')
  const findings = []
  const suspicious = []
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
      for (const item of result.suspicious) suspicious.push({ ...item, path: entry.path })
    }
    onProgress?.(scanned + skipped.length, files.length)
  }
  return { findings, suspicious, scanned, skipped }
}
