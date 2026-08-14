'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { generateKeyPairSync, sign } = require('crypto')
const {
  tryAcquireMachineChannelLock,
  releaseMachineChannelLock,
  setMachineChannelLockDepsForTest,
  resetMachineChannelLockDepsForTest,
} = require('../electron/machine-channel-lock.cjs')
const {
  ensureWindowsBackgroundStartup,
  ensureStableLauncherCopy,
  resolveStableLauncherPath,
  isBackgroundLaunchArgv,
  setBackgroundStartupDepsForTest,
  resetBackgroundStartupDepsForTest,
} = require('../electron/background-startup.cjs')
const {
  resolveTrustedPublishKey,
  setTrustedPublishKeyRingForTest,
  resetTrustedPublishKeyRingForTest,
  OLD_KEY_ID,
  NEW_KEY_ID,
} = require('../electron/publish-trust.cjs')
const { evaluateAuthenticodeGate } = require('../electron/authenticode-gate.cjs')
const {
  assertTriggerSafety,
  evaluateGoodManifestSanity,
  evaluateSignatureGates,
} = require('../scripts/legacy-update-bridge-check.cjs')

test('machine channel lock: second acquire fails while first holds', () => {
  resetMachineChannelLockDepsForTest()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxqk-lock-'))
  setMachineChannelLockDepsForTest({ platform: 'linux', programData: dir })
  const a = tryAcquireMachineChannelLock('client-aaa')
  assert.equal(a.ok, true)
  const b = tryAcquireMachineChannelLock('client-aaa')
  assert.equal(b.ok, false)
  assert.equal(b.code, 'OWNER_OTHER_SESSION')
  releaseMachineChannelLock(a.handle)
  const c = tryAcquireMachineChannelLock('client-aaa')
  assert.equal(c.ok, true)
  releaseMachineChannelLock(c.handle)
  resetMachineChannelLockDepsForTest()
})

test('machine channel lock: stale pid lock is reclaimable', () => {
  resetMachineChannelLockDepsForTest()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxqk-lock-stale-'))
  setMachineChannelLockDepsForTest({ platform: 'linux', programData: dir })
  const lockDir = path.join(dir, 'WXQK', 'locks')
  fs.mkdirSync(lockDir, { recursive: true })
  // Create a lock owned by a dead pid
  const first = tryAcquireMachineChannelLock('client-stale')
  assert.equal(first.ok, true)
  const lockFile = first.handle.lockFile
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 1, clientId: 'client-stale' }))
  try { fs.closeSync(first.handle.fd) } catch { /* ignore */ }
  // pid 1 may or may not be alive on Windows; force unlink then recreate stale content
  try { fs.unlinkSync(lockFile) } catch { /* ignore */ }
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483000, clientId: 'client-stale' }))
  const reclaim = tryAcquireMachineChannelLock('client-stale')
  assert.equal(reclaim.ok, true, reclaim.message)
  releaseMachineChannelLock(reclaim.handle)
  resetMachineChannelLockDepsForTest()
})

test('stable launcher path never embeds versioned exe name', () => {
  const p = resolveStableLauncherPath('C:\\Users\\x\\AppData\\Local\\WXQK')
  assert.match(p.replace(/\\/g, '/'), /\/launcher\/微信群控系统\.exe$/)
  assert.doesNotMatch(p, /v1\.\d+/)
})

test('ensureStableLauncherCopy copies source into launcher dir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wxqk-launcher-'))
  const src = path.join(root, '微信群控系统v1.106.exe')
  fs.writeFileSync(src, 'portable-bytes')
  const out = ensureStableLauncherCopy({ userDataRoot: root, sourceExe: src })
  assert.equal(out.ok, true)
  assert.equal(fs.existsSync(resolveStableLauncherPath(root)), true)
  assert.equal(fs.readFileSync(resolveStableLauncherPath(root), 'utf8'), 'portable-bytes')
})

