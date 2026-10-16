/**
 * HTTP bridge for the Web UI half.
 *
 * The browser cannot spawn a process, so the two buttons talk to the host through
 * three loopback endpoints registered on the DSH web server:
 *
 *   GET  /api/dsh-migrate/state            current progress + last results
 *   GET  /api/dsh-migrate/pick?mode=save   open the *native* dialog on the host
 *   POST /api/dsh-migrate/pack             start 打包大肥鱼
 *   POST /api/dsh-migrate/release          start 释放大肥鱼
 *
 * All request handling lives here as plain functions so it can be unit-tested with
 * fake req/res objects, with no web server and no browser in sight.
 *
 * @module dsh-migrate/core/http-bridge
 */

/** Base path of every dsh-migrate endpoint. */
export const API_BASE = '/api/dsh-migrate'

/** Endpoints exposed to the client half. */
export const ROUTES = {
  state: `${API_BASE}/state`,
  pick: `${API_BASE}/pick`,
  pack: `${API_BASE}/pack`,
  release: `${API_BASE}/release`,
}

const MAX_BODY_BYTES = 256 * 1024

function sendJson(res, status, value) {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8')
  if (typeof res.writeHead === 'function') {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store' })
  }
  res.end(payload)
}

async function readJsonBody(req) {
  if (req?.body !== undefined) {
    if (typeof req.body === 'string') return req.body.trim() === '' ? {} : JSON.parse(req.body)
    return req.body ?? {}
  }
  const chunks = []
  let size = 0
  for await (const chunk of req ?? []) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('请求体过大'), { status: 413 })
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  return JSON.parse(text)
}

function summarizePack(result) {
  return {
    zipPath: result.zipPath,
    bytes: result.bytes,
    files: result.report?.files ?? null,
    durationMs: result.durationMs,
    platformBound: result.report?.platformBound ?? 0,
    finishedAt: new Date().toISOString(),
  }
}

function summarizeRelease(result) {
  return {
    zipPath: result.zipPath,
    targetHome: result.targetHome,
    dryRun: result.dryRun,
    created: result.created,
    skipped: result.skipped?.length ?? 0,
    backupPath: result.backupPath ?? null,
    bootstrap: result.bootstrap ?? null,
    residuals: result.residuals?.length ?? 0,
    finishedAt: new Date().toISOString(),
  }
}

/**
 * Build the bridge.
 *
 * @param {object} deps
 * @param {(options: object) => Promise<object>} deps.pack
 * @param {(options: object) => Promise<object>} deps.release
 * @param {(options: object) => Promise<string|null>} deps.pickPath
 * @param {string} deps.home
 * @param {object} [deps.tooling]
 * @param {object} [deps.generator]
 * @param {string} [deps.dshBin]
 * @param {boolean} [deps.bootstrap]
 * @param {string} [deps.version]
 */
