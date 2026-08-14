/**
 * 静默更新客户端：启动检查 → 下载/进度 → 替换 → 重启。
 * 生产环境强制校验清单 Ed25519 签名。
 */
const { createHash, createPublicKey, verify } = require('crypto')
const {
  copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync,
  unlinkSync, statSync, writeFileSync, readFileSync, rmSync, readdirSync,
  openSync, ftruncateSync, closeSync,
} = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const { spawn } = require('child_process')
const {
  getServiceBase,
  getAllowedHosts,
  getPublishPublicKeyB64,
  getLegacyManifestDefaults,
  getUpdateTrashDirName,
  getUpdateWorkDirName,
  getLegacyTrashDirNames,
  isLegacyBrandDownloadUrl,
  isLegacyBrandFileName,
} = require('./secure-config.cjs')
const { insecureTlsForService } = require('./service-tls.cjs')
const {
  POLICY,
  normalizeTargetClientIds,
  resolveUpdatePolicy,
  isForcedPolicy,
} = require('./update-policy.cjs')
const {
  mergeIntervals,
  completedUniqueBytes,
  rangesFromDoneParts,
  normalizeRanges,
} = require('./update-ranges.cjs')
const {
  DRAIN_STATE,
  collectActiveCriticalWork,
  waitForUpdateDrain,
  beginUpdateDrain,
  endUpdateDrain,
  canAcceptNewWork,
  isUpdateDrainActive,
  setUpdateDrainActive,
} = require('./update-drain.cjs')
const updateState = require('./update-state.cjs')
const updateHandoff = require('./update-handoff.cjs')

const DEFAULT_BASE = getServiceBase()
const BUILTIN_PUBLISH_PUBLIC_KEY_B64 = getPublishPublicKeyB64()
const ALLOWED_DOWNLOAD_HOSTS = getAllowedHosts()
const UPDATE_TRASH_DIR = getUpdateTrashDirName()
const UPDATE_OLD_TRASH_ENV = 'APP_UPDATE_OLD_TRASH'
/** 旧版客户端写入的环境变量，升级到本版后仍需能删掉旧 exe */
const LEGACY_UPDATE_OLD_TRASH_ENV = 'WXQK_UPDATE_OLD_TRASH'
const HIGHEST_SEEN_SEQ_FILE = 'update-highest-seen-seq.json'
const PORTABLE_CURRENT_MARKER = 'current-portable-exe.json'
const PORTABLE_READY_MARKER = 'update-ready.marker'
const STARTUP_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000]
const PERIODIC_CHECK_MS = 5 * 60 * 60 * 1000
const PERIODIC_JITTER_MS = 30 * 60 * 1000

let allowUnsignedForTest = false
let startupApplyAllowed = true
let applying = false
let startupCheckScheduled = false
let startupRetryStopped = false
/** @type {ReturnType<typeof setTimeout>[]} */
let schedulerTimers = []
/** @type {ReturnType<typeof setInterval> | null} */
let periodicTimer = null
let checkInFlight = false
let downloadInFlight = false
/** @type {string} */
let highestSeenUserData = ''
/** @type {import('./update-drain.cjs').DrainHooks} */
let defaultDrainHooks = {}

/**
 * 设置测试环境是否允许跳过验签（生产禁止开启）。
 * @param {boolean} value
 */
function setAllowUnsignedForTest(value) {
  allowUnsignedForTest = Boolean(value)
}

/**
 * @param {string} userDataPath
 */
function setHighestSeenUserData(userDataPath) {
  highestSeenUserData = String(userDataPath || '').trim()
}

/**
 * @param {import('./update-drain.cjs').DrainHooks} hooks
 */
function setDefaultDrainHooks(hooks) {
  defaultDrainHooks = hooks && typeof hooks === 'object' ? hooks : {}
}

/**
 * 关闭本进程的启动更新窗口（登录后或用户取消后调用）。
 * @param {string} [reason] NO_UPDATE 才永久停止启动重试；其它原因不影响周期检查
 */
function markStartupUpdateDone(reason = '') {
  startupApplyAllowed = false
  const code = String(reason || '').trim()
  if (!code || code === 'NO_UPDATE' || code === 'CURRENT_PACKAGE_MATCH' || code === 'DEFERRED') {
    if (code === 'NO_UPDATE' || code === 'CURRENT_PACKAGE_MATCH' || !code) {
      startupRetryStopped = true
    }
    if (code === 'DEFERRED') {
      // 用户稍后：停止启动退避打扰，保留周期检查
      startupRetryStopped = true
    }
  }
  // CHECK_FAILED / APPLY_FAILED：不停止启动重试
}

/**
 * 解析便携包真实路径（优先 PORTABLE_EXECUTABLE_FILE，避免写到 TEMP 解压目录）。
 * @returns {string}
 */
