'use strict'

/**
 * Portable handoff: helper waits NEW_VERSION_READY ACK, then COMMIT / ROLLBACK.
 * After old PID is confirmed exited: converge to COMMITTED or ROLLED_BACK*.
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
  writeCommittedMarker,
  setCommittedPhase,
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
  clearApplyingLock,
  clearGhostCommittedMarker,
  abortHandoffOldStillRunning,
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

function spawnDetached(spawnImpl, exePath, args, updateId) {
  const child = spawnImpl(exePath, args, {
    cwd: path.dirname(exePath),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      PORTABLE_EXECUTABLE_FILE: exePath,
      PORTABLE_EXECUTABLE_DIR: path.dirname(exePath),
    },
  })
  child.unref()
  return child
}

/**
 * Schedule detached helper.
 * ROLLBACK_ARTIFACT_GATE: artifact prepared before helper starts (old still running).
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
  const abortJs = path.join(workDir, `handoff-abort-${process.pid}.cjs`)

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

  fs.writeFileSync(abortJs, `
'use strict';
const handoff = require(${JSON.stringify(handoffModulePath)});
const opts = JSON.parse(process.argv[2] || '{}');
const r = handoff.finalizeAbortOldStillRunning(opts);
console.log(JSON.stringify(r));
process.exit(r && r.ok ? 0 : 1);
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
  const abortPayloadBase = {
    userDataPath,
    updateId,
    installDir,
    reason: 'OLD_EXIT_TIMEOUT',
  }

  const script = [
    'param([int]$ParentPid,[string]$CurrentExe,[string]$FinalPath,[string]$DownloadPath,[string]$ExpectedSha256,[string]$LogPath,[string]$ReadyPath,[string]$PreparedPath,[string]$UpdateId,[int]$ReadyTimeoutSec,[string]$CommitJs,[string]$RollbackJs,[string]$AbortJs,[string]$CommitJson,[string]$RollbackJson,[string]$AbortJson,[string]$ElectronExe,[string]$ValidateJs,[string]$UserDataPath)',
    "$ErrorActionPreference = 'Stop'",
    '$oldExited = $false',
    '$newPid = 0',
    'function Log([string]$Message) { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ((Get-Date -Format o) + " " + $Message) }',
    'function Test-ProcessAlive([int]$ProcId) {',
    '  if ($ProcId -le 0) { return $false }',
    '  try { $p = Get-Process -Id $ProcId -ErrorAction SilentlyContinue; return ($null -ne $p) } catch { return $false }',
    '}',
    'function Confirm-OldProcessExited([int]$ProcId, [int]$ExtraPolls) {',
    '  for ($i = 0; $i -lt $ExtraPolls; $i++) {',
    '    if (-not (Test-ProcessAlive $ProcId)) { return $true }',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '  return -not (Test-ProcessAlive $ProcId)',
    '}',
    'function RunNode([string]$Script,[string]$Json) {',
    '  $env:ELECTRON_RUN_AS_NODE = "1"',
    '  & $ElectronExe $Script $Json',
    '  return $LASTEXITCODE',
    '}',
    'function Invoke-AbortOldStillRunning([string]$Reason) {',
    '  Log ("OLD still running — abort handoff reason=" + $Reason)',
    '  try {',
    '    $ab = $AbortJson | ConvertFrom-Json',
    '    $ab.reason = $Reason',
    '    $abJson = ($ab | ConvertTo-Json -Compress -Depth 8)',
    '    $null = RunNode $AbortJs $abJson',
    '  } catch { Log ("abort invoke error: " + $_.Exception.Message) }',
    '  exit 2',
    '}',
    'function Invoke-Rollback([string]$Reason) {',
    '  Log ("Invoke-Rollback reason=" + $Reason + " oldExited=" + $oldExited + " newPid=" + $newPid)',
    '  if (-not $oldExited) {',
    '    Log "refuse rollback before old exit confirmation"',
    '    Invoke-AbortOldStillRunning "ROLLBACK_BEFORE_OLD_EXIT"',
    '  }',
    '  try { if ($newPid -gt 0) { $np = Get-Process -Id $newPid -ErrorAction SilentlyContinue; if ($np -and -not $np.HasExited) { Stop-Process -Id $newPid -Force -ErrorAction SilentlyContinue } } } catch {}',
    '  $rbCode = 1',
    '  try {',
    '    $rb = $RollbackJson | ConvertFrom-Json',
    '    $rb.reason = $Reason',
    '    if ($newPid -gt 0) { $rb.newPid = $newPid }',
    '    $rbJson = ($rb | ConvertTo-Json -Compress -Depth 8)',
    '    $rbCode = RunNode $RollbackJs $rbJson',
    '  } catch {',
    '    Log ("rollback invoke error: " + $_.Exception.Message)',
    '    $rbCode = 1',
    '  }',
    '  if ($rbCode -eq 0) { Log "rollback complete"; exit 1 }',
    '  Log ("ROLLBACK_FALLBACK: node rollback failed code=" + $rbCode)',
    '  try {',
    '    $rb2 = $RollbackJson | ConvertFrom-Json',
    '    $rb2.reason = $Reason',
    '    $rb2.forceFallback = $true',
    '    $rb2Json = ($rb2 | ConvertTo-Json -Compress -Depth 8)',
    '    $rbCode2 = RunNode $RollbackJs $rb2Json',
    '    if ($rbCode2 -eq 0) { Log "rollback fallback complete"; exit 1 }',
    '  } catch { Log ("rollback fallback error: " + $_.Exception.Message) }',
    '  Log "FAILED_UNRECOVERABLE after rollback fallbacks"',
    '  exit 3',
    '}',
    'Log "handoff wait old exit parent=$ParentPid updateId=$UpdateId"',
    'try { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction SilentlyContinue } catch {}',
    'if (-not (Confirm-OldProcessExited -ProcId $ParentPid -ExtraPolls 120)) {',
    '  Invoke-AbortOldStillRunning "OLD_EXIT_TIMEOUT"',
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
    abortJs,
    JSON.stringify(commitPayloadBase),
    JSON.stringify(rollbackPayloadBase),
    JSON.stringify(abortPayloadBase),
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

function finalizeAbortOldStillRunning(opts) {
  return abortHandoffOldStillRunning(String(opts.userDataPath || ''), {
    updateId: opts.updateId,
    reason: opts.reason || 'OLD_EXIT_TIMEOUT',
    installDir: opts.installDir || path.dirname(String(opts.finalPath || opts.currentExe || '')),
  })
}

/**
 * Order: validate → SHA → launch entries → highest committed → committed marker → phase.
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

  if (opts.injectHighestWriteFail) {
    return { ok: false, reason: 'HIGHEST_COMMITTED_WRITE_FAILED' }
  }

  try {
    recordHighestCommittedReleaseSequence(committedDraft.releaseSequence, userDataPath)
  } catch (error) {
    return {
      ok: false,
      reason: 'HIGHEST_COMMITTED_WRITE_FAILED',
      error: String(error && error.message || error),
    }
  }

  // COMMITTED marker only after highest seq persisted
  const committed = writeCommittedMarker(userDataPath, committedDraft)
  clearFailedUpdate(userDataPath)
  clearApplyingLock(userDataPath)
  setCommittedPhase(userDataPath, updateId)

  try {
    cleanupOldVersionedExes(installDir, {
      keepPaths: [committed.exePath, committed.oldExePath, entries.stableLauncher.path],
      maxExtras: 0,
    })
  } catch { /* CLEANUP_BEST_EFFORT */ }

  writeHandoffResult(userDataPath, { updateId, result: 'COMMITTED' })
  return { ok: true, committed, entries, stableLauncher: entries.stableLauncher.path }
}

