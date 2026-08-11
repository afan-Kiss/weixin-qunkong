const { desktopCapturer, shell, screen, nativeImage } = require('electron')
const WebSocket = require('ws')
const http = require('http')
const https = require('https')
const { loadOrCreate, signRaw, authHeaders, BUILD_ID, VERSION, PROTOCOL, agentWsRequestPath } = require('./device-identity.cjs')
const { getServiceBase, getDesktopHashPath } = require('./secure-config.cjs')
const { insecureTlsForService } = require('./service-tls.cjs')
const { handleControlPayload, stopWorker } = require('./win-input.cjs')
const {
  startWebRtcDesktop,
  stopWebRtcDesktop,
  isWebRtcMediaConnected,
  isWebRtcDesktopActive,
  isWebRtcCaptureBusy,
  isWebRtcStarting,
  markWebRtcStarting,
  updateAgentToken,
} = require('./webrtc-desktop.cjs')

/** 最近一次 WebRTC 会话参数，供代理 WS 重连后恢复 */
let lastWebRtcOpts = null
/** 串行化 WS 命令，避免 start/stop/signal 交错 */
let agentMsgChain = Promise.resolve()

const DEFAULT_BASE = getServiceBase()
/**
 * 远程桌面总开关。
 * WebRTC 为主路径；JPEG 仅低频关键帧，供屏幕墙 / latest 兜底。
 * 旧实现备份：electron/_backup_remote_desktop_disabled_*
 */
const DESKTOP_CAPTURE_ENABLED = true
/** 进程内 WebRTC 推流（隐藏窗，不侧载外部进程） */
const DESKTOP_WEBRTC_ENABLED = true
/** WebRTC 未连通时 JPEG 兜底间隔；连通后停止 JPEG，避免双路抓屏吃 CPU/内存 */
const JPEG_SNAPSHOT_INTERVAL_MS = 5000
/** 桌面图传：优先流畅，分辨率略降以减小单帧体积 */
const CAPTURE_MAX_WIDTH = 1280
const CAPTURE_MAX_HEIGHT = 720
/** JPEG 质量：正常 / 轻度拥塞 / 重度拥塞 */
const JPEG_QUALITY_NORMAL = 70
const JPEG_QUALITY_MID = 55
const JPEG_QUALITY_LOW = 42
/** 抓帧间隔（毫秒）：快 / 正常 / 慢，按发送缓冲自适应 */
const CAPTURE_INTERVAL_FAST_MS = 90
const CAPTURE_INTERVAL_MS = 150
const CAPTURE_INTERVAL_SLOW_MS = 280
/** 拥塞时再拉长间隔，避免旧帧在 WS 发送队列里越堆越久（表现为“开久越卡”） */
const CAPTURE_INTERVAL_BACKLOG_MS = 450
const CAPTURE_INTERVAL_DRAIN_MS = 800
/** 脏矩形网格（对齐开云 desktop-delta-v1） */
const TILE_SIZE = 64
const DELTA_KEYFRAME_EVERY_N = 60
const DELTA_KEYFRAME_MAX_AGE_MS = 8000
const DELTA_DIRTY_AREA_LIMIT = 0.35
/** 发送队列水位：超过软阈值只发关键帧；超过硬阈值丢帧并等排空 */
const BUFFER_SOFT_BYTES = 256 * 1024
const BUFFER_HARD_BYTES = 512 * 1024
const BUFFER_DROP_BYTES = 768 * 1024
let state = { running: false, connected: false, watching: false, identity: null, baseUrl: DEFAULT_BASE, account: '', lastError: '' }
let socket = null
let reconnectTimer = null
let heartbeatTimer = null
let captureTimer = null
let stopping = false
let logger = null
let frameSeq = 0
let keySeq = 0
let framesSinceKey = 0
let lastKeyAt = 0
let forceKey = true
let prevBitmap = null
let prevW = 0
let prevH = 0
let reconnectAttempt = 0
let lastServerAt = 0
let watchdogTimer = null
let captureInFlight = false
let callbacks = {}
let syncTimer = null
let tokenRefreshTimer = null
/** agentToken 签发时间戳（本地 Date.now），用于计算 refresh 时机 */
let agentTokenIssuedAt = 0
const AGENT_TOKEN_TTL_MS = 3600 * 1000
const AGENT_TOKEN_REFRESH_BEFORE_MS = 600 * 1000
let tokenRefreshAttempt = 0
let tokenRefreshRunning = false
/** 连续因发送队列拥塞而跳过的次数；用于拉长抓帧间隔帮助排空 */
let bufferSkipStreak = 0
const MAX_BUFFERED_BYTES = BUFFER_DROP_BYTES

function log(message, details = {}) { try { logger?.(message, details) } catch {} }
function rootUrl(value) { return String(value || DEFAULT_BASE).replace(/\/$/, '') }
function dataOf(value) { return value?.data && typeof value.data === 'object' ? value.data : value }

