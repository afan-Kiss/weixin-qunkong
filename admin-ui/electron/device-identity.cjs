'use strict'

/**
 * Device identity — machine-bound via Windows safeStorage (DPAPI) when available.
 * Never recreate identity when decrypt fails (DEVICE_IDENTITY_UNREADABLE).
 * Legacy portable clones must not inherit another PC's clientId.
 */

const { createHash, generateKeyPairSync, randomBytes, sign, createPrivateKey } = require('crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const path = require('path')
const { getProtocol, getBuildIdPrefix, getAgentWsPath } = require('./secure-config.cjs')

const packageInfo = require('../package.json')
const VERSION = packageInfo.version
const BUILD_ID = `${getBuildIdPrefix()}${VERSION}`
const RELEASE_SEQUENCE = String(packageInfo.releaseSequence || '1')
const PROTOCOL = getProtocol()
const IDENTITY_SCHEMA_VERSION = 2

let safeStorageRef = null
try {
  safeStorageRef = require('electron').safeStorage
} catch {
  safeStorageRef = null
}

/** @type {{ readInstalledAgentName?: () => string, fs?: typeof import('fs') }} */
let identityDeps = {}

function setIdentityDepsForTest(overrides = {}) {
  identityDeps = { ...identityDeps, ...overrides }
}

function resetIdentityDepsForTest() {
  identityDeps = {}
}

/** @type {import('electron').SafeStorage | null | undefined} */
let safeStorageOverride = undefined

/**
 * Inject safeStorage double for unit tests (undefined = use electron module).
 * @param {import('electron').SafeStorage | null | undefined} store
 */
function setSafeStorageForTest(store) {
  safeStorageOverride = store
}

function resetSafeStorageForTest() {
  safeStorageOverride = undefined
}

function activeSafeStorage() {
  if (safeStorageOverride !== undefined) return safeStorageOverride
  return safeStorageRef
}

function b64(buf) {
  return Buffer.from(buf).toString('base64')
}

/**
 * @param {import('electron').SafeStorage | null} store
 * @param {string} pem
 */
function encryptPem(store, pem) {
  if (store && store.isEncryptionAvailable()) return store.encryptString(pem).toString('base64')
  return null
}

/**
 * @param {import('electron').SafeStorage | null} store
 * @param {string} encoded
 */
function decryptPem(store, encoded) {
  if (!store || !store.isEncryptionAvailable()) return ''
  try {
    return store.decryptString(Buffer.from(String(encoded || ''), 'base64'))
  } catch {
    return ''
  }
}

function encryptionAvailable(store = safeStorageRef) {
  try {
    return Boolean(store && store.isEncryptionAvailable && store.isEncryptionAvailable())
  } catch {
    return false
  }
}

/**
 * Read agentName from installed branded WXQK.msh (local ownership evidence).
 * @returns {string}
 */
function readInstalledWxqkAgentName() {
  if (typeof identityDeps.readInstalledAgentName === 'function') {
    return String(identityDeps.readInstalledAgentName() || '').trim()
  }
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const candidates = [
    path.join(pf, 'WXQK', 'WXQK.msh'),
    path.join(pf, 'WXQK', 'WXQK', 'WXQK.msh'),
  ]
  const fsApi = identityDeps.fs || { existsSync, readFileSync }
  for (const msh of candidates) {
    try {
      if (!fsApi.existsSync(msh)) continue
      const text = fsApi.readFileSync(msh, 'utf8')
      const m = String(text).match(/^agentName=(.+)$/im)
      if (m) return String(m[1] || '').trim()
    } catch { /* continue */ }
  }
  return ''
}

/**
 * Whether a legacy identity row may be adopted on this machine (anti-clone).
 * @param {Record<string, unknown>} raw
 * @param {string} privateKeyPem
 * @param {boolean} decryptedViaDpapi
 */
function canAdoptLegacyIdentity(raw, privateKeyPem, decryptedViaDpapi) {
  if (!privateKeyPem || !raw?.publicKeyB64 || !raw?.deviceId) return { ok: false, reason: 'incomplete' }
  if (decryptedViaDpapi) return { ok: true, reason: 'dpapi' }

  // Plaintext-only legacy: require local Agent msh to already claim this clientId
  const clientId = String(raw.clientId || raw.deviceId || '').trim()
  if (!clientId) return { ok: false, reason: 'no_client_id' }
  const agentName = readInstalledWxqkAgentName()
  const expected = `WXQK-${clientId}`
  if (agentName && agentName === expected) {
    return { ok: true, reason: 'local_msh_agentName_match' }
  }
  return { ok: false, reason: 'clone_rejected' }
}

/**
 * Persist identity without long-lived plaintext when DPAPI is available.
 * @param {string} file
 * @param {Record<string, unknown>} row
 * @param {string} privateKeyPem
 */
function writeIdentityFile(file, row, privateKeyPem) {
  const store = activeSafeStorage()
  const enc = encryptPem(store, privateKeyPem)
  const out = {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    publicKeyB64: row.publicKeyB64,
    deviceId: row.deviceId,
    clientId: row.clientId || row.deviceId,
    createdAt: row.createdAt || new Date().toISOString(),
    migratedAt: row.migratedAt || undefined,
    machineBindingVersion: 1,
  }
  if (enc) {
    out.privateKeyEnc = enc
    // Do NOT persist privateKeyPem when encryption works (anti portable-folder clone)
  } else {
    // Test / non-electron environments without DPAPI
    out.privateKeyPem = privateKeyPem
  }
  writeFileSync(file, JSON.stringify(out, null, 2), 'utf8')
  return out
}

/**
 * @param {string} userDataDir
 */
function loadOrCreate(userDataDir) {
  const dir = path.join(userDataDir, 'security')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'device-identity.json')
  const store = activeSafeStorage()
  if (existsSync(file)) {
    let raw = null
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      raw = null
    }
    if (raw && typeof raw === 'object') {
      let privateKeyPem = ''
      let decryptedViaDpapi = false
      if (raw.privateKeyEnc) {
        privateKeyPem = decryptPem(store, raw.privateKeyEnc)
        decryptedViaDpapi = Boolean(privateKeyPem)
      }

      if (!privateKeyPem && raw.privateKeyPem) {
        if (raw.privateKeyEnc && encryptionAvailable(store) && !decryptedViaDpapi) {
          // Enc present but undecryptable — never fall back to plaintext
          const err = new Error('设备身份暂时无法读取，请稍后重试或联系客服（不会自动重置）')
          err.code = 'DEVICE_IDENTITY_UNREADABLE'
          throw err
        }
        // Local stable plaintext (legacy format): allow once, then rewrite encrypted without plaintext
        privateKeyPem = String(raw.privateKeyPem)
      }

      if (privateKeyPem && raw.publicKeyB64 && raw.deviceId) {
        try {
          writeIdentityFile(file, {
            publicKeyB64: raw.publicKeyB64,
            deviceId: raw.deviceId,
            clientId: raw.clientId || raw.deviceId,
            createdAt: raw.createdAt || new Date().toISOString(),
            migratedAt: new Date().toISOString(),
          }, privateKeyPem)
        } catch { /* ignore rewrite failures; still return usable identity */ }
        return {
          privateKeyPem,
          publicKeyB64: raw.publicKeyB64,
          deviceId: raw.deviceId,
          clientId: raw.clientId || raw.deviceId,
          createdAt: raw.createdAt,
          schemaVersion: IDENTITY_SCHEMA_VERSION,
        }
      }
    }
    const err = new Error('设备身份暂时无法读取，请稍后重试或联系客服（不会自动重置）')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }

  // Fresh identity
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const publicKeyB64 = b64(pubRaw)
  const deviceId = createHash('sha256').update(pubRaw).digest('hex')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeIdentityFile(file, {
    publicKeyB64,
    deviceId,
    clientId: deviceId,
    createdAt: new Date().toISOString(),
  }, privateKeyPem)
  return {
    privateKeyPem,
    publicKeyB64,
    deviceId,
    clientId: deviceId,
    createdAt: new Date().toISOString(),
    schemaVersion: IDENTITY_SCHEMA_VERSION,
  }
}

