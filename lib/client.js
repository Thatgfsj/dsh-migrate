/**
 * dsh-migrate — Web UI half (plain JS bundle, no build step).
 *
 * Loaded by the browser module loader; the factory only registers, it performs no
 * side effects. Two buttons live in the composer dock and drive the host through
 * the loopback endpoints registered by \`lib/core/http-bridge.mjs\`:
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
      danger: 'var(--dsw-alias-text-danger, #b91c1c)',
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
      fontSize: '12px',
      lineHeight: '1.6',
      padding: '2px 10px',
      borderRadius: '999px',
      border: `1px solid ${primary ? colors.accent : colors.border}`,
      background: primary ? colors.accent : 'transparent',
      color: primary ? colors.accentText : colors.text,
      cursor: 'pointer',
    })

    function Dock() {
      const [busy, setBusy] = React.useState(null)
      const [progress, setProgress] = React.useState(null)
      const [message, setMessage] = React.useState(null)

      React.useEffect(() => {
        if (!busy) return undefined
        let alive = true
        const tick = async () => {
          try {
            const state = await call(`${API}/state`)
            if (!alive || !state?.ok) return
            setProgress(state.progress)
            if (!state.running) setBusy(null)
            if (state.error) setMessage(state.error.message)
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
        setProgress(null)
        setBusy(kind)
        try {
          const picked = await call(`${API}/pick?mode=${kind === 'pack' ? 'save' : 'open'}`)
          if (!picked?.ok) {
            setMessage(picked?.message ?? '无法选择路径')
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
              : `已释放到 ${result.targetHome}（新建 ${result.created} 个文件${result.backupPath ? '，已备份旧环境' : ''}）`)
          } else {
            setMessage(result?.message ?? '操作失败')
          }
        } catch (error) {
          setMessage(String(error?.message ?? error))
        } finally {
          setBusy(null)
        }
      }

      const label = busy
        ? `${busy === 'pack' ? '打包中' : '释放中'}：${progress?.label ?? '准备中'} ${progress?.percent ?? 0}%`
        : null

      return h('div', {
        className: 'dsh-migrate-dock',
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
          padding: '4px 8px',
          fontSize: '12px',
          color: colors.text,
        },
      }, [
        h('span', { key: 'brand', style: { color: colors.muted } }, '大肥鱼'),
        h('button', { key: 'pack', type: 'button', style: buttonStyle(true), disabled: busy !== null, onClick: () => start('pack') }, '打包大肥鱼'),
        h('button', { key: 'release', type: 'button', style: buttonStyle(false), disabled: busy !== null, onClick: () => start('release') }, '释放大肥鱼'),
        label ? h('span', { key: 'progress', style: { color: colors.muted } }, label) : null,
        message ? h('span', { key: 'message', style: { color: colors.muted, maxWidth: '420px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: message }, message) : null,
      ])
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-migrate',
          order: 60,
        }, Dock))
      },
    }
  },
})
