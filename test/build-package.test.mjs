import { strict as assert } from 'node:assert'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { buildPackage } from '../scripts/build-package.mjs'
import { listZip, verifyZip } from '../lib/core/zip.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('buildPackage produces a verifiable, self-contained deliverable zip', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'dsh-migrate-package-'))
  t.after(async () => { await rm(outDir, { recursive: true, force: true }) })

  const result = await buildPackage({ outDir })
  assert.match(result.zipPath, /dsh-migrate-\d+\.\d+\.\d+\.zip$/)
  assert.ok((await stat(result.zipPath)).size > 10_000)

  const verification = await verifyZip(result.zipPath)
  assert.deepEqual(verification.errors, [])
  assert.equal(verification.ok, true)

  const { entries } = await listZip(result.zipPath)
  const names = new Set(entries.map((entry) => entry.name))
  const prefix = `dsh-migrate-${result.version}`
  for (const rel of [
    'package.json', 'cordis.patch.yml', 'icon.svg', 'README.md', 'LICENSE',
    'install.sh', 'install.cmd', 'lib/index.js', 'lib/client.js',
    'skills/dsh-migration/SKILL.md', 'skills/dsh-migration/references/workflow.md',
    'locale/zh.json', 'tools/restore.mjs', 'tools/restore.sh',
  ]) {
    assert.ok(names.has(`${prefix}/${rel}`), `package zip is missing ${rel}`)
  }

  if (process.platform !== 'win32') {
    const restore = entries.find((entry) => entry.name.endsWith('tools/restore.sh'))
    assert.ok((restore.mode & 0o111) !== 0, 'restore.sh must stay executable inside the zip')
  }

  // The published file list and the zip must agree on what "the package" is.
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(repoRoot, 'package.json'), 'utf8'))
  for (const listed of pkg.files) {
    assert.ok(names.has(`${prefix}/${listed}`) || [...names].some((name) => name.startsWith(`${prefix}/${listed}/`)),
      `package.json#files entry ${listed} is not in the zip`)
  }
})