/**
 * Multi-level rollback: original entry → artifact direct → stable launcher.
 */
async function finalizeRollback(opts) {
  const userDataPath = String(opts.userDataPath || '')
  const prepared = readPrepared(userDataPath)
  const updateId = String(opts.updateId || prepared?.updateId || '')
  const reason = String(opts.reason || 'NEW_READY_TIMEOUT')
  const highestBefore = loadHighestCommittedReleaseSequence(userDataPath)
  const spawnImpl = typeof opts.spawnImpl === 'function' ? opts.spawnImpl : spawn

  const ghost = clearGhostCommittedMarker(userDataPath, { updateId })

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
  const meta = readRollbackMeta(userDataPath, updateId)
  const rawArtifact = String(
    opts.rollbackArtifactPath
    || prepared?.rollbackArtifactPath
    || meta?.artifactPath
    || '',
  ).trim()
  const artifact = rawArtifact ? path.resolve(rawArtifact) : ''
  const expectedRollbackSha = String(meta?.sha256 || prepared?.rollbackSha256 || '').toLowerCase()

  const recovery = {
    artifact,
    oldExe,
    stableLauncher: path.join(installDir, STABLE_LAUNCHER_NAME),
    ghostCleared: Boolean(ghost.removed),
  }

  function verifyArtifact() {
    if (!artifact || !fs.existsSync(artifact)) {
      return { ok: false, reason: 'rollback_artifact_missing' }
    }
    try {
      if (!fs.statSync(artifact).isFile()) {
        return { ok: false, reason: 'rollback_artifact_not_file' }
      }
    } catch {
      return { ok: false, reason: 'rollback_artifact_missing' }
    }
    const actual = hashFileSync(artifact).toLowerCase()
    if (expectedRollbackSha && actual !== expectedRollbackSha) {
      return { ok: false, reason: 'rollback_artifact_sha_mismatch', actual, expected: expectedRollbackSha }
    }
    return { ok: true, sha256: actual }
  }

  // Level 1: restore original entry + restart
  if (!opts.skipLevel1) {
    const restored = restoreOriginalEntryFromArtifact(userDataPath, {
      updateId,
      oldExePath: oldExe,
    })
    if (restored.ok) {
      writeInstallCurrentPointers(installDir, {
        pending: null,
        current: {
          currentPortableExePath: path.resolve(oldExe),
          rolledBackAt: new Date().toISOString(),
          updateId,
          sha256: restored.sha256,
        },
      })
      try {
        const child = spawnDetached(spawnImpl, oldExe, ['--update-rollback', `--update-id=${updateId}`], updateId)
        if (child.pid) {
          writeHandoffResult(userDataPath, { updateId, result: 'ROLLED_BACK', reason })
          setPhase(userDataPath, PHASE.ROLLED_BACK, { updateId, oldPid: child.pid, level: 1 })
          return {
            ok: true,
            result: 'ROLLED_BACK',
            oldPid: child.pid,
            reason,
            launchPath: oldExe,
            level: 1,
            recovery,
            highestCommitted: loadHighestCommittedReleaseSequence(userDataPath),
          }
        }
      } catch (error) {
        recovery.level1Error = String(error && error.message || error)
      }
    } else {
      recovery.level1 = restored
    }
  }

  // Level 2: direct verified rollback artifact
  const artCheck = verifyArtifact()
  if (artCheck.ok) {
    try {
      const child = spawnDetached(spawnImpl, artifact, ['--update-rollback', `--update-id=${updateId}`], updateId)
      if (child.pid) {
        writeInstallCurrentPointers(installDir, {
          pending: null,
          current: {
            currentPortableExePath: path.resolve(artifact),
            rolledBackAt: new Date().toISOString(),
            updateId,
            sha256: artCheck.sha256,
            note: 'ROLLED_BACK_ARTIFACT_DIRECT',
          },
        })
        writeHandoffResult(userDataPath, {
          updateId,
          result: 'ROLLED_BACK_ARTIFACT_DIRECT',
          reason,
        })
        setPhase(userDataPath, PHASE.ROLLED_BACK, { updateId, oldPid: child.pid, level: 2 })
        return {
          ok: true,
          result: 'ROLLED_BACK_ARTIFACT_DIRECT',
          oldPid: child.pid,
          reason,
          launchPath: artifact,
          level: 2,
          recovery,
          highestCommitted: highestBefore,
        }
      }
    } catch (error) {
      recovery.level2Error = String(error && error.message || error)
    }
  } else {
    recovery.level2 = artCheck
  }

  // Level 3: restore stable launcher from artifact + restart
  if (artCheck.ok) {
    const stable = path.join(installDir, STABLE_LAUNCHER_NAME)
    try {
      fs.copyFileSync(artifact, stable)
      const stableSha = hashFileSync(stable).toLowerCase()
      if (stableSha !== artCheck.sha256) {
        recovery.level3 = { ok: false, reason: 'stable_sha_mismatch' }
      } else {
        const child = spawnDetached(spawnImpl, stable, ['--update-rollback', `--update-id=${updateId}`], updateId)
        if (child.pid) {
          writeInstallCurrentPointers(installDir, {
            pending: null,
            current: {
              currentPortableExePath: path.resolve(stable),
              rolledBackAt: new Date().toISOString(),
              updateId,
              sha256: stableSha,
              note: 'ROLLED_BACK_STABLE_LAUNCHER',
            },
          })
          writeHandoffResult(userDataPath, {
            updateId,
            result: 'ROLLED_BACK_STABLE_LAUNCHER',
            reason,
          })
          setPhase(userDataPath, PHASE.ROLLED_BACK, { updateId, oldPid: child.pid, level: 3 })
          return {
            ok: true,
            result: 'ROLLED_BACK_STABLE_LAUNCHER',
            oldPid: child.pid,
            reason,
            launchPath: stable,
            level: 3,
            recovery,
            highestCommitted: highestBefore,
          }
        }
      }
    } catch (error) {
      recovery.level3Error = String(error && error.message || error)
    }
  }

  writeHandoffResult(userDataPath, {
    updateId,
    result: 'FAILED_UNRECOVERABLE',
    reason: 'ALL_ROLLBACK_FALLBACKS_FAILED',
  })
  setPhase(userDataPath, PHASE.FAILED, { updateId, reason: 'FAILED_UNRECOVERABLE' })
  // Keep rollback artifact; do not delete recovery paths
  return {
    ok: false,
    result: 'FAILED_UNRECOVERABLE',
    reason: 'ALL_ROLLBACK_FALLBACKS_FAILED',
    recovery,
    highestCommitted: highestBefore,
  }
}

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
  finalizeAbortOldStillRunning,
  emitNewVersionReadyAck,
  validateReadyAck,
  prepareRollbackArtifact,
  readRollbackMeta,
}
