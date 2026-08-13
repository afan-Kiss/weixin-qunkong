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
const HANDOFF_RESULT_FILE = 'handoff-result.json'
const ROLLBACK_DIR_NAME = 'rollback'
const ROLLBACK_META_FILE = 'rollback-meta.json'

const PHASE = Object.freeze({
  IDLE: 'IDLE',
  PREPARING: 'PREPARING',
  PREPARED: 'PREPARED',
  DRAINING: 'DRAINING',
  WAITING_OLD_EXIT: 'WAITING_OLD_EXIT',
  STARTING_NEW: 'STARTING_NEW',
  WAITING_NEW_READY: 'WAITING_NEW_READY',
  COMMITTING: 'COMMITTING',
  COMMITTED: 'COMMITTED',
  ROLLING_BACK: 'ROLLING_BACK',
  ROLLED_BACK: 'ROLLED_BACK',
  FAILED: 'FAILED',
})

const APPLYING_LOCK_TTL_MS = 10 * 60 * 1000

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
    PHASE.COMMITTING,
    PHASE.ROLLING_BACK,
  ].includes(phase) || fs.existsSync(path.join(resolveUpdateStateDir(userDataDir), APPLYING_LOCK))
}

function writeApplyingLock(userDataDir, payload = {}) {
  const dir = ensureStateDir(userDataDir)
  const row = {
    updateId: String(payload.updateId || ''),
    helperPid: Number(payload.helperPid || 0) || 0,
    createdAt: String(payload.createdAt || new Date().toISOString()),
    ttlMs: Number(payload.ttlMs || APPLYING_LOCK_TTL_MS) || APPLYING_LOCK_TTL_MS,
  }
  writeJson(path.join(dir, APPLYING_LOCK), row)
  return row
}

function readApplyingLock(userDataDir) {
  return readJson(path.join(resolveUpdateStateDir(userDataDir), APPLYING_LOCK))
}

