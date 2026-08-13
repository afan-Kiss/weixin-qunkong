'use strict'

/**
 * Portable handoff: helper waits NEW_VERSION_READY ACK, then COMMIT / ROLLBACK.
 * HANDOFF_TERMINAL_STATE_GATE: after old PID exits, only COMMITTED or ROLLED_BACK.
 */

const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const {
  PHASE,
  newUpdateId,
  writePrepared,
  readPrepared,
  writeReadyAck,
  readReady,
  validateReadyAck,
  writeCommitted,
  recordHighestCommittedReleaseSequence,
  loadHighestCommittedReleaseSequence,
  writeFailedUpdate,
  clearFailedUpdate,
  setPhase,
  writeInstallCurrentPointers,
  commitLaunchEntries,
  cleanupOldVersionedExes,
  resolveUpdateStateDir,
  prepareRollbackArtifact,
  restoreOriginalEntryFromArtifact,
  readRollbackMeta,
  writeHandoffResult,
  writeApplyingLock,
  hashFileSync,
  STABLE_LAUNCHER_NAME,
} = require('./update-state.cjs')

const DEFAULT_READY_TIMEOUT_MS = 90_000

function parseUpdateCliArgs(argv = process.argv) {
  const args = Array.isArray(argv) ? argv : []
  let updateId = ''
  let afterUpdate = false
  let updateRollback = false
  for (let i = 0; i < args.length; i += 1) {
    const a = String(args[i] || '')
    if (a === '--after-update') afterUpdate = true
    if (a === '--update-rollback') updateRollback = true
    if (a.startsWith('--update-id=')) updateId = a.slice('--update-id='.length).trim()
    if (a === '--update-id' && args[i + 1]) updateId = String(args[i + 1] || '').trim()
  }
  return { updateId, afterUpdate, updateRollback }
}

/**
 * Schedule detached helper that:
 * 1) waits old PID exit
 * 2) starts new with --after-update --update-id
 * 3) waits READY marker, validates via Node handoff-validate
 * 4) COMMIT + cleanup OR ROLLBACK old
 *
 * ROLLBACK_ARTIFACT_GATE: artifact prepared before helper starts (old still running).
 *
 * @returns {{ helperPid: number, updateId: string, prepared: object, rollbackArtifact: object }}
 */
