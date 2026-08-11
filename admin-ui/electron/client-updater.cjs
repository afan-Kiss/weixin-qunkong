/**
 * 静默更新客户端：启动检查 → 下载/进度 → 替换 → 重启。
 * 生产环境强制校验清单 Ed25519 签名。
 */
const { createHash, createPublicKey, verify } = require('crypto')
const { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, unlinkSync, statSync, writeFileSync, rmSync, readdirSync } = require('fs')
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

const DEFAULT_BASE = getServiceBase()
const BUILTIN_PUBLISH_PUBLIC_KEY_B64 = getPublishPublicKeyB64()
const ALLOWED_DOWNLOAD_HOSTS = getAllowedHosts()
const UPDATE_TRASH_DIR = getUpdateTrashDirName()
const UPDATE_OLD_TRASH_ENV = 'APP_UPDATE_OLD_TRASH'
/** 旧版客户端写入的环境变量，升级到本版后仍需能删掉旧 exe */
const LEGACY_UPDATE_OLD_TRASH_ENV = 'WXQK_UPDATE_OLD_TRASH'

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
/**
 * 定向发布：manifest.targetClientIds 非空时，仅名单内 clientId 视为需要升级。
 * @param {Record<string, unknown>} man
 * @param {string} [clientId]
 * @returns {boolean}
 */
function isManifestTargetedToClient(man, clientId = '') {
  const targets = Array.isArray(man?.targetClientIds) ? man.targetClientIds.map((x) => String(x || '').trim()).filter(Boolean) : []
  if (!targets.length) return true
  const cid = String(clientId || '').trim()
  if (!cid) return false
  return targets.includes(cid)
}

function needsUpgrade(man, currentSeq, currentBuild, currentVersion = '', clientId = '') {
  if (!man) return false
  if (!isManifestTargetedToClient(man, clientId)) return false
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
 * @returns {Promise<{ manifest: Record<string, unknown>, signature: string }>}
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
  if (allowUnsignedForTest) {
    // 单测可跳过验签
  } else if (!signature) {
    throw new Error('UPDATE_SIGNATURE_MISSING')
  } else if (!verifyManifestSignature(man, signature)) {
    // 仅信任客户端内置公钥；响应里的 publicKey 不能作为验签根（可被同响应伪造）
    throw new Error('UPDATE_SIGNATURE_INVALID')
  }
  if (!String(man.buildId || '').trim() && !String(man.version || '').trim() && !Number(man.releaseSequence || 0)) {
    throw new Error('missing buildId')
  }
  return { manifest: man, signature, publicKey: String(wrap.publicKey || '').trim() }
}

/**
 * 检查是否有可用更新。
 * @param {{ baseUrl?: string, currentBuild: string, currentVersion: string, currentReleaseSequence: number|string, portablePath?: string }} options
 * @returns {Promise<{ needUpdate: boolean, mandatory: boolean, manifest?: Record<string, unknown>, code: string, message?: string }>}
 */
