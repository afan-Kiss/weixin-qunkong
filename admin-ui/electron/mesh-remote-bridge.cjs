/**
 * MeshCentral remote session bridge (main process only).
 * Login tokens / embed URLs never enter the Vue renderer.
 * Renderer may only pass clientId — never nodeId.
 */
'use strict'

const { BrowserWindow, session } = require('electron')
const http = require('http')
const https = require('https')
const { getServiceBase } = require('./secure-config.cjs')
const { insecureTlsForService } = require('./service-tls.cjs')
const softwareAuth = require('./software-auth.cjs')
const meshAgent = require('./mesh-agent-manager.cjs')

let sessionWindow = null
/** @type {Electron.Session | null} */
let sessionPartition = null
/** @type {(() => (Electron.BrowserWindow | null)) | null} */
let parentWindowGetter = null

function setParentWindowGetter(fn) {
  parentWindowGetter = typeof fn === 'function' ? fn : null
}

function log(message, details) {
  try {
    const safe = details
      ? JSON.stringify(details)
        .replace(/login=[^&\s"']+/gi, 'login=***')
        .replace(/auth=[^&\s"']+/gi, 'auth=***')
        .replace(/"embedUrl"\s*:\s*"[^"]*"/gi, '"embedUrl":"***"')
      : ''
    console.log(`[MESH] ${message}${safe ? ` ${safe}` : ''}`)
  } catch {
    console.log(`[MESH] ${message}`)
  }
}

function safeClientId(value) {
  const id = String(value || '').trim()
  if (!id || id.length > 128 || !/^[A-Za-z0-9._:@-]+$/.test(id)) return ''
  return id
}

async function requestMeshJson(method, pathname, body) {
  const base = String(getServiceBase() || '').replace(/\/$/, '')
  const target = `${base}${pathname}`
  const u = new URL(target)
  const lib = u.protocol === 'https:' ? https : http
  const token = softwareAuth.getToken ? softwareAuth.getToken() : ''
  const payload = body != null ? JSON.stringify(body) : ''
  const headers = {
    Accept: 'application/json',
    ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  return new Promise((resolve, reject) => {
    const req = lib.request(target, {
      method,
      headers,
      timeout: 20000,
      ...insecureTlsForService(u.hostname),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        let data = {}
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { data = {} }
        resolve({ status: res.statusCode || 0, data })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

async function wipeSessionPartition() {
  const ses = sessionPartition
  sessionPartition = null
  if (!ses) return
  try { await ses.clearStorageData() } catch { /* ignore */ }
  try { await ses.clearCache() } catch { /* ignore */ }
  try { await ses.clearAuthCache() } catch { /* ignore */ }
}

async function closeSessionWindow() {
  if (sessionWindow && !sessionWindow.isDestroyed()) {
    try { sessionWindow.destroy() } catch { /* ignore */ }
  }
  sessionWindow = null
  await wipeSessionPartition()
  log('session closed')
  return { ok: true }
}

/**
 * Open MeshCentral embed URL in a dedicated BrowserWindow (not system browser).
 * webSecurity stays enabled. Temporary partition — no persist: cookies.
 */
function openEmbedWindow(embedUrl, title) {
  const url = String(embedUrl || '').trim()
  if (!url || !/^https?:\/\//i.test(url)) {
    return { ok: false, code: 'BAD_EMBED_URL', message: '无效的远控嵌入地址' }
  }
  // Never accept nodeId from renderer; URL must come from wxqk server only.
  if (/[?&]node=/i.test(url) === false || /[?&]login=/i.test(url) === false) {
    return { ok: false, code: 'BAD_EMBED_URL', message: '嵌入地址缺少必要参数' }
  }

  void closeSessionWindow()

  const partitionName = `temp:mesh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  sessionPartition = session.fromPartition(partitionName)

  const parent = parentWindowGetter ? parentWindowGetter() : null
  const opts = {
    width: 1280,
    height: 800,
    title: title || '远程维护',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: partitionName,
    },
  }
  if (parent && !parent.isDestroyed()) {
    opts.parent = parent
  }

  sessionWindow = new BrowserWindow(opts)
  sessionWindow.setMenuBarVisibility(false)
  sessionWindow.on('closed', () => {
    sessionWindow = null
    void wipeSessionPartition()
  })
  sessionWindow.once('ready-to-show', () => {
    try { sessionWindow.show() } catch { /* ignore */ }
  })
  sessionWindow.loadURL(url).catch((err) => {
    log('embed load failed', { error: String(err?.message || err) })
  })
  log('embed window opened', { title: title || '远程维护', partition: 'temp' })
  return { ok: true }
}

function mapStatusCode(server, localStatus) {
  if (server?.code) return String(server.code)
  if (localStatus === 'missing') return 'AGENT_MISSING'
  if (localStatus === 'broken') return 'AGENT_BROKEN'
  if (localStatus === 'stopped' || localStatus === 'installed_no_service') return 'AGENT_STOPPED'
  if (localStatus === 'pending') return 'AGENT_STARTING'
  return 'OK'
}

async function getRemoteStatus(clientId) {
  const cid = safeClientId(clientId)
  if (!cid) return { ok: false, code: 'BAD_REQUEST', message: 'clientId 无效' }
  const local = await meshAgent.getMeshAgentStatus()
  let server = null
  try {
    const res = await requestMeshJson('GET', `/api/mesh/status?clientId=${encodeURIComponent(cid)}`)
    server = res.data
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        code: res.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED',
        message: String(server?.message || '无权查看该设备'),
        clientId: cid,
        localAgent: {
          installed: local.status !== 'missing',
          running: local.status === 'running',
          status: local.status,
          version: String(local.version || ''),
        },
      }
    }
  } catch (err) {
    server = { ok: false, code: 'MESH_UNREACHABLE', message: String(err?.message || err) }
  }
  const localStatus = String(local.status || '')
  return {
    ok: Boolean(server?.ok ?? true) && server?.code !== 'MESH_UNREACHABLE' && server?.code !== 'MESH_DISABLED',
    code: mapStatusCode(server, localStatus),
    message: String(server?.message || ''),
    clientId: cid,
    bound: Boolean(server?.bound),
    meshNodeId: String(server?.meshNodeId || server?.mapping?.mesh_node_id || ''),
    meshAgentStatus: String(localStatus || server?.mapping?.mesh_agent_status || ''),
    meshLastSeen: String(server?.mapping?.mesh_last_seen || ''),
    version: String(local.version || ''),
    localAgent: {
      installed: localStatus !== 'missing',
      running: localStatus === 'running',
      status: localStatus,
      version: String(local.version || ''),
    },
    mapping: server?.mapping || null,
  }
}

async function openDesktopSession(clientId) {
  const cid = safeClientId(clientId)
  if (!cid) return { ok: false, code: 'BAD_REQUEST', message: 'clientId 无效' }
  const res = await requestMeshJson('POST', '/api/mesh/session/desktop', { clientId: cid })
  const data = res.data || {}
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: res.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED', message: data.message || '无权操作该设备' }
  }
  if (!data.ok || !data.embedUrl) {
    return { ok: false, code: data.code || 'MESH_SESSION_ERROR', message: data.message || '无法创建远程桌面会话' }
  }
  return openEmbedWindow(data.embedUrl, `远程桌面 · ${cid.slice(0, 12)}`)
}

async function openFilesSession(clientId) {
  const cid = safeClientId(clientId)
  if (!cid) return { ok: false, code: 'BAD_REQUEST', message: 'clientId 无效' }
  const res = await requestMeshJson('POST', '/api/mesh/session/files', { clientId: cid })
  const data = res.data || {}
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: res.status === 403 ? 'FORBIDDEN' : 'UNAUTHORIZED', message: data.message || '无权操作该设备' }
  }
  if (!data.ok || !data.embedUrl) {
    return { ok: false, code: data.code || 'MESH_SESSION_ERROR', message: data.message || '无法创建文件管理会话' }
  }
  return openEmbedWindow(data.embedUrl, `文件管理 · ${cid.slice(0, 12)}`)
}

async function ensureLocalMeshAgent(clientId) {
  const cid = safeClientId(clientId) || String(clientId || '').trim()
  try {
    const ensured = await meshAgent.ensureMeshAgentRunning({ clientId: cid })
    // Best-effort auto-bind after agent is up (server matches node name/tag to clientId)
    if (cid && ensured?.ok) {
      try {
        await requestMeshJson('POST', '/api/mesh/auto-bind', { clientId: cid })
      } catch {
        /* Mesh disabled / unbound — non-fatal */
      }
    }
    return ensured
  } catch (err) {
    log('ensure agent failed', { error: String(err?.message || err) })
    return { ok: false, status: 'error', message: String(err?.message || err) }
  }
}

module.exports = {
  getRemoteStatus,
  openDesktopSession,
  openFilesSession,
  closeSessionWindow,
  ensureLocalMeshAgent,
  safeClientId,
  setParentWindowGetter,
}