function resolvePortableExePath() {
  const portable = String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim()
  if (portable && existsSync(portable)) return path.resolve(portable)
  return path.resolve(process.execPath)
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function manifestUsesProtocolV2(value) {
  const raw = String(value || '').trim().toLowerCase()
  if (raw === 'updater-v2' || raw === 'upd-v2') return true
  const match = raw.match(/(\d+)/)
  return Boolean(match && Number(match[1]) >= 2)
}

/**
 * v1 签名字节（旧客户端）；不含 releaseSequence / targetClientIds 等控制字段。
 * @param {Record<string, unknown>} man
 * @returns {Buffer}
 */
function canonicalManifestBytesV1(man) {
  const legacy = getLegacyManifestDefaults()
  const wire = {
    version: String(man.version || ''),
    buildId: String(man.buildId || ''),
    gitCommit: String(man.gitCommit || ''),
    protocolVersion: String(man.protocolVersion || legacy.protocolVersion),
    securityProtocolVersion: String(man.securityProtocolVersion || legacy.securityProtocolVersion),
    desktopProtocolVersion: String(man.desktopProtocolVersion || legacy.desktopProtocolVersion),
    updaterProtocolVersion: String(man.updaterProtocolVersion || legacy.updaterProtocolVersion),
    mandatory: Boolean(man.mandatory ?? true),
    publishedAt: String(man.publishedAt || ''),
    minimumSupportedBuild: String(man.minimumSupportedBuild || ''),
    downloadURL: String(man.downloadURL || ''),
    fileName: String(man.fileName || ''),
    fileSize: Number(man.fileSize || 0) || 0,
    sha256: String(man.sha256 || ''),
    signingKeyId: String(man.signingKeyId || legacy.signingKeyId),
    authenticodePublisher: String(man.authenticodePublisher || ''),
  }
  return Buffer.from(JSON.stringify(wire), 'utf8')
}

/**
 * v2 签名字节：在 v1 字段上附加控制面字段。
 * @param {Record<string, unknown>} man
 * @returns {Buffer}
 */
function canonicalManifestBytesV2(man) {
  const legacy = getLegacyManifestDefaults()
  const wire = {
    version: String(man.version || ''),
    buildId: String(man.buildId || ''),
    gitCommit: String(man.gitCommit || ''),
    protocolVersion: String(man.protocolVersion || legacy.protocolVersion),
    securityProtocolVersion: String(man.securityProtocolVersion || legacy.securityProtocolVersion),
    desktopProtocolVersion: String(man.desktopProtocolVersion || legacy.desktopProtocolVersion),
    updaterProtocolVersion: String(man.updaterProtocolVersion || 'updater-v2'),
    mandatory: Boolean(man.mandatory ?? true),
    publishedAt: String(man.publishedAt || ''),
    minimumSupportedBuild: String(man.minimumSupportedBuild || ''),
    downloadURL: String(man.downloadURL || ''),
    fileName: String(man.fileName || ''),
    fileSize: Number(man.fileSize || 0) || 0,
    sha256: String(man.sha256 || ''),
    signingKeyId: String(man.signingKeyId || legacy.signingKeyId),
    authenticodePublisher: String(man.authenticodePublisher || ''),
    releaseSequence: Number(man.releaseSequence || 0) || 0,
    minimumReleaseSequence: Number(man.minimumReleaseSequence || 0) || 0,
    targetClientIds: normalizeTargetClientIds(man.targetClientIds),
    securityEmergency: Boolean(man.securityEmergency),
  }
  return Buffer.from(JSON.stringify(wire), 'utf8')
}

/** @deprecated 使用 canonicalManifestBytesV1；保留导出名兼容旧测试 */
function canonicalManifestBytes(man) {
  return canonicalManifestBytesV1(man)
}

/**
 * 用内嵌 Ed25519 公钥校验清单签名。
 * 优先 signatureV2（控制面字段）；否则按协议版本选择 v1/v2 wire。
 * @param {Record<string, unknown>} man
 * @param {string} signatureHex
 * @param {string} [publicKeyB64]
 * @param {string} [signatureV2Hex]
 * @returns {boolean}
 */
function _ed25519VerifyHex(body, signatureHex, publicKeyB64) {
  const raw = Buffer.from(String(publicKeyB64 || '').trim(), 'base64')
  if (raw.length !== 32) return false
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
  const h = String(signatureHex || '').trim()
  if (!/^[0-9a-fA-F]+$/.test(h) || h.length % 2 !== 0) return false
  try {
    return verify(null, body, key, Buffer.from(h, 'hex'))
  } catch {
    return false
  }
}

/**
 * Legacy wire signature (v1 canonical bytes).
 * @param {Record<string, unknown>} man
 * @param {string} signatureHex
 * @param {string} [publicKeyB64]
 * @returns {boolean}
 */
function verifyManifestSignatureV1(man, signatureHex, publicKeyB64 = BUILTIN_PUBLISH_PUBLIC_KEY_B64) {
  if (allowUnsignedForTest && !publicKeyB64) return true
  try {
    return _ed25519VerifyHex(canonicalManifestBytesV1(man), signatureHex, publicKeyB64)
  } catch {
    return false
  }
}

/**
 * Modern control-plane signature (v2 canonical bytes).
 * @param {Record<string, unknown>} man
 * @param {string} signatureV2Hex
 * @param {string} [publicKeyB64]
 * @returns {boolean}
 */
function verifyManifestSignatureV2(man, signatureV2Hex, publicKeyB64 = BUILTIN_PUBLISH_PUBLIC_KEY_B64) {
  if (allowUnsignedForTest && !publicKeyB64) return true
  try {
    return _ed25519VerifyHex(canonicalManifestBytesV2(man), signatureV2Hex, publicKeyB64)
  } catch {
    return false
  }
}

/**
 * 用内嵌 Ed25519 公钥校验清单签名。
 * 优先 signatureV2（控制面字段）；否则按协议版本选择 v1/v2 wire。
 * @param {Record<string, unknown>} man
 * @param {string} signatureHex
 * @param {string} [publicKeyB64]
 * @param {string} [signatureV2Hex]
 * @returns {boolean}
 */
function verifyManifestSignature(man, signatureHex, publicKeyB64 = BUILTIN_PUBLISH_PUBLIC_KEY_B64, signatureV2Hex = '') {
  if (allowUnsignedForTest && !publicKeyB64) return true
  try {
    const v2Hex = String(signatureV2Hex || '').trim()
    if (v2Hex) {
      return verifyManifestSignatureV2(man, v2Hex, publicKeyB64)
    }
    // 无 signatureV2：仅当 signature 本身就是 v2 wire（或 v1 协议）时通过
    if (manifestUsesProtocolV2(man?.updaterProtocolVersion)) {
      return verifyManifestSignatureV2(man, signatureHex, publicKeyB64)
    }
    return verifyManifestSignatureV1(man, signatureHex, publicKeyB64)
  } catch {
    return false
  }
}

/**
 * 解析 MAJOR.MINOR(.PATCH) 版本号。
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
function parseVersionParts(value) {
  const match = String(value || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)]
}

/**
 * 远端版本是否比本地新（用于 releaseSequence 未超过本地时兜底）。
 * @param {unknown} remoteVersion
 * @param {unknown} localVersion
 * @returns {boolean}
 */
function isRemoteVersionNewer(remoteVersion, localVersion) {
  const remote = parseVersionParts(remoteVersion)
  const local = parseVersionParts(localVersion)
  if (!remote || !local) return false
  for (let index = 0; index < 3; index += 1) {
    if (remote[index] > local[index]) return true
    if (remote[index] < local[index]) return false
  }
  return false
}

/**
 * @param {string} [userDataPath]
 * @returns {string}
 */
function highestSeenSeqPath(userDataPath) {
  const root = String(userDataPath || highestSeenUserData || '').trim()
  if (!root) return ''
  return path.join(root, HIGHEST_SEEN_SEQ_FILE)
}

/**
 * @param {string} [userDataPath]
 * @returns {number}
 */
function loadHighestSeenReleaseSequence(userDataPath) {
  const file = highestSeenSeqPath(userDataPath)
  if (!file || !existsSync(file)) return 0
  try {
    const row = JSON.parse(readFileSync(file, 'utf8'))
    return Number(row?.highestSeenReleaseSequence || 0) || 0
  } catch {
    return 0
  }
}

/**
 * @param {number|string} seq
 * @param {string} [userDataPath]
 */
function recordHighestSeenReleaseSequence(seq, userDataPath) {
  const next = Number(seq || 0) || 0
  if (next <= 0) return
  const file = highestSeenSeqPath(userDataPath)
  if (!file) return
  const prev = loadHighestSeenReleaseSequence(userDataPath)
  if (next <= prev) return
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ highestSeenReleaseSequence: next, updatedAt: new Date().toISOString() }, null, 2))
  } catch { /* ignore */ }
}

/**
 * 定向发布：manifest.targetClientIds 非空时，仅名单内 clientId 视为需要升级。
 * @param {Record<string, unknown>} man
 * @param {string} [clientId]
 * @returns {boolean}
 */
function isManifestTargetedToClient(man, clientId = '') {
  const targets = normalizeTargetClientIds(man?.targetClientIds)
  if (!targets.length) return true
  const cid = String(clientId || '').trim()
  if (!cid) return false
  return targets.includes(cid)
}

/**
 * 是否需要升级：版本号 / releaseSequence / buildId，并尊重 minimumReleaseSequence。
 * @param {Record<string, unknown>} man
 * @param {number} currentSeq
 * @param {string} currentBuild
 * @param {string} [currentVersion]
 * @param {string} [clientId]
 * @param {string} [userDataPath]
 * @returns {boolean}
 */
function needsUpgrade(man, currentSeq, currentBuild, currentVersion = '', clientId = '', userDataPath = '') {
  if (!man) return false
  if (!isManifestTargetedToClient(man, clientId)) return false
  const latest = Number(man.releaseSequence || 0) || 0
  // Anti-downgrade uses COMMITTED only — never download/check-time "seen"
  const committed = updateState.loadHighestCommittedReleaseSequence(userDataPath || highestSeenUserData)
  if (latest > 0 && committed > 0 && latest < committed) return false
  const minSeq = Number(man.minimumReleaseSequence || 0) || 0
  const cur = Number(currentSeq || 0) || 0
  if (minSeq > 0 && cur < minSeq) return true
  if (isRemoteVersionNewer(man.version, currentVersion)) return true
  if (latest > 0 && cur > 0) return latest > cur
  const bid = String(man.buildId || '')
  return Boolean(bid && bid !== String(currentBuild || ''))
}

