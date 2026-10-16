import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { ARCHIVE_PREFIX, archiveName, sanitizeHost, stamp } from '../lib/core/artifact-name.mjs'

test('stamp is zero padded and UTC-stable', () => {
  const date = new Date(Date.UTC(2026, 0, 5, 4, 7, 59))
  assert.equal(stamp(date, { utc: true }), '20260105-0407')
})

test('stamp is monotonic within a minute', () => {
  const a = stamp(new Date(Date.UTC(2026, 0, 5, 4, 7)), { utc: true })
  const b = stamp(new Date(Date.UTC(2026, 0, 5, 4, 8)), { utc: true })
  assert.notEqual(a, b)
})

test('sanitizeHost removes characters that break Windows or chat apps', () => {
  assert.equal(sanitizeHost('DESKTOP-A1B2C3'), 'desktop-a1b2c3')
  assert.equal(sanitizeHost('my pc:1/2?'), 'my-pc-1-2')
  assert.equal(sanitizeHost('   中文 主机   '), '中文-主机')
  assert.equal(sanitizeHost(''), 'unknown-host')
  assert.equal(sanitizeHost(undefined), 'unknown-host')
  assert.equal(sanitizeHost('---'), 'unknown-host')
  assert.ok(sanitizeHost('x'.repeat(100)).length <= 40)
})

test('archiveName follows dsh-fatfish-<host>-<stamp>.zip', () => {
  const name = archiveName({ host: 'My PC', date: new Date(Date.UTC(2026, 9, 17, 0, 30)), utc: true })
  assert.equal(name, `${ARCHIVE_PREFIX}-my-pc-20261017-0030.zip`)
})
