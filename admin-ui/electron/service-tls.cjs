/**
 * TLS helpers for IP/self-signed service endpoint.
 * Chromium + Node https/ws all need an explicit trust path for non-public CA certs.
 *
 * 证书固定（Certificate Pinning）：
 * - SPKI SHA-256 pin（与部署脚本 openssl 输出一致）
 * - 支持双 pin 轮换
 * - 未配置 pin 且无 WXQK_ALLOW_UNPINNED_TLS=1 时 fail closed
 */
const {
  createHash,
  X509Certificate,
} = require('crypto')
const net = require('net')
const https = require('https')
const tls = require('tls')
const { getServiceBase, getAllowedHosts } = require('./secure-config.cjs')

/** @type {Map<string, string[]>} pin 格式：sha256/<base64 SPKI hash> */
const CERT_PINS = new Map()

/** @type {Set<string>} 测试或运行时额外信任 host */
const extraTrustedHosts = new Set()

/** @type {Map<string, https.Agent>} */
const pinnedAgentsByHost = new Map()

let pinEnforcementEnabled = false
let unpinnedCompatWarned = false

;(function loadEnvPins() {
  const raw = process.env.WXQK_TLS_SPKI_PINS || ''
  if (!raw.trim()) {
    try { console.warn('[TLS] TLS_PIN_NOT_CONFIGURED — 未配置 WXQK_TLS_SPKI_PINS') } catch (_) {}
    return
  }
  const pins = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (!pins.length) return
  const host = serviceHostname()
  if (host) {
    CERT_PINS.set(host, pins)
    pinEnforcementEnabled = true
    try { console.log(`[TLS] SPKI pin 已加载，host=${host}，pins=${pins.length}`) } catch (_) {}
  }
  for (const h of getAllowedHosts()) {
    if (!CERT_PINS.has(h)) CERT_PINS.set(h, pins)
  }
})()

function serviceHostname() {
  try {
    return new URL(getServiceBase()).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isTrustedServiceHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (!host) return false
  if (extraTrustedHosts.has(host)) return true
  if (host === serviceHostname()) return true
  return getAllowedHosts().has(host)
}

function hasConfiguredPins(hostname) {
  const host = String(hostname || '').toLowerCase()
  const pins = CERT_PINS.get(host)
  return Boolean(pins && pins.length)
}

function toX509Certificate(certData) {
  if (certData instanceof X509Certificate) return certData
  if (Buffer.isBuffer(certData)) return new X509Certificate(certData)
  if (typeof certData === 'string' && certData.trim()) return new X509Certificate(certData)
  throw new Error('TLS_CERT_DATA_INVALID')
}

/**
 * SPKI SHA-256 hash（base64），格式与部署脚本 openssl 输出一致。
 * @param {string|Buffer|X509Certificate} certData PEM / DER / X509Certificate
 * @returns {string}
 */
function computeSpkiHash(certData) {
  const x509 = toX509Certificate(certData)
  const spkiDer = x509.publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spkiDer).digest('base64')
}

/**
 * @param {X509Certificate} x509
 * @param {string} hostname
 * @returns {boolean}
 */
function certificateMatchesHost(x509, hostname) {
  const host = String(hostname || '').trim()
  if (!host) return false
  if (net.isIP(host)) return x509.checkIP(host)
  return x509.checkHost(host)
}

/**
 * 从 Electron / Node TLS 证书对象提取可解析的 cert 数据。
 * @param {any} cert
 * @returns {string|Buffer|X509Certificate|null}
 */
function normalizeCertInput(cert) {
  if (!cert) return null
  if (cert instanceof X509Certificate) return cert
  if (typeof cert === 'string' && cert.trim()) return cert
  if (Buffer.isBuffer(cert)) return cert
  if (typeof cert === 'object') {
    if (typeof cert.data === 'string' && cert.data.trim()) return cert.data
    if (Buffer.isBuffer(cert.data)) return cert.data
    if (Buffer.isBuffer(cert.raw)) return cert.raw
  }
  return null
}

/**
 * @param {string} hostname
 * @param {any} cert
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyCertPin(hostname, cert) {
  const host = String(hostname || '').toLowerCase()
  if (!isTrustedServiceHost(host)) return { ok: false, reason: 'HOST_NOT_TRUSTED' }

  const certData = normalizeCertInput(cert)
  if (!certData) return { ok: false, reason: 'TLS_CERT_DATA_INVALID' }

  let x509
  try {
    x509 = toX509Certificate(certData)
  } catch {
    return { ok: false, reason: 'TLS_CERT_DATA_INVALID' }
  }

  if (!certificateMatchesHost(x509, host)) {
    return { ok: false, reason: 'TLS_HOSTNAME_MISMATCH' }
  }

  const pins = CERT_PINS.get(host)
  if (!pins || !pins.length) {
    if (pinEnforcementEnabled) return { ok: false, reason: 'NO_PINS_CONFIGURED' }
    if (process.env.WXQK_ALLOW_UNPINNED_TLS === '1') return { ok: true }
    return { ok: false, reason: 'TLS_PIN_NOT_CONFIGURED' }
  }

  const spki = `sha256/${computeSpkiHash(x509)}`
  if (pins.includes(spki)) return { ok: true }
  return { ok: false, reason: 'TLS_CERT_PIN_MISMATCH' }
}

function setCertPins(hostname, pins) {
  const host = String(hostname || '').toLowerCase()
  if (!host) return
  const oldAgent = pinnedAgentsByHost.get(host)
  if (oldAgent) {
    try { oldAgent.destroy() } catch { /* ignore */ }
  }
  CERT_PINS.set(host, Array.isArray(pins) ? pins : [])
  pinnedAgentsByHost.delete(host)
  if (pins && pins.length) pinEnforcementEnabled = true
}