/**
 * 校验下载 URL：仅 HTTPS + 白名单主机。
 * @param {string} raw
 * @returns {{ ok: boolean, code?: string }}
 */
function validateDownloadURL(raw) {
  try {
    const u = new URL(String(raw || ''))
    if (u.protocol !== 'https:') return { ok: false, code: 'UPDATE_URL_NOT_HTTPS' }
    if (!ALLOWED_DOWNLOAD_HOSTS.has(u.hostname.toLowerCase())) return { ok: false, code: 'UPDATE_URL_HOST_DENIED' }
    return { ok: true }
  } catch {
    return { ok: false, code: 'UPDATE_URL_INVALID' }
  }
}

/**
 * 计算文件 SHA-256（小写 hex）。
 * @param {string} filePath
 * @returns {Promise<string>}
 */
function hashFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * 本地包是否已与清单一致（防重复下载循环）。
 * @param {string} filePath
 * @param {Record<string, unknown>} man
 * @returns {Promise<boolean>}
 */
async function packageFileMatchesManifest(filePath, man) {
  if (!man || !filePath || !existsSync(filePath) || !String(man.sha256 || '').trim()) return false
  const expectedSize = Number(man.fileSize || 0) || 0
  if (expectedSize > 0 && statSync(filePath).size !== expectedSize) return false
  const sum = await hashFileSha256(filePath)
  return sum.toLowerCase() === String(man.sha256).trim().toLowerCase()
}

/**
 * 校验已下载包的大小与 sha256。
 * @param {string} filePath
 * @param {Record<string, unknown>} man
 */
async function verifyPackageFile(filePath, man) {
  const st = statSync(filePath)
  const expectedSize = Number(man.fileSize || 0) || 0
  if (expectedSize > 0 && st.size !== expectedSize) throw new Error('UPDATE_SIZE_MISMATCH')
  const expectedSha = String(man.sha256 || '').trim()
  if (!expectedSha) return
  const sum = await hashFileSha256(filePath)
  if (sum.toLowerCase() !== expectedSha.toLowerCase()) throw new Error('UPDATE_SHA256_MISMATCH')
}

/**
 * HTTP(S) GET，支持自定义 headers。
 * @param {string} url
 * @param {{ headers?: Record<string, string>, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, headers: import('http').IncomingHttpHeaders, body: Buffer }>}
 */
function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const req = lib.request(url, {
      method: 'GET',
      headers: options.headers || {},
      timeout: options.timeoutMs || 60000,
      ...insecureTlsForService(u.hostname),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
    req.end()
  })
}

/**
 * 拉取并验签更新清单。
 * @param {string} baseUrl
 * @param {string} [clientId]
 * @returns {Promise<{ manifest: Record<string, unknown>, signature: string, publicKey?: string }>}
 */
async function fetchManifest(baseUrl, clientId = '') {
  const cid = String(clientId || '').trim()
  const qs = cid ? `?clientId=${encodeURIComponent(cid)}` : ''
  const url = `${String(baseUrl || DEFAULT_BASE).replace(/\/$/, '')}/api/update/manifest${qs}`
  const headers = cid ? { 'X-Client-Id': cid } : {}
  const res = await httpGet(url, { timeoutMs: 20000, headers })
  if (res.status >= 300) throw new Error(`manifest http ${res.status}`)
  const wrap = JSON.parse(res.body.toString('utf8') || '{}')
  if (!wrap || wrap.ok === false) throw new Error(wrap?.message || 'MANIFEST_FETCH_FAILED')
  const man = wrap.manifest && typeof wrap.manifest === 'object' ? wrap.manifest : wrap
  const signature = String(wrap.signature || '')
  const signatureV2 = String(wrap.signatureV2 || '')
  if (allowUnsignedForTest) {
    // 单测可跳过验签
  } else if (!signature && !signatureV2) {
    throw new Error('UPDATE_SIGNATURE_MISSING')
  } else if (!verifyManifestSignature(man, signature, undefined, signatureV2)) {
    throw new Error('UPDATE_SIGNATURE_INVALID')
  }
  if (!String(man.buildId || '').trim() && !String(man.version || '').trim() && !Number(man.releaseSequence || 0)) {
    throw new Error('missing buildId')
  }
  return { manifest: man, signature, signatureV2, publicKey: String(wrap.publicKey || '').trim() }
}

/**
 * 检查是否有可用更新。
 * @param {{ baseUrl?: string, currentBuild: string, currentVersion: string, currentReleaseSequence: number|string, portablePath?: string, clientId?: string, userDataPath?: string }} options
 * @returns {Promise<{ needUpdate: boolean, mandatory: boolean, policy?: string, manifest?: Record<string, unknown>, code: string, message?: string }>}
 */
async function checkForUpdate(options) {
  const currentSeq = Number(options.currentReleaseSequence || 0) || 0
  const currentBuild = String(options.currentBuild || '')
  const clientId = String(options.clientId || '')
  const userDataPath = String(options.userDataPath || highestSeenUserData || '')
  const { manifest } = await fetchManifest(options.baseUrl || DEFAULT_BASE, clientId)
  // Do NOT bump anti-downgrade on mere check/download — only after COMMITTED
  const blocked = updateState.isFailedUpdateBlocked(manifest, userDataPath)
  if (blocked.blocked) {
    return {
      needUpdate: false,
      mandatory: false,
      policy: POLICY.OPTIONAL,
      manifest,
      code: 'FAILED_UPDATE_BACKOFF',
      message: `近期同一更新包启动失败，请 ${Math.ceil((blocked.remainMs || 0) / 60000)} 分钟后再试`,
    }
  }
  const portablePath = options.portablePath || resolvePortableExePath()
  if (await packageFileMatchesManifest(portablePath, manifest)) {
    return { needUpdate: false, mandatory: false, policy: POLICY.OPTIONAL, manifest, code: 'CURRENT_PACKAGE_MATCH' }
  }
  if (needsUpgrade(manifest, currentSeq, currentBuild, options.currentVersion, clientId, userDataPath)) {
    const policy = resolveUpdatePolicy(manifest)
    const mandatory = isForcedPolicy(policy)
    return {
      needUpdate: true,
      mandatory,
      policy,
      manifest,
      code: 'UPDATE_AVAILABLE',
      message: `发现新版本 ${manifest.fileName || manifest.version || ''}`.trim(),
    }
  }
  return { needUpdate: false, mandatory: false, policy: POLICY.OPTIONAL, manifest, code: 'NO_UPDATE' }
}

/**
 * 上报更新事件（失败忽略，不影响主流程）。
 * @param {string} baseUrl
 * @param {string} event
 * @param {Record<string, unknown>} meta
 * @param {Record<string, unknown>} [extra]
 */
async function reportUpdate(baseUrl, event, meta, extra = {}) {
  try {
    const body = JSON.stringify({
      event,
      buildId: meta.currentBuild,
      version: meta.currentVersion,
      releaseSequence: meta.currentReleaseSequence,
      t: new Date().toISOString(),
      ...extra,
    })
    const url = `${String(baseUrl || DEFAULT_BASE).replace(/\/$/, '')}/api/update/report`
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    await new Promise((resolve) => {
      const req = lib.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 8000,
        ...insecureTlsForService(u.hostname),
      }, (res) => { res.resume(); res.on('end', resolve) })
      req.on('error', () => resolve())
      req.on('timeout', () => { req.destroy(); resolve() })
      req.write(body)
      req.end()
    })
  } catch { /* ignore */ }
}

