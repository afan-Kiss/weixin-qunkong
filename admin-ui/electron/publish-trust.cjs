'use strict'

/**
 * Trusted publish signer key ring.
 * Trust root is local only — never use server-returned publicKey for verification.
 *
 * Transition:
 * - OLD (facai888-v1): verifies releases while seq <= maxTrustedReleaseSequence (if set)
 * - NEW (wxqk-v2): verifies releases with signingKeyId=wxqk-v2
 *
 * After transition release ships, set WXQK_OLD_SIGNER_MAX_SEQ to that sequence so
 * a compromised OLD private key cannot sign future sequences.
 */

const { getPublishPublicKeyB64, getPublishPublicKeyV2B64 } = require('./secure-config.cjs')

const OLD_KEY_ID = 'facai888-v1'
const NEW_KEY_ID = 'wxqk-v2'

/** @type {{ keyId: string, publicKeyB64: string, maxTrustedReleaseSequence: number | null, minTrustedReleaseSequence: number | null }[] | null} */
let overrideRing = null

function parseOptionalInt(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}

function getTrustedPublishKeyRing() {
  if (overrideRing) return overrideRing.map((r) => ({ ...r }))
  const oldMax = parseOptionalInt(process.env.WXQK_OLD_SIGNER_MAX_SEQ)
  const newMin = parseOptionalInt(process.env.WXQK_NEW_SIGNER_MIN_SEQ)
  return [
    {
      keyId: OLD_KEY_ID,
      publicKeyB64: getPublishPublicKeyB64(),
      maxTrustedReleaseSequence: oldMax,
      minTrustedReleaseSequence: null,
    },
    {
      keyId: NEW_KEY_ID,
      publicKeyB64: getPublishPublicKeyV2B64(),
      maxTrustedReleaseSequence: null,
      minTrustedReleaseSequence: newMin,
    },
  ]
}

/**
 * Resolve local trusted public key for a manifest. Ignores any server-supplied key.
 * @param {Record<string, unknown>} man
 * @returns {{ ok: boolean, keyId?: string, publicKeyB64?: string, code?: string, message?: string }}
 */
function resolveTrustedPublishKey(man) {
  const keyId = String(man?.signingKeyId || OLD_KEY_ID).trim() || OLD_KEY_ID
  const seq = Number(man?.releaseSequence || 0) || 0
  const ring = getTrustedPublishKeyRing()
  const entry = ring.find((r) => r.keyId === keyId)
  if (!entry || !entry.publicKeyB64) {
    return { ok: false, code: 'UNKNOWN_SIGNING_KEY_ID', message: `unknown signingKeyId: ${keyId}` }
  }
  if (entry.maxTrustedReleaseSequence != null && seq > Number(entry.maxTrustedReleaseSequence)) {
    return {
      ok: false,
      code: 'OLD_SIGNER_RETIRED',
      message: `signer ${keyId} retired above sequence ${entry.maxTrustedReleaseSequence}`,
    }
  }
  if (entry.minTrustedReleaseSequence != null && seq > 0 && seq < Number(entry.minTrustedReleaseSequence)) {
    return {
      ok: false,
      code: 'SIGNER_SEQ_TOO_LOW',
      message: `signer ${keyId} not trusted below sequence ${entry.minTrustedReleaseSequence}`,
    }
  }
  return { ok: true, keyId, publicKeyB64: entry.publicKeyB64 }
}

function setTrustedPublishKeyRingForTest(ring) {
  overrideRing = Array.isArray(ring) ? ring.map((r) => ({ ...r })) : null
}

function resetTrustedPublishKeyRingForTest() {
  overrideRing = null
}

module.exports = {
  OLD_KEY_ID,
  NEW_KEY_ID,
  getTrustedPublishKeyRing,
  resolveTrustedPublishKey,
  setTrustedPublishKeyRingForTest,
  resetTrustedPublishKeyRingForTest,
}
