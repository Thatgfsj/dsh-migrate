import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(repoRoot, 'lib', 'index.js'), 'utf8')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

// NOTE: the entry file imports @deepseek-ai/* peers, which exist only inside a DSH
// installation. CI therefore checks its shape statically; the mounted behaviour is
// verified against a real profile (see the smoke script) on a machine that has dsh.
test('host half exports a function-plugin shape', () => {
  assert.match(source, /export const name = 'dsh-migrate'/)
  assert.match(source, /export const inject = \['tools'\]/)
  assert.match(source, /export function apply\(ctx, config = \{\}\)/)
  assert.match(source, /export const Config = Schema\.object\(/)
  assert.doesNotMatch(source, /export default/, 'function plugins must not also default-export')
})

test('entry file registers both 大肥鱼 tools through the shared descriptors', () => {
  assert.match(source, /createToolDescriptors/)
  assert.match(source, /ctx\.tools\.register\(defineTool\(descriptor\)\)/)
})

test('entry file only imports @deepseek-ai/* packages that are peers', () => {
  const peers = new Set(Object.keys(pkg.peerDependencies ?? {}))
  const imported = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])
  for (const spec of imported) {
    if (spec.startsWith('@deepseek-ai/')) {
      assert.ok(peers.has(spec), `${spec} must be declared in peerDependencies`)
    }
    assert.ok(spec.startsWith('node:') || spec.startsWith('.') || peers.has(spec), `unexpected import ${spec}`)
  }
})