async function postJson(baseUrl, pathname, body) {
  const payload = JSON.stringify(body)
  const target = `${rootUrl(baseUrl)}${pathname}`
  const u = new URL(target)
  const lib = u.protocol === 'https:' ? https : http
  const data = await new Promise((resolve, reject) => {
    const req = lib.request(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 20000,
      ...insecureTlsForService(u.hostname),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let parsed = {}
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { parsed = {} }
        resolve({ status: res.statusCode || 0, data: parsed })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
    req.write(payload)
    req.end()
  })
  if (data.status >= 300 || data.data?.ok === false) throw new Error(data.data?.message || `HTTP ${data.status}`)
  return dataOf(data.data)
}

async function ensureRegistered(identity, baseUrl) {
  const challenge = await postJson(baseUrl, '/api/device/register/challenge', { publicKey: identity.publicKeyB64, buildId: BUILD_ID })
  const done = await postJson(baseUrl, '/api/device/register/complete', { challengeId: challenge.challengeId, challenge: challenge.challenge, publicKey: identity.publicKeyB64, signature: signRaw(identity, challenge.challenge) })
  log('设备连接信息已更新', { deviceId: identity.deviceId, status: done.status })
  return done
}

function wsUrl(baseUrl, clientId) {
  const url = new URL(rootUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (url.protocol !== 'wss:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('公网连接必须使用 WSS 加密通道')
  const agentPath = agentWsRequestPath()
  url.pathname = `${url.pathname.replace(/\/$/, '')}${agentPath}`
  url.search = `clientId=${encodeURIComponent(clientId)}`
  return url.toString()
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false
  try { socket.send(JSON.stringify(message)); return true } catch { return false }
}

function heartbeat() {
  const identity = state.identity
  if (!identity) return
  send({
    type: 'heartbeat',
    id: `${Date.now()}`,
    payload: {
      clientId: identity.clientId,
      account: state.account,
      version: VERSION,
      desktopWatching: state.watching,
      capabilities: {
        jpegDesktop: DESKTOP_CAPTURE_ENABLED,
        desktopDelta: DESKTOP_CAPTURE_ENABLED && !DESKTOP_WEBRTC_ENABLED,
        webrtc: DESKTOP_WEBRTC_ENABLED,
        files: false,
        camera: false,
      },
      ...PROTOCOL,
    },
  })
}

function resetDeltaState() {
  prevBitmap = null
  prevW = 0
  prevH = 0
  framesSinceKey = 0
  lastKeyAt = 0
  forceKey = true
}

/**
 * 对比 BGRA 位图，收集 64px 网格脏块（开云 CollectDirtyTiles 等价实现）。
 * @param {Buffer|null} prev
 * @param {Buffer} cur
 * @param {number} width
 * @param {number} height
 * @returns {{ x: number, y: number, w: number, h: number }[]}
 */
function collectDirtyTiles(prev, cur, width, height) {
  if (!cur || width <= 0 || height <= 0 || cur.length < width * height * 4) return []
  const forceAll = !prev || prevW !== width || prevH !== height || prev.length < width * height * 4
  const out = []
  for (let y = 0; y < height; y += TILE_SIZE) {
    const th = Math.min(TILE_SIZE, height - y)
    for (let x = 0; x < width; x += TILE_SIZE) {
      const tw = Math.min(TILE_SIZE, width - x)
      let dirty = forceAll
      if (!dirty) {
        for (let row = 0; row < th && !dirty; row += 1) {
          const off = ((y + row) * width + x) * 4
          const bytes = tw * 4
          if (!cur.subarray(off, off + bytes).equals(prev.subarray(off, off + bytes))) dirty = true
        }
      }
      if (dirty) out.push({ x, y, w: tw, h: th })
    }
  }
  return out
}

function dirtyAreaRatio(tiles, width, height) {
  if (width <= 0 || height <= 0) return 1
  let area = 0
  for (const t of tiles) area += t.w * t.h
  return area / (width * height)
}

/** 能力未启用时的统一提示（避免源码出现直白功能词堆叠） */
function capabilityDisabledMessage() {
  return '当前客户端未启用该能力'
}

async function syncWechatData() {
  if (socket?.readyState !== WebSocket.OPEN || !callbacks.getSyncSnapshot) return
  try { const payload = await callbacks.getSyncSnapshot(); if (payload) send({ type: 'wx_sync', payload }) } catch (error) { log('微信数据同步失败', { error: String(error?.message || error) }) }
}

/**
 * 计算抓帧分辨率（按主屏物理像素，限制上限）。
 * @returns {{ width: number, height: number, display: Electron.Display }}
 */
function resolveCaptureSize() {
  const display = screen.getPrimaryDisplay()
  const scale = Number(display.scaleFactor) > 0 ? Number(display.scaleFactor) : 1
  const physW = Math.max(1, Math.round((display.size?.width || CAPTURE_MAX_WIDTH) * scale))
  const physH = Math.max(1, Math.round((display.size?.height || CAPTURE_MAX_HEIGHT) * scale))
  const ratio = Math.min(1, CAPTURE_MAX_WIDTH / physW, CAPTURE_MAX_HEIGHT / physH)
  return {
    width: Math.max(320, Math.round(physW * ratio)),
    height: Math.max(180, Math.round(physH * ratio)),
    display,
  }
}

/**
 * 在 BGRA 位图上绘制标准箭头鼠标（desktopCapturer 缩略图不含光标）。
 * @param {Buffer} bitmap toBitmap() 结果
 * @param {number} width 图像宽
 * @param {number} height 图像高
 * @param {number} cursorX 光标 X（图像坐标）
 * @param {number} cursorY 光标 Y（图像坐标）
 */
function paintArrowCursor(bitmap, width, height, cursorX, cursorY) {
  // 经典箭头轮廓（相对热点 0,0）
  const shape = [
    'X',
    'XX',
    'X.X',
    'X..X',
    'X...X',
    'X....X',
    'X.....X',
    'X......X',
    'X.......X',
    'X........X',
    'X.....XXXX',
    'X..X..X',
    'X.X X.X',
    'XX  X.X',
    'X   X.X',
    '     X.X',
    '     X.X',
    '      XX',
  ]
  const setPx = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const i = (y * width + x) * 4
    bitmap[i] = b
    bitmap[i + 1] = g
    bitmap[i + 2] = r
    bitmap[i + 3] = a
  }
  for (let row = 0; row < shape.length; row += 1) {
    const line = shape[row]
    for (let col = 0; col < line.length; col += 1) {
      const ch = line[col]
      if (ch === 'X') setPx(cursorX + col, cursorY + row, 0, 0, 0, 255)
      else if (ch === '.') setPx(cursorX + col, cursorY + row, 255, 255, 255, 255)
    }
  }
}

/**
 * 仅计算光标相对截帧坐标（不改图像）。
 * @param {Electron.NativeImage} image 截帧
 * @param {Electron.Display} display 显示器
 * @returns {{ x: number, y: number, nx: number, ny: number, visible: boolean }}
 */
function resolveCursor(image, display) {
  const size = image.getSize()
  const bounds = display.bounds || { x: 0, y: 0, width: display.size.width, height: display.size.height }
  const point = screen.getCursorScreenPoint()
  const localX = point.x - bounds.x
  const localY = point.y - bounds.y
  const visible = localX >= 0 && localY >= 0 && localX < bounds.width && localY < bounds.height
  const nx = bounds.width > 1 ? Math.min(1, Math.max(0, localX / (bounds.width - 1 || 1))) : 0
  const ny = bounds.height > 1 ? Math.min(1, Math.max(0, localY / (bounds.height - 1 || 1))) : 0
  return {
    x: Math.round(nx * Math.max(size.width - 1, 0)),
    y: Math.round(ny * Math.max(size.height - 1, 0)),
    nx,
    ny,
    visible,
  }
}

/**
 * 把当前鼠标位置合成到截帧图上，并返回光标归一化坐标。
 * @param {Electron.NativeImage} image 原始截帧
 * @param {Electron.Display} display 对应显示器
 * @param {{ paint?: boolean }} [options] paint=false 时只回传坐标，降低 CPU 占用
 * @returns {{ image: Electron.NativeImage, cursor: { x: number, y: number, nx: number, ny: number, visible: boolean } }}
 */
function compositeCursor(image, display, options = {}) {
  const cursor = resolveCursor(image, display)
  const paint = options.paint !== false
  const size = image.getSize()
  if (!paint || !cursor.visible || size.width < 8 || size.height < 8) return { image, cursor }
  try {
    const bitmap = Buffer.from(image.toBitmap())
    paintArrowCursor(bitmap, size.width, size.height, cursor.x, cursor.y)
    return { image: nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height }), cursor }
  } catch {
    return { image, cursor }
  }
}

