#!/usr/bin/env node
/**
 * Guard for CI and local test runs: refuse to run when DSH_HOME points at a real
 * user home. Every automated test must operate on a throwaway home under the
 * runner's temp directory so a bug can never touch someone's real ~/.dsh.
 */

import { homedir, tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

const home = process.env.DSH_HOME
if (!home) {
  console.error('guard FAIL: DSH_HOME is not set; automated runs must use a throwaway home')
  process.exit(1)
}

const real = resolve(realpathSync.native ? realpathSync.native(home) : home)
const userHome = resolve(homedir())
const temp = resolve(tmpdir())

if (real === resolve(userHome, '.dsh')) {
  console.error(`guard FAIL: DSH_HOME points at the real DSH home (${real})`)
  process.exit(1)
}
const inTemp = real.startsWith(temp)
console.log(`guard      : DSH_HOME=${real} (temp=${inTemp ? 'yes' : 'no'})`)
if (!inTemp) {
  console.error(`guard FAIL: DSH_HOME must live under the temp directory (${temp})`)
  process.exit(1)
}
console.log('guard      : ok')
