'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { generateKeyPairSync, createHash } = require('node:crypto')

const {
  loadOrCreate,
  tryImportLegacyIdentityFile,
  writeIdentityFile,
  setIdentityDepsForTest,
  resetIdentityDepsForTest,
  setSafeStorageForTest,
  resetSafeStorageForTest,
} = require('../electron/device-identity.cjs')
const machine = require('../electron/machine-identity.cjs')

function makePemIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const publicKeyB64 = Buffer.from(pubRaw).toString('base64')
  const deviceId = createHash('sha256').update(pubRaw).digest('hex')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return { privateKeyPem, publicKeyB64, deviceId, clientId: deviceId }
}

function withIsolatedMachine(fn) {
  const machineRoot = mkdtempSync(path.join(tmpdir(), 'machine-iso-'))
  process.env.WXQK_MACHINE_DATA_DIR = machineRoot
  machine.setMachineIdentityDepsForTest({
    platform: 'linux',
    hardenAcl: () => ({ ok: true }),
  })
  try {
    return fn(machineRoot)
  } finally {
    machine.resetMachineIdentityDepsForTest()
    delete process.env.WXQK_MACHINE_DATA_DIR
    try { rmSync(machineRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

test('clone prevention: plaintext legacy without local msh agentName is rejected', () => {
  withIsolatedMachine(() => {
    resetIdentityDepsForTest()
    setIdentityDepsForTest({ readInstalledAgentName: () => '' })
    const stable = mkdtempSync(path.join(tmpdir(), 'id-stable-'))
    const legacyDir = mkdtempSync(path.join(tmpdir(), 'id-legacy-'))
    const ident = makePemIdentity()
    const legacyFile = path.join(legacyDir, 'device-identity.json')
    writeFileSync(legacyFile, JSON.stringify({
      ...ident,
      privateKeyPem: ident.privateKeyPem,
      createdAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8')

    const result = tryImportLegacyIdentityFile(stable, legacyFile)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DEVICE_IDENTITY_CLONE_REJECTED')

    const created = loadOrCreate(stable)
    assert.notEqual(created.clientId, ident.clientId)

    resetIdentityDepsForTest()
    try { rmSync(stable, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(legacyDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})

test('clone prevention: plaintext legacy accepted only when local msh agentName matches', () => {
  withIsolatedMachine(() => {
    resetIdentityDepsForTest()
    const ident = makePemIdentity()
    setIdentityDepsForTest({ readInstalledAgentName: () => `WXQK-${ident.clientId}` })
    const stable = mkdtempSync(path.join(tmpdir(), 'id-stable2-'))
    const legacyDir = mkdtempSync(path.join(tmpdir(), 'id-legacy2-'))
    const legacyFile = path.join(legacyDir, 'device-identity.json')
    writeFileSync(legacyFile, JSON.stringify({
      ...ident,
      privateKeyPem: ident.privateKeyPem,
      createdAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8')

    const result = tryImportLegacyIdentityFile(stable, legacyFile)
    assert.equal(result.ok, true)
    const loaded = loadOrCreate(stable)
    assert.equal(loaded.clientId, ident.clientId)

    resetIdentityDepsForTest()
    try { rmSync(stable, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(legacyDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})

test('stable identity survives move simulation via machine store', () => {
  withIsolatedMachine(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'id-move-'))
    const first = loadOrCreate(root)
    const second = loadOrCreate(path.join(root, 'other-user-sim'))
    assert.equal(second.clientId, first.clientId)
    assert.equal(second.deviceId, first.deviceId)
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})

test('DEVICE_IDENTITY_UNREADABLE: undecryptable privateKeyEnc does not recreate identity', () => {
  withIsolatedMachine(() => {
    resetSafeStorageForTest()
    const root = mkdtempSync(path.join(tmpdir(), 'id-unread-'))
    const dir = path.join(root, 'security')
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'device-identity.json')
    const ident = makePemIdentity()
    writeFileSync(file, JSON.stringify({
      schemaVersion: 2,
      publicKeyB64: ident.publicKeyB64,
      deviceId: ident.deviceId,
      clientId: ident.clientId,
      privateKeyEnc: Buffer.from('not-valid-dpapi-blob').toString('base64'),
      privateKeyPem: ident.privateKeyPem,
      createdAt: '2026-01-01T00:00:00.000Z',
    }), 'utf8')

    setSafeStorageForTest({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(`enc:${s}`),
      decryptString: () => { throw new Error('dpapi fail') },
    })

    let threw = null
    try {
      loadOrCreate(root)
    } catch (err) {
      threw = err
    }
    assert.ok(threw)
    assert.equal(threw.code, 'DEVICE_IDENTITY_UNREADABLE')
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.clientId, ident.clientId)
    assert.ok(onDisk.privateKeyEnc)

    resetSafeStorageForTest()
    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})

test('writeIdentityFile drops plaintext when DPAPI encryption available', () => {
  resetSafeStorageForTest()
  setSafeStorageForTest({
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(`enc:${s}`),
    decryptString: (buf) => String(buf).replace(/^enc:/, ''),
  })
  const dir = mkdtempSync(path.join(tmpdir(), 'id-dpapi-'))
  const file = path.join(dir, 'device-identity.json')
  const ident = makePemIdentity()
  writeIdentityFile(file, {
    publicKeyB64: ident.publicKeyB64,
    deviceId: ident.deviceId,
    clientId: ident.clientId,
    createdAt: '2026-01-01T00:00:00.000Z',
  }, ident.privateKeyPem)
  const row = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(row.privateKeyEnc)
  assert.equal(row.privateKeyPem, undefined)
  assert.equal(row.schemaVersion, 2)
  assert.equal(row.machineBindingVersion, 1)
  resetSafeStorageForTest()
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('legacy import rejects undecryptable Enc even when plaintext pem present', () => {
  withIsolatedMachine(() => {
    resetSafeStorageForTest()
    resetIdentityDepsForTest()
    setSafeStorageForTest({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: () => { throw new Error('fail') },
    })
    setIdentityDepsForTest({ readInstalledAgentName: () => '' })
    const stable = mkdtempSync(path.join(tmpdir(), 'id-imp-'))
    const legacyDir = mkdtempSync(path.join(tmpdir(), 'id-leg-'))
    const ident = makePemIdentity()
    const legacyFile = path.join(legacyDir, 'device-identity.json')
    writeFileSync(legacyFile, JSON.stringify({
      ...ident,
      privateKeyEnc: Buffer.from('foreign-machine').toString('base64'),
      privateKeyPem: ident.privateKeyPem,
    }), 'utf8')
    const result = tryImportLegacyIdentityFile(stable, legacyFile)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'DEVICE_IDENTITY_UNREADABLE')
    resetSafeStorageForTest()
    resetIdentityDepsForTest()
    try { rmSync(stable, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(legacyDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})

test('deleting LOCALAPPDATA userData keeps machine clientId', () => {
  withIsolatedMachine((machineRoot) => {
    const userA = mkdtempSync(path.join(tmpdir(), 'userA-'))
    const first = loadOrCreate(userA)
    try { rmSync(userA, { recursive: true, force: true }) } catch { /* ignore */ }
    const userB = mkdtempSync(path.join(tmpdir(), 'userB-'))
    const second = loadOrCreate(userB)
    assert.equal(second.clientId, first.clientId)
    assert.ok(existsSync(path.join(machineRoot, 'machine', 'device-identity.json')))
    try { rmSync(userB, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})