/**
 * 标记发送队列拥塞：丢掉后续过期帧意图，并在恢复后强制关键帧（避免差分接在旧画面上）。
 * @param {number} buffered
 * @param {string} reason
 */
function markSendBacklog(buffered, reason) {
  bufferSkipStreak = Math.min(30, bufferSkipStreak + 1)
  forceKey = true
  // 释放上一帧位图，减轻长时间观看的内存驻留
  prevBitmap = null
  prevW = 0
  prevH = 0
  if (bufferSkipStreak === 1 || bufferSkipStreak % 8 === 0) {
    log('网络较慢，已丢弃过期桌面画面', { bufferedBytes: buffered, reason, streak: bufferSkipStreak })
  }
}

/**
 * 根据发送缓冲选择下一帧等待时间。
 * @returns {number} 毫秒
 */
function nextCaptureDelay() {
  // WebRTC 路径下 JPEG 仅低频探测；真正抓帧在 captureFrame 里若已连通会直接 return
  if (DESKTOP_WEBRTC_ENABLED && state.watching) return JPEG_SNAPSHOT_INTERVAL_MS
  const buffered = socket?.bufferedAmount || 0
  if (buffered > BUFFER_HARD_BYTES || bufferSkipStreak >= 6) return CAPTURE_INTERVAL_DRAIN_MS
  if (buffered > BUFFER_SOFT_BYTES || bufferSkipStreak >= 2) return CAPTURE_INTERVAL_BACKLOG_MS
  if (buffered > 128 * 1024) return CAPTURE_INTERVAL_SLOW_MS
  if (buffered > 64 * 1024) return CAPTURE_INTERVAL_MS
  if (bufferSkipStreak > 0) bufferSkipStreak = Math.max(0, bufferSkipStreak - 1)
  return CAPTURE_INTERVAL_FAST_MS
}

