import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createToolDescriptors, formatPackReport, formatReleaseReport } from '../lib/core/plugin-tools.mjs'

const packResult = {
  zipPath: '/tmp/dsh-fatfish-x.zip',
  bytes: 5 * 1024 * 1024,
  durationMs: 1234,
  sensitiveScan: { scanned: 42, skipped: 3 },
  report: { files: 100, directories: 10, bytesPacked: 9 * 1024 * 1024, excluded: 4, platformBound: 2, warnings: ['w1'] },
}

const releaseResult = {
  zipPath: '/tmp/x.zip',
  targetHome: '/home/me/.dsh',
  dryRun: false,
  created: 10,
  overwritten: 0,
  rewrite: { files: 2, hits: 3 },
  backupPath: '/home/me/.dsh.bak-20261017-0100',
  skipped: [{ path: 'plugins/a/worker', reason: '平台绑定项在本机不适用' }],
  residuals: [],
  warnings: [],
  bootstrap: { attempted: true, ok: true, profile: 'web' },
}

function makeDescriptors(overrides = {}) {
  const calls = { pack: [], release: [], pickPath: [] }
  const descriptors = createToolDescriptors({
    home: '/home/me/.dsh',
    defaultSaveDir: () => '/tmp/saves',
    now: () => new Date(Date.UTC(2026, 9, 17, 1, 30)),
    pack: async (options) => { calls.pack.push(options); return packResult },
    release: async (options) => { calls.release.push(options); return releaseResult },
    pickPath: async (options) => { calls.pickPath.push(options); return '/tmp/chosen.zip' },
    ...overrides,
  })
  return { descriptors, calls }
}

const byName = (descriptors, name) => descriptors.find((descriptor) => descriptor.name === name)

test('createToolDescriptors validates its inputs', () => {
  assert.throws(() => createToolDescriptors({}), /pack is required/)
  assert.throws(() => createToolDescriptors({ pack: async () => {} }), /release is required/)
  assert.throws(() => createToolDescriptors({ pack: async () => {}, release: async () => {} }), /pickPath is required/)
  assert.throws(() => createToolDescriptors({ pack: async () => {}, release: async () => {}, pickPath: async () => {} }), /home is required/)
})

test('fatfish_pack: asks for a save location, then packs there', async () => {
  const { descriptors, calls } = makeDescriptors()
  const tool = byName(descriptors, 'fatfish_pack')
  assert.equal(tool.parameters.savePath.required, undefined, 'optional parameters must omit "required" for DSH')
  assert.equal(typeof tool.output.render, 'function')

  const text = await tool.execute({})
  assert.equal(calls.pickPath.length, 1)
  assert.equal(calls.pickPath[0].mode, 'save')
  assert.ok(calls.pickPath[0].defaultPath.startsWith('/tmp/saves/dsh-fatfish-'))
  assert.equal(calls.pack[0].outPath, '/tmp/chosen.zip')
  assert.match(text, /打包完成/)
  assert.match(text, /密钥扫描通过/)
  assert.match(text, /平台绑定/)
})

test('fatfish_pack: explicit savePath skips the dialog; dryRun does not pack', async () => {
  const { descriptors, calls } = makeDescriptors()
  const tool = byName(descriptors, 'fatfish_pack')
  const text = await tool.execute({ savePath: '/tmp/explicit.zip', dryRun: true })
  assert.equal(calls.pickPath.length, 0)
  assert.equal(calls.pack.length, 0)
  assert.match(text, /dry-run/)
  assert.match(text, /\/tmp\/explicit\.zip/)
})

test('fatfish_pack: cancellation and headless fallback are reported clearly', async () => {
  const cancelled = makeDescriptors({ pickPath: async () => null })
  assert.match(await byName(cancelled.descriptors, 'fatfish_pack').execute({}), /已取消/)

  const headless = makeDescriptors({
    pickPath: async () => { const error = new Error('no dialog'); error.code = 'DIALOG_UNAVAILABLE'; throw error },
  })
  const text = await byName(headless.descriptors, 'fatfish_pack').execute({})
  assert.match(text, /无法弹出对话框/)
  assert.ok(headless.calls.pack[0].outPath.startsWith('/tmp/saves/'), 'falls back to the default directory')
})

test('fatfish_release: defaults to dry-run and asks for a zip when needed', async () => {
  const { descriptors, calls } = makeDescriptors()
  const tool = byName(descriptors, 'fatfish_release')
  const text = await tool.execute({})
  assert.equal(calls.pickPath[0].mode, 'open')
  assert.equal(calls.release[0].dryRun, true, 'release must default to dry-run')
  assert.equal(calls.release[0].zipPath, '/tmp/chosen.zip')
  assert.match(text, /释放大肥鱼/)
  // with an explicit path there is no dialog
  await tool.execute({ zipPath: '/tmp/given.zip', dryRun: false })
  assert.equal(calls.pickPath.length, 1)
  assert.equal(calls.release[1].zipPath, '/tmp/given.zip')
})

test('formatPackReport / formatReleaseReport carry the important facts', () => {
  const packText = formatPackReport(packResult)
  assert.match(packText, /5\.0 MiB/)
  assert.match(packText, /100 个文件/)
  assert.match(packText, /⚠️ w1/)

  const releaseText = formatReleaseReport(releaseResult)
  assert.match(releaseText, /备份/)
  assert.match(releaseText, /跳过/)
  assert.match(releaseText, /已安装插件到 profile「web」/)
  assert.match(formatReleaseReport({ ...releaseResult, dryRun: true }), /dry-run/)
})
