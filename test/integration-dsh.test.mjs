import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Locate the running dsh installation, or undefined when dsh is not installed. */
function findDshInstall() {
  let bin
  try {
    bin = execFileSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
  if (!bin) return undefined
  try {
    const entry = execFileSync('sh', ['-c', `realpath "${bin}"`], { encoding: 'utf8' }).trim()
    const installDir = resolve(entry, '..', '..')
    if (!existsSync(join(installDir, 'package.json'))) return undefined
    return installDir
  } catch {
    return undefined
  }
}

const dshInstall = findDshInstall()

// This test needs the @deepseek-ai/* peers, which only exist inside a DSH install.
// CI runners have no dsh; there the descriptor surface is covered by unit tests and
// the entry shape by test/entry.test.mjs.
test('host half mounts with the real DSH runtime and registers both tools', { skip: dshInstall ? false : 'dsh is not installed on this host' }, async (t) => {
  const peersDir = join(dshInstall, 'node_modules', '@deepseek-ai')
  const work = await mkdtemp(join(tmpdir(), 'dsh-migrate-integration-'))
  t.after(async () => { await rm(work, { recursive: true, force: true }) })

  // Resolve the peers the same way a profile would: a node_modules tree next to the plugin.
  const peerRoot = join(work, 'node_modules', '@deepseek-ai')
  await mkdir(peerRoot, { recursive: true })
  for (const peer of ['dsh-tools', 'schemastery', 'cordis']) {
    const source = join(peersDir, peer)
    if (!existsSync(source)) continue
    await symlink(await realpath(source), join(peerRoot, peer), 'dir')
  }
  await cp(join(repoRoot, 'lib'), join(work, 'plugin', 'lib'), { recursive: true })
  await cp(join(repoRoot, 'package.json'), join(work, 'plugin', 'package.json'))

  const plugin = await import(pathToFileURL(join(work, 'plugin', 'lib', 'index.js')).href)
  assert.equal(plugin.name, 'dsh-migrate')
  assert.deepEqual(plugin.inject, ['tools', 'skills'])
  assert.equal(typeof plugin.apply, 'function')
  assert.ok(plugin.Config, 'Config must be a Schemastery schema')

  const registered = []
  const registeredSkills = []
  const ctx = {
    tools: { register(tool) { registered.push(tool) } },
    skills: { register(skill) { registeredSkills.push(skill); return () => {} } },
  }
  plugin.apply(ctx, { skillsDir: join(repoRoot, 'skills') })

  assert.equal(registeredSkills.length, 1, 'the bundled migration skill must be registered')
  const skill = registeredSkills[0]
  assert.equal(skill.name, 'dsh-migration')
  assert.equal(skill.source, 'runtime')
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  assert.ok(skill.content.includes('# 搬运 DSH'))
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.match(skill.path, /SKILL\.md$/)

  assert.deepEqual(registered.map((tool) => tool.name), ['fatfish_pack', 'fatfish_release'])
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10)
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
  // The pack tool must resolve its default save location without a dialog in headless runs.
  const text = await registered[0].execute({ dryRun: true, savePath: '/tmp/probe.zip' })
  assert.match(text, /dry-run/)
})
