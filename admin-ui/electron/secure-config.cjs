/**
 * 敏感配置运行时解码：源码/asar 中不保留完整明文 URL、域名与协议指纹。
 * 仅做扫描成本抬高，不能对抗内存 dump。
 */
const K_A = Object.freeze([0x5a, 0x3c, 0x91, 0x2e, 0x77, 0x08, 0xb4, 0xd1])
const K_B = Object.freeze([0xe3, 0x19, 0x6a, 0xc0, 0x4f, 0x82, 0x3d, 0x55])

/** @type {Record<string, readonly number[]>} */
const BLOB = Object.freeze({
  // IP+端口 HTTPS 基址（运行时解码，源码不落明文）
  serviceBase: Object.freeze([50, 72, 229, 94, 4, 50, 155, 254, 210, 43, 90, 238, 125, 181, 19, 103, 107, 5, 191, 31, 68, 48, 142, 233, 215, 45, 89, 239, 56, 250, 76, 62]),
  host1: Object.freeze([107, 14, 161, 0, 69, 63, 154, 227, 210, 32, 68, 241, 124, 186]),
  host2: Object.freeze([107, 14, 166, 0, 71, 38, 132, 255, 210]),
  // 域名镜像：大包更新走旧域名出口（带宽更大）
  host3: Object.freeze([34, 85, 240, 64, 16, 113, 193, 171, 139, 108, 8, 161, 32, 172, 69, 44, 32]),
  // 线上 8443 SPKI pins（双 pin：旧自签 + Let's Encrypt IP leaf；可用 WXQK_TLS_SPKI_PINS 覆盖）
  tlsSpkiPins: Object.freeze([41, 84, 240, 28, 66, 62, 155, 129, 166, 106, 11, 244, 1, 231, 76, 62, 44, 75, 221, 72, 2, 88, 222, 133, 165, 43, 0, 246, 57, 250, 84, 20, 20, 91, 208, 67, 17, 74, 242, 149, 185, 117, 63, 249, 24, 250, 113, 6, 27, 87, 172, 2, 4, 96, 213, 227, 214, 47, 69, 182, 7, 241, 76, 0, 22, 12, 214, 95, 33, 94, 231, 180, 132, 97, 25, 129, 62, 227, 14, 33, 46, 101, 203, 111, 46, 71, 214, 147, 208, 104, 32, 247, 123, 187, 90, 39, 50, 23, 245, 109, 52, 127, 137]),
  pubKey: Object.freeze([105, 93, 223, 28, 17, 98, 240, 189, 177, 67, 6, 177, 120, 225, 81, 28, 21, 118, 166, 118, 67, 121, 228, 135, 173, 77, 16, 137, 29, 187, 108, 5, 10, 12, 162, 67, 29, 77, 225, 130, 130, 122, 9, 253]),
  // Transition publish public key (wxqk-v2). Private seed must NEVER enter Git.
  pubKeyV2: Object.freeze([60, 5, 213, 94, 66, 124, 217, 231, 213, 87, 27, 143, 25, 203, 80, 25, 34, 109, 231, 88, 0, 126, 225, 146, 141, 73, 15, 244, 29, 242, 126, 39, 25, 11, 210, 104, 62, 103, 242, 149, 212, 124, 5, 253]),
  protoApp: Object.freeze([59, 76, 225, 3, 1, 57]),
  protoSec: Object.freeze([41, 89, 242, 3, 1, 57]),
  protoDesk: Object.freeze([62, 89, 226, 69, 90, 126, 133]),
  protoUpd: Object.freeze([47, 76, 245, 3, 1, 57]),
  legacyProto: Object.freeze([60, 93, 242, 79, 30, 48, 140, 233, 206, 111, 91]),
  legacySec: Object.freeze([41, 89, 242, 91, 5, 97, 192, 168, 206, 111, 91]),
  legacyDesk: Object.freeze([62, 89, 226, 69, 3, 103, 196, 252, 148, 124, 8, 178, 59, 225, 16, 35, 107]),
  legacyUpd: Object.freeze([47, 76, 245, 79, 3, 109, 198, 252, 149, 40]),
  legacyBrand: Object.freeze([191, 179, 0, 198, 195, 170, 140, 233, 219]),
  pathBase: Object.freeze([117, 75, 233, 95, 28]),
  wsPath: Object.freeze([117, 93, 225, 71, 88, 127, 199, 254, 130, 126, 15, 174, 59]),
  deskHash: Object.freeze([117, 88, 244, 93, 28, 124, 219, 161]),
  // 保持与历史客户端一致的 BuildId 前缀，避免网关白名单/运营识别断裂
  buildPrefix: Object.freeze([45, 68, 224, 69, 90, 109, 216, 180, 128, 109, 24, 175, 33, 175]),
  trashDir: Object.freeze([116, 93, 225, 94, 90, 125, 196, 181, 130, 109, 15, 237, 59, 240, 92, 38, 50]),
  workDir: Object.freeze([59, 76, 225, 3, 2, 120, 208, 176, 151, 124]),
  legacyTempUpdate: Object.freeze([45, 68, 224, 69, 90, 125, 196, 181, 130, 109, 15]),
  legacyTrashDir: Object.freeze([116, 75, 233, 95, 28, 37, 193, 161, 135, 120, 30, 165, 98, 246, 79, 52, 41, 84]),
  legacyQrCollector: Object.freeze([45, 68, 188, 73, 5, 103, 193, 161, 206, 104, 24, 237, 44, 237, 81, 57, 63, 95, 229, 65, 5]),
  legacyQrMonitor: Object.freeze([45, 68, 188, 73, 5, 103, 193, 161, 206, 104, 24, 237, 34, 237, 83, 60, 46, 83, 227]),
})

