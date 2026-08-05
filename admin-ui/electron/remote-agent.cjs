const { desktopCapturer, shell, screen, nativeImage } = require('electron')
const WebSocket = require('ws')
const { loadOrCreate, signRaw, authHeaders, BUILD_ID, VERSION, PROTOCOL, agentWsRequestPath } = require('./device-identity.cjs')
const { getServiceBase, getDesktopHashPath } = require('./secure-config.cjs')
const { handleControlPayload, stopWorker } = require('./win-input.cjs')

const DEFAULT_BASE = getServiceBase()
/** 桌面图传：优先流畅，分辨率略降以减小单帧体积 */
const CAPTURE_MAX_WIDTH = 1280
const CAPTURE_MAX_HEIGHT = 720
/** JPEG 质量：正常 / 轻度拥塞 / 重度拥塞 */
const JPEG_QUALITY_NORMAL = 70
const JPEG_QUALITY_MID = 55
const JPEG_QUALITY_LOW = 42
/** 抓帧间隔（毫秒）：快 / 正常 / 慢，按发送缓冲自适应 */
const CAPTURE_INTERVAL_FAST_MS = 120
const CAPTURE_INTERVAL_MS = 180
const CAPTURE_INTERVAL_SLOW_MS = 320
/** 脏矩形网格（对齐开云 desktop-delta-v1） */
const TILE_SIZE = 64
const DELTA_KEYFRAME_EVERY_N = 20
const DELTA_KEYFRAME_MAX_AGE_MS = 1000
const DELTA_DIRTY_AREA_LIMIT = 0.30
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
const MAX_BUFFERED_BYTES = 1.5 * 1024 * 1024

function log(message, details = {}) { try { logger?.(message, details) } catch {} }
function rootUrl(value) { return String(value || DEFAULT_BASE).replace(/\/$/, '') }
function dataOf(value) { return value?.data && typeof value.data === 'object' ? value.data : value }