export function createBridge(deps) {
  const {
    pack, release, pickPath, home,
    tooling, generator = { name: 'dsh-migrate', version: null },
    dshBin = 'dsh', bootstrap = true, version = null,
  } = deps

  const state = {
    action: null,
    phase: null,
    label: null,
    percent: 0,
    current: null,
    startedAt: null,
    finishedAt: null,
    error: null,
  }
  const history = { lastPack: null, lastRelease: null }

  const makeProgress = (action) => (event) => {
    state.action = action
    state.phase = event?.phase ?? state.phase
    state.label = event?.label ?? state.label
    state.percent = Number.isFinite(event?.percent) ? event.percent : state.percent
    state.current = event?.current ?? null
  }

  async function run(action, task, summarize) {
    if (state.action !== null) {
      throw Object.assign(new Error(`已有任务在执行：${state.action}`), { status: 409 })
    }
    state.action = action
    state.phase = null
    state.label = action === 'pack' ? '打包大肥鱼' : '释放大肥鱼'
    state.percent = 0
    state.current = null
    state.startedAt = new Date().toISOString()
    state.error = null
    try {
      const result = await task()
      history[action === 'pack' ? 'lastPack' : 'lastRelease'] = summarize(result)
      state.percent = 100
      return result
    } catch (error) {
      state.error = { code: error?.code ?? 'ERROR', message: error?.message ?? String(error) }
      throw error
    } finally {
      state.action = null
      state.phase = null
      state.finishedAt = new Date().toISOString()
    }
  }

  async function handleState() {
    return {
      ok: true,
      home,
      version,
      running: state.action,
      progress: state.action === null ? null : {
        action: state.action, phase: state.phase, label: state.label,
        percent: state.percent, current: state.current, startedAt: state.startedAt,
      },
      error: state.error,
      ...history,
    }
  }

  async function handlePick(url) {
    const mode = url.searchParams.get('mode') === 'open' ? 'open' : 'save'
    try {
      const path = await pickPath({ mode, defaultPath: url.searchParams.get('defaultPath') ?? undefined })
      return { ok: true, path, cancelled: path === null }
    } catch (error) {
      return { ok: false, code: error?.code ?? 'ERROR', message: error?.message ?? String(error) }
    }
  }

  async function handlePack(body) {
    const result = await run('pack', () => pack({
      home,
      outPath: body.savePath,
      includeModels: body.includeModels === true,
      generator,
      tooling,
      onProgress: makeProgress('pack'),
    }), summarizePack)
    return { ok: true, ...summarizePack(result), report: result.report }
  }

  async function handleRelease(body) {
    const result = await run('release', () => release({
      zipPath: body.zipPath,
      targetHome: body.targetHome,
      merge: body.merge === true,
      dryRun: body.dryRun !== false,
      dshBin,
      bootstrap,
      onProgress: makeProgress('release'),
    }), summarizeRelease)
    return { ok: true, ...summarizeRelease(result), residuals: result.residuals?.length ?? 0 }
  }

  /**
   * HTTP request handler: exact-path router over the four endpoints.
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function request(req, res) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      return sendJson(res, 400, { ok: false, message: '无法解析请求 URL' })
    }
    const method = (req.method ?? 'GET').toUpperCase()
    try {
      if (url.pathname === ROUTES.state) {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, message: 'state 只支持 GET' })
        return sendJson(res, 200, await handleState())
      }
      if (url.pathname === ROUTES.pick) {
        if (method !== 'GET') return sendJson(res, 405, { ok: false, message: 'pick 只支持 GET' })
        return sendJson(res, 200, await handlePick(url))
      }
      if (url.pathname === ROUTES.pack) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, message: 'pack 只支持 POST' })
        const body = await readJsonBody(req)
        if (typeof body.savePath !== 'string' || body.savePath.trim() === '') {
          return sendJson(res, 400, { ok: false, code: 'SAVE_PATH_REQUIRED', message: '请先调用 pick?mode=save 选择保存位置，并把它作为 savePath 传回' })
        }
        return sendJson(res, 200, await handlePack(body))
      }
      if (url.pathname === ROUTES.release) {
        if (method !== 'POST') return sendJson(res, 405, { ok: false, message: 'release 只支持 POST' })
        const body = await readJsonBody(req)
        if (typeof body.zipPath !== 'string' || body.zipPath.trim() === '') {
          return sendJson(res, 400, { ok: false, code: 'ZIP_PATH_REQUIRED', message: '请先调用 pick?mode=open 选择归档，并把它作为 zipPath 传回' })
        }
        return sendJson(res, 200, await handleRelease(body))
      }
      return sendJson(res, 404, { ok: false, message: `未知端点：${url.pathname}` })
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500
      return sendJson(res, status, {
        ok: false,
        code: error?.code ?? 'ERROR',
        message: error?.message ?? String(error),
      })
    }
  }

  /** Web-route descriptors for \`ctx.webServer.register()\`. */
  function routes() {
    return Object.values(ROUTES).map((path) => ({ kind: 'exact', path, handler: request }))
  }

  return { request, routes, state, history, handleState, handlePack, handleRelease, handlePick }
}
