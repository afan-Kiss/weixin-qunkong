'use strict'

/**
 * Machine-scoped WXQK device identity.
 * Path: %PROGRAMDATA%\WXQK\machine\
 * Private key: DPAPI LocalMachine (not Electron user-scoped safeStorage).
 * UI business data stays in %LOCALAPPDATA%\WXQK.
 */

const { createHash, generateKeyPairSync, createPrivateKey, createPublicKey } = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFileSync } = require('child_process')

const IDENTITY_SCHEMA_VERSION = 3
const MACHINE_BINDING_VERSION = 2
const MACHINE_DIR_NAME = 'WXQK'
const MACHINE_SUBDIR = 'machine'
const IDENTITY_FILE = 'device-identity.json'
const SECRET_FILE = 'device-identity.secret'
const CREATE_LOCK = 'identity.create.lock'

/** @type {{ execFileSync?: typeof execFileSync, fs?: typeof fs, platform?: string }} */
let deps = {}

function setMachineIdentityDepsForTest(overrides = {}) {
  deps = { ...deps, ...overrides }
}

function resetMachineIdentityDepsForTest() {
  deps = {}
}

function fsApi() {
  return deps.fs || fs
}

function resolveProgramDataRoot() {
  const allowOverride = process.env.WXQK_ALLOW_MACHINE_DATA_OVERRIDE === '1'
    || String(process.env.NODE_ENV || '').toLowerCase() === 'test'
    || process.env.WXQK_TEST_ALLOW_USER_DATA_DIR === '1'
  if (allowOverride && process.env.WXQK_MACHINE_DATA_DIR && String(process.env.WXQK_MACHINE_DATA_DIR).trim()) {
    return path.resolve(String(process.env.WXQK_MACHINE_DATA_DIR).trim())
  }
  const pd = process.env.ProgramData
    || (process.env.SystemDrive ? path.join(process.env.SystemDrive, 'ProgramData') : '')
    || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(pd, MACHINE_DIR_NAME)
}

function resolveMachineIdentityDir() {
  return path.join(resolveProgramDataRoot(), MACHINE_SUBDIR)
}

function resolveMachineIdentityPaths(rootDir) {
  const dir = rootDir || resolveMachineIdentityDir()
  return {
    dir,
    identityFile: path.join(dir, IDENTITY_FILE),
    secretFile: path.join(dir, SECRET_FILE),
    lockFile: path.join(dir, CREATE_LOCK),
  }
}

function b64(buf) {
  return Buffer.from(buf).toString('base64')
}

/**
 * DPAPI LocalMachine protect/unprotect via PowerShell (cross-user on same PC).
 * @param {'protect'|'unprotect'} mode
 * @param {string} payloadB64
 */
