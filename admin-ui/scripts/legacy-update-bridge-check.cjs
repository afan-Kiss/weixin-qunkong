'use strict'

/**
 * Legacy bridge diagnostic (no secrets in output).
 *
 * Usage:
 *   set WXQK_PUBLISH_PASSWORD=...
 *   node scripts/legacy-update-bridge-check.cjs [--client-id <id>] [--trigger]
 *
 * Reads canonical BaseUrl from secure-config. Never prints password/token.
 */

const { getServiceBase } = require('../electron/secure-config.cjs')

function parseArgs(argv) {
  const out = { clientId: '', trigger: false }
  for (let i = 2; i < argv.length; i += 1) {
    const a = String(argv[i] || '')
    if (a === '--client-id' && argv[i + 1]) { out.clientId = String(argv[++i]); continue }
    if (a.startsWith('--client-id=')) { out.clientId = a.slice('--client-id='.length); continue }
    if (a === '--trigger') out.trigger = true
  }
  return out
}

function suffix(id, n = 8) {
  const s = String(id || '')
  return s ? `…${s.slice(-n)}` : ''
}

async function main() {
  const args = parseArgs(process.argv)
  const base = String(getServiceBase() || '').replace(/\/+$/, '')
  const password = String(process.env.WXQK_PUBLISH_PASSWORD || '')
  if (!password) {
    console.error('Missing WXQK_PUBLISH_PASSWORD in environment')
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

  let clientId = String(args.clientId || '').trim()
  if (!clientId && online.length === 1) {
    clientId = String(online[0].clientId || '')
  }
  const row = online.find((r) => String(r.clientId) === clientId) || null

  let targeted = null
  if (clientId) {
    const mres = await fetch(`${base}/api/update/manifest?clientId=${encodeURIComponent(clientId)}`)
    targeted = await mres.json().catch(() => null)
  }

  const man = targeted?.manifest || null
  const GOOD_SHA = '7e40a56995f37767c34894eec7e64b8966a5e8e3938cdba95abd449eabf122b9'
  const EXPECTED_SEQ = 102
  const hostname = row ? String(row.hostname || row.host || '') : ''
  const report = {
    baseHost: (() => { try { return new URL(base).host } catch { return '' } })(),
    onlineCount: online.length,
    target: row ? {
      clientIdSuffix: suffix(row.clientId),
      hostname,
      account: String(row.account || ''),
      ip: String(row.ip || ''),
      version: String(row.version || ''),
      lastSeenText: String(row.lastSeenText || ''),
      online: true,
    } : {
      clientIdSuffix: suffix(clientId),
      online: false,
      note: clientId ? 'not in overview.online' : 'no clientId',
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
      targetClientIdsSuffix: (man.targetClientIds || []).map((x) => suffix(x)),
      hasSignature: Boolean(targeted.signature),
      hasSignatureV2: Boolean(targeted.signatureV2),
    } : null,
    recentEvents: (status.events || []).slice(0, 8).map((e) => ({
      event: e.event,
      version: e.version,
      releaseSequence: e.releaseSequence,
      t: e.t,
    })),
    gates: {
      LEGACY_TARGET_IDENTITY_GATE: (!clientId)
        ? 'FAIL'
        : (!row)
          ? 'NOT VERIFIED (offline)'
          : (!hostname)
            ? 'NOT VERIFIED (hostname empty — do not assume unique-online)'
            : 'PENDING_HOSTNAME_MATCH',
      GOOD_MANIFEST_SANITY_GATE: (!man)
        ? 'FAIL'
        : (
          String(man.version || '') === '1.106'
          && Number(man.releaseSequence || 0) === EXPECTED_SEQ
          && String(man.sha256 || '').toLowerCase() === GOOD_SHA
          && !man.failBeforeReady
          && !man.securityEmergency
          && Boolean(targeted.signature)
        ) ? 'PASS' : `FAIL (need v1.106 seq=${EXPECTED_SEQ} good SHA; got v${man.version} seq=${man.releaseSequence})`,
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
    if (!clientId) {
      console.error('Cannot --trigger without clientId / single online device')
      process.exit(2)
    }
    const enq = await fetch(`${base}/api/admin/friend-diagnostic/force-update`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        reason: 'legacy_bridge_check',
        // Keep queued while device may be briefly offline (requires server ttlSec support)
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
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((err) => {
  console.error(String(err && err.message || err))
  process.exit(1)
})
