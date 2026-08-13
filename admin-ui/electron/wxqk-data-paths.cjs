'use strict'

/**
 * Machine-stable WXQK data paths.
 * Portable EXE location must NOT own identity / single-instance namespace.
 *
 * Stable root (Windows): %LOCALAPPDATA%\WXQK
 * Legacy portable: <PORTABLE_EXECUTABLE_DIR>\WXQK-Data
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const STABLE_APP_DIR_NAME = 'WXQK'
const LEGACY_PORTABLE_DATA_NAME = 'WXQK-Data'
const MIGRATION_MARKER = '.wxqk-migrated-from-portable-v1'

/**
 * @returns {string}
 */
function resolveStableUserDataRoot() {
  if (process.env.WXQK_USER_DATA_DIR && String(process.env.WXQK_USER_DATA_DIR).trim()) {
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
 * Pin Electron userData / sessionData to machine-stable path BEFORE requestSingleInstanceLock.
 * Also returns legacy portable path for one-shot migration.
 * @param {{ setPath: (name: string, p: string) => void }} appLike
 */
function pinStableUserData(appLike) {
  const stable = resolveStableUserDataRoot()
  try { fs.mkdirSync(stable, { recursive: true }) } catch { /* ignore */ }
  appLike.setPath('userData', stable)
  try { appLike.setPath('sessionData', path.join(stable, 'session')) } catch { /* older electron */ }
  return {
    stableUserDataDir: stable,
    legacyPortableUserDataDir: resolveLegacyPortableUserDataDir(),
  }
}

/**
 * Copy selected legacy files into stable dir if stable has no identity yet.
 * Never overwrites an existing stable device-identity.json.
 * @param {{
 *   stableUserDataDir: string,
 *   legacyPortableUserDataDir: string,
 *   copyFileSync?: typeof fs.copyFileSync,
 *   existsSync?: typeof fs.existsSync,
 *   mkdirSync?: typeof fs.mkdirSync,
 *   readdirSync?: typeof fs.readdirSync,
 *   writeFileSync?: typeof fs.writeFileSync,
 * }} opts
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
  const stableIdentity = path.join(stable, 'security', 'device-identity.json')
  if (existsSync(stableIdentity)) {
    try { writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), skipped: 'stable_identity_exists' }, null, 2)) } catch { /* ignore */ }
    return { migrated: false, reason: 'stable_identity_exists' }
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

  // Do NOT copy device-identity.json here — must go through clone-safe import.
  tryCopy('account-session.bin')

  try {
    writeFileSync(marker, JSON.stringify({
      at: new Date().toISOString(),
      from: legacy,
      copied,
    }, null, 2), 'utf8')
  } catch { /* ignore */ }

  return { migrated: copied.length > 0, reason: 'copied', copied, legacy, stable }
}

/**
 * Reject cleanup / updater paths that would touch Machine Agent or stable identity.
 * @param {string} targetPath
 */
function isProtectedWxqkPath(targetPath) {
  const normalized = String(targetPath || '').replace(/\//g, '\\').toLowerCase()
  if (!normalized) return false
  if (normalized.includes('\\program files\\wxqk')) return true
  if (normalized.includes('\\program files (x86)\\wxqk')) return true
  const stable = resolveStableUserDataRoot().replace(/\//g, '\\').toLowerCase()
  if (stable && normalized.startsWith(stable)) {
    if (normalized.includes('\\security\\') || normalized.endsWith('\\device-identity.json')) return true
  }
  return false
}

module.exports = {
  STABLE_APP_DIR_NAME,
  LEGACY_PORTABLE_DATA_NAME,
  MIGRATION_MARKER,
  resolveStableUserDataRoot,
  resolveLegacyPortableUserDataDir,
  pinStableUserData,
  migrateLegacyPortableUserDataIfNeeded,
  isProtectedWxqkPath,
}
