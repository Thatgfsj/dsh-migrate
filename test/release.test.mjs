import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { after, before, test } from 'node:test'

import { pack } from '../lib/core/pack.mjs'
import { backupPathFor, defaultTargetHome, payloadEntries, release, ReleaseError } from '../lib/core/release.mjs'
import { findResiduals } from '../lib/core/rewrite.mjs'
import { sha256File } from '../lib/core/manifest.mjs'
import { ZipWriter, extractZip } from '../lib/core/zip.mjs'

let root
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-migrate-release-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function buildHome(name) {
  const home = join(root, name)
  const put = async (relative, content) => {
    const path = join(home, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  await put('AGENTS.md', '# 全局指令\n')
  await put('skills/demo/SKILL.md', '---\nname: demo\ndescription: d\n---\nbody\n')
  await put('plugins/dsh-demo/entry.js', 'export function apply() {}\n')
  await put('plugins/dsh-demo/runtime/linux-x64/worker', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]))
  await put('profiles/web/package.json', JSON.stringify({
    name: 'dsh-profile-web',
    dependencies: { 'dsh-ops': `file:${home}/artifacts/dsh-ops-0.3.1-linux-x64.tgz` },
  }, null, 2))
  await put('profiles/web/cordis.patch.yml', `config:\n  root: ${home}/plugins\n`)
  await put('artifacts/dsh-ops-0.3.1-linux-x64.tgz', 'tarball')
  await put('storages/workspace.json', '[]')
  // policy: never packed
  await put('.credentials.yaml', 'refs:\n  DEEPSEEK_API_KEY: sk-should-never-ship\n')
  await put('sessions/abc/session.json', '{}\n')
  return home
}

test('defaultTargetHome / backupPathFor', () => {
  assert.equal(defaultTargetHome({ DSH_HOME: '/custom/home' }, '/home/me'), '/custom/home')
  assert.equal(defaultTargetHome({}, '/home/me'), join('/home/me', '.dsh'))
  assert.match(backupPathFor('/target/.dsh', new Date(Date.UTC(2026, 9, 17, 1, 2))), /\.dsh\.bak-\d{8}-\d{4}$/)
})

test('release: end-to-end into a fresh home, with rewrite and zero residuals', async () => {
  const source = await buildHome('src-fresh')
  const zipPath = join(root, 'fresh.zip')
  await pack({ home: source, outPath: zipPath })
  const targetHome = join(root, 'target-fresh')

  const plan = await release({ zipPath, targetHome, dryRun: true })
  assert.equal(plan.ok, true)
  assert.ok(plan.created > 0)
  assert.equal(plan.dryRun, true)
  await assert.rejects(() => readFile(join(targetHome, 'AGENTS.md')), /ENOENT/, 'dry run must not write')

  // checkPostInstall: false keeps this test hermetic; the self-check has its own tests.
  const result = await release({ zipPath, targetHome, dryRun: false, checkPostInstall: false })
  assert.equal(result.ok, true)
  assert.equal(result.backupPath, null, 'no backup when the target does not exist')
  assert.equal(result.residuals.length, 0, JSON.stringify(result.residuals))

  assert.equal(await sha256File(join(targetHome, 'AGENTS.md')), await sha256File(join(source, 'AGENTS.md')))
  assert.equal(await sha256File(join(targetHome, 'plugins/dsh-demo/entry.js')), await sha256File(join(source, 'plugins/dsh-demo/entry.js')))
  assert.equal(await sha256File(join(targetHome, 'storages/workspace.json')), await sha256File(join(source, 'storages/workspace.json')))

  // absolute dependencies were pointed at the new home
  const pkg = JSON.parse(await readFile(join(targetHome, 'profiles/web/package.json'), 'utf8'))
  assert.ok(pkg.dependencies['dsh-ops'].includes(targetHome), pkg.dependencies['dsh-ops'])
  assert.ok(!pkg.dependencies['dsh-ops'].includes(source))
  assert.ok((await readFile(join(targetHome, 'profiles/web/cordis.patch.yml'), 'utf8')).includes(targetHome))
  assert.equal((await findResiduals(targetHome, [source])).length, 0)

  // policy: credentials and session data never arrive
  await assert.rejects(() => readFile(join(targetHome, '.credentials.yaml')), /ENOENT/)
  await assert.rejects(() => readFile(join(targetHome, 'sessions/abc/session.json')), /ENOENT/)
})