function dpapiLocalMachine(mode, payloadB64) {
  if ((deps.platform || process.platform) !== 'win32') {
    // Non-Windows / unit tests: store opaque base64 as-is when inject not provided
    if (mode === 'protect') return Buffer.from(String(payloadB64 || ''), 'utf8').toString('base64')
    return Buffer.from(String(payloadB64 || ''), 'base64').toString('utf8')
  }
  if (typeof deps.dpapiLocalMachine === 'function') {
    return deps.dpapiLocalMachine(mode, payloadB64)
  }
  const exec = deps.execFileSync || execFileSync
  const scope = '[System.Security.Cryptography.DataProtectionScope]::LocalMachine'
  const input = String(payloadB64 || '').replace(/'/g, "''")
  const ps = mode === 'protect'
    ? [
      `Add-Type -AssemblyName System.Security;`,
      `$b=[Convert]::FromBase64String('${input}');`,
      `$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,${scope});`,
      `[Convert]::ToBase64String($p)`,
    ].join('')
    : [
      `Add-Type -AssemblyName System.Security;`,
      `$b=[Convert]::FromBase64String('${input}');`,
      `$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,${scope});`,
      `[Convert]::ToBase64String($p)`,
    ].join('')
  const out = exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps,
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
  return String(out || '').trim()
}

function encryptPemMachine(pem) {
  const plainB64 = Buffer.from(String(pem || ''), 'utf8').toString('base64')
  return dpapiLocalMachine('protect', plainB64)
}

function decryptPemMachine(encB64) {
  try {
    const plainB64 = dpapiLocalMachine('unprotect', String(encB64 || ''))
    return Buffer.from(plainB64, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

/**
 * Restrict ACL on machine identity dir (best-effort).
 * @param {string} dir
 */
function hardenMachineDirAcl(dir) {
  if ((deps.platform || process.platform) !== 'win32') return { ok: true, skipped: true }
  if (typeof deps.hardenAcl === 'function') return deps.hardenAcl(dir)
  try {
    const exec = deps.execFileSync || execFileSync
    const target = String(dir).replace(/'/g, "''")
    const ps = [
      `$p='${target}';`,
      `icacls $p /inheritance:r | Out-Null;`,
      `icacls $p /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' 'Users:(OI)(CI)RX' | Out-Null;`,
      `'OK'`,
    ].join('')
    exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
      encoding: 'utf8', windowsHide: true, timeout: 20000,
    })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

function verifyKeyPair(privateKeyPem, publicKeyB64) {
  try {
    const priv = createPrivateKey(privateKeyPem)
    const pub = createPublicKey(priv)
    const der = pub.export({ type: 'spki', format: 'der' })
    const raw = der.subarray(der.length - 32)
    const expected = b64(raw)
    return expected === String(publicKeyB64 || '')
  } catch {
    return false
  }
}

function writeMachineIdentityFiles(paths, row, privateKeyPem) {
  const api = fsApi()
  api.mkdirSync(paths.dir, { recursive: true })
  const enc = encryptPemMachine(privateKeyPem)
  if (!enc) {
    const err = new Error('无法使用机器级 DPAPI 保护设备私钥')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }
  const meta = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    machineBindingVersion: MACHINE_BINDING_VERSION,
    publicKeyB64: row.publicKeyB64,
    deviceId: row.deviceId,
    clientId: row.clientId || row.deviceId,
    createdAt: row.createdAt || new Date().toISOString(),
    migratedAt: row.migratedAt || undefined,
    secretFormat: 'dpapi-localmachine-v1',
    // Never write privateKeyPem / privateKeyEnc (user-scope) into ProgramData metadata.
  }
  const tmpMeta = `${paths.identityFile}.tmp`
  const tmpSecret = `${paths.secretFile}.tmp`
  api.writeFileSync(tmpSecret, JSON.stringify({
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    privateKeyEncMachine: enc,
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  api.writeFileSync(tmpMeta, JSON.stringify(meta, null, 2), 'utf8')
  api.renameSync(tmpSecret, paths.secretFile)
  api.renameSync(tmpMeta, paths.identityFile)
  hardenMachineDirAcl(paths.dir)
  return meta
}

function readMachineIdentity(paths) {
  const api = fsApi()
  if (!api.existsSync(paths.identityFile)) return null
  let meta
  try {
    meta = JSON.parse(api.readFileSync(paths.identityFile, 'utf8'))
  } catch {
    const err = new Error('机器身份元数据损坏（不会自动重置）')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }
  if (!api.existsSync(paths.secretFile)) {
    const err = new Error('机器身份私钥文件缺失（不会自动重置）')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }
  let secret
  try {
    secret = JSON.parse(api.readFileSync(paths.secretFile, 'utf8'))
  } catch {
    const err = new Error('机器身份私钥文件损坏（不会自动重置）')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }
  const pem = decryptPemMachine(secret.privateKeyEncMachine)
  if (!pem) {
    const err = new Error('机器身份私钥无法解密（不会自动重置）')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }
  if (!verifyKeyPair(pem, meta.publicKeyB64)) {
    const err = new Error('机器身份公私钥不一致（不会自动重置）')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }
  const deviceId = String(meta.deviceId || '')
  const expectedId = createHash('sha256')
    .update(Buffer.from(String(meta.publicKeyB64 || ''), 'base64'))
    .digest('hex')
  // deviceId should be sha256(public raw); tolerate legacy mismatches only if clientId present
  const clientId = String(meta.clientId || meta.deviceId || '').trim()
  if (!clientId || !deviceId || !meta.publicKeyB64) {
    const err = new Error('机器身份字段不完整（不会自动重置）')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }
  return {
    privateKeyPem: pem,
    publicKeyB64: meta.publicKeyB64,
    deviceId,
    clientId,
    createdAt: meta.createdAt,
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    machineBindingVersion: MACHINE_BINDING_VERSION,
    expectedDeviceId: expectedId,
  }
}

/**
 * Exclusive create lock so two Windows users don't race first identity creation.
 * @param {string} lockFile
 */
function withCreateLock(lockFile, fn) {
  const api = fsApi()
  api.mkdirSync(path.dirname(lockFile), { recursive: true })
  const maxAttempts = 40
  for (let i = 0; i < maxAttempts; i += 1) {
    let fd = null
    try {
      fd = api.openSync(lockFile, 'wx')
      api.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      try {
        return fn()
      } finally {
        try { api.closeSync(fd) } catch { /* ignore */ }
        try { api.unlinkSync(lockFile) } catch { /* ignore */ }
      }
    } catch (err) {
      if (err && (err.code === 'EEXIST' || /EEXIST/i.test(String(err.message || '')))) {
        // Stale lock: if owner PID dead, remove
        try {
          const raw = api.readFileSync(lockFile, 'utf8')
          const row = JSON.parse(raw)
          const pid = Number(row?.pid || 0)
          if (pid > 0) {
            try { process.kill(pid, 0) } catch {
              try { api.unlinkSync(lockFile) } catch { /* ignore */ }
            }
          }
        } catch {
          try { api.unlinkSync(lockFile) } catch { /* ignore */ }
        }
        Atomics.wait?.(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
        // eslint-disable-next-line no-restricted-globals
        const end = Date.now() + 50
        while (Date.now() < end) { /* spin */ }
        continue
      }
      throw err
    }
  }
  const err = new Error('无法获取机器身份创建锁')
  err.code = 'DEVICE_IDENTITY_UNREADABLE'
  throw err
}

function generateFreshIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const publicKeyB64 = b64(pubRaw)
  const deviceId = createHash('sha256').update(pubRaw).digest('hex')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return {
    privateKeyPem,
    publicKeyB64,
    deviceId,
    clientId: deviceId,
    createdAt: new Date().toISOString(),
  }
}

/**
 * Import a validated identity (legacy user-level / portable) into machine store.
 * @param {{ publicKeyB64: string, deviceId: string, clientId?: string, createdAt?: string, privateKeyPem: string }} identity
 * @param {string} [rootDir]
 */
function adoptIdentityIntoMachineStore(identity, rootDir) {
  const paths = resolveMachineIdentityPaths(rootDir)
  if (!verifyKeyPair(identity.privateKeyPem, identity.publicKeyB64)) {
    return { ok: false, code: 'KEY_MISMATCH' }
  }
  return withCreateLock(paths.lockFile, () => {
    const existing = (() => {
      try { return readMachineIdentity(paths) } catch { return null }
    })()
    if (existing) {
      return { ok: true, code: 'ALREADY_EXISTS', identity: existing }
    }
    writeMachineIdentityFiles(paths, {
      publicKeyB64: identity.publicKeyB64,
      deviceId: identity.deviceId,
      clientId: identity.clientId || identity.deviceId,
      createdAt: identity.createdAt || new Date().toISOString(),
      migratedAt: new Date().toISOString(),
    }, identity.privateKeyPem)
    return { ok: true, code: 'ADOPTED', identity: readMachineIdentity(paths) }
  })
}

/**
 * Load or create canonical machine identity.
 * @param {{
 *   rootDir?: string,
 *   candidateIdentities?: Array<{ privateKeyPem: string, publicKeyB64: string, deviceId: string, clientId?: string, createdAt?: string, source?: string }>,
 * }} [opts]
 */
function loadOrCreateMachineIdentity(opts = {}) {
  const paths = resolveMachineIdentityPaths(opts.rootDir)
  const api = fsApi()
  api.mkdirSync(paths.dir, { recursive: true })

  if (api.existsSync(paths.identityFile)) {
    return readMachineIdentity(paths)
  }

  return withCreateLock(paths.lockFile, () => {
    if (api.existsSync(paths.identityFile)) {
      return readMachineIdentity(paths)
    }
    const candidates = Array.isArray(opts.candidateIdentities) ? opts.candidateIdentities : []
    for (const cand of candidates) {
      if (!cand?.privateKeyPem || !cand?.publicKeyB64 || !cand?.deviceId) continue
      if (!verifyKeyPair(cand.privateKeyPem, cand.publicKeyB64)) continue
      writeMachineIdentityFiles(paths, {
        publicKeyB64: cand.publicKeyB64,
        deviceId: cand.deviceId,
        clientId: cand.clientId || cand.deviceId,
        createdAt: cand.createdAt || new Date().toISOString(),
        migratedAt: new Date().toISOString(),
      }, cand.privateKeyPem)
      return readMachineIdentity(paths)
    }
    const fresh = generateFreshIdentity()
    writeMachineIdentityFiles(paths, fresh, fresh.privateKeyPem)
    return {
      ...fresh,
      schemaVersion: IDENTITY_SCHEMA_VERSION,
      machineBindingVersion: MACHINE_BINDING_VERSION,
    }
  })
}

module.exports = {
  IDENTITY_SCHEMA_VERSION,
  MACHINE_BINDING_VERSION,
  MACHINE_DIR_NAME,
  MACHINE_SUBDIR,
  IDENTITY_FILE,
  SECRET_FILE,
  resolveProgramDataRoot,
  resolveMachineIdentityDir,
  resolveMachineIdentityPaths,
  loadOrCreateMachineIdentity,
  adoptIdentityIntoMachineStore,
  verifyKeyPair,
  encryptPemMachine,
  decryptPemMachine,
  hardenMachineDirAcl,
  setMachineIdentityDepsForTest,
  resetMachineIdentityDepsForTest,
  writeMachineIdentityFiles,
  readMachineIdentity,
}
