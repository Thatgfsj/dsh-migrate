import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { assertArchiveIsClean, pack, PackError } from '../lib/core/pack.mjs'
import { MANIFEST_ENTRY, sha256File, validateManifest } from '../lib/core/manifest.mjs'
import { extractZip, listZip, verifyZip } from '../lib/core/zip.mjs'

let root
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-migrate-pack-'))
})
after(async () => {
  await rm(root, { recursive: true, force: true })
})

/** A synthetic DSH home: plugins, profile with installed deps, skills, context, plus data/secrets that must be dropped. */
async function buildHome(name) {
  const home = join(root, name)
  const put = async (relative, content) => {
    const path = join(home, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  await put('AGENTS.md', '# 全局指令：回复必须用中文\n')
  await put('cordis.patch.yml', '[]\n')
  await put('skills/demo/SKILL.md', '---\nname: demo\ndescription: demo skill\n---\nbody\n')
  await put('plugins/dsh-demo/entry.js', 'export function apply() {}\n')
  await put('plugins/dsh-demo/assets/clip.mp4', Buffer.alloc(4096, 7))
  await put('plugins/dsh-demo/runtime/linux-x64/worker', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]))
  await put('profiles/web/package.json', '{"name":"dsh-profile-web"}\n')
  await put('profiles/web/cordis.patch.yml', '[]\n')
  await put('profiles/web/node_modules/dep/index.js', 'export default 42\n')
  await put('artifacts/dsh-ops-0.3.1-linux-x64.tgz', 'tarball')
  // must be excluded
  await put('.credentials.yaml', 'refs:\n  DEEPSEEK_API_KEY: <redacted>\n')
  await put('sessions/abc/session.json', '{}\n')
  await put('logs/startup.log', 'boot\n')
  return home
}

test('pack: produces a verifiable archive whose manifest matches its payload', async () => {
  const home = await buildHome('home-main')
  const outPath = join(root, 'main.zip')
  const events = []
  const result = await pack({ home, outPath, generator: { name: 'dsh-migrate', version: '0.0.0-test' }, onProgress: (event) => events.push(event) })

  assert.equal(result.ok, true)
  assert.equal(result.verification.ok, true)
  assert.equal(result.verification.checked, true)
  assert.ok(result.bytes > 0)

  // progress covers every phase and finishes at 100%
  const phases = events.map((event) => event.phase)
  for (const phase of ['scan', 'secrets', 'hash', 'archive', 'verify']) assert.ok(phases.includes(phase), `missing progress phase ${phase}`)
  assert.equal(Math.max(...events.map((event) => event.percent)), 100)

  const { entries } = await listZip(outPath)
  const names = entries.map((entry) => entry.name)
  assert.ok(names.includes(MANIFEST_ENTRY))

  // nothing forbidden survived, whatever the inventory said
  assert.doesNotThrow(() => assertArchiveIsClean(entries))
  for (const name of names) {
    assert.ok(!name.includes('.credentials'), `secret leaked: ${name}`)
    assert.ok(!name.startsWith('sessions/'), `session data leaked: ${name}`)
    assert.ok(!name.startsWith('logs/'), `log leaked: ${name}`)
  }

  // plugin payload is packed verbatim, including the linux-x64 worker and the media asset
  assert.ok(names.includes('plugins/dsh-demo/entry.js'))
  assert.ok(names.includes('plugins/dsh-demo/assets/clip.mp4'))
  assert.ok(names.includes('plugins/dsh-demo/runtime/linux-x64/worker'))

  // manifest <-> payload agreement
  const extracted = join(root, 'out-main')
  await extractZip(outPath, extracted)
  const manifest = JSON.parse(await readFile(join(extracted, MANIFEST_ENTRY), 'utf8'))
  assert.equal(validateManifest(manifest).ok, true, validateManifest(manifest).errors.join('; '))
  assert.equal(manifest.source.generator.version, '0.0.0-test')
  assert.equal(manifest.sensitiveScan.clean, true)
  assert.equal(manifest.totals.files, manifest.entries.filter((entry) => entry.type === 'file').length)

  const fileNames = entries.filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name).sort()
  const manifestNames = [MANIFEST_ENTRY, ...manifest.entries.filter((entry) => entry.type === 'file').map((entry) => entry.path)].sort()
  assert.deepEqual(fileNames, manifestNames, 'zip payload must equal manifest entries')

  for (const entry of manifest.entries.filter((item) => item.type === 'file')) {
    const digest = await sha256File(join(extracted, entry.path))
    assert.equal(digest, entry.sha256, `sha256 mismatch for ${entry.path}`)
  }

  const verification = await verifyZip(outPath)
  assert.equal(verification.ok, true)
})

