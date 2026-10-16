import { strict as assert } from 'node:assert'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CATALOG_DESCRIPTION_MAX_LENGTH, SKILL_NAME_PATTERN, loadBundledSkills, parseSkillMarkdown, toRuntimeRegistration, validateSkill,
} from '../lib/core/skill.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = join(repoRoot, 'skills')

test('parseSkillMarkdown splits frontmatter from the body', () => {
  const parsed = parseSkillMarkdown('---\nname: demo\ndescription: does a thing\nwhenToUse: when needed\n---\n\n# Body\ntext\n')
  assert.deepEqual(parsed.attributes, { name: 'demo', description: 'does a thing', whenToUse: 'when needed' })
  assert.equal(parsed.body, '# Body\ntext')
})

test('parseSkillMarkdown tolerates a file without frontmatter', () => {
  const parsed = parseSkillMarkdown('# just a body\n')
  assert.deepEqual(parsed.attributes, {})
  assert.equal(parsed.body, '# just a body')
})

test('validateSkill mirrors the registry rules', () => {
  assert.deepEqual(validateSkill({ name: 'dsh-migration', description: 'x', content: 'y' }), [])
  assert.ok(validateSkill({ name: 'Bad_Name', description: 'x', content: 'y' }).length > 0)
  assert.ok(validateSkill({ name: 'ok', description: '', content: 'y' }).length > 0)
  assert.ok(validateSkill({ name: 'ok', description: 'x', content: '' }).length > 0)
})

test('loadBundledSkills reads <root>/<name>/SKILL.md and carries the resource base', () => {
  const skills = loadBundledSkills(skillsDir)
  assert.equal(skills.length, 1)
  const skill = skills[0]
  assert.equal(skill.name, 'dsh-migration')
  assert.ok(skill.description.length > 80)
  assert.ok(skill.content.includes('# 搬运 DSH'))
  assert.equal(skill.resourceBase.kind, 'directory')
  assert.equal(skill.resourceBase.path, join(skillsDir, 'dsh-migration'))
  assert.ok(skill.path.endsWith('SKILL.md'))
})

test('loadBundledSkills returns [] for a missing directory', () => {
  assert.deepEqual(loadBundledSkills(join(repoRoot, 'nope')), [])
  assert.deepEqual(loadBundledSkills(''), [])
})

test('toRuntimeRegistration produces a runtime-source registration', () => {
  const [skill] = loadBundledSkills(skillsDir)
  const registration = toRuntimeRegistration(skill)
  assert.equal(registration.source, 'runtime')
  assert.deepEqual(registration.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(registration.content, skill.content)
  assert.throws(() => toRuntimeRegistration({ ...skill, name: 'Bad Name' }), /invalid/)
})

test('the shipped skill is valid and its description fits the catalog', () => {
  const directories = readdirSync(skillsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  assert.ok(directories.length >= 1)
  for (const entry of directories) {
    assert.ok(SKILL_NAME_PATTERN.test(entry.name), `skill directory must be kebab-case: ${entry.name}`)
    const frontmatter = parseSkillMarkdown(readFileSync(join(skillsDir, entry.name, 'SKILL.md'), 'utf8'))
    assert.equal(frontmatter.attributes.name, entry.name, 'frontmatter name must match its directory')
    assert.ok(frontmatter.attributes.description.length <= CATALOG_DESCRIPTION_MAX_LENGTH)
    assert.match(frontmatter.attributes.description, /打包大肥鱼/, 'trigger words must be front-loaded')
    assert.match(frontmatter.attributes.description, /释放大肥鱼/)
  }
})

test('every relative markdown link inside the skill resolves on disk', () => {
  const skillRoot = join(skillsDir, 'dsh-migration')
  for (const file of ['SKILL.md', 'references/workflow.md', 'references/layers.md', 'references/troubleshooting.md']) {
    const text = readFileSync(join(skillRoot, file), 'utf8')
    for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]
      if (/^[a-z]+:/i.test(target) || target.startsWith('#')) continue
      const resolved = resolve(dirname(join(skillRoot, file)), target)
      assert.doesNotThrow(() => readFileSync(resolved), `broken link ${target} in ${file}`)
    }
  }
})
