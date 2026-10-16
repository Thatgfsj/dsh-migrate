#!/usr/bin/env node
/**
 * Build the UI-installable tarball: \`dist/dsh-migrate-<version>.tgz\`.
 *
 * Why this exists: the plugin is not published to npm, so installing it from a git
 * URL makes pnpm pull a remote source (and DSH then asks for skill approval, and the
 * local install gets replaced). The tarball is the artefact the Plugins settings page
 * can consume as a **local path** instead.
 *
 * Usage: node scripts/pack-tarball.mjs
 */

import { execFileSync } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every file the tarball must contain for the plugin to work (paths as npm reports them, without the `package/` prefix). */
const REQUIRED = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/client.js',
  'lib/core/pack.mjs',
  'skills/dsh-migration/SKILL.md',
  'locale/zh.json',
]

/**
 * @param {{ outDir?: string }} [options]
 * @returns {Promise<{ tgzPath: string, version: string, files: number, bytes: number }>}
 */
export async function packTarball(options = {}) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const outDir = resolve(options.outDir ?? join(repoRoot, 'dist'))
  await mkdir(outDir, { recursive: true })
  await rm(join(outDir, `${pkg.name}-${pkg.version}.tgz`), { force: true })

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const output = execFileSync(npm, ['pack', '--pack-destination', outDir, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const report = JSON.parse(output)
  const entry = Array.isArray(report) ? report[0] : report
  const tgzPath = join(outDir, entry.filename)
  const files = (entry.files ?? []).map((file) => file.path)

  const missing = REQUIRED.filter((required) => !files.includes(required))
  if (missing.length > 0) {
    throw new Error(`tarball is missing required files: ${missing.join(', ')}`)
  }
  if (!existsSync(tgzPath)) throw new Error(`npm pack reported ${tgzPath} but it does not exist`)

  return { tgzPath, version: pkg.version, files: files.length, bytes: (await stat(tgzPath)).size }
}

if (process.argv[1]?.endsWith('pack-tarball.mjs')) {
  const result = await packTarball()
  console.log(`built ${result.tgzPath} (${result.files} files, ${result.bytes} bytes)`)
}