function schedulePortableHandoff(options) {
  const {
    currentExe,
    finalPath,
    downloadPath,
    expectedSha256,
    userDataPath,
    manifest = {},
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  } = options

  const updateId = String(options.updateId || newUpdateId())
  const stateDir = resolveUpdateStateDir(userDataPath)
  fs.mkdirSync(stateDir, { recursive: true })

  // Must succeed while old process is still alive
  const rollbackArtifact = prepareRollbackArtifact(userDataPath, {
    updateId,
    oldExePath: currentExe,
  })
  if (!rollbackArtifact.ok) {
    const err = new Error(rollbackArtifact.reason || 'ROLLBACK_ARTIFACT_PREPARE_FAILED')
    err.code = rollbackArtifact.reason
    err.detail = rollbackArtifact.detail
    throw err
  }

  const prepared = writePrepared(userDataPath, {
    updateId,
    exePath: finalPath,
    oldExePath: currentExe,
    rollbackArtifactPath: rollbackArtifact.artifactPath,
    rollbackSha256: rollbackArtifact.sha256,
    version: manifest.version,
    buildId: manifest.buildId,
    releaseSequence: manifest.releaseSequence,
    sha256: expectedSha256,
    parentPid: process.pid,
  })

  const installDir = path.dirname(finalPath)
  writeInstallCurrentPointers(installDir, {
    pending: {
      pendingPortableExePath: path.resolve(finalPath),
      updateId,
      sha256: String(expectedSha256 || '').toLowerCase(),
      releaseSequence: Number(manifest.releaseSequence || 0) || 0,
      preparedAt: prepared.preparedAt,
    },
    current: {
      currentPortableExePath: path.resolve(currentExe),
      updateId: 'previous',
    },
  })

  setPhase(userDataPath, PHASE.WAITING_OLD_EXIT, { updateId })

  const workDir = path.dirname(downloadPath)
  fs.mkdirSync(workDir, { recursive: true })
  const helperPath = path.join(workDir, `handoff-${Date.now()}-${process.pid}.ps1`)
  const logPath = path.join(workDir, 'handoff.log')
  const readyPath = path.join(stateDir, 'ready.json')
  const preparedPath = path.join(stateDir, 'prepared.json')

  const electronExe = String(options.electronExe || process.execPath)
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : spawn
  const handoffModulePath = path.join(__dirname, 'update-handoff.cjs')
  const validateJs = path.join(__dirname, 'handoff-validate.cjs')

  const commitJs = path.join(workDir, `handoff-commit-${process.pid}.cjs`)
  const rollbackJs = path.join(workDir, `handoff-rollback-${process.pid}.cjs`)

  fs.writeFileSync(commitJs, `
'use strict';
const handoff = require(${JSON.stringify(handoffModulePath)});
const opts = JSON.parse(process.argv[2] || '{}');
handoff.finalizeCommit(opts).then((r) => {
  console.log(JSON.stringify(r));
  process.exit(r && r.ok ? 0 : 1);
}).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
`.trim(), 'utf8')

  fs.writeFileSync(rollbackJs, `
'use strict';
const handoff = require(${JSON.stringify(handoffModulePath)});
const opts = JSON.parse(process.argv[2] || '{}');
handoff.finalizeRollback(opts).then((r) => {
  console.log(JSON.stringify(r));
  process.exit(r && r.ok ? 0 : 1);
}).catch((e) => { console.error(String(e && e.message || e)); process.exit(1); });
`.trim(), 'utf8')

  const commitPayloadBase = {
    userDataPath,
    updateId,
    finalPath,
    currentExe,
    downloadPath,
    expectedSha256: String(expectedSha256 || ''),
    version: String(manifest.version || ''),
    buildId: String(manifest.buildId || ''),
    releaseSequence: Number(manifest.releaseSequence || 0) || 0,
    rollbackArtifactPath: rollbackArtifact.artifactPath,
  }
  const rollbackPayloadBase = {
    ...commitPayloadBase,
    reason: 'NEW_READY_TIMEOUT',
  }

  // PowerShell: after $oldExited=$true every failure goes through Invoke-Rollback (never bare exit 1).
  const script = [
    'param([int]$ParentPid,[string]$CurrentExe,[string]$FinalPath,[string]$DownloadPath,[string]$ExpectedSha256,[string]$LogPath,[string]$ReadyPath,[string]$PreparedPath,[string]$UpdateId,[int]$ReadyTimeoutSec,[string]$CommitJs,[string]$RollbackJs,[string]$CommitJson,[string]$RollbackJson,[string]$ElectronExe,[string]$ValidateJs,[string]$UserDataPath)',
    "$ErrorActionPreference = 'Stop'",
    '$oldExited = $false',
    '$newPid = 0',
    'function Log([string]$Message) { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ((Get-Date -Format o) + " " + $Message) }',
    'function RunNode([string]$Script,[string]$Json) {',
    '  $env:ELECTRON_RUN_AS_NODE = "1"',
    '  & $ElectronExe $Script $Json',
    '  return $LASTEXITCODE',
    '}',
    'function Invoke-Rollback([string]$Reason) {',
    '  Log ("Invoke-Rollback reason=" + $Reason + " oldExited=" + $oldExited + " newPid=" + $newPid)',
    '  try { if ($newPid -gt 0) { $np = Get-Process -Id $newPid -ErrorAction SilentlyContinue; if ($np -and -not $np.HasExited) { Stop-Process -Id $newPid -Force -ErrorAction SilentlyContinue } } } catch {}',
    '  try {',
    '    $rb = $RollbackJson | ConvertFrom-Json',
    '    $rb.reason = $Reason',
    '    if ($newPid -gt 0) { $rb.newPid = $newPid }',
    '    $rbJson = ($rb | ConvertTo-Json -Compress -Depth 8)',
    '    $null = RunNode $RollbackJs $rbJson',
    '  } catch {',
    '    Log ("rollback invoke error: " + $_.Exception.Message)',
    '  }',
    '  exit 1',
    '}',
    'Log "handoff wait old exit parent=$ParentPid updateId=$UpdateId"',
    'try { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction SilentlyContinue } catch {}',
    'for ($i = 0; $i -lt 120; $i++) {',
    '  try { if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500; continue }; break } catch { break }',
    '}',
    '$oldExited = $true',
    'Log "old exited confirmed"',
    'if (-not (Test-Path -LiteralPath $FinalPath)) { Invoke-Rollback "FINAL_MISSING" }',
    '$actual = (Get-FileHash -LiteralPath $FinalPath -Algorithm SHA256).Hash.ToLowerInvariant()',
    'if ($actual -ne $ExpectedSha256.ToLowerInvariant()) { Invoke-Rollback "FINAL_SHA_MISMATCH" }',
    'Log "starting new"',
    'try {',
    '  $env:PORTABLE_EXECUTABLE_FILE = $FinalPath',
    '  $env:PORTABLE_EXECUTABLE_DIR = Split-Path -Parent $FinalPath',
    '  $env:WXQK_UPDATE_ID = $UpdateId',
    '  $p = Start-Process -FilePath $FinalPath -ArgumentList @("--after-update","--update-id=$UpdateId") -WorkingDirectory (Split-Path -Parent $FinalPath) -PassThru -WindowStyle Hidden -ErrorAction Stop',
    '} catch {',
    '  Log ("spawn exception: " + $_.Exception.Message)',
    '  Invoke-Rollback "NEW_SPAWN_FAILED"',
    '}',
    'if (-not $p -or -not $p.Id -or $p.Id -le 0) { Invoke-Rollback "NEW_PID_INVALID" }',
    '$newPid = [int]$p.Id',
    'Log ("new pid=" + $newPid)',
    '$deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)',
    '$readySeen = $false',
    'while ((Get-Date) -lt $deadline) {',
    '  if ($p.HasExited) { Invoke-Rollback "NEW_PROCESS_EXITED_BEFORE_READY" }',
    '  if (Test-Path -LiteralPath $ReadyPath) {',
    '    $readySeen = $true',
    '    break',
    '  }',
    '  Start-Sleep -Milliseconds 500',
    '}',
    'if (-not $readySeen) { Invoke-Rollback "NEW_READY_TIMEOUT" }',
    'Log "ready marker present — full Node validate"',
    '$env:ELECTRON_RUN_AS_NODE = "1"',
    '$vout = & $ElectronExe $ValidateJs --user-data $UserDataPath --update-id $UpdateId --expected-new-pid $newPid --json 2>&1 | Out-String',
    'if ($LASTEXITCODE -ne 0) {',
    '  $reason = "READY_INVALID"',
    '  try { $parsed = $vout | ConvertFrom-Json; if ($parsed.reason) { $reason = [string]$parsed.reason } } catch {}',
    '  Invoke-Rollback $reason',
    '}',
    'Log "ready full validation ok — commit"',
    '$commitObj = $CommitJson | ConvertFrom-Json',
    '$commitObj.expectedNewPid = $newPid',
    '$commitPayload = ($commitObj | ConvertTo-Json -Compress -Depth 8)',
    '$code = RunNode $CommitJs $commitPayload',
    'if ($code -ne 0) { Invoke-Rollback "COMMIT_FAILED" }',
    'Remove-Item -LiteralPath $DownloadPath -Force -ErrorAction SilentlyContinue',
    'Log "commit done"',
    'exit 0',
  ].join('\r\n')

  fs.writeFileSync(helperPath, `\uFEFF${script}`, 'utf8')
  const child = spawnImpl('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
    String(process.pid),
    currentExe,
    finalPath,
    downloadPath,
    String(expectedSha256 || ''),
    logPath,
    readyPath,
    preparedPath,
    updateId,
    String(Math.ceil(readyTimeoutMs / 1000)),
    commitJs,
    rollbackJs,
    JSON.stringify(commitPayloadBase),
    JSON.stringify(rollbackPayloadBase),
    electronExe,
    validateJs,
    String(userDataPath || ''),
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  if (!child.pid) throw new Error('无法启动更新交接助手')
  writeApplyingLock(userDataPath, {
    updateId,
    helperPid: child.pid,
    createdAt: new Date().toISOString(),
  })
  return { helperPid: child.pid, updateId, prepared, rollbackArtifact }
}

/**
 * Called by helper after READY ACK fully validated.
 * Order: validate → verify SHA → launch entries → pointer → committed → highest seq.
 */
async function finalizeCommit(opts) {
  const userDataPath = String(opts.userDataPath || '')
  const prepared = readPrepared(userDataPath)
  const updateId = String(opts.updateId || prepared?.updateId || '')
  if (!prepared || prepared.updateId !== updateId) {
    return { ok: false, reason: 'prepared_mismatch' }
  }

  const ready = readReady(userDataPath)
  const expectedNewPid = Number(opts.expectedNewPid || 0) || 0
  const validation = validateReadyAck(prepared, ready, {
    expectedNewPid: expectedNewPid > 0 ? expectedNewPid : undefined,
  })
  if (!validation.ok) {
    return { ok: false, reason: `READY_INVALID_${validation.reason}` }
  }

  const finalPath = path.resolve(String(opts.finalPath || prepared.exePath))
  if (!fs.existsSync(finalPath)) {
    return { ok: false, reason: 'FINAL_MISSING' }
  }
  const expectedSha = String(opts.expectedSha256 || prepared.sha256 || '').toLowerCase()
  const actualSha = hashFileSync(finalPath).toLowerCase()
  if (!expectedSha || actualSha !== expectedSha) {
    return { ok: false, reason: 'FINAL_SHA_MISMATCH', actualSha, expectedSha }
  }
  if (String(ready.sha256 || '').toLowerCase() !== expectedSha) {
    return { ok: false, reason: 'READY_INVALID_sha_mismatch' }
  }

  setPhase(userDataPath, PHASE.COMMITTING, { updateId })

  const committedDraft = {
    updateId,
    exePath: finalPath,
    oldExePath: opts.currentExe || prepared.oldExePath,
    version: opts.version || prepared.version,
    buildId: opts.buildId || prepared.buildId,
    releaseSequence: Number(opts.releaseSequence || prepared.releaseSequence || 0) || 0,
    sha256: expectedSha,
    committedAt: new Date().toISOString(),
  }

  const installDir = path.dirname(finalPath)
  const entries = commitLaunchEntries({
    installDir,
    newExePath: committedDraft.exePath,
    oldExePath: committedDraft.oldExePath,
    committed: committedDraft,
  })
  if (!entries.ok) {
    return { ok: false, reason: entries.reason || 'LAUNCH_ENTRY_COMMIT_FAILED', entries }
  }

  // COMMITTED marker last among commit-critical writes (after launch entries + pointer)
  const committed = writeCommitted(userDataPath, committedDraft)
  recordHighestCommittedReleaseSequence(committed.releaseSequence, userDataPath)
  clearFailedUpdate(userDataPath)

  // CLEANUP_BEST_EFFORT
  try {
    cleanupOldVersionedExes(installDir, {
      keepPaths: [committed.exePath, committed.oldExePath, entries.stableLauncher.path],
      maxExtras: 0,
    })
  } catch { /* ignore */ }

  writeHandoffResult(userDataPath, { updateId, result: 'COMMITTED' })
  setPhase(userDataPath, PHASE.COMMITTED, { updateId })
  return { ok: true, committed, entries, stableLauncher: entries.stableLauncher.path }
}

/**
 * Rollback to old EXE using rollback artifact (never rely solely on possibly overwritten old entry).
 */
async function finalizeRollback(opts) {
  const userDataPath = String(opts.userDataPath || '')
  const prepared = readPrepared(userDataPath)
  const updateId = String(opts.updateId || prepared?.updateId || '')
  const reason = String(opts.reason || 'NEW_READY_TIMEOUT')
  const highestBefore = loadHighestCommittedReleaseSequence(userDataPath)

  writeFailedUpdate(userDataPath, {
    updateId,
    releaseSequence: opts.releaseSequence || prepared?.releaseSequence,
    sha256: opts.expectedSha256 || prepared?.sha256,
    buildId: opts.buildId || prepared?.buildId,
    reason,
    backoffMs: 30 * 60 * 1000,
  })
  setPhase(userDataPath, PHASE.ROLLING_BACK, { updateId, reason })

  const oldExe = String(opts.currentExe || prepared?.oldExePath || '')
  const installDir = path.dirname(String(opts.finalPath || prepared?.exePath || oldExe))

  const restored = restoreOriginalEntryFromArtifact(userDataPath, {
    updateId,
    oldExePath: oldExe,
  })
  if (!restored.ok) {
    writeHandoffResult(userDataPath, { updateId, result: 'FAILED', reason: restored.reason || 'rollback_restore_failed' })
    setPhase(userDataPath, PHASE.FAILED, { updateId, reason: restored.reason })
    return { ok: false, reason: restored.reason || 'rollback_restore_failed', highestCommitted: highestBefore }
  }

  // Prefer restarting restored original entry; fall back to artifact path
  const launchPath = (oldExe && fs.existsSync(oldExe)) ? oldExe : restored.artifact
  writeInstallCurrentPointers(installDir, {
    pending: null,
    current: {
      currentPortableExePath: path.resolve(launchPath),
      rolledBackAt: new Date().toISOString(),
      updateId,
      sha256: restored.sha256,
    },
  })

  if (launchPath && fs.existsSync(launchPath)) {
    const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn
    const child = spawnImpl(launchPath, ['--update-rollback', `--update-id=${updateId}`], {
      cwd: path.dirname(launchPath),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        PORTABLE_EXECUTABLE_FILE: launchPath,
        PORTABLE_EXECUTABLE_DIR: path.dirname(launchPath),
      },
    })
    child.unref()
    if (!child.pid) {
      writeHandoffResult(userDataPath, { updateId, result: 'FAILED', reason: 'rollback_spawn_failed' })
      setPhase(userDataPath, PHASE.FAILED, { updateId, reason: 'rollback_spawn_failed' })
      return { ok: false, reason: 'rollback_spawn_failed', highestCommitted: highestBefore }
    }
    writeHandoffResult(userDataPath, { updateId, result: 'ROLLED_BACK', reason })
    setPhase(userDataPath, PHASE.ROLLED_BACK, { updateId, oldPid: child.pid })
    return {
      ok: true,
      oldPid: child.pid,
      reason,
      launchPath,
      restored,
      highestCommitted: loadHighestCommittedReleaseSequence(userDataPath),
    }
  }
  writeHandoffResult(userDataPath, { updateId, result: 'FAILED', reason: 'old_missing' })
  setPhase(userDataPath, PHASE.FAILED, { updateId, reason: 'old_missing' })
  return { ok: false, reason: 'old_missing', highestCommitted: highestBefore }
}

