/**
 * 微信群控静默更新客户端（对齐开云：启动检查 → 有新版直接下载/进度条 → 替换 → 重启）。
 * 产品要求：不依赖发布密钥；清单签名缺失/失败不阻断更新。
 */
const { createHash, createPublicKey, verify } = require('crypto')
const { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync, statSync, writeFileSync, rmSync, readdirSync } = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const { spawn } = require('child_process')

const DEFAULT_BASE = 'https://xiangyuzhubao.xyz/wxqk'
/** 与开云共用发布密钥时的内嵌公钥；生产环境需与服务器 publish_ed25519.priv 配对 */
const BUILTIN_PUBLISH_PUBLIC_KEY_B64 = '3aN2fjDlRZlq7clIOJ7X4qPVNTzIR9QPP03mjEUSacc='
const ALLOWED_DOWNLOAD_HOSTS = new Set(['xiangyuzhubao.xyz', 'www.xiangyuzhubao.xyz'])
const UPDATE_TRASH_DIR = '.wxqk-update-trash'
const UPDATE_OLD_TRASH_ENV = 'WXQK_UPDATE_OLD_TRASH'

let allowUnsignedForTest = false
let startupApplyAllowed = true
let applying = false
let startupCheckScheduled = false

/**
 * 设置测试环境是否允许跳过验签（生产禁止开启）。
 * @param {boolean} value
 */
function setAllowUnsignedForTest(value) {
  allowUnsignedForTest = Boolean(value)
}

/**
 * 关闭本进程的启动更新窗口（登录后或用户取消后调用）。
 */
