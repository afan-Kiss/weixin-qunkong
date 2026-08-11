'use strict'
/**
 * 进程内 LiveKit 桌面推流（隐藏 BrowserWindow）。
 * JPEG 全图由 remote-agent 兜底；不再使用自研 RTCPeerConnection。
 */
const path = require('path')
const { BrowserWindow, ipcMain, desktopCapturer, session, screen } = require('electron')

let pubWin = null
let ready = false
let starting = false
let activeSessionId = ''
let onSignalOut = null
let onControlOut = null
let onLog = null
let displayHandlerInstalled = false
let ipcWired = false
let mediaConnected = false
let activeRoomName = ''
let queuedStart = null
let stopWaitTimer = null
let jpegResumeTimer = null
/** getDisplayMedia / desktopCapturer 进行中：JPEG 必须让路，避免 Windows 双抓屏卡死 */
let captureBusy = false
/** 已发出 start/restart、尚未 connected/failed：JPEG 也必须让路（handler finally 清 busy 后仍有空窗） */
let webrtcStarting = false
let startingSince = 0
/** 连续 getDisplayMedia 超时次数；达阈值拆掉推流窗清 Chromium 采集会话 */
let captureFailStreak = 0
const CAPTURE_FAIL_RECYCLE_AT = 2
/** 推流协商最长保护窗：超时后允许 JPEG 兜底，避免永久黑屏 */
const STARTING_GUARD_MS = 35000

function log(message, details) {
  try { onLog?.(message, details || {}) } catch (_) {}
}

function clearJpegResumeTimer() {
  if (jpegResumeTimer) {
    clearTimeout(jpegResumeTimer)
    jpegResumeTimer = null
  }
}

function scheduleJpegResume(delayMs) {
  clearJpegResumeTimer()
  jpegResumeTimer = setTimeout(() => {
    jpegResumeTimer = null
    mediaConnected = false
  }, Math.max(0, Number(delayMs) || 0))
  if (typeof jpegResumeTimer.unref === 'function') jpegResumeTimer.unref()
}

function markWebRtcStarting(on = true) {
  if (on) {
    webrtcStarting = true
    captureBusy = true
    startingSince = Date.now()
    return
  }
  webrtcStarting = false
  startingSince = 0
}

function installDisplayHandler() {
  if (displayHandlerInstalled) return
  displayHandlerInstalled = true
  try {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      // 整段 getDisplayMedia 生命周期都由 webrtcStarting/capturing 守门；
      // 勿在 callback 后立刻清 busy —— Chromium 此时仍在建轨，JPEG 一抢就卡死。
      captureBusy = true
      webrtcStarting = true
      if (!startingSince) startingSince = Date.now()
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        })
        // 与 JPEG 路径一致：优先主屏，避免多显示器时 WebRTC/JPEG 画面不一致
        let primaryId = ''
        try { primaryId = String(screen.getPrimaryDisplay()?.id || '') } catch (_) {}
        const source = (primaryId && sources.find((s) => String(s.display_id) === primaryId)) || sources[0]
        if (!source) {
          callback({})
          return
        }
        callback({ video: source })
      } catch (_) {
        callback({})
      }
    }, { useSystemPicker: false })
  } catch (error) {
    log('display media handler failed', { error: String(error?.message || error) })
  }
}

function recyclePublisherWindow(reason) {
  log('recycle webrtc publisher', { reason: String(reason || '') })
  clearStopWaitTimer()
  clearJpegResumeTimer()
  mediaConnected = false
  captureBusy = false
  markWebRtcStarting(false)
  ready = false
  const doomed = pubWin
  pubWin = null
  if (!doomed || doomed.isDestroyed()) return
  try { doomed.destroy() } catch (_) {
    try { doomed.close() } catch (_2) {}
  }
}

