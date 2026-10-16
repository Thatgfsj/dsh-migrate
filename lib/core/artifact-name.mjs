/**
 * Naming helpers for 大肥鱼 archives. Pure, dependency-free, unit-tested.
 *
 * @module dsh-migrate/core/artifact-name
 */

/** Prefix of a migration archive ("fat fish"). */
export const ARCHIVE_PREFIX = 'dsh-fatfish'

/** Characters that are illegal (or hostile) in file names on Windows/POSIX. */
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]+/g

/**
 * Make a hostname safe to embed in a file name that must survive
 * Windows / macOS / Linux and being sent through chat apps.
 *
 * @param {unknown} host raw hostname
 * @returns {string} sanitized host, never empty
 */
export function sanitizeHost(host) {
  const raw = typeof host === 'string' ? host : ''
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(ILLEGAL, '-')
    .replace(/[\s._]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  const trimmed = cleaned.slice(0, 40).replace(/[-.]+$/, '')
  return trimmed || 'unknown-host'
}

/**
 * Format a date as `yyyyMMdd-HHmm`.
 *
 * @param {Date} [date] date to format (defaults to now)
 * @param {{ utc?: boolean }} [options] use UTC instead of local time
 * @returns {string}
 */
export function stamp(date = new Date(), options = {}) {
  const utc = options.utc === true
  const p = (n, width = 2) => String(n).padStart(width, '0')
  const y = utc ? date.getUTCFullYear() : date.getFullYear()
  const mo = (utc ? date.getUTCMonth() : date.getMonth()) + 1
  const d = utc ? date.getUTCDate() : date.getDate()
  const h = utc ? date.getUTCHours() : date.getHours()
  const mi = utc ? date.getUTCMinutes() : date.getMinutes()
  return `${p(y, 4)}${p(mo)}${p(d)}-${p(h)}${p(mi)}`
}

/**
 * Build the default archive file name: `dsh-fatfish-<host>-<stamp>.zip`.
 *
 * @param {{ host?: string, date?: Date, utc?: boolean }} [options]
 * @returns {string} file name (no directory)
 */
export function archiveName(options = {}) {
  const { host = 'unknown-host', date = new Date(), utc = false } = options
  return `${ARCHIVE_PREFIX}-${sanitizeHost(host)}-${stamp(date, { utc })}.zip`
}
