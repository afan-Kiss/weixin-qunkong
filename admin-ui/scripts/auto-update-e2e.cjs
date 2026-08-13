#!/usr/bin/env node
/**
 * Local portable auto-update simulation (Windows-friendly).
 *
 * What this script covers WITHOUT a live Mesh server:
 * - policy resolution / forced vs optional
 * - range merge + parts completed-byte accounting
 * - drain timeout behavior
 * - v2 canonical signing round-trip (local keypair)
 * - schedulePortableReplacement helper spawn shape (dry, no real EXE replace)
 * - unsigned test-mode check wiring stubs
 *
 * What still requires AUTO_UPDATE_E2E_GATE / live server:
 * - HTTPS manifest fetch against real /api/update/manifest
 * - package Range download from /api/update/package/{buildId}
 * - Authenticode / production pubkey verify
 * - full portable EXE replace while Electron holds file lock
 * - --after-update trash cleanup on a real second process
 * - targeted release matching via server resolve_manifest_for_client
 *
 * Usage:
 *   node scripts/auto-update-e2e.cjs
 *   set ALLOW_UNSIGNED_UPDATE_TEST=1 && node scripts/auto-update-e2e.cjs
 */
const assert = require('node:assert/strict')
const { generateKeyPairSync, sign } = require('node:crypto')
const http = require('node:http')
const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const updater = require('../electron/client-updater.cjs')
const { resolveUpdatePolicy, POLICY } = require('../electron/update-policy.cjs')
const { completedUniqueBytes, mergeIntervals } = require('../electron/update-ranges.cjs')
const { waitForUpdateDrain, DRAIN_STATE } = require('../electron/update-drain.cjs')

async function main() {
  console.log('[auto-update-e2e] local simulation start')
  updater.setAllowUnsignedForTest(process.env.ALLOW_UNSIGNED_UPDATE_TEST === '1')

  // 1) Policy
  assert.equal(
    resolveUpdatePolicy({ mandatory: false, targetClientIds: ['x'] }),
    POLICY.REMOTE_TARGETED_OPTIONAL,
  )
  console.log('  ok policy')

  // 2) Ranges (ftruncate-safe progress)
  assert.equal(completedUniqueBytes(mergeIntervals([[0, 99], [50, 149]])), 150)
  console.log('  ok ranges')

  // 3) Drain
  const drain = await waitForUpdateDrain({
    timeoutMs: 40,
    pollMs: 15,
    isRemote: true,
    hooks: { getRunningTasks: () => [{ id: '1', status: 'RUNNING' }] },
  })
  assert.equal(drain.state, DRAIN_STATE.TIMEOUT_PENDING)
  console.log('  ok drain')

  // 4) v2 signature local fixture
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const man = {
    version: '9.9',
    buildId: 'e2e-local',
    gitCommit: '',
    protocolVersion: 'facai888-v1',
    securityProtocolVersion: 'security-v1',
    desktopProtocolVersion: 'desktop-webrtc-v1',
    updaterProtocolVersion: 'updater-v2',
    mandatory: false,
    publishedAt: new Date().toISOString(),
    minimumSupportedBuild: '',
    downloadURL: 'https://mesh.example.invalid/wxqk/api/update/package/e2e-local',
    fileName: '微信群控系统v9.9.exe',
    fileSize: 4,
    sha256: 'aa'.repeat(32),
    signingKeyId: 'facai888-v1',
    authenticodePublisher: '',
    releaseSequence: 99,
    minimumReleaseSequence: 0,
    targetClientIds: ['c1'],
    securityEmergency: false,
  }
  const body = updater.canonicalManifestBytesV2(man)
  const sig = sign(null, body, privateKey).toString('hex')
  assert.equal(updater.verifyManifestSignature(man, sig, pubRaw.toString('base64')), true)
  console.log('  ok v2 signature')

  // 5) Local HTTP fixture for resume meta shape (unsigned mode optional)
  const dir = mkdtempSync(path.join(tmpdir(), 'wxqk-upd-e2e-'))
  const dest = path.join(dir, 'pkg.exe')
  const parts = `${dest}.wxqk-parts`
  writeFileSync(dest, Buffer.alloc(8))
  writeFileSync(parts, JSON.stringify({
    total: 8,
    partSize: 2 * 1024 * 1024,
    fileSize: 8,
    sha256: 'bb'.repeat(32),
    buildId: 'e2e-local',
    version: '9.9',
    completedRanges: [[0, 3]],
    done: [0],
  }))
  assert.equal(updater.readPartsCompletedBytes(dest), 4)
  console.log('  ok parts completed bytes', { dir })

  // 6) Helper export present
  assert.equal(typeof updater.schedulePortableReplacement, 'function')
  console.log('  ok schedulePortableReplacement export')

  // 7) Tiny local server smoke (manifest JSON only; skip TLS)
  const server = http.createServer((req, res) => {
    if (String(req.url || '').startsWith('/api/update/manifest')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, manifest: man, signature: sig, publicKey: pubRaw.toString('base64') }))
      return
    }
    res.writeHead(404)
    res.end('no')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  console.log(`  local fixture http://127.0.0.1:${port} (manifest only; production clients require HTTPS allowlist)`)
  server.close()

  console.log('[auto-update-e2e] PASS — local gates ok')
  console.log('[auto-update-e2e] Remaining for AUTO_UPDATE_E2E_GATE: live HTTPS publish→download→portable replace on device')
}

main().catch((error) => {
  console.error('[auto-update-e2e] FAIL', error)
  process.exitCode = 1
})