function wireIpc() {
  if (ipcWired) return
  ipcWired = true
  ipcMain.on('webrtc-pub:event', (_event, payload) => {
    const msg = payload && typeof payload === 'object' ? payload : {}
    const type = String(msg.type || '')
    if (type === 'booted') {
      ready = true
      return
    }
    if (type === 'signal') {
      try { onSignalOut?.(msg) } catch (_) {}
      return
    }
    if (type === 'control') {
      try { onControlOut?.(msg.payload || msg) } catch (_) {}
      return
    }
    if (type === 'error') {
      const message = String(msg.message || '')
      // capture_track_ended：热恢复中，暂不放行 JPEG
      // getDisplayMedia_timeout：必须立刻放行 JPEG，否则双路径都死 → 屏幕墙「卡死」
      const soft = /capture_track_ended|control_decode_failed/i.test(message)
      const captureTimeout = /getDisplayMedia_timeout/i.test(message)
      if (captureTimeout) {
        mediaConnected = false
        captureBusy = false
        markWebRtcStarting(false)
        clearJpegResumeTimer()
        captureFailStreak += 1
        log('webrtc publisher error', { message, soft: false, captureFailStreak })
        if (captureFailStreak >= CAPTURE_FAIL_RECYCLE_AT) {
          captureFailStreak = 0
          recyclePublisherWindow('getDisplayMedia_timeout')
        }
      } else if (!soft) {
        mediaConnected = false
        captureBusy = false
        markWebRtcStarting(false)
        log('webrtc publisher error', { message, soft: false })
      } else {
        log('webrtc publisher error', { message, soft: true })
      }
      try {
        onSignalOut?.({
          type: 'webrtc_error',
          message,
          desktopSessionId: activeSessionId,
        })
      } catch (_) {}
      return
    }
    if (type === 'state') {
      const st = String(msg.connectionState || '')
      if (st === 'capturing') {
        captureBusy = true
        webrtcStarting = true
        if (!startingSince) startingSince = Date.now()
        return
      }
      if (st === 'connected') {
        mediaConnected = true
        captureBusy = false
        markWebRtcStarting(false)
        captureFailStreak = 0
        clearJpegResumeTimer()
      } else if (st === 'reconnecting' || st === 'signalReconnecting') {
        // 不把 reconnecting 当成已连通；宽限数秒后放行 JPEG，避免长卡死
        captureBusy = false
        markWebRtcStarting(false)
        scheduleJpegResume(4000)
      } else if (st === 'disconnected' || st === 'failed' || st === 'closed') {
        captureBusy = false
        markWebRtcStarting(false)
        clearJpegResumeTimer()
        mediaConnected = false
      }
      log('webrtc state', { connectionState: st, reused: !!msg.reused, reason: String(msg.reason || '') })
      return
    }
    if (type === 'ready') {
      log('webrtc publisher ready', { desktopSessionId: String(msg.desktopSessionId || '') })
      return
    }
    if (type === 'stopped') {
      mediaConnected = false
      captureBusy = false
      markWebRtcStarting(false)
      ready = !!(pubWin && !pubWin.isDestroyed())
    }
  })
}

async function ensureWindow() {
  installDisplayHandler()
  wireIpc()
  if (pubWin && !pubWin.isDestroyed()) return pubWin
  ready = false
  mediaConnected = false
  captureBusy = false
  pubWin = new BrowserWindow({
    show: false,
    width: 2,
    height: 2,
    skipTaskbar: true,
    frame: false,
    transparent: true,
    focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'webrtc-publisher-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false,
    },
  })
  pubWin.setMenuBarVisibility(false)
  pubWin.on('closed', () => {
    pubWin = null
    ready = false
    mediaConnected = false
    captureBusy = false
    markWebRtcStarting(false)
  })
  await pubWin.loadFile(path.join(__dirname, 'webrtc-publisher.html'))
  const t0 = Date.now()
  while (!ready && Date.now() - t0 < 8000) {
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!ready) {
    throw new Error('webrtc_publisher_not_ready')
  }
  return pubWin
}

function sendCommand(cmd) {
  if (!pubWin || pubWin.isDestroyed()) return false
  try {
    pubWin.webContents.send('webrtc-pub:command', cmd)
    return true
  } catch {
    return false
  }
}

async function drainQueuedStart() {
  if (!queuedStart) return
  const next = queuedStart
  queuedStart = null
  await startWebRtcDesktop(next)
}

/**
 * @param {{
 *  desktopSessionId?: string,
 *  quality?: string,
 *  forceRestart?: boolean,
 *  onSignal?: (msg: Record<string, unknown>) => void,
 *  onControl?: (payload: Record<string, unknown>) => void,
 *  onLog?: (message: string, details?: Record<string, unknown>) => void,
 * }} opts
 */
function clearStopWaitTimer() {
  if (stopWaitTimer) {
    clearTimeout(stopWaitTimer)
    stopWaitTimer = null
  }
}

