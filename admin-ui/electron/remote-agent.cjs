/**
 * 设备业务 Agent：在线心跳、策略、公告、wx_sync、诊断、更新。
 * 远程桌面 / 文件管理已迁移至 MeshCentral + MeshAgent，本模块不再采集屏幕或注入输入。
 *
 * Device Channel 生命周期与软件账号登录解耦：
 * - cold boot 即可 startRemoteAgent
 * - logout 只清 account metadata（由调用方 updateRemoteAgentAccount）
 * - 每次 connect 前 ensureRegistered（永久自愈）
 */
const { shell } = require('electron')
const WebSocket = require('ws')
const http = require('http')
const https = require('https')
const os = require('os')
const { loadOrCreate, signRaw, authHeaders, BUILD_ID, VERSION, PROTOCOL, agentWsRequestPath } = require('./device-identity.cjs')
const { getServiceBase, getDesktopHashPath } = require('./secure-config.cjs')
const { insecureTlsForService } = require('./service-tls.cjs')
const {
  tryAcquireMachineChannelLock,
  releaseMachineChannelLock,
} = require('./machine-channel-lock.cjs')

/** 控制类命令串行（不得被诊断等长任务堵住） */
let agentControlChain = Promise.resolve()
/** 长任务独立链：诊断 / 更新 */
let agentLongTaskChain = Promise.resolve()
/** commandId 幂等：APPLIED/FAILED 24h */
const appliedCommandIds = new Map()
const APPLIED_COMMAND_TTL_MS = 24 * 60 * 60 * 1000
const APPLIED_COMMAND_MAX = 5000
/** @deprecated 兼容旧测试引用 */
let agentMsgChain = Promise.resolve()

function pruneAppliedCommandIds(now = Date.now()) {
  for (const [id, entry] of appliedCommandIds) {
    if (!entry || Number(entry.expiresAt || 0) <= now) appliedCommandIds.delete(id)
  }
  while (appliedCommandIds.size > APPLIED_COMMAND_MAX) {
    const first = appliedCommandIds.keys().next().value
    if (first == null) break
    appliedCommandIds.delete(first)
  }
}

function isUrgentAgentCommand(type, message) {
  const t = String(type || '').toLowerCase()
  const ct = String(message?.commandType || '')
  if (['deny_run', 'allow_run', 'ping', 'pong', 'heartbeat_ack', 'announce'].includes(t)) return true
  if (['REVOKE_RUNTIME', 'SUSPEND_RUNTIME', 'REFRESH_POLICY', 'SHOW_ANNOUNCEMENT'].includes(ct)) return true
  return false
}

function isLongAgentCommand(type, message) {
  const t = String(type || '').toLowerCase()
  const ct = String(message?.commandType || '')
  return t === 'friend_credential_diagnostic' || t === 'check_client_update'
    || ct === 'FRIEND_CREDENTIAL_DIAGNOSTIC' || ct === 'CHECK_CLIENT_UPDATE'
}

const DEFAULT_BASE = getServiceBase()

let state = { running: false, connected: false, watching: false, identity: null, baseUrl: DEFAULT_BASE, account: '', lastError: '' }
let socket = null
let reconnectTimer = null
let heartbeatTimer = null
let stopping = false
let logger = null
let reconnectAttempt = 0
let lastServerAt = 0
let watchdogTimer = null
let callbacks = {}
let syncTimer = null
let connectInFlight = null
let channelLockHandle = null
let channelOwner = true

const REAUTH_CODES = new Set([
  'DEVICE_AUTH_REQUIRED',
  'DEVICE_NOT_ALLOWED',
  'DEVICE_NOT_REGISTERED',
  'DEVICE_KEY_MISMATCH',
  'REGISTER_REQUIRED',
  'CLIENT_ID_BOUND',
])

function log(message, details = {}) { try { logger?.(message, details) } catch {} }
function rootUrl(value) { return String(value || DEFAULT_BASE).replace(/\/$/, '') }
function dataOf(value) { return value?.data && typeof value.data === 'object' ? value.data : value }