test('release: existing home is renamed aside, never merged silently', async () => {
  const source = await buildHome('src-backup')
  const zipPath = join(root, 'backup.zip')
  await pack({ home: source, outPath: zipPath })
  const targetHome = join(root, 'target-backup')
  await mkdir(targetHome, { recursive: true })
  await writeFile(join(targetHome, 'OLD-MARKER.txt'), 'previous install\n')

  // checkPostInstall: false keeps this test hermetic; the self-check has its own tests.
  const result = await release({ zipPath, targetHome, dryRun: false, checkPostInstall: false })
  assert.equal(result.ok, true)
  assert.ok(result.backupPath, 'a backup must be taken')
  assert.equal(await readFile(join(result.backupPath, 'OLD-MARKER.txt'), 'utf8'), 'previous install\n')
  await assert.rejects(() => readFile(join(targetHome, 'OLD-MARKER.txt')), /ENOENT/)
  assert.ok(await readFile(join(targetHome, 'AGENTS.md'), 'utf8'))
})

test('release: merge writes into the existing home without a backup', async () => {
  const source = await buildHome('src-merge')
  const zipPath = join(root, 'merge.zip')
  await pack({ home: source, outPath: zipPath })
  const targetHome = join(root, 'target-merge')
  await mkdir(targetHome, { recursive: true })
  await writeFile(join(targetHome, 'KEEP.txt'), 'keep me\n')

  const result = await release({ zipPath, targetHome, dryRun: false, merge: true, checkPostInstall: false })
  assert.equal(result.backupPath, null)
  assert.equal(await readFile(join(targetHome, 'KEEP.txt'), 'utf8'), 'keep me\n')
  assert.ok(await readFile(join(targetHome, 'AGENTS.md'), 'utf8'))
})

test('release: platform-incompatible payloads are skipped and reported', async () => {
  const source = await buildHome('src-platform')
  const zipPath = join(root, 'platform.zip')
  await pack({ home: source, outPath: zipPath })
  const targetHome = join(root, 'target-platform')

  const result = await release({ zipPath, targetHome, dryRun: false, targetPlatform: 'win32-x64', checkPostInstall: false })
  assert.ok(result.skipped.some((item) => item.path.endsWith('worker')), JSON.stringify(result.skipped))
  await assert.rejects(() => readFile(join(targetHome, 'plugins/dsh-demo/runtime/linux-x64/worker')), /ENOENT/)
  assert.ok(await readFile(join(targetHome, 'plugins/dsh-demo/entry.js'), 'utf8'))
})

test('release: refuses a tampered archive', async () => {
  const source = await buildHome('src-tamper')
  const zipPath = join(root, 'tamper.zip')
  await pack({ home: source, outPath: zipPath })

  // Rebuild with a lying manifest: sha256 replaced.
  const staging = join(root, 'tamper-stage')
  await extractZip(zipPath, staging)
  const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8'))
  manifest.entries.find((entry) => entry.path === 'AGENTS.md').sha256 = 'f'.repeat(64)
  const rebuilt = join(root, 'tamper-rebuilt.zip')
  const zip = await ZipWriter.create(rebuilt)
  await zip.add({ name: 'manifest.json', type: 'file', content: Buffer.from(JSON.stringify(manifest, null, 2)) })
  await zip.addTree(staging, { prefix: '', filter: (relative) => relative !== 'manifest.json' })
  await zip.close()

  await assert.rejects(
    () => release({ zipPath: rebuilt, targetHome: join(root, 'target-tamper'), dryRun: false }),
    (error) => error instanceof ReleaseError && error.code === 'VERIFY_FAILED',
  )
  await assert.rejects(() => readFile(join(root, 'target-tamper', 'AGENTS.md')), /ENOENT/, 'nothing may be written')
})


test('release: post-install self-check never fails the release', async () => {
  const source = await buildHome('src-postinstall')
  const zipPath = join(root, 'postinstall.zip')
  await pack({ home: source, outPath: zipPath })
  const targetHome = join(root, 'target-postinstall')

  // A missing dsh must degrade to checked:false + warning, never throw (#46).
  const result = await release({
    zipPath, targetHome, dryRun: false,
    dshBin: 'dsh-migrate-definitely-not-installed',
  })
  assert.equal(result.ok, true)
  assert.equal(result.postInstall.checked, false)
  assert.equal(result.postInstall.profile, 'web', 'defaults to the web profile')
  assert.deepEqual(result.postInstall.skippedBundles, [])
  assert.ok(result.postInstall.warnings.some((warning) => warning.includes('自检未完成')), JSON.stringify(result.postInstall.warnings))
})

test('payloadEntries only returns files', () => {
  const entries = payloadEntries({ entries: [{ path: 'a', type: 'file' }, { path: 'b', type: 'dir' }] })
  assert.deepEqual(entries.map((entry) => entry.path), ['a'])
  assert.equal(basename('/x/y.zip'), 'y.zip')
})