function markStartupUpdateDone() {
  startupApplyAllowed = false
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
 * 生成与 Go ManifestCanonicalJSON / Python canonical_manifest_bytes 一致的签名字节。
 * @param {Record<string, unknown>} man
 * @returns {Buffer}
 */
function canonicalManifestBytes(man) {
  const wire = {
    version: String(man.version || ''),
    buildId: String(man.buildId || ''),
    gitCommit: String(man.gitCommit || ''),
    protocolVersion: String(man.protocolVersion || 'facai888-v1'),
    securityProtocolVersion: String(man.securityProtocolVersion || 'security-v1'),
    desktopProtocolVersion: String(man.desktopProtocolVersion || 'desktop-webrtc-v1'),
    updaterProtocolVersion: String(man.updaterProtocolVersion || 'updater-v1'),
    mandatory: Boolean(man.mandatory ?? true),
    publishedAt: String(man.publishedAt || ''),
    minimumSupportedBuild: String(man.minimumSupportedBuild || ''),
    downloadURL: String(man.downloadURL || ''),
    fileName: String(man.fileName || ''),
    fileSize: Number(man.fileSize || 0) || 0,
    sha256: String(man.sha256 || ''),
    signingKeyId: String(man.signingKeyId || 'facai888-v1'),
    authenticodePublisher: String(man.authenticodePublisher || ''),
  }
  return Buffer.from(JSON.stringify(wire), 'utf8')
}

/**
 * 用内嵌 Ed25519 公钥校验清单签名。
 * @param {Record<string, unknown>} man
 * @param {string} signatureHex
 * @param {string} [publicKeyB64]
 * @returns {boolean}
 */
function verifyManifestSignature(man, signatureHex, publicKeyB64 = BUILTIN_PUBLISH_PUBLIC_KEY_B64) {
  if (allowUnsignedForTest && !publicKeyB64) return true
  const hex = String(signatureHex || '').trim()
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return false
  try {
    const raw = Buffer.from(String(publicKeyB64 || '').trim(), 'base64')
    if (raw.length !== 32) return false
    const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' })
    return verify(null, canonicalManifestBytes(man), key, Buffer.from(hex, 'hex'))
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
 * 是否需要升级：版本号 / releaseSequence / buildId，并尊重 minimumReleaseSequence。
 * @param {Record<string, unknown>} man
 * @param {number} currentSeq
 * @param {string} currentBuild
 * @param {string} [currentVersion]
 * @returns {boolean}
 */
function needsUpgrade(man, currentSeq, currentBuild, currentVersion = '') {
  if (!man) return false
  const minSeq = Number(man.minimumReleaseSequence || 0) || 0
  const latest = Number(man.releaseSequence || 0) || 0
  const cur = Number(currentSeq || 0) || 0
  if (minSeq > 0 && cur < minSeq) return true
  // 版本号兜底：本地 bump 过快导致 seq 高于远端时，仍能凭 1.9 > 1.6 拉起更新
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
 * @returns {Promise<{ manifest: Record<string, unknown>, signature: string }>}
 */
async function fetchManifest(baseUrl) {
  const url = `${String(baseUrl || DEFAULT_BASE).replace(/\/$/, '')}/api/update/manifest`
  const res = await httpGet(url, { timeoutMs: 20000 })
  if (res.status >= 300) throw new Error(`manifest http ${res.status}`)
  const wrap = JSON.parse(res.body.toString('utf8') || '{}')
  if (!wrap || wrap.ok === false) throw new Error(wrap?.message || 'MANIFEST_FETCH_FAILED')
  const man = wrap.manifest && typeof wrap.manifest === 'object' ? wrap.manifest : wrap
  const signature = String(wrap.signature || '')
  // 不依赖密钥：有签名也只作旁路校验，失败不阻断
  if (signature && !verifyManifestSignature(man, signature)) {
    /* ignore UPDATE_SIGNATURE_INVALID */
  }
  if (!String(man.buildId || '').trim() && !String(man.version || '').trim()) {
    throw new Error('missing buildId')
  }
  return { manifest: man, signature }
}

/**
 * 检查是否有可用更新。
 * @param {{ baseUrl?: string, currentBuild: string, currentVersion: string, currentReleaseSequence: number|string, portablePath?: string }} options
 * @returns {Promise<{ needUpdate: boolean, mandatory: boolean, manifest?: Record<string, unknown>, code: string, message?: string }>}
 */
async function checkForUpdate(options) {
  const currentSeq = Number(options.currentReleaseSequence || 0) || 0
  const currentBuild = String(options.currentBuild || '')
  const { manifest } = await fetchManifest(options.baseUrl || DEFAULT_BASE)
  const portablePath = options.portablePath || resolvePortableExePath()
  if (await packageFileMatchesManifest(portablePath, manifest)) {
    return { needUpdate: false, mandatory: false, manifest, code: 'CURRENT_PACKAGE_MATCH' }
  }
  if (needsUpgrade(manifest, currentSeq, currentBuild, options.currentVersion)) {
    const minSeq = Number(manifest.minimumReleaseSequence || 0) || 0
    const latest = Number(manifest.releaseSequence || 0) || 0
    const mandatory = Boolean(manifest.mandatory)
      || latest > currentSeq
      || isRemoteVersionNewer(manifest.version, options.currentVersion)
      || (minSeq > 0 && currentSeq < minSeq)
    return {
      needUpdate: true,
      mandatory,
      manifest,
      code: 'UPDATE_AVAILABLE',
      message: `发现新版本 ${manifest.fileName || manifest.version || ''}`.trim(),
    }
  }
  return { needUpdate: false, mandatory: false, manifest, code: 'NO_UPDATE' }
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
      }, (res) => { res.resume(); res.on('end', resolve) })
      req.on('error', () => resolve())
      req.on('timeout', () => { req.destroy(); resolve() })
      req.write(body)
      req.end()
    })
  } catch { /* ignore */ }
}

/**
 * 支持 Range 断点续传的下载。
 * @param {string} url
 * @param {string} dest
 * @param {number} expectedSize
 * @param {(downloaded: number, total: number) => void} [onProgress]
 */
