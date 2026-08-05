/**
 * 启动时清理旧版可扫描缓存（临时目录、诊断落盘、Chromium 缓存、API 采样等）。
 * 保留正式设置：SQLite 业务库（设置/任务/通讯录等）、登录会话、设备身份。
 */
const { existsSync, rmSync, readdirSync, statSync, writeFileSync, readFileSync, unlinkSync } = require('fs')
const path = require('path')
const os = require('os')
const { getUpdateWorkDirName, getUpdateTrashDirName, getLegacyTempDirNames, getLegacyTrashDirNames } = require('./secure-config.cjs')

/** Electron/Chromium 缓存目录名（不含用户设置） */
const CHROMIUM_CACHE_DIR_NAMES = Object.freeze([
  'Cache',
  'Code Cache',
  'GPUCache',
  'blob_storage',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
])

/**
 * @param {string} target
 */
function removePathBestEffort(target) {
  if (!target || !existsSync(target)) return false
  try {
    rmSync(target, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} parent
 * @param {readonly string[]} names
 * @returns {string[]}
 */
function removeNamedChildren(parent, names) {
  const removed = []
  if (!parent || !existsSync(parent)) return removed
  for (const name of names) {
    const full = path.join(parent, name)
    if (removePathBestEffort(full)) removed.push(full)
  }
  return removed
}

/**
 * 清理系统临时目录中的更新/采集缓存。
 * @returns {string[]}
 */
function scrubTempCaches() {
  const tmp = os.tmpdir()
  const names = [...getLegacyTempDirNames(), getUpdateWorkDirName()]
  return removeNamedChildren(tmp, names)
}

/**
 * 清理便携包旁的旧版回收站目录。
 * @param {string} [portableExePath]
 * @returns {string[]}
 */
function scrubInstallTrash(portableExePath = '') {
  const removed = []
  const exe = String(portableExePath || '').trim()
  if (!exe) return removed
  try {
    const dir = path.dirname(path.resolve(exe))
    const names = [...getLegacyTrashDirNames(), getUpdateTrashDirName()]
    removed.push(...removeNamedChildren(dir, names))
  } catch { /* ignore */ }
  return removed
}

/**
 * 清理 userData 下缓存/诊断/日志文件；不动 data/、security/、登录会话。
 * @param {string} userDataDir
 * @returns {string[]}
 */
function scrubUserDataCaches(userDataDir) {
  const root = String(userDataDir || '').trim()
  const removed = []
  if (!root) return removed

  // 明确的业务缓存/诊断
  removed.push(...removeNamedChildren(root, [
    'cache',
    'friend-diagnostics',
    'logs',
  ]))

  // Chromium 默认缓存（设置在 Local Storage / Preferences，不在这些目录）
  removed.push(...removeNamedChildren(root, CHROMIUM_CACHE_DIR_NAMES))

  // 旧版可能散落的 jsonl / 临时安装脚本日志
  try {
    for (const name of readdirSync(root)) {
      const full = path.join(root, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (!st.isFile()) continue
      if (/\.(tmp|log)$/i.test(name) || /install-.*\.ps1$/i.test(name)) {
        try { unlinkSync(full); removed.push(full) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return removed
}

/**
 * 清空库内运行时采样表（不删 app_settings / 任务 / 通讯录 / 登录态）。
 * 注意：不在启动时清 backend_session_cache，避免误伤可能依赖会话缓存的恢复路径。
 * @param {{ clearRuntimeCaches?: () => number, clearApiSamplesOnly?: () => number }} [storage]
 * @returns {number}
 */
function scrubDatabaseRuntimeCaches(storage) {
  if (!storage) return 0
  try {
    if (typeof storage.clearApiSamplesOnly === 'function') {
      return Number(storage.clearApiSamplesOnly() || 0) || 0
    }
    // 兼容旧 storage：若只有全量清理则跳过，宁可留诊断采样也不要误删会话缓存
    return 0
  } catch {
    return 0
  }
}

/**
 * 每个版本只清一次，避免每次启动都重扫大目录。
 * @param {string} userDataDir
 * @param {string} version
 */
function alreadyScrubbedForVersion(userDataDir, version) {
  const marker = path.join(String(userDataDir || ''), `.cache-scrubbed-${String(version || '').replace(/[^\w.-]/g, '_')}`)
  return existsSync(marker)
}

/**
 * @param {string} userDataDir
 * @param {string} version
 */
function markScrubbedForVersion(userDataDir, version) {
  const marker = path.join(String(userDataDir || ''), `.cache-scrubbed-${String(version || '').replace(/[^\w.-]/g, '_')}`)
  try {
    writeFileSync(marker, new Date().toISOString(), 'utf8')
  } catch { /* ignore */ }
  // 清理更旧的 marker，避免堆积
  try {
    for (const name of readdirSync(userDataDir)) {
      if (!name.startsWith('.cache-scrubbed-')) continue
      const full = path.join(userDataDir, name)
      if (full === marker) continue
      try { unlinkSync(full) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

/**
 * 执行一次启动缓存清理。
 * @param {{
 *   userDataDir: string,
 *   version: string,
 *   portableExePath?: string,
 *   storage?: { clearRuntimeCaches?: () => number },
 *   force?: boolean,
 * }} options
 */
function scrubLegacyCachesOnStartup(options) {
  const userDataDir = String(options?.userDataDir || '')
  const version = String(options?.version || '')
  if (!userDataDir || !version) return { skipped: true, removed: [], dbRows: 0 }
  if (!options.force && alreadyScrubbedForVersion(userDataDir, version)) {
    return { skipped: true, removed: [], dbRows: 0 }
  }

  const removed = [
    ...scrubTempCaches(),
    ...scrubInstallTrash(options.portableExePath || ''),
    ...scrubUserDataCaches(userDataDir),
  ]
  const dbRows = scrubDatabaseRuntimeCaches(options.storage)
  markScrubbedForVersion(userDataDir, version)
  return { skipped: false, removed, dbRows }
}

module.exports = {
  scrubLegacyCachesOnStartup,
  scrubTempCaches,
  scrubUserDataCaches,
  scrubInstallTrash,
  CHROMIUM_CACHE_DIR_NAMES,
}
