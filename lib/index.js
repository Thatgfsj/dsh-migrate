/**
 * dsh-migrate — host half.
 *
 * Kept intentionally thin: this file is the only place allowed to import
 * `@deepseek-ai/*` packages (they must be declared in `peerDependencies`,
 * otherwise the row silently fails to load). All logic lives in `lib/core/*.mjs`
 * as dependency-free ESM so it can be unit-tested without a DSH runtime.
 *
 * @module dsh-migrate
 */

/** Plugin name shown by the loader. */
export const name = 'dsh-migrate'

/** Services this plugin needs. Grows to `['tools', 'skills']` when those land. */
export const inject = []

/**
 * Mount the host half.
 * Currently a no-op placeholder: the pack/release tools are tracked in
 * issues #15/#16 and the bundled skill in #14.
 */
export function apply() {}
