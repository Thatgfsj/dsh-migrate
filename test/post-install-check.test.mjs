import { strict as assert } from 'node:assert'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { parseProfileDiagnostics, postInstallCheck } from '../lib/core/release.mjs'

// Verbatim 0.2.1-rc.2 wording from issue #46.
const SKIPPING = [
  `dsh: skipping profile bundle "dsh-migrate": Error: dsh: cannot resolve profile bundle "dsh-migrate"`,
  `from the dsh installation or /tmp/x/profiles/web-migrated;`,
  `run 'dsh plugin --profile web-migrated install' if its dependency is not installed`,
].join('\n')

let root
before(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-migrate-postinstall-')) })
after(async () => { await rm(root, { recursive: true, force: true }) })

/** Create `home/profiles/<name>/package.json` for every requested profile. */
async function makeHome(name, profiles = []) {
  const home = join(root, name)
  for (const profile of profiles) {
    const file = join(home, 'profiles', profile, 'package.json')
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify({ name: `dsh-profile-${profile}` }))
  }
  return home
}

/** Executable fake `dsh`: counts calls, optionally sleeps, prints `message`, exits `code`. */
async function fakeDsh(name, message, code, { sleepSeconds = 0 } = {}) {
  const messagePath = join(root, `${name}.txt`)
  const counterPath = join(root, `${name}.calls`)
  const script = join(root, name)
  await writeFile(messagePath, message)
  const lines = [
    '#!/bin/sh',
    `echo x >> "${counterPath}"`,
    sleepSeconds > 0 ? `sleep ${sleepSeconds}` : 'true',
    `cat "${messagePath}" >&2`,
    'echo "DSH_HOME=$DSH_HOME"',
    `exit ${code}`,
  ]
  await writeFile(script, lines.join('\n') + '\n')
  await chmod(script, 0o755)
  return { script, counterPath }
}

test('parseProfileDiagnostics reads the 0.2.1 skipping message', () => {
  const parsed = parseProfileDiagnostics(SKIPPING)
  assert.deepEqual(parsed.skippedBundles, ['dsh-migrate'])
  assert.deepEqual(parsed.missingPatches, [])
})

test('parseProfileDiagnostics dedupes bundles and catches missing patch targets', () => {
  const parsed = parseProfileDiagnostics(`${SKIPPING}\n${SKIPPING}\npatch: entry dsh-migrate not found\n`)
  assert.deepEqual(parsed.skippedBundles, ['dsh-migrate'])
  assert.deepEqual(parsed.missingPatches, ['patch: entry dsh-migrate not found'])
})

test('parseProfileDiagnostics tolerates empty input', () => {
  assert.deepEqual(parseProfileDiagnostics(undefined), { skippedBundles: [], missingPatches: [] })
  assert.deepEqual(parseProfileDiagnostics(''), { skippedBundles: [], missingPatches: [] })
})

test('postInstallCheck skips without a profile name and never guesses one', async () => {
  const result = await postInstallCheck({ dshBin: 'dsh-migrate-definitely-not-installed', targetHome: join(root, 'home-anon') })
  assert.equal(result.checked, false)
  assert.equal(result.command, null)
  assert.equal(result.profile, null)
  assert.ok(result.warnings.some((warning) => warning.includes('未指定 profile')), JSON.stringify(result.warnings))
})

// The major from the #52 review: `dsh --profile web --dump-config` creates a
// missing profile (0.2.1), so the check must refuse to spawn for a profile the
// released home does not already have.
test('postInstallCheck never spawns for a profile that is not there', async () => {
  const targetHome = await makeHome('home-noprofile')
  const result = await postInstallCheck({ dshBin: 'dsh-migrate-definitely-not-installed', targetHome, profile: 'web' })
  assert.equal(result.checked, false)
  assert.equal(result.output, '', 'no dsh output means no dsh was spawned')
  assert.ok(result.warnings.some((warning) => warning.includes('没有 profile')), JSON.stringify(result.warnings))
  assert.ok(!result.warnings.some((warning) => warning.includes('找不到命令')), 'spawning would have reported ENOENT instead')
})

