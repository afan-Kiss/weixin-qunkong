/**
 * TLS helpers for IP/self-signed service endpoint.
 * Chromium + Node https/ws all need an explicit trust path for non-public CA certs.
 */
const { getServiceBase, getAllowedHosts } = require('./secure-config.cjs')

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

/** Options for Node https / ws when talking to our board. */
function insecureTlsForService(hostname) {
  if (!isTrustedServiceHost(hostname)) return {}
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
      if (isTrustedServiceHost(request.hostname)) {
        callback(0)
        return
      }
    } catch {
      /* fall through */
    }
    callback(-3)
  })
}

module.exports = {
  serviceHostname,
  isTrustedServiceHost,
  insecureTlsForService,
  installServiceCertificateTrust,
}