test('pack: manifest records platform-bound payloads with evidence', async () => {
  const home = await buildHome('home-platform')
  const result = await pack({ home, outPath: join(root, 'platform.zip'), verify: false })
  const worker = result.manifest.platformBound.find((entry) => entry.path.endsWith('worker'))
  assert.ok(worker, 'the ELF payload must be listed as platform bound')
  assert.ok(worker.platforms.includes('linux'), `expected the linux family, got ${worker.platforms.join(',')}`)
  assert.match(worker.evidence, /elf/)
  const tarball = result.manifest.platformBound.find((entry) => entry.path.endsWith('.tgz'))
  assert.ok(tarball.platforms.includes('linux-x64'))
})

test('pack: refuses to pack a credential and reports it masked', async () => {
  const home = await buildHome('home-secret')
  await writeFile(join(home, 'plugins/dsh-demo/leak.env'), 'OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz\n', { flag: 'w' })
  await assert.rejects(
    () => pack({ home, outPath: join(root, 'secret.zip'), verify: false }),
    (error) => {
      assert.ok(error instanceof PackError)
      assert.equal(error.code, 'SECRET_FOUND')
      assert.ok(!error.message.includes('abcdefghijklmnopqrstuvwxyz'), 'the error must not echo the credential')
      assert.ok(error.findings.length >= 1)
      assert.ok(error.findings[0].masked.startsWith('sk-a'))
      return true
    },
  )
})

test('pack: a cancelled run leaves no half-written archive and never touches the home', async () => {
  const home = await buildHome('home-cancel')
  const outPath = join(root, 'cancelled.zip')
  const before = await sha256File(join(home, 'AGENTS.md'))
  await assert.rejects(
    () => pack({
      home,
      outPath,
      verify: false,
      onProgress: (event) => { if (event.phase === 'archive' && event.done > 0) throw new Error('user cancelled') },
    }),
    /user cancelled/,
  )
  await assert.rejects(() => readFile(outPath), /ENOENT/)
  assert.equal(await sha256File(join(home, 'AGENTS.md')), before, 'packing must not modify the source home')
})

test('pack: rejects bad arguments and empty homes', async () => {
  const home = await buildHome('home-args')
  await assert.rejects(() => pack({ home, outPath: join(root, 'x.tar') }), /must end with .zip/)
  await assert.rejects(() => pack({ outPath: join(root, 'x.zip') }), /home is required/)

  const empty = join(root, 'empty-home')
  await mkdir(empty, { recursive: true })
  await assert.rejects(() => pack({ home: empty, outPath: join(root, 'empty.zip') }), (error) => error.code === 'EMPTY_HOME')
})

test('assertArchiveIsClean: unit matrix', () => {
  assert.doesNotThrow(() => assertArchiveIsClean([{ name: 'plugins/a/entry.js' }, { name: 'storages/workspace.json' }]))
  for (const name of ['.credentials.yaml', 'a/.credentials.bak', 'sessions/x/y.json', 'attachments/a.png', 'logs/x.log', 'storages/session_projcache/x']) {
    assert.throws(() => assertArchiveIsClean([{ name }]), (error) => error.code === 'FORBIDDEN_CONTENT', `expected ${name} to be rejected`)
  }
})
