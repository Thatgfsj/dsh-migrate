/**
 * dsh-migrate — host half.
 *
 * This is the only file allowed to import \`@deepseek-ai/*\` packages (they must be
 * declared in \`peerDependencies\`, otherwise the row silently fails to load).
 * Everything else lives in \`lib/core/*.mjs\` as dependency-free, unit-tested ESM.
 *
 * The two user-facing functions are 打包大肥鱼 (fatfish_pack) and 释放大肥鱼
 * (fatfish_release); the Web UI half renders the same two actions as buttons.
 *
 * @module dsh-migrate
 */

import { fileURLToPath } from 'node:url'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

import { pack } from './core/pack.mjs'
import { pickPath } from './core/pick-path.mjs'
import { createToolDescriptors } from './core/plugin-tools.mjs'
import { defaultTargetHome, release } from './core/release.mjs'
import { loadBundledSkills, toRuntimeRegistration } from './core/skill.mjs'

/** Plugin name shown by the loader. */
export const name = 'dsh-migrate'

/** Services this plugin needs: the tool registry and the skill registry. */
export const inject = ['tools', 'skills']

/** Absolute path of the embedded tooling that gets copied into an archive. */
export function defaultToolingDir() {
  return fileURLToPath(new URL('../tools/', import.meta.url))
}

/** Absolute path of this package (embedded into an archive so the new machine can install it). */
export function defaultPluginDir() {
  return fileURLToPath(new URL('../', import.meta.url))
}

/** Absolute path of the SKILL.md bundle that travels with this plugin. */
export function defaultSkillsDir() {
  return fileURLToPath(new URL('../skills/', import.meta.url))
}

export const Config = Schema.object({
  home: Schema.string().default('').description('要打包的 DSH home，默认 $DSH_HOME 或 ~/.dsh'),
  dshBin: Schema.string().default('dsh').description('释放后自举安装插件时使用的 dsh 命令'),
  bootstrap: Schema.boolean().default(true).description('释放后自动把内嵌的插件副本装进 profile'),
  saveDirectory: Schema.string().default('').description('弹不出对话框时使用的默认保存目录，默认 ~/Downloads'),
  toolingDir: Schema.string().default('').description('内嵌到归档里的恢复工具目录，默认包内 tools/'),
  pluginDir: Schema.string().default('').description('内嵌到归档里的插件副本目录，默认本包根目录'),
  skillsDir: Schema.string().default('').description('随插件分发的技能目录，默认包内 skills/'),
})

/**
 * Mount the host half: register the two tools.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config resolved plugin config
 */
export function apply(ctx, config = {}) {
  const home = (config.home && config.home.trim()) || defaultTargetHome()
  const saveDirectory = (config.saveDirectory && config.saveDirectory.trim()) || undefined
  const tooling = {
    toolingDir: config.toolingDir && config.toolingDir.trim() ? config.toolingDir : defaultToolingDir(),
    pluginDir: config.pluginDir && config.pluginDir.trim() ? config.pluginDir : defaultPluginDir(),
  }

  const descriptors = createToolDescriptors({
    pack,
    release,
    pickPath,
    home,
    ...(saveDirectory ? { defaultSaveDir: () => saveDirectory } : {}),
    dshBin: config.dshBin || 'dsh',
    bootstrap: config.bootstrap !== false,
    tooling,
    generator: { name: 'dsh-migrate', version: '0.1.0' },
  })

  for (const descriptor of descriptors) {
    ctx.tools.register(defineTool(descriptor))
  }

  // Ship the migration skill with the plugin. Registered through the runtime skill
  // registry on purpose: overriding skill-filesystem's customSkillDirs would replace
  // the row's whole config and drop the upstream agent-preset skills.
  const skillsDir = config.skillsDir && config.skillsDir.trim() ? config.skillsDir : defaultSkillsDir()
  for (const skill of loadBundledSkills(skillsDir)) {
    ctx.skills.register(toRuntimeRegistration(skill))
  }
}
