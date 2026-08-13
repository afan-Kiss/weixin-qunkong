/**
 * 启动更新（对齐开云）：检查 → 确认「立即更新」→ 进度条下载 → 替换重启。
 */

const HOST_ID = 'app-upd-modal'
const STARTUP_UPDATE_KEY = 'app-startup-update-checked'

function fmtBytes(n: number) {
  const value = Number(n) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function ensureModal() {
  let el = document.getElementById(HOST_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = HOST_ID
  el.className = 'app-upd-modal'
  el.setAttribute('hidden', '')
  el.innerHTML = `
    <div class="app-upd-box" role="dialog" aria-modal="true" aria-labelledby="app-upd-title">
      <h3 id="app-upd-title">发现新版本</h3>
      <p class="app-upd-name" id="app-upd-name"></p>
      <p class="app-upd-hint" id="app-upd-hint">更新会关闭当前窗口并启动新版本。可稍后更新，继续使用本版本。</p>
      <div class="app-upd-actions" id="app-upd-actions">
        <button type="button" class="app-upd-btn app-upd-btn--primary" id="app-upd-now">立即更新</button>
        <button type="button" class="app-upd-btn app-upd-btn--ghost" id="app-upd-later">稍后更新</button>
      </div>
      <div class="app-upd-progress" id="app-upd-progress" hidden>
        <div class="app-upd-bar"><i id="app-upd-bar" style="width:0%"></i></div>
        <p class="app-upd-pct" id="app-upd-pct">准备下载…</p>
      </div>
    </div>
  `
  document.body.appendChild(el)
  return el
}

function setProgressVisible(visible: boolean) {
  const actions = document.getElementById('app-upd-actions')
  const progress = document.getElementById('app-upd-progress')
  if (actions) {
    if (visible) actions.setAttribute('hidden', '')
    else actions.removeAttribute('hidden')
  }
  if (progress) {
    if (visible) progress.removeAttribute('hidden')
    else progress.setAttribute('hidden', '')
  }
}

function isForcedUpdate(info: { mandatory?: boolean; policy?: string }) {
  const policy = String(info?.policy || '')
  if (policy === 'MANDATORY' || policy === 'REMOTE_TARGETED_MANDATORY' || policy === 'SECURITY_EMERGENCY') return true
  return Boolean(info?.mandatory)
}

/**
 * 显示确认弹层；用户点「立即更新」后下载替换。
 * automatic=false：始终等待用户选择（禁止假「稍后」自动开下）。
 */
async function runClientUpdateModal(
  info: { fileName?: string; latestVersion?: string; fileSize?: number; mandatory?: boolean; policy?: string },
  applyFn: () => Promise<{ ok?: boolean; message?: string; deferred?: boolean; pending?: boolean }>,
  automatic = false,
) {
  const el = ensureModal()
  const forced = isForcedUpdate(info)
  const name = String(info?.fileName || (info?.latestVersion ? `微信群控系统v${info.latestVersion}.exe` : '新版本'))
  const nameEl = document.getElementById('app-upd-name')
  const bar = document.getElementById('app-upd-bar')
  const pctEl = document.getElementById('app-upd-pct')
  const hint = document.getElementById('app-upd-hint')
  const title = document.getElementById('app-upd-title')
  const btnNow = document.getElementById('app-upd-now')
  const btnLater = document.getElementById('app-upd-later')

  if (nameEl) nameEl.textContent = name + (info?.fileSize ? `（${fmtBytes(Number(info.fileSize))}）` : '')
  if (title) {
    title.textContent = forced
      ? (String(info?.policy) === 'SECURITY_EMERGENCY' ? '安全紧急更新' : '必须更新后才能继续')
      : '发现新版本'
  }
  if (hint) {
    hint.textContent = forced
      ? '当前版本需要更新。请选择「立即更新」，或「退出」关闭软件。不会在后台假装稍后自动更新。'
      : '更新会关闭当前窗口并启动新版本。可稍后更新，继续使用本版本。'
  }
  if (btnLater) {
    if (forced) {
      btnLater.textContent = '退出'
      btnLater.removeAttribute('hidden')
    } else {
      btnLater.textContent = '稍后更新'
      btnLater.removeAttribute('hidden')
    }
  }
  if (bar) bar.style.width = '0%'
  if (pctEl) pctEl.textContent = '0%'
  setProgressVisible(false)
  el.removeAttribute('hidden')

  // 即使误传 automatic=true，强制更新也必须等用户点选，禁止假稍后
  const waitForUser = !automatic || forced
  const choice = waitForUser
    ? await new Promise<'now' | 'later' | 'exit'>((resolve) => {
      const onNow = () => {
        cleanup()
        resolve('now')
      }
      const onLater = () => {
        cleanup()
        resolve(forced ? 'exit' : 'later')
      }
      function cleanup() {
        try { btnNow?.removeEventListener('click', onNow) } catch { /* ignore */ }
        try { btnLater?.removeEventListener('click', onLater) } catch { /* ignore */ }
      }
      btnNow?.addEventListener('click', onNow)
      btnLater?.addEventListener('click', onLater)
    })
    : 'now' as const

  if (choice === 'exit') {
    el.setAttribute('hidden', '')
    try { await window.wxControl?.quitApp?.() } catch {
      try { window.close() } catch { /* ignore */ }
    }
    return { ok: false as const, deferred: false as const, message: '已退出以等待更新' }
  }

  if (choice === 'later') {
    el.setAttribute('hidden', '')
    return { ok: false as const, deferred: true as const, message: '已跳过本次更新，稍后或下次检查再提示' }
  }

  setProgressVisible(true)
  if (hint) hint.textContent = '正在下载；完成后再自动替换、启动新版本并关闭旧版（下载中不会关闭）'

  const onProgress = (ev: { phase?: string; downloaded?: number; total?: number; percent?: number; speedBps?: number; message?: string }) => {
    const phase = String(ev?.phase || '')
    const percent = Math.max(0, Math.min(100, Number(ev?.percent) || 0))
    if (bar) bar.style.width = `${percent.toFixed(1)}%`
    if (phase === 'download') {
      const loaded = Number(ev?.downloaded) || 0
      const total = Number(ev?.total) || 0
      const speed = Number(ev?.speedBps) || 0
      const speedText = speed > 0
        ? (speed >= 1024 * 1024
          ? `${(speed / (1024 * 1024)).toFixed(2)} MB/s`
          : `${(speed / 1024).toFixed(0)} KB/s`)
        : ''
      if (pctEl) {
        const sizeText = total > 0
          ? `${percent.toFixed(1)}%（${fmtBytes(loaded)} / ${fmtBytes(total)}）`
          : `${percent.toFixed(1)}%`
        pctEl.textContent = speedText ? `${sizeText} · ${speedText}` : sizeText
      }
      if (hint) {
        hint.textContent = speedText
          ? `下载中 ${speedText}；完成后才会启动新版本并关闭旧版`
          : '下载中，请勿关闭；完成后才会启动新版本并关闭旧版'
      }
    } else if (phase === 'installing') {
      if (pctEl) pctEl.textContent = '100% · 更新助手已调度，正在关闭旧版…'
      if (hint) hint.textContent = String(ev?.message || '请稍候，旧版本即将关闭')
    } else if (phase === 'error') {
      if (pctEl) pctEl.textContent = String(ev?.message || '更新失败')
      if (hint) hint.textContent = '更新失败，软件不会关闭，可稍后重开再试'
    }
  }

  const stopProgress = window.wxControl?.onUpdateProgress?.(onProgress)
  try {
    const res = await applyFn()
    if (!res?.ok) {
      onProgress({ phase: 'error', message: res?.message || '更新失败', percent: 0 })
      await new Promise((resolve) => setTimeout(resolve, 2200))
      el.setAttribute('hidden', '')
      return { ok: false as const, message: res?.message || '更新失败', deferred: Boolean(res?.deferred || res?.pending) }
    }
    onProgress({ phase: 'installing', percent: 100, message: res?.message || '即将重启' })
    await new Promise((resolve) => setTimeout(resolve, 15000))
    el.setAttribute('hidden', '')
    return { ok: true as const, message: res?.message || '更新完成' }
  } finally {
    stopProgress?.()
  }
}

let bootstrapStarted = false
let modalOpen = false
let deferOptionalUntilPeriodic = false

/**
 * 冷启动 / 周期检查更新：有新版弹确认，点「立即更新」再下载替换。
 */
export async function bootstrapClientUpdate() {
  if (bootstrapStarted) return
  bootstrapStarted = true
  if (!window.wxControl?.checkClientUpdate) return

  let pageReloadGuard = false
  try { pageReloadGuard = sessionStorage.getItem(STARTUP_UPDATE_KEY) === '1' } catch { /* ignore */ }
  // 同会话内页面重载：不再弹更新，只关掉主进程启动窗口
  if (pageReloadGuard) {
    try { await window.wxControl?.markStartupUpdateDone?.('DEFERRED') } catch { /* ignore */ }
  }

  const run = async (meta?: { reason?: string }) => {
    const reason = String(meta?.reason || 'startup')
    // 重复触发（主进程信号 + 兜底）只忽略进行中的弹窗，绝不能提前 markStartupUpdateDone，
    // 否则用户还没点「立即更新」窗口就被关掉，表现为「点更新没有用」。
    if (modalOpen) return
    if (deferOptionalUntilPeriodic && reason !== 'periodic' && reason !== 'online') return
    if (pageReloadGuard && reason === 'startup') return

    try { sessionStorage.setItem(STARTUP_UPDATE_KEY, '1') } catch { /* ignore */ }
    pageReloadGuard = true

    let applySucceeded = false
    try {
      const upd = await window.wxControl?.checkClientUpdate?.()
      if (!upd) return
      if (upd.ok === false) {
        console.warn('[update]', upd.message || '检查更新失败')
        // 网络失败：不 mark done，留给启动退避 / 周期重试
        return
      }
      if (!upd.needUpdate) {
        try { await window.wxControl?.markStartupUpdateDone?.(upd.code || 'NO_UPDATE') } catch { /* ignore */ }
        return
      }
      if (upd.canApply === false) {
        console.warn('[update]', upd.message || '发现新版本，但当前不是便携包运行环境，无法自动替换')
        return
      }
      modalOpen = true
      // automatic=false：等待用户；policy 驱动强制文案
      const applied = await runClientUpdateModal(upd, () => window.wxControl!.applyClientUpdate(), false)
      if (applied?.ok === true) applySucceeded = true
      else if (applied && 'deferred' in applied && applied.deferred) {
        deferOptionalUntilPeriodic = !isForcedUpdate(upd)
        console.info('[update]', applied.message)
        try { await window.wxControl?.markStartupUpdateDone?.('DEFERRED') } catch { /* ignore */ }
      } else if (applied?.ok === false) console.warn('[update]', applied.message)
    } catch (error) {
      console.warn('[update] check failed', error)
    } finally {
      modalOpen = false
      // 失败不 markStartupUpdateDone，允许退避重试
      if (applySucceeded) {
        /* 进程即将退出 */
      }
    }
  }

  window.wxControl.onUpdateStartupCheck?.((payload?: { reason?: string }) => { void run(payload) })
  void run({ reason: 'startup' })
}
