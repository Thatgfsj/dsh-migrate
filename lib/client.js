/**
 * dsh-migrate — Web UI half (plain JS bundle, no build step).
 *
 * Loaded by the browser module loader; the factory only registers, it performs no
 * side effects. The two actions live in **设置 → 插件** as a tab
 * (\`settings.plugins.tab\`), not under the composer: moving a whole DSH install is
 * an occasional operation, so it should not sit in everyone's input area.
 *
 *   【打包大肥鱼】→ GET pick?mode=save（宿主弹出原生保存对话框）→ POST pack
 *   【释放大肥鱼】→ GET pick?mode=open（宿主弹出原生文件对话框）→ POST release（dryRun:false）
 *
 * Both are polled through GET state while they run, so the user sees the same
 * phase/percentage the host reports.
 */

window.__ModuleLoader__.load({
  id: 'dsh-migrate',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const API = '/api/dsh-migrate'

    const colors = {
      text: 'var(--dsw-alias-text-primary, inherit)',
      muted: 'var(--dsw-alias-text-secondary, #6b7280)',
      border: 'var(--dsw-alias-border-base, rgba(127,127,127,0.35))',
      surface: 'var(--dsw-alias-bg-elevated, transparent)',
      accent: 'var(--dsw-alias-bg-accent, #2563eb)',
      accentText: 'var(--dsw-alias-text-on-accent, #ffffff)',
      track: 'var(--dsw-alias-bg-sunken, rgba(127,127,127,0.2))',
    }

    async function call(path, options) {
      const response = await fetch(path, {
        headers: { 'content-type': 'application/json' },
        ...options,
      })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`${path} 返回了非 JSON 内容（HTTP ${response.status}）`)
      }
    }

    const buttonStyle = (primary) => ({
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '1.9',
      padding: '0 16px',
      borderRadius: '8px',
      border: `1px solid ${primary ? colors.accent : colors.border}`,
      background: primary ? colors.accent : 'transparent',
      color: primary ? colors.accentText : colors.text,
      cursor: 'pointer',
    })

    function ProgressBar({ percent }) {
      return h('div', {
        style: { height: '6px', borderRadius: '999px', background: colors.track, overflow: 'hidden' },
      }, h('div', {
        style: { height: '100%', width: `${Math.max(0, Math.min(100, percent))}%`, background: colors.accent, transition: 'width 0.3s ease' },
      }))
    }

    function MigrationPanel() {
      const [busy, setBusy] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [failed, setFailed] = React.useState(false)

      React.useEffect(() => {
        if (!busy) return undefined
        let alive = true
        const tick = async () => {
          try {
            const state = await call(`${API}/state`)
            if (!alive || !state?.ok) return
            setProgress(state.progress)
            if (!state.running) setBusy(null)
            if (state.error) {
              setMessage(state.error.message)
              setFailed(true)
            }
          } catch {
            /* keep polling quietly: the host may be busy starting up */
          }
        }
        const timer = setInterval(tick, 800)
        tick()
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [busy])

      const start = async (kind) => {
        setMessage(null)
        setFailed(false)
        setProgress(null)
        setBusy(kind)
        try {
          const picked = await call(`${API}/pick?mode=${kind === 'pack' ? 'save' : 'open'}`)
          if (!picked?.ok) {
            setMessage(picked?.message ?? '无法选择路径')
            setFailed(true)
            setBusy(null)
            return
          }
          if (picked.cancelled || !picked.path) {
            setMessage('已取消')
            setBusy(null)
            return
          }
          const result = kind === 'pack'
            ? await call(`${API}/pack`, { method: 'POST', body: JSON.stringify({ savePath: picked.path }) })
            : await call(`${API}/release`, { method: 'POST', body: JSON.stringify({ zipPath: picked.path, dryRun: false }) })
          if (result?.ok) {
            setMessage(kind === 'pack'
              ? `已打包：${result.zipPath}`
              : `已释放到 ${result.targetHome}（新建 ${result.created} 个文件${result.backupPath ? '，旧环境已备份' : ''}）`)
          } else {
            setMessage(result?.message ?? '操作失败')
            setFailed(true)
          }
        } catch (error) {
          setMessage(String(error?.message ?? error))
          setFailed(true)
        } finally {
          setBusy(null)
        }
      }

      const percent = progress?.percent ?? 0
      const busyLabel = busy ? `${busy === 'pack' ? '打包中' : '释放中'} · ${progress?.label ?? '准备中'} ${percent}%` : null

      return h('div', {
        className: 'dsh-migrate-panel',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
          padding: '4px 0 8px',
          maxWidth: '720px',
          fontSize: '13px',
          color: colors.text,
        },
      }, [
        h('div', { key: 'intro', style: { color: colors.muted, lineHeight: '1.8' } },
          '把本机的整套 DSH 环境（所有插件、插件配置、技能、上下文）打包成一个 zip，拷到另一台电脑后释放即可完成搬运。'),
        h('div', { key: 'scope', style: { color: colors.muted, lineHeight: '1.8' } },
          '归档不含任何 API key，也不含会话数据；释放时会先校验 sha256，并把现有 home 整体备份。'),
        h('div', { key: 'actions', style: { display: 'flex', gap: '10px', flexWrap: 'wrap', paddingTop: '2px' } }, [
          h('button', { key: 'pack', type: 'button', style: buttonStyle(true), disabled: busy !== null, onClick: () => start('pack') }, '打包大肥鱼'),
          h('button', { key: 'release', type: 'button', style: buttonStyle(false), disabled: busy !== null, onClick: () => start('release') }, '释放大肥鱼'),
        ]),
        busy ? h('div', { key: 'progress', style: { display: 'flex', flexDirection: 'column', gap: '6px' } }, [
          h('div', { key: 'label', style: { color: colors.muted } }, busyLabel),
          h(ProgressBar, { key: 'bar', percent }),
        ]) : null,
        message ? h('div', {
          key: 'message',
          style: {
            color: failed ? 'var(--dsw-alias-text-danger, #b91c1c)' : colors.text,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: '8px',
            padding: '8px 12px',
            wordBreak: 'break-all',
            lineHeight: '1.7',
          },
        }, message) : null,
        h('div', { key: 'hint', style: { color: colors.muted, lineHeight: '1.8' } },
          '打包会弹出系统对话框选择保存位置；释放会弹出文件选择框选中那个 zip。也可以直接对 agent 说「打包大肥鱼」。'),
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'dsh-migrate',
          order: 50,
          label: () => '大肥鱼搬运',
        }, MigrationPanel))
      },
    }
  },
})