async function downloadWithResume(url, dest, expectedSize, onProgress) {
  mkdirSync(path.dirname(dest), { recursive: true })
  let start = 0
  if (existsSync(dest)) {
    start = statSync(dest).size
    if (expectedSize > 0 && start > expectedSize) {
      unlinkSync(dest)
      start = 0
    }
    if (expectedSize > 0 && start === expectedSize) {
      onProgress?.(expectedSize, expectedSize)
      return
    }
  }
  const headers = {}
  if (start > 0) headers.Range = `bytes=${start}-`
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? https : http
  const res = await new Promise((resolve, reject) => {
    const req = lib.request(url, { method: 'GET', headers, timeout: 120000 }, resolve)
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
    req.end()
  })
  const status = res.statusCode || 0
  if (status >= 300 && status !== 206) {
    res.resume()
    throw new Error(`download http ${status}`)
  }
  const append = start > 0 && status === 206
  if (!append) start = 0
  const flags = append ? 'a' : 'w'
  const file = createWriteStream(dest, { flags })
  let total = expectedSize
  if (total <= 0 && Number(res.headers['content-length'] || 0) > 0) {
    total = start + Number(res.headers['content-length'])
  }
  onProgress?.(start, total)
  let got = 0
  await new Promise((resolve, reject) => {
    res.on('data', (chunk) => {
      got += chunk.length
      onProgress?.(start + got, total)
    })
    res.on('error', reject)
    file.on('error', reject)
    file.on('finish', resolve)
    res.pipe(file)
  })
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
 * 下载、校验、替换便携包并拉起新进程。
 * @param {{ baseUrl?: string, currentBuild: string, currentVersion: string, currentReleaseSequence: number|string, onProgress?: Function, app?: import('electron').App }} options
 * @returns {Promise<{ ok: boolean, finalPath?: string, message?: string }>}
 */
async function applyUpdate(options) {
  if (applying) return { ok: false, message: '更新正在进行中' }
  if (!startupApplyAllowed) return { ok: false, message: '运行中不自动更新，请重启软件后再试' }
  applying = true
  const baseUrl = options.baseUrl || DEFAULT_BASE
  const meta = {
    currentBuild: options.currentBuild,
    currentVersion: options.currentVersion,
    currentReleaseSequence: options.currentReleaseSequence,
  }
  try {
    const check = await checkForUpdate({ ...options, baseUrl })
    if (!check.needUpdate || !check.manifest) return { ok: false, message: '无需更新' }
    const man = check.manifest
    const curSeq = Number(options.currentReleaseSequence || 0) || 0
    const latest = Number(man.releaseSequence || 0) || 0
    if (latest > 0 && curSeq > 0 && latest < curSeq) return { ok: false, message: '拒绝降级' }

    const currentExe = resolvePortableExePath()
    const installDir = path.dirname(currentExe)
    let destName = path.basename(String(man.fileName || `${man.buildId}.exe`))
    // 远端若仍写着旧品牌文件名，落盘时改回微信群控命名，避免覆盖成错名
    if (!/微信群控/.test(destName) || /开云|发财888|投注软件/i.test(destName)) {
      const ver = String(man.version || '').replace(/^v/i, '') || 'update'
      destName = `微信群控系统v${ver}.exe`
    }
    if (!destName.toLowerCase().endsWith('.exe')) destName += '.exe'
    const finalPath = path.join(installDir, destName)

    let url = String(man.downloadURL || '').trim()
    const packageUrl = `${baseUrl.replace(/\/$/, '')}/api/update/package/${man.buildId}`
    // 清单若误写成 /发财888/ 等旧前缀，强制回退到当前客户端的 /wxqk 基址
    if (!url || /\/发财888\//i.test(url) || (/xiangyuzhubao\.xyz\//i.test(url) && !/\/wxqk\//i.test(url))) {
      url = packageUrl
    }
    const urlGate = validateDownloadURL(url)
    if (!urlGate.ok) throw new Error(urlGate.code || 'UPDATE_URL_INVALID')

    probeDirWritable(installDir)
    const workDir = path.join(require('os').tmpdir(), 'wxqk-update')
    mkdirSync(workDir, { recursive: true })
    const downloadPath = path.join(workDir, destName)

    await reportUpdate(baseUrl, 'DOWNLOAD_STARTED', meta, { buildId: man.buildId, version: man.version })
    await downloadWithResume(url, downloadPath, Number(man.fileSize || 0) || 0, options.onProgress)
    await reportUpdate(baseUrl, 'DOWNLOAD_COMPLETED', meta, { buildId: man.buildId })
    await verifyPackageFile(downloadPath, man)

    await reportUpdate(baseUrl, 'INSTALL_STARTED', meta, { buildId: man.buildId, version: man.version })
    const oldTrash = prepareUpdateOldTrashPath(installDir)
    try {
      renameSync(currentExe, oldTrash)
    } catch (error) {
      await reportUpdate(baseUrl, 'INSTALL_FAILED', meta, { reason: String(error?.message || error) })
      throw new Error(`无法替换原文件（可能被占用）：${error.message || error}`)
    }

    const rollback = () => {
      try { if (existsSync(finalPath) && path.resolve(finalPath) !== path.resolve(oldTrash)) unlinkSync(finalPath) } catch {}
      renameSync(oldTrash, currentExe)
    }

    try {
      if (path.resolve(finalPath) !== path.resolve(currentExe) && existsSync(finalPath)) {
        try { unlinkSync(finalPath) } catch {}
      }
      copyFileSync(downloadPath, finalPath)
      await verifyPackageFile(finalPath, man)
    } catch (error) {
      try { rollback() } catch (rb) {
        await reportUpdate(baseUrl, 'INSTALL_FAILED', meta, { reason: String(error?.message || error), rollback: String(rb?.message || rb) })
        throw new Error(`${error.message || error}；回滚失败：${rb.message || rb}`)
      }
      await reportUpdate(baseUrl, 'INSTALL_FAILED', meta, { reason: String(error?.message || error) })
      throw error
    }

    try { unlinkSync(downloadPath) } catch {}

    // 必须先释放单实例锁，否则新进程会被 second-instance 立刻退出
    try { options.app?.releaseSingleInstanceLock?.() } catch { /* ignore */ }

    const child = spawn(finalPath, ['--after-update'], {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, [UPDATE_OLD_TRASH_ENV]: oldTrash },
    })
    child.unref()
    const pid = child.pid || 0
    if (await childDiedWithin(pid, 3000)) {
      try { rollback() } catch (rb) {
        await reportUpdate(baseUrl, 'INSTALL_FAILED', meta, { reason: 'child_exit', rollback: String(rb?.message || rb) })
        throw new Error(`新版本启动失败且回滚失败：${rb.message || rb}`)
      }
      await reportUpdate(baseUrl, 'INSTALL_FAILED', meta, { reason: 'child_exit' })
      throw new Error('新版本启动失败，已回滚到旧版本')
    }

    await reportUpdate(baseUrl, 'INSTALL_OK', meta, { buildId: man.buildId, version: man.version })
    return { ok: true, finalPath, message: `软件已更新成功：${destName}` }
  } finally {
    applying = false
  }
}