function isPidAlive(pid) {
  const n = Number(pid || 0)
  if (!n) return false
  try {
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

function writeHandoffResult(userDataDir, payload) {
  const dir = ensureStateDir(userDataDir)
  const row = {
    schema: 1,
    updateId: String(payload.updateId || ''),
    result: String(payload.result || ''),
    reason: String(payload.reason || ''),
    at: new Date().toISOString(),
  }
  writeJson(path.join(dir, HANDOFF_RESULT_FILE), row)
  return row
}

function readHandoffResult(userDataDir) {
  return readJson(path.join(resolveUpdateStateDir(userDataDir), HANDOFF_RESULT_FILE))
}

function getRollbackArtifactPath(userDataDir, updateId) {
  return path.join(
    resolveUpdateStateDir(userDataDir),
    ROLLBACK_DIR_NAME,
    String(updateId || 'unknown'),
    'previous.exe',
  )
}

/**
 * ROLLBACK_ARTIFACT_GATE: copy current old EXE before old process exits.
 */
function prepareRollbackArtifact(userDataDir, { updateId, oldExePath }) {
  const uid = String(updateId || '')
  const src = path.resolve(String(oldExePath || ''))
  if (!uid) return { ok: false, reason: 'ROLLBACK_ARTIFACT_PREPARE_FAILED', detail: 'updateId_missing' }
  if (!src || !fs.existsSync(src)) {
    return { ok: false, reason: 'ROLLBACK_ARTIFACT_PREPARE_FAILED', detail: 'old_missing' }
  }
  const dest = getRollbackArtifactPath(userDataDir, uid)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  try {
    fs.copyFileSync(src, dest)
  } catch (error) {
    return {
      ok: false,
      reason: 'ROLLBACK_ARTIFACT_PREPARE_FAILED',
      detail: 'copy_failed',
      error: String(error && error.message || error),
    }
  }
  const srcSha = hashFileSync(src)
  const dstSha = hashFileSync(dest)
  if (srcSha !== dstSha) {
    try { fs.unlinkSync(dest) } catch { /* ignore */ }
    return { ok: false, reason: 'ROLLBACK_ARTIFACT_PREPARE_FAILED', detail: 'sha_mismatch' }
  }
  const meta = {
    schema: 1,
    updateId: uid,
    oldExePath: src,
    artifactPath: path.resolve(dest),
    sha256: dstSha,
    preparedAt: new Date().toISOString(),
  }
  writeJson(path.join(path.dirname(dest), ROLLBACK_META_FILE), meta)
  return { ok: true, ...meta }
}

function readRollbackMeta(userDataDir, updateId) {
  const dest = getRollbackArtifactPath(userDataDir, updateId)
  return readJson(path.join(path.dirname(dest), ROLLBACK_META_FILE))
}

/**
 * Restore original versioned entry from rollback artifact (commit-critical for rollback).
 */
function restoreOriginalEntryFromArtifact(userDataDir, { updateId, oldExePath }) {
  const meta = readRollbackMeta(userDataDir, updateId)
  const artifact = path.resolve(String(meta?.artifactPath || getRollbackArtifactPath(userDataDir, updateId)))
  const target = path.resolve(String(oldExePath || meta?.oldExePath || ''))
  if (!artifact || !fs.existsSync(artifact)) {
    return { ok: false, reason: 'rollback_artifact_missing', artifact }
  }
  if (!target) return { ok: false, reason: 'old_entry_missing' }
  const expectedSha = String(meta?.sha256 || hashFileSync(artifact)).toLowerCase()
  try {
    if (path.resolve(artifact) !== target) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(artifact, target)
    }
  } catch (error) {
    return { ok: false, reason: 'old_entry_restore_failed', error: String(error && error.message || error) }
  }
  const actual = hashFileSync(target).toLowerCase()
  if (actual !== expectedSha) {
    return { ok: false, reason: 'old_entry_sha_mismatch', expectedSha, actual }
  }
  return { ok: true, artifact, oldExePath: target, sha256: actual }
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
    rollbackArtifactPath: payload.rollbackArtifactPath
      ? path.resolve(String(payload.rollbackArtifactPath))
      : '',
    rollbackSha256: String(payload.rollbackSha256 || '').toLowerCase(),
    version: String(payload.version || ''),
    buildId: String(payload.buildId || ''),
    releaseSequence: Number(payload.releaseSequence || 0) || 0,
    sha256: String(payload.sha256 || '').toLowerCase(),
    preparedAt: new Date().toISOString(),
    parentPid: Number(payload.parentPid || process.pid) || process.pid,
  }
  writeJson(path.join(dir, PREPARED_FILE), row)
  try { fs.unlinkSync(path.join(dir, READY_FILE)) } catch { /* ignore */ }
  writeApplyingLock(userDataDir, { updateId: row.updateId, helperPid: 0, createdAt: row.preparedAt })
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
 * Full READY validation (Node source of truth).
 * @param {object} prepared
 * @param {object|null} ready
 * @param {{ expectedNewPid?: number }} [options]
 */
function validateReadyAck(prepared, ready, options = {}) {
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
  const expected = options.expectedNewPid != null ? Number(options.expectedNewPid) : null
  if (expected != null && Number.isFinite(expected) && expected > 0 && pid !== expected) {
    return { ok: false, reason: 'pid_mismatch' }
  }
  if (!isPidAlive(pid)) return { ok: false, reason: 'pid_dead' }
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
    // Ignore stale READY for a different updateId; keep waiting for current ACK.
    if (ready && String(ready.updateId || '') && String(ready.updateId) !== String(prepared?.updateId || '')) {
      await new Promise((r) => setTimeout(r, pollMs))
      continue
    }
    const check = validateReadyAck(prepared, ready, { expectedNewPid: options.expectedNewPid })
    if (check.ok) return { ok: true, ready, waitedMs: Date.now() - started }
    // Current updateId marker present but invalid → fail closed immediately
    if (ready && String(ready.updateId || '') === String(prepared?.updateId || '') && !check.ok
      && check.reason !== 'missing' && check.reason !== 'pid_dead') {
      return { ok: false, reason: `READY_INVALID_${check.reason}`, waitedMs: Date.now() - started, ready }
    }
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

function verifyCopiedSha(filePath, expectedSha) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'missing' }
  const actual = hashFileSync(filePath).toLowerCase()
  const expected = String(expectedSha || '').toLowerCase()
  if (!expected || actual !== expected) return { ok: false, reason: 'sha_mismatch', actual, expected }
  return { ok: true, actual }
}

/**
 * Commit-critical launch entries. Never silent-ignore failures.
 */
