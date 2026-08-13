'use strict'

/**
 * Portable update state machine: PREPARED → WAITING_NEW_READY → COMMITTED | ROLLING_BACK.
 * Markers live under %LOCALAPPDATA%\\WXQK\\update-state\\ (stable, not portable dir).
 */

const fs = require('fs')
const path = require('path')
const { createHash, randomBytes } = require('crypto')
const os = require('os')

const STATE_DIR_NAME = 'update-state'
const PREPARED_FILE = 'prepared.json'
const READY_FILE = 'ready.json'
const COMMITTED_FILE = 'committed.json'
const FAILED_FILE = 'failed-update.json'
const PHASE_FILE = 'phase.json'
const HIGHEST_COMMITTED_FILE = 'highest-committed-seq.json'
const APPLYING_LOCK = 'applying.lock'

const PHASE = Object.freeze({
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  PREPARED: 'PREPARED',
  DRAINING: 'DRAINING',
  WAITING_OLD_EXIT: 'WAITING_OLD_EXIT',
  STARTING_NEW: 'STARTING_NEW',
  WAITING_NEW_READY: 'WAITING_NEW_READY',
  COMMITTED: 'COMMITTED',
  ROLLING_BACK: 'ROLLING_BACK',
  ROLLED_BACK: 'ROLLED_BACK',
  FAILED: 'FAILED',
})

/**
 * @param {string} [userDataDir]
 */
function resolveUpdateStateDir(userDataDir) {
  const explicit = String(userDataDir || '').trim()
  if (explicit) return path.join(explicit, STATE_DIR_NAME)
  const local = process.env.LOCALAPPDATA
    || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(local, 'WXQK', STATE_DIR_NAME)
}

