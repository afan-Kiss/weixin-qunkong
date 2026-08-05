const { createHash, generateKeyPairSync, randomBytes, sign, createPrivateKey } = require('crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const path = require('path')
const { getProtocol, getBuildIdPrefix, getAgentWsPath } = require('./secure-config.cjs')

const packageInfo = require('../package.json')
const VERSION = packageInfo.version
const BUILD_ID = `${getBuildIdPrefix()}${VERSION}`
/** 与服务端 releaseSequence 对齐；由 bump-version.cjs 在打包时递增（兼容旧字段名） */
const RELEASE_SEQUENCE = String(packageInfo.releaseSequence || '1')
const PROTOCOL = getProtocol()

let safeStorageRef = null
try {
  // electron 在非 electron 进程 require 会失败；测试环境跳过加密
  safeStorageRef = require('electron').safeStorage
} catch {
  safeStorageRef = null
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

/**
 * 加载或创建设备身份；私钥优先走 OS safeStorage，启动时迁移旧明文。
 * 已有身份文件时绝不会因解密失败而覆盖成新设备（避免客户机变成“新机器”）。
 * @param {string} userDataDir
 */
function loadOrCreate(userDataDir) {
  const dir = path.join(userDataDir, 'security')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'device-identity.json')
  const store = safeStorageRef
  if (existsSync(file)) {
    let raw = null
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      raw = null
    }
    if (raw && typeof raw === 'object') {
      let privateKeyPem = ''
      if (raw.privateKeyEnc) {
        privateKeyPem = decryptPem(store, raw.privateKeyEnc)
      }
      // 解密失败时仍可用明文备份；迁移成功后暂保留明文一档，避免个别机器 DPAPI 异常丢身份
      if (!privateKeyPem && raw.privateKeyPem) {
        privateKeyPem = String(raw.privateKeyPem)
      }
      if (privateKeyPem && raw.publicKeyB64 && raw.deviceId) {
        const enc = encryptPem(store, privateKeyPem)
        if (enc && !raw.privateKeyEnc) {
          try {
            writeFileSync(file, JSON.stringify({
              privateKeyEnc: enc,
              // 保留明文备份：仅当系统加密可用时仍双写，防止偶发解密失败丢掉设备
              privateKeyPem,
              publicKeyB64: raw.publicKeyB64,
              deviceId: raw.deviceId,
              clientId: raw.clientId || raw.deviceId,
              createdAt: raw.createdAt || new Date().toISOString(),
              migratedAt: new Date().toISOString(),
            }, null, 2), 'utf8')
          } catch { /* ignore */ }
        } else if (!raw.clientId) {
          try {
            writeFileSync(file, JSON.stringify({ ...raw, clientId: raw.deviceId }, null, 2), 'utf8')
          } catch { /* ignore */ }
        }
        return {
          privateKeyPem,
          publicKeyB64: raw.publicKeyB64,
          deviceId: raw.deviceId,
          clientId: raw.clientId || raw.deviceId,
          createdAt: raw.createdAt,
        }
      }
    }
    // 已有身份文件时绝不能覆盖成新设备（含 JSON 损坏、解密失败、字段残缺）
    const err = new Error('设备身份暂时无法读取，请稍后重试或联系客服（不会自动重置）')
    err.code = 'DEVICE_IDENTITY_UNREADABLE'
    throw err
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const publicKeyB64 = b64(pubRaw)
  const deviceId = createHash('sha256').update(pubRaw).digest('hex')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const enc = encryptPem(store, privateKeyPem)
  const row = {
    publicKeyB64,
    deviceId,
    clientId: deviceId,
    createdAt: new Date().toISOString(),
    privateKeyPem,
  }
  if (enc) row.privateKeyEnc = enc
  writeFileSync(file, JSON.stringify(row, null, 2), 'utf8')
  return { ...row, privateKeyPem }
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

/** WS 握手路径（与服务端一致，字面量不落源码） */
function agentWsRequestPath() {
  return getAgentWsPath()
}

module.exports = {
  BUILD_ID,
  VERSION,
  RELEASE_SEQUENCE,
  PROTOCOL,
  loadOrCreate,
  signRaw,
  authHeaders,
  bodyHash,
  agentWsRequestPath,
}
