import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { CATEGORY, classify, detectPlatformBinding, scanHome } from '../lib/core/inventory.mjs'

let home
const write = async (relative, content) => {
  const absolute = join(home, relative)
  await mkdir(join(absolute, '..'), { recursive: true })
  await writeFile(absolute, content)
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-migrate-inventory-'))
  await write('AGENTS.md', '# global instructions')
  await write('cordis.patch.yml', '[]')
  await write('dream-skin.json', '{}')
  await write('.anonymous-user-id', 'abc')
  await write('.credentials.yaml', 'refs:\n  DEEPSEEK_API_KEY: secret\n')
  await write('.credentials.bak', 'secret')
  await write('.DS_Store', 'junk')
  await write('whale-audio/a.mp3', 'audio')

  await write('skills/demo/SKILL.md', '---\nname: demo\ndescription: d\n---\nbody')
  await write('plugins/dsh-demo/entry.js', 'export function apply() {}')
  await write('plugins/dsh-demo/docs/logs/keep.txt', 'must stay: rule is anchored at the home root')
  await write('plugins/dsh-demo/docs/readme.md', 'readme')
  await write('plugins/dsh-demo/runtime/linux-x64/worker', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]))
  await write('plugins/dsh-demo/assets/clip.mp4', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]))

  await write('profiles/web/package.json', '{"name":"dsh-profile-web"}')
  await write('profiles/web/cordis.patch.yml', '[]')
  await write('profiles/web/pnpm-lock.yaml', 'lockfileVersion: 9')
  await write('profiles/web/cordis.yml', '[]')
  await write('profiles/web/.plugin-manager/logs/pnpm.log', 'log')
  await write('profiles/web/node_modules/dep/index.js', 'export default 1')

  await write('artifacts/dsh-ops-0.3.1-linux-x64.tgz', 'tarball')

  await write('sessions/s1.json', '{}')
  await write('attachments/a.png', 'png')
  await write('logs/startup.log', 'log')
  await write('storages/workspace.json', '[]')
  await write('storages/session_projcache/cache.bin', 'cache')
  await write('speech-to-text/sensevoice/models/model.onnx', 'model')
  await write('.dsh-rollback-20260101/cordis.patch.yml', '[]')
})

after(async () => {
  await rm(home, { recursive: true, force: true })
})

test('classify: policy matrix', () => {
  const cases = [
    ['AGENTS.md', 'include', CATEGORY.context],
    ['cordis.patch.yml', 'include', CATEGORY.context],
    ['whale-audio/a.mp3', 'include', CATEGORY.context],
    ['skills/demo/SKILL.md', 'include', CATEGORY.skills],
    ['plugins/dsh-demo/entry.js', 'include', CATEGORY.plugin],
    ['plugins/dsh-demo/logs/x.log', 'include', CATEGORY.plugin],
    ['profiles/web/package.json', 'include', CATEGORY.profile],
    ['artifacts/x.tgz', 'include', CATEGORY.artifact],
    ['storages/workspace.json', 'include', CATEGORY.context],
    ['storages/session_projcache/x', 'exclude', 'data'],
    ['.credentials.yaml', 'exclude', 'secret'],
    ['.env', 'exclude', 'secret'],
    ['plugins/web/.env', 'exclude', 'secret'],
    ['.env.local', 'exclude', 'secret'],
    ['.env.example', 'include', CATEGORY.context],
    ['plugins/a/.env.template', 'include', CATEGORY.plugin],
    ['certs/server.pem', 'exclude', 'secret'],
    ['ssh/id_rsa', 'exclude', 'secret'],
    ['home/.npmrc', 'exclude', 'secret'],
    ['.credentials', 'exclude', 'secret'],
    ['sessions/a/b', 'exclude', 'data'],
    ['attachments/x', 'exclude', 'data'],
    ['logs/x.log', 'exclude', 'data'],
    ['profiles/web/cordis.yml', 'exclude', 'regenerated'],
    ['profiles/web/.plugin-manager/logs/x', 'exclude', 'log'],
    ['.dsh-rollback-1/x', 'exclude', 'backup'],
    ['.manual-backup-1/x', 'exclude', 'backup'],
    ['.DS_Store', 'exclude', 'junk'],
    ['plugins/a/.DS_Store', 'exclude', 'junk'],
    ['speech-to-text/x', 'optional', CATEGORY.optional],
  ]
  for (const [path, action, category] of cases) {
    const decision = classify(path)
    assert.equal(decision.action, action, `action for ${path}`)
    assert.equal(decision.category, category, `category for ${path}`)
  }
})