function commitLaunchEntries({ installDir, newExePath, oldExePath, committed }) {
  const expectedSha = String(committed?.sha256 || '').toLowerCase()
  const stable = path.join(installDir, STABLE_LAUNCHER_NAME)
  const result = {
    ok: true,
    reason: '',
    stableLauncher: { path: stable, created: false, shaMatch: false },
    oldEntry: { path: oldExePath ? path.resolve(oldExePath) : '', updated: false, shaMatch: false },
    currentPointer: { written: false, valid: false },
  }

  try {
    if (path.resolve(newExePath) !== path.resolve(stable)) {
      fs.copyFileSync(newExePath, stable)
      result.stableLauncher.created = true
    } else {
      result.stableLauncher.created = true
    }
    const stableCheck = verifyCopiedSha(stable, expectedSha)
    result.stableLauncher.shaMatch = Boolean(stableCheck.ok)
    if (!stableCheck.ok) {
      result.ok = false
      result.reason = 'LAUNCH_ENTRY_VERIFY_FAILED'
      return result
    }
  } catch (error) {
    result.ok = false
    result.reason = 'STABLE_LAUNCHER_WRITE_FAILED'
    result.error = String(error && error.message || error)
    return result
  }

  if (oldExePath && path.resolve(oldExePath) !== path.resolve(newExePath)) {
    try {
      fs.copyFileSync(newExePath, oldExePath)
      result.oldEntry.updated = true
      const oldCheck = verifyCopiedSha(oldExePath, expectedSha)
      result.oldEntry.shaMatch = Boolean(oldCheck.ok)
      if (!oldCheck.ok) {
        result.ok = false
        result.reason = 'ORIGINAL_ENTRY_UPDATE_FAILED'
        return result
      }
    } catch (error) {
      result.ok = false
      result.reason = 'ORIGINAL_ENTRY_WRITE_FAILED'
      result.error = String(error && error.message || error)
      return result
    }
  } else if (oldExePath) {
    result.oldEntry.updated = true
    result.oldEntry.shaMatch = true
  }

  const pointer = {
    currentPortableExePath: path.resolve(newExePath),
    stableLauncherPath: path.resolve(stable),
    buildId: committed.buildId,
    version: committed.version,
    sha256: committed.sha256,
    releaseSequence: committed.releaseSequence,
    updateId: committed.updateId,
    committedAt: committed.committedAt || new Date().toISOString(),
  }
  try {
    writeInstallCurrentPointers(installDir, { pending: null, current: pointer })
    result.currentPointer.written = true
    const readBack = readInstallCurrent(installDir)
    const valid = Boolean(
      readBack
      && path.resolve(String(readBack.currentPortableExePath || '')) === path.resolve(newExePath)
      && String(readBack.sha256 || '').toLowerCase() === expectedSha
      && Number(readBack.releaseSequence || 0) === Number(committed.releaseSequence || 0)
      && String(readBack.updateId || '') === String(committed.updateId || ''),
    )
    result.currentPointer.valid = valid
    if (!valid) {
      result.ok = false
      result.reason = 'CURRENT_POINTER_VERIFY_FAILED'
      return result
    }
  } catch (error) {
    result.ok = false
    result.reason = 'CURRENT_POINTER_WRITE_FAILED'
    result.error = String(error && error.message || error)
    return result
  }

  return result
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
      } catch { /* ignore — CLEANUP_BEST_EFFORT */ }
    }
  } catch { /* ignore */ }
  return { removed }
}

/**
 * Conservative startup recovery when helper died mid-handoff.
 * Prefer ROLLBACK OLD unless NEW is clearly COMMITTED.
 */
function inspectStaleApplying(userDataDir, { now = Date.now(), ttlMs = APPLYING_LOCK_TTL_MS } = {}) {
  const phaseRow = getPhase(userDataDir)
  const phase = String(phaseRow.phase || PHASE.IDLE)
  const result = readHandoffResult(userDataDir)
  if (result?.result === 'COMMITTED' || phase === PHASE.COMMITTED) {
    return { stale: false, action: 'none', reason: 'already_committed' }
  }
  if (result?.result === 'ROLLED_BACK' || phase === PHASE.ROLLED_BACK) {
    return { stale: false, action: 'none', reason: 'already_rolled_back' }
  }
  const lock = readApplyingLock(userDataDir)
  const applyingPhases = [
    PHASE.WAITING_OLD_EXIT,
    PHASE.STARTING_NEW,
    PHASE.WAITING_NEW_READY,
    PHASE.COMMITTING,
    PHASE.ROLLING_BACK,
    PHASE.PREPARED,
  ]
  if (!applyingPhases.includes(phase) && !lock) {
    return { stale: false, action: 'none', reason: 'idle' }
  }
  const createdAt = Date.parse(String(lock?.createdAt || phaseRow.at || '')) || 0
  const lockTtl = Number(lock?.ttlMs || ttlMs) || ttlMs
  const expired = !createdAt || (now - createdAt) > lockTtl
  const helperAlive = isPidAlive(lock?.helperPid)
  if (!expired && helperAlive) {
    return { stale: false, action: 'wait', reason: 'helper_alive' }
  }
  if (phase === PHASE.COMMITTED) {
    return { stale: false, action: 'none', reason: 'committed' }
  }
  // Conservative: cannot prove COMMITTED → prefer rollback
  return {
    stale: true,
    action: 'rollback',
    reason: helperAlive ? 'ttl_expired' : 'helper_dead_or_missing',
    phase,
    lock,
  }
}

module.exports = {
  PHASE,
  STATE_DIR_NAME,
  PREPARED_FILE,
  READY_FILE,
  COMMITTED_FILE,
  FAILED_FILE,
  HANDOFF_RESULT_FILE,
  APPLYING_LOCK_TTL_MS,
  STABLE_LAUNCHER_NAME,
  resolveUpdateStateDir,
  ensureStateDir,
  newUpdateId,
  setPhase,
  getPhase,
  isUpdateApplying,
  writeApplyingLock,
  readApplyingLock,
  writeHandoffResult,
  readHandoffResult,
  getRollbackArtifactPath,
  prepareRollbackArtifact,
  readRollbackMeta,
  restoreOriginalEntryFromArtifact,
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
  inspectStaleApplying,
  isPidAlive,
}
