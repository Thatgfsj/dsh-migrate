/**
 * Tool descriptors for 打包大肥鱼 / 释放大肥鱼.
 *
 * Kept free of \`@deepseek-ai/*\` imports so the whole surface is unit-testable
 * without a DSH runtime: \`lib/index.js\` only maps these descriptors through
 * \`defineTool()\` and registers them.
 *
 * @module dsh-migrate/core/plugin-tools
 */

import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

import { archiveName } from './artifact-name.mjs'

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '未知'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** Render a pack result for the model/user. */
export function formatPackReport(result) {
  const lines = [
    `打包完成：${result.zipPath}`,
    `  归档大小 : ${humanBytes(result.bytes)}`,
    `  文件数量 : ${result.report.files} 个文件 / ${result.report.directories} 个目录`,
    `  源体积   : ${humanBytes(result.report.bytesPacked)}`,
    `  耗时     : ${(result.durationMs / 1000).toFixed(1)} 秒`,
    `  自检     : 密钥扫描通过（${result.sensitiveScan.scanned} 个文本文件，跳过 ${result.sensitiveScan.skipped} 个）`,
    `  排除     : ${result.report.excluded} 项（凭据/会话数据/日志等）`,
  ]
  if (result.report.platformBound > 0) {
    lines.push(`  平台绑定 : ${result.report.platformBound} 个（换平台后需要重建，manifest 里已标注）`)
  }
  for (const warning of result.report.warnings ?? []) lines.push(`  ⚠️ ${warning}`)
  lines.push('', '下一步：把该 zip 拷到新电脑 → 装 Node 与 DSH → 安装本插件 → 释放大肥鱼。')
  return lines.join('\n')
}

/** Render a release result for the model/user. */
export function formatReleaseReport(result) {
  const mode = result.dryRun ? '（dry-run，未写入任何文件）' : ''
  const lines = [
    `释放大肥鱼${mode}`,
    `  归档     : ${result.zipPath}`,
    `  目标 home: ${result.targetHome}`,
    `  新建     : ${result.created} 个文件`,
    `  覆盖     : ${result.overwritten} 个文件`,
    `  路径重写 : ${result.rewrite.files} 个文件 / ${result.rewrite.hits} 处`,
  ]
  if (result.backupPath) lines.push(`  备份     : ${result.backupPath}`)
  if (result.skipped.length > 0) {
    lines.push(`  跳过     : ${result.skipped.length} 个平台绑定项`)
    for (const item of result.skipped.slice(0, 5)) lines.push(`    - ${item.path}（${item.reason}）`)
  }
  if (result.residuals?.length > 0) {
    lines.push(`  ⚠️ 残留  : ${result.residuals.length} 处旧路径，可能需要手工重装插件`)
  }
  for (const warning of result.warnings ?? []) lines.push(`  ⚠️ ${warning}`)
  const bootstrap = result.bootstrap
  if (bootstrap) {
    if (bootstrap.attempted && bootstrap.ok) lines.push(`  自举     : 已安装插件到 profile「${bootstrap.profile}」`)
    else if (bootstrap.attempted) lines.push(`  自举     : 失败（不影响本次释放），请手动执行：${bootstrap.command}`)
    else if (bootstrap.pluginPath) lines.push(`  自举     : 未自动执行（${bootstrap.reason}）。手动命令：${bootstrap.command ?? `dsh plugin --profile <profile> add ${bootstrap.pluginPath}`}`)
  }
  if (!result.dryRun) lines.push('', '下一步：重启 DSH；若插件未生效，按上面的命令手动安装一次。')
  else lines.push('', '确认无误后，用 dryRun:false 再调用一次即可真正释放。')
  return lines.join('\n')
}

/**
 * Build the two tool descriptors.
 *
 * @param {object} deps
 * @param {(options: object) => Promise<object>} deps.pack
 * @param {(options: object) => Promise<object>} deps.release
 * @param {(options: object) => Promise<string|null>} deps.pickPath
 * @param {string} deps.home DSH home to pack
 * @param {() => string} [deps.defaultSaveDir]
 * @param {string} [deps.dshBin]
 * @param {boolean} [deps.bootstrap]
 * @param {object} [deps.tooling]
 * @param {() => Date} [deps.now]
 * @returns {Array<object>} descriptors accepted by defineTool()
 */