/**
 * 根据发送缓冲选择 JPEG 质量。
 * @returns {number}
 */
function chooseJpegQuality() {
  const buffered = socket?.bufferedAmount || 0
  if (buffered > BUFFER_SOFT_BYTES || bufferSkipStreak >= 2) return JPEG_QUALITY_LOW
  if (buffered > 128 * 1024) return JPEG_QUALITY_MID
  return JPEG_QUALITY_NORMAL
}

/**
 * 抓取一帧并推送：关键帧 JPEG，或脏矩形 frame_delta（无变化不传）。
 */
async function captureFrame() {
  if (!state.watching || socket?.readyState !== WebSocket.OPEN || captureInFlight) return
  if (stopping || !state.running) return
  // LiveKit 已出画：停 JPEG，避免双路抓屏
  if (DESKTOP_WEBRTC_ENABLED && isWebRtcMediaConnected()) {
    if (prevBitmap) { prevBitmap = null; prevW = 0; prevH = 0 }
    return
  }
  // getDisplayMedia 协商/建轨中：必须让路。Windows 上 JPEG desktopCapturer 与
  // getDisplayMedia 双开会卡死 → 屏幕墙长期「断链」。
  if (DESKTOP_WEBRTC_ENABLED && (isWebRtcCaptureBusy() || isWebRtcStarting())) return
  if (DESKTOP_WEBRTC_ENABLED && isWebRtcDesktopActive() && !forceKey) {
    const now = Date.now()
    // 未连通：按 JPEG_SNAPSHOT 间隔兜底（不能 30s，否则屏幕墙会判卡死狂拉）
    const gap = JPEG_SNAPSHOT_INTERVAL_MS
    if (lastKeyAt && (now - lastKeyAt) < gap) return
  }
  const buffered = socket.bufferedAmount || 0
  // 硬水位：只排空、不产新帧。否则旧 JPEG 在队列里排队，观感就是延迟越来越大。
  if (buffered > BUFFER_DROP_BYTES) {
    markSendBacklog(buffered, 'drop')
    return
  }
  if (buffered > BUFFER_HARD_BYTES) {
    markSendBacklog(buffered, 'hard')
    return
  }
  captureInFlight = true
  try {
    const { width, height, display } = resolveCaptureSize()
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false })
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
    if (!source || source.thumbnail.isEmpty()) return
    // 缓冲偏大时只传光标坐标，避免每帧 toBitmap 拖慢整链路
    const paintCursor = (socket.bufferedAmount || 0) < BUFFER_SOFT_BYTES
    const composed = compositeCursor(source.thumbnail, display, { paint: paintCursor })
    const size = composed.image.getSize()
    const bitmap = Buffer.from(composed.image.toBitmap())
    if (bitmap.length < size.width * size.height * 4) return

    const now = Date.now()
    const queueBytes = socket.bufferedAmount || 0
    // WebRTC 主路径：JPEG 只发关键帧快照；否则按脏矩形/拥塞策略
    let needKey = DESKTOP_WEBRTC_ENABLED
      || forceKey || !prevBitmap || prevW !== size.width || prevH !== size.height
      || framesSinceKey >= DELTA_KEYFRAME_EVERY_N
      || !lastKeyAt || (now - lastKeyAt) >= DELTA_KEYFRAME_MAX_AGE_MS
      || queueBytes > BUFFER_SOFT_BYTES
      || bufferSkipStreak > 0

    const quality = chooseJpegQuality()
    const stamp = new Date().toISOString()

    if (!needKey) {
      const tiles = collectDirtyTiles(prevBitmap, bitmap, size.width, size.height)
      if (!tiles.length) {
        // 画面无变化：不传图（对齐开云）
        return
      }
      if (dirtyAreaRatio(tiles, size.width, size.height) > DELTA_DIRTY_AREA_LIMIT) {
        needKey = true
      } else {
        const outTiles = []
        for (const tile of tiles) {
          try {
            const cropped = composed.image.crop({ x: tile.x, y: tile.y, width: tile.w, height: tile.h })
            outTiles.push({
              x: tile.x,
              y: tile.y,
              w: tile.w,
              h: tile.h,
              image: `data:image/jpeg;base64,${cropped.toJPEG(quality).toString('base64')}`,
            })
          } catch {
            needKey = true
            break
          }
        }
        if (!needKey && outTiles.length) {
          // 发送前再看一眼队列，避免编码期间又堆高
          if ((socket.bufferedAmount || 0) > BUFFER_HARD_BYTES) {
            markSendBacklog(socket.bufferedAmount || 0, 'delta-pre-send')
            return
          }
          frameSeq += 1
          const ok = send({
            type: 'frame_delta',
            clientId: state.identity.clientId,
            t: stamp,
            seq: frameSeq,
            keySeq: keySeq || frameSeq,
            w: size.width,
            h: size.height,
            tiles: outTiles,
            cursor: composed.cursor,
            source: 'desktop',
            via: 'dirty_rect',
          })
          if (ok) {
            prevBitmap = bitmap
            prevW = size.width
            prevH = size.height
            framesSinceKey += 1
            if (bufferSkipStreak > 0) bufferSkipStreak = Math.max(0, bufferSkipStreak - 1)
          } else {
            markSendBacklog(socket.bufferedAmount || 0, 'delta-send-fail')
          }
          return
        }
      }
    }

    if ((socket.bufferedAmount || 0) > BUFFER_HARD_BYTES) {
      markSendBacklog(socket.bufferedAmount || 0, 'key-pre-send')
      return
    }
    frameSeq += 1
    keySeq = frameSeq
    forceKey = false
    framesSinceKey = 0
    lastKeyAt = now
    const ok = send({
      type: 'frame',
      clientId: state.identity.clientId,
      t: stamp,
      seq: frameSeq,
      keySeq: keySeq,
      w: size.width,
      h: size.height,
      cursor: composed.cursor,
      image: `data:image/jpeg;base64,${composed.image.toJPEG(quality).toString('base64')}`,
      source: 'desktop',
      via: DESKTOP_WEBRTC_ENABLED ? 'jpeg_snapshot' : 'dirty_rect',
    })
    if (ok) {
      prevBitmap = bitmap
      prevW = size.width
      prevH = size.height
      if (bufferSkipStreak > 0) bufferSkipStreak = Math.max(0, bufferSkipStreak - 1)
    } else {
      markSendBacklog(socket.bufferedAmount || 0, 'key-send-fail')
    }
  } catch (error) { state.lastError = String(error?.message || error) }
  finally { captureInFlight = false }
}