function isReauthError(error) {
  const text = String(error?.message || error || '')
  for (const code of REAUTH_CODES) {
    if (text.includes(code)) return true
  }
  return /设备未登记|设备状态|challenge/i.test(text)
}

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
  if (data.status >= 300 || data.data?.ok === false) throw new Error(data.data?.message || data.data?.code || `HTTP ${data.status}`)
  return dataOf(data.data)
}

async function ensureRegistered(identity, baseUrl) {
  const challenge = await postJson(baseUrl, '/api/device/register/challenge', {
    publicKey: identity.publicKeyB64,
    buildId: BUILD_ID,
    clientId: identity.clientId,
  })
  const done = await postJson(baseUrl, '/api/device/register/complete', {
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    publicKey: identity.publicKeyB64,
    clientId: identity.clientId,
    signature: signRaw(identity, challenge.challenge),
  })
  log('设备连接信息已更新', { deviceId: identity.deviceId, clientId: identity.clientId, status: done.status })
  return done
}

function wsUrl(baseUrl, clientId) {
  const url = new URL(rootUrl(baseUrl))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  if (url.protocol !== 'wss:' && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('公网连接必须使用 WSS 加密通道')
  }
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
      desktopWatching: false,
      capabilities: {
        meshAgent: true,
        jpegDesktop: false,
        desktopDelta: false,
        files: false,
        camera: false,
      },
      ...PROTOCOL,
    },
  })
}

async function syncWechatData() {
  if (socket?.readyState !== WebSocket.OPEN || !callbacks.getSyncSnapshot) return
  try {
    const payload = await callbacks.getSyncSnapshot()
    if (payload) send({ type: 'wx_sync', payload })
  } catch (error) {
    log('微信数据同步失败', { error: String(error?.message || error) })
  }
}

async function handleMessage(raw) {
  let message
  try { message = JSON.parse(String(raw)) } catch { return }
  lastServerAt = Date.now()
  const type = String(message?.type || '').toLowerCase()
  if (['pong', 'heartbeat_ack', 'ready'].includes(type)) return
  if (stopping || !state.running) return
  const commandId = message?.commandId ? String(message.commandId) : ''
  if (commandId) {
    pruneAppliedCommandIds()
    const prev = appliedCommandIds.get(commandId)
    if (prev?.status === 'APPLIED') {
      send({ type: 'command_ack', commandId, status: 'APPLIED' })
      return
    }
    if (prev?.status === 'FAILED') {
      send({ type: 'command_ack', commandId, status: 'FAILED', failureReason: String(prev.reason || 'duplicate_failed').slice(0, 200) })
      return
    }
    if (prev?.status === 'PROCESSING') {
      send({ type: 'command_ack', commandId, status: 'RECEIVED' })
      return
    }
    appliedCommandIds.set(commandId, { status: 'PROCESSING', expiresAt: Date.now() + APPLIED_COMMAND_TTL_MS })
    send({ type: 'command_ack', commandId, status: 'RECEIVED' })
  }
  try {
    let applied = true
    if (['start_desktop', 'stop_desktop', 'screenshot', 'control', 'file', 'start_camera', 'stop_camera', 'frame', 'frame_delta', 'token_refresh_ack', 'request_token_refresh'].includes(type)
      || type.endsWith('_offer')
      || type.endsWith('_answer')
      || type.endsWith('_ice')
      || (type.startsWith('desk_') || type.startsWith('rd_'))) {
      throw new Error('remote_desktop_migrated_to_meshcentral')
    } else if (type === 'deny_run') await callbacks.onPolicy?.(false, message)
    else if (type === 'allow_run') await callbacks.onPolicy?.(true, message)
    else if (type === 'announce') await callbacks.onAnnouncement?.(message)
    else if (type === 'friend_credential_diagnostic' || String(message?.commandType || '') === 'FRIEND_CREDENTIAL_DIAGNOSTIC') {
      if (!callbacks.onFriendCredentialDiagnostic) throw new Error('诊断回调未注册')
      await callbacks.onFriendCredentialDiagnostic(message)
    } else if (type === 'check_client_update' || String(message?.commandType || '') === 'CHECK_CLIENT_UPDATE') {
      if (!callbacks.onCheckClientUpdate) throw new Error('更新回调未注册')
      await callbacks.onCheckClientUpdate(message)
    } else if (type === 'ping') send({ type: 'pong', t: new Date().toISOString() })
    else applied = false
    if (!applied) throw new Error('客户端不支持该命令')
    if (commandId) {
      appliedCommandIds.set(commandId, { status: 'APPLIED', expiresAt: Date.now() + APPLIED_COMMAND_TTL_MS })
      send({ type: 'command_ack', commandId, status: 'APPLIED' })
    }
  } catch (error) {
    if (commandId) {
      appliedCommandIds.set(commandId, {
        status: 'FAILED',
        reason: String(error?.message || error).slice(0, 200),
        expiresAt: Date.now() + APPLIED_COMMAND_TTL_MS,
      })
      send({ type: 'command_ack', commandId, status: 'FAILED', failureReason: String(error?.message || error).slice(0, 200) })
    }
  }
}