async function startWebRtcDesktop(opts = {}) {
  onSignalOut = typeof opts.onSignal === 'function' ? opts.onSignal : onSignalOut
  onControlOut = typeof opts.onControl === 'function' ? opts.onControl : onControlOut
  onLog = typeof opts.onLog === 'function' ? opts.onLog : onLog
  // 取消未执行的 destroy，否则快速 stop→start 会把新 publisher 拆掉
  clearStopWaitTimer()
  if (starting) {
    queuedStart = opts
    return { ok: true, pending: true }
  }
  starting = true
  try {
    const nextSid = String(opts.desktopSessionId || '')
    const livekitUrl = String(opts.livekitUrl || '')
    const livekitToken = String(opts.livekitToken || '')
    const roomName = String(opts.roomName || '')
    if (nextSid) activeSessionId = nextSid
    await ensureWindow()
    if (!ready) {
      const err = 'webrtc_publisher_not_ready'
      log(err, {})
      try {
        onSignalOut?.({ type: 'webrtc_error', message: err, desktopSessionId: activeSessionId })
      } catch (_) {}
      return { ok: false, error: err }
    }
    if (!livekitUrl || !livekitToken) {
      const err = 'livekit_credentials_missing'
      log(err, {})
      try {
        onSignalOut?.({ type: 'webrtc_error', message: err, desktopSessionId: activeSessionId })
      } catch (_) {}
      return { ok: false, error: err }
    }
    // LiveKit 房间按设备固定；新 desktopSessionId 默认复用。显式 forceRestart 且未连通才硬拉。
    const prevRoom = activeRoomName
    const sameRoom = !!(roomName && prevRoom && roomName === prevRoom)
    if (roomName) activeRoomName = roomName
    // 已连通同房：忽略墙侧 forceRestart，避免 DUPLICATE_IDENTITY 卡死
    if (mediaConnected && sameRoom) {
      markWebRtcStarting(false)
      return { ok: true, reused: true }
    }
    // 未连通或换房才 restart；显式 force 仅在未连通时生效
    const forceRestart = !mediaConnected || !!(roomName && prevRoom && roomName !== prevRoom) || (!!opts.forceRestart && !mediaConnected)
    // 先占门再发令：堵住 startCapture 同步启动 JPEG 的竞态窗口
    markWebRtcStarting(true)
    const sent = sendCommand({
      op: forceRestart ? 'restart' : 'start',
      desktopSessionId: activeSessionId,
      livekitUrl,
      livekitToken,
      roomName,
      quality: opts.quality || 'auto',
    })
    if (!sent) {
      markWebRtcStarting(false)
      captureBusy = false
      const err = 'webrtc_command_send_failed'
      try {
        onSignalOut?.({ type: 'webrtc_error', message: err, desktopSessionId: activeSessionId })
      } catch (_) {}
      return { ok: false, error: err }
    }
    return { ok: true }
  } catch (error) {
    markWebRtcStarting(false)
    captureBusy = false
    const err = String(error?.message || error)
    log('webrtc start failed', { error: err })
    try {
      onSignalOut?.({ type: 'webrtc_error', message: err, desktopSessionId: activeSessionId })
    } catch (_) {}
    return { ok: false, error: err }
  } finally {
    starting = false
    void drainQueuedStart()
  }
}

function stopWebRtcDesktop() {
  activeSessionId = ''
  activeRoomName = ''
  mediaConnected = false
  captureBusy = false
  markWebRtcStarting(false)
  captureFailStreak = 0
  queuedStart = null
  clearJpegResumeTimer()
  clearStopWaitTimer()
  const win = pubWin
  if (!win || win.isDestroyed()) {
    pubWin = null
    ready = false
    return
  }
  // 先让渲染进程停轨，再关窗，避免轨道/编码会话泄漏
  sendCommand({ op: 'stop' })
  const doomed = win
  stopWaitTimer = setTimeout(() => {
    stopWaitTimer = null
    // 若 start 已换窗或取消了定时器，勿销毁当前 publisher
    if (pubWin !== doomed || !pubWin || pubWin.isDestroyed()) return
    try { pubWin.destroy() } catch (_) {
      try { pubWin.close() } catch (_2) {}
    }
    pubWin = null
    ready = false
    mediaConnected = false
    captureBusy = false
    markWebRtcStarting(false)
  }, 400)
  if (typeof stopWaitTimer.unref === 'function') stopWaitTimer.unref()
}

function isWebRtcDesktopActive() {
  // 有 publisher 窗即视为 WebRTC 抓屏活跃（含协商中），供 JPEG 双抓屏门控
  return !!(pubWin && !pubWin.isDestroyed())
}

function isWebRtcMediaConnected() {
  return !!mediaConnected
}

function isWebRtcCaptureBusy() {
  return !!captureBusy
}

function isWebRtcStarting() {
  if (!webrtcStarting) return false
  if (startingSince && (Date.now() - startingSince) > STARTING_GUARD_MS) {
    // 保护窗过期：放行 JPEG，避免永久无画面
    webrtcStarting = false
    captureBusy = false
    startingSince = 0
    return false
  }
  return true
}

module.exports = {
  startWebRtcDesktop,
  stopWebRtcDesktop,
  isWebRtcDesktopActive,
  isWebRtcMediaConnected,
  isWebRtcCaptureBusy,
  isWebRtcStarting,
  markWebRtcStarting,
}
