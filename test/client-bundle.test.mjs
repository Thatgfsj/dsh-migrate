import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientPath = join(repoRoot, 'lib', 'client.js')
const source = readFileSync(clientPath, 'utf8')

let captured = null
globalThis.window = { __ModuleLoader__: { load(spec) { captured = spec } } }

test('client bundle registers a factory under the package name', async () => {
  await import(pathToFileURL(clientPath).href)
  assert.ok(captured, 'window.__ModuleLoader__.load must be called')
  assert.equal(captured.id, 'dsh-migrate')
  assert.equal(typeof captured.factory, 'function')
})

test('the factory asks only for react and returns a slot contribution', () => {
  const requested = []
  const react = {
    createElement: (type, props, children) => ({ type, props, children }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
  }
  const module_ = captured.factory((name) => {
    requested.push(name)
    if (name === 'react') return react
    throw new Error(`unexpected require(${name})`)
  })
  assert.deepEqual(requested, ['react'])
  assert.deepEqual(module_.inject, ['slots'])

  const calls = []
  module_.apply({
    slots: {
      inject(owner, register) { calls.push({ owner }); register() },
      register(options, Component) { calls.push({ options, Component }); return Component },
    },
  })
  assert.equal(calls[0].owner, 'conversation.composer.dock')
  assert.equal(calls[1].options.name, 'conversation.composer.dock')
  assert.equal(calls[1].options.id, 'dsh-migrate')
  assert.equal(typeof calls[1].Component, 'function')
})

test('client bundle obeys the documented UI red lines', () => {
  assert.doesNotMatch(source, /document\.body/)
  assert.doesNotMatch(source, /iframe/i)
  assert.doesNotMatch(source, /require\('@deepseek-ai\/dsh-client-/, 'must not require platform client packages')
  assert.match(source, /--dsw-alias-/, 'must style through theme tokens')
  assert.match(source, /\/api\/dsh-migrate/, 'must talk to the host bridge')
})