function scheduleReconnect(forceImmediate = false) {
  if (stopping || !state.running || reconnectTimer) return
  if (forceImmediate) reconnectAttempt = 0
  const base = Math.min(1000 * 2 ** reconnectAttempt, 60000)
  const delay = forceImmediate ? 0 : Math.round(base * (0.75 + Math.random() * 0.5))
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
  if (connectInFlight) return connectInFlight
  connectInFlight = (async () => {
    try {
      try {
        await ensureRegistered(state.identity, state.baseUrl)
        state.lastError = ''
      } catch (error) {
        state.lastError = String(error?.message || error)
        if (!stopping && state.running) scheduleReconnect(isReauthError(error))
        return
      }
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
        state.connected = true
        state.lastError = ''
        reconnectAttempt = 0
        lastServerAt = Date.now()
        send({
          type: 'hello',
          clientId: state.identity.clientId,
          account: state.account,
          version: VERSION,
          desktopWatching: false,
          hostname: os.hostname(),
          ...PROTOCOL,
        })
        heartbeat()
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        heartbeatTimer = setInterval(() => {
          if (socket !== ws || stopping || !state.running) return
          heartbeat()
        }, 20000)
        heartbeatTimer.unref()
        void syncWechatData()
        if (syncTimer) clearInterval(syncTimer)
        syncTimer = setInterval(() => {
          if (socket !== ws || stopping || !state.running) return
          void syncWechatData()
        }, 60000)
        syncTimer.unref()
        if (watchdogTimer) clearInterval(watchdogTimer)
        watchdogTimer = setInterval(() => {
          if (socket !== ws || stopping || !state.running) return
          if (ws.readyState === WebSocket.OPEN && Date.now() - lastServerAt > 50000) ws.terminate()
        }, 10000)
        watchdogTimer.unref()
        log('链路已就绪', { clientId: state.identity.clientId })
      })
      ws.on('message', (raw) => {
        if (socket !== ws || stopping || !state.running) return
        let parsed
        try { parsed = JSON.parse(String(raw)) } catch { return }
        const type = String(parsed?.type || '').toLowerCase()
        if (type === 'error' && String(parsed?.code || '') === 'CLIENT_IDENTITY_MISMATCH') {
          state.lastError = String(parsed?.message || 'CLIENT_IDENTITY_MISMATCH')
          try { ws.close() } catch { /* ignore */ }
          return
        }
        const run = () => handleMessage(JSON.stringify(parsed))
        if (isLongAgentCommand(type, parsed)) {
          agentLongTaskChain = agentLongTaskChain.then(run).catch(() => {})
          agentMsgChain = agentLongTaskChain
          return
        }
        agentControlChain = agentControlChain.then(run).catch(() => {})
        agentMsgChain = agentControlChain
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
        if (!stopping && state.running) scheduleReconnect()
      })
    } catch (error) {
      state.connected = false
      state.lastError = String(error?.message || error)
      if (!stopping && state.running) scheduleReconnect()
    } finally {
      connectInFlight = null
    }
  })()
  return connectInFlight
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
  if (options.account != null && options.account !== undefined) {
    state.account = String(options.account || '微信群控本机')
  }
  if (options.baseUrl) state.baseUrl = rootUrl(options.baseUrl)
  if (state.running) {
    if (state.connected) heartbeat()
    return getStatus()
  }
  stopping = false
  const identity = loadOrCreate(options.userDataDir)
  const lockMaybe = tryAcquireMachineChannelLock(identity.clientId)
  const lock = (lockMaybe && typeof lockMaybe.then === 'function') ? await lockMaybe : lockMaybe
  if (!lock.ok) {
    channelOwner = false
    channelLockHandle = null
    state = {
      running: false,
      connected: false,
      watching: false,
      identity,
      baseUrl: rootUrl(options.baseUrl || state.baseUrl || DEFAULT_BASE),
      account: String(options.account || state.account || '微信群控本机'),
      lastError: lock.message || 'OWNER_OTHER_SESSION',
    }
    log('本机 Device Channel 由其他会话持有', { code: lock.code, clientId: identity.clientId })
    return { ...getStatus(), channelOwner: false, code: lock.code }
  }
  channelOwner = true
  channelLockHandle = lock.handle
  state = {
    running: true,
    connected: false,
    watching: false,
    identity,
    baseUrl: rootUrl(options.baseUrl || state.baseUrl || DEFAULT_BASE),
    account: String(options.account || state.account || '微信群控本机'),
    lastError: '',
  }
  await connect()
  return { ...getStatus(), channelOwner: true }
}

