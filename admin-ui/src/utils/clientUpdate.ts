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

/**
 * 显示确认弹层；用户点「立即更新」后下载替换。
 */
async function runClientUpdateModal(
  info: { fileName?: string; latestVersion?: string; fileSize?: number; mandatory?: boolean },
  applyFn: () => Promise<{ ok?: boolean; message?: string; deferred?: boolean }>,
  automatic = false,
) {
  const el = ensureModal()
  const name = String(info?.fileName || (info?.latestVersion ? `微信群控系统v${info.latestVersion}.exe` : '新版本'))
  const nameEl = document.getElementById('app-upd-name')
  const bar = document.getElementById('app-upd-bar')
  const pctEl = document.getElementById('app-upd-pct')
  const hint = document.getElementById('app-upd-hint')
  const title = document.getElementById('app-upd-title')
  const btnNow = document.getElementById('app-upd-now')
  const btnLater = document.getElementById('app-upd-later')

  if (nameEl) nameEl.textContent = name + (info?.fileSize ? `（${fmtBytes(Number(info.fileSize))}）` : '')
  if (title) title.textContent = info?.mandatory ? '发现新版本（建议尽快更新）' : '发现新版本'
  if (hint) {
    hint.textContent = info?.mandatory
      ? '建议尽快更新。点「稍后更新」可继续使用本版本，下次启动再提示；点「立即更新」会关闭当前窗口并启动新版本。'
      : '更新会关闭当前窗口并启动新版本。可稍后更新，继续使用本版本。'
  }
  if (bar) bar.style.width = '0%'
  if (pctEl) pctEl.textContent = '0%'
  setProgressVisible(false)
  el.removeAttribute('hidden')

  const choice = automatic ? 'now' : await new Promise<'now' | 'later'>((resolve) => {
    const onNow = () => {
      cleanup()
      resolve('now')
    }
    const onLater = () => {
      cleanup()
      resolve('later')
    }
    function cleanup() {
      try { btnNow?.removeEventListener('click', onNow) } catch { /* ignore */ }
      try { btnLater?.removeEventListener('click', onLater) } catch { /* ignore */ }
    }
    btnNow?.addEventListener('click', onNow)
    btnLater?.addEventListener('click', onLater)
  })

  if (choice === 'later') {
    el.setAttribute('hidden', '')
    return { ok: false as const, deferred: true as const, message: '已跳过本次更新，下次启动再检查' }
  }

  setProgressVisible(true)
  if (hint) hint.textContent = '正在下载；完成后再自动替换、启动新版本并关闭旧版（下载中不会关闭）'

  const onProgress = (ev: { phase?: string; downloaded?: number; total?: number; percent?: number; message?: string }) => {
    const phase = String(ev?.phase || '')
    const percent = Math.max(0, Math.min(100, Number(ev?.percent) || 0))
    if (bar) bar.style.width = `${percent.toFixed(1)}%`
    if (phase === 'download') {
      const loaded = Number(ev?.downloaded) || 0
      const total = Number(ev?.total) || 0
      if (pctEl) {
        pctEl.textContent = total > 0
          ? `${percent.toFixed(1)}%（${fmtBytes(loaded)} / ${fmtBytes(total)}）`
          : `${percent.toFixed(1)}%`
      }
      if (hint) hint.textContent = '下载中，请勿关闭；完成后才会启动新版本并关闭旧版'
    } else if (phase === 'installing') {
      if (pctEl) pctEl.textContent = '100% · 新版本已启动，正在关闭旧版…'
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
      return { ok: false as const, message: res?.message || '更新失败' }
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

/**
 * 冷启动自动检查更新：有新版弹确认，点「立即更新」再下载替换。
 */
export async function bootstrapClientUpdate() {
  if (bootstrapStarted) return
  bootstrapStarted = true
  if (!window.wxControl?.checkClientUpdate) return

  let alreadyChecked = false
  try { alreadyChecked = sessionStorage.getItem(STARTUP_UPDATE_KEY) === '1' } catch { /* ignore */ }
  // 同会话内页面重载：不再弹更新，只关掉主进程启动窗口
  if (alreadyChecked) {
    try { await window.wxControl?.markStartupUpdateDone?.() } catch { /* ignore */ }
    return
  }

  const run = async () => {
    // 重复触发（主进程信号 + 兜底）只忽略，绝不能提前 markStartupUpdateDone，
    // 否则用户还没点「立即更新」窗口就被关掉，表现为「点更新没有用」。
    if (alreadyChecked) return
    alreadyChecked = true
    try { sessionStorage.setItem(STARTUP_UPDATE_KEY, '1') } catch { /* ignore */ }

    let applySucceeded = false
    try {
      const upd = await window.wxControl?.checkClientUpdate?.()
      if (!upd) return
      if (upd.ok === false) {
        console.warn('[update]', upd.message || '检查更新失败')
        return
      }
      if (!upd.needUpdate) return
      if (upd.canApply === false) {
        console.warn('[update]', upd.message || '发现新版本，但当前不是便携包运行环境，无法自动替换')
        return
      }
      const applied = await runClientUpdateModal(upd, () => window.wxControl!.applyClientUpdate(), true)
      if (applied?.ok === true) applySucceeded = true
      else if (applied && 'deferred' in applied && applied.deferred) console.info('[update]', applied.message)
      else if (applied?.ok === false) console.warn('[update]', applied.message)
    } catch (error) {
      console.warn('[update] check failed', error)
    } finally {
      if (!applySucceeded) {
        try { await window.wxControl?.markStartupUpdateDone?.() } catch { /* ignore */ }
      }
    }
  }

  // 主进程冷启动信号 + 本进程兜底（防止信号早于监听）；重复调用安全
  window.wxControl.onUpdateStartupCheck?.(() => { void run() })
  void run()
}
