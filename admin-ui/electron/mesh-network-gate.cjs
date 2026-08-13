'use strict'

/**
 * Agent network gate — TCP reachability of Mesh Agent endpoint from WXQK.msh.
 * NETWORK_BLOCKED must NEVER trigger Agent reinstall.
 */

const net = require('net')
const fs = require('fs')
const path = require('path')

/**
 * @param {string} mshText
 * @returns {{ host: string, port: number, meshServer: string } | null}
 */
function parseAgentEndpointFromMsh(mshText) {
  const m = String(mshText || '').match(/^MeshServer=(.+)$/im)
  if (!m) return null
  const raw = String(m[1] || '').trim()
  if (!raw) return null
  try {
    // wss://host:4433/agent.ashx or ws://
    const u = new URL(raw.replace(/^wss:/i, 'https:').replace(/^ws:/i, 'http:'))
    const host = u.hostname
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    if (!host || !port) return null
    return { host, port, meshServer: raw }
  } catch {
    return null
  }
}

/**
 * @param {string} mshPath
 */
function readAgentEndpointFromMshFile(mshPath) {
  try {
    if (!fs.existsSync(mshPath)) return null
    return parseAgentEndpointFromMsh(fs.readFileSync(mshPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, code: string, message: string, ms: number }>}
 */
function probeTcp(host, port, timeoutMs = 5000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let settled = false
    const done = (ok, code, message) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ ok, code, message, ms: Date.now() - started })
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true, 'TCP_PASS', 'tcp connected'))
    socket.once('timeout', () => done(false, 'TCP_TIMEOUT', 'tcp timeout'))
    socket.once('error', (err) => done(false, 'TCP_FAIL', String(err && err.message || err)))
    try {
      socket.connect(port, host)
    } catch (err) {
      done(false, 'TCP_FAIL', String(err && err.message || err))
    }
  })
}

/**
 * @param {{ mshPath?: string, timeoutMs?: number }} [opts]
 */
async function checkAgentNetworkGate(opts = {}) {
  const mshPath = opts.mshPath
    || path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WXQK', 'WXQK.msh')
  const endpoint = readAgentEndpointFromMshFile(mshPath)
  if (!endpoint) {
    return {
      ok: false,
      code: 'ENDPOINT_UNKNOWN',
      message: '无法从 WXQK.msh 解析 Agent 地址',
      endpoint: null,
      tcp: null,
    }
  }
  const tcp = await probeTcp(endpoint.host, endpoint.port, opts.timeoutMs || 5000)
  return {
    ok: tcp.ok,
    code: tcp.ok ? 'NETWORK_PASS' : 'NETWORK_BLOCKED',
    message: tcp.ok ? 'Agent 端口可达' : 'Agent 端口不可达（可能被防火墙拦截）',
    endpoint,
    tcp,
  }
}

module.exports = {
  parseAgentEndpointFromMsh,
  readAgentEndpointFromMshFile,
  probeTcp,
  checkAgentNetworkGate,
}