/**
 * 抓完一帧再调度下一帧，避免 setInterval 在慢帧时堆积导致更卡。
 */
function scheduleCapture() {
  if (captureTimer) {
    clearTimeout(captureTimer)
    captureTimer = null
  }
  if (!state.watching) return
  const delay = nextCaptureDelay()
  captureTimer = setTimeout(() => {
    void captureFrame().finally(() => scheduleCapture())
  }, delay)
  if (typeof captureTimer.unref === 'function') captureTimer.unref()
}

async function startWebRtcFromMessage(message = {}) {
  if (!DESKTOP_WEBRTC_ENABLED) return { ok: false, error: 'webrtc_disabled' }
  const sid = String(message.desktopSessionId || (lastWebRtcOpts && lastWebRtcOpts.desktopSessionId) || '')
  const livekitUrl = String(message.livekitUrl || (lastWebRtcOpts && lastWebRtcOpts.livekitUrl) || '')
  const livekitToken = String(message.livekitToken || (lastWebRtcOpts && lastWebRtcOpts.livekitToken) || '')
  const roomName = String(message.roomName || (lastWebRtcOpts && lastWebRtcOpts.roomName) || '')
  const tokenChanged = livekitToken && livekitToken !== (lastWebRtcOpts?.livekitToken || '')
  lastWebRtcOpts = {
    desktopSessionId: sid,
    livekitUrl,
    livekitToken,
    roomName,
    quality: String(message.quality || lastWebRtcOpts?.quality || 'auto'),
  }
  if (tokenChanged || !agentTokenIssuedAt) {
    agentTokenIssuedAt = Date.now()
    ensureTokenRefreshScheduled()
  }
  const result = await startWebRtcDesktop({
    desktopSessionId: sid,
    livekitUrl,
    livekitToken,
    roomName,
    quality: lastWebRtcOpts.quality,
    forceRestart: !!(message.forceRestart || message.kick || message.force),
    onSignal: (msg) => {
      const out = {
        type: String(msg.type || ''),
        desktopSessionId: String(msg.desktopSessionId || sid || ''),
        clientId: state.identity?.clientId || '',
        deviceId: state.identity?.deviceId || state.identity?.clientId || '',
        transport: 'livekit',
      }
      if (msg.sdp) out.sdp = msg.sdp
      if (msg.message) out.message = String(msg.message).slice(0, 240)
      send(out)
    },
    onControl: (payload) => {
      try { handleControlPayload(payload || {}) } catch (_) {}
    },
    onLog: log,
  })
  return result
}

