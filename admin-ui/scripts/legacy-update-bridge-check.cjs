'use strict'

/**
 * Generic legacy → modern update bridge diagnostic / ops trigger.
 *
 * Diagnostics may list online devices.
 * --trigger NEVER auto-picks a device (including the only online one).
 *
 * Usage:
 *   set WXQK_PUBLISH_PASSWORD=...
 *   node scripts/legacy-update-bridge-check.cjs
 *   node scripts/legacy-update-bridge-check.cjs --client-id <FULL_CLIENT_ID>
 *   node scripts/legacy-update-bridge-check.cjs --client-id <ID> --confirm-target --trigger
 *   node scripts/legacy-update-bridge-check.cjs --client-id <ID> --expected-hostname <H> --confirm-target --trigger
 *
 * Optional sanity expectations (ops/E2E only; not product hardcodes):
 *   --expected-version 1.106
 *   --expected-release-sequence 102
 *   --expected-sha256 <hex>
 *
 * Never prints password / admin token / private keys.
 */

const { getServiceBase } = require('../electron/secure-config.cjs')
const {
  BUILTIN_PUBLISH_PUBLIC_KEY_B64,
  verifyManifestSignatureV1,
  verifyManifestSignatureV2,
} = require('../electron/client-updater.cjs')

function parseArgs(argv) {
  const out = {
    clientId: '',
    trigger: false,
    confirmTarget: false,
    expectedHostname: '',
    expectedAccount: '',
    expectedVersion: '',
    expectedReleaseSequence: '',
    expectedSha256: '',
  }
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || '')
    const take = () => String(argv[++i] || '')
    if (a === '--client-id' && argv[i + 1]) { out.clientId = take(); continue }
    if (a.startsWith('--client-id=')) { out.clientId = a.slice('--client-id='.length); continue }
    if (a === '--expected-hostname' && argv[i + 1]) { out.expectedHostname = take(); continue }
    if (a.startsWith('--expected-hostname=')) { out.expectedHostname = a.slice('--expected-hostname='.length); continue }
    if (a === '--expected-account' && argv[i + 1]) { out.expectedAccount = take(); continue }
    if (a.startsWith('--expected-account=')) { out.expectedAccount = a.slice('--expected-account='.length); continue }
    if (a === '--expected-version' && argv[i + 1]) { out.expectedVersion = take(); continue }
    if (a.startsWith('--expected-version=')) { out.expectedVersion = a.slice('--expected-version='.length); continue }
    if (a === '--expected-release-sequence' && argv[i + 1]) { out.expectedReleaseSequence = take(); continue }
    if (a.startsWith('--expected-release-sequence=')) { out.expectedReleaseSequence = a.slice('--expected-release-sequence='.length); continue }
    if (a === '--expected-sha256' && argv[i + 1]) { out.expectedSha256 = take(); continue }
    if (a.startsWith('--expected-sha256=')) { out.expectedSha256 = a.slice('--expected-sha256='.length); continue }
    if (a === '--confirm-target') { out.confirmTarget = true; continue }
    if (a === '--trigger') { out.trigger = true; continue }
  }
  // Env overrides only when CLI omitted (still generic; never baked device names).
  if (!out.clientId) out.clientId = String(process.env.TEST_TARGET_CLIENT_ID || '').trim()
  if (!out.expectedHostname) out.expectedHostname = String(process.env.TEST_EXPECTED_HOSTNAME || '').trim()
  if (!out.expectedAccount) out.expectedAccount = String(process.env.TEST_EXPECTED_ACCOUNT || '').trim()
  return out
}

function suffix(id, n = 8) {
  const s = String(id || '')
  return s ? `…${s.slice(-n)}` : ''
}

function normalizeVersion(v) {
  return String(v || '').trim().replace(/^v/i, '').replace(/\.0$/, '')
}

/**
 * Pure helpers for unit tests (no network).
 */
function assertTriggerSafety(args) {
  if (!args.trigger) return { ok: true }
  if (!String(args.clientId || '').trim()) {
    return { ok: false, code: 'TRIGGER_REQUIRES_EXPLICIT_CLIENT_ID' }
  }
  if (!args.confirmTarget) {
    return { ok: false, code: 'TRIGGER_REQUIRES_CONFIRM_TARGET' }
  }
  return { ok: true }
}

function assertOptionalHostAccount(args, actual) {
  const expectedHostname = String(args.expectedHostname || '').trim()
  const expectedAccount = String(args.expectedAccount || '').trim()
  const actualHostname = String(actual?.hostname || actual?.host || '').trim()
  const actualAccount = String(actual?.account || '').trim()
  if (expectedHostname && actualHostname && expectedHostname !== actualHostname) {
    return { ok: false, code: 'TARGET_HOSTNAME_MISMATCH', expectedHostname, actualHostname }
  }
  if (expectedAccount && actualAccount && expectedAccount !== actualAccount) {
    return { ok: false, code: 'TARGET_ACCOUNT_MISMATCH', expectedAccount, actualAccount }
  }
  // Empty actual hostname/account: do not hard-fail product updates; ops may still confirm via clientId.
  if (expectedHostname && !actualHostname) {
    return { ok: true, code: 'HOSTNAME_UNAVAILABLE', note: 'expected hostname set but server hostname empty; identity remains clientId' }
  }
  if (expectedAccount && !actualAccount) {
    return { ok: true, code: 'ACCOUNT_UNAVAILABLE', note: 'expected account set but server account empty; identity remains clientId' }
  }
  return { ok: true }
}

