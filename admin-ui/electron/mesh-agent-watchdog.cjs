'use strict'

/**
 * LOCAL_AGENT_WATCHDOG — periodic local health for WXQK Windows Service.
 * Never reinstalls on NETWORK_BLOCKED. Elevation prompts are rate-limited.
 */

const meshAgent = require('./mesh-agent-manager.cjs')
const networkGate = require('./mesh-network-gate.cjs')

const DEFAULT_INTERVAL_MS = 45000
const ELEVATION_BACKOFF_MS = 30 * 60 * 1000

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null
/** @type {Promise<any> | null} */
let tickInflight = null
let lastElevationDeniedAt = 0
let elevationDeniedThisSession = false
let lastNetworkBlocked = false
/** @type {((msg: string, extra?: object) => void) | null} */
let logger = null
/** @type {(() => string) | null} */
let resolveClientId = null
/** @type {((clientId: string) => Promise<any>) | null} */
let onNetworkRecovered = null

function log(level, message, extra) {
  if (typeof logger === 'function') {
    logger(`[MESH-WATCHDOG] ${level} ${message}`, extra || {})
    return
  }
  const line = `[MESH-WATCHDOG] ${level} ${message}`
  if (level === 'ERROR') console.error(line, extra || '')
  else if (level === 'WARN') console.warn(line, extra || '')
  else console.log(line, extra || '')
}

function canElevate() {
  if (elevationDeniedThisSession) {
    const since = Date.now() - lastElevationDeniedAt
    if (since < ELEVATION_BACKOFF_MS) return false
  }
  return true
}

function noteElevationDenied() {
  elevationDeniedThisSession = true
  lastElevationDeniedAt = Date.now()
}

/**
 * Build layered local readiness snapshot (no secrets).
 * @param {object} status getMeshAgentStatus()
 * @param {object} [net] network gate result
 */
function buildLocalGates(status, net) {
  const identityOk = true // caller already has clientId when watchdog runs prepare
  const artifactOk = Boolean(status?.packagedExePresent && status?.packagedMshPresent)
  const serviceOk = Boolean(
    status?.servicePresent
    && status?.imagePathOk
    && (status?.startMode === '' || /auto/i.test(String(status.startMode || ''))),
  )
  const processOk = status?.status === 'running' && Number(status?.processId || 0) >= 0
  const networkOk = net ? Boolean(net.ok) : null
  return {
    IDENTITY: identityOk ? 'PASS' : 'FAIL',
    ARTIFACT: artifactOk ? 'PASS' : 'FAIL',
    SERVICE: serviceOk ? 'PASS' : (status?.status === 'service_config_broken' ? 'FAIL' : 'WAIT'),
    PROCESS: processOk ? 'PASS' : 'FAIL',
    NETWORK: networkOk == null ? 'WAIT' : (networkOk ? 'PASS' : 'FAIL'),
    LOCAL_AGENT_READY: Boolean(
      artifactOk && serviceOk && processOk && status?.status === 'running' && !status?.outdatedAgent,
    ),
    NETWORK_BLOCKED: Boolean(net && !net.ok),
  }
}

async function tick() {
  if (tickInflight) return tickInflight
  tickInflight = (async () => {
    try {
      const status = await meshAgent.getMeshAgentStatus()
      const clientId = typeof resolveClientId === 'function' ? String(resolveClientId() || '').trim() : ''

      if (status.status === 'running' && !status.outdatedAgent) {
        const mshPath = status.paths?.installedMshPath
        const net = await networkGate.checkAgentNetworkGate({ mshPath, timeoutMs: 4000 })
        const gates = buildLocalGates(status, net)
        if (!net.ok) {
          if (!lastNetworkBlocked) {
            log('WARN', 'NETWORK_BLOCKED — not reinstalling', {
              host: net.endpoint?.host,
              port: net.endpoint?.port,
              code: net.code,
            })
          }
          lastNetworkBlocked = true
          return { action: 'noop_network', gates, status, net }
        }
        if (lastNetworkBlocked) {
          lastNetworkBlocked = false
          log('INFO', 'network recovered — rebind', { clientId: clientId ? clientId.slice(0, 8) : '' })
          if (clientId && typeof onNetworkRecovered === 'function') {
            try { await onNetworkRecovered(clientId) } catch (err) {
              log('WARN', 'rebind after network recover failed', { error: String(err?.message || err) })
            }
          }
        }
        return { action: 'noop', gates, status, net }
      }

      // Needs local heal
      if (!canElevate() && ['missing', 'stale_service', 'outdated_agent', 'service_config_broken', 'broken'].includes(status.status)) {
        log('WARN', 'skip repair — elevation backoff', { status: status.status })
        return { action: 'skip_elevation_backoff', status, gates: buildLocalGates(status) }
      }

      if (!clientId) {
        log('WARN', 'skip heal — no clientId')
        return { action: 'skip_no_client', status }
      }

      log('INFO', 'heal tick', { status: status.status })
      const ensured = await meshAgent.ensureMeshAgentRunning({ clientId })
      if (ensured?.code === 'MESH_ELEVATION_REQUIRED') {
        noteElevationDenied()
      }
      return { action: ensured?.action || 'heal', ensured, status: ensured?.status || status }
    } catch (err) {
      log('ERROR', 'tick failed', { error: String(err?.message || err) })
      return { action: 'error', error: String(err?.message || err) }
    } finally {
      tickInflight = null
    }
  })()
  return tickInflight
}

/**
 * @param {{
 *   intervalMs?: number,
 *   resolveClientId?: () => string,
 *   onNetworkRecovered?: (clientId: string) => Promise<any>,
 *   log?: (msg: string, extra?: object) => void,
 * }} [opts]
 */
function startLocalAgentWatchdog(opts = {}) {
  stopLocalAgentWatchdog()
  resolveClientId = opts.resolveClientId || null
  onNetworkRecovered = opts.onNetworkRecovered || null
  logger = opts.log || null
  elevationDeniedThisSession = false
  lastElevationDeniedAt = 0
  lastNetworkBlocked = false
  const intervalMs = Math.max(15000, Number(opts.intervalMs) || DEFAULT_INTERVAL_MS)
  timer = setInterval(() => { void tick() }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  // First check soon after start (avoid racing cold-boot prepare)
  setTimeout(() => { void tick() }, 8000).unref?.()
  log('INFO', 'started', { intervalMs })
  return { ok: true, intervalMs }
}

function stopLocalAgentWatchdog() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** Immediate health check (e.g. powerMonitor resume). */
function kickLocalAgentWatchdog(reason = 'kick') {
  log('INFO', 'kick', { reason })
  return tick()
}

function resetElevationBackoffForTest() {
  elevationDeniedThisSession = false
  lastElevationDeniedAt = 0
}

module.exports = {
  startLocalAgentWatchdog,
  stopLocalAgentWatchdog,
  kickLocalAgentWatchdog,
  buildLocalGates,
  tick,
  resetElevationBackoffForTest,
  DEFAULT_INTERVAL_MS,
  ELEVATION_BACKOFF_MS,
}