function startCapture(opts = {}, message = {}) {
  if (!DESKTOP_CAPTURE_ENABLED) {
    stopCapture()
    return
  }
  if (opts.forceRestart) {
    resetDeltaState()
    bufferSkipStreak = 0
  }
  state.watching = true
  if (DESKTOP_WEBRTC_ENABLED) {
    const sid = String(message.desktopSessionId || '')
    const livekitUrl = String(message.livekitUrl || '')
    const livekitToken = String(message.livekitToken || '')
    // LiveKit：必须有 url+token；绝不能仅凭 forceRestart 空转 publisher
    const resumeSid = String((lastWebRtcOpts && lastWebRtcOpts.desktopSessionId) || '')
    const resumeTok = String((lastWebRtcOpts && lastWebRtcOpts.livekitToken) || '')
    const canStartRtc = !!(
      (livekitUrl && livekitToken)
      || (opts.forceRestart && resumeSid && resumeTok)
    )
    if (canStartRtc) {
      // 同步占门，堵住下方立刻 scheduleCapture/captureFrame 与 getDisplayMedia 的竞态
      try { markWebRtcStarting(true) } catch (_) {}
      void startWebRtcFromMessage({
        ...(lastWebRtcOpts || {}),
        ...message,
        desktopSessionId: sid || resumeSid,
        livekitUrl: livekitUrl || lastWebRtcOpts?.livekitUrl,
        livekitToken: livekitToken || lastWebRtcOpts?.livekitToken,
        forceRestart: !!opts.forceRestart,
      })
    }
  }
  if (captureTimer) {
    if (opts.forceRestart) forceKey = true
    return
  }
  void captureFrame().finally(() => scheduleCapture())
}

function stopCapture() {
  state.watching = false
  if (captureTimer) clearTimeout(captureTimer)
  captureTimer = null
  bufferSkipStreak = 0
  resetDeltaState()
  try { stopWebRtcDesktop() } catch (_) {}
}

async function handleMessage(raw) {
  let message
  try { message = JSON.parse(String(raw)) } catch { return }
  lastServerAt = Date.now()
  const type = String(message?.type || '').toLowerCase()
  if (['pong', 'heartbeat_ack', 'ready'].includes(type)) return
  if (type === 'token_refresh_ack') {
    const newToken = String(message.agentToken || '')
    if (newToken && lastWebRtcOpts) {
      lastWebRtcOpts.livekitToken = newToken
      agentTokenIssuedAt = Date.now()
      tokenRefreshAttempt = 0
      if (tokenRefreshTimer) { clearTimeout(tokenRefreshTimer); tokenRefreshTimer = null }
      try { updateAgentToken(newToken) } catch (_) {}
      log('LiveKit agent token 已刷新（WS）', {})
      ensureTokenRefreshScheduled()
    }
    return
  }
  // 登出/停代理后丢弃排队命令，避免幽灵 publisher
  if (stopping || !state.running) return
  // 仅认 commandId，避免把 heartbeat_ack.id 误当成命令回执
  const commandId = message?.commandId
  if (commandId) send({ type: 'command_ack', commandId, status: 'RECEIVED' })
  try {
    let applied = true
    if (type === 'start_desktop' || type === 'screenshot') {
      if (!DESKTOP_CAPTURE_ENABLED) throw new Error('desktop_capture_disabled')
      startCapture({ forceRestart: !!(message.forceRestart || message.kick || message.force) }, message)
    }
    else if (type === 'stop_desktop') {
      stopCapture()
      lastWebRtcOpts = null
      resetTokenRefreshLifecycle()
    }
    else if (type === 'control') {
      if (!DESKTOP_CAPTURE_ENABLED) throw new Error('desktop_capture_disabled')
      // LiveKit 控制走 viewer WS；P2P 场景由前端优先 DC、失败才 WS，这里始终落地
      applied = handleControlPayload(message.payload || message)
    }
    else if (type === 'deny_run') await callbacks.onPolicy?.(false, message)
    else if (type === 'allow_run') await callbacks.onPolicy?.(true, message)
    else if (type === 'announce') await callbacks.onAnnouncement?.(message)
    else if (type === 'friend_credential_diagnostic' || String(message?.commandType || '') === 'FRIEND_CREDENTIAL_DIAGNOSTIC') {
      if (!callbacks.onFriendCredentialDiagnostic) throw new Error('诊断回调未注册')
      await callbacks.onFriendCredentialDiagnostic(message)
    } else if (type === 'check_client_update' || String(message?.commandType || '') === 'CHECK_CLIENT_UPDATE') {
      if (!callbacks.onCheckClientUpdate) throw new Error('更新回调未注册')
      await callbacks.onCheckClientUpdate(message)
    } else if (type === 'ping') send({ type: 'pong', t: new Date().toISOString() })
    else if (type === 'webrtc_answer' || type === 'webrtc_ice' || type === 'webrtc_offer') {
      // 自研 P2P 信令已废弃；LiveKit 由 SDK 处理，入站 answer/ice 忽略
      applied = true
    }
    else if (type === 'webrtc_stop') {
      if (!DESKTOP_WEBRTC_ENABLED) throw new Error(capabilityDisabledMessage())
      stopWebRtcDesktop()
    }
    else if (['file', 'start_camera', 'stop_camera'].includes(type) || type.startsWith('webrtc_')) {
      throw new Error(capabilityDisabledMessage())
    }
    else applied = false
    if (!applied) throw new Error('客户端不支持该命令')
    if (commandId) send({ type: 'command_ack', commandId, status: 'APPLIED' })
  } catch (error) {
    if (commandId) send({ type: 'command_ack', commandId, status: 'FAILED', failureReason: String(error?.message || error).slice(0, 200) })
  }
}

