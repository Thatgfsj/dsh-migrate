import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createBridge, ROUTES } from '../lib/core/http-bridge.mjs'
import { buildManifest } from '../lib/core/manifest.mjs'
import { PLUGIN_NAME, PLUGIN_VERSION } from '../lib/core/version.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const testHome = join(tmpdir(), 'dsh-migrate-version-test')

// #45: the version used to be hardcoded in lib/index.js (0.1.0) while
// package.json said 0.1.1. package.json is now the single source of truth; these
// tests pin every surface that reports who generated the archive.

function fakeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers; return this },
    end(payload) { this.body = payload === undefined ? '' : payload.toString() },
    json() { return this.body === '' ? undefined : JSON.parse(this.body) },
  }
}

function fakeReq({ method = 'GET', url = '/' } = {}) {
  return { method, url }
}

test('the shared constants come from package.json', () => {
  assert.equal(PLUGIN_VERSION, pkg.version)
  assert.equal(PLUGIN_NAME, pkg.name)
})

test('the host entry builds its generator from the shared constants', () => {
  const source = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8')
  assert.ok(source.includes("from './core/version.mjs'"), 'lib/index.js must import the shared constants')
  assert.ok(source.includes('{ name: PLUGIN_NAME, version: PLUGIN_VERSION }'), 'the generator must not hardcode a version')
  assert.equal(/version:\s*['"]\d+\.\d+\.\d+['"]/.test(source), false, 'no hardcoded semver in lib/index.js')
})

test('GET /api/dsh-migrate/state reports the package.json version', async () => {
  const bridge = createBridge({
    pack: async () => ({}),
    release: async () => ({}),
    pickPath: async () => null,
    home: testHome,
  })
  const res = fakeRes()
  await bridge.request(fakeReq({ url: ROUTES.state }), res)
  assert.equal(res.status, 200, res.body)
  const state = res.json()
  assert.equal(state.ok, true)
  assert.equal(state.home, testHome)
  assert.equal(state.version, pkg.version)
})

test('manifest.generator reports the package.json version by default', () => {
  const manifest = buildManifest({
    scan: { totals: { byCategory: {} }, excluded: [], optional: [], warnings: [] },
    hashedEntries: [],
    source: { home: testHome },
    archiveName: 'test.zip',
    scope: {},
    tooling: [],
  })
  assert.equal(manifest.generator.name, pkg.name)
  assert.equal(manifest.generator.version, pkg.version)
})
