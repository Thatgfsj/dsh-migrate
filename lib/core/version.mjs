/**
 * Single source of truth for this plugin's own identity.
 *
 * `package.json` is the one place a release bumps; every surface that reports
 * "which dsh-migrate produced this" — the `GET state` endpoint, the pack/release
 * report and `manifest.generator` — reads the constants below, so the version
 * can never drift from the published package again.
 *
 * `lib/core/*.mjs` must stay free of `@deepseek-ai/*` imports (only
 * `lib/index.js` may touch peers), so the manifest is read with `node:fs`.
 *
 * @module dsh-migrate/core/version
 */

import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

/** Published package name. `lib/index.js` exports the same string as the row id. */
export const PLUGIN_NAME = pkg.name

/** Published package version (`package.json#version`) — never hardcode this. */
export const PLUGIN_VERSION = pkg.version