function resetTokenRefreshLifecycle() {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer)
  tokenRefreshTimer = null
  tokenRefreshAttempt = 0
  agentTokenIssuedAt = 0
  tokenRefreshRunning = false
}

function ensureTokenRefreshScheduled() {
  if (stopping || !state.running || !state.watching || !lastWebRtcOpts?.livekitToken) return
  if (tokenRefreshTimer) return
  const issuedAt = agentTokenIssuedAt || Date.now()
  const refreshAt = issuedAt + AGENT_TOKEN_TTL_MS - AGENT_TOKEN_REFRESH_BEFORE_MS
  const delay = Math.max(0, refreshAt - Date.now())
  tokenRefreshTimer = setTimeout(() => {
    tokenRefreshTimer = null
    void refreshAgentToken()
  }, delay)
  if (typeof tokenRefreshTimer.unref === 'function') tokenRefreshTimer.unref()
}

async function refreshAgentToken() {
  if (stopping || tokenRefreshRunning || !state.running || !state.identity) return
  if (!state.watching || !lastWebRtcOpts?.livekitToken) return
  if (!state.connected) {
    if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer)
    tokenRefreshTimer = setTimeout(() => {
      tokenRefreshTimer = null
      void refreshAgentToken()
    }, 30000)
    if (typeof tokenRefreshTimer.unref === 'function') tokenRefreshTimer.unref()
    return
  }
  tokenRefreshRunning = true
  try {
    send({ type: 'request_token_refresh', clientId: state.identity.clientId || '' })
    tokenRefreshAttempt += 1
    const backoff = Math.min(300000, 30000 * Math.pow(2, tokenRefreshAttempt - 1))
    const remaining = AGENT_TOKEN_TTL_MS - (Date.now() - (agentTokenIssuedAt || Date.now()))
    if (remaining < 300000) log('LiveKit agent token 即将过期，等待 server 刷新', { attempt: tokenRefreshAttempt, remainingMs: remaining })
    tokenRefreshTimer = setTimeout(() => {
      tokenRefreshTimer = null
      void refreshAgentToken()
    }, backoff)
    if (typeof tokenRefreshTimer.unref === 'function') tokenRefreshTimer.unref()
  } finally {
    tokenRefreshRunning = false
  }
}

function scheduleReconnect() {
  if (stopping || !state.running || reconnectTimer) return
  const base = Math.min(1000 * 2 ** reconnectAttempt, 60000)
  const delay = Math.round(base * (0.75 + Math.random() * 0.5))
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    if (stopping || !state.running) return
    void connect()
  }, delay)
  reconnectTimer.unref()
}

