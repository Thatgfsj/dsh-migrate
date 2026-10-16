import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { DialogUnavailableError, dialogCommands, pickOpenPath, pickPath, pickSavePath } from '../lib/core/pick-path.mjs'

test('dialogCommands: Windows uses PowerShell Save/OpenFileDialog', () => {
  const save = dialogCommands({ platform: 'win32', mode: 'save', defaultPath: 'C:/Users/me/Downloads/dsh-fatfish-x.zip' })
  assert.equal(save.length, 1)
  assert.equal(save[0].command, 'powershell')
  assert.ok(save[0].args.join(' ').includes('SaveFileDialog'))
  assert.ok(save[0].args.join(' ').includes('dsh-fatfish-x.zip'))

  const open = dialogCommands({ platform: 'win32', mode: 'open' })
  assert.ok(open[0].args.join(' ').includes('OpenFileDialog'))
})

test('dialogCommands: macOS uses osascript choose file name / choose file', () => {
  const save = dialogCommands({ platform: 'darwin', mode: 'save', defaultPath: 'dsh-fatfish-x.zip' })
  assert.equal(save[0].command, 'osascript')
  assert.match(save[0].args[1], /choose file name/)
  const open = dialogCommands({ platform: 'darwin', mode: 'open' })
  assert.match(open[0].args[1], /choose file with prompt/)
})

test('dialogCommands: Linux needs a display, then zenity before kdialog', () => {
  assert.deepEqual(dialogCommands({ platform: 'linux', env: {} }), [], 'headless must not try a GUI dialog')
  const withDisplay = dialogCommands({ platform: 'linux', env: { DISPLAY: ':0' }, mode: 'save', defaultPath: '/tmp/x.zip' })
  assert.deepEqual(withDisplay.map((item) => item.id), ['zenity', 'kdialog'])
  assert.ok(withDisplay[0].args.includes('--save'))
  const wayland = dialogCommands({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, mode: 'open' })
  assert.equal(wayland[0].id, 'zenity')
})

test('pickPath: returns the chosen path and trims CRLF from PowerShell output', async () => {
  const chosen = await pickPath({
    platform: 'win32',
    defaultPath: 'x.zip',
    runner: async () => ({ stdout: 'D:\\backup\\dsh-fatfish.zip\r\n' }),
  })
  assert.equal(chosen, 'D:\\backup\\dsh-fatfish.zip')
})

test('pickPath: empty output means the user cancelled', async () => {
  const chosen = await pickPath({ platform: 'darwin', runner: async () => ({ stdout: '\n' }) })
  assert.equal(chosen, null)
})

test('pickPath: a non-zero exit with cancel means cancelled', async () => {
  const chosen = await pickPath({
    platform: 'linux',
    env: { DISPLAY: ':0' },
    runner: async () => { const error = new Error('cancelled'); error.code = 1; throw error },
  })
  assert.equal(chosen, null)
})

test('pickPath: falls through missing tools, then reports unavailable', async () => {
  const tried = []
  const chosen = await pickPath({
    platform: 'linux',
    env: { DISPLAY: ':0' },
    runner: async (command) => {
      tried.push(command)
      if (command === 'zenity') { const error = new Error('not found'); error.code = 'ENOENT'; throw error }
      return { stdout: '/home/me/out.zip' }
    },
  })
  assert.deepEqual(tried, ['zenity', 'kdialog'])
  assert.equal(chosen, '/home/me/out.zip')

  await assert.rejects(
    () => pickPath({
      platform: 'linux',
      env: { DISPLAY: ':0' },
      runner: async () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error },
    }),
    (error) => error instanceof DialogUnavailableError && error.code === 'DIALOG_UNAVAILABLE',
  )
})

test('pickPath: headless environments raise DialogUnavailableError immediately', async () => {
  await assert.rejects(() => pickPath({ platform: 'linux', env: {} }), /没有可用的图形对话框/)
})

test('pickSavePath / pickOpenPath set the mode', async () => {
  const saveArgs = []
  await pickSavePath({ platform: 'darwin', runner: async (command, args) => { saveArgs.push(args[1]); return { stdout: '/tmp/a.zip' } } })
  assert.match(saveArgs[0], /choose file name/)
  const openArgs = []
  await pickOpenPath({ platform: 'darwin', runner: async (command, args) => { openArgs.push(args[1]); return { stdout: '/tmp/a.zip' } } })
  assert.match(openArgs[0], /choose file with prompt/)
})
