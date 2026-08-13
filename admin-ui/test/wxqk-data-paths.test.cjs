'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')

const {
  resolveStableUserDataRoot,
  pinStableUserData,
  migrateLegacyPortableUserDataIfNeeded,
  isProtectedWxqkPath,
} = require('../electron/wxqk-data-paths.cjs')

test('stable userData is under LOCALAPPDATA\\WXQK not portable dir', () => {
  const prev = process.env.WXQK_USER_DATA_DIR
  delete process.env.WXQK_USER_DATA_DIR
  process.env.LOCALAPPDATA = path.join(tmpdir(), 'wxqk-localapp')
  const root = resolveStableUserDataRoot()
  assert.match(root.replace(/\//g, '\\'), /WXQK$/i)
  assert.ok(!root.includes('WXQK-Data'))
  if (prev == null) delete process.env.WXQK_USER_DATA_DIR
  else process.env.WXQK_USER_DATA_DIR = prev
})

test('pinStableUserData sets userData before lock consumers', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wxqk-pin-'))
  process.env.WXQK_USER_DATA_DIR = root
  const paths = {}
  pinStableUserData({
    setPath(name, p) { paths[name] = p },
  })
  assert.equal(paths.userData, root)
  assert.ok(String(paths.sessionData || '').includes('session'))
  delete process.env.WXQK_USER_DATA_DIR
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('legacy portable migration copies session but not identity overwrite', () => {
  const stable = mkdtempSync(path.join(tmpdir(), 'wxqk-stable-'))
  const legacy = mkdtempSync(path.join(tmpdir(), 'wxqk-legacy-'))
  mkdirSync(path.join(legacy, 'security'), { recursive: true })
  writeFileSync(path.join(legacy, 'account-session.bin'), 'sess', 'utf8')
  writeFileSync(path.join(legacy, 'security', 'device-identity.json'), JSON.stringify({
    clientId: 'aaa',
    deviceId: 'aaa',
    privateKeyPem: 'PLAIN',
    publicKeyB64: 'x',
  }), 'utf8')

  const first = migrateLegacyPortableUserDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(first.migrated, true)
  assert.ok(existsSync(path.join(stable, 'account-session.bin')))
  assert.equal(existsSync(path.join(stable, 'security', 'device-identity.json')), false)

  // Idempotent
  const second = migrateLegacyPortableUserDataIfNeeded({
    stableUserDataDir: stable,
    legacyPortableUserDataDir: legacy,
  })
  assert.equal(second.reason, 'already_migrated')

  try { rmSync(stable, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(legacy, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('isProtectedWxqkPath blocks Program Files agent and security identity', () => {
  assert.equal(isProtectedWxqkPath('C:\\Program Files\\WXQK\\WXQK.exe'), true)
  assert.equal(isProtectedWxqkPath('C:\\Temp\\foo.tmp'), false)
  const prev = process.env.WXQK_USER_DATA_DIR
  const root = mkdtempSync(path.join(tmpdir(), 'wxqk-prot-'))
  process.env.WXQK_USER_DATA_DIR = root
  assert.equal(isProtectedWxqkPath(path.join(root, 'security', 'device-identity.json')), true)
  if (prev == null) delete process.env.WXQK_USER_DATA_DIR
  else process.env.WXQK_USER_DATA_DIR = prev
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})