async function connect() {
  if (stopping || !state.running || !state.identity) return
  try {
    const headers = authHeaders(state.identity, 'WS_CONNECT', agentWsRequestPath(), Buffer.alloc(0))
    const wsTarget = wsUrl(state.baseUrl, state.identity.clientId)
    let wsHost = ''
    try { wsHost = new URL(wsTarget).hostname } catch { /* ignore */ }
    const ws = new WebSocket(wsTarget, {
      headers,
      handshakeTimeout: 10000,
      ...insecureTlsForService(wsHost),
    })
    socket = ws
    ws.on('open', () => {
      if (socket !== ws || stopping || !state.running) return
      state.connected = true; state.lastError = ''
      reconnectAttempt = 0; lastServerAt = Date.now()
      send({ type: 'hello', clientId: state.identity.clientId, account: state.account, version: VERSION, desktopWatching: state.watching, ...PROTOCOL })
      heartbeat()
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = setInterval(() => {
        if (socket !== ws || stopping || !state.running) return
        heartbeat()
      }, 20000); heartbeatTimer.unref()
      void syncWechatData()
      if (syncTimer) clearInterval(syncTimer)
      syncTimer = setInterval(() => {
        if (socket !== ws || stopping || !state.running) return
        void syncWechatData()
      }, 60000); syncTimer.unref()
      if (watchdogTimer) clearInterval(watchdogTimer)
      watchdogTimer = setInterval(() => {
        if (socket !== ws || stopping || !state.running) return
        if (ws.readyState === WebSocket.OPEN && Date.now() - lastServerAt > 50000) ws.terminate()
      }, 10000); watchdogTimer.unref()
      if (state.watching && DESKTOP_WEBRTC_ENABLED) {
        void startWebRtcFromMessage({
          ...(lastWebRtcOpts || {}),
          forceRestart: !isWebRtcMediaConnected(),
        })
        forceKey = true
      }
      if (state.watching && lastWebRtcOpts?.livekitToken) ensureTokenRefreshScheduled()
      log('链路已就绪', { clientId: state.identity.clientId })
    })
    ws.on('message', (raw) => {
      if (socket !== ws || stopping || !state.running) return
      agentMsgChain = agentMsgChain.then(() => handleMessage(raw)).catch(() => {})
    })
    ws.on('error', (error) => {
      if (socket !== ws) return
      state.lastError = String(error?.message || error)
    })
    ws.on('close', () => {
      if (socket !== ws) return
      state.connected = false
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (watchdogTimer) clearInterval(watchdogTimer)
      if (syncTimer) clearInterval(syncTimer)
      heartbeatTimer = null
      watchdogTimer = null
      syncTimer = null
      if (DESKTOP_WEBRTC_ENABLED && !state.watching) {
        try { stopWebRtcDesktop() } catch (_) {}
      }
      if (!stopping && state.running) scheduleReconnect()
    })
  } catch (error) {
    state.connected = false
    state.lastError = String(error?.message || error)
    if (!stopping && state.running) scheduleReconnect()
  }
}

async function startRemoteAgent(options = {}) {
  logger = options.onLog || logger
  callbacks = {
    onPolicy: options.onPolicy || callbacks.onPolicy,
    onAnnouncement: options.onAnnouncement || callbacks.onAnnouncement,
    getSyncSnapshot: options.getSyncSnapshot || callbacks.getSyncSnapshot,
    onFriendCredentialDiagnostic: options.onFriendCredentialDiagnostic || callbacks.onFriendCredentialDiagnostic,
    onCheckClientUpdate: options.onCheckClientUpdate || callbacks.onCheckClientUpdate,
  }
  if (options.account) state.account = String(options.account)
  if (options.baseUrl) state.baseUrl = rootUrl(options.baseUrl)
  // 运行中仅更新 baseUrl 不会重连；UI 不支持运行中改地址，避免 socket 仍连旧 host
  if (state.running) {
    if (state.connected) heartbeat()
    return getStatus()
  }
  stopping = false
  const identity = loadOrCreate(options.userDataDir)
  state = { running: true, connected: false, watching: false, identity, baseUrl: rootUrl(options.baseUrl || state.baseUrl || DEFAULT_BASE), account: String(options.account || state.account || '微信群控本机'), lastError: '' }
  try { await ensureRegistered(identity, state.baseUrl) } catch (error) { state.lastError = String(error?.message || error) }
  await connect()
  return getStatus()
}

function stopRemoteAgent() {
  stopping = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (watchdogTimer) clearInterval(watchdogTimer)
  if (syncTimer) clearInterval(syncTimer)
  resetTokenRefreshLifecycle()
  reconnectTimer = null; heartbeatTimer = null; watchdogTimer = null; syncTimer = null
  lastWebRtcOpts = null
  agentMsgChain = Promise.resolve()
  stopCapture(); stopWorker()
  try { socket?.close() } catch {}
  socket = null
  state.running = false; state.connected = false
}

function getStatus() { return { ok: !state.lastError, running: state.running, connected: state.connected, watching: state.watching, clientId: state.identity?.clientId || '', deviceId: state.identity?.deviceId || '', lastError: state.lastError } }
async function openAdminConsole(token = '', baseUrl = DEFAULT_BASE) {
  const url = new URL(`${rootUrl(baseUrl)}/`)
  url.hash = token ? `token=${encodeURIComponent(token)}` : getDesktopHashPath()
  await shell.openExternal(url.toString())
  return true
}

module.exports = { startRemoteAgent, stopRemoteAgent, getStatus, openAdminConsole, DEFAULT_BASE }
