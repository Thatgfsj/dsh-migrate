/**
 * Bundled skill loading.
 *
 * dsh-migrate ships its own SKILL.md so the knowledge travels with the plugin
 * instead of being copied into a user's skills root. It is registered through the
 * **runtime** skill registry (\`ctx.skills.register()\`) — deliberately *not* by
 * overriding the filesystem provider's \`customSkillDirs\`, because a patch layer
 * replaces a row's whole \`config\` and would drop the upstream
 * \`@deepseek-ai/dsh-agent-preset/skills\` entry.
 *
 * @module dsh-migrate/core/skill
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Kebab-case skill name rule enforced by the DSH skill registry. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** The catalog only shows this many characters of a description. */
export const CATALOG_DESCRIPTION_MAX_LENGTH = 500

/** Source label used for skills contributed at runtime by a plugin. */
export const RUNTIME_SOURCE = 'runtime'

/**
 * Parse a SKILL.md: YAML-ish frontmatter plus the Markdown body.
 *
 * Only the flat \`key: value\` subset used by DSH frontmatter is supported.
 *
 * @param {string} text raw file content
 * @returns {{attributes: Record<string, string>, body: string}}
 */
export function parseSkillMarkdown(text) {
  if (!text.startsWith('---')) return { attributes: {}, body: text.trim() }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { attributes: {}, body: text.trim() }
  const attributes = {}
  for (const line of text.slice(4, end).split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator < 0 || /^\s/.test(line)) continue
    attributes[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { attributes, body: text.slice(end + 4).trim() }
}

/** Coerce DSH's boolean spellings; returns undefined for anything unrecognised. */
function parseBoolean(value) {
  if (value === undefined) return undefined
  const normalized = String(value).trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  if (['false', 'no', 'off', '0'].includes(normalized)) return false
  return undefined
}

/**
 * Validate a candidate skill the way the registry will.
 *
 * @param {object} skill
 * @returns {string[]} problems (empty means valid)
 */
export function validateSkill(skill) {
  const problems = []
  if (!SKILL_NAME_PATTERN.test(String(skill?.name ?? ''))) problems.push(`name 不符合 kebab-case 规则：${skill?.name}`)
  if (typeof skill?.description !== 'string' || skill.description.length === 0) problems.push('description 不能为空')
  if (typeof skill?.content !== 'string' || skill.content.length === 0) problems.push('content 不能为空')
  return problems
}

/**
 * Read every \`<dir>/<name>/SKILL.md\`.
 *
 * @param {string} dir skills root (one level deep, matching DSH discovery)
 * @returns {Array<{name: string, description: string, whenToUse?: string, content: string,
 *   path: string, resourceBase: {kind: 'directory', path: string},
 *   modelInvocable: boolean, userInvocable: boolean}>}
 */
export function loadBundledSkills(dir) {
  if (!dir || !existsSync(dir)) return []
  const skills = []
  for (const entry of readdirSync(dir).sort()) {
    const directory = join(dir, entry)
    let info
    try {
      info = statSync(directory)
    } catch {
      continue
    }
    if (!info.isDirectory()) continue
    const path = join(directory, 'SKILL.md')
    if (!existsSync(path)) continue
    const { attributes, body } = parseSkillMarkdown(readFileSync(path, 'utf8'))
    const modelInvocable = parseBoolean(attributes['disable-model-invocation']) === true ? false : true
    const userInvocable = parseBoolean(attributes['user-invocable']) === false ? false : true
    skills.push({
      name: attributes.name ?? entry,
      description: attributes.description ?? '',
      ...(attributes.whenToUse ? { whenToUse: attributes.whenToUse } : {}),
      content: body,
      path,
      resourceBase: { kind: 'directory', path: directory },
      modelInvocable,
      userInvocable,
    })
  }
  return skills
}

/**
 * Convert a loaded skill into the payload accepted by \`ctx.skills.register()\`.
 *
 * @param {object} skill result of {@link loadBundledSkills}
 */
export function toRuntimeRegistration(skill) {
  const problems = validateSkill(skill)
  if (problems.length > 0) {
    throw new Error(`bundled skill is invalid: ${problems.join('; ')}`)
  }
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
    content: skill.content,
    source: RUNTIME_SOURCE,
    path: skill.path,
    resourceBase: skill.resourceBase,
    invocation: { modelInvocable: skill.modelInvocable !== false, userInvocable: skill.userInvocable !== false },
  }
}