/**
 * 单段 Range 下载到指定偏移（流式写盘 + 背压，避免 writeSync 拖死带宽）。
 * @param {string} url
 * @param {string} dest
 * @param {number} start
 * @param {number} end inclusive
 * @param {(n: number) => void} [onChunk]
 */
function downloadRangeToFile(url, dest, start, end, onChunk) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const expectedLen = end - start + 1
    let settled = false
    const finish = (err, value) => {
      if (settled) return
      settled = true
      if (err) reject(err)
      else resolve(value)
    }
    const req = lib.request(url, {
      method: 'GET',
      headers: {
        Range: `bytes=${start}-${end}`,
        Connection: 'keep-alive',
      },
      timeout: 180000,
      highWaterMark: 1024 * 1024,
      ...insecureTlsForService(u.hostname),
    }, (res) => {
      const status = res.statusCode || 0
      if (status === 200) {
        res.resume()
        finish(Object.assign(new Error('RANGE_UNSUPPORTED'), { code: 'RANGE_UNSUPPORTED' }))
        return
      }
      if (status !== 206) {
        res.resume()
        finish(new Error(`download http ${status}`))
        return
      }
      const cr = String(res.headers['content-range'] || '')
      const crMatch = cr.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/)
      if (!crMatch) {
        res.resume()
        finish(Object.assign(new Error('RANGE_INVALID_CONTENT_RANGE'), { code: 'RANGE_INVALID_CONTENT_RANGE' }))
        return
      }
      const crStart = Number(crMatch[1])
      const crEnd = Number(crMatch[2])
      if (crStart !== start || crEnd !== end) {
        res.resume()
        finish(new Error(`Content-Range mismatch: expected ${start}-${end}, got ${crStart}-${crEnd}`))
        return
      }
      let file
      try {
        file = createWriteStream(dest, { flags: 'r+', start, highWaterMark: 1024 * 1024 })
      } catch (error) {
        res.resume()
        finish(error)
        return
      }
      let offset = start
      const fail = (error) => {
        try { res.destroy() } catch { /* ignore */ }
        try { req.destroy() } catch { /* ignore */ }
        try { file.destroy() } catch { /* ignore */ }
        finish(error)
      }
      res.on('data', (chunk) => {
        if (settled) return
        if (offset + chunk.length > end + 1) {
          fail(Object.assign(new Error('RANGE_BODY_TOO_LARGE'), { code: 'RANGE_BODY_TOO_LARGE' }))
          return
        }
        offset += chunk.length
        onChunk?.(chunk.length)
        if (!file.write(chunk)) {
          res.pause()
          file.once('drain', () => {
            try { res.resume() } catch { /* ignore */ }
          })
        }
      })
      res.on('error', fail)
      file.on('error', fail)
      res.on('end', () => {
        file.end(() => {
          const got = offset - start
          if (got !== expectedLen) {
            finish(new Error(`Range body length mismatch: expected ${expectedLen}, got ${got}`))
            return
          }
          finish(null, got)
        })
      })
    })
    req.on('error', (error) => finish(error))
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
      finish(new Error('timeout'))
    })
    req.end()
  })
}

/**
 * @param {string} dest
 * @returns {string}
 */
function partsMetaPathFor(dest) {
  return `${dest}.wxqk-parts`
}

/**
 * 从 parts 元数据读取已完成唯一字节（勿用 ftruncate 后的 stat.size）。
 * @param {string} dest
 * @returns {number}
 */
function readPartsCompletedBytes(dest) {
  const metaPath = partsMetaPathFor(dest)
  if (!existsSync(metaPath)) return 0
  try {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    if (Array.isArray(meta?.completedRanges) && meta.completedRanges.length) {
      return completedUniqueBytes(meta.completedRanges)
    }
    if (Array.isArray(meta?.done) && Number(meta.partSize) > 0) {
      const partSize = Number(meta.partSize)
      const total = Number(meta.total || 0) || 0
      const ranges = meta.done.map((start) => {
        const s = Number(start)
        return [s, Math.min(total > 0 ? total - 1 : s + partSize - 1, s + partSize - 1)]
      })
      return completedUniqueBytes(ranges)
    }
  } catch { /* ignore */ }
  return 0
}

/**
 * 多连接 Range 下载 + 断点续传。
 * 可预分配文件长度，但进度/镜像切换必须以 parts 完成区间的唯一字节为准。
 * @param {string} url
 * @param {string} dest
 * @param {number} expectedSize
 * @param {(downloaded: number, total: number) => void} [onProgress]
 * @param {{ sha256?: string, fileSize?: number, buildId?: string, version?: string }} [artifact]
 */
