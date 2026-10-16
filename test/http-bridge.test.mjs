import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { API_BASE, ROUTES, createBridge } from '../lib/core/http-bridge.mjs'

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

function fakeReq({ method = 'GET', url = '/', body } = {}) {
  return { method, url, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) }
}

const packResult = {
  zipPath: '/tmp/out.zip',
  bytes: 1024,
  durationMs: 12,
  sensitiveScan: { scanned: 1, skipped: 0 },
  report: { files: 3, directories: 1, bytesPacked: 900, excluded: 0, platformBound: 0, warnings: [] },
}

const releaseResult = {
  zipPath: '/tmp/out.zip',
  targetHome: '/tmp/home',
  dryRun: false,
  created: 3,
  overwritten: 0,
  rewrite: { files: 1, hits: 2 },
  backupPath: null,
  skipped: [],
  residuals: [],
  warnings: [],
  bootstrap: { attempted: false, reason: 'disabled' },
}

function makeBridge(overrides = {}) {
  const calls = { pack: [], release: [], pickPath: [] }
  const bridge = createBridge({
    home: '/tmp/home',
    version: '0.0.0-test',
    pack: async (options) => { calls.pack.push(options); return packResult },
    release: async (options) => { calls.release.push(options); return releaseResult },
    pickPath: async (options) => { calls.pickPath.push(options); return '/tmp/picked.zip' },
    ...overrides,
  })
  return { bridge, calls }
}

test('state starts idle and reports the home', async () => {
  const { bridge } = makeBridge()
  const res = fakeRes()
  await bridge.request(fakeReq({ url: ROUTES.state }), res)
  assert.equal(res.status, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.running, null)
  assert.equal(body.home, '/tmp/home')
  assert.equal(body.progress, null)
})

test('routes() returns exact web routes for every endpoint', () => {
  const { bridge } = makeBridge()
  const routes = bridge.routes()
  assert.equal(routes.length, 4)
  for (const route of routes) {
    assert.equal(route.kind, 'exact')
    assert.ok(route.path.startsWith(API_BASE))
    assert.equal(typeof route.handler, 'function')
  }
})

test('unknown paths 404, wrong methods 405', async () => {
  const { bridge } = makeBridge()
  const notFound = fakeRes()
  await bridge.request(fakeReq({ url: '/api/dsh-migrate/nope' }), notFound)
  assert.equal(notFound.status, 404)

  const wrongMethod = fakeRes()
  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.state }), wrongMethod)
  assert.equal(wrongMethod.status, 405)
})

test('pick asks the host dialog and surfaces cancellation', async () => {
  const { bridge, calls } = makeBridge()
  const res = fakeRes()
  await bridge.request(fakeReq({ url: `${ROUTES.pick}?mode=open` }), res)
  assert.equal(res.status, 200)
  assert.deepEqual(calls.pickPath[0].mode, 'open')
  assert.equal(res.json().path, '/tmp/picked.zip')

  const cancelled = makeBridge({ pickPath: async () => null })
  const cancelledRes = fakeRes()
  await cancelled.bridge.request(fakeReq({ url: ROUTES.pick }), cancelledRes)
  assert.equal(cancelledRes.json().cancelled, true)

  const headless = makeBridge({ pickPath: async () => { const error = new Error('no dialog'); error.code = 'DIALOG_UNAVAILABLE'; throw error } })
  const headlessRes = fakeRes()
  await headless.bridge.request(fakeReq({ url: ROUTES.pick }), headlessRes)
  assert.equal(headlessRes.json().ok, false)
  assert.equal(headlessRes.json().code, 'DIALOG_UNAVAILABLE')
})

test('pack requires a chosen save path, then runs with it', async () => {
  const { bridge, calls } = makeBridge()
  const missing = fakeRes()
  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.pack, body: {} }), missing)
  assert.equal(missing.status, 400)
  assert.equal(missing.json().code, 'SAVE_PATH_REQUIRED')

  const ok = fakeRes()
  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.pack, body: { savePath: '/tmp/out.zip' } }), ok)
  assert.equal(ok.status, 200)
  assert.equal(calls.pack[0].outPath, '/tmp/out.zip')
  assert.equal(ok.json().zipPath, '/tmp/out.zip')

  const badJson = fakeRes()
  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.pack, body: '{not json' }), badJson)
  assert.equal(badJson.status, 500)
  assert.equal(badJson.json().code, 'ERROR')
})

test('release requires a zip path, defaults to dry-run and records the result', async () => {
  const { bridge, calls } = makeBridge()
  const missing = fakeRes()
  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.release, body: {} }), missing)
  assert.equal(missing.status, 400)
  assert.equal(missing.json().code, 'ZIP_PATH_REQUIRED')

  const ok = fakeRes()
  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.release, body: { zipPath: '/tmp/out.zip' } }), ok)
  assert.equal(calls.release[0].dryRun, true, 'bare request must not write')
  assert.equal(ok.json().ok, true)

  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.release, body: { zipPath: '/tmp/out.zip', dryRun: false } }), fakeRes())
  assert.equal(calls.release[1].dryRun, false)

  const state = fakeRes()
  await bridge.request(fakeReq({ url: ROUTES.state }), state)
  assert.equal(state.json().lastRelease.targetHome, '/tmp/home')
})

test('a second task is rejected while one is running, and progress is visible', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const { bridge } = makeBridge({
    pack: async (options) => {
      options.onProgress?.({ phase: 'scan', label: '扫描 DSH home', percent: 10 })
      await gate
      return packResult
    },
  })

  const first = bridge.request(fakeReq({ method: 'POST', url: ROUTES.pack, body: { savePath: '/tmp/a.zip' } }), fakeRes())
  await new Promise((resolve) => setTimeout(resolve, 10))

  const state = fakeRes()
  await bridge.request(fakeReq({ url: ROUTES.state }), state)
  assert.equal(state.json().running, 'pack')
  assert.equal(state.json().progress.percent, 10)

  const second = fakeRes()
  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.pack, body: { savePath: '/tmp/b.zip' } }), second)
  assert.equal(second.status, 409)

  release()
  await first
  const after = fakeRes()
  await bridge.request(fakeReq({ url: ROUTES.state }), after)
  assert.equal(after.json().running, null)
  assert.equal(after.json().lastPack.zipPath, '/tmp/out.zip')
})

test('a failing task reports its error and clears the running flag', async () => {
  const { bridge } = makeBridge({
    pack: async () => { const error = new Error('refusing to pack'); error.code = 'SECRET_FOUND'; throw error },
  })
  const res = fakeRes()
  await bridge.request(fakeReq({ method: 'POST', url: ROUTES.pack, body: { savePath: '/tmp/x.zip' } }), res)
  assert.equal(res.status, 500)
  assert.equal(res.json().code, 'SECRET_FOUND')

  const state = fakeRes()
  await bridge.request(fakeReq({ url: ROUTES.state }), state)
  assert.equal(state.json().running, null)
  assert.equal(state.json().error.code, 'SECRET_FOUND')
})
