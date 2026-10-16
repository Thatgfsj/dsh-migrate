import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = await import(join(repoRoot, 'lib', 'index.js'))

test('host half exports a function-plugin shape', () => {
  assert.equal(entry.name, 'dsh-migrate')
  assert.equal(typeof entry.apply, 'function')
  assert.ok(Array.isArray(entry.inject), 'inject must be an array')
  assert.equal(entry.default, undefined, 'function plugins must not also default-export')
})

test('entry file only imports @deepseek-ai/* packages that are peers', () => {
  const source = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const peers = new Set(Object.keys(pkg.peerDependencies ?? {}))
  const imported = [...source.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1])
  for (const spec of imported) {
    if (spec.startsWith('@deepseek-ai/')) {
      assert.ok(peers.has(spec), `${spec} must be declared in peerDependencies`)
    }
    assert.ok(spec.startsWith('node:') || spec.startsWith('.') || peers.has(spec), `unexpected import ${spec}`)
  }
})
