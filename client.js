window.__ModuleLoader__.load({
  id: '@local/dsh-chatgpt-plan',
  factory(require) {
    const React = require('react')
    const { createElement: h, useEffect, useId, useRef, useState } = React
    const slot = 'sidebar.footer.action'
    // Diff Approval uses the slot default (0); Cost Meter's wide card
    // takes visual precedence with its own flex order (-1).
    const ns = 'chatgpt-plan.usage'
    const zh = {
      title: 'Codex 订阅用量', loading: '正在查询…', signedOut: 'Codex 尚未登录',
      signIn: '在设置 → 内置插件 → ChatGPT Plan 登录，也可运行 /chatgpt-plan image-login。', forbidden: '仅主机所有者可查看',
      unavailable: '额度接口尚未加载，请重启 DSH Desktop。', error: '查询失败，请稍后重试。',
      empty: '服务端未返回可展示的额度。', details: '展开或收起用量详情', refresh: '刷新',
      refreshing: '刷新中…', left: '约剩 {value}%', primary: '主窗口', secondary: '次窗口',
      loadingCompact: '查询中', signedOutCompact: '未登录', unavailableCompact: '未加载', errorCompact: '查询失败', emptyCompact: '无额度数据',
      weeks: '{n} 周窗口', days: '{n} 天窗口', hours: '{n} 小时窗口', minutes: '{n} 分钟窗口',
      resets: '重置：{time}', unknown: '未返回', updated: '更新于 {time}', bucket: '额度组 {n}',
      unlimited: '额外积分：不限量', noCredits: '无可用额外积分', credits: '额外积分余额：{balance}',
      availableCredits: '有可用额外积分，余额未返回', resetsLeft: '可用重置次数：{n}',
      resetAction: '重置额度', confirmReset: '确认重置', cancelReset: '取消', resetting: '正在重置 Codex 额度…', resettingCompact: '重置中',
      resetPrompt: '若当前窗口符合条件，将使用 1 次重置机会。确认继续？',
      reset: '符合条件的 Codex 额度已重置。', alreadyRedeemed: '这次请求已重置过，未再次扣减次数。',
      nothingToReset: '当前没有符合条件的额度窗口，未扣减次数。', noCredit: '当前没有可用的重置次数。',
      resetStale: '额度或账号状态已更新，请重新确认。', resetNotSent: '未发送重置请求。请刷新额度后再试。',
      resetUncertain: '重置结果待确认。请在 Codex 用量管理页查看，勿重复提交。',
      resetUnsupported: '当前 Codex 连接未开放重置。请前往官方用量管理页。',
      resetUnavailable: '当前没有可确认的重置机会。', official: 'Codex 用量管理',
      scope: '仅显示 Codex 订阅额度，不含 SIWC 文本、独立生图或 API 余额。',
    }
    const en = {
      title: 'Codex subscription usage', loading: 'Checking…', signedOut: 'Signed out of Codex',
      signIn: 'Sign in under Settings → Built-in plugins → ChatGPT Plan, or run /chatgpt-plan image-login.', forbidden: 'Host owner only',
      unavailable: 'Usage endpoint not loaded. Restart DSH Desktop.', error: 'Could not load usage. Try again.',
      empty: 'No quota details returned.', details: 'Toggle usage details', refresh: 'Refresh',
      refreshing: 'Refreshing…', left: '≈ {value}% left', primary: 'Primary window', secondary: 'Secondary window',
      loadingCompact: 'Checking', signedOutCompact: 'Signed out', unavailableCompact: 'Not loaded', errorCompact: 'Unavailable', emptyCompact: 'No data',
      weeks: '{n}-week window', days: '{n}-day window', hours: '{n}-hour window', minutes: '{n}-min window',
      resets: 'Resets: {time}', unknown: 'Not reported', updated: 'Updated {time}', bucket: 'Quota group {n}',
      unlimited: 'Extra credits: unlimited', noCredits: 'No extra credits', credits: 'Extra credits: {balance}',
      availableCredits: 'Extra credits available; balance not reported', resetsLeft: 'Resets available: {n}',
      resetAction: 'Reset usage', confirmReset: 'Confirm reset', cancelReset: 'Cancel', resetting: 'Resetting Codex usage…', resettingCompact: 'Resetting',
      resetPrompt: 'If a window qualifies, this uses one reset credit. Continue?',
      reset: 'Eligible Codex usage windows were reset.', alreadyRedeemed: 'This request was already redeemed; no extra credit was used.',
      nothingToReset: 'No usage window qualifies; no credit was used.', noCredit: 'No reset credits are currently available.',
      resetStale: 'Usage or account state changed. Please confirm again.', resetNotSent: 'Reset was not sent. Refresh usage before trying again.',
      resetUncertain: 'Reset outcome is uncertain. Check Codex usage before submitting anything again.',
      resetUnsupported: 'This Codex connection does not expose reset. Open the official usage page.',
      resetUnavailable: 'No reset is currently available to confirm.', official: 'Codex usage settings',
      scope: 'Codex subscription only. Not SIWC text, a separate image allowance, or API balance.',
    }
    const styles = `
      .dsh-chatgpt-plan-usage { --cq-inline-inset: 8px; box-sizing: border-box; width: 100%; min-width: 0; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
      .dsh-chatgpt-plan-usage button { background: transparent; color: inherit; font: inherit; border: 0; border-radius: var(--dsw-radius-md); cursor: pointer; }
      .dsh-chatgpt-plan-usage button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: -2px; }
      @media (hover: hover) {
        .dsh-chatgpt-plan-usage button:not([aria-disabled="true"]):hover { background: var(--dsh-claude-hover-bg, var(--dsw-alias-interactive-bg-hover)); }
      }
      .dsh-chatgpt-plan-usage .cq-entry { display: flex; align-items: center; gap: 7px; width: 100%; min-height: 32px; padding: 4px var(--cq-inline-inset); text-align: start; }
      .dsh-chatgpt-plan-usage .cq-entry[aria-expanded="true"] { background: var(--dsh-claude-hover-bg, var(--dsw-alias-interactive-bg-hover)); }
      .dsh-chatgpt-plan-usage .cq-icon { flex: none; }
      .dsh-chatgpt-plan-usage .cq-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dsh-chatgpt-plan-usage .cq-value { flex: none; font-size: 12px; font-variant-numeric: tabular-nums; }
      .dsh-chatgpt-plan-usage .cq-muted { color: var(--dsw-alias-label-secondary); }
      .dsh-chatgpt-plan-usage .cq-summary, .dsh-chatgpt-plan-usage .cq-details { margin-inline: var(--cq-inline-inset); font-size: 12px; }
      .dsh-chatgpt-plan-usage .cq-summary { padding-block-end: 4px; }
      .dsh-chatgpt-plan-usage .cq-summary .cq-window:first-child { margin-block-start: 2px; }
      .dsh-chatgpt-plan-usage .cq-details { margin-block-start: 4px; padding: 6px 0 4px; max-height: min(38vh, 280px); overflow: auto; border-block-start: 1px solid var(--dsh-claude-divider, var(--dsw-alias-border-l1)); }
      .dsh-chatgpt-plan-usage .cq-line { display: flex; align-items: baseline; flex-wrap: wrap; column-gap: 6px; justify-content: space-between; }
      .dsh-chatgpt-plan-usage .cq-controls { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 4px; }
      .dsh-chatgpt-plan-usage .cq-action { flex: none; min-height: 26px; padding: 2px 6px; border: 1px solid var(--dsh-claude-divider, var(--dsw-alias-border-l1)); }
      .dsh-chatgpt-plan-usage .cq-action[aria-disabled="true"] { color: var(--dsw-alias-label-secondary); cursor: default; }
      .dsh-chatgpt-plan-usage a { color: inherit; text-underline-offset: 2px; }
      .dsh-chatgpt-plan-usage .cq-group + .cq-group { border-block-start: 1px solid var(--dsh-claude-divider, var(--dsw-alias-border-l1)); padding-block-start: 6px; }
      .dsh-chatgpt-plan-usage .cq-group, .dsh-chatgpt-plan-usage .cq-window, .dsh-chatgpt-plan-usage .cq-note { margin-block-start: 6px; }
      .dsh-chatgpt-plan-usage .cq-heading { font-weight: 600; }
      .dsh-chatgpt-plan-usage .cq-meter { height: 4px; margin-block: 3px; border-radius: 999px; overflow: hidden; background: var(--dsw-alias-border-l2); }
      .dsh-chatgpt-plan-usage .cq-meter > span { display: block; height: 100%; border-radius: inherit; background: var(--dsw-alias-brand-primary); }
      @media (forced-colors: active) {
        .dsh-chatgpt-plan-usage .cq-meter { forced-color-adjust: none; background: Canvas; outline: 1px solid CanvasText; }
        .dsh-chatgpt-plan-usage .cq-meter > span { background: Highlight; }
      }
    `
    function icon(path, size) {
      return h('svg', { className: 'cq-icon cq-muted', width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: path }))
    }
    const statusKey = { loading: 'loading', 'signed-out': 'signedOut', forbidden: 'forbidden', unavailable: 'unavailable', error: 'error', resetting: 'resetting' }
    const resetKey = { reset: 'reset', alreadyRedeemed: 'alreadyRedeemed', nothingToReset: 'nothingToReset', noCredit: 'noCredit',
      stale: 'resetStale', notSent: 'resetNotSent', pending: 'resetting', unsupported: 'resetUnsupported', uncertain: 'resetUncertain' }
    const initial = { state: 'loading' }
    const remaining = value => Math.max(0, Math.min(100, 100 - value))
    function windowName(t, data) {
      const n = data.durationMins
      if (!Number.isSafeInteger(n) || n <= 0) return t(data.kind)
      for (const [unit, size] of [['weeks', 10080], ['days', 1440], ['hours', 60], ['minutes', 1]]) {
        if (n % size === 0) return t(unit, { n: n / size })
      }
    }
    function time(value, seconds, locale) {
      const date = new Date(seconds ? value * 1000 : value)
      return Number.isSafeInteger(value) && value > 0 && Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
        : undefined
    }
    function usageFetch(path, options) {
      const transport = globalThis.__DSH_TRANSPORT__
      const url = new URL(`api/chatgpt-plan/usage${path}`, document.baseURI)
      const request = { credentials: 'same-origin', cache: 'no-store', ...options }
      return transport?.fetch ? transport.fetch(url, request) : globalThis.fetch(url, request)
    }
    function useUsage() {
      const [data, setData] = useState(initial)
      const [busy, setBusy] = useState(null)
      const [result, setResult] = useState(null)
      const action = useRef(null)
      useEffect(() => {
        let active = true, inFlight
        async function read(force, controller) {
          try {
            const response = await usageFetch(force ? '?refresh=1' : '', {
              method: 'GET', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(24000)]),
            })
            let next
            if (response.status === 401 || response.status === 403) next = { state: 'forbidden' }
            else if (response.status === 404) next = { state: 'unavailable' }
            else if (!response.ok) next = { state: 'error' }
            else {
              const snapshot = await response.json()
              next = ['signed-out', 'resetting'].includes(snapshot?.state) || (snapshot?.state === 'ready' && Array.isArray(snapshot.buckets))
                ? snapshot : { state: 'error' }
            }
            if (active) setData(next)
          } catch { if (active) setData({ state: 'error' }) }
        }
        async function run(kind, work) {
          if (!active || inFlight) return
          const controller = new AbortController()
          inFlight = controller
          setBusy(kind)
          try { await work(controller) }
          finally {
            inFlight = undefined
            if (active) setBusy(null)
          }
        }
        const load = (force = false) => {
          if (!document.hidden) void run('read', controller => read(force, controller))
        }
        action.current = {
          load,
          reset: resetToken => run('reset', async controller => {
            setResult(null)
            let value = 'uncertain'
            try {
              const response = await usageFetch('/reset', { method: 'POST',
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true, resetToken }),
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(44000)]),
              })
              if (response.status === 401 || response.status === 403) value = 'notSent'
              else if (response.status === 404) value = 'unsupported'
              else {
                const answer = await response.json()
                if (Object.hasOwn(resetKey, answer?.outcome)) value = answer.outcome
              }
            } catch { /* Never retry after an ambiguous transport result. */ }
            if (active) {
              setResult(value)
              await read(true, controller)
            }
          }),
        }
        const poll = () => load()
        poll()
        const timer = setInterval(poll, 60000)
        document.addEventListener('visibilitychange', poll)
        return () => {
          active = false
          action.current = null
          inFlight?.abort()
          clearInterval(timer)
          document.removeEventListener('visibilitychange', poll)
        }
      }, [])
      return { data, busy, result, refresh: () => action.current?.load(true), reset: key => action.current?.reset(key) }
    }
    function Usage({ t, activeLocale }) {
      const { data, busy, result, refresh, reset } = useUsage()
      const [open, setOpen] = useState(false)
      const [confirmToken, setConfirmToken] = useState(null)
      const toggle = useRef(null), resetButton = useRef(null), cancelButton = useRef(null)
      const id = useId()
      const ready = data.state === 'ready'
      const buckets = ready ? data.buckets : []
      const groupName = (group, index) => group.name ?? group.id ?? t('bucket', { n: index + 1 })
      const summaryGroup = buckets.find(group => group.id === 'codex' && group.windows.length) ?? buckets.find(group => group.windows.length)
      const message = statusKey[data.state] ? t(statusKey[data.state]) : ready && !summaryGroup ? t('empty') : null
      const locale = activeLocale()
      const when = time(data.fetchedAt, false, locale)
      const blocked = data.resetBlocked ?? (['uncertain', 'unsupported'].includes(result) ? result : null)
      const eligible = ready && !blocked && data.resetCount > 0 && typeof data.resetToken === 'string'
      const confirming = open && eligible && confirmToken === data.resetToken
      const pending = busy === 'reset' || data.state === 'resetting'
      const notice = pending ? t('resetting') : blocked ? t(resetKey[blocked]) : result && result !== 'pending' ? t(resetKey[result])
        : busy === 'read' && ready ? t('refreshing') : message
      useEffect(() => { if (confirming) cancelButton.current?.focus() }, [confirming])
      function closeConfirm() {
        setConfirmToken(null)
        resetButton.current?.focus()
      }
      function credit(group) {
        const c = group.credits
        if (c?.unlimited) return t('unlimited')
        if (c?.balance !== undefined) return t('credits', { balance: c.balance })
        if (c?.hasCredits === false) return t('noCredits')
        if (c?.hasCredits === true) return t('availableCredits')
        return null
      }
      function meter(w) {
        const value = remaining(w.usedPercent)
        return h('div', { key: w.kind, className: 'cq-window' },
          h('div', { className: 'cq-line' }, h('span', null, windowName(t, w)),
            h('span', { className: 'cq-value' }, t('left', { value }))),
          h('div', { className: 'cq-meter', 'aria-hidden': true }, h('span', { style: { width: `${value}%` } })),
          h('div', { className: 'cq-muted' }, t('resets', { time: time(w.resetsAt, true, locale) ?? t('unknown') })))
      }
      // A non-owner sees no account values or persistent action surface.
      if (data.state === 'forbidden') return null
      return h('section', { className: 'dsh-chatgpt-plan-usage', 'aria-label': t('title'), onKeyDown: event => {
        if (!open || event.key !== 'Escape') return
        event.stopPropagation()
        if (confirming) closeConfirm()
        else { setConfirmToken(null); setOpen(false); toggle.current?.focus() }
      } },
      h('button', { ref: toggle, type: 'button', className: 'cq-entry', title: t('details'),
        'aria-expanded': open, 'aria-controls': id,
        onClick: () => { setConfirmToken(null); setOpen(v => !v) } },
        h('span', { className: 'cq-title' }, t('title')),
        (pending || message) && h('span', { className: 'cq-value cq-muted' }, t(pending ? 'resettingCompact' : ready ? 'emptyCompact' : `${statusKey[data.state]}Compact`)),
        icon(open ? 'm7 15 5-5 5 5' : 'm7 10 5 5 5-5', 14)),
      summaryGroup && h('div', { className: 'cq-summary' }, summaryGroup.windows.map(meter)),
      h('div', { id, hidden: !open, className: 'cq-details' },
        h('div', { className: 'cq-line' }, h('span', { className: 'cq-muted' }, when ? t('updated', { time: when }) : ''),
          h('button', { type: 'button', className: 'cq-action', 'aria-disabled': !!busy, onClick: () => { if (!busy) refresh() } }, t('refresh'))),
        h('div', { role: 'status', className: 'cq-muted' }, notice),
        data.state === 'signed-out' && h('div', null, t('signIn')),
        buckets.map((group, i) => {
          const extra = credit(group)
          const windows = group === summaryGroup ? [] : group.windows
          if (!extra && !windows.length) return null
          return h('div', { key: i, className: 'cq-group' },
            h('div', { className: 'cq-heading' }, groupName(group, i)), windows.map(meter),
            extra && h('div', { className: 'cq-note' }, extra))
        }),
        ready && h('div', { className: 'cq-note' },
          h('div', { className: 'cq-line' },
            h('span', null, t('resetsLeft', { n: Number.isSafeInteger(data.resetCount) ? data.resetCount : t('unknown') })),
            h('button', { ref: resetButton, type: 'button', className: 'cq-action',
              'aria-disabled': !eligible || !!busy || confirming,
              'aria-describedby': !eligible ? `${id}-reset-info` : undefined,
              onClick: () => { if (eligible && !busy && !confirming) setConfirmToken(data.resetToken) },
            }, t('resetAction'))),
          !eligible && h('div', { id: `${id}-reset-info`, className: 'cq-muted' }, blocked ? t(resetKey[blocked]) : t('resetUnavailable')),
          confirming && h('div', { className: 'cq-note' },
            h('div', { id: `${id}-confirm`, className: 'cq-muted' }, t('resetPrompt')),
            h('div', { className: 'cq-controls' },
              h('button', { ref: cancelButton, type: 'button', className: 'cq-action', onClick: closeConfirm }, t('cancelReset')),
              h('button', { type: 'button', className: 'cq-action', 'aria-describedby': `${id}-confirm`,
                onKeyDown: event => { if (event.repeat) event.preventDefault() },
                'aria-disabled': !!busy, onClick: event => {
                  if (busy || event.detail > 1) return
                  closeConfirm()
                  void reset(confirmToken)
                },
              }, t('confirmReset'))))),
        (ready || blocked) && h('div', { className: 'cq-muted cq-note' },
          h('a', { href: 'https://chatgpt.com/codex/settings/usage', target: '_blank', rel: 'noreferrer' }, t('official'))),
        h('div', { className: 'cq-muted cq-note' }, t('scope'))))
    }
    function FooterUsage({ wide, t, activeLocale }) {
      if (!wide) return null
      return h(React.Fragment, null, h('style', null, styles), h(Usage, { t, activeLocale }))
    }
    const authSlot = 'settings.plugins.tab'
    const authNs = 'chatgpt-plan.auth'
    const authZh = {
      tab: 'ChatGPT Plan', intro: '文字推理与 Codex 生图使用两套独立的 ChatGPT 登录。',
      text: '文字推理', textInfo: '使用 Sign in with ChatGPT 连接文字模型。',
      codex: 'Codex 生图', codexInfo: '使用 Codex 设备验证码连接生图。',
      signedOut: '未登录', checking: '正在检查…', pending: '等待完成登录', connected: '已连接',
      cancelled: '登录已取消', expired: '登录已过期，请重试', failed: '登录未完成，请重试',
      start: '登录', cancel: '取消登录', refresh: '刷新状态', starting: '正在启动登录…', cancelling: '正在取消登录…',
      browser: '登录由 DSH 主机打开默认浏览器，请在该浏览器完成。',
      forbidden: '仅主机所有者可管理登录。', unavailable: '登录接口尚未加载。', requestFailed: '请求失败，请刷新状态后重试。', statusUnavailable: '暂时查不到登录状态，请刷新。',
      code: '设备验证码', codeHelp: '在官方验证页面输入此验证码。请勿与他人分享。',
      copy: '复制验证码', copied: '验证码已复制。', copyFailed: '请选中验证码并手动复制。', fallback: '手动打开官方验证页面',
    }
    const authEn = {
      tab: 'ChatGPT Plan', intro: 'Text inference and Codex image generation use separate ChatGPT sign-ins.',
      text: 'Text inference', textInfo: 'Connect text models through Sign in with ChatGPT.',
      codex: 'Codex image generation', codexInfo: 'Connect image generation with a Codex device code.',
      signedOut: 'Signed out', checking: 'Checking…', pending: 'Waiting for sign-in', connected: 'Connected',
      cancelled: 'Sign-in cancelled', expired: 'Sign-in expired. Try again.', failed: 'Sign-in incomplete. Try again.',
      start: 'Sign in', cancel: 'Cancel sign-in', refresh: 'Refresh status', starting: 'Starting sign-in…', cancelling: 'Cancelling sign-in…',
      browser: 'DSH opens the default browser on the host. Complete sign-in in that browser.',
      forbidden: 'Only the host owner can manage sign-in.', unavailable: 'The sign-in endpoint is not loaded.', requestFailed: 'Request failed. Refresh status and try again.', statusUnavailable: 'Sign-in status is unavailable. Refresh to try again.',
      code: 'Device code', codeHelp: 'Enter this code on the official verification page. Do not share it.',
      copy: 'Copy code', copied: 'Device code copied.', copyFailed: 'Select and copy the code manually.', fallback: 'Open the official verification page manually',
    }
    const authStates = new Set(['signedOut', 'checking', 'pending', 'connected', 'cancelled', 'expired', 'failed', 'statusUnavailable'])
    const authKinds = ['text', 'codex']
    const authStyles = `
      .dsh-chatgpt-plan-auth { display: grid; gap: 10px; padding-top: 8px; min-width: 0; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
      .dsh-chatgpt-plan-auth p, .dsh-chatgpt-plan-auth h3 { margin: 0; }
      .dsh-chatgpt-plan-auth p { color: var(--dsw-alias-label-secondary); }
      .dsh-chatgpt-plan-auth h3 { font-size: 14px; font-weight: 600; }
      .dsh-chatgpt-plan-auth .cpa-card { display: grid; gap: 8px; min-width: 0; padding: 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); }
      .dsh-chatgpt-plan-auth .cpa-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dsh-chatgpt-plan-auth .cpa-line > :first-child { margin-inline-end: auto; }
      .dsh-chatgpt-plan-auth button, .dsh-chatgpt-plan-auth input { color: inherit; background: transparent; font: inherit; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md, 8px); }
      .dsh-chatgpt-plan-auth button { cursor: pointer; padding: 4px 10px; min-height: 28px; }
      .dsh-chatgpt-plan-auth button[aria-disabled=true] { color: var(--dsw-alias-label-secondary); cursor: default; }
      .dsh-chatgpt-plan-auth button:not([aria-disabled=true]):hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-chatgpt-plan-auth :is(a, button, input):focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary)); outline-offset: 2px; }
      .dsh-chatgpt-plan-auth a { color: var(--dsw-alias-brand-primary); text-underline-offset: 2px; }
      .dsh-chatgpt-plan-auth .cpa-code { display: grid; justify-items: start; gap: 7px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l2); }
      .dsh-chatgpt-plan-auth input { box-sizing: border-box; width: 36ch; max-width: 100%; padding: 4px 7px; font-family: monospace; user-select: all; }
    `
    function officialVerification(value) {
      // Validate the original authority too: URL strips an explicit default port.
      if (typeof value !== 'string' || !/^https:\/\/(?:auth\.openai\.com|chatgpt\.com)(?:[/?#]|$)/i.test(value)) return undefined
      try {
        const url = new URL(value)
        if (url.protocol === 'https:' && ['auth.openai.com', 'chatgpt.com'].includes(url.hostname) && !url.username && !url.password && !url.port) return url.href
      } catch { /* Invalid verification URL. */ }
    }
    function authSnapshot(value) {
      if (!authStates.has(value?.text?.state) || !authStates.has(value?.codex?.state)) throw new Error('Invalid auth snapshot')
      const text = { state: value.text.state }, codex = { state: value.codex.state }
      if (codex.state === 'pending') {
        codex.verificationUrl = officialVerification(value.codex.verificationUrl)
        const code = value.codex.userCode
        if (typeof code === 'string' && /^[A-Za-z0-9-]{4,32}$/.test(code)) codex.userCode = code
      }
      return { text, codex }
    }
    function authFetch(path, options) {
      const transport = globalThis.__DSH_TRANSPORT__
      const url = new URL(`api/chatgpt-plan/auth${path}`, document.baseURI)
      const request = { credentials: 'same-origin', cache: 'no-store', redirect: 'error', ...options }
      return transport?.fetch ? transport.fetch(url, request) : globalThis.fetch(url, request)
    }
    function useAuth(root) {
      const [data, setData] = useState(null)
      const [readError, setReadError] = useState(null)
      const [actionError, setActionError] = useState(null)
      const [action, setAction] = useState(null)
      const [reading, setReading] = useState(false)
      const controls = useRef(null)
      useEffect(() => {
        const element = root.current
        if (!element) return
        let active = true, visible = false, inView = true, latest = null, timer, current
        const canRead = () => active && visible && !document.hidden && !!element.getClientRects().length
        const clearPoll = () => { clearTimeout(timer); timer = undefined }
        function schedule() {
          clearPoll()
          if (!canRead() || current || !latest) return
          // A host-reported checking state can precede pending in another caller's flow.
          if (authKinds.some(kind => ['pending', 'checking'].includes(latest[kind].state))) timer = setTimeout(read, 2500)
        }
        async function request(actionName) {
          if (!canRead() || current?.actionName || (!actionName && current)) return
          clearPoll()
          current?.controller.abort()
          const req = { controller: new AbortController(), actionName }
          current = req
          if (actionName) { setAction(actionName); setActionError(null); setReading(false) }
          else setReading(true)
          let reconcile = false
          const isCurrent = () => active && current === req && (actionName || canRead())
          try {
            const response = await authFetch(actionName ? `/${actionName}` : '', {
              method: actionName ? 'POST' : 'GET',
              ...(actionName ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) } : {}),
              signal: AbortSignal.any([req.controller.signal, AbortSignal.timeout(actionName ? 45000 : 16000)]),
            })
            if (!isCurrent()) return
            if (!response.ok) {
              const error = response.status === 401 || response.status === 403 ? 'forbidden' : response.status === 404 ? 'unavailable' : 'requestFailed'
              if (error !== 'requestFailed') {
                latest = null
                setData(null)
                setReadError(error)
                setActionError(null)
              } else {
                if (actionName) { setActionError(error); reconcile = true }
                else setReadError(error)
              }
              return
            }
            const snapshot = authSnapshot(await response.json())
            if (isCurrent()) { latest = snapshot; setData(snapshot); setReadError(null) }
          } catch {
            if (!isCurrent()) return
            if (actionName) { setActionError('requestFailed'); reconcile = true }
            else setReadError('requestFailed')
          } finally {
            if (active && current === req) {
              current = undefined
              if (actionName) setAction(null)
              else setReading(false)
              if (reconcile) read()
              else schedule()
            }
          }
        }
        function read() { void request(null) }
        function visibility() {
          if (!active) return
          const next = inView && !document.hidden && !!element.getClientRects().length
          if (next === visible) return
          visible = next
          if (visible) read()
          else {
            clearPoll()
            if (current && !current.actionName) {
              current.controller.abort()
              current = undefined
              setReading(false)
            }
          }
        }
        controls.current = { read: () => {
          if (!canRead() || current) return
          setActionError(null)
          read()
        }, mutate: (kind, verb) => {
          const state = latest?.[kind]?.state
          if (!authKinds.includes(kind) || !state) return
          if (verb === 'start' && ['signedOut', 'cancelled', 'expired', 'failed'].includes(state)) void request(`${kind}/start`)
          else if (verb === 'cancel' && state === 'pending') void request(`${kind}/cancel`)
        } }
        const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; visibility() })
        observer.observe(element)
        document.addEventListener('visibilitychange', visibility)
        visibility()
        return () => {
          active = false
          controls.current = null
          clearPoll()
          current?.controller.abort()
          observer.disconnect()
          document.removeEventListener('visibilitychange', visibility)
        }
      }, [root])
      return { data, readError, actionError, action, reading, read: () => controls.current?.read(), mutate: (kind, verb) => controls.current?.mutate(kind, verb) }
    }
    function AuthDeviceCode({ code, verificationUrl, t }) {
      const input = useRef(null)
      const [copyResult, setCopyResult] = useState(null)
      async function copy() {
        try {
          await navigator.clipboard.writeText(code)
          if (input.current) setCopyResult('copied')
        } catch {
          if (!input.current) return
          input.current.focus()
          input.current.select()
          setCopyResult('copyFailed')
        }
      }
      return h('div', { className: 'cpa-code' },
        code && h(React.Fragment, null,
          h('p', null, t('codeHelp')),
          h('input', { 'aria-label': t('code'), ref: input, readOnly: true, value: code, onFocus: event => event.currentTarget.select(), spellCheck: false }),
          h('button', { type: 'button', onClick: () => { void copy() } }, t('copy')),
          copyResult && h('p', { role: 'status' }, t(copyResult))),
        verificationUrl && h('a', { href: verificationUrl, target: '_blank', rel: 'noopener noreferrer' }, t('fallback')))
    }
    function AuthSettings({ t }) {
      const root = useRef(null)
      const auth = useAuth(root)
      const { data, action, reading, readError, actionError } = auth
      function card(kind) {
        const profile = data[kind], state = profile.state
        const verb = state === 'pending' ? 'cancel' : ['signedOut', 'cancelled', 'expired', 'failed'].includes(state) ? 'start' : null
        const active = action?.startsWith(`${kind}/`)
        return h('section', { key: kind, className: 'cpa-card', 'aria-label': t(kind) },
          h('div', { className: 'cpa-line' }, h('h3', null, t(kind)),
            verb && h('button', { type: 'button', 'aria-label': `${t(verb)} · ${t(kind)}`, 'aria-disabled': !!action,
              onClick: () => { if (!action) auth.mutate(kind, verb) },
            }, t(verb))),
          h('p', null, t(`${kind}Info`)),
          h('p', { role: 'status' }, t(active ? (action.endsWith('/start') ? 'starting' : 'cancelling') : state)),
          state === 'pending' && !active && h('p', null, t('browser')),
          kind === 'codex' && state === 'pending' && !active && (profile.userCode || profile.verificationUrl) && h(AuthDeviceCode, {
            key: profile.userCode ?? 'link', code: profile.userCode, verificationUrl: profile.verificationUrl, t,
          }))
      }
      return h('div', { ref: root, className: 'dsh-chatgpt-plan-auth' },
        h('style', null, authStyles),
        h('div', { className: 'cpa-line' }, h('p', null, t('intro')),
          h('button', { type: 'button', 'aria-disabled': !!action || reading, onClick: auth.read }, t('refresh'))),
        (readError || actionError || !data) && h('p', { role: 'status' }, t(readError || actionError || 'checking')),
        data && authKinds.map(card))
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(ns, { zh, en }))
        ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, id: 'codex-usage', locale: ns, order: -1,
          inject: () => ({ activeLocale: () => ctx.locale.getSnapshot().active }),
        }, FooterUsage))
        ctx.effect(() => ctx.locale.register(authNs, { zh: authZh, en: authEn }))
        const tAuth = ctx.locale.bind(authNs)
        ctx.slots.inject(authSlot, () => ctx.slots.register({
          name: authSlot, id: 'chatgpt-plan', order: 20, label: () => tAuth('tab'), locale: authNs,
        }, AuthSettings))
      },
    }
  },
})