async function downloadWithResume(url, dest, expectedSize, onProgress, artifact = {}) {
  mkdirSync(path.dirname(dest), { recursive: true })
  const total = Number(expectedSize || artifact.fileSize || 0) || 0
  const artifactSha = String(artifact.sha256 || '').trim().toLowerCase()
  const artifactBuild = String(artifact.buildId || '').trim()
  const artifactVersion = String(artifact.version || '').trim()
  if (total <= 0) {
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const res = await new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'GET',
        timeout: 180000,
        highWaterMark: 1024 * 1024,
        ...insecureTlsForService(u.hostname),
      }, resolve)
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
      req.end()
    })
    if ((res.statusCode || 0) >= 300) {
      res.resume()
      throw new Error(`download http ${res.statusCode || 0}`)
    }
    await new Promise((resolve, reject) => {
      const file = createWriteStream(dest, { flags: 'w', highWaterMark: 1024 * 1024 })
      let got = 0
      res.on('data', (chunk) => {
        got += chunk.length
        onProgress?.(got, 0)
      })
      res.on('error', reject)
      file.on('error', reject)
      file.on('finish', resolve)
      res.pipe(file)
    })
    return
  }

  const partSize = 2 * 1024 * 1024
  const concurrency = 1
  const partsMetaPath = partsMetaPathFor(dest)
  const parts = []
  for (let start = 0; start < total; start += partSize) {
    parts.push({ start, end: Math.min(total - 1, start + partSize - 1), done: false })
  }

  function artifactMatches(meta) {
    if (!meta || typeof meta !== 'object') return false
    if (Number(meta.total) !== total || Number(meta.partSize) !== partSize) return false
    if (artifactSha && String(meta.sha256 || '').trim().toLowerCase() !== artifactSha) return false
    if (artifactBuild && String(meta.buildId || '').trim() !== artifactBuild) return false
    if (artifactVersion && String(meta.version || '').trim() !== artifactVersion) return false
    if (Number(meta.fileSize || 0) && Number(meta.fileSize) !== total) return false
    return true
  }

  function persistPartsProgress() {
    const completedRanges = rangesFromDoneParts(parts)
    try {
      writeFileSync(partsMetaPath, JSON.stringify({
        total,
        partSize,
        fileSize: total,
        sha256: artifactSha,
        buildId: artifactBuild,
        version: artifactVersion,
        completedRanges,
        done: parts.filter((part) => part.done).map((part) => part.start),
      }))
    } catch { /* ignore */ }
  }

  let downloaded = 0
  let resumeOk = false
  if (existsSync(dest) && existsSync(partsMetaPath)) {
    try {
      const meta = JSON.parse(readFileSync(partsMetaPath, 'utf8'))
      if (artifactMatches(meta)) {
        const doneSet = new Set(
          (Array.isArray(meta.done) ? meta.done : [])
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n)),
        )
        if (Array.isArray(meta.completedRanges) && meta.completedRanges.length) {
          const merged = mergeIntervals(meta.completedRanges)
          for (const part of parts) {
            const hit = merged.some(([s, e]) => s <= part.start && e >= part.end)
            if (hit) {
              part.done = true
            }
          }
        } else {
          for (const part of parts) {
            if (doneSet.has(part.start)) part.done = true
          }
        }
        downloaded = completedUniqueBytes(rangesFromDoneParts(parts))
        // 预分配后 stat.size===total 不能当作已下完；缺 parts 绑定则重来
        resumeOk = true
      }
    } catch {
      resumeOk = false
    }
  }
  if (!resumeOk) {
    const fd = openSync(dest, 'w')
    try { ftruncateSync(fd, total) } finally { closeSync(fd) }
    downloaded = 0
    for (const part of parts) part.done = false
    persistPartsProgress()
  }
  onProgress?.(Math.min(total, downloaded), total)
  if (parts.every((part) => part.done)) {
    try { unlinkSync(partsMetaPath) } catch { /* ignore */ }
    return
  }

  let cursor = 0
  let rangeUnsupported = false
  async function worker() {
    while (true) {
      if (rangeUnsupported) return
      const idx = cursor
      cursor += 1
      if (idx >= parts.length) return
      const part = parts[idx]
      if (part.done) continue
      let attempt = 0
      while (attempt < 3) {
        if (rangeUnsupported) return
        attempt += 1
        let partGot = 0
        try {
          await downloadRangeToFile(url, dest, part.start, part.end, (n) => {
            partGot += n
            downloaded += n
            onProgress?.(Math.min(total, downloaded), total)
          })
          part.done = true
          downloaded = completedUniqueBytes(rangesFromDoneParts(parts))
          persistPartsProgress()
          onProgress?.(Math.min(total, downloaded), total)
          break
        } catch (error) {
          downloaded = Math.max(0, downloaded - partGot)
          onProgress?.(Math.min(total, downloaded), total)
          if (error && error.code === 'RANGE_UNSUPPORTED') {
            rangeUnsupported = true
            return
          }
          if (attempt >= 3) throw error
          await new Promise((r) => setTimeout(r, 400 * attempt))
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (rangeUnsupported) {
    if (parts.some((part) => part.done)) {
      throw new Error('RANGE_UNSUPPORTED_AFTER_PARTIAL')
    }
    try { unlinkSync(partsMetaPath) } catch { /* ignore */ }
    // Fallback: single-connection full download (HTTP 200)
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    downloaded = 0
    onProgress?.(0, total)
    const res = await new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'GET',
        timeout: 180000,
        highWaterMark: 1024 * 1024,
        ...insecureTlsForService(u.hostname),
      }, resolve)
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
      req.end()
    })
    if ((res.statusCode || 0) >= 300) {
      res.resume()
      throw new Error(`download fallback http ${res.statusCode || 0}`)
    }
    await new Promise((resolve, reject) => {
      const file = createWriteStream(dest, { flags: 'w', highWaterMark: 1024 * 1024 })
      res.on('data', (chunk) => {
        downloaded += chunk.length
        onProgress?.(downloaded, total)
      })
      res.on('error', reject)
      file.on('error', reject)
      file.on('finish', resolve)
      res.pipe(file)
    })
  }
  if (statSync(dest).size !== total) throw new Error('UPDATE_SIZE_MISMATCH')
  try { unlinkSync(partsMetaPath) } catch { /* ignore */ }
}

/**
 * 探测目录是否可写。
 * @param {string} dir
 */
function probeDirWritable(dir) {
  const probe = path.join(dir, `.w-${Date.now()}.tmp`)
  writeFileSync(probe, Buffer.from([1]))
  unlinkSync(probe)
}

/**
 * @param {string} dir
 * @param {number} needBytes
 */
function ensureDiskSpace(dir, needBytes) {
  const need = Math.max(0, Number(needBytes || 0) || 0) + 64 * 1024 * 1024
  try {
    if (typeof require('fs').statfsSync === 'function') {
      const st = require('fs').statfsSync(dir)
      const free = Number(st.bavail) * Number(st.bsize)
      if (Number.isFinite(free) && free < need) throw new Error('UPDATE_DISK_FULL')
    }
  } catch (error) {
    if (String(error?.message || error) === 'UPDATE_DISK_FULL') throw error
  }
}

/**
 * 准备同卷回收站路径，用于移走旧便携包。
 * @param {string} installDir
 * @returns {string}
 */
