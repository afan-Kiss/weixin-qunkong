const test = require('node:test')
const assert = require('node:assert/strict')
const { createHash, generateKeyPairSync, sign } = require('node:crypto')
const { writeFileSync, unlinkSync, mkdtempSync, readFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const {
  canonicalManifestBytes,
  verifyManifestSignature,
  needsUpgrade,
  validateDownloadURL,
  packageFileMatchesManifest,
  setAllowUnsignedForTest,
  DEFAULT_BASE,
} = require('../electron/client-updater.cjs')
const { getServiceBase, getLegacyManifestDefaults, isLegacyBrandDownloadUrl } = require('../electron/secure-config.cjs')

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
    mandatory: true,
    publishedAt: '2026-08-02T12:00:00Z',
    minimumSupportedBuild: '',
    downloadURL: `${getServiceBase()}/api/update/package/20260802-120000-abc`,
    fileName: '微信群控系统v1.6.exe',
    fileSize: 12,
    sha256: '',
    signingKeyId: legacy.signingKeyId,
    authenticodePublisher: '',
    releaseSequence: 3,
    minimumReleaseSequence: 0,
    ...overrides,
  }
}

test('needsUpgrade prefers releaseSequence and honors minimumReleaseSequence', () => {
  assert.equal(needsUpgrade(sampleManifest({ releaseSequence: 3 }), 2, 'old', '1.5.0'), true)
  assert.equal(needsUpgrade(sampleManifest({ releaseSequence: 3, version: '1.6' }), 3, 'old', '1.6.0'), false)
  assert.equal(needsUpgrade(sampleManifest({ releaseSequence: 0, version: '1.0', buildId: 'b2' }), 0, 'b1', '1.0.0'), true)
  assert.equal(needsUpgrade(sampleManifest({ releaseSequence: 0, version: '1.0', buildId: 'b1' }), 0, 'b1', '1.0.0'), false)
  assert.equal(needsUpgrade(sampleManifest({ minimumReleaseSequence: 5, releaseSequence: 5, version: '1.0' }), 4, 'x', '1.0.0'), true)
})

test('needsUpgrade uses version when local releaseSequence is ahead of remote', () => {
  assert.equal(
    needsUpgrade(sampleManifest({ version: '1.9', releaseSequence: 2 }), 2, 'app-electron-1.6.0', '1.6.0'),
    true,
  )
  assert.equal(
    needsUpgrade(sampleManifest({ version: '1.9', releaseSequence: 2 }), 5, 'app-electron-1.9.0', '1.9.0'),
    false,
  )
})

test('validateDownloadURL only allows https whitelist hosts', () => {
  assert.equal(validateDownloadURL(`${DEFAULT_BASE}/api/update/package/a`).ok, true)
  assert.equal(validateDownloadURL(DEFAULT_BASE.replace(/^https/, 'http') + '/api/update/package/a').ok, false)
  assert.equal(validateDownloadURL('https://evil.example/pkg.exe').ok, false)
})

test('canonical manifest excludes releaseSequence and verifies ed25519', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const man = sampleManifest()
  const body = canonicalManifestBytes(man)
  assert.equal(body.includes('"releaseSequence"'), false)
  assert.equal(body.includes('"fileName":"微信群控系统v1.6.exe"'), true)
  const sig = sign(null, body, privateKey)
  assert.equal(verifyManifestSignature(man, sig.toString('hex'), pubRaw.toString('base64')), true)
  assert.equal(verifyManifestSignature(man, '00'.repeat(64), pubRaw.toString('base64')), false)
})

test('packageFileMatchesManifest prevents update loops on same bytes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'app-upd-'))
  const file = path.join(dir, 'pkg.exe')
  const payload = Buffer.from('portable-bytes')
  writeFileSync(file, payload)
  const sha = createHash('sha256').update(payload).digest('hex')
  const man = sampleManifest({ sha256: sha, fileSize: payload.length })
  assert.equal(await packageFileMatchesManifest(file, man), true)
  assert.equal(await packageFileMatchesManifest(file, sampleManifest({ sha256: 'aa'.repeat(32), fileSize: payload.length })), false)
  try { unlinkSync(file) } catch {}
})

test('applyUpdate falls back from legacy brand downloadURL via secure-config helper', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /isLegacyBrandDownloadUrl/)
  assert.match(src, /isLegacyBrandFileName/)
  assert.match(src, /微信群控系统v\$\{ver\}\.exe/)
  assert.equal(typeof isLegacyBrandDownloadUrl, 'function')
})

test('apply does not reject a newer semantic version when local releaseSequence is ahead', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  const applySource = src.slice(src.indexOf('async function applyUpdate'), src.indexOf('function cleanupUpdateTrashBestEffort'))
  assert.doesNotMatch(applySource, /拒绝降级/)
  assert.doesNotMatch(applySource, /latest\s*<\s*curSeq/)
})

test('non-mandatory manifest stays non-mandatory when an update is available', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  const checkSource = src.slice(src.indexOf('async function checkForUpdate'), src.indexOf('async function reportUpdate'))
  assert.match(checkSource, /const mandatory = Boolean\(manifest\.mandatory\)/)
  assert.doesNotMatch(checkSource, /const mandatory[\s\S]*latest > currentSeq/)
})

