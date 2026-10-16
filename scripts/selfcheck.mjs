#!/usr/bin/env node
/**
 * Platform self-check. Prints what the current machine offers and fails only on
 * things that would make dsh-migrate misbehave (missing icon, oversized icon,
 * bad package manifest). Zip-tool availability is informational, because the
 * engine ships its own zip reader/writer.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const problems = []

console.log(`platform   : ${process.platform} ${process.arch}`)
console.log(`node       : ${process.versions.node} (npm ${process.env.npm_config_user_agent ? 'via npm' : 'n/a'})`)
console.log(`plugin     : ${pkg.name}@${pkg.version}`)
console.log(`DSH_HOME   : ${process.env.DSH_HOME ?? '(unset)'}`)

const iconRel = typeof pkg.icon === 'string' ? pkg.icon.replace(/^\.\//, '') : ''
if (!iconRel) problems.push('package.json has no top-level "icon"')
else {
  const iconPath = join(repoRoot, iconRel)
  try {
    const size = statSync(iconPath).size
    console.log(`icon       : ${iconRel} (${size} bytes)`)
    if (size > 256 * 1024) problems.push(`icon exceeds 256 KiB (${size})`)
  } catch {
    problems.push(`icon file missing: ${iconRel}`)
  }
}

if (pkg.dependencies && Object.keys(pkg.dependencies).some((d) => d.startsWith('@deepseek-ai/'))) {
  problems.push('@deepseek-ai/* must live in peerDependencies, never dependencies')
}

const probes = process.platform === 'win32' ? ['tar', 'powershell'] : ['unzip', 'tar', '7z', 'zenity', 'osascript']
for (const tool of probes) {
  let ok = false
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' })
    ok = true
  } catch {
    try {
      execFileSync(tool, ['-h'], { stdio: 'ignore' })
      ok = true
    } catch { ok = false }
  }
  console.log(`tool       : ${tool.padEnd(10)} ${ok ? 'available' : 'not found (informational)'}`)
}

if (problems.length > 0) {
  for (const p of problems) console.error(`selfcheck FAIL: ${p}`)
  process.exit(1)
}
console.log('selfcheck  : ok')
