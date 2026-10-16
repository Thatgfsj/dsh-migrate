import { strict as assert } from 'node:assert'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

import { looksLikeLiteralSecret, mask, scanEntriesForSecrets, scanFileForSecrets } from '../lib/core/sensitive.mjs'

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

test('high-confidence key shapes are fatal findings', async () => {
  const path = await put('keys.yaml', [
    'refs:',
    '  OPENAI_API_KEY: sk-abcdefghijklmnopqrstuvwxyz',
    '  GITHUB: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    '  AWS: AKIAIOSFODNN7EXAMPLE',
    '  SLACK: xoxb-1234567890-abcdefghijkl',
    '-----BEGIN RSA PRIVATE KEY-----',
    'MIIEowIBAAKCAQEA' + 'A'.repeat(300),
    '-----END RSA PRIVATE KEY-----',
  ].join('\n'))
  const { findings, suspicious } = await scanFileForSecrets(path)
  const ids = new Set(findings.map((finding) => finding.pattern))
  for (const expected of ['openai-style-key', 'github-token', 'aws-access-key', 'slack-token', 'private-key-block']) {
    assert.ok(ids.has(expected), `expected ${expected}`)
  }
  assert.equal(suspicious.length, 0)
  for (const finding of findings) {
    assert.ok(!finding.masked.includes('abcdefghijklmnopqrstuvwxyz'), 'report must be masked')
    assert.equal(finding.severity, 'high')
    assert.ok(finding.line >= 1)
  }
})

test('generic assignments are only suspicious, and only when the value looks like a literal secret', async () => {
  const path = await put('config.yml', [
    'service:',
    '  api_key: aB3xY9pLmQ7zR2sT',                 // literal-looking -> suspicious
    '  client_secret: "k9F2mQ7xL4pR8tW1yB6n"',    // literal-looking -> suspicious
    'code:',
    '  apiKey: config.apiKey',                     // reference -> ignored
    '  secret: this.req.secret',                  // reference -> ignored
    '  password: process.env.DB_PASSWORD',        // reference -> ignored
    'docs:',
    '  api_key = <your-key-here>',                // placeholder -> ignored
    '  secret: changeme',                         // placeholder -> ignored
  ].join('\n'))
  const { findings, suspicious } = await scanFileForSecrets(path)
  assert.equal(findings.length, 0, 'no high-confidence hit in this file')
  assert.equal(suspicious.length, 2)
  assert.ok(suspicious.every((item) => item.severity === 'low'))
  assert.ok(suspicious.every((item) => !JSON.stringify(item).includes('aB3xY9pLmQ7zR2sT') || item.masked.length < 20))
})

test('looksLikeLiteralSecret separates values from references and placeholders', () => {
  const truthy = ['aB3xY9pLmQ7zR2sT', 'k9F2mQ7xL4pR8tW1yB6n', 'sk-abcdefghijklmnop', 'AbCdEfGhIjKlMnOpQrSt']
  const falsy = ['config.apiKey', 'this.req.secret', 'process.env.DB_PASSWORD', '<your-key-here>', 'changeme', 'none', 'undefined', '12345678901234', 'your_api_key_value']
  for (const value of truthy) assert.equal(looksLikeLiteralSecret(value), true, `${value} should be suspicious`)
  for (const value of falsy) assert.equal(looksLikeLiteralSecret(value), false, `${value} should be ignored`)
})

test('the third-party false positives from issue #35 no longer match', async () => {
  const path = await put('response.js', '  var secret = this.req.secret;\n')
  const { findings, suspicious } = await scanFileForSecrets(path)
  assert.equal(findings.length + suspicious.length, 0)
})

test('a PEM header without a key body is only a documentation-level warning', async () => {
  // This is exactly the dotenv README shape that made a real home unpackable.
  const path = await put('dotenv-README.md', [
    'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
    '...',
    'Kh9NV...',
    '...',
    '-----END RSA PRIVATE KEY-----"',
  ].join('\n'))
  const { findings, suspicious } = await scanFileForSecrets(path)
  assert.equal(findings.length, 0, 'a bare header must not be fatal')
  assert.equal(suspicious.length, 1)
  assert.equal(suspicious[0].pattern, 'private-key-header')
})

test('clean text yields no findings', async () => {
  const path = await put('clean.md', '# hello\nthis file mentions secrets but has no values\n')
  const { findings, suspicious } = await scanFileForSecrets(path)
  assert.deepEqual(findings, [])
  assert.deepEqual(suspicious, [])
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
  await put('home/plugins/a/cfg.json', '{"api_key":"aB3xY9pLmQ7zR2sT"}')
  const entries = [
    { path: '.credentials.yaml', size: 30, type: 'file' },
    { path: 'skills/demo/SKILL.md', size: 5, type: 'file' },
    { path: 'plugins/a/cfg.json', size: 31, type: 'file' },
    { path: 'skills/demo', size: 0, type: 'dir' },
  ]
  let last = 0
  const result = await scanEntriesForSecrets(join(dir, 'home'), entries, { onProgress: (done) => { last = done } })
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].path, '.credentials.yaml')
  assert.equal(result.suspicious.length, 1)
  assert.equal(result.suspicious[0].path, 'plugins/a/cfg.json')
  assert.equal(result.scanned, 3)
  assert.equal(last, 3)
  assert.ok(!JSON.stringify(result.findings).includes('abcdefghijklmnopqrstuvwxyz'))
})