test('postInstallCheck reports a missing dsh for an existing profile', async () => {
  const targetHome = await makeHome('home-missing-dsh', ['web'])
  const result = await postInstallCheck({ dshBin: 'dsh-migrate-definitely-not-installed', targetHome, profile: 'web' })
  assert.equal(result.checked, false)
  assert.equal(result.profile, 'web')
  assert.deepEqual(result.skippedBundles, [])
  assert.ok(result.warnings.some((warning) => warning.includes('找不到命令')), JSON.stringify(result.warnings))
})

const posixOnly = process.platform === 'win32' ? 'the fake dsh is a POSIX shell script' : false

test('postInstallCheck does not invoke dsh at all for a missing profile', { skip: posixOnly }, async () => {
  const targetHome = await makeHome('home-noprofile-counter')
  const { script, counterPath } = await fakeDsh('fake-dsh-count', SKIPPING, 0)
  const result = await postInstallCheck({ dshBin: script, targetHome, profile: 'web' })
  assert.equal(result.checked, false)
  assert.ok(result.warnings.some((warning) => warning.includes('没有 profile')), JSON.stringify(result.warnings))
  await assert.rejects(() => readFile(counterPath), /ENOENT/, 'the fake dsh must never run')
})

test('postInstallCheck inspects an existing profile and reports skipped bundles', { skip: posixOnly }, async () => {
  const targetHome = await makeHome('home-skip', ['web'])
  const { script, counterPath } = await fakeDsh('fake-dsh-skip', SKIPPING, 0)
  const result = await postInstallCheck({ dshBin: script, targetHome, profile: 'web' })
  assert.equal(result.checked, true)
  assert.deepEqual(result.skippedBundles, ['dsh-migrate'])
  assert.deepEqual(result.missingPatches, [])
  assert.ok(result.warnings.some((warning) => warning.includes('跳过了 profile bundle')), JSON.stringify(result.warnings))
  assert.equal(result.command, `${script} --profile web --dump-config`)
  assert.ok(result.output.includes(`DSH_HOME=${targetHome}`), 'must compose the released home, not the ambient one')
  assert.equal((await readFile(counterPath, 'utf8')).trim(), 'x', 'exactly one invocation')
})

test('postInstallCheck reports the exit code on a non-zero exit', { skip: posixOnly }, async () => {
  const targetHome = await makeHome('home-fail', ['tui'])
  const { script } = await fakeDsh('fake-dsh-fail', 'dsh: boom', 3)
  const result = await postInstallCheck({ dshBin: script, targetHome, profile: 'tui' })
  assert.equal(result.checked, false)
  assert.equal(result.profile, 'tui')
  assert.deepEqual(result.skippedBundles, [])
  assert.ok(result.warnings.some((warning) => warning.includes('自检命令退出码 3')), JSON.stringify(result.warnings))
})

test('postInstallCheck still surfaces findings from a non-zero exit', { skip: posixOnly }, async () => {
  const targetHome = await makeHome('home-skip-fail', ['web'])
  const { script } = await fakeDsh('fake-dsh-skip-fail', SKIPPING, 1)
  const result = await postInstallCheck({ dshBin: script, targetHome, profile: 'web' })
  assert.equal(result.checked, false)
  assert.deepEqual(result.skippedBundles, ['dsh-migrate'])
  assert.ok(result.warnings.some((warning) => warning.includes('跳过了 profile bundle')))
  assert.ok(result.warnings.some((warning) => warning.includes('自检未完成')))
})

test('postInstallCheck times out instead of hanging the release', { skip: posixOnly }, async () => {
  const targetHome = await makeHome('home-timeout', ['web'])
  const { script } = await fakeDsh('fake-dsh-hang', '', 0, { sleepSeconds: 30 })
  const result = await postInstallCheck({ dshBin: script, targetHome, profile: 'web', timeoutMs: 300 })
  assert.equal(result.checked, false)
  assert.ok(result.warnings.some((warning) => warning.includes('自检超时')), JSON.stringify(result.warnings))
})