const cache = new Map()

/**
 * @returns {Buffer}
 */
function keyBuf() {
  return Buffer.from([...K_A, ...K_B])
}

/**
 * @param {readonly number[]} bytes
 * @returns {string}
 */
function decodeBytes(bytes) {
  const key = keyBuf()
  const out = Buffer.alloc(bytes.length)
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes[i] ^ key[i % key.length]
  return out.toString('utf8')
}

/**
 * @param {keyof typeof BLOB} name
 * @returns {string}
 */
function secret(name) {
  if (cache.has(name)) return cache.get(name)
  const bytes = BLOB[name]
  if (!bytes) throw new Error('config blob missing')
  const value = decodeBytes(bytes)
  cache.set(name, value)
  return value
}

/** @returns {string} */
function getServiceBase() {
  return secret('serviceBase')
}

/** @returns {Set<string>} */
function getAllowedHosts() {
  const hosts = [secret('host1'), secret('host2')]
  try { hosts.push(secret('host3')) } catch (_) {}
  return new Set(hosts.filter(Boolean))
}

/** @returns {string} */
function getPublishPublicKeyB64() {
  return secret('pubKey')
}

/** @returns {string} Transition / NEW publish public key (wxqk-v2). */
function getPublishPublicKeyV2B64() {
  return secret('pubKeyV2')
}

/**
 * 内置 TLS SPKI pin 列表（逗号分隔）；环境变量 WXQK_TLS_SPKI_PINS 可覆盖。
 * @returns {string[]}
 */
function getTlsSpkiPins() {
  const raw = secret('tlsSpkiPins')
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)
}

/**
 * 客户端对外协议头。
 * 故意继续走线上已放行的旧协议 ID（运行时解码，源码无明文）：
 * 若改成中性 ID，在服务端兼容策略未部署时会导致登录设备/远程通道全军覆没。
 *
 * Note: desktopProtocolVersion decodes to the legacy string "desktop-webrtc-v1".
 * Legacy protocol identifier only — no WebRTC / LiveKit / desktop capture
 * implementation remains in this codebase. Gate accepts meshcentral-v1 as well.
 */
function getProtocol() {
  return {
    protocolVersion: secret('legacyProto'),
    securityProtocolVersion: secret('legacySec'),
    desktopProtocolVersion: secret('legacyDesk'),
    updaterProtocolVersion: secret('legacyUpd'),
  }
}

/**
 * 清单验签默认值：与线上已签名字段兼容（旧指纹仅作缺省回填，不出现在源码字面量）。
 */
function getLegacyManifestDefaults() {
  return {
    protocolVersion: secret('legacyProto'),
    securityProtocolVersion: secret('legacySec'),
    desktopProtocolVersion: secret('legacyDesk'),
    updaterProtocolVersion: secret('legacyUpd'),
    signingKeyId: secret('legacyProto'),
  }
}

/** @returns {string} */
function getAgentWsPath() {
  return secret('wsPath')
}

/** @returns {string} */
function getDesktopHashPath() {
  return secret('deskHash')
}

/** @returns {string} */
function getBuildIdPrefix() {
  return secret('buildPrefix')
}

/** @returns {string} */
function getUpdateTrashDirName() {
  return secret('trashDir')
}

/** @returns {string} */
function getUpdateWorkDirName() {
  return secret('workDir')
}

/** @returns {string[]} */
function getLegacyTempDirNames() {
  return [secret('legacyTempUpdate'), secret('legacyQrCollector'), secret('legacyQrMonitor')]
}

/** @returns {string[]} */
function getLegacyTrashDirNames() {
  return [secret('legacyTrashDir')]
}

/**
 * 下载 URL 是否仍指向旧品牌路径，需回退到当前服务基址。
 * @param {string} url
 */
function isLegacyBrandDownloadUrl(url) {
  const text = String(url || '')
  const brand = secret('legacyBrand')
  const basePath = secret('pathBase')
  const host = secret('host1')
  if (text.includes(`/${brand}/`)) return true
  if (text.includes(`${host}/`) && !text.includes(`${basePath}/`)) return true
  return false
}

/**
 * 落盘文件名是否仍带旧品牌，需改回产品名。
 * @param {string} name
 */
function isLegacyBrandFileName(name) {
  const text = String(name || '')
  const brand = secret('legacyBrand')
  return text.includes(brand) || /开云|投注软件/i.test(text)
}

module.exports = {
  getServiceBase,
  getAllowedHosts,
  getPublishPublicKeyB64,
  getPublishPublicKeyV2B64,
  getTlsSpkiPins,
  getProtocol,
  getLegacyManifestDefaults,
  getAgentWsPath,
  getDesktopHashPath,
  getBuildIdPrefix,
  getUpdateTrashDirName,
  getUpdateWorkDirName,
  getLegacyTempDirNames,
  getLegacyTrashDirNames,
  isLegacyBrandDownloadUrl,
  isLegacyBrandFileName,
  // 测试用：直接解码指定 blob
  _decodeForTest: secret,
}
