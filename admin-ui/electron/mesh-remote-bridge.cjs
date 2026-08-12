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

/** Wait for Mesh node registration / bind after Agent start */
const PREPARE_RETRY_DELAYS_MS = [0, 1500, 2500, 4000, 6000, 10000, 15000, 20000, 30000]

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
    console.log(`[MESH] ${message}${safe ? ` ${safe}` : ''}`)
  } catch {
    console.log(`[MESH] ${message}`)
  }
}

function safeClientId(value) {
  return meshAgent.safeClientIdForAgent(value)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))
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

function userMessageForCode(code, fallback) {
  const c = String(code || '')
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
  if (c === 'MESH_NO_MATCH' || c === 'MESH_UNBOUND' || c === 'MESH_BIND_REQUEST_FAILED' || c === 'MESH_NODE_ID_MISSING') {
    return '设备绑定失败'
  }
  if (c === 'MESH_AGENT_OFFLINE' || c === 'MESH_NODE_TIMEOUT') {
    return 'MeshAgent 无法连接服务器'
  }
  if (c === 'BAD_CLIENT_ID' || c === 'BAD_REQUEST') {
    return '远程服务准备失败'
  }
  return String(fallback || '远程服务准备失败')
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

async function requestAutoBind(clientId, hostname) {
  const body = {
    clientId,
    agentName: meshAgent.buildAgentName(clientId),
    allowHostnameFallback: true,
  }
  if (hostname) body.hostname = hostname
  const res = await requestMeshJson('POST', '/api/mesh/auto-bind', body)
  return {
    httpStatus: res.status,
    ...(res.data && typeof res.data === 'object' ? res.data : {}),
  }
}

async function requestMeshStatus(clientId) {
  const res = await requestMeshJson('GET', `/api/mesh/status?clientId=${encodeURIComponent(clientId)}`)
  return {
    httpStatus: res.status,
    ...(res.data && typeof res.data === 'object' ? res.data : {}),
  }
}

function isBindSuccess(result) {
  if (!result || typeof result !== 'object') return false
  if (result.ok === false) return false
  if (result.code === 'MESH_DISABLED') return false
  if (result.bound === true) return true
  if (result.code === 'OK' && (result.meshNodeId || result.mapping?.mesh_node_id)) return true
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
  return setPrepareState({
    phase: PHASE.READY,
    remoteReady: true,
    clientId,
    agentName: agentName || meshAgent.buildAgentName(clientId),
    meshNodeId,
    meshGroupId,
    code: 'OK',
    message: '远程服务已就绪',
    userMessage: '远程服务已就绪',
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

/**
 * Unified Mesh prepare state machine (idempotent, single-flight).
 * Does not block Electron UI — callers must fire-and-forget or await without gating window show.
 * @param {string} clientId
 * @param {{ force?: boolean }} [opts]
 */
async function ensureMeshReady(clientId, opts = {}) {
  const cid = safeClientId(clientId)
  if (!cid) {
    return finishFailed('', 'BAD_CLIENT_ID', '缺少设备标识')
  }

  if (
    !opts.force
    && prepareState.remoteReady
    && prepareState.clientId === cid
    && prepareState.meshNodeId
  ) {
    return getMeshPrepareStatus()
  }

  if (inflightPrepare && inflightClientId === cid) {
    return inflightPrepare
  }

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
      message: '正在准备远程服务…',
      userMessage: '正在准备远程服务…',
    })

    try {
      try {
        const st = await requestMeshStatus(cid)
        if (isBindSuccess(st) && String(st.mapping?.mesh_node_id || st.meshNodeId || '').trim()) {
          log('bind ok', { via: 'existing-mapping', clientId: redactClientId(cid) })
          return finishReady(cid, agentName, st)
        }
      } catch {
        /* continue prepare */
      }

      setPrepareState({
        phase: PHASE.STARTING,
        message: '正在启动远程服务…',
        userMessage: '正在启动远程服务…',
      })
      const ensured = await meshAgent.ensureMeshAgentRunning({ clientId: cid })
      if (!ensured?.ok) {
        return finishFailed(cid, ensured?.code || 'MESH_START_FAILED', ensured?.message || 'MeshAgent 启动失败')
      }
      log('agent running', { action: ensured.action, clientId: redactClientId(cid) })

      setPrepareState({
        phase: PHASE.WAITING_NODE,
        message: '正在等待客户端上线…',
        userMessage: '正在等待客户端上线…',
      })
      log('waiting node', { clientId: redactClientId(cid) })

      let lastBind = null
      let repairedOnce = false
      for (let i = 0; i < PREPARE_RETRY_DELAYS_MS.length; i += 1) {
        const waitMs = PREPARE_RETRY_DELAYS_MS[i]
        if (waitMs > 0) await sleep(waitMs)

        setPrepareState({
          phase: PHASE.BINDING,
          message: '正在绑定远程设备…',
          userMessage: '正在绑定远程设备…',
        })

        try {
          lastBind = await requestAutoBind(cid, hostname)
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
        if (!repairedOnce && (code === 'MESH_NO_MATCH' || code === 'MESH_NODE_TIMEOUT') && i >= 0) {
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
 * Wait for an in-flight prepare (or start one).
 * @param {string} clientId
 * @param {number} [timeoutMs]
 */
async function waitForMeshReady(clientId, timeoutMs = 90000) {
  const cid = safeClientId(clientId)
  if (!cid) return finishFailed('', 'BAD_CLIENT_ID', '缺少设备标识')
  const started = Date.now()
  const prep = ensureMeshReady(cid)
  const timeout = new Promise((resolve) => {
    const left = Math.max(1000, Number(timeoutMs) || 90000)
    setTimeout(() => {
      resolve(finishFailed(cid, 'MESH_NODE_TIMEOUT', '等待远程服务就绪超时'))
    }, left).unref?.()
  })
  const result = await Promise.race([prep, timeout])
  if (result?.remoteReady) return result
  if (Date.now() - started < (Number(timeoutMs) || 90000)) {
    return ensureMeshReady(cid, { force: true })
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
  safeClientId,
  PREPARE_RETRY_DELAYS_MS,
  AUTO_BIND_RETRY_DELAYS_MS: PREPARE_RETRY_DELAYS_MS,
  PHASE,
  isBindSuccess,
  shouldStopBindRetry,
  userMessageForCode,
}