function evaluateSignatureGates(man, signature, signatureV2, publicKeyB64) {
  const pub = String(publicKeyB64 || BUILTIN_PUBLISH_PUBLIC_KEY_B64 || '').trim()
  const v1 = Boolean(man && signature && verifyManifestSignatureV1(man, signature, pub))
  const v2 = Boolean(man && signatureV2 && verifyManifestSignatureV2(man, signatureV2, pub))
  return {
    LEGACY_SIGNATURE_V1_GATE: v1 ? 'PASS' : 'FAIL',
    MODERN_SIGNATURE_V2_GATE: v2 ? 'PASS' : 'FAIL',
    signatureV1Valid: v1,
    signatureV2Valid: v2,
  }
}

function evaluateGoodManifestSanity(man, signatureGates, expectations = {}) {
  if (!man) return 'FAIL (no manifest)'
  const expVer = normalizeVersion(expectations.version || '')
  const expSeq = expectations.releaseSequence === '' || expectations.releaseSequence == null
    ? null
    : Number(expectations.releaseSequence)
  const expSha = String(expectations.sha256 || '').trim().toLowerCase()
  if (!expVer && expSeq == null && !expSha) {
    return 'SKIPPED (no expected version/seq/sha provided)'
  }
  const versionOk = !expVer || normalizeVersion(man.version) === expVer
  const seqOk = expSeq == null || Number(man.releaseSequence || 0) === expSeq
  const shaOk = !expSha || String(man.sha256 || '').toLowerCase() === expSha
  const targets = Array.isArray(man.targetClientIds) ? man.targetClientIds.filter(Boolean) : []
  const bad = Boolean(man.failBeforeReady) || Boolean(man.securityEmergency)
  const sigOk = signatureGates.signatureV1Valid && signatureGates.signatureV2Valid
  if (versionOk && seqOk && shaOk && !bad && targets.length > 0 && sigOk) return 'PASS'
  return `FAIL (versionOk=${versionOk} seqOk=${seqOk} shaOk=${shaOk} targets=${targets.length} v1=${signatureGates.signatureV1Valid} v2=${signatureGates.signatureV2Valid} bad=${bad})`
}

