const { createHash, generateKeyPairSync, randomBytes, sign, createPrivateKey } = require('crypto')
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const path = require('path')

const packageInfo = require('../package.json')
const VERSION = packageInfo.version
const BUILD_ID = `wxqk-electron-${VERSION}`
/** 与服务端 releaseSequence 对齐；由 bump-version.cjs 在打包时递增 */
const RELEASE_SEQUENCE = String(packageInfo.wxqkReleaseSequence || '1')
const PROTOCOL = {
  protocolVersion: 'facai888-v1',
  securityProtocolVersion: 'security-v1',
  desktopProtocolVersion: 'desktop-webrtc-v1',
  updaterProtocolVersion: 'updater-v1',
}

function b64(buf) {
  return Buffer.from(buf).toString('base64')
}

function loadOrCreate(userDataDir) {
  const dir = path.join(userDataDir, 'security')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'device-identity.json')
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw.privateKeyPem && raw.publicKeyB64 && raw.deviceId) {
        if (!raw.clientId) {
          raw.clientId = raw.deviceId
          try { writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8') } catch {}
        }
        return raw
      }
    } catch {}
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })
  // SPKI for Ed25519 is 44 bytes; raw key is last 32.
  const pubRaw = pubDer.subarray(pubDer.length - 32)
  const publicKeyB64 = b64(pubRaw)
  const deviceId = createHash('sha256').update(pubRaw).digest('hex')
  const row = {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyB64,
    deviceId,
    clientId: deviceId,
    createdAt: new Date().toISOString(),
  }
  writeFileSync(file, JSON.stringify(row, null, 2), 'utf8')
  return row
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

module.exports = {
  BUILD_ID,
  VERSION,
  RELEASE_SEQUENCE,
  PROTOCOL,
  loadOrCreate,
  signRaw,
  authHeaders,
  bodyHash,
}