export function createToolDescriptors(deps) {
  const {
    pack,
    release,
    pickPath,
    home,
    defaultSaveDir = () => join(homedir(), 'Downloads'),
    dshBin = 'dsh',
    bootstrap = true,
    tooling,
    now = () => new Date(),
    generator = { name: 'dsh-migrate', version: null },
  } = deps

  if (typeof pack !== 'function') throw new TypeError('createToolDescriptors: pack is required')
  if (typeof release !== 'function') throw new TypeError('createToolDescriptors: release is required')
  if (typeof pickPath !== 'function') throw new TypeError('createToolDescriptors: pickPath is required')
  if (!home) throw new TypeError('createToolDescriptors: home is required')

  return [
    {
      name: 'fatfish_pack',
      description: '打包大肥鱼：把本机的 DSH 环境（所有插件、插件配置、技能、上下文；不含 API key 与会话数据）打包成一个 zip，用于搬到另一台电脑。默认会弹出“选择保存位置”对话框。',
      parameters: {
        // NOTE: DSH's parameter dialect rejects \`required: false\` — optional
        // parameters simply omit the key (verified against a real dsh install).
        savePath: { type: 'string', description: '直接指定 zip 的保存路径；不给则弹出系统对话框让用户选择' },
        includeModels: { type: 'boolean', description: '是否连可重新下载的模型缓存一起打包（默认否）' },
        dryRun: { type: 'boolean', description: '只报告将要写到哪里，不真的打包（默认否）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args = {}) {
        const defaultPath = join(defaultSaveDir(), archiveName({ host: hostname(), date: now() }))
        let savePath = typeof args.savePath === 'string' && args.savePath.trim() !== '' ? args.savePath : null
        let dialogNote = ''
        if (!savePath) {
          try {
            savePath = await pickPath({ mode: 'save', defaultPath })
            if (!savePath) return '已取消：用户没有选择保存位置，未生成任何文件。'
          } catch (error) {
            if (error?.code !== 'DIALOG_UNAVAILABLE') throw error
            savePath = defaultPath
            dialogNote = `（当前环境无法弹出对话框：${error.message}；已回退到默认位置）`
          }
        }
        if (args.dryRun === true) {
          return `[dry-run] 将打包 ${home} -> ${savePath}${dialogNote}`
        }
        const result = await pack({
          home,
          outPath: savePath,
          includeModels: args.includeModels === true,
          generator,
          tooling,
        })
        return `${formatPackReport(result)}${dialogNote ? `\n${dialogNote}` : ''}`
      },
    },
    {
      name: 'fatfish_release',
      description: '释放大肥鱼：把“打包大肥鱼”生成的 zip 还原成这台电脑的 DSH 环境（校验 sha256、备份现有 home、重写绝对路径、跳过平台不兼容的二进制）。默认 dry-run。',
      parameters: {
        zipPath: { type: 'string', description: '要释放的 zip 路径；不给则弹出系统文件选择对话框' },
        targetHome: { type: 'string', description: '目标 DSH home，默认 $DSH_HOME 或 ~/.dsh' },
        merge: { type: 'boolean', description: '写进已存在的 home 而不是整体替换（默认否；默认会先整体备份）' },
        dryRun: { type: 'boolean', description: '只演练并报告计划，不写入（默认是）' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args = {}) {
        let zipPath = typeof args.zipPath === 'string' && args.zipPath.trim() !== '' ? args.zipPath : null
        if (!zipPath) {
          try {
            zipPath = await pickPath({ mode: 'open' })
          } catch (error) {
            if (error?.code === 'DIALOG_UNAVAILABLE') {
              return `当前环境无法弹出文件选择对话框（${error.message}）。请重新调用并带上 zipPath 参数。`
            }
            throw error
          }
          if (!zipPath) return '已取消：用户没有选择归档文件。'
        }
        const result = await release({
          zipPath,
          targetHome: args.targetHome,
          merge: args.merge === true,
          dryRun: args.dryRun !== false,
          dshBin,
          bootstrap,
        })
        return formatReleaseReport(result)
      },
    },
  ]
}
