/**
 * Update hardening unit tests: policy, ranges, drain, v2 sig, anti-downgrade, parts meta.
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { generateKeyPairSync, sign } = require('node:crypto')
const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const {
  POLICY,
  resolveUpdatePolicy,
  isForcedPolicy,
  normalizeTargetClientIds,
  mergeIntervals,
  completedUniqueBytes,
  normalizeRanges,
  collectActiveCriticalWork,
  waitForUpdateDrain,
  DRAIN_STATE,
  canonicalManifestBytesV1,
  canonicalManifestBytesV2,
  verifyManifestSignature,
  needsUpgrade,
  setHighestSeenUserData,
  recordHighestSeenReleaseSequence,
  loadHighestSeenReleaseSequence,
} = require('../electron/client-updater.cjs')
const { getLegacyManifestDefaults, getServiceBase } = require('../electron/secure-config.cjs')

function sampleManifest(overrides = {}) {
  const legacy = getLegacyManifestDefaults()
  return {
    version: '1.6',
    buildId: '20260802-120000-abc',
    gitCommit: '',
    protocolVersion: legacy.protocolVersion,
    securityProtocolVersion: legacy.securityProtocolVersion,
    desktopProtocolVersion: legacy.desktopProtocolVersion,
    updaterProtocolVersion: legacy.updaterProtocolVersion,
    mandatory: false,
    publishedAt: '2026-08-02T12:00:00Z',
    minimumSupportedBuild: '',
    downloadURL: `${getServiceBase()}/api/update/package/20260802-120000-abc`,
    fileName: '微信群控系统v1.6.exe',
    fileSize: 12,
    sha256: 'ab'.repeat(32),
    signingKeyId: legacy.signingKeyId,
    authenticodePublisher: '',
    releaseSequence: 3,
    minimumReleaseSequence: 0,
    targetClientIds: [],
    securityEmergency: false,
    ...overrides,
  }
}

test('resolveUpdatePolicy does not force mandatory solely because targets nonempty', () => {
  assert.equal(resolveUpdatePolicy(sampleManifest({ mandatory: false, targetClientIds: ['a', 'b'] })), POLICY.REMOTE_TARGETED_OPTIONAL)
  assert.equal(resolveUpdatePolicy(sampleManifest({ mandatory: true, targetClientIds: ['a'] })), POLICY.REMOTE_TARGETED_MANDATORY)
  assert.equal(resolveUpdatePolicy(sampleManifest({ mandatory: true, targetClientIds: [] })), POLICY.MANDATORY)
  assert.equal(resolveUpdatePolicy(sampleManifest({ mandatory: false })), POLICY.OPTIONAL)
  assert.equal(resolveUpdatePolicy(sampleManifest({ securityEmergency: true, mandatory: false })), POLICY.SECURITY_EMERGENCY)
  assert.equal(isForcedPolicy(POLICY.REMOTE_TARGETED_OPTIONAL), false)
  assert.equal(isForcedPolicy(POLICY.REMOTE_TARGETED_MANDATORY), true)
})

test('normalizeTargetClientIds sorts and dedupes', () => {
  assert.deepEqual(normalizeTargetClientIds(['b', 'a', 'b', '', 'a']), ['a', 'b'])
})

test('mergeIntervals and completedUniqueBytes cover gaps and overlaps', () => {
  assert.deepEqual(mergeIntervals([[0, 3], [2, 5], [10, 12]]), [[0, 5], [10, 12]])
  assert.equal(completedUniqueBytes([[0, 3], [2, 5], [10, 12]]), 6 + 3)
  assert.deepEqual(normalizeRanges([{ start: 1, end: 2 }, [5, 4], [7, 9]]), [[1, 2], [7, 9]])
})

test('waitForUpdateDrain times out to pending for remote', async () => {
  const busy = await collectActiveCriticalWork({
    getRunningTasks: () => [{ id: 't1', name: 'send', status: 'RUNNING' }],
  })
  assert.equal(busy.busy, true)
  const drain = await waitForUpdateDrain({
    timeoutMs: 50,
    pollMs: 20,
    isRemote: true,
    isMandatory: false,
    hooks: { getRunningTasks: () => [{ id: 't1', name: 'send', status: 'RUNNING' }] },
  })
  assert.equal(drain.ok, false)
  assert.equal(drain.state, DRAIN_STATE.TIMEOUT_PENDING)
})

test('waitForUpdateDrain becomes READY when work clears', async () => {
  let n = 0
  const drain = await waitForUpdateDrain({
    timeoutMs: 500,
    pollMs: 20,
    hooks: {
      getRunningTasks: () => {
        n += 1
        return n < 3 ? [{ id: 't1', status: 'RUNNING' }] : []
      },
    },
  })
  assert.equal(drain.ok, true)
  assert.equal(drain.state, DRAIN_STATE.READY)
})

test('canonical v2 includes control fields and verifies', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const man = sampleManifest({
    updaterProtocolVersion: 'updater-v2',
    releaseSequence: 9,
    minimumReleaseSequence: 2,
    targetClientIds: ['z', 'a', 'a'],
    securityEmergency: true,
    mandatory: true,
  })
  const v1 = canonicalManifestBytesV1(man)
  const v2 = canonicalManifestBytesV2(man)
  assert.equal(v1.includes('"releaseSequence"'), false)
  assert.equal(v2.includes('"releaseSequence":9'), true)
  assert.equal(v2.includes('"minimumReleaseSequence":2'), true)
  assert.equal(v2.includes('"targetClientIds":["a","z"]'), true)
  assert.equal(v2.includes('"securityEmergency":true'), true)
  const sigV2 = sign(null, v2, privateKey)
  const sigV1 = sign(null, v1, privateKey)
  // New clients prefer signatureV2 for control-plane integrity
  assert.equal(verifyManifestSignature(man, sigV1.toString('hex'), pubRaw.toString('base64'), sigV2.toString('hex')), true)
  // signature field alone may carry v2 wire (legacy single-sig servers)
  assert.equal(verifyManifestSignature(man, sigV2.toString('hex'), pubRaw.toString('base64')), true)
  // v1-only signature must not satisfy updater-v2 without signatureV2
  assert.equal(verifyManifestSignature(man, sigV1.toString('hex'), pubRaw.toString('base64')), false)
  // Old clients still verify v1 wire against `signature` when protocol is forced to v1
  const manV1 = sampleManifest({ updaterProtocolVersion: 'updater-v1', releaseSequence: 9 })
  assert.equal(verifyManifestSignature(manV1, sign(null, canonicalManifestBytesV1(manV1), privateKey).toString('hex'), pubRaw.toString('base64')), true)
})

test('anti-downgrade via highestSeenReleaseSequence', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'upd-seen-'))
  setHighestSeenUserData(dir)
  recordHighestSeenReleaseSequence(10, dir)
  assert.equal(loadHighestSeenReleaseSequence(dir), 10)
  assert.equal(
    needsUpgrade(sampleManifest({ releaseSequence: 8, version: '1.0' }), 5, 'old', '1.0.0', '', dir),
    false,
  )
  assert.equal(
    needsUpgrade(sampleManifest({ releaseSequence: 11, version: '1.1' }), 5, 'old', '1.0.0', '', dir),
    true,
  )
})

test('parts metadata binds sha256/fileSize/version/buildId', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /completedRanges/)
  assert.match(src, /artifactMatches/)
  assert.match(src, /sha256: artifactSha/)
  assert.match(src, /buildId: artifactBuild/)
  assert.match(src, /version: artifactVersion/)
  assert.match(src, /readPartsCompletedBytes/)
  assert.doesNotMatch(
    src.slice(src.indexOf('async function downloadWithResume'), src.indexOf('function probeDirWritable')),
    /statSync\(dest\)\.size === total/,
  )
})

test('server update_manifest exposes v2 canonical + normalize targets', () => {
  const py = readFileSync(path.join(__dirname, '..', '..', 'server', 'wxqk', 'update_manifest.py'), 'utf8')
  assert.match(py, /def canonical_manifest_bytes_v1/)
  assert.match(py, /def canonical_manifest_bytes_v2/)
  assert.match(py, /def normalize_target_client_ids/)
  assert.match(py, /UPDATER_PROTOCOL_V2/)
  assert.match(py, /securityEmergency/)
})