test('portable update writes and verifies the new executable before launching it directly', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  const ui = readFileSync(path.join(__dirname, '..', 'src', 'utils', 'clientUpdate.ts'), 'utf8')
  assert.match(src, /copyFileSync\(downloadPath, finalPath\)/)
  assert.match(src, /await verifyPackageFile\(finalPath, man\)/)
  assert.match(src, /const child = spawn\(finalPath, \['--after-update'\]/)
  assert.match(src, /PORTABLE_EXECUTABLE_FILE: finalPath/)
  assert.match(src, /\[UPDATE_OLD_TRASH_ENV\]: currentExe/)
  assert.match(src, /if \(!child\.pid\) throw new Error/)
  assert.doesNotMatch(src, /\$child\.HasExited/)
  assert.doesNotMatch(src.slice(src.indexOf('async function applyUpdate'), src.indexOf('function cleanupUpdateTrashBestEffort')), /renameSync\(currentExe/)
  assert.match(ui, /applyClientUpdate\(\), true/)
})

test('manifest signature failure blocks fetchManifest in production', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /UPDATE_SIGNATURE_MISSING/)
  assert.match(src, /UPDATE_SIGNATURE_INVALID/)
  assert.match(src, /throw new Error\('UPDATE_SIGNATURE_INVALID'\)/)
  assert.doesNotMatch(src, /remotePublicKey/)
  assert.doesNotMatch(src, /ignore UPDATE_SIGNATURE_INVALID/)
})

test('main wires updater scheduler and client uses encoded service base', () => {
  const fs = require('node:fs')
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const updater = fs.readFileSync(path.join(root, 'electron', 'client-updater.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const ui = fs.readFileSync(path.join(root, 'src', 'utils', 'clientUpdate.ts'), 'utf8')
  const bump = fs.readFileSync(path.join(root, 'scripts', 'bump-version.cjs'), 'utf8')
  const identity = fs.readFileSync(path.join(root, 'electron', 'device-identity.cjs'), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const server = fs.readFileSync(path.join(root, '..', 'server', 'wxqk', 'server.py'), 'utf8')
  const manifest = fs.readFileSync(path.join(root, '..', 'server', 'wxqk', 'update_manifest.py'), 'utf8')
  assert.match(main, /startUpdateScheduler/)
  assert.match(main, /update:check/)
  assert.match(main, /update:apply/)
  assert.match(main, /releaseSingleInstanceLock/)
  assert.match(updater, /ipcCheckClientUpdate/)
  assert.match(updater, /ipcApplyClientUpdate/)
  assert.match(updater, /releaseSingleInstanceLock/)
  assert.match(updater, /getServiceBase|secure-config/)
  assert.doesNotMatch(updater, /CHECK_INTERVAL_MS/)
  assert.doesNotMatch(updater, /setInterval\s*\(/)
  assert.match(preload, /checkClientUpdate/)
  assert.match(preload, /applyClientUpdate/)
  assert.match(ui, /bootstrapClientUpdate/)
  assert.match(ui, /runClientUpdateModal/)
  assert.match(ui, /立即更新/)
  assert.match(ui, /稍后更新/)
  assert.match(ui, /绝不能提前 markStartupUpdateDone/)
  assert.match(identity, /releaseSequence/)
  assert.match(bump, /releaseSequence/)
  assert.match(bump, /getServiceBase/)
  assert.equal(typeof pkg.releaseSequence, 'number')
  assert.match(server, /120\.27\.219\.138:8443\/wxqk/)
  assert.match(server, /"publicKey": um\.public_key_b64\(DATA_DIR\)/)
  assert.doesNotMatch(server, /public_base_url="https:\/\/xiangyuzhubao\.xyz\/发财888"/)
  assert.match(manifest, /微信群控系统v\{ver\}\.exe/)
  assert.match(manifest, /120\.27\.219\.138:8443\/wxqk/)
  assert.match(updater, /LEGACY_UPDATE_OLD_TRASH_ENV/)
  assert.match(updater, /WXQK_UPDATE_OLD_TRASH/)
  assert.match(updater, /sameHost/)
  assert.doesNotMatch(updater, /xiangyuzhubao\.xyz\/wxqk\/api\/update\/package/)
  assert.match(main, /clientId: String\(getRemoteAgentStatus/)
})

test('allowUnsignedForTest stays off by default', () => {
  setAllowUnsignedForTest(false)
  assert.equal(verifyManifestSignature(sampleManifest(), '00'.repeat(64)), false)
})

test('downloadRangeToFile rejects HTTP 200 with RANGE_UNSUPPORTED', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /RANGE_UNSUPPORTED/)
  assert.match(src, /status === 200/)
  assert.match(src, /status !== 206/)
  assert.match(src, /RANGE_INVALID_CONTENT_RANGE/)
  assert.match(src, /RANGE_BODY_TOO_LARGE/)
  assert.match(src, /Content-Range mismatch/)
  assert.match(src, /Range body length mismatch/)
  assert.match(src, /content-range/)
  assert.match(src, /createWriteStream\(dest, \{ flags: 'r\+', start/)
  assert.match(src, /concurrency = total >= 16 \* 1024 \* 1024 \? 2 : 1/)
  assert.match(src, /partSize = 2 \* 1024 \* 1024/)
  assert.doesNotMatch(src, /writeSync\(fd, chunk/)
})

test('downloadWithResume falls back to single-connection on RANGE_UNSUPPORTED', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /rangeUnsupported/)
  assert.match(src, /error\.code === 'RANGE_UNSUPPORTED'/)
  assert.match(src, /Fallback: single-connection full download/)
  assert.match(src, /download fallback http/)
  assert.match(src, /UPDATE_SIZE_MISMATCH/)
})
