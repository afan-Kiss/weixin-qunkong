'use strict'

/**
 * Stable Windows background startup registration (portable-safe).
 * Startup entry always points at stable launcher under %LOCALAPPDATA%\WXQK\launcher\,
 * never a versioned EXE path like 微信群控系统v1.106.exe.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

/** @type {{ app?: any, fs?: typeof fs, homedir?: () => string, platform?: string, copyFileSync?: Function }} */
let deps = {}

function setBackgroundStartupDepsForTest(overrides = {}) {
  deps = { ...deps, ...overrides }
}

function resetBackgroundStartupDepsForTest() {
  deps = {}
}

function resolveStableUserDataRoot(userDataRoot) {
  return String(userDataRoot || '').trim()
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'WXQK')
}

function resolveStableLauncherPath(userDataRoot) {
  return path.join(resolveStableUserDataRoot(userDataRoot), 'launcher', '微信群控系统.exe')
}

/**
 * Ensure %LOCALAPPDATA%\WXQK\launcher\微信群控系统.exe exists (copy from sourceExe when provided).
 * @returns {{ ok: boolean, path: string, code: string, message?: string }}
 */
function ensureStableLauncherCopy(options = {}) {
  const fsApi = deps.fs || fs
  const copyFileSync = deps.copyFileSync || fs.copyFileSync
  const launcher = resolveStableLauncherPath(options.userDataRoot)
  const dir = path.dirname(launcher)
  try { fsApi.mkdirSync?.(dir, { recursive: true }) } catch {
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* ignore */ }
  }
  const source = String(options.sourceExe || '').trim()
  if (source && fsApi.existsSync(source)) {
    try {
      if (path.resolve(source) !== path.resolve(launcher)) {
        copyFileSync(source, launcher)
      }
      return { ok: true, path: launcher, code: 'COPIED' }
    } catch (error) {
      return { ok: false, path: launcher, code: 'COPY_FAILED', message: String(error?.message || error) }
    }
  }
  if (fsApi.existsSync(launcher)) return { ok: true, path: launcher, code: 'EXISTS' }
  return { ok: false, path: launcher, code: 'STABLE_LAUNCHER_MISSING', message: '稳定启动器尚不存在' }
}

/**
 * Idempotent: register HKCU/Electron login item for stable launcher --background.
 * @returns {{ ok: boolean, path?: string, code: string, message?: string }}
 */
function ensureWindowsBackgroundStartup(options = {}) {
  const platform = deps.platform || process.platform
  if (platform !== 'win32' && !deps.app) {
    return { ok: true, code: 'SKIPPED_NON_WINDOWS' }
  }
  const ensured = ensureStableLauncherCopy(options)
  const launcher = ensured.path || resolveStableLauncherPath(options.userDataRoot)
  if (!options.allowMissing && !ensured.ok && ensured.code === 'STABLE_LAUNCHER_MISSING') {
    return { ok: false, code: 'STABLE_LAUNCHER_MISSING', path: launcher, message: '稳定启动器尚不存在' }
  }
  const app = options.app || deps.app
  if (app && typeof app.setLoginItemSettings === 'function') {
    try {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        path: launcher,
        args: ['--background'],
      })
      return { ok: true, code: 'REGISTERED', path: launcher }
    } catch (error) {
      return { ok: false, code: 'LOGIN_ITEM_FAILED', path: launcher, message: String(error?.message || error) }
    }
  }
  return { ok: true, code: 'NO_ELECTRON_APP', path: launcher }
}

function isBackgroundLaunchArgv(argv = process.argv) {
  return (argv || []).some((a) => a === '--background' || a === '--startup')
}

module.exports = {
  resolveStableLauncherPath,
  ensureStableLauncherCopy,
  ensureWindowsBackgroundStartup,
  isBackgroundLaunchArgv,
  setBackgroundStartupDepsForTest,
  resetBackgroundStartupDepsForTest,
}