async function checkForUpdate(options) {
  const currentSeq = Number(options.currentReleaseSequence || 0) || 0
  const currentBuild = String(options.currentBuild || '')
  const clientId = String(options.clientId || '')
  const { manifest } = await fetchManifest(options.baseUrl || DEFAULT_BASE, clientId)
  const portablePath = options.portablePath || resolvePortableExePath()
  if (await packageFileMatchesManifest(portablePath, manifest)) {
    return { needUpdate: false, mandatory: false, manifest, code: 'CURRENT_PACKAGE_MATCH' }
  }
  if (needsUpgrade(manifest, currentSeq, currentBuild, options.currentVersion, clientId)) {
    // 是否强制更新只服从发布清单。releaseSequence 和版本号只用于判断
    // 是否存在新版，不能把后台发布的非强制更新擅自升级为强制更新。
    const mandatory = Boolean(manifest.mandatory) || (Array.isArray(manifest.targetClientIds) && manifest.targetClientIds.length > 0)
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
 * 单段 Range 下载到指定偏移（支持并发拼包）。
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
    const req = lib.request(url, {
      method: 'GET',
      headers: { Range: `bytes=${start}-${end}` },
      timeout: 120000,
      ...insecureTlsForService(u.hostname),
    }, (res) => {
      const status = res.statusCode || 0
      if (status === 200) {
        res.resume()
        reject(Object.assign(new Error('RANGE_UNSUPPORTED'), { code: 'RANGE_UNSUPPORTED' }))
        return
      }
      if (status !== 206) {
        res.resume()
        reject(new Error(`download http ${status}`))
        return
      }
      const cr = String(res.headers['content-range'] || '')
      const crMatch = cr.match(/^bytes\s+(\d+)-(\d+)\//)
      if (crMatch) {
        const crStart = Number(crMatch[1])
        const crEnd = Number(crMatch[2])
        if (crStart !== start || crEnd !== end) {
          res.resume()
          reject(new Error(`Content-Range mismatch: expected ${start}-${end}, got ${crStart}-${crEnd}`))
          return
        }
      }
      const { openSync, writeSync, closeSync } = require('fs')
      let fd
      try {
        fd = openSync(dest, 'r+')
      } catch (error) {
        res.resume()
        reject(error)
        return
      }
      let offset = start
      res.on('data', (chunk) => {
        try {
          writeSync(fd, chunk, 0, chunk.length, offset)
          offset += chunk.length
          onChunk?.(chunk.length)
        } catch (error) {
          try { closeSync(fd) } catch (_) {}
          reject(error)
          req.destroy()
        }
      })
      res.on('error', (error) => {
        try { closeSync(fd) } catch (_) {}
        reject(error)
      })
      res.on('end', () => {
        try { closeSync(fd) } catch (_) {}
        const got = offset - start
        if (got !== expectedLen) {
          reject(new Error(`Range body length mismatch: expected ${expectedLen}, got ${got}`))
          return
        }
        resolve(got)
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
    req.end()
  })
}

/**
 * 多连接 Range 并发下载 + 断点续传（显著快于单连接慢上行）。
 * @param {string} url
 * @param {string} dest
 * @param {number} expectedSize
 * @param {(downloaded: number, total: number) => void} [onProgress]
 */
async function downloadWithResume(url, dest, expectedSize, onProgress) {
  mkdirSync(path.dirname(dest), { recursive: true })
  const total = Number(expectedSize || 0) || 0
  if (total <= 0) {
    // 未知大小：退回单连接整包
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    const res = await new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'GET',
        timeout: 120000,
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
      const file = createWriteStream(dest, { flags: 'w' })
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

  const partSize = 4 * 1024 * 1024
  const concurrency = 4
  const parts = []
  for (let start = 0; start < total; start += partSize) {
    parts.push({ start, end: Math.min(total - 1, start + partSize - 1), done: false })
  }
  // 已有完整文件
  if (existsSync(dest) && statSync(dest).size === total) {
    onProgress?.(total, total)
    return
  }
  // 预分配
  const { openSync, ftruncateSync, closeSync } = require('fs')
  const fd = openSync(dest, 'w')
  try { ftruncateSync(fd, total) } finally { closeSync(fd) }

  let downloaded = 0
  onProgress?.(0, total)
  let cursor = 0
  let rangeUnsupported = false
  async function worker() {
    while (true) {
      if (rangeUnsupported) return
      const idx = cursor
      cursor += 1
      if (idx >= parts.length) return
      const part = parts[idx]
      let attempt = 0
      while (attempt < 4) {
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
          break
        } catch (error) {
          downloaded = Math.max(0, downloaded - partGot)
          onProgress?.(Math.min(total, downloaded), total)
          if (error && error.code === 'RANGE_UNSUPPORTED') {
            rangeUnsupported = true
            return
          }
          if (attempt >= 4) throw error
          await new Promise((r) => setTimeout(r, 500 * attempt))
        }
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (rangeUnsupported) {
    // Fallback: single-connection full download (HTTP 200)
    const u = new URL(url)
    const lib = u.protocol === 'https:' ? https : http
    downloaded = 0
    onProgress?.(0, total)
    const res = await new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'GET',
        timeout: 120000,
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
      const file = createWriteStream(dest, { flags: 'w' })
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
 * 由独立进程等待当前程序退出后替换便携 EXE，规避 Windows 对运行中 EXE 的文件锁。
 */
function schedulePortableReplacement({ currentExe, finalPath, downloadPath, expectedSha256 }) {
  const workDir = path.dirname(downloadPath)
  const helperPath = path.join(workDir, `install-${Date.now()}-${process.pid}.ps1`)
  const logPath = path.join(workDir, 'install.log')
  const script = [
    'param([int]$ParentPid,[string]$CurrentExe,[string]$FinalPath,[string]$DownloadPath,[string]$ExpectedSha256,[string]$LogPath)',
    "$ErrorActionPreference = 'Stop'",
    'function Log([string]$Message) { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ((Get-Date -Format o) + " " + $Message) }',
    'Log "等待旧版退出 parent=$ParentPid current=$CurrentExe final=$FinalPath"',
    'try { Wait-Process -Id $ParentPid -Timeout 60 -ErrorAction SilentlyContinue } catch {}',
    'for ($i = 0; $i -lt 60; $i++) {',
    '  try { if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500; continue }; break } catch { break }',
    '}',
    'try {',
    '  if (-not (Test-Path -LiteralPath $FinalPath)) { throw "新版文件不存在" }',
    "  $actual = (Get-FileHash -LiteralPath $FinalPath -Algorithm SHA256).Hash.ToLowerInvariant()",
    "  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) { throw 'SHA256 mismatch after install' }",
    '  $env:PORTABLE_EXECUTABLE_FILE = $FinalPath',
    '  $env:PORTABLE_EXECUTABLE_DIR = Split-Path -Parent $FinalPath',
    '  $env:APP_UPDATE_OLD_TRASH = $CurrentExe',
    "  Start-Process -FilePath $FinalPath -ArgumentList '--after-update' -WorkingDirectory (Split-Path -Parent $FinalPath) -ErrorAction Stop",
    '  Log "新版启动命令成功"',
    '  Remove-Item -LiteralPath $DownloadPath -Force -ErrorAction SilentlyContinue',
    '} catch {',
    '  Log ("更新启动失败: " + $_.Exception.Message)',
    '  try { Start-Process -FilePath $CurrentExe -WorkingDirectory (Split-Path -Parent $CurrentExe) } catch {}',
    '  exit 1',
    '}',
  ].join('\r\n')
  // Windows PowerShell 5 会把无 BOM 的 UTF-8 脚本按系统 ANSI 读取，中文字符串
  // 可能被解码成破坏引号的乱码，导致脚本尚未执行就 ParserError。
  writeFileSync(helperPath, `\uFEFF${script}`, 'utf8')
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    process.pid.toString(), currentExe, finalPath, downloadPath, String(expectedSha256 || ''), logPath,
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  if (!child.pid) throw new Error('无法启动独立更新器')
  return child.pid
}

/**
 * 下载、校验、替换便携包并拉起新进程。
 * @param {{ baseUrl?: string, currentBuild: string, currentVersion: string, currentReleaseSequence: number|string, onProgress?: Function, app?: import('electron').App }} options
 * @returns {Promise<{ ok: boolean, finalPath?: string, message?: string }>}
 */
async function applyUpdate(options) {
  if (applying) return { ok: false, message: '更新正在进行中' }
  // 仅在入口检查一次：MarkStartupUpdateDone 不应打断已通过检查的下载/替换
  if (!startupApplyAllowed) {
    return { ok: false, deferred: true, message: '运行中禁止因更新关闭软件，请完全退出后重新打开再更新' }
  }
  applying = true
  const baseUrl = options.baseUrl || DEFAULT_BASE
  const meta = {
    currentBuild: options.currentBuild,
    currentVersion: options.currentVersion,
    currentReleaseSequence: options.currentReleaseSequence,
  }
  try {
    const check = await checkForUpdate({ ...options, baseUrl, clientId: options.clientId })
    if (!check.needUpdate || !check.manifest) return { ok: false, message: '无需更新' }
    const man = check.manifest
    const currentExe = resolvePortableExePath()
    const installDir = path.dirname(currentExe)
    let destName = path.basename(String(man.fileName || `${man.buildId}.exe`))
    // 远端若仍写着旧品牌文件名，落盘时改回产品命名
    if (!/微信群控/.test(destName) || isLegacyBrandFileName(destName)) {
      const ver = String(man.version || '').replace(/^v/i, '') || 'update'
      destName = `微信群控系统v${ver}.exe`
    }
    if (!destName.toLowerCase().endsWith('.exe')) destName += '.exe'
    const finalPath = path.join(installDir, destName)

    let url = String(man.downloadURL || '').trim()
    const packageUrl = `${baseUrl.replace(/\/$/, '')}/api/update/package/${man.buildId}`
    // 只从当前服务基址拉包；清单若指到其它主机/旧品牌路径则忽略
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
    const workDir = path.join(require('os').tmpdir(), getUpdateWorkDirName())
    mkdirSync(workDir, { recursive: true })
    const downloadPath = path.join(workDir, destName)

    await reportUpdate(baseUrl, 'DOWNLOAD_STARTED', meta, { buildId: man.buildId, version: man.version })
    let downloadError = null
    for (const candidate of candidates) {
      try {
        await downloadWithResume(candidate, downloadPath, Number(man.fileSize || 0) || 0, options.onProgress)
        url = candidate
        downloadError = null
        break
      } catch (error) {
        downloadError = error
      }
    }
    if (downloadError) throw downloadError
    await reportUpdate(baseUrl, 'DOWNLOAD_COMPLETED', meta, { buildId: man.buildId, downloadURL: url })
    await verifyPackageFile(downloadPath, man)

    await reportUpdate(baseUrl, 'INSTALL_STARTED', meta, { buildId: man.buildId, version: man.version })
    if (path.resolve(finalPath) === path.resolve(currentExe)) {
      throw new Error('新版文件名与当前版本相同，无法安全替换')
    }
    // 旧版仍运行时先把新版写入同目录并校验；只有确认文件存在后才允许退出。
    copyFileSync(downloadPath, finalPath)
    await verifyPackageFile(finalPath, man)
    try { options.app?.releaseSingleInstanceLock?.() } catch { /* ignore */ }
    const child = spawn(finalPath, ['--after-update'], {
      cwd: installDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        PORTABLE_EXECUTABLE_FILE: finalPath,
        PORTABLE_EXECUTABLE_DIR: installDir,
        [UPDATE_OLD_TRASH_ENV]: currentExe,
      },
    })
    child.unref()
    if (!child.pid) throw new Error('新版启动失败，旧版将继续运行')
    try { unlinkSync(downloadPath) } catch { /* ignore */ }
    return { ok: true, finalPath, message: `新版已下载，正在自动重启：${destName}` }
  } finally {
    applying = false
  }
}

/**
 * 新进程启动后清理旧版回收站文件。
 */
function cleanupUpdateTrashBestEffort() {
  try {
    const candidates = [
      String(process.env[UPDATE_OLD_TRASH_ENV] || '').trim(),
      String(process.env[LEGACY_UPDATE_OLD_TRASH_ENV] || '').trim(),
    ].filter(Boolean)
    for (const trash of candidates) {
      try { if (existsSync(trash)) unlinkSync(trash) } catch { /* ignore */ }
    }
    const dir = path.dirname(resolvePortableExePath())
    const trashDirs = [UPDATE_TRASH_DIR, ...getLegacyTrashDirNames()]
    for (const name of trashDirs) {
      const trashDir = path.join(dir, name)
      if (!existsSync(trashDir)) continue
      try {
        if (!readdirSync(trashDir).length) rmSync(trashDir, { recursive: true, force: true })
      } catch { /* ignore */ }
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
      clientId: options.clientId,
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
  const allowRemote = Boolean(options.allowRemoteForce)
  if (!startupApplyAllowed && !allowRemote) {
    return { ok: false, deferred: true, message: '运行中禁止因更新关闭软件，请完全退出后重新打开再更新' }
  }
  if (!options.isPackaged || !process.env.PORTABLE_EXECUTABLE_FILE) {
    if (!allowRemote) markStartupUpdateDone()
    return { ok: false, message: '开发/非便携环境不自动替换安装包' }
  }
  log('INFO', '开始下载更新包', { module: '软件更新', remoteForce: allowRemote })
  try {
    // 远程强制更新临时打开启动窗口门闩，避免 applyUpdate 入口拦截
    const prev = startupApplyAllowed
    if (allowRemote) startupApplyAllowed = true
    let applied
    try {
      applied = await applyUpdate({
        app: options.app,
        baseUrl: options.baseUrl || DEFAULT_BASE,
        currentBuild: options.currentBuild,
        currentVersion: options.currentVersion,
        currentReleaseSequence: options.currentReleaseSequence,
        clientId: options.clientId,
        onProgress: options.onProgress,
      })
    } finally {
      if (allowRemote) startupApplyAllowed = prev
    }
    if (applied.ok) {
      log('INFO', applied.message || '更新成功，即将退出旧进程', { module: '软件更新' })
      setTimeout(() => {
        try { options.app.exit(0) } catch { process.exit(0) }
      }, 250)
      return applied
    }
    if (!allowRemote) markStartupUpdateDone()
    return applied
  } catch (error) {
    if (!allowRemote) markStartupUpdateDone()
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
