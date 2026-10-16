/**
 * 选择保存位置 / 选择归档 — native file dialogs, with graceful fallbacks.
 *
 * The host runs on the user's machine, so "点击【打包大肥鱼】后选择保存位置"
 * means calling the platform's own dialog: zenity/kdialog, PowerShell's
 * Save-/OpenFileDialog, or osascript. When there is no dialog to call (headless
 * server, missing tools) the caller falls back to a configured directory or the
 * download card — this module reports that clearly instead of failing vaguely.
 *
 * @module dsh-migrate/core/pick-path
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Thrown when no native dialog can be used on this machine. */
export class DialogUnavailableError extends Error {
  /**
   * @param {string} message
   * @param {{ platform?: string, tried?: string[] }} [details]
   */
  constructor(message, details = {}) {
    super(message)
    this.name = 'DialogUnavailableError'
    this.code = 'DIALOG_UNAVAILABLE'
    Object.assign(this, details)
  }
}

/** Thrown when the user cancels the dialog. */
export class DialogCancelledError extends Error {
  constructor() {
    super('user cancelled the dialog')
    this.name = 'DialogCancelledError'
    this.code = 'DIALOG_CANCELLED'
  }
}

const ZIP_FILTER = 'DSH 大肥鱼归档 (*.zip)|*.zip|所有文件 (*.*)|*.*'

function powershellSaveScript({ defaultPath, title }) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dialog = New-Object System.Windows.Forms.SaveFileDialog',
    `$dialog.Title = '${title}'`,
    `$dialog.Filter = '${ZIP_FILTER}'`,
    '$dialog.AddExtension = $true',
    `$dialog.FileName = '${defaultPath.split(/[\\\\/]/).pop()}'`,
    `$dialog.InitialDirectory = '${defaultPath.replace(/[\\\\/][^\\\\/]*$/, '')}'`,
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
  ].join('; ')
}

function powershellOpenScript({ title }) {
  return [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
    `$dialog.Title = '${title}'`,
    `$dialog.Filter = '${ZIP_FILTER}'`,
    '$dialog.CheckFileExists = $true',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
  ].join('; ')
}

function osascriptScript({ mode, defaultPath, title }) {
  if (mode === 'save') {
    return [
      'try',
      `  set target to choose file name with prompt "${title}" default name "${defaultPath.split('/').pop()}"`,
      '  return POSIX path of target',
      'on error number -128',
      '  return ""',
      'end try',
    ].join('\n')
  }
  return [
    'try',
    `  set target to choose file with prompt "${title}" of type {"zip"}`,
    '  return POSIX path of target',
    'on error number -128',
    '  return ""',
    'end try',
  ].join('\n')
}

/**
 * Dialog commands for a platform, in preference order.
 *
 * @param {{ platform?: string, env?: Record<string, string|undefined> }} [options]
 * @returns {Array<{id: string, command: string, args: string[]}>}
 */
export function dialogCommands(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const { mode = 'save', defaultPath = 'dsh-fatfish.zip', title = mode === 'save' ? '选择大肥鱼的保存位置' : '选择要释放的大肥鱼 zip' } = options

  if (platform === 'win32') {
    return [{
      id: 'powershell-dialog',
      command: 'powershell',
      args: ['-NoProfile', '-STA', '-NonInteractive', '-Command', mode === 'save' ? powershellSaveScript({ defaultPath, title }) : powershellOpenScript({ title })],
    }]
  }
  if (platform === 'darwin') {
    return [{
      id: 'osascript',
      command: 'osascript',
      args: ['-e', osascriptScript({ mode, defaultPath, title })],
    }]
  }
  // Linux / BSD: only try a GUI dialog when there is a display to draw on.
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return []
  if (mode === 'save') {
    return [
      { id: 'zenity', command: 'zenity', args: ['--file-selection', '--save', '--confirm-overwrite', `--title=${title}`, `--filename=${defaultPath}`] },
      { id: 'kdialog', command: 'kdialog', args: ['--getsavefilename', defaultPath, 'zip (*.zip)'] },
    ]
  }
  return [
    { id: 'zenity', command: 'zenity', args: ['--file-selection', `--title=${title}`, '--file-filter=*.zip'] },
    { id: 'kdialog', command: 'kdialog', args: ['--getopenfilename', '.', 'zip (*.zip)'] },
  ]
}

/**
 * Ask the user for a path.
 *
 * @param {object} options
 * @param {'save'|'open'} [options.mode]
 * @param {string} [options.defaultPath]
 * @param {string} [options.title]
 * @param {string} [options.platform]
 * @param {Record<string, string|undefined>} [options.env]
 * @param {number} [options.timeoutMs]
 * @param {(command: string, args: string[], options: object) => Promise<{stdout: string}>} [options.runner] injectable for tests
 * @returns {Promise<string|null>} chosen path, or null if the user cancelled
 * @throws {DialogUnavailableError} when no dialog tool exists
 */
export async function pickPath(options = {}) {
  const {
    mode = 'save',
    defaultPath = 'dsh-fatfish.zip',
    platform = process.platform,
    env = process.env,
    timeoutMs = 600000,
    runner = execFileAsync,
  } = options
  const title = options.title ?? (mode === 'save' ? '选择大肥鱼的保存位置' : '选择要释放的大肥鱼 zip')
  const candidates = dialogCommands({ mode, defaultPath, title, platform, env })
  if (candidates.length === 0) {
    throw new DialogUnavailableError('当前环境没有可用的图形对话框（无 DISPLAY / 无 zenity/kdialog）', { platform, tried: [] })
  }
  const tried = []
  for (const candidate of candidates) {
    tried.push(candidate.id)
    try {
      const { stdout } = await runner(candidate.command, candidate.args, { timeout: timeoutMs, windowsHide: true })
      const chosen = String(stdout ?? '').trim().replace(/\r$/gm, '')
      if (chosen === '') return null
      return chosen
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 127) continue
      // zenity/kdialog/osascript exit non-zero when the user cancels.
      if (error?.code === 1 || /cancel/i.test(String(error?.stderr ?? ''))) return null
      if (tried.length === candidates.length) {
        throw new DialogUnavailableError(`对话框调用失败：${error.message}`, { platform, tried })
      }
    }
  }
  throw new DialogUnavailableError('找不到可用的图形对话框', { platform, tried })
}

/** Convenience wrapper for the pack flow. */
export function pickSavePath(options = {}) {
  return pickPath({ ...options, mode: 'save' })
}

/** Convenience wrapper for the release flow. */
export function pickOpenPath(options = {}) {
  return pickPath({ ...options, mode: 'open' })
}