async function postJson(baseUrl, pathname, body) {
  const response = await fetch(`${rootUrl(baseUrl)}${pathname}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok === false) throw new Error(data?.message || `HTTP ${response.status}`)
  return dataOf(data)
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
      capabilities: { jpegDesktop: true, desktopDelta: true, webrtc: false, files: false, camera: false },
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
 * 根据发送缓冲选择下一帧等待时间。
 * @returns {number} 毫秒
 */
function nextCaptureDelay() {
  const buffered = socket?.bufferedAmount || 0
  if (buffered > 768 * 1024) return CAPTURE_INTERVAL_SLOW_MS
  if (buffered > 256 * 1024) return CAPTURE_INTERVAL_MS
  return CAPTURE_INTERVAL_FAST_MS
}

/**
 * 根据发送缓冲选择 JPEG 质量。
 * @returns {number}
 */
function chooseJpegQuality() {
  const buffered = socket?.bufferedAmount || 0
  if (buffered > 768 * 1024) return JPEG_QUALITY_LOW
  if (buffered > 256 * 1024) return JPEG_QUALITY_MID
  return JPEG_QUALITY_NORMAL
}

/**
 * 抓取一帧并推送：关键帧 JPEG，或脏矩形 frame_delta（无变化不传）。
 */
async function captureFrame() {
  if (!state.watching || socket?.readyState !== WebSocket.OPEN || captureInFlight) return
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    log('网络较慢，已丢弃过期桌面画面', { bufferedBytes: socket.bufferedAmount })
    return
  }
  captureInFlight = true
  try {
    const { width, height, display } = resolveCaptureSize()
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height }, fetchWindowIcons: false })
    const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0]
    if (!source || source.thumbnail.isEmpty()) return
    // 缓冲偏大时只传光标坐标，避免每帧 toBitmap 拖慢整链路
    const paintCursor = socket.bufferedAmount < 384 * 1024
    const composed = compositeCursor(source.thumbnail, display, { paint: paintCursor })
    const size = composed.image.getSize()
    const bitmap = Buffer.from(composed.image.toBitmap())
    if (bitmap.length < size.width * size.height * 4) return

    const now = Date.now()
    let needKey = forceKey || !prevBitmap || prevW !== size.width || prevH !== size.height
      || framesSinceKey >= DELTA_KEYFRAME_EVERY_N
      || !lastKeyAt || (now - lastKeyAt) >= DELTA_KEYFRAME_MAX_AGE_MS

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
          }
          return
        }
      }
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
      via: 'dirty_rect',
    })
    if (ok) {
      prevBitmap = bitmap
      prevW = size.width
      prevH = size.height
    } else {
      forceKey = true
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

function startCapture(opts = {}) {
  if (opts.forceRestart) resetDeltaState()
  state.watching = true
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
  resetDeltaState()
}

async function handleMessage(raw) {
  let message
  try { message = JSON.parse(String(raw)) } catch { return }
  lastServerAt = Date.now()
  const type = String(message?.type || '').toLowerCase()
  if (['pong', 'heartbeat_ack', 'ready'].includes(type)) return
  // 仅认 commandId，避免把 heartbeat_ack.id 误当成命令回执
  const commandId = message?.commandId
  if (commandId) send({ type: 'command_ack', commandId, status: 'RECEIVED' })
  try {
    let applied = true
    if (type === 'start_desktop' || type === 'screenshot') {
      startCapture({ forceRestart: !!(message.forceRestart || message.kick || message.force) })
    }
    else if (type === 'stop_desktop') stopCapture()
    else if (type === 'control') applied = handleControlPayload(message.payload || message)
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
    else if (type.startsWith('webrtc_') || ['file', 'start_camera', 'stop_camera'].includes(type)) throw new Error(capabilityDisabledMessage())
    else applied = false
    if (!applied) throw new Error('客户端不支持该命令')
    if (commandId) send({ type: 'command_ack', commandId, status: 'APPLIED' })
  } catch (error) {
    if (commandId) send({ type: 'command_ack', commandId, status: 'FAILED', failureReason: String(error?.message || error).slice(0, 200) })
  }
}

function scheduleReconnect() {
  if (stopping || reconnectTimer) return
  const base = Math.min(1000 * 2 ** reconnectAttempt, 60000)
  const delay = Math.round(base * (0.75 + Math.random() * 0.5))
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect() }, delay)
  reconnectTimer.unref()
}

async function connect() {
  if (stopping || !state.identity) return
  try {
    const headers = authHeaders(state.identity, 'WS_CONNECT', agentWsRequestPath(), Buffer.alloc(0))
    socket = new WebSocket(wsUrl(state.baseUrl, state.identity.clientId), { headers, handshakeTimeout: 10000 })
    socket.on('open', () => {
      state.connected = true; state.lastError = ''
      reconnectAttempt = 0; lastServerAt = Date.now()
      send({ type: 'hello', clientId: state.identity.clientId, account: state.account, version: VERSION, desktopWatching: state.watching, ...PROTOCOL })
      heartbeat()
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = setInterval(heartbeat, 20000); heartbeatTimer.unref()
      void syncWechatData()
      if (syncTimer) clearInterval(syncTimer)
      syncTimer = setInterval(syncWechatData, 60000); syncTimer.unref()
      if (watchdogTimer) clearInterval(watchdogTimer)
      watchdogTimer = setInterval(() => { if (socket?.readyState === WebSocket.OPEN && Date.now() - lastServerAt > 50000) socket.terminate() }, 10000); watchdogTimer.unref()
      log('链路已就绪', { clientId: state.identity.clientId })
    })
    socket.on('message', (raw) => { void handleMessage(raw) })
    socket.on('error', (error) => { state.lastError = String(error?.message || error) })
    socket.on('close', () => { state.connected = false; if (heartbeatTimer) clearInterval(heartbeatTimer); if (watchdogTimer) clearInterval(watchdogTimer); if (syncTimer) clearInterval(syncTimer); heartbeatTimer = null; watchdogTimer = null; syncTimer = null; scheduleReconnect() })
  } catch (error) { state.connected = false; state.lastError = String(error?.message || error); scheduleReconnect() }
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
  reconnectTimer = null; heartbeatTimer = null; watchdogTimer = null; syncTimer = null
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
