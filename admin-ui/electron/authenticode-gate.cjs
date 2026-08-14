'use strict'

/**
 * Production Authenticode signing gate.
 * Does not forge certificates. Without a configured signing identity:
 * AUTHENTICODE_GATE=BLOCKED_EXTERNAL
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/**
 * @param {{ exePath?: string, requireSign?: boolean, signToolPath?: string, certificateThumbprint?: string }} opts
 * @returns {{ gate: string, ok: boolean, code: string, message?: string }}
 */
function evaluateAuthenticodeGate(opts = {}) {
  const requireSign = Boolean(opts.requireSign)
    || process.env.WXQK_REQUIRE_AUTHENTICODE === '1'
    || String(process.env.WXQK_RELEASE_CHANNEL || '').toLowerCase() === 'production'
  const thumb = String(opts.certificateThumbprint || process.env.WXQK_AUTHENTICODE_THUMBPRINT || '').trim()
  const signTool = String(opts.signToolPath || process.env.WXQK_SIGNTOOL_PATH || '').trim()
  const exePath = String(opts.exePath || '').trim()

  if (!requireSign) {
    return { gate: 'AUTHENTICODE_GATE', ok: true, code: 'SKIPPED_NON_PRODUCTION', message: 'signing not required for this build' }
  }
  if (!thumb && !process.env.WXQK_AZURE_TRUSTED_SIGNING_ENDPOINT) {
    return {
      gate: 'AUTHENTICODE_GATE',
      ok: false,
      code: 'BLOCKED_EXTERNAL',
      message: 'production signing requires WXQK_AUTHENTICODE_THUMBPRINT or Azure Trusted Signing config',
    }
  }
  if (exePath && fs.existsSync(exePath) && signTool && fs.existsSync(signTool)) {
    const args = ['sign', '/fd', 'SHA256', '/sha1', thumb, '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256', exePath]
    const r = spawnSync(signTool, args, { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) {
      return {
        gate: 'AUTHENTICODE_GATE',
        ok: false,
        code: 'SIGN_FAILED',
        message: String(r.stderr || r.stdout || 'signtool failed').slice(0, 300),
      }
    }
    return { gate: 'AUTHENTICODE_GATE', ok: true, code: 'SIGNED', message: path.basename(exePath) }
  }
  if (thumb || process.env.WXQK_AZURE_TRUSTED_SIGNING_ENDPOINT) {
    return {
      gate: 'AUTHENTICODE_GATE',
      ok: true,
      code: 'IDENTITY_CONFIGURED',
      message: 'signing identity configured; invoke during package:win',
    }
  }
  return {
    gate: 'AUTHENTICODE_GATE',
    ok: false,
    code: 'BLOCKED_EXTERNAL',
    message: 'no Authenticode identity',
  }
}

module.exports = {
  evaluateAuthenticodeGate,
}
