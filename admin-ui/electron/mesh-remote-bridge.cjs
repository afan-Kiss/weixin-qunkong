/**
 * Silent MeshAgent bridge (main process only).
 * Product UI must not expose remote desktop/files; admin console owns viewing.
 *
 * Unified prepare flow: ensureMeshReady(clientId)
 * — single-flight, idempotent, non-blocking for UI.
 */
'use strict'

const os = require('os')
const http = require('http')
const https = require('https')
const { getServiceBase } = require('./secure-config.cjs')
const { insecureTlsForService } = require('./service-tls.cjs')
const softwareAuth = require('./software-auth.cjs')
const meshAgent = require('./mesh-agent-manager.cjs')

/**
 * Retry gaps inside a single prepare deadline.
 * Sum of delays is intentionally well under DEFAULT_PREPARE_TIMEOUT_MS so
 * network timeouts + sleeps cannot outrun the outer deadline.
 */
const PREPARE_RETRY_DELAYS_MS = [0, 1200, 2000, 3000, 4500, 6000, 8000, 10000]
const DEFAULT_PREPARE_TIMEOUT_MS = 90000
/** Fast-path TTL: only reuse READY after recent live validation */
const READY_FAST_PATH_TTL_MS = 8000
const REQUEST_TIMEOUT_CAP_MS = 8000

const PHASE = {
  IDLE: 'idle',
  CHECKING: 'checking',
  INSTALLING: 'installing',
  STARTING: 'starting',
  WAITING_NODE: 'waiting_node',
  BINDING: 'binding',
  READY: 'ready',
  FAILED: 'failed',
}

/** @type {Promise<any> | null} */
let inflightPrepare = null
/** @type {string} */
let inflightClientId = ''

/** Latest prepare snapshot for UI / diagnostics (no secrets). */
let prepareState = {
  phase: PHASE.IDLE,
  remoteReady: false,
  clientId: '',
  agentName: '',
  meshNodeId: '',
  meshGroupId: '',
  code: '',
  message: '',
  userMessage: '',
  updatedAt: 0,
  liveValidatedAt: 0,
}

