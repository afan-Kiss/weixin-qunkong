'use strict'

/**
 * WXQK path helpers.
 * - UI / account / business data: %LOCALAPPDATA%\WXQK (user-level)
 * - Machine identity: %PROGRAMDATA%\WXQK\machine (machine-level)
 * - Legacy portable: <PORTABLE_EXECUTABLE_DIR>\WXQK-Data
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const STABLE_APP_DIR_NAME = 'WXQK'
const LEGACY_PORTABLE_DATA_NAME = 'WXQK-Data'
const MIGRATION_MARKER = '.wxqk-migrated-from-portable-v1'

/**
 * Packaged production must ignore WXQK_USER_DATA_DIR unless explicitly allowed.
 * @param {{ isPackaged?: boolean } | null | undefined} appLike
 */
function allowUserDataDirOverride(appLike) {
  // Packaged production: ignore WXQK_USER_DATA_DIR unless explicitly allowed.
  if (appLike && appLike.isPackaged === true) {
    return process.env.WXQK_ALLOW_USER_DATA_OVERRIDE === '1'
  }
  if (process.env.WXQK_ALLOW_USER_DATA_OVERRIDE === '1') return true
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'test') return true
  if (process.env.WXQK_TEST_ALLOW_USER_DATA_DIR === '1') return true
  // Dev scripts / unit doubles without isPackaged → allow
  return true
}

/**
 * @param {{ app?: { isPackaged?: boolean }, allowOverride?: boolean }} [opts]
 * @returns {string}
 */
function resolveStableUserDataRoot(opts = {}) {
  const allow = typeof opts.allowOverride === 'boolean'
    ? opts.allowOverride
    : allowUserDataDirOverride(opts.app)
  if (allow && process.env.WXQK_USER_DATA_DIR && String(process.env.WXQK_USER_DATA_DIR).trim()) {
    return path.resolve(String(process.env.WXQK_USER_DATA_DIR).trim())
  }
  const local = process.env.LOCALAPPDATA
    || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '')
    || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, STABLE_APP_DIR_NAME)
}

/**
 * @returns {string}
 */
function resolveLegacyPortableUserDataDir() {
  const portableDir = String(process.env.PORTABLE_EXECUTABLE_DIR || '').trim()
  if (!portableDir) return ''
  return path.join(portableDir, LEGACY_PORTABLE_DATA_NAME)
}

/**
 * Pin Electron userData / sessionData BEFORE requestSingleInstanceLock.
 * @param {{ setPath: (name: string, p: string) => void, isPackaged?: boolean }} appLike
 */
function pinStableUserData(appLike) {
  const stable = resolveStableUserDataRoot({ app: appLike })
  try { fs.mkdirSync(stable, { recursive: true }) } catch { /* ignore */ }
  appLike.setPath('userData', stable)
  try { appLike.setPath('sessionData', path.join(stable, 'session')) } catch { /* older electron */ }
  return {
    stableUserDataDir: stable,
    legacyPortableUserDataDir: resolveLegacyPortableUserDataDir(),
    userDataOverrideAllowed: allowUserDataDirOverride(appLike),
  }
}

/**
 * Copy account-session only (identity goes through clone-safe import; DB via business migration).
 * @param {object} opts
 */
function migrateLegacyPortableUserDataIfNeeded(opts) {
  const existsSync = opts.existsSync || fs.existsSync
  const mkdirSync = opts.mkdirSync || fs.mkdirSync
  const copyFileSync = opts.copyFileSync || fs.copyFileSync
  const writeFileSync = opts.writeFileSync || fs.writeFileSync
  const stable = String(opts.stableUserDataDir || '').trim()
  const legacy = String(opts.legacyPortableUserDataDir || '').trim()
  if (!stable || !legacy || !existsSync(legacy)) {
    return { migrated: false, reason: 'no_legacy' }
  }
  const marker = path.join(stable, MIGRATION_MARKER)
  if (existsSync(marker)) {
    return { migrated: false, reason: 'already_migrated' }
  }

  const copied = []
  const ensureParent = (filePath) => {
    mkdirSync(path.dirname(filePath), { recursive: true })
  }
  const tryCopy = (rel) => {
    const src = path.join(legacy, rel)
    const dest = path.join(stable, rel)
    if (!existsSync(src) || existsSync(dest)) return
    ensureParent(dest)
    copyFileSync(src, dest)
    copied.push(rel)
  }

  // Do NOT copy device-identity.json or wechat-control.sqlite here.
  tryCopy('account-session.bin')

  try {
    writeFileSync(marker, JSON.stringify({
      at: new Date().toISOString(),
      from: legacy,
      copied,
      note: 'session-only; identity+sqlite use dedicated migrators',
    }, null, 2), 'utf8')
  } catch { /* ignore */ }

  return { migrated: copied.length > 0, reason: 'copied', copied, legacy, stable }
}

/**
 * Reject cleanup / updater paths that would touch Agent or identity stores.
 * @param {string} targetPath
 */
function isProtectedWxqkPath(targetPath) {
  const normalized = String(targetPath || '').replace(/\//g, '\\').toLowerCase()
  if (!normalized) return false
  if (normalized.includes('\\program files\\wxqk')) return true
  if (normalized.includes('\\program files (x86)\\wxqk')) return true
  if (normalized.includes('\\programdata\\wxqk')) return true
  const stable = resolveStableUserDataRoot({ allowOverride: true }).replace(/\//g, '\\').toLowerCase()
  if (stable && normalized.startsWith(stable)) {
    if (normalized.includes('\\security\\') || normalized.endsWith('\\device-identity.json')) return true
    if (normalized.includes('\\data\\wechat-control.sqlite')) return true
  }
  return false
}

module.exports = {
  STABLE_APP_DIR_NAME,
  LEGACY_PORTABLE_DATA_NAME,
  MIGRATION_MARKER,
  allowUserDataDirOverride,
  resolveStableUserDataRoot,
  resolveLegacyPortableUserDataDir,
  pinStableUserData,
  migrateLegacyPortableUserDataIfNeeded,
  isProtectedWxqkPath,
}
