import { strict as assert } from 'node:assert'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

test('manifest declares the bundle layer', () => {
  const patch = pkg.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string')
  assert.ok(existsSync(join(repoRoot, patch)), `patch file missing: ${patch}`)
  const yaml = readFileSync(join(repoRoot, patch), 'utf8')
  assert.match(yaml, /insert:/, 'patch must insert the dsh-migrate row')
  assert.match(yaml, /name: 'dsh-migrate'/)
  // Overriding skill-filesystem would replace the row's whole config and drop the
  // upstream agent-preset skills; the bundled skill goes through the runtime registry.
  assert.doesNotMatch(yaml, /skill-filesystem/)
  assert.doesNotMatch(yaml, /customSkillDirs/)
})

test('icon is declared at the top level and stays under 256 KiB', () => {
  assert.equal(typeof pkg.icon, 'string', '0.2.0-rc.2 only honors a top-level "icon"')
  const iconPath = join(repoRoot, pkg.icon.replace(/^\.\//, ''))
  assert.ok(existsSync(iconPath))
  assert.ok(statSync(iconPath).size <= 256 * 1024)
  assert.match(pkg.icon, /\.svg$/)
})

test('exports expose the entry, the patch and package.json', () => {
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./package.json'], './package.json')
  assert.ok(existsSync(join(repoRoot, pkg.exports['./cordis.patch.yml'])))
  for (const target of Object.values(pkg.exports)) {
    if (typeof target === 'string' && target.startsWith('./')) {
      assert.ok(existsSync(join(repoRoot, target)), `exports target missing: ${target}`)
    }
  }
})

test('@deepseek-ai/* stays out of dependencies', () => {
  const deps = Object.keys(pkg.dependencies ?? {})
  assert.deepEqual(deps.filter((d) => d.startsWith('@deepseek-ai/')), [])
  assert.ok(pkg.peerDependencies['@deepseek-ai/schemastery'])
})

test('published file list stays inside the repository', () => {
  for (const entry of pkg.files) {
    assert.ok(existsSync(join(repoRoot, entry)), `files entry missing: ${entry}`)
  }
})