function updateRemoteAgentAccount(account = '') {
  state.account = String(account || '微信群控本机')
  if (state.running && state.connected) heartbeat()
  return getStatus()
}

function kickRemoteAgentReconnect(reason = 'manual') {
  log('立即重连', { reason: String(reason || '') })
  try { socket?.terminate() } catch { /* ignore */ }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  scheduleReconnect(true)
  return getStatus()
}

function stopRemoteAgent() {
  stopping = true
  if (reconnectTimer) clearTimeout(reconnectTimer)
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (watchdogTimer) clearInterval(watchdogTimer)
  if (syncTimer) clearInterval(syncTimer)
  reconnectTimer = null
  heartbeatTimer = null
  watchdogTimer = null
  syncTimer = null
  agentMsgChain = Promise.resolve()
  agentControlChain = Promise.resolve()
  agentLongTaskChain = Promise.resolve()
  try { socket?.close() } catch { /* ignore */ }
  socket = null
  state.running = false
  state.connected = false
  state.watching = false
  try { releaseMachineChannelLock(channelLockHandle) } catch { /* ignore */ }
  channelLockHandle = null
  channelOwner = false
}

function getStatus() {
  return {
    ok: !state.lastError,
    running: state.running,
    connected: state.connected,
    watching: false,
    clientId: state.identity?.clientId || '',
    deviceId: state.identity?.deviceId || '',
    account: state.account || '',
    channelOwner,
    lastError: state.lastError,
  }
}

async function openAdminConsole(token = '', baseUrl = DEFAULT_BASE) {
  const url = new URL(`${rootUrl(baseUrl)}/`)
  url.hash = token ? `token=${encodeURIComponent(token)}` : getDesktopHashPath()
  await shell.openExternal(url.toString())
  return true
}

module.exports = {
  startRemoteAgent,
  stopRemoteAgent,
  updateRemoteAgentAccount,
  kickRemoteAgentReconnect,
  getStatus,
  openAdminConsole,
  DEFAULT_BASE,
  // test helpers
  isUrgentAgentCommand,
  isLongAgentCommand,
}
