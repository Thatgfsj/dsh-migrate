/**
 * Peer-range compatibility guard (#47).
 *
 * The published @deepseek-ai/dsh-* packages are prereleases, and node-semver
 * refuses to match a prerelease against a comparator set that does not carry a
 * prerelease on the *same* major.minor.patch tuple:
 *
 *   satisfies('0.2.1-rc.2', '>=0.2.0-rc.2') -> false
 *
 * So a peer range that only names the 0.2.0 rc line silently drops the 0.2.1 rc
 * line, and registry/git installs start treating the plugin as incompatible.
 *
 * The repo has no node_modules and CI never runs `npm install`, so this file
 * carries a tiny prerelease-aware matcher covering exactly the operators our
 * peers use (>, >=, <, <=, =, ^, ~, space = AND, `||` = OR). It is cross-checked
 * against the real node-semver whenever a DSH install happens to be on the host.
 */

import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// ---------------------------------------------------------------------------
// minimal prerelease-aware semver (test-only; no node_modules allowed in CI)
// ---------------------------------------------------------------------------

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
const COMPARATOR_RE = /^(>=|<=|>|<|=|\^|~)?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** Parse `1.2.3-rc.1` into its numeric tuple plus prerelease identifiers. */
function parseVersion(text) {
  const match = VERSION_RE.exec(String(text).trim())
  if (!match) throw new Error(`unsupported version: ${text}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** semver §11 ordering: release > prerelease, numeric identifiers < alphanumeric. */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

function compareParsed(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

function compareVersions(left, right) {
  return compareParsed(parseVersion(left), parseVersion(right))
}

function sameTuple(version, other) {
  return version.major === other.major && version.minor === other.minor && version.patch === other.patch
}

/** `<X.Y.Z-0` is node-semver's exclusive upper bound: it excludes X.Y.Z's prereleases too. */
function upperBound(major, minor, patch) {
  return { op: '<', version: { major, minor, patch, prerelease: ['0'] } }
}

/** Expand one comparator into plain comparison operators. */
function expandComparator(operator, version) {
  switch (operator) {
    case '^': {
      const { major, minor, patch } = version
      const upper = major > 0
        ? upperBound(major + 1, 0, 0)
        : minor > 0
          ? upperBound(0, minor + 1, 0)
          : upperBound(0, 0, patch + 1)
      return [{ op: '>=', version }, upper]
    }
    case '~':
      return [{ op: '>=', version }, upperBound(version.major, version.minor + 1, 0)]
    default:
      return [{ op: operator ?? '=', version }]
  }
}

/** Parse a range into OR-ed comparator sets (`||` splits sets, whitespace ANDs). */
function parseRange(range) {
  return String(range).split('||').map((clause) => {
    const tokens = clause.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) throw new Error(`unsupported range: ${range}`)
    return tokens.flatMap((token) => {
      const match = COMPARATOR_RE.exec(token)
      if (!match) throw new Error(`unsupported comparator: ${token}`)
      return expandComparator(match[1], {
        major: Number(match[2]),
        minor: Number(match[3]),
        patch: Number(match[4]),
        prerelease: match[5] ? match[5].split('.') : [],
      })
    })
  })
}

function testComparator(version, comparator) {
  const order = compareParsed(version, comparator.version)
  switch (comparator.op) {
    case '>': return order > 0
    case '>=': return order >= 0
    case '<': return order < 0
    case '<=': return order <= 0
    case '=': return order === 0
    default: throw new Error(`unsupported operator: ${comparator.op}`)
  }
}

/** node-semver `satisfies(version, range)` for the subset above. */
function satisfies(versionText, rangeText) {
  const version = parseVersion(versionText)
  for (const clause of parseRange(rangeText)) {
    // A prerelease only satisfies a set when one comparator in that set carries a
    // prerelease on the same M.m.p tuple; without this rule '^0.2.0-rc.2' would
    // wrongly accept '0.2.1-rc.2'.
    const prereleaseAllowed = clause.some((comparator) =>
      comparator.version.prerelease.length > 0 && sameTuple(comparator.version, version))
    if (version.prerelease.length > 0 && !prereleaseAllowed) continue
    if (clause.every((comparator) => testComparator(version, comparator))) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// the peer contract this repository promises
// ---------------------------------------------------------------------------

const DSH_PREFIX = '@deepseek-ai/dsh-'

/** Runtime versions a released dsh line installs; every one must be covered. */
const SUPPORTED_DSH_VERSIONS = ['0.2.0-rc.2', '0.2.1-rc.2']

/** The next breaking line; a peer range must never claim it. */
const REJECTED_DSH_VERSIONS = ['0.3.0']

/**
 * Non-dsh peers are pinned by the versions dsh actually depends on:
 * 0.2.0-rc.2 ships ~4.0.4 / ~3.18.4, 0.2.1-rc.2 ships ~4.0.5 / ~3.18.5.
 */
const RUNTIME_PEER_VERSIONS = {
  '@deepseek-ai/cordis': ['4.0.4', '4.0.5'],
  '@deepseek-ai/schemastery': ['3.18.4', '3.18.5'],
}
const RUNTIME_PEER_REJECTED = {
  '@deepseek-ai/cordis': ['5.0.0'],
  '@deepseek-ai/schemastery': ['4.0.0'],
}

/**
 * Check a peerDependencies map against the contract.
 *
 * @param {Record<string, string>} peers
 * @returns {string[]} human-readable violations (empty when the map is good)
 */
function peerViolations(peers) {
  const problems = []
  for (const [name, range] of Object.entries(peers)) {
    if (typeof range !== 'string' || range.trim() === '') {
      problems.push(`peer ${name} has no range`)
      continue
    }
    if (name.startsWith(DSH_PREFIX)) {
      for (const version of SUPPORTED_DSH_VERSIONS) {
        if (!satisfies(version, range)) problems.push(`${name} "${range}" must satisfy ${version}`)
      }
      for (const version of REJECTED_DSH_VERSIONS) {
        if (satisfies(version, range)) problems.push(`${name} "${range}" must not satisfy ${version}`)
      }
      continue
    }
    if (name in RUNTIME_PEER_VERSIONS) {
      for (const version of RUNTIME_PEER_VERSIONS[name]) {
        if (!satisfies(version, range)) problems.push(`${name} "${range}" must satisfy ${version}`)
      }
      for (const version of RUNTIME_PEER_REJECTED[name]) {
        if (satisfies(version, range)) problems.push(`${name} "${range}" must not satisfy ${version}`)
      }
      continue
    }
    problems.push(`peer ${name} is not covered by this test; add its runtime versions above`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

test('the minimal matcher reproduces node-semver prerelease rules', () => {
  const table = [
    // the premise of #47
    ['0.2.1-rc.2', '>=0.2.0-rc.2', false],
    ['0.2.1-rc.2', '^0.2.1-rc.2', true],
    ['0.2.1-rc.2', '^0.2.0-rc.2 || ^0.2.1-rc.2', true],
    // both rc lines, and only those
    ['0.2.0-rc.2', '^0.2.0-rc.2 || ^0.2.1-rc.2', true],
    ['0.2.2', '^0.2.1-rc.2', true],
    ['0.3.0', '^0.2.0-rc.2 || ^0.2.1-rc.2', false],
    ['0.3.0-rc.1', '^0.2.1-rc.2', false],
    // non-dsh runtime peers
    ['4.0.4', '^4.0.4', true],
    ['4.0.5', '^4.0.4', true],
    ['5.0.0', '^4.0.4', false],
    ['4.1.0', '~4.0.5', false],
    ['3.18.4', '^3.18.4', true],
    ['3.18.5', '^3.18.4', true],
    ['4.0.0', '^3.18.4', false],
    ['1.2.3', '=1.2.3', true],
    ['1.3.0', '~1.2.3', false],
  ]
  for (const [version, range, expected] of table) {
    assert.equal(satisfies(version, range), expected, `satisfies(${version}, "${range}")`)
  }
})

test('the matcher rejects syntax it does not implement', () => {
  assert.throws(() => satisfies('1.2.3', '^1.2'), /unsupported/)
  assert.throws(() => satisfies('1.2.3', '>=1.2.3 ||'), /unsupported/)
  assert.throws(() => satisfies('1.2', '^1.2.3'), /unsupported/)
})

test('package.json peers cover both rc lines and reject the next one', async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const peers = pkg.peerDependencies ?? {}
  assert.ok(Object.keys(peers).length > 0, 'peerDependencies must not be empty')
  assert.deepEqual(peerViolations(peers), [])
})

test('the guard catches the pre-#47 peer block (regression proof)', () => {
  const before = {
    '@deepseek-ai/cordis': '>=4.0.0',
    '@deepseek-ai/dsh-tools': '>=0.2.0-rc.2',
    '@deepseek-ai/schemastery': '>=3.18.0',
  }
  const problems = peerViolations(before)
  assert.ok(
    problems.some((problem) => problem.includes('dsh-tools') && problem.includes('0.2.1-rc.2')),
    `the old range must be flagged as missing the 0.2.1 rc line, got: ${JSON.stringify(problems)}`,
  )
  assert.deepEqual(peerViolations({ ...before, '@deepseek-ai/dsh-tools': '^0.2.0-rc.2 || ^0.2.1-rc.2' })
    .filter((problem) => problem.includes('dsh-tools')), [], 'the fixed range must pass')
})

/** Locate the running dsh installation, or undefined when dsh is not installed. */
function findDshInstall() {
  let bin
  try {
    bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
  if (!bin) return undefined
  try {
    const entry = execFileSync('sh', ['-c', `realpath "${bin}"`], { encoding: 'utf8' }).trim()
    const installDir = resolve(entry, '..', '..')
    if (!existsSync(join(installDir, 'package.json'))) return undefined
    return installDir
  } catch {
    return undefined
  }
}

function loadRealSemver() {
  try {
    return createRequire(import.meta.url)('semver')
  } catch {
    /* no node_modules next to this repo; fall through to the DSH install */
  }
  const install = findDshInstall()
  if (!install) return undefined
  try {
    return createRequire(join(install, 'package.json'))('semver')
  } catch {
    return undefined
  }
}

const realSemver = loadRealSemver()

test('the minimal matcher agrees with the real node-semver where available', { skip: realSemver ? false : 'node-semver is not resolvable on this host' }, () => {
  const versions = [
    '0.2.0-rc.2', '0.2.0-rc.3', '0.2.0', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.1', '0.2.2-rc.1',
    '0.2.2', '0.3.0-0', '0.3.0-rc.1', '0.3.0', '0.3.1',
    '3.18.3', '3.18.4', '3.18.5', '3.19.0-0', '3.19.0', '4.0.0',
    '4.0.4', '4.0.5', '4.1.0-0', '4.1.0', '5.0.0-0', '5.0.0',
    '1.2.3', '1.2.4-rc.1', '1.3.0', '2.0.0',
  ]
  const ranges = [
    '^0.2.0-rc.2 || ^0.2.1-rc.2', '^0.2.0-rc.2', '^0.2.1-rc.2', '>=0.2.0-rc.2',
    '^4.0.4', '~4.0.5', '^3.18.4', '~3.18.4', '^1.2.3', '~1.2.3',
    '=1.2.3', '>1.2.3', '<2.0.0', '>=1.0.0 <2.0.0', '1.2.3 || 2.0.0',
  ]
  const mismatches = []
  for (const range of ranges) {
    for (const version of versions) {
      const mine = satisfies(version, range)
      const theirs = realSemver.satisfies(version, range)
      if (mine !== theirs) mismatches.push(`${version} "${range}": minimal=${mine} node-semver=${theirs}`)
    }
  }
  assert.deepEqual(mismatches, [])
})