function ensureStateDir(userDataDir) {
  const dir = resolveUpdateStateDir(userDataDir)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function newUpdateId() {
  return randomBytes(16).toString('hex')
}

function writeJson(filePath, row) {
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(row, null, 2), 'utf8')
  fs.renameSync(tmp, filePath)
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function setPhase(userDataDir, phase, extra = {}) {
  const dir = ensureStateDir(userDataDir)
  writeJson(path.join(dir, PHASE_FILE), {
    phase: String(phase || PHASE.IDLE),
    at: new Date().toISOString(),
    ...extra,
  })
}

function getPhase(userDataDir) {
  const row = readJson(path.join(resolveUpdateStateDir(userDataDir), PHASE_FILE))
  return row || { phase: PHASE.IDLE }
}

function isUpdateApplying(userDataDir) {
  const phase = String(getPhase(userDataDir).phase || '')
  return [
    PHASE.PREPARING,
    PHASE.PREPARED,
    PHASE.DRAINING,
    PHASE.WAITING_OLD_EXIT,
    PHASE.STARTING_NEW,
    PHASE.WAITING_NEW_READY,
    PHASE.ROLLING_BACK,
  ].includes(phase) || fs.existsSync(path.join(resolveUpdateStateDir(userDataDir), APPLYING_LOCK))
}

/**
 * @param {object} payload
 */
function writePrepared(userDataDir, payload) {
  const dir = ensureStateDir(userDataDir)
  const row = {
    schema: 1,
    status: 'prepared',
    updateId: String(payload.updateId || ''),
    exePath: path.resolve(String(payload.exePath || '')),
    oldExePath: path.resolve(String(payload.oldExePath || '')),
    version: String(payload.version || ''),
    buildId: String(payload.buildId || ''),
    releaseSequence: Number(payload.releaseSequence || 0) || 0,
    sha256: String(payload.sha256 || '').toLowerCase(),
    preparedAt: new Date().toISOString(),
    parentPid: Number(payload.parentPid || process.pid) || process.pid,
  }
  writeJson(path.join(dir, PREPARED_FILE), row)
  // Clear stale ready from previous attempts
  try { fs.unlinkSync(path.join(dir, READY_FILE)) } catch { /* ignore */ }
  writeJson(path.join(dir, APPLYING_LOCK), { updateId: row.updateId, at: row.preparedAt })
  setPhase(userDataDir, PHASE.PREPARED, { updateId: row.updateId })
  return row
}

function readPrepared(userDataDir) {
  return readJson(path.join(resolveUpdateStateDir(userDataDir), PREPARED_FILE))
}

/**
 * MUST be called only by the NEW process after critical startup.
 */
function writeReadyAck(userDataDir, payload) {
  const dir = ensureStateDir(userDataDir)
  const prepared = readPrepared(userDataDir)
  const updateId = String(payload.updateId || prepared?.updateId || '')
  const exePath = path.resolve(String(payload.exePath || process.env.PORTABLE_EXECUTABLE_FILE || process.execPath))
  const row = {
    schema: 1,
    status: 'ready',
    updateId,
    pid: process.pid,
    exePath,
    version: String(payload.version || ''),
    buildId: String(payload.buildId || ''),
    releaseSequence: Number(payload.releaseSequence || 0) || 0,
    sha256: String(payload.sha256 || prepared?.sha256 || '').toLowerCase(),
    readyAt: new Date().toISOString(),
    parentUpdateId: updateId,
  }
  writeJson(path.join(dir, READY_FILE), row)
  setPhase(userDataDir, PHASE.WAITING_NEW_READY, { updateId, note: 'ready_written' })
  return row
}

function readReady(userDataDir) {
  return readJson(path.join(resolveUpdateStateDir(userDataDir), READY_FILE))
}

/**
 * @param {object} prepared
 * @param {object|null} ready
 */
function validateReadyAck(prepared, ready) {
  if (!prepared || !ready) return { ok: false, reason: 'missing' }
  if (String(ready.status) !== 'ready') return { ok: false, reason: 'status' }
  if (String(ready.updateId || '') !== String(prepared.updateId || '')) {
    return { ok: false, reason: 'updateId_mismatch' }
  }
  if (path.resolve(String(ready.exePath || '')) !== path.resolve(String(prepared.exePath || ''))) {
    return { ok: false, reason: 'exe_mismatch' }
  }
  if (String(ready.sha256 || '').toLowerCase() !== String(prepared.sha256 || '').toLowerCase()) {
    return { ok: false, reason: 'sha_mismatch' }
  }
  if (Number(ready.releaseSequence || 0) !== Number(prepared.releaseSequence || 0)) {
    return { ok: false, reason: 'seq_mismatch' }
  }
  const pid = Number(ready.pid || 0)
  if (!pid) return { ok: false, reason: 'pid_missing' }
  try {
    process.kill(pid, 0)
  } catch {
    return { ok: false, reason: 'pid_dead' }
  }
  return { ok: true }
}

/**
 * Poll until READY ACK validates or timeout.
 */
async function waitForReadyAck(userDataDir, prepared, options = {}) {
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs || 90_000) || 90_000)
  const pollMs = Math.max(200, Number(options.pollMs || 500) || 500)
  const started = Date.now()
  setPhase(userDataDir, PHASE.WAITING_NEW_READY, { updateId: prepared?.updateId })
  while (Date.now() - started < timeoutMs) {
    const ready = readReady(userDataDir)
    const check = validateReadyAck(prepared, ready)
    if (check.ok) return { ok: true, ready, waitedMs: Date.now() - started }
    // If new process died without ready
    if (options.newPid) {
      try {
        process.kill(Number(options.newPid), 0)
      } catch {
        return { ok: false, reason: 'new_process_exited', waitedMs: Date.now() - started }
      }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return { ok: false, reason: 'NEW_READY_TIMEOUT', waitedMs: Date.now() - started, ready: readReady(userDataDir) }
}

function writeCommitted(userDataDir, payload) {
  const dir = ensureStateDir(userDataDir)
  const row = {
    schema: 1,
    status: 'committed',
    updateId: String(payload.updateId || ''),
    exePath: path.resolve(String(payload.exePath || '')),
    oldExePath: payload.oldExePath ? path.resolve(String(payload.oldExePath)) : '',
    version: String(payload.version || ''),
    buildId: String(payload.buildId || ''),
    releaseSequence: Number(payload.releaseSequence || 0) || 0,
    sha256: String(payload.sha256 || '').toLowerCase(),
    committedAt: new Date().toISOString(),
  }
  writeJson(path.join(dir, COMMITTED_FILE), row)
  try { fs.unlinkSync(path.join(dir, APPLYING_LOCK)) } catch { /* ignore */ }
  setPhase(userDataDir, PHASE.COMMITTED, { updateId: row.updateId })
  return row
}

function readCommitted(userDataDir) {
  return readJson(path.join(resolveUpdateStateDir(userDataDir), COMMITTED_FILE))
}

function loadHighestCommittedReleaseSequence(userDataDir) {
  const row = readJson(path.join(resolveUpdateStateDir(userDataDir), HIGHEST_COMMITTED_FILE))
  return Number(row?.highestCommittedReleaseSequence || 0) || 0
}

function recordHighestCommittedReleaseSequence(seq, userDataDir) {
  const next = Number(seq || 0) || 0
  if (next <= 0) return loadHighestCommittedReleaseSequence(userDataDir)
  const dir = ensureStateDir(userDataDir)
  const prev = loadHighestCommittedReleaseSequence(userDataDir)
  const value = Math.max(prev, next)
  writeJson(path.join(dir, HIGHEST_COMMITTED_FILE), {
    highestCommittedReleaseSequence: value,
    updatedAt: new Date().toISOString(),
  })
  return value
}

function writeFailedUpdate(userDataDir, payload) {
  const dir = ensureStateDir(userDataDir)
  const row = {
    schema: 1,
    releaseSequence: Number(payload.releaseSequence || 0) || 0,
    sha256: String(payload.sha256 || '').toLowerCase(),
    buildId: String(payload.buildId || ''),
    updateId: String(payload.updateId || ''),
    failedAt: new Date().toISOString(),
    reason: String(payload.reason || 'UNKNOWN'),
    backoffMs: Number(payload.backoffMs || 30 * 60 * 1000) || 30 * 60 * 1000,
  }
  writeJson(path.join(dir, FAILED_FILE), row)
  try { fs.unlinkSync(path.join(dir, APPLYING_LOCK)) } catch { /* ignore */ }
  setPhase(userDataDir, PHASE.FAILED, { updateId: row.updateId, reason: row.reason })
  return row
}

function readFailedUpdate(userDataDir) {
  return readJson(path.join(resolveUpdateStateDir(userDataDir), FAILED_FILE))
}

/**
 * Same artifact blocked during backoff after failed ready.
 */
function isFailedUpdateBlocked(man, userDataDir) {
  const failed = readFailedUpdate(userDataDir)
  if (!failed) return { blocked: false }
  const sha = String(man?.sha256 || '').toLowerCase()
  const seq = Number(man?.releaseSequence || 0) || 0
  const same = (sha && sha === String(failed.sha256 || ''))
    || (seq > 0 && seq === Number(failed.releaseSequence || 0))
  if (!same) return { blocked: false }
  const at = Date.parse(String(failed.failedAt || '')) || 0
  const backoff = Number(failed.backoffMs || 30 * 60 * 1000) || 30 * 60 * 1000
  const remain = at + backoff - Date.now()
  if (remain > 0) return { blocked: true, remainMs: remain, failed }
  return { blocked: false, expired: true, failed }
}

function clearFailedUpdate(userDataDir) {
  try { fs.unlinkSync(path.join(resolveUpdateStateDir(userDataDir), FAILED_FILE)) } catch { /* ignore */ }
}

function clearApplyingLock(userDataDir) {
  try { fs.unlinkSync(path.join(resolveUpdateStateDir(userDataDir), APPLYING_LOCK)) } catch { /* ignore */ }
}

function hashFileSync(filePath) {
  const hash = createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

/**
 * Install-dir current pointer: pending vs committed.
 * Lives beside EXEs for maybeRelaunch, but phase of truth is update-state.
 */
function writeInstallCurrentPointers(installDir, { pending, current }) {
  const pendingPath = path.join(installDir, 'pending-portable-exe.json')
  const currentPath = path.join(installDir, 'current-portable-exe.json')
  if (pending) writeJson(pendingPath, pending)
  else try { fs.unlinkSync(pendingPath) } catch { /* ignore */ }
  if (current) writeJson(currentPath, current)
}

function readInstallCurrent(installDir) {
  return readJson(path.join(installDir, 'current-portable-exe.json'))
}

function readInstallPending(installDir) {
  return readJson(path.join(installDir, 'pending-portable-exe.json'))
}

const STABLE_LAUNCHER_NAME = '微信群控系统.exe'

/**
 * After commit: ensure stable launcher name points at current bytes (full copy).
 * Also refresh old entry path so shortcuts keep working (overwrite with current bytes).
 */
function commitLaunchEntries({ installDir, newExePath, oldExePath, committed }) {
  const stable = path.join(installDir, STABLE_LAUNCHER_NAME)
  if (path.resolve(newExePath) !== path.resolve(stable)) {
    try {
      fs.copyFileSync(newExePath, stable)
    } catch { /* ignore */ }
  }
  // Keep original entry path working: overwrite old versioned EXE with new bytes (stub-equivalent)
  if (oldExePath && path.resolve(oldExePath) !== path.resolve(newExePath) && fs.existsSync(newExePath)) {
    try {
      fs.copyFileSync(newExePath, oldExePath)
    } catch { /* ignore — file may still be locked briefly */ }
  }
  writeInstallCurrentPointers(installDir, {
    pending: null,
    current: {
      currentPortableExePath: path.resolve(newExePath),
      stableLauncherPath: path.resolve(stable),
      buildId: committed.buildId,
      version: committed.version,
      sha256: committed.sha256,
      releaseSequence: committed.releaseSequence,
      updateId: committed.updateId,
      committedAt: committed.committedAt,
    },
  })
  return { stableLauncherPath: stable }
}

/**
 * Retain at most current + previous versioned EXEs (plus stable launcher).
 * Never touch Program Files\\WXQK.
 */
function cleanupOldVersionedExes(installDir, { keepPaths = [], maxExtras = 0 } = {}) {
  const keep = new Set(keepPaths.map((p) => path.resolve(String(p || '')).toLowerCase()).filter(Boolean))
  keep.add(path.resolve(path.join(installDir, STABLE_LAUNCHER_NAME)).toLowerCase())
  let removed = 0
  try {
    const names = fs.readdirSync(installDir)
    const candidates = []
    for (const name of names) {
      if (!/^微信群控系统v.+\.exe$/i.test(name)) continue
      const full = path.join(installDir, name)
      if (keep.has(path.resolve(full).toLowerCase())) continue
      try {
        candidates.push({ full, mtime: fs.statSync(full).mtimeMs })
      } catch { /* ignore */ }
    }
    candidates.sort((a, b) => b.mtime - a.mtime)
    for (const row of candidates.slice(maxExtras)) {
      try {
        fs.unlinkSync(row.full)
        removed += 1
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return { removed }
}

module.exports = {
  PHASE,
  STATE_DIR_NAME,
  PREPARED_FILE,
  READY_FILE,
  COMMITTED_FILE,
  FAILED_FILE,
  STABLE_LAUNCHER_NAME,
  resolveUpdateStateDir,
  ensureStateDir,
  newUpdateId,
  setPhase,
  getPhase,
  isUpdateApplying,
  writePrepared,
  readPrepared,
  writeReadyAck,
  readReady,
  validateReadyAck,
  waitForReadyAck,
  writeCommitted,
  readCommitted,
  loadHighestCommittedReleaseSequence,
  recordHighestCommittedReleaseSequence,
  writeFailedUpdate,
  readFailedUpdate,
  isFailedUpdateBlocked,
  clearFailedUpdate,
  clearApplyingLock,
  hashFileSync,
  writeInstallCurrentPointers,
  readInstallCurrent,
  readInstallPending,
  commitLaunchEntries,
  cleanupOldVersionedExes,
}