/**
 * 新进程启动后清理旧版回收站文件。
 */
function cleanupUpdateTrashBestEffort() {
  try {
    const trash = String(process.env[UPDATE_OLD_TRASH_ENV] || '').trim()
    if (trash && existsSync(trash)) unlinkSync(trash)
    const dir = path.dirname(resolvePortableExePath())
    const trashDir = path.join(dir, UPDATE_TRASH_DIR)
    if (existsSync(trashDir)) {
      try {
        if (!readdirSync(trashDir).length) rmSync(trashDir, { recursive: true, force: true })
      } catch {}
    }
  } catch { /* ignore */ }
}

/**
 * 启动更新调度：冷启动清理 + 通知渲染进程检查；下载进度/替换由 IPC apply 驱动（对齐开云）。
 * 运行中不做定时轮询。
 * @param {{
 *   app: import('electron').App,
 *   baseUrl?: string,
 *   currentBuild: string,
 *   currentVersion: string,
 *   currentReleaseSequence: number|string,
 *   isPackaged: boolean,
 *   onLog?: (level: string, message: string, details?: object) => void,
 *   onRequestStartupCheck?: () => void,
 * }} options
 */
function startUpdateScheduler(options) {
  if (process.argv.includes('--after-update')) {
    cleanupUpdateTrashBestEffort()
  }
  if (startupCheckScheduled) return
  startupCheckScheduled = true
  setTimeout(() => {
    try { options.onRequestStartupCheck?.() } catch { /* ignore */ }
  }, 1800)
}