function prepareUpdateOldTrashPath(installDir) {
  const trashDir = path.join(installDir, UPDATE_TRASH_DIR)
  mkdirSync(trashDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(trashDir, `old-${stamp}-${Math.random().toString(16).slice(2, 8)}.exe`)
}

/**
 * 子进程是否在健康窗口内已退出。
 * @param {number} pid
 * @param {number} windowMs
 * @returns {Promise<boolean>} true 表示已死亡
 */
async function childDiedWithin(pid, windowMs) {
  if (!pid) return true
  const deadline = Date.now() + Math.max(0, windowMs)
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

/**
 * @param {string} installDir
 * @param {string} finalPath
 * @param {Record<string, unknown>} man
 */
/**
 * @deprecated Old API wrote false READY. Use updateHandoff / update-state PREPARED only.
 * Kept as no-op so callers never mark READY from the old process.
 */
function writePortableReadyMarkers(_installDir, _finalPath, _man) {
  return { ok: false, reason: 'deprecated_use_prepared_not_ready' }
}

/**
 * 旧入口被取代时写重定向批处理（可行则写；失败忽略）。
 * @param {string} oldExe
 * @param {string} newExe
 */
function writeSupersededRedirect(oldExe, newExe) {
  try {
    if (!oldExe || !newExe || path.resolve(oldExe) === path.resolve(newExe)) return
    const redirect = `${oldExe}.wxqk-redirect.cmd`
    const body = [
      '@echo off',
      `rem superseded by newer portable build`,
      `set "PORTABLE_EXECUTABLE_FILE=${newExe}"`,
      `start "" "${newExe}" %*`,
    ].join('\r\n')
    writeFileSync(redirect, body, 'utf8')
    writeFileSync(`${oldExe}.wxqk-superseded.json`, JSON.stringify({
      superseded: true,
      redirectTo: path.resolve(newExe),
      at: new Date().toISOString(),
    }, null, 2))
  } catch { /* ignore */ }
}

/**
 * @deprecated Prefer schedulePortableHandoff — kept for tests that probe export name.
 */
function schedulePortableReplacement(opts) {
  return updateHandoff.schedulePortableHandoff({
    ...opts,
    userDataPath: opts.userDataPath || highestSeenUserData,
    manifest: opts.manifest || {
      sha256: opts.expectedSha256,
      version: opts.version,
      buildId: opts.buildId,
      releaseSequence: opts.releaseSequence,
    },
    electronExe: opts.electronExe || process.execPath,
  }).helperPid
}

/**
 * 下载、校验、写出新版并调度独立替换器（本函数不 exit）。
 * @param {{ baseUrl?: string, currentBuild: string, currentVersion: string, currentReleaseSequence: number|string, onProgress?: Function, app?: import('electron').App, clientId?: string, userDataPath?: string }} options
 * @returns {Promise<{ ok: boolean, finalPath?: string, message?: string, pendingHelper?: boolean, deferred?: boolean }>}
 */
async function applyUpdate(options) {
  if (applying || downloadInFlight) return { ok: false, message: '更新正在进行中' }
  applying = true
  downloadInFlight = true
  const baseUrl = options.baseUrl || DEFAULT_BASE
  const meta = {
    currentBuild: options.currentBuild,
    currentVersion: options.currentVersion,
    currentReleaseSequence: options.currentReleaseSequence,
  }
  try {
    const check = await checkForUpdate({
      ...options,
      baseUrl,
      clientId: options.clientId,
      userDataPath: options.userDataPath || highestSeenUserData,
    })
    if (!check.needUpdate || !check.manifest) return { ok: false, message: '无需更新' }
    const man = check.manifest
    const currentExe = resolvePortableExePath()
    const installDir = path.dirname(currentExe)
    let destName = path.basename(String(man.fileName || `${man.buildId}.exe`))
    if (!/微信群控/.test(destName) || isLegacyBrandFileName(destName)) {
      const ver = String(man.version || '').replace(/^v/i, '') || 'update'
      destName = `微信群控系统v${ver}.exe`
    }
    if (!destName.toLowerCase().endsWith('.exe')) destName += '.exe'
    const finalPath = path.join(installDir, destName)

    let url = String(man.downloadURL || '').trim()
    const packageUrl = `${baseUrl.replace(/\/$/, '')}/api/update/package/${man.buildId}`
    let sameHost = false
    try {
      sameHost = !!(url && new URL(url).hostname.toLowerCase() === new URL(baseUrl).hostname.toLowerCase())
    } catch (_) { sameHost = false }
    if (!url || isLegacyBrandDownloadUrl(url) || !sameHost) {
      url = packageUrl
    }
    const candidates = []
    for (const candidate of [packageUrl, url]) {
      if (!candidate || candidates.includes(candidate)) continue
      if (validateDownloadURL(candidate).ok) candidates.push(candidate)
    }
    if (!candidates.length) throw new Error('UPDATE_URL_HOST_DENIED')
    url = candidates[0]

    probeDirWritable(installDir)
    const expectedSize = Number(man.fileSize || 0) || 0
    ensureDiskSpace(installDir, expectedSize)
    const workDir = path.join(require('os').tmpdir(), getUpdateWorkDirName())
    mkdirSync(workDir, { recursive: true })
    const downloadPath = path.join(workDir, destName)

    await reportUpdate(baseUrl, 'DOWNLOAD_STARTED', meta, { buildId: man.buildId, version: man.version })
    let downloadError = null
    let reusedLocal = false
    if (expectedSize > 0 && existsSync(downloadPath) && statSync(downloadPath).size === expectedSize && !existsSync(partsMetaPathFor(downloadPath))) {
      try {
        await verifyPackageFile(downloadPath, man)
        reusedLocal = true
        downloadError = null
      } catch {
        try { unlinkSync(downloadPath) } catch { /* ignore */ }
        try { unlinkSync(partsMetaPathFor(downloadPath)) } catch { /* ignore */ }
      }
    }
    const artifact = {
      sha256: String(man.sha256 || ''),
      fileSize: expectedSize,
      buildId: String(man.buildId || ''),
      version: String(man.version || ''),
    }
    if (!reusedLocal) {
      for (let i = 0; i < candidates.length; i += 1) {
        const candidate = candidates[i]
        try {
          await downloadWithResume(candidate, downloadPath, expectedSize, options.onProgress, artifact)
          url = candidate
          downloadError = null
          break
        } catch (error) {
          downloadError = error
          if (i + 1 < candidates.length) {
            const partial = readPartsCompletedBytes(downloadPath)
            if (partial > 1024 * 1024) break
          }
        }
      }
    }
    if (downloadError) throw downloadError
    await reportUpdate(baseUrl, 'DOWNLOAD_COMPLETED', meta, { buildId: man.buildId, downloadURL: url })
    try {
      await verifyPackageFile(downloadPath, man)
    } catch (error) {
      try { unlinkSync(downloadPath) } catch { /* ignore */ }
      try { unlinkSync(partsMetaPathFor(downloadPath)) } catch { /* ignore */ }
      throw error
    }

    await reportUpdate(baseUrl, 'INSTALL_STARTED', meta, { buildId: man.buildId, version: man.version })
    if (path.resolve(finalPath) === path.resolve(currentExe)) {
      throw new Error('新版文件名与当前版本相同，无法安全替换')
    }
    copyFileSync(downloadPath, finalPath)
    await verifyPackageFile(finalPath, man)
    // PREPARED only — NEVER write NEW_VERSION_READY here (old process)
    const handoff = updateHandoff.schedulePortableHandoff({
      currentExe,
      finalPath,
      downloadPath,
      expectedSha256: String(man.sha256 || ''),
      userDataPath: options.userDataPath || highestSeenUserData,
      manifest: man,
      electronExe: process.execPath,
      readyTimeoutMs: Number(options.readyTimeoutMs || 90_000) || 90_000,
    })
    try { options.app?.releaseSingleInstanceLock?.() } catch { /* ignore */ }
    return {
      ok: true,
      pendingHelper: true,
      phase: 'PREPARED',
      helperPid: handoff.helperPid,
      updateId: handoff.updateId,
      finalPath,
      message: `新版已就绪（PREPARED），等待旧进程退出后由助手确认 NEW_VERSION_READY：${destName}`,
    }
  } finally {
    applying = false
    downloadInFlight = false
  }
}

/**
 * Refuse updater cleanup paths that could hit Program Files\\WXQK or stable identity.
 * @param {string} targetPath
 */
function isSafeUpdaterCleanupPath(targetPath) {
  const raw = String(targetPath || '').trim()
  if (!raw) return false
  try {
    const { isProtectedWxqkPath } = require('./wxqk-data-paths.cjs')
    if (isProtectedWxqkPath(raw)) return false
  } catch { /* ignore */ }
  const normalized = raw.replace(/\//g, '\\').toLowerCase()
  if (normalized.includes('\\program files\\wxqk')) return false
  if (normalized.includes('\\program files (x86)\\wxqk')) return false
  return true
}

/**
 * 若当前 EXE 已被更新取代，则安全拉起 marker 指向的新版并退出本进程。
 * 仅允许同目录 + SHA 与已验签 artifact 一致。
 * @param {{ app?: import('electron').App }} [options]
 * @returns {{ redirected: boolean, to?: string, reason?: string }}
 */
function maybeRelaunchSupersededPortable(options = {}) {
  try {
    const current = resolvePortableExePath()
    const installDir = path.dirname(current)
    const markerPath = path.join(installDir, PORTABLE_CURRENT_MARKER)
    if (!existsSync(markerPath)) return { redirected: false, reason: 'no_marker' }
    const row = JSON.parse(readFileSync(markerPath, 'utf8'))
    const target = path.resolve(String(row?.currentPortableExePath || '').trim())
    if (!target || !existsSync(target)) return { redirected: false, reason: 'target_missing' }
    if (path.dirname(target).toLowerCase() !== installDir.toLowerCase()) {
      return { redirected: false, reason: 'dir_mismatch' }
    }
    if (path.resolve(target) === path.resolve(current)) return { redirected: false, reason: 'already_current' }
    const expectedSha = String(row?.sha256 || '').trim().toLowerCase()
    if (expectedSha) {
      const { createHash: h } = require('crypto')
      const buf = readFileSync(target)
      const actual = h('sha256').update(buf).digest('hex')
      if (actual !== expectedSha) return { redirected: false, reason: 'sha_mismatch' }
    }
    const child = spawn(target, process.argv.slice(1).filter((a) => a !== '--after-update'), {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        PORTABLE_EXECUTABLE_FILE: target,
        PORTABLE_EXECUTABLE_DIR: installDir,
      },
    })
    child.unref()
    if (!child.pid) return { redirected: false, reason: 'spawn_failed' }
    setTimeout(() => {
      try { options.app?.exit?.(0) } catch { process.exit(0) }
    }, 200)
    return { redirected: true, to: target }
  } catch (err) {
    return { redirected: false, reason: String(err?.message || err) }
  }
}

/**
 * Cleanup after COMMIT only. Never delete old EXE based on PREPARED / false ready markers.
 */
function cleanupUpdateTrashBestEffort(userDataPath) {
  try {
    const ud = String(userDataPath || highestSeenUserData || '')
    const phase = String(updateState.getPhase(ud).phase || '')
    const committed = updateState.readCommitted(ud)
    if (phase !== updateState.PHASE.COMMITTED && !committed) return
    const installDir = path.dirname(resolvePortableExePath())
    const current = updateState.readInstallCurrent(installDir)
    const marked = String(current?.currentPortableExePath || '').trim()
    if (!marked || path.resolve(marked) !== path.resolve(resolvePortableExePath())) return
    // Old trash env cleanup is intentionally limited — finalizeCommit already rewrote launch entries
    const candidates = [
      String(process.env[UPDATE_OLD_TRASH_ENV] || '').trim(),
      String(process.env[LEGACY_UPDATE_OLD_TRASH_ENV] || '').trim(),
    ].filter(Boolean)
    for (const trash of candidates) {
      if (!isSafeUpdaterCleanupPath(trash)) continue
      // Do not delete if it is the stable launcher or current committed path
      if (path.resolve(trash) === path.resolve(resolvePortableExePath())) continue
      if (path.basename(trash) === updateState.STABLE_LAUNCHER_NAME) continue
      try { if (existsSync(trash)) unlinkSync(trash) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function clearSchedulerTimers() {
  for (const timer of schedulerTimers) {
    try { clearTimeout(timer) } catch { /* ignore */ }
  }
  schedulerTimers = []
  if (periodicTimer) {
    try { clearInterval(periodicTimer) } catch { /* ignore */ }
    periodicTimer = null
  }
}

/**
 * 启动更新调度：冷启动检查 + 失败指数退避 + 周期 4–6h 检查。
 * @param {{
 *   app: import('electron').App,
 *   baseUrl?: string,
 *   currentBuild: string,
 *   currentVersion: string,
 *   currentReleaseSequence: number|string,
 *   isPackaged: boolean,
 *   userDataPath?: string,
 *   onLog?: (level: string, message: string, details?: object) => void,
 *   onRequestStartupCheck?: (meta?: { reason?: string }) => void,
 *   registerOnlineHook?: (cb: () => void) => void,
 *   drainHooks?: import('./update-drain.cjs').DrainHooks,
 * }} options
 */
function startUpdateScheduler(options) {
  const cli = updateHandoff.parseUpdateCliArgs(process.argv)
  if (cli.afterUpdate) {
    // Cleanup only after COMMITTED — not on mere --after-update
    cleanupUpdateTrashBestEffort(options.userDataPath || highestSeenUserData)
  }
  if (cli.updateRollback) {
    // After rollback, skip immediate auto-apply of the same failed release (backoff file handles it)
    markStartupUpdateDone('UPDATE_ROLLBACK')
  }
  try {
    if (updateState.isUpdateApplying(options.userDataPath || highestSeenUserData)) {
      // Secondary launch during APPLYING: prefer redirect to pending/current
      const redirected = maybeRelaunchSupersededPortable({ app: options.app })
      if (redirected.redirected) return
    } else {
      const redirected = maybeRelaunchSupersededPortable({ app: options.app })
      if (redirected.redirected) return
    }
  } catch { /* ignore */ }
  if (options.userDataPath) setHighestSeenUserData(options.userDataPath)
  if (options.drainHooks) setDefaultDrainHooks(options.drainHooks)
  if (startupCheckScheduled) return
  startupCheckScheduled = true
  startupRetryStopped = false
  clearSchedulerTimers()

  const requestCheck = (reason) => {
    if (checkInFlight) return
    checkInFlight = true
    try {
      options.onRequestStartupCheck?.({ reason: String(reason || 'startup') })
    } catch { /* ignore */ }
    setTimeout(() => { checkInFlight = false }, 1500)
  }

  const scheduleStartupBackoff = () => {
    STARTUP_BACKOFF_MS.forEach((ms, index) => {
      const timer = setTimeout(() => {
        if (startupRetryStopped) return
        requestCheck(`startup-retry-${index + 1}`)
      }, ms)
      schedulerTimers.push(timer)
    })
  }

  schedulerTimers.push(setTimeout(() => {
    requestCheck('startup')
    scheduleStartupBackoff()
  }, 1800))

  const periodicDelay = PERIODIC_CHECK_MS + Math.floor((Math.random() * 2 - 1) * PERIODIC_JITTER_MS)
  periodicTimer = setInterval(() => {
    requestCheck('periodic')
  }, Math.max(4 * 60 * 60 * 1000, periodicDelay))
  if (typeof periodicTimer.unref === 'function') periodicTimer.unref()

  let onlineTimer = null
  if (typeof options.registerOnlineHook === 'function') {
    try {
      options.registerOnlineHook(() => {
        if (onlineTimer) clearTimeout(onlineTimer)
        onlineTimer = setTimeout(() => {
          requestCheck('online')
        }, 8_000)
        schedulerTimers.push(onlineTimer)
      })
    } catch { /* ignore */ }
  }
}

/**
 * 供 IPC：检查是否有新版本。
 * @param {{
 *   baseUrl?: string,
 *   currentBuild: string,
 *   currentVersion: string,
 *   currentReleaseSequence: number|string,
 *   isPackaged?: boolean,
 *   clientId?: string,
 *   userDataPath?: string,
 * }} options
 */
async function ipcCheckClientUpdate(options) {
  const meta = {
    currentBuild: options.currentBuild,
    currentVersion: options.currentVersion,
    currentReleaseSequence: options.currentReleaseSequence,
  }
  const out = {
    ok: true,
    needUpdate: false,
    currentVersion: options.currentVersion,
    currentBuildId: options.currentBuild,
    releaseSequence: options.currentReleaseSequence,
    canApply: Boolean(options.isPackaged && process.env.PORTABLE_EXECUTABLE_FILE),
  }
  try {
    await reportUpdate(options.baseUrl || DEFAULT_BASE, 'CHECK_STARTED', meta, { phase: 'startup-ui' })
    const result = await checkForUpdate({
      baseUrl: options.baseUrl || DEFAULT_BASE,
      currentBuild: options.currentBuild,
      currentVersion: options.currentVersion,
      currentReleaseSequence: options.currentReleaseSequence,
      clientId: options.clientId,
      userDataPath: options.userDataPath || highestSeenUserData,
    })
    if (!result.needUpdate) {
      await reportUpdate(options.baseUrl || DEFAULT_BASE, 'NO_UPDATE', meta, { code: result.code })
      markStartupUpdateDone(result.code || 'NO_UPDATE')
      return { ...out, code: result.code, policy: result.policy || POLICY.OPTIONAL }
    }
    const man = result.manifest || {}
    await reportUpdate(options.baseUrl || DEFAULT_BASE, 'UPDATE_PENDING_UI', meta, {
      buildId: man.buildId,
      version: man.version,
      policy: result.policy,
    })
    return {
      ...out,
      needUpdate: true,
      mandatory: Boolean(result.mandatory),
      policy: result.policy || resolveUpdatePolicy(man),
      latestVersion: man.version,
      latestBuildId: man.buildId,
      fileName: man.fileName,
      fileSize: man.fileSize,
      message: result.message || `发现新版本 ${man.fileName || man.version || ''}`.trim(),
      code: result.code,
    }
  } catch (error) {
    await reportUpdate(options.baseUrl || DEFAULT_BASE, 'CHECK_UNAVAILABLE', meta, {
      reason: String(error?.message || error),
      action: 'retry',
    })
    // 不 markStartupUpdateDone：允许启动退避重试
    return { ...out, ok: false, message: String(error?.message || error), code: 'CHECK_FAILED' }
  }
}

/**
 * 供 IPC：drain → 下载替换调度 → 优雅退出（不再 250ms 强杀）。
 * @param {{
 *   app: import('electron').App,
 *   baseUrl?: string,
 *   currentBuild: string,
 *   currentVersion: string,
 *   currentReleaseSequence: number|string,
 *   isPackaged?: boolean,
 *   allowRemoteForce?: boolean,
 *   clientId?: string,
 *   userDataPath?: string,
 *   drainHooks?: import('./update-drain.cjs').DrainHooks,
 *   onProgress?: (downloaded: number, total: number) => void,
 *   onLog?: (level: string, message: string, details?: object) => void,
 * }} options
 */
async function ipcApplyClientUpdate(options) {
  const log = options.onLog || (() => {})
  const allowRemote = Boolean(options.allowRemoteForce)
  if (!options.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE) {
    if (!allowRemote) markStartupUpdateDone('DEFERRED')
    return { ok: false, message: '开发/非便携环境不自动替换安装包' }
  }

  const hooks = options.drainHooks || defaultDrainHooks
  let policy = POLICY.OPTIONAL
  try {
    const preview = await checkForUpdate({
      baseUrl: options.baseUrl || DEFAULT_BASE,
      currentBuild: options.currentBuild,
      currentVersion: options.currentVersion,
      currentReleaseSequence: options.currentReleaseSequence,
      clientId: options.clientId,
      userDataPath: options.userDataPath || highestSeenUserData,
    })
    policy = preview.policy || resolveUpdatePolicy(preview.manifest)
  } catch { /* ignore */ }

  const isEmergency = policy === POLICY.SECURITY_EMERGENCY
  const isMandatory = isForcedPolicy(policy)
  const drain = await waitForUpdateDrain({
    timeoutMs: isEmergency ? 5_000 : 45_000,
    isEmergency,
    isRemote: allowRemote,
    isMandatory,
    forceAfterConfirm: Boolean(options.forceDrainConfirm),
    hooks,
    onState: (state, detail) => {
      log('INFO', `更新排空：${state}`, { module: '软件更新', ...(detail || {}) })
    },
  })
  if (!drain.ok) {
    log('WARN', '更新排空未完成，暂缓退出', {
      module: '软件更新',
      state: drain.state,
      items: drain.items,
      needsConfirm: Boolean(drain.needsConfirm),
    })
    // Keep admission closed only while waiting for user force; remote pending clears drain
    if (drain.pending || !drain.needsConfirm) {
      endUpdateDrain()
    }
    return {
      ok: false,
      pending: Boolean(drain.pending || drain.state === DRAIN_STATE.TIMEOUT_PENDING),
      needsConfirm: Boolean(drain.needsConfirm),
      code: drain.code || drain.state,
      message: drain.needsConfirm
        ? '当前仍有任务执行中。现在更新可能中断任务，请确认是否强制更新。'
        : (allowRemote
          ? '远端更新排空超时，有任务仍在运行，已暂缓'
          : '有任务仍在运行，请稍后再更新'),
      drain,
    }
  }

  log('INFO', '开始下载更新包', { module: '软件更新', remoteForce: allowRemote, policy })
  try {
    const applied = await applyUpdate({
      app: options.app,
      baseUrl: options.baseUrl || DEFAULT_BASE,
      currentBuild: options.currentBuild,
      currentVersion: options.currentVersion,
      currentReleaseSequence: options.currentReleaseSequence,
      clientId: options.clientId,
      userDataPath: options.userDataPath || highestSeenUserData,
      onProgress: options.onProgress,
    })
    if (applied.ok) {
      log('INFO', applied.message || '更新助手已调度，即将优雅退出', { module: '软件更新', pendingHelper: true, updateId: applied.updateId })
      updateState.setPhase(options.userDataPath || highestSeenUserData, updateState.PHASE.WAITING_OLD_EXIT, {
        updateId: applied.updateId,
      })
      const exitDelay = Math.max(2_500, Number(options.exitDelayMs || 3_500) || 3_500)
      setTimeout(() => {
        try { options.app.quit() } catch {
          try { options.app.exit(0) } catch { process.exit(0) }
        }
      }, exitDelay)
      return applied
    }
    endUpdateDrain()
    if (!allowRemote) markStartupUpdateDone('APPLY_FAILED')
    return applied
  } catch (error) {
    endUpdateDrain()
    if (!allowRemote) markStartupUpdateDone('APPLY_FAILED')
    log('ERROR', `更新失败：${error.message || error}`, { module: '软件更新' })
    return { ok: false, message: String(error?.message || error) }
  }
}

/**
 * 停止更新调度。
 */
function stopUpdateScheduler() {
  startupCheckScheduled = false
  clearSchedulerTimers()
}

module.exports = {
  DEFAULT_BASE,
  BUILTIN_PUBLISH_PUBLIC_KEY_B64,
  POLICY,
  canonicalManifestBytes,
  canonicalManifestBytesV1,
  canonicalManifestBytesV2,
  verifyManifestSignature,
  verifyManifestSignatureV1,
  verifyManifestSignatureV2,
  needsUpgrade,
  isManifestTargetedToClient,
  parseVersionParts,
  isRemoteVersionNewer,
  validateDownloadURL,
  packageFileMatchesManifest,
  verifyPackageFile,
  hashFileSha256,
  fetchManifest,
  checkForUpdate,
  downloadWithResume,
  readPartsCompletedBytes,
  applyUpdate,
  reportUpdate,
  resolvePortableExePath,
  schedulePortableReplacement,
  maybeRelaunchSupersededPortable,
  startUpdateScheduler,
  stopUpdateScheduler,
  markStartupUpdateDone,
  setAllowUnsignedForTest,
  setHighestSeenUserData,
  setDefaultDrainHooks,
  loadHighestSeenReleaseSequence,
  recordHighestSeenReleaseSequence,
  loadHighestCommittedReleaseSequence: updateState.loadHighestCommittedReleaseSequence,
  recordHighestCommittedReleaseSequence: updateState.recordHighestCommittedReleaseSequence,
  cleanupUpdateTrashBestEffort,
  isSafeUpdaterCleanupPath,
  ipcCheckClientUpdate,
  ipcApplyClientUpdate,
  resolveUpdatePolicy,
  isForcedPolicy,
  canAcceptNewWork,
  isUpdateDrainActive,
  beginUpdateDrain,
  endUpdateDrain,
  emitNewVersionReadyAck: updateHandoff.emitNewVersionReadyAck,
  parseUpdateCliArgs: updateHandoff.parseUpdateCliArgs,
  schedulePortableHandoff: updateHandoff.schedulePortableHandoff,
  updateState,
  DRAIN_STATE,
  collectActiveCriticalWork,
  waitForUpdateDrain,
  completedUniqueBytes,
  mergeIntervals,
  normalizeRanges,
  normalizeTargetClientIds,
  childDiedWithin,
  prepareUpdateOldTrashPath,
  writeSupersededRedirect,
  writePortableReadyMarkers,
}
