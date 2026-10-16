/**
 * Archive policy shared by the packer and the verifier.
 *
 * One source of truth: the same inventory rules that decide what may be packed
 * also decide what a finished archive may contain. Anything else drifting apart
 * is how a credential eventually ships by accident.
 *
 * @module dsh-migrate/core/policy
 */

import { classify } from './inventory.mjs'

/** Error thrown when an archive contains content the policy forbids. */
export class ForbiddenContentError extends Error {
  constructor(violations) {
    super(`archive contains paths that must never be packed: ${violations.slice(0, 10).join(', ')}`)
    this.name = 'ForbiddenContentError'
    this.code = 'FORBIDDEN_CONTENT'
    this.violations = violations
  }
}

/**
 * Refuse any archive entry the policy excludes.
 *
 * @param {Array<{name: string}>} entries zip entries (or manifest paths)
 * @param {{ allowOptional?: boolean }} [options] optional categories (model caches) are
 *   only allowed when the pack recorded that scope.
 */
export function assertArchiveIsClean(entries, options = {}) {
  const { allowOptional = false } = options
  const violations = []
  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name
    if (typeof name !== 'string') continue
    if (name === 'manifest.json') continue
    const decision = classify(name)
    if (decision.action === 'exclude') violations.push(name)
    else if (decision.action === 'optional' && !allowOptional) violations.push(name)
  }
  if (violations.length > 0) throw new ForbiddenContentError(violations)
}