/**
 * 供 IPC：检查是否有新版本（启动窗口内）。
 * @param {{
 *   baseUrl?: string,
 *   currentBuild: string,
 *   currentVersion: string,
 *   currentReleaseSequence: number|string,
 *   isPackaged?: boolean,
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
  if (!startupApplyAllowed) {
    return { ...out, deferred: true, message: '运行中不检查更新，下次启动软件时再更新' }
  }
  try {
    await reportUpdate(options.baseUrl || DEFAULT_BASE, 'CHECK_STARTED', meta, { phase: 'startup-ui' })
    const result = await checkForUpdate({
      baseUrl: options.baseUrl || DEFAULT_BASE,
      currentBuild: options.currentBuild,
      currentVersion: options.currentVersion,
      currentReleaseSequence: options.currentReleaseSequence,
    })
    if (!result.needUpdate) {
      await reportUpdate(options.baseUrl || DEFAULT_BASE, 'NO_UPDATE', meta, { code: result.code })
      return { ...out, code: result.code }
    }
    const man = result.manifest || {}
    await reportUpdate(options.baseUrl || DEFAULT_BASE, 'UPDATE_PENDING_UI', meta, {
      buildId: man.buildId,
      version: man.version,
    })
    return {
      ...out,
      needUpdate: true,
      mandatory: Boolean(result.mandatory),
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
      action: 'continue',
    })
    return { ...out, ok: false, message: String(error?.message || error) }
  }
}

/**
 * 供 IPC：下载并替换（带进度回调）；成功后调用方应退出旧进程。
 * @param {{
 *   app: import('electron').App,
 *   baseUrl?: string,
 *   currentBuild: string,
 *   currentVersion: string,
 *   currentReleaseSequence: number|string,
 *   isPackaged?: boolean,
 *   onProgress?: (downloaded: number, total: number) => void,
 *   onLog?: (level: string, message: string, details?: object) => void,
 * }} options
 */
async function ipcApplyClientUpdate(options) {
  const log = options.onLog || (() => {})
  if (!startupApplyAllowed) {
    return { ok: false, deferred: true, message: '运行中禁止因更新关闭软件，请完全退出后重新打开再更新' }
  }
  if (!options.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE) {
    markStartupUpdateDone()
    return { ok: false, message: '开发/非便携环境不自动替换安装包' }
  }
  log('INFO', '开始下载更新包', { module: '软件更新' })
  try {
    const applied = await applyUpdate({
      app: options.app,
      baseUrl: options.baseUrl || DEFAULT_BASE,
      currentBuild: options.currentBuild,
      currentVersion: options.currentVersion,
      currentReleaseSequence: options.currentReleaseSequence,
      onProgress: options.onProgress,
    })
    if (applied.ok) {
      log('INFO', applied.message || '更新成功，即将退出旧进程', { module: '软件更新' })
      setTimeout(() => {
        try { options.app.exit(0) } catch { process.exit(0) }
      }, 1200)
      return applied
    }
    markStartupUpdateDone()
    return applied
  } catch (error) {
    markStartupUpdateDone()
    log('ERROR', `更新失败：${error.message || error}`, { module: '软件更新' })
    return { ok: false, message: String(error?.message || error) }
  }
}

/**
 * 停止更新调度（兼容退出钩子；当前无运行中定时器）。
 */
function stopUpdateScheduler() {
  startupCheckScheduled = false
}

module.exports = {
  DEFAULT_BASE,
  BUILTIN_PUBLISH_PUBLIC_KEY_B64,
  canonicalManifestBytes,
  verifyManifestSignature,
  needsUpgrade,
  parseVersionParts,
  isRemoteVersionNewer,
  validateDownloadURL,
  packageFileMatchesManifest,
  verifyPackageFile,
  hashFileSha256,
  fetchManifest,
  checkForUpdate,
  downloadWithResume,
  applyUpdate,
  reportUpdate,
  resolvePortableExePath,
  startUpdateScheduler,
  stopUpdateScheduler,
  markStartupUpdateDone,
  setAllowUnsignedForTest,
  cleanupUpdateTrashBestEffort,
  ipcCheckClientUpdate,
  ipcApplyClientUpdate,
}
