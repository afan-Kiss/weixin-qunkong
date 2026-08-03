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
} = require('../electron/client-updater.cjs')

function sampleManifest(overrides = {}) {
  return {
    version: '1.6',
    buildId: '20260802-120000-abc',
    gitCommit: '',
    protocolVersion: 'facai888-v1',
    securityProtocolVersion: 'security-v1',
    desktopProtocolVersion: 'desktop-webrtc-v1',
    updaterProtocolVersion: 'updater-v1',
    mandatory: true,
    publishedAt: '2026-08-02T12:00:00Z',
    minimumSupportedBuild: '',
    downloadURL: 'https://xiangyuzhubao.xyz/wxqk/api/update/package/20260802-120000-abc',
    fileName: '微信群控系统v1.6.exe',
    fileSize: 12,
    sha256: '',
    signingKeyId: 'facai888-v1',
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
  // 现场故障：v1.6 本地 seq=2，远端发布 1.9 也是 seq=2，旧逻辑判定无需更新
  assert.equal(
    needsUpgrade(sampleManifest({ version: '1.9', releaseSequence: 2 }), 2, 'wxqk-electron-1.6.0', '1.6.0'),
    true,
  )
  assert.equal(
    needsUpgrade(sampleManifest({ version: '1.9', releaseSequence: 2 }), 5, 'wxqk-electron-1.9.0', '1.9.0'),
    false,
  )
})

test('validateDownloadURL only allows https whitelist hosts', () => {
  assert.equal(validateDownloadURL('https://xiangyuzhubao.xyz/wxqk/api/update/package/a').ok, true)
  assert.equal(validateDownloadURL('http://xiangyuzhubao.xyz/wxqk/api/update/package/a').ok, false)
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
  const dir = mkdtempSync(path.join(tmpdir(), 'wxqk-upd-'))
  const file = path.join(dir, 'pkg.exe')
  const payload = Buffer.from('portable-bytes')
  writeFileSync(file, payload)
  const sha = createHash('sha256').update(payload).digest('hex')
  const man = sampleManifest({ sha256: sha, fileSize: payload.length })
  assert.equal(await packageFileMatchesManifest(file, man), true)
  assert.equal(await packageFileMatchesManifest(file, sampleManifest({ sha256: 'aa'.repeat(32), fileSize: payload.length })), false)
  try { unlinkSync(file) } catch {}
})

test('applyUpdate falls back from legacy 发财888 downloadURL to /wxqk package URL', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /\/发财888\//)
  assert.match(src, /强制回退到当前客户端的 \/wxqk 基址/)
  assert.match(src, /微信群控系统v\$\{ver\}\.exe/)
})

test('manifest signature failure does not block fetchManifest contract', () => {
  const src = readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /不依赖密钥/)
  assert.match(src, /ignore UPDATE_SIGNATURE_INVALID/)
  assert.doesNotMatch(src, /if \(!verifyManifestSignature\(man, signature\)\) throw new Error\('UPDATE_SIGNATURE_INVALID'\)/)
})

test('main wires updater scheduler and publish branding is wxqk', () => {
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
  assert.doesNotMatch(updater, /CHECK_INTERVAL_MS/)
  assert.doesNotMatch(updater, /setInterval\s*\(/)
  assert.match(preload, /checkClientUpdate/)
  assert.match(preload, /applyClientUpdate/)
  assert.match(ui, /bootstrapClientUpdate/)
  assert.match(ui, /runClientUpdateModal/)
  assert.match(identity, /wxqkReleaseSequence/)
  assert.match(bump, /wxqkReleaseSequence/)
  assert.match(bump, /releaseSequence/)
  assert.equal(typeof pkg.wxqkReleaseSequence, 'number')
  assert.match(server, /xiangyuzhubao\.xyz\/wxqk/)
  assert.doesNotMatch(server, /public_base_url="https:\/\/xiangyuzhubao\.xyz\/发财888"/)
  assert.match(manifest, /微信群控系统v\{ver\}\.exe/)
  assert.match(manifest, /xiangyuzhubao\.xyz\/wxqk/)
})

test('allowUnsignedForTest stays off by default', () => {
  setAllowUnsignedForTest(false)
  assert.equal(verifyManifestSignature(sampleManifest(), '00'.repeat(64)), false)
})
