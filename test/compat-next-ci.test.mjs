/**
 * Guard for the `compat-next` CI channel (#43).
 *
 * The job must exist, must be allowed to fail without blocking the required
 * checks, and — crucially — must call `scripts/compat-check.sh` instead of
 * re-implementing the steps inline, so local and CI runs cannot drift apart.
 */

import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Extract one top-level job block (2-space indented key) from a workflow file. */
function jobBlock(workflow, job) {
  const lines = workflow.split('\n')
  const start = lines.findIndex((line) => line === `  ${job}:`)
  if (start === -1) return undefined
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[index])) {
      end = index
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

test('ci.yml defines a non-required compat-next job on ubuntu', async () => {
  const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const block = jobBlock(workflow, 'compat-next')
  assert.ok(block, 'ci.yml must define a top-level compat-next job')
  assert.match(block, /^ {4}runs-on: ubuntu-latest$/m, 'compat-next is a linux-only channel check')
  assert.match(block, /^ {4}continue-on-error: true$/m, 'compat-next must stay non-required')
  assert.match(block, /^ {4}timeout-minutes: (\d+)$/m, 'installing dsh takes minutes; set an explicit job timeout')
  assert.ok(
    Number(/^ {4}timeout-minutes: (\d+)$/m.exec(block)[1]) >= 10,
    'the timeout must leave room for a 1-2 minute dsh install plus the boot probe',
  )
})

test('compat-next calls the shared script instead of duplicating the steps', async () => {
  const workflow = await readFile(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8')
  const block = jobBlock(workflow, 'compat-next')
  assert.ok(block.includes('bash scripts/compat-check.sh'), 'the job must invoke scripts/compat-check.sh')
  assert.ok(!block.includes('npm install'), 'the install must live in the script, not be duplicated in YAML')
  assert.ok(block.includes('DSH_NEXT_PREFIX'), 'the install prefix should be an env override the script understands')
})

test('scripts/compat-check.sh implements the whole channel check', async () => {
  const script = await readFile(join(repoRoot, 'scripts', 'compat-check.sh'), 'utf8')
  for (const marker of [
    '@deepseek-ai/dsh@next',           // the channel under test
    'test/integration-dsh.test.mjs',   // real-runtime integration test
    '--from-default-profile web',      // build the profile from the shipped web template
    '--dump-config',                   // assert the composed layer
    '/api/dsh-migrate/state',          // the bridge endpoint
    '--no-open',                       // headless boot
    '90',                              // readiness budget in seconds
  ]) {
    assert.ok(script.includes(marker), `compat-check.sh must reference ${marker}`)
  }
})