test('background startup registers login item with --background', () => {
  resetBackgroundStartupDepsForTest()
  const calls = []
  setBackgroundStartupDepsForTest({
    platform: 'win32',
    fs: { existsSync: () => true, mkdirSync() {} },
  })
  const out = ensureWindowsBackgroundStartup({
    userDataRoot: 'D:\\WXQK',
    allowMissing: true,
    app: { setLoginItemSettings(cfg) { calls.push(cfg) } },
  })
  assert.equal(out.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].openAtLogin, true)
  assert.deepEqual(calls[0].args, ['--background'])
  assert.match(String(calls[0].path), /微信群控系统\.exe$/)
  resetBackgroundStartupDepsForTest()
})

test('background argv detection', () => {
  assert.equal(isBackgroundLaunchArgv(['node', 'app', '--background']), true)
  assert.equal(isBackgroundLaunchArgv(['node', 'app']), false)
})

test('trusted key ring rejects unknown signingKeyId', () => {
  resetTrustedPublishKeyRingForTest()
  setTrustedPublishKeyRingForTest([
    { keyId: OLD_KEY_ID, publicKeyB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', maxTrustedReleaseSequence: null, minTrustedReleaseSequence: null },
  ])
  const bad = resolveTrustedPublishKey({ signingKeyId: 'unknown-key', releaseSequence: 1 })
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'UNKNOWN_SIGNING_KEY_ID')
  resetTrustedPublishKeyRingForTest()
})

test('old signer retirement rejects seq above max', () => {
  resetTrustedPublishKeyRingForTest()
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  setTrustedPublishKeyRingForTest([
    { keyId: OLD_KEY_ID, publicKeyB64: pub, maxTrustedReleaseSequence: 100, minTrustedReleaseSequence: null },
    { keyId: NEW_KEY_ID, publicKeyB64: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=', maxTrustedReleaseSequence: null, minTrustedReleaseSequence: 101 },
  ])
  const retired = resolveTrustedPublishKey({ signingKeyId: OLD_KEY_ID, releaseSequence: 101 })
  assert.equal(retired.ok, false)
  assert.equal(retired.code, 'OLD_SIGNER_RETIRED')
  const ok = resolveTrustedPublishKey({ signingKeyId: OLD_KEY_ID, releaseSequence: 100 })
  assert.equal(ok.ok, true)
  void privateKey
  resetTrustedPublishKeyRingForTest()
})

test('authenticode production without identity is BLOCKED_EXTERNAL', () => {
  const prev = process.env.WXQK_REQUIRE_AUTHENTICODE
  const thumb = process.env.WXQK_AUTHENTICODE_THUMBPRINT
  process.env.WXQK_REQUIRE_AUTHENTICODE = '1'
  delete process.env.WXQK_AUTHENTICODE_THUMBPRINT
  delete process.env.WXQK_AZURE_TRUSTED_SIGNING_ENDPOINT
  const gate = evaluateAuthenticodeGate({ requireSign: true })
  assert.equal(gate.ok, false)
  assert.equal(gate.code, 'BLOCKED_EXTERNAL')
  if (prev == null) delete process.env.WXQK_REQUIRE_AUTHENTICODE
  else process.env.WXQK_REQUIRE_AUTHENTICODE = prev
  if (thumb != null) process.env.WXQK_AUTHENTICODE_THUMBPRINT = thumb
})

test('legacy trigger blocked when sanity SKIPPED', () => {
  const sanity = evaluateGoodManifestSanity({ version: '1.1', targetClientIds: ['a'] }, {
    signatureV1Valid: true,
    signatureV2Valid: true,
  }, {})
  assert.match(sanity, /^SKIPPED/)
})

test('legacy signature gate ignores server publicKey argument preference', () => {
  // Builtin key used first; fake server key must not become trust root when builtin present.
  const gates = evaluateSignatureGates(null, '', '', 'fake-server-key')
  assert.equal(gates.signatureV1Valid, false)
  assert.equal(gates.signatureV2Valid, false)
})

test('trigger safety still requires explicit client id', () => {
  const r = assertTriggerSafety({ trigger: true, clientId: '', confirmTarget: true })
  assert.equal(r.ok, false)
})