function setPinEnforcement(enabled) {
  pinEnforcementEnabled = Boolean(enabled)
}

function addTrustedHostForTests(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (host) extraTrustedHosts.add(host)
}

class PinnedHttpsAgent extends https.Agent {
  constructor(hostname, options = {}) {
    super({ keepAlive: true, ...options })
    this.pinnedHostname = String(hostname || '').toLowerCase()
  }

  createConnection(options, callback) {
    const expectedHostname = String(
      options.servername || options.host || this.pinnedHostname || '',
    ).toLowerCase()
    let settled = false
    const finish = (err, socket) => {
      if (settled) return
      settled = true
      callback(err, socket)
    }

    const connectOptions = {
      ...options,
      host: options.host || expectedHostname,
      port: options.port,
      rejectUnauthorized: false,
      servername: net.isIP(expectedHostname) ? undefined : expectedHostname,
    }

    const socket = tls.connect(connectOptions)

    socket.once('secureConnect', () => {
      try {
        let peerCert = null
        if (typeof socket.getPeerX509Certificate === 'function') {
          peerCert = socket.getPeerX509Certificate()
        } else {
          const legacy = socket.getPeerCertificate(true)
          if (legacy && legacy.raw) peerCert = legacy.raw
        }
        const pinResult = verifyCertPin(expectedHostname, peerCert)
        if (pinResult.ok) {
          finish(null, socket)
          return
        }
        socket.destroy()
        const err = new Error(pinResult.reason || 'TLS_PIN_REJECTED')
        err.code = pinResult.reason || 'TLS_PIN_REJECTED'
        finish(err)
      } catch (error) {
        socket.destroy()
        finish(error)
      }
    })

    socket.once('error', (err) => {
      if (!settled) finish(err)
    })

    return socket
  }
}

function getPinnedHttpsAgent(hostname) {
  const host = String(hostname || '').toLowerCase()
  let agent = pinnedAgentsByHost.get(host)
  if (!agent) {
    agent = new PinnedHttpsAgent(host)
    pinnedAgentsByHost.set(host, agent)
  }
  return agent
}

/** Options for Node https / ws when talking to our board. */
function insecureTlsForService(hostname) {
  if (!isTrustedServiceHost(hostname)) return {}
  if (hasConfiguredPins(hostname)) {
    return { agent: getPinnedHttpsAgent(hostname) }
  }
  if (process.env.WXQK_ALLOW_UNPINNED_TLS === '1') {
    if (!unpinnedCompatWarned) {
      unpinnedCompatWarned = true
      try { console.warn('[TLS] TLS_UNPINNED_COMPAT_MODE — WXQK_ALLOW_UNPINNED_TLS=1') } catch (_) {}
    }
    return { rejectUnauthorized: false }
  }
  const error = new Error('TLS_PIN_NOT_CONFIGURED')
  error.code = 'TLS_PIN_NOT_CONFIGURED'
  throw error
}

/**
 * Install Electron session hook so fetch/WebView accept the service cert.
 * @param {import('electron').Session} sess
 */
function installServiceCertificateTrust(sess) {
  if (!sess || typeof sess.setCertificateVerifyProc !== 'function') return
  if (sess._wxqkCertProcInstalled) return
  sess._wxqkCertProcInstalled = true
  sess.setCertificateVerifyProc((request, callback) => {
    try {
      const host = String(request.hostname || '').toLowerCase()
      if (!isTrustedServiceHost(host)) {
        callback(-3)
        return
      }
      const pins = CERT_PINS.get(host)
      if (pins && pins.length) {
        const pinResult = verifyCertPin(host, request.certificate)
        if (pinResult.ok) {
          callback(0)
          return
        }
        try {
          console.error('[TLS]', pinResult.reason || 'TLS_REJECTED', 'for', host)
        } catch (_) {}
        callback(-2)
        return
      }
      if (process.env.WXQK_ALLOW_UNPINNED_TLS === '1') {
        if (!unpinnedCompatWarned) {
          unpinnedCompatWarned = true
          try { console.warn('[TLS] TLS_UNPINNED_COMPAT_MODE — WXQK_ALLOW_UNPINNED_TLS=1') } catch (_) {}
        }
        callback(0)
        return
      }
      try { console.error('[TLS] TLS_PIN_NOT_CONFIGURED for', host) } catch (_) {}
      callback(-2)
    } catch {
      callback(-3)
    }
  })
}

function resetTlsStateForTests() {
  for (const agent of pinnedAgentsByHost.values()) {
    try { agent.destroy() } catch { /* ignore */ }
  }
  CERT_PINS.clear()
  pinnedAgentsByHost.clear()
  extraTrustedHosts.clear()
  pinEnforcementEnabled = false
  unpinnedCompatWarned = false
}

module.exports = {
  serviceHostname,
  isTrustedServiceHost,
  insecureTlsForService,
  installServiceCertificateTrust,
  verifyCertPin,
  computeSpkiHash,
  certificateMatchesHost,
  toX509Certificate,
  setCertPins,
  setPinEnforcement,
  getPinnedHttpsAgent,
  PinnedHttpsAgent,
  addTrustedHostForTests,
  resetTlsStateForTests,
  hasConfiguredPins,
}
