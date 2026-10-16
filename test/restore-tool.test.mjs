import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { pack } from '../lib/core/pack.mjs'
import { extractZip } from '../lib/core/zip.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(repoRoot, 'tools', 'restore.mjs')

let root
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-migrate-restore-tool-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

async function buildArchive(name) {
  const home = join(root, `${name}-src`)
  const put = async (relative, content) => {
    const path = join(home, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  await put('AGENTS.md', '# instructions\n')
  await put('plugins/dsh-demo/entry.js', 'export function apply() {}\n')
  await put('profiles/web/package.json', JSON.stringify({ dependencies: { 'dsh-ops': `file:${home}/artifacts/x.tgz` } }, null, 2))
  await put('.credentials.yaml', 'refs:\n  KEY: secret\n')

  const zipPath = join(root, `${name}.zip`)
  await pack({ home, outPath: zipPath })
  const extracted = join(root, `${name}-extracted`)
  await extractZip(zipPath, extracted)
  await mkdir(join(extracted, 'dsh-migrate-tools'), { recursive: true })
  await cp(script, join(extracted, 'dsh-migrate-tools', 'restore.mjs'))
  return { home, extracted }
}

const runRestore = (args, options = {}) => execFileSync(process.execPath, [join('dsh-migrate-tools', 'restore.mjs'), ...args], {
  encoding: 'utf8',
  cwd: options.cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
})

test('standalone restore.mjs: dry run writes nothing, --yes migrates and rewrites', async () => {
  const { home, extracted } = await buildArchive('tool')
  const targetHome = join(root, 'tool-target')

  const dry = runRestore([], { cwd: extracted })
  assert.match(dry, /dry-run/)
  await assert.rejects(() => readFile(join(targetHome, 'AGENTS.md')), /ENOENT/)

  const applied = runRestore(['--home', targetHome, '--yes'], { cwd: extracted })
  assert.match(applied, /已写入/)
  assert.equal(await readFile(join(targetHome, 'AGENTS.md'), 'utf8'), '# instructions\n')
  const pkg = JSON.parse(await readFile(join(targetHome, 'profiles', 'web', 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies['dsh-ops'].startsWith(`file:${targetHome}`), pkg.dependencies['dsh-ops'])
  assert.ok(!pkg.dependencies['dsh-ops'].includes(home))
  await assert.rejects(() => readFile(join(targetHome, '.credentials.yaml')), /ENOENT/)
})

test('standalone restore.mjs: backs up an existing home and supports --json', async () => {
  const { extracted } = await buildArchive('tool2')
  const targetHome = join(root, 'tool2-target')
  await mkdir(targetHome, { recursive: true })
  await writeFile(join(targetHome, 'OLD.txt'), 'old\n')

  const output = runRestore(['--home', targetHome, '--yes', '--json'], { cwd: extracted })
  const summary = JSON.parse(output.slice(output.indexOf('{')))
  assert.equal(summary.ok, true)
  assert.ok(summary.backupPath)
  assert.equal(await readFile(join(summary.backupPath, 'OLD.txt'), 'utf8'), 'old\n')
  await assert.rejects(() => readFile(join(targetHome, 'OLD.txt')), /ENOENT/)
})

test('standalone restore.mjs: refuses a root without a manifest', async () => {
  const empty = join(root, 'tool3-empty')
  await mkdir(empty, { recursive: true })
  assert.throws(
    () => execFileSync(process.execPath, [script, '--root', empty], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    (error) => /manifest/.test(String(error.stderr)),
  )
})
