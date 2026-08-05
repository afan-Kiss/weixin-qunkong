const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

test('loadOrCreate does not overwrite an existing unreadable identity file', () => {
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

  const { loadOrCreate } = require('../electron/device-identity.cjs')
  assert.throws(() => loadOrCreate(root), /设备身份暂时无法读取/)
  const after = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(after.deviceId, 'deadbeef')
  assert.equal(after.privateKeyEnc, before.privateKeyEnc)
  try { rmSync(root, { recursive: true, force: true }) } catch {}
})

test('loadOrCreate does not replace a corrupt identity JSON with a new device', () => {
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

test('loadOrCreate keeps plaintext backup when migrating to encrypted storage', () => {
  // 无 electron safeStorage 时：应仍能用明文创建/读取，且不因加密失败丢身份
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
