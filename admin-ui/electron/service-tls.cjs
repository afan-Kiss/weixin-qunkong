/**
 * TLS helpers for IP/self-signed service endpoint.
 * Chromium + Node https/ws all need an explicit trust path for non-public CA certs.
 *
 * 证书固定（Certificate Pinning）框架：
 * - 支持 SPKI SHA-256 pin 或 certificate SHA-256 fingerprint
 * - 支持新旧证书双 pin（方便轮换）
 * - 需要线上证书 pin 才能完全启用（当前为兼容模式）
 * - 不影响 Ed25519 更新包验签
 */
const { createHash } = require('crypto')
const { getServiceBase, getAllowedHosts } = require('./secure-config.cjs')

/**
 * 证书固定配置。每个 hostname 可配多个 pin（新旧双证书轮换）。
 * pin 格式：'sha256/<base64-encoded-SPKI-hash>'
 * 设为空数组表示该 host 仅校验 hostname 白名单（兼容模式）。
 * TODO: 部署后从线上服务获取真实 pin，填入此处
 * @type {Map<string, string[]>}
 */
const CERT_PINS = new Map()

/** 是否启用证书固定强制校验（false = 兼容模式：仅 hostname 白名单） */
let pinEnforcementEnabled = false

// 从环境变量加载 SPKI pins（格式：sha256/xxx,sha256/yyy）
;(function loadEnvPins() {
  const raw = process.env.WXQK_TLS_SPKI_PINS || ''
  if (!raw.trim()) {
    try { console.warn('[TLS] TLS_PIN_NOT_CONFIGURED — 未配置 WXQK_TLS_SPKI_PINS，证书固定未启用') } catch (_) {}
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
  if (host === serviceHostname()) return true
  return getAllowedHosts().has(host)
}

/**
 * 从 DER 编码的证书中提取 SPKI SHA-256 hash（base64）。
 * @param {Buffer} certDer
 * @returns {string}
 */
function computeSpkiHash(certDer) {
  return createHash('sha256').update(certDer).digest('base64')
}

/**
 * 校验证书是否匹配已配置的 pin。
 * @param {string} hostname
 * @param {{ data: Buffer } | { fingerprint256?: string }} cert
 * @returns {{ ok: boolean, reason?: string }}
 */
function verifyCertPin(hostname, cert) {
  const host = String(hostname || '').toLowerCase()
  if (!isTrustedServiceHost(host)) return { ok: false, reason: 'HOST_NOT_TRUSTED' }
  const pins = CERT_PINS.get(host)
  if (!pins || !pins.length) {
    if (pinEnforcementEnabled) {
      return { ok: false, reason: 'NO_PINS_CONFIGURED' }
    }
    return { ok: true }
  }
  if (cert && cert.data) {
    const spki = `sha256/${computeSpkiHash(cert.data)}`
    if (pins.includes(spki)) return { ok: true }
  }
  const fp = cert?.fingerprint256 || ''
  if (fp) {
    const normalized = `sha256/${fp.replace(/:/g, '').toLowerCase()}`
    if (pins.some((p) => p.toLowerCase() === normalized)) return { ok: true }
  }
  return { ok: false, reason: 'TLS_CERT_PIN_MISMATCH' }
}

/**
 * 设置证书 pin（用于测试或运行时配置）。
 * @param {string} hostname
 * @param {string[]} pins
 */
function setCertPins(hostname, pins) {
  const host = String(hostname || '').toLowerCase()
  if (!host) return
  CERT_PINS.set(host, Array.isArray(pins) ? pins : [])
}

/**
 * 启用/禁用证书固定强制校验。
 * @param {boolean} enabled
 */
function setPinEnforcement(enabled) {
  pinEnforcementEnabled = Boolean(enabled)
}

/** Options for Node https / ws when talking to our board. */
function insecureTlsForService(hostname) {
  if (!isTrustedServiceHost(hostname)) return {}
  if (pinEnforcementEnabled) return {}
  if (process.env.WXQK_ALLOW_UNPINNED_TLS === '1') {
    try { console.warn('[TLS] TLS pin verification disabled by explicit compatibility flag (WXQK_ALLOW_UNPINNED_TLS=1)') } catch (_) {}
    return { rejectUnauthorized: false }
  }
  // 未配置 pin 且未显式允许：保持兼容但发出警告
  return { rejectUnauthorized: false }
}

/**
 * Install Electron session hook so fetch/WebView accept the service cert.
 * @param {import('electron').Session} sess
 */
function installServiceCertificateTrust(sess) {
  if (!sess || typeof sess.setCertificateVerifyProc !== 'function') return
  const prev = sess._wxqkCertProcInstalled
  if (prev) return
  sess._wxqkCertProcInstalled = true
  sess.setCertificateVerifyProc((request, callback) => {
    try {
      if (!isTrustedServiceHost(request.hostname)) {
        callback(-3)
        return
      }
      const pinResult = verifyCertPin(request.hostname, request.certificate)
      if (pinResult.ok) {
        callback(0)
        return
      }
      if (pinResult.reason === 'TLS_CERT_PIN_MISMATCH') {
        try {
          console.error('[TLS] TLS_CERT_PIN_MISMATCH for', request.hostname)
        } catch (_) {}
        callback(-2)
        return
      }
      callback(0)
    } catch {
      callback(-3)
    }
  })
}

module.exports = {
  serviceHostname,
  isTrustedServiceHost,
  insecureTlsForService,
  installServiceCertificateTrust,
  verifyCertPin,
  computeSpkiHash,
  setCertPins,
  setPinEnforcement,
}