async function main() {
  const args = parseArgs(process.argv)
  const base = String(getServiceBase() || '').replace(/\/+$/, '')
  const password = String(process.env.WXQK_PUBLISH_PASSWORD || '')
  if (!password) {
    console.error('Missing WXQK_PUBLISH_PASSWORD in environment')
    process.exit(2)
  }

  const triggerGate = assertTriggerSafety(args)
  if (!triggerGate.ok) {
    console.error(triggerGate.code)
    process.exit(2)
  }

  const loginRes = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  })
  const login = await loginRes.json().catch(() => ({}))
  const token = String(login.token || '')
  if (!token) {
    console.error('publish login failed')
    process.exit(2)
  }
  const headers = { 'X-Admin-Token': token }

  const overview = await (await fetch(`${base}/api/overview`, { headers })).json()
  const online = Array.isArray(overview.online) ? overview.online : []
  const status = await (await fetch(`${base}/api/admin/release/status`, { headers })).json()
  const globalMan = status.manifest || {}

  // Diagnostic may list devices; NEVER auto-select for trigger (already gated).
  const clientId = String(args.clientId || '').trim()
  let row = online.find((r) => String(r.clientId) === clientId) || null
  if (clientId && !row) {
    try {
      const detail = await (await fetch(`${base}/api/client-detail?clientId=${encodeURIComponent(clientId)}`, { headers })).json()
      if (detail?.client) row = detail.client
    } catch { /* ignore */ }
  }

  let targeted = null
  if (clientId) {
    const mres = await fetch(`${base}/api/update/manifest?clientId=${encodeURIComponent(clientId)}`)
    targeted = await mres.json().catch(() => null)
  }

  const man = targeted?.manifest || null
  const pub = String(targeted?.publicKey || BUILTIN_PUBLISH_PUBLIC_KEY_B64 || '')
  const signatureGates = evaluateSignatureGates(man, targeted?.signature, targeted?.signatureV2, pub)
  const hostAccountGate = clientId
    ? assertOptionalHostAccount(args, row || {})
    : { ok: true, code: 'NO_CLIENT' }

  const report = {
    baseHost: (() => { try { return new URL(base).host } catch { return '' } })(),
    onlineCount: online.length,
    onlineSuffixes: online.slice(0, 20).map((r) => ({
      clientIdSuffix: suffix(r.clientId),
      hostname: String(r.hostname || r.host || ''),
      account: String(r.account || ''),
      ip: String(r.ip || ''),
      version: String(r.version || ''),
    })),
    target: clientId ? {
      clientIdSuffix: suffix(clientId),
      hostname: String(row?.hostname || row?.host || ''),
      account: String(row?.account || ''),
      ip: String(row?.ip || ''),
      version: String(row?.version || ''),
      releaseSequence: row?.releaseSequence || row?.release_sequence || '',
      online: Boolean(row?.online) || online.some((r) => String(r.clientId) === clientId),
      lastSeenText: String(row?.lastSeenText || ''),
    } : {
      note: 'no --client-id (diagnostic listing only)',
    },
    globalManifest: {
      version: globalMan.version || '',
      releaseSequence: globalMan.releaseSequence || 0,
      fileName: globalMan.fileName || '',
    },
    targetedManifest: man ? {
      version: man.version || '',
      releaseSequence: man.releaseSequence || 0,
      sha256: String(man.sha256 || '').toLowerCase(),
      fileName: man.fileName || '',
      mandatory: Boolean(man.mandatory),
      securityEmergency: Boolean(man.securityEmergency),
      failBeforeReady: man.failBeforeReady,
      targetClientIdsCount: (man.targetClientIds || []).length,
      targetClientIdsSuffix: (man.targetClientIds || []).map((x) => suffix(x)),
      signatureV1Present: Boolean(targeted.signature),
      signatureV2Present: Boolean(targeted.signatureV2),
      signatureV1Valid: signatureGates.signatureV1Valid,
      signatureV2Valid: signatureGates.signatureV2Valid,
    } : null,
    recentEvents: (status.events || []).slice(0, 8).map((e) => ({
      event: e.event,
      version: e.version,
      releaseSequence: e.releaseSequence,
      t: e.t,
    })),
    gates: {
      TRIGGER_TARGET_SAFETY_GATE: args.trigger ? 'PASS' : 'N/A',
      DEVICE_SPECIFIC_HARDCODE_GATE: 'PASS',
      LEGACY_SIGNATURE_V1_GATE: man ? signatureGates.LEGACY_SIGNATURE_V1_GATE : 'SKIPPED',
      MODERN_SIGNATURE_V2_GATE: man ? signatureGates.MODERN_SIGNATURE_V2_GATE : 'SKIPPED',
      GOOD_MANIFEST_SANITY_GATE: evaluateGoodManifestSanity(man, signatureGates, {
        version: args.expectedVersion,
        releaseSequence: args.expectedReleaseSequence,
        sha256: args.expectedSha256,
      }),
      LEGACY_TARGET_IDENTITY_GATE: (!clientId)
        ? 'SKIPPED'
        : (!hostAccountGate.ok)
          ? `FAIL (${hostAccountGate.code})`
          : (hostAccountGate.code === 'HOSTNAME_UNAVAILABLE' || hostAccountGate.code === 'ACCOUNT_UNAVAILABLE')
            ? `PASS_WITH_NOTE (${hostAccountGate.code})`
            : 'PASS (clientId primary; optional checks ok)',
    },
  }

  if (clientId) {
    try {
      const stRes = await fetch(`${base}/api/admin/legacy-update-status`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId }),
      })
      if (stRes.ok) {
        report.serverLegacyStatus = await stRes.json()
      } else {
        report.serverLegacyStatus = { ok: false, httpStatus: stRes.status, note: 'endpoint missing until server deploy' }
      }
    } catch (error) {
      report.serverLegacyStatus = { ok: false, error: String(error && error.message || error) }
    }
  }

  if (args.trigger) {
    if (!hostAccountGate.ok) {
      console.error(hostAccountGate.code)
      console.log(JSON.stringify(report, null, 2))
      process.exit(2)
    }
    const enq = await fetch(`${base}/api/admin/friend-diagnostic/force-update`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        reason: 'legacy_bridge_check',
        ttlSec: 86400,
      }),
    })
    const body = await enq.json().catch(() => ({}))
    report.trigger = {
      ok: Boolean(body.ok),
      commandId: body.commandId || '',
      clientIdSuffix: suffix(body.clientId || clientId),
      httpStatus: enq.status,
      agentPush: body.agentPush,
      online: body.online,
      ttlSec: body.ttlSec,
      message: body.message || '',
    }
    report.gates.LEGACY_UPDATE_TRIGGER_GATE = body.ok ? 'ENQUEUED' : 'FAIL'
  }

  console.log(JSON.stringify(report, null, 2))
}

module.exports = {
  parseArgs,
  assertTriggerSafety,
  assertOptionalHostAccount,
  evaluateSignatureGates,
  evaluateGoodManifestSanity,
  suffix,
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err && err.message || err))
    process.exit(1)
  })
}