test('detectPlatformBinding: names, extensions, magic bytes', () => {
  const byName = detectPlatformBinding({ path: 'artifacts/dsh-ops-0.3.1-linux-x64.tgz' }, 'linux-x64')
  assert.equal(byName.bound, true)
  assert.ok(byName.platforms.includes('linux-x64'))

  const byExtension = detectPlatformBinding({ path: 'a/b/native.node' }, 'darwin-arm64')
  assert.equal(byExtension.bound, true)

  const byMagic = detectPlatformBinding({ path: 'bin/worker', magic: 'elf' }, 'linux-x64')
  assert.equal(byMagic.bound, true)

  const executable = detectPlatformBinding({ path: 'bin/script', mode: 0o755 }, 'linux-x64')
  assert.equal(executable.bound, true)

  // Documentation that merely mentions a platform in its name is not binding.
  const docs = detectPlatformBinding({ path: 'node_modules/dsh-ops/docs/macos-arm64.md', mode: 0o644 }, 'linux-x64')
  assert.equal(docs.bound, false)
  assert.deepEqual(docs.platforms, [])

  const plain = detectPlatformBinding({ path: 'docs/readme.md', mode: 0o644 }, 'linux-x64')
  assert.equal(plain.bound, false)
  assert.deepEqual(plain.platforms, [])
})

test('scanHome: includes plugin payloads verbatim and drops data/secrets', async () => {
  const scan = await scanHome(home, { sourcePlatform: 'linux-x64' })
  const paths = scan.entries.map((entry) => entry.path)

  // packed
  for (const expected of [
    'AGENTS.md', 'cordis.patch.yml', 'dream-skin.json', '.anonymous-user-id', 'whale-audio/a.mp3',
    'skills/demo/SKILL.md', 'plugins/dsh-demo/entry.js', 'plugins/dsh-demo/docs/logs/keep.txt',
    'plugins/dsh-demo/assets/clip.mp4', 'plugins/dsh-demo/runtime/linux-x64/worker',
    'profiles/web/package.json', 'profiles/web/cordis.patch.yml', 'profiles/web/pnpm-lock.yaml',
    'profiles/web/node_modules/dep/index.js', 'artifacts/dsh-ops-0.3.1-linux-x64.tgz',
    'storages/workspace.json',
  ]) {
    assert.ok(paths.includes(expected), `missing from inventory: ${expected}`)
  }

  // excluded
  const excludedPaths = scan.excluded.map((entry) => entry.path)
  for (const unexpected of ['sessions/s1.json', 'attachments/a.png', 'logs/startup.log', 'storages/session_projcache/cache.bin']) {
    assert.ok(!paths.includes(unexpected), `must not be packed: ${unexpected}`)
  }
  // Pruned roots are reported once (the scan must not walk 47 MB of session data),
  // while the non-pruned storages exception is reported at the child level.
  for (const expected of ['sessions', 'attachments', 'logs', 'storages/session_projcache']) {
    assert.ok(excludedPaths.includes(expected), `must be reported as excluded: ${expected}`)
  }
  assert.ok(paths.includes('storages/workspace.json'), 'storages/workspace.json is config, not session data')
  for (const secret of ['.credentials.yaml', '.credentials.bak']) {
    assert.ok(!paths.includes(secret), `secret must never be packed: ${secret}`)
  }
  assert.ok(!paths.includes('profiles/web/cordis.yml'), 'cordis.yml is regenerated')
  assert.ok(!paths.includes('profiles/web/.plugin-manager/logs/pnpm.log'))
  assert.ok(!paths.includes('.DS_Store'))
  assert.ok(!paths.includes('.dsh-rollback-20260101/cordis.patch.yml'))

  // optional model cache is reported, not packed
  assert.ok(scan.optional.some((entry) => entry.path === 'speech-to-text'), 'model cache reported as optional, not packed')
  assert.ok(!paths.includes('speech-to-text/sensevoice/models/model.onnx'))

  // platform binding detected for the ELF payload and the linux-named tarball
  const worker = scan.entries.find((entry) => entry.path.endsWith('worker'))
  assert.deepEqual(worker.platformBound, ['linux'], 'ELF magic names the platform family, not the packing host')
  assert.match(worker.platformEvidence, /elf/)
  const tarball = scan.entries.find((entry) => entry.path.endsWith('.tgz'))
  assert.ok(tarball.platformBound.includes('linux-x64'))

  // totals
  assert.equal(scan.totals.files, scan.entries.length)
  assert.ok(scan.totals.bytes > 0)
  assert.equal(scan.totals.excluded, scan.excluded.length)
  assert.ok(scan.totals.byCategory[CATEGORY.plugin] > 0)
})

test('scanHome: includeModels pulls the model cache in', async () => {
  const scan = await scanHome(home, { includeModels: true })
  assert.ok(scan.entries.some((entry) => entry.path.startsWith('speech-to-text/')))
  assert.equal(scan.optional.length, 0)
})
