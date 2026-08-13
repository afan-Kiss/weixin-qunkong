const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const machine = require('../electron/machine-identity.cjs')

function withIsolatedMachine(fn) {
  const machineRoot = mkdtempSync(path.join(tmpdir(), 'machine-safe-'))
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

test('loadOrCreate does not overwrite an existing unreadable identity file', () => {
  withIsolatedMachine(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'ident-'))
    const security = path.join(root, 'security')
    mkdirSync(security, { recursive: true })
    const file = path.join(security, 'device-identity.json')
    const before = {
      privateKeyEnc: 'not-valid-base64-cipher',
      publicKeyB64: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=',
      deviceId: 'deadbeef',
      clientId: 'deadbeef',
      createdAt: '2026-01-01T00:00:00.000Z',
    }
    writeFileSync(file, JSON.stringify(before, null, 2), 'utf8')

    const { loadOrCreate, setSafeStorageForTest, resetSafeStorageForTest } = require('../electron/device-identity.cjs')
    setSafeStorageForTest({
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: () => { throw new Error('fail') },
    })
    assert.throws(() => loadOrCreate(root), /设备身份暂时无法读取/)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(after.deviceId, 'deadbeef')
    assert.equal(after.privateKeyEnc, before.privateKeyEnc)
    resetSafeStorageForTest()
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

test('loadOrCreate does not replace a corrupt identity JSON with a new device', () => {
  withIsolatedMachine(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'ident-bad-'))
    const security = path.join(root, 'security')
    mkdirSync(security, { recursive: true })
    const file = path.join(security, 'device-identity.json')
    writeFileSync(file, '{not-json', 'utf8')
    const before = readFileSync(file, 'utf8')
    const { loadOrCreate } = require('../electron/device-identity.cjs')
    assert.throws(() => loadOrCreate(root), /设备身份暂时无法读取/)
    assert.equal(readFileSync(file, 'utf8'), before)
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})

test('loadOrCreate keeps stable machine identity across reloads', () => {
  withIsolatedMachine(() => {
    const root = mkdtempSync(path.join(tmpdir(), 'ident2-'))
    const { loadOrCreate } = require('../electron/device-identity.cjs')
    const first = loadOrCreate(root)
    assert.ok(first.deviceId)
    assert.ok(first.privateKeyPem.includes('PRIVATE KEY'))
    const second = loadOrCreate(root)
    assert.equal(second.deviceId, first.deviceId)
    assert.equal(second.clientId, first.clientId)
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  })
})