/**
 * Try importing a staged legacy identity file into stable security dir with clone checks.
 * @param {string} userDataDir stable userData
 * @param {string} legacyIdentityPath
 */
function tryImportLegacyIdentityFile(userDataDir, legacyIdentityPath) {
  const fsApi = identityDeps.fs || { existsSync, readFileSync, mkdirSync, writeFileSync }
  if (!legacyIdentityPath || !fsApi.existsSync(legacyIdentityPath)) {
    return { ok: false, code: 'NO_LEGACY', message: 'no legacy identity' }
  }
  const destDir = path.join(userDataDir, 'security')
  const dest = path.join(destDir, 'device-identity.json')
  if (fsApi.existsSync(dest)) {
    return { ok: false, code: 'STABLE_EXISTS', message: 'stable identity already present' }
  }
  let raw
  try {
    raw = JSON.parse(fsApi.readFileSync(legacyIdentityPath, 'utf8'))
  } catch {
    return { ok: false, code: 'LEGACY_CORRUPT', message: 'legacy identity unreadable' }
  }
  let privateKeyPem = ''
  let viaDpapi = false
  if (raw.privateKeyEnc) {
    privateKeyPem = decryptPem(activeSafeStorage(), raw.privateKeyEnc)
    viaDpapi = Boolean(privateKeyPem)
  }
  if (!privateKeyPem && raw.privateKeyEnc && encryptionAvailable(activeSafeStorage())) {
    // Encrypted identity from another machine / corrupted DPAPI — never fall back to plaintext clone
    if (raw.privateKeyPem) {
      return {
        ok: false,
        code: 'DEVICE_IDENTITY_UNREADABLE',
        message: 'legacy privateKeyEnc 无法在本机解密，拒绝用明文克隆',
      }
    }
    return {
      ok: false,
      code: 'DEVICE_IDENTITY_UNREADABLE',
      message: 'legacy privateKeyEnc 无法在本机解密',
    }
  }
  if (!privateKeyPem && raw.privateKeyPem) {
    privateKeyPem = String(raw.privateKeyPem)
  }
  const adopt = canAdoptLegacyIdentity(raw, privateKeyPem, viaDpapi)
  if (!adopt.ok) {
    return { ok: false, code: 'DEVICE_IDENTITY_CLONE_REJECTED', reason: adopt.reason, message: '拒绝导入可能克隆的设备身份' }
  }
  fsApi.mkdirSync(destDir, { recursive: true })
  writeIdentityFile(dest, {
    publicKeyB64: raw.publicKeyB64,
    deviceId: raw.deviceId,
    clientId: raw.clientId || raw.deviceId,
    createdAt: raw.createdAt || new Date().toISOString(),
    migratedAt: new Date().toISOString(),
  }, privateKeyPem)
  return {
    ok: true,
    code: 'OK',
    reason: adopt.reason,
    clientId: String(raw.clientId || raw.deviceId),
  }
}