/**
 * New process: after critical startup, write READY ACK.
 */
function emitNewVersionReadyAck(options = {}) {
  const cli = parseUpdateCliArgs(options.argv || process.argv)
  if (!cli.afterUpdate && !options.force) return { ok: false, reason: 'not_after_update' }
  const userDataPath = String(options.userDataPath || '')
  const prepared = readPrepared(userDataPath)
  const updateId = String(options.updateId || cli.updateId || process.env.WXQK_UPDATE_ID || prepared?.updateId || '')
  if (!prepared || (updateId && prepared.updateId !== updateId)) {
    return { ok: false, reason: 'updateId_mismatch', prepared, updateId }
  }
  const exePath = path.resolve(String(options.exePath || process.env.PORTABLE_EXECUTABLE_FILE || process.execPath))
  if (path.resolve(prepared.exePath) !== exePath) {
    return { ok: false, reason: 'exe_mismatch' }
  }
  const ready = writeReadyAck(userDataPath, {
    updateId: prepared.updateId,
    exePath,
    version: options.version || prepared.version,
    buildId: options.buildId || prepared.buildId,
    releaseSequence: options.releaseSequence || prepared.releaseSequence,
    sha256: prepared.sha256,
  })
  return { ok: true, ready }
}

module.exports = {
  DEFAULT_READY_TIMEOUT_MS,
  parseUpdateCliArgs,
  schedulePortableHandoff,
  finalizeCommit,
  finalizeRollback,
  emitNewVersionReadyAck,
  validateReadyAck,
  prepareRollbackArtifact,
  readRollbackMeta,
}