function log(message, details) {
  try {
    const safe = details
      ? JSON.stringify(details)
        .replace(/login=[^&\s"']+/gi, 'login=***')
        .replace(/auth=[^&\s"']+/gi, 'auth=***')
        .replace(/"embedUrl"\s*:\s*"[^"]*"/gi, '"embedUrl":"***"')
        .replace(/MeshID=[^"&\s]+/gi, 'MeshID=***')
        .replace(/ServerID=[^"&\s]+/gi, 'ServerID=***')
      : ''
    const suffix = safe ? ` ${safe}` : ''
    console.log(`[MESH] ${message}${suffix}`)
    console.log(`[MESH-BOOT] ${message}${suffix}`)
  } catch {
    console.log(`[MESH] ${message}`)
    console.log(`[MESH-BOOT] ${message}`)
  }
}

function safeClientId(value) {
  return meshAgent.safeClientIdForAgent(value)
}

function sleep(ms, deadlineMs) {
  const want = Math.max(0, Number(ms) || 0)
  if (!deadlineMs) return new Promise((resolve) => setTimeout(resolve, want))
  const left = Math.max(0, deadlineMs - Date.now())
  const actual = Math.min(want, left)
  if (actual <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, actual))
}

function remainingMs(deadlineMs) {
  return Math.max(0, Number(deadlineMs || 0) - Date.now())
}

function redactClientId(clientId) {
  const id = String(clientId || '')
  if (id.length <= 8) return id ? '***' : ''
  return `${id.slice(0, 4)}…${id.slice(-4)}`
}

function setPrepareState(patch) {
  prepareState = {
    ...prepareState,
    ...patch,
    updatedAt: Date.now(),
  }
  return prepareState
}

function getMeshPrepareStatus() {
  return { ...prepareState }
}

function resetMeshPrepareStateForTest() {
  inflightPrepare = null
  inflightClientId = ''
  prepareState = {
    phase: PHASE.IDLE,
    remoteReady: false,
    clientId: '',
    agentName: '',
    meshNodeId: '',
    meshGroupId: '',
    code: '',
    message: '',
    userMessage: '',
    updatedAt: 0,
    liveValidatedAt: 0,
  }
}

function userMessageForCode(code, fallback) {
  const c = String(code || '')
  if (c === 'MESH_ELEVATION_REQUIRED') {
    return '需要管理员权限以修复远程服务'
  }
  if (c === 'MESH_STALE_SERVICE' || c === 'MESH_BAD_ARTIFACT' || c === 'MESH_BAD_ARTIFACT_NAME') {
    return '远程服务安装损坏，正在尝试修复…'
  }
  if (c === 'MESH_AGENT_FILES_MISSING' || c === 'MESH_INSTALL_FAILED' || c === 'MSH_IDENTITY_INCOMPLETE') {
    return '远程服务安装失败'
  }
  if (c === 'MESH_START_FAILED' || c === 'MESH_REPAIR_FAILED') {
    return '远程服务无法启动'
  }
  if (c === 'MESH_DISABLED' || c === 'MESH_UNAVAILABLE' || c === 'MESH_WS_UNAVAILABLE' || c === 'MESH_SYNC_FAILED' || c === 'MESH_WS_ERROR') {
    return 'MeshCentral 不可用'
  }
  if (c === 'MESH_AMBIGUOUS' || c === 'MESH_HOSTNAME_AMBIGUOUS') {
    return '发现重复设备'
  }
  if (c === 'MESH_NO_MATCH' || c === 'MESH_UNBOUND' || c === 'MESH_BIND_REQUEST_FAILED' || c === 'MESH_NODE_ID_MISSING' || c === 'MESH_NODE_MISSING') {
    return '设备绑定失败'
  }
  if (c === 'MESH_AGENT_OFFLINE' || c === 'MESH_NODE_TIMEOUT') {
    return '正在等待客户端远程服务上线…'
  }
  if (c === 'BAD_CLIENT_ID' || c === 'BAD_REQUEST') {
    return '远程服务准备失败'
  }
  return String(fallback || '远程服务准备失败')
}

async function requestMeshJson(method, pathname, body, deadlineMs) {
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

  const left = deadlineMs ? remainingMs(deadlineMs) : REQUEST_TIMEOUT_CAP_MS
  if (deadlineMs && left < 200) {
    throw new Error('deadline_exceeded')
  }
  const timeoutMs = Math.max(500, Math.min(REQUEST_TIMEOUT_CAP_MS, left || REQUEST_TIMEOUT_CAP_MS))

  return new Promise((resolve, reject) => {
    const req = lib.request(target, {
      method,
      headers,
      timeout: timeoutMs,
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

async function requestAutoBind(clientId, hostname, deadlineMs) {
  const body = {
    clientId,
    agentName: meshAgent.buildAgentName(clientId),
    allowHostnameFallback: true,
  }
  if (hostname) body.hostname = hostname
  const res = await requestMeshJson('POST', '/api/mesh/auto-bind', body, deadlineMs)
  return {
    httpStatus: res.status,
    ...(res.data && typeof res.data === 'object' ? res.data : {}),
  }
}

async function requestMeshStatus(clientId, deadlineMs) {
  const res = await requestMeshJson('GET', `/api/mesh/status?clientId=${encodeURIComponent(clientId)}`, null, deadlineMs)
  return {
    httpStatus: res.status,
    ...(res.data && typeof res.data === 'object' ? res.data : {}),
  }
}

/**
 * Live-ready only. Mapping / bound alone is NOT success (prevents false ready).
 */
function isBindSuccess(result) {
  if (!result || typeof result !== 'object') return false
  if (result.ok === false) return false
  if (result.code === 'MESH_DISABLED') return false
  if (result.ready === false || result.online === false) return false
  if (result.remoteState && result.remoteState !== 'ready' && result.ready !== true) return false
  if (result.ready === true || result.online === true || result.remoteState === 'ready') {
    return !!(result.meshNodeId || result.mapping?.mesh_node_id)
  }
  return false
}

function shouldStopBindRetry(result) {
  const code = String(result?.code || '')
  return (
    code === 'MESH_DISABLED'
    || code === 'BAD_REQUEST'
    || code === 'UNAUTHORIZED'
    || code === 'FORBIDDEN'
    || code === 'MESH_AMBIGUOUS'
    || code === 'MESH_HOSTNAME_AMBIGUOUS'
  )
}

function mappingFromBind(result) {
  const nodeId = String(result?.meshNodeId || result?.mapping?.mesh_node_id || '').trim()
  const groupId = String(result?.mapping?.mesh_group_id || result?.meshGroupId || '').trim()
  return { meshNodeId: nodeId, meshGroupId: groupId }
}

function finishReady(clientId, agentName, bind) {
  const { meshNodeId, meshGroupId } = mappingFromBind(bind || {})
  log('ready', { clientId: redactClientId(clientId), meshNodeId: meshNodeId ? `${meshNodeId.slice(0, 6)}…` : undefined })
  const now = Date.now()
  return setPrepareState({
    phase: PHASE.READY,
    remoteReady: true,
    clientId,
    agentName: agentName || meshAgent.buildAgentName(clientId),
    meshNodeId,
    meshGroupId,
    code: 'OK',
    message: '服务已就绪',
    userMessage: '服务已就绪',
    liveValidatedAt: now,
  })
}

function finishFailed(clientId, code, message) {
  const userMessage = userMessageForCode(code, message)
  log('prepare failed', { clientId: redactClientId(clientId), code, message })
  return setPrepareState({
    phase: PHASE.FAILED,
    remoteReady: false,
    clientId,
    code: String(code || 'MESH_PREPARE_FAILED'),
    message: String(message || userMessage),
    userMessage,
  })
}

function canUseReadyFastPath(cid) {
  if (!prepareState.remoteReady) return false
  if (prepareState.clientId !== cid) return false
  if (!prepareState.meshNodeId) return false
  const validatedAt = Number(prepareState.liveValidatedAt || prepareState.updatedAt || 0)
  if (!validatedAt) return false
  return (Date.now() - validatedAt) < READY_FAST_PATH_TTL_MS
}

/**
 * Unified Mesh prepare state machine (idempotent, single-flight).
 * Does not block Electron UI — callers must fire-and-forget or await without gating window show.
 * @param {string} clientId
 * @param {{ force?: boolean, deadlineMs?: number, timeoutMs?: number }} [opts]
 */
async function ensureMeshReady(clientId, opts = {}) {
  const cid = safeClientId(clientId)
  if (!cid) {
    return finishFailed('', 'BAD_CLIENT_ID', '缺少设备标识')
  }

  if (!opts.force && canUseReadyFastPath(cid)) {
    return getMeshPrepareStatus()
  }

  if (inflightPrepare && inflightClientId === cid) {
    return inflightPrepare
  }

  const deadlineMs = Number(opts.deadlineMs)
    || (Date.now() + Math.max(5000, Number(opts.timeoutMs) || DEFAULT_PREPARE_TIMEOUT_MS))

  inflightClientId = cid
  inflightPrepare = (async () => {
    const hostname = String(os.hostname() || '').trim()
    const agentName = meshAgent.buildAgentName(cid)
    log('prepare start', { clientId: redactClientId(cid), agentName })
    setPrepareState({
      phase: PHASE.CHECKING,
      remoteReady: false,
      clientId: cid,
      agentName,
      meshNodeId: '',
      meshGroupId: '',
      code: '',
      message: '正在准备服务…',
      userMessage: '正在准备服务…',
      liveValidatedAt: 0,
    })

    try {
      // Always confirm local MeshAgent before trusting any server-side mapping.
      setPrepareState({
        phase: PHASE.STARTING,
        message: '正在准备服务…',
        userMessage: '正在准备服务…',
      })
      if (remainingMs(deadlineMs) < 1000) {
        return finishFailed(cid, 'MESH_NODE_TIMEOUT', '等待服务就绪超时')
      }
      const ensured = await meshAgent.ensureMeshAgentRunning({ clientId: cid })
      if (!ensured?.ok) {
        return finishFailed(cid, ensured?.code || 'MESH_START_FAILED', ensured?.message || '服务启动失败')
      }
      log('agent running', { action: ensured.action, clientId: redactClientId(cid) })
      log('service_running', { action: ensured.action, status: ensured?.status?.status })

      // Optional quick status check after agent is confirmed running.
      try {
        if (remainingMs(deadlineMs) > 1500) {
          const st = await requestMeshStatus(cid, deadlineMs)
          if (isBindSuccess(st)) {
            log('bind ok', { via: 'live-status', clientId: redactClientId(cid) })
            return finishReady(cid, agentName, st)
          }
        }
      } catch {
        /* continue prepare */
      }

      setPrepareState({
        phase: PHASE.WAITING_NODE,
        message: '正在等待客户端上线…',
        userMessage: '正在等待客户端上线…',
      })
      log('waiting node', { clientId: redactClientId(cid) })

      let lastBind = null
      let repairedOnce = false
      for (let i = 0; i < PREPARE_RETRY_DELAYS_MS.length; i += 1) {
        if (remainingMs(deadlineMs) < 800) break
        const waitMs = PREPARE_RETRY_DELAYS_MS[i]
        if (waitMs > 0) await sleep(waitMs, deadlineMs)
        if (remainingMs(deadlineMs) < 800) break

        setPrepareState({
          phase: PHASE.BINDING,
          message: '正在绑定远程设备…',
          userMessage: '正在绑定远程设备…',
        })

        try {
          lastBind = await requestAutoBind(cid, hostname, deadlineMs)
        } catch (err) {
          lastBind = { ok: false, code: 'MESH_BIND_REQUEST_FAILED', message: String(err?.message || err) }
        }

        if (isBindSuccess(lastBind)) {
          log('node discovered', { attempt: i + 1 })
          log('bind ok', { clientId: redactClientId(cid) })
          return finishReady(cid, agentName, lastBind)
        }

        if (shouldStopBindRetry(lastBind)) {
          return finishFailed(cid, lastBind.code, lastBind.message)
        }

        // 旧安装可能没有 agentName=WXQK-<clientId>：中途修复重装一次再继续等节点
        const code = String(lastBind?.code || '')
        if (
          !repairedOnce
          && (code === 'MESH_NO_MATCH' || code === 'MESH_NODE_TIMEOUT' || code === 'MESH_NODE_MISSING' || code === 'MESH_AGENT_OFFLINE')
          && remainingMs(deadlineMs) > 5000
        ) {
          repairedOnce = true
          setPrepareState({
            phase: PHASE.INSTALLING,
            message: '正在修复远程服务…',
            userMessage: '正在修复远程服务…',
          })
          log('repair agent for agentName', { clientId: redactClientId(cid) })
          try {
            await meshAgent.repairMeshAgent({ clientId: cid })
          } catch (err) {
            log('repair failed', { message: String(err?.message || err) })
          }
          setPrepareState({
            phase: PHASE.WAITING_NODE,
            message: '正在等待客户端上线…',
            userMessage: '正在等待客户端上线…',
          })
        }
      }

      return finishFailed(
        cid,
        lastBind?.code || 'MESH_NODE_TIMEOUT',
        lastBind?.message || '等待远程设备上线超时',
      )
    } catch (err) {
      return finishFailed(cid, 'MESH_PREPARE_FAILED', String(err?.message || err))
    } finally {
      inflightPrepare = null
      inflightClientId = ''
    }
  })()

  return inflightPrepare
}

/**
 * Wait for an in-flight prepare (or start one) under a single deadline.
 * @param {string} clientId
 * @param {number} [timeoutMs]
 */
async function waitForMeshReady(clientId, timeoutMs = DEFAULT_PREPARE_TIMEOUT_MS) {
  const cid = safeClientId(clientId)
  if (!cid) return finishFailed('', 'BAD_CLIENT_ID', '缺少设备标识')
  const deadlineMs = Date.now() + Math.max(5000, Number(timeoutMs) || DEFAULT_PREPARE_TIMEOUT_MS)
  const prep = ensureMeshReady(cid, { deadlineMs, timeoutMs })
  const timeout = new Promise((resolve) => {
    const left = Math.max(1000, remainingMs(deadlineMs))
    setTimeout(() => {
      resolve(finishFailed(cid, 'MESH_NODE_TIMEOUT', '等待远程服务就绪超时'))
    }, left).unref?.()
  })
  const result = await Promise.race([prep, timeout])
  if (result?.remoteReady) return result
  // Do not spawn a second concurrent prepare after timeout — single-flight already covers force.
  if (remainingMs(deadlineMs) > 2000 && (!inflightPrepare || inflightClientId !== cid)) {
    return ensureMeshReady(cid, { force: true, deadlineMs })
  }
  return result
}

/** @deprecated use ensureMeshReady */
async function ensureLocalMeshAgent(clientId) {
  return ensureMeshReady(clientId)
}

module.exports = {
  ensureMeshReady,
  ensureLocalMeshAgent,
  waitForMeshReady,
  getMeshPrepareStatus,
  resetMeshPrepareStateForTest,
  safeClientId,
  PREPARE_RETRY_DELAYS_MS,
  DEFAULT_PREPARE_TIMEOUT_MS,
  READY_FAST_PATH_TTL_MS,
  AUTO_BIND_RETRY_DELAYS_MS: PREPARE_RETRY_DELAYS_MS,
  PHASE,
  isBindSuccess,
  shouldStopBindRetry,
  userMessageForCode,
}