function signRaw(identity, message) {
  const key = createPrivateKey(identity.privateKeyPem)
  const sig = sign(null, Buffer.from(message), key)
  return b64(sig)
}

function bodyHash(body) {
  return createHash('sha256').update(body || Buffer.alloc(0)).digest('hex')
}

function newNonce() {
  return randomBytes(12).toString('hex')
}

function authHeaders(identity, method, reqPath, bodyBuf) {
  const ts = Math.floor(Date.now() / 1000)
  const nonce = newNonce()
  const bh = bodyHash(bodyBuf)
  const msg = `${method.toUpperCase()}\n${reqPath}\n${bh}\n${ts}\n${nonce}\n${BUILD_ID}\n${RELEASE_SEQUENCE}\n${identity.deviceId}`
  const signature = signRaw(identity, msg)
  return {
    'X-Build-Id': BUILD_ID,
    'X-Client-Version': VERSION,
    'X-Protocol-Version': PROTOCOL.protocolVersion,
    'X-Security-Protocol-Version': PROTOCOL.securityProtocolVersion,
    'X-Desktop-Protocol-Version': PROTOCOL.desktopProtocolVersion,
    'X-Updater-Protocol-Version': PROTOCOL.updaterProtocolVersion,
    'X-Release-Sequence': RELEASE_SEQUENCE,
    'X-Device-Id': identity.deviceId,
    'X-Device-Timestamp': String(ts),
    'X-Device-Nonce': nonce,
    'X-Device-Signature': signature,
  }
}

function agentWsRequestPath() {
  return getAgentWsPath()
}

module.exports = {
  BUILD_ID,
  VERSION,
  RELEASE_SEQUENCE,
  PROTOCOL,
  IDENTITY_SCHEMA_VERSION,
  loadOrCreate,
  tryImportLegacyIdentityFile,
  canAdoptLegacyIdentity,
  readInstalledWxqkAgentName,
  encryptionAvailable,
  writeIdentityFile,
  signRaw,
  authHeaders,
  bodyHash,
  agentWsRequestPath,
  setIdentityDepsForTest,
  resetIdentityDepsForTest,
  setSafeStorageForTest,
  resetSafeStorageForTest,
}
