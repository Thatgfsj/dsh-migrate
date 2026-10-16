#!/usr/bin/env node
/**
 * Build the deliverable zip: \`dist/dsh-migrate-<version>.zip\`.
 *
 * Dogfoods the project's own zip engine (\`lib/core/zip.mjs\`), so the artifact users
 * download is produced by the same code that produces a 大肥鱼 archive — including
 * UTF-8 names, permission bits and ZIP64 handling.
 *
 * Usage: node scripts/build-package.mjs [--out <dir>]
 */

import { mkdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ZipWriter } from '../lib/core/zip.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Everything a user needs to install and use the plugin. */
const CONTENT = [
  'package.json',
  'cordis.patch.yml',
  'icon.svg',
  'README.md',
  'LICENSE',
  'install.sh',
  'install.cmd',
  'lib',
  'skills',
  'locale',
  'tools',
]

/**
 * Build the package zip.
 *
 * @param {{ outDir?: string, prefix?: string }} [options]
 * @returns {Promise<{zipPath: string, entries: number, bytes: number, version: string}>}
 */
export async function buildPackage(options = {}) {
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'))
  const version = pkg.version
  const outDir = resolve(options.outDir ?? join(repoRoot, 'dist'))
  const prefix = options.prefix ?? `${pkg.name}-${version}`
  await mkdir(outDir, { recursive: true })
  const zipPath = join(outDir, `${pkg.name}-${version}.zip`)
  await rm(zipPath, { force: true })

  const zip = await ZipWriter.create(zipPath)
  await zip.add({ name: prefix, type: 'dir' })

  let entries = 0
  for (const entry of CONTENT) {
    const absolute = join(repoRoot, entry)
    if (!existsSync(absolute)) continue
    await zip.addTree(absolute, {
      prefix: `${prefix}/${entry}`,
      followSymlinks: true,
      onProgress: () => {},
    })
    const info = await stat(absolute)
    if (info.isFile()) entries += 1
    else entries += 1
  }
  const summary = await zip.close()
  const bytes = (await stat(zipPath)).size
  return { zipPath, entries: summary.entries, bytes, version }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-package.mjs')) {
  const result = await buildPackage({ outDir: process.argv[2] })
  const rel = relative(repoRoot, result.zipPath).split(sep).join('/')
  console.log(`built ${rel} (${result.entries} entries, ${result.bytes} bytes)`)
}
