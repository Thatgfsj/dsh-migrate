import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { mask, scanEntriesForSecrets, scanFileForSecrets } from '../lib/core/sensitive.mjs'

let dir
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-migrate-secrets-'))
})
after(async () => {
  await rm(dir, { recursive: true, force: true })
})

const put = async (name, content) => {
  const path = join(dir, name)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}

test('mask never reveals the secret', () => {
  assert.equal(mask('sk-abcdefghijklmnop'), 'sk-a************')
  assert.equal(mask('short'), '*****')
  assert.ok(!mask('sk-abcdefghijklmnop').includes('mnop'))
})

test('detects the usual credential shapes', async () => {
  const path = await put('config.yaml', [
    'refs:',
    '  OPENAI_API_KEY: sk-abcdefghijklmnopqrstuvwxyz',
    '  GITHUB: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    '  AWS: AKIAIOSFODNN7EXAMPLE',
    'notes: api_key = "abcdefghijklmnop1234"',
    '-----BEGIN RSA PRIVATE KEY-----',
  ].join('\n'))
  const { findings } = await scanFileForSecrets(path)
  const ids = new Set(findings.map((finding) => finding.pattern))
  assert.ok(ids.has('openai-style-key'))
  assert.ok(ids.has('github-token'))
  assert.ok(ids.has('aws-access-key'))
  assert.ok(ids.has('private-key-block'))
  assert.ok(ids.has('assigned-secret'))
  for (const finding of findings) {
    assert.ok(!finding.masked.includes('abcdefghijklmnopqrstuvwxyz'), 'report must be masked')
    assert.ok(finding.line >= 1)
  }
})

test('clean text yields no findings', async () => {
  const path = await put('clean.md', '# hello\nthis file mentions secrets but has no values\n')
  const { findings } = await scanFileForSecrets(path)
  assert.deepEqual(findings, [])
})

test('binary payloads are skipped by extension or NUL byte', async () => {
  const byExtension = await scanFileForSecrets(await put('image.png', 'sk-abcdefghijklmnopqrstuvwxyz'))
  assert.deepEqual(byExtension.findings, [])
  assert.equal(byExtension.skipped, 'binary-extension')

  const path = join(dir, 'blob.dat')
  await writeFile(path, Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from('sk-abcdefghijklmnop')]))
  const byContent = await scanFileForSecrets(path)
  assert.deepEqual(byContent.findings, [])
  assert.equal(byContent.skipped, 'binary-content')
})

test('oversized files are skipped, not read', async () => {
  const path = await put('big.txt', 'x'.repeat(64))
  const { findings, skipped } = await scanFileForSecrets(path, { maxBytes: 16 })
  assert.deepEqual(findings, [])
  assert.equal(skipped, 'too-large')
})

test('scanEntriesForSecrets walks inventory entries and reports progress', async () => {
  await put('home/.credentials.yaml', 'sk-abcdefghijklmnopqrstuvwxyz')
  await put('home/skills/demo/SKILL.md', 'clean')
  const entries = [
    { path: '.credentials.yaml', size: 30, type: 'file' },
    { path: 'skills/demo/SKILL.md', size: 5, type: 'file' },
    { path: 'skills/demo', size: 0, type: 'dir' },
  ]
  let last = 0
  const result = await scanEntriesForSecrets(join(dir, 'home'), entries, { onProgress: (done) => { last = done } })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].path, '.credentials.yaml')
  assert.equal(result.scanned, 2)
  assert.equal(last, 2)
  assert.ok(!JSON.stringify(result).includes('abcdefghijklmnopqrstuvwxyz'))
})
