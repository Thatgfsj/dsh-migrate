import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { collectTooling, pack } from '../lib/core/pack.mjs'
import { bootstrapCommand, release } from '../lib/core/release.mjs'
import { verifyArchive } from '../lib/core/verify.mjs'
import { extractZip, listZip } from '../lib/core/zip.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let root
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-migrate-tooling-'))
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
  await put('AGENTS.md', '# instructions\n')
  await put('plugins/dsh-demo/entry.js', 'export function apply() {}\n')
  await put('profiles/web/package.json', '{"name":"dsh-profile-web"}\n')
  return home
}

const toolingOptions = { toolingDir: join(repoRoot, 'tools'), pluginDir: repoRoot }

test('collectTooling: restore tool + embedded plugin copy', async () => {
  const files = await collectTooling(toolingOptions)
  const names = files.map((file) => file.name)
  assert.ok(names.includes('dsh-migrate-tools/restore.mjs'))
  assert.ok(names.includes('dsh-migrate-tools/restore.cmd'))
  assert.ok(names.includes('dsh-migrate-tools/RESTORE.md'))
  assert.ok(names.includes('dsh-migrate-tools/plugin/package.json'))
  assert.ok(names.includes('dsh-migrate-tools/plugin/lib/index.js'))
  assert.ok(names.every((name) => name.startsWith('dsh-migrate-tools/')))
})

test('pack embeds tooling and keeps it out of the payload list', async () => {
  const home = await buildHome('tooling-home')
  const zipPath = join(root, 'tooling.zip')
  const result = await pack({ home, outPath: zipPath, tooling: toolingOptions })

  const toolingPaths = result.manifest.tooling.map((entry) => entry.path)
  assert.ok(toolingPaths.includes('dsh-migrate-tools/restore.mjs'))
  assert.ok(result.manifest.entries.every((entry) => !entry.path.startsWith('dsh-migrate-tools/')), 'tooling must not be a payload entry')

  const { entries } = await listZip(zipPath)
  assert.ok(entries.some((entry) => entry.name === 'dsh-migrate-tools/plugin/package.json'))

  // payload agreement still holds, and tooling hashes are verified too
  const report = await verifyArchive(zipPath, { hash: true })
  assert.deepEqual(report.errors, [])
  assert.equal(report.hashed, result.manifest.entries.length + result.manifest.tooling.length)
})

test('release installs the embedded plugin copy under plugins/, and never in the home root', async () => {
  const home = await buildHome('release-home')
  const zipPath = join(root, 'release-tooling.zip')
  await pack({ home, outPath: zipPath, tooling: toolingOptions })
  const targetHome = join(root, 'release-target')

  const result = await release({ zipPath, targetHome, dryRun: false, bootstrap: false })
  assert.equal(result.bootstrap.attempted, false)
  assert.equal(result.bootstrap.reason, 'disabled')
  assert.ok(await readFile(join(targetHome, 'plugins', 'dsh-migrate', 'package.json'), 'utf8'))
  assert.ok(await readFile(join(targetHome, 'plugins', 'dsh-migrate', 'lib', 'index.js'), 'utf8'))
  await assert.rejects(() => readFile(join(targetHome, 'package.json')), /ENOENT/, 'tooling must not land in the home root')
})

test('release attempts the bootstrap command and reports failures without aborting', async () => {
  const home = await buildHome('bootstrap-home')
  const zipPath = join(root, 'bootstrap.zip')
  await pack({ home, outPath: zipPath, tooling: toolingOptions })
  const targetHome = join(root, 'bootstrap-target')

  // process.execPath is node: "node plugin --profile web add <path>" fails, which is
  // exactly the failure path we want to exercise without touching a real dsh.
  const result = await release({ zipPath, targetHome, dryRun: false, dshBin: process.execPath })
  assert.equal(result.bootstrap.attempted, true)
  assert.equal(result.bootstrap.ok, false)
  assert.equal(result.bootstrap.profile, 'web')
  assert.match(result.bootstrap.command, /plugin --profile web add/)
  assert.ok(result.warnings.some((warning) => warning.includes('自动安装插件失败')))
  assert.ok(await readFile(join(targetHome, 'AGENTS.md'), 'utf8'), 'the release itself must still have succeeded')
})

test('bootstrap needs an unambiguous profile', async () => {
  const home = await buildHome('ambiguous-home')
  await writeFile(join(home, 'profiles', 'ops-test', 'package.json'), '{}\n', { flag: 'w' }).catch(async () => {
    await mkdir(join(home, 'profiles', 'ops-test'), { recursive: true })
    await writeFile(join(home, 'profiles', 'ops-test', 'package.json'), '{}\n')
  })
  const zipPath = join(root, 'ambiguous.zip')
  await pack({ home, outPath: zipPath, tooling: toolingOptions })
  const targetHome = join(root, 'ambiguous-target')
  const result = await release({ zipPath, targetHome, dryRun: false, dshBin: process.execPath })
  assert.equal(result.bootstrap.attempted, false)
  assert.match(result.bootstrap.reason, /多个 profile/)
  assert.match(result.bootstrap.command, /dsh plugin --profile <profile> add/)
})

test('bootstrapCommand builds the documented command', () => {
  const { command, args } = bootstrapCommand({ profile: 'web', pluginPath: '/home/me/.dsh/plugins/dsh-migrate' })
  assert.equal(command, 'dsh')
  assert.deepEqual(args, ['plugin', '--profile', 'web', 'add', '/home/me/.dsh/plugins/dsh-migrate'])
})

test('standalone restore.mjs also places the embedded plugin copy', async () => {
  const { execFileSync } = await import('node:child_process')
  const home = await buildHome('standalone-home')
  const zipPath = join(root, 'standalone.zip')
  await pack({ home, outPath: zipPath, tooling: toolingOptions })
  const extracted = join(root, 'standalone-extracted')
  await extractZip(zipPath, extracted)

  const targetHome = join(root, 'standalone-target')
  const output = execFileSync(process.execPath, [join('dsh-migrate-tools', 'restore.mjs'), '--home', targetHome, '--yes'], {
    cwd: extracted, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert.match(output, /插件副本已放到/)
  assert.ok(await readFile(join(targetHome, 'plugins', 'dsh-migrate', 'package.json'), 'utf8'))
})
