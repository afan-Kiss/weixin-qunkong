'use strict'

/**
 * Portable handoff: helper waits NEW_VERSION_READY ACK, then COMMIT / ROLLBACK.
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
  waitForReadyAck,
  validateReadyAck,
  writeCommitted,
  recordHighestCommittedReleaseSequence,
  writeFailedUpdate,
  clearFailedUpdate,
  setPhase,
  writeInstallCurrentPointers,
  commitLaunchEntries,
  cleanupOldVersionedExes,
  resolveUpdateStateDir,
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
 * 3) waits READY ACK in LOCALAPPDATA update-state
 * 4) COMMIT + cleanup OR ROLLBACK old
 *
 * @returns {{ helperPid: number, updateId: string, prepared: object }}
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

  const prepared = writePrepared(userDataPath, {
    updateId,
    exePath: finalPath,
    oldExePath: currentExe,
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

  // PowerShell helper: wait old exit → start new → poll ready.json → commit/rollback via node one-liner is fragile;
  // instead embed validation in PS and call a small node commit script we write beside helper.
  const electronExe = String(options.electronExe || process.execPath)
  const handoffModulePath = path.join(__dirname, 'update-handoff.cjs')

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

  const commitPayload = JSON.stringify({
    userDataPath,
    updateId,
    finalPath,
    currentExe,
    downloadPath,
    expectedSha256: String(expectedSha256 || ''),
    version: String(manifest.version || ''),
    buildId: String(manifest.buildId || ''),
    releaseSequence: Number(manifest.releaseSequence || 0) || 0,
  })
  const rollbackPayload = JSON.stringify({
    userDataPath,
    updateId,
    finalPath,
    currentExe,
    expectedSha256: String(expectedSha256 || ''),
    version: String(manifest.version || ''),
    buildId: String(manifest.buildId || ''),
    releaseSequence: Number(manifest.releaseSequence || 0) || 0,
    reason: 'NEW_READY_TIMEOUT',
  })

  const script = [
    'param([int]$ParentPid,[string]$CurrentExe,[string]$FinalPath,[string]$DownloadPath,[string]$ExpectedSha256,[string]$LogPath,[string]$ReadyPath,[string]$PreparedPath,[string]$UpdateId,[int]$ReadyTimeoutSec,[string]$CommitJs,[string]$RollbackJs,[string]$CommitJson,[string]$RollbackJson,[string]$ElectronExe)',
    "$ErrorActionPreference = 'Stop'",
    'function Log([string]$Message) { Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ((Get-Date -Format o) + " " + $Message) }',
    'function RunNode([string]$Script,[string]$Json) {',
    '  $env:ELECTRON_RUN_AS_NODE = "1"',
    '  & $ElectronExe $Script $Json',
    '  return $LASTEXITCODE',
    '}',
    'Log "handoff wait old exit parent=$ParentPid updateId=$UpdateId"',
    'try { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction SilentlyContinue } catch {}',
    'for ($i = 0; $i -lt 120; $i++) {',
    '  try { if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 500; continue }; break } catch { break }',
    '}',
    'if (-not (Test-Path -LiteralPath $FinalPath)) { Log "final missing"; exit 1 }',
    " $actual = (Get-FileHash -LiteralPath $FinalPath -Algorithm SHA256).Hash.ToLowerInvariant()",
    " if ($actual -ne $ExpectedSha256.ToLowerInvariant()) { Log 'SHA mismatch before start'; exit 1 }",
    ' Log "starting new"',
    ' $env:PORTABLE_EXECUTABLE_FILE = $FinalPath',
    ' $env:PORTABLE_EXECUTABLE_DIR = Split-Path -Parent $FinalPath',
    ' $env:WXQK_UPDATE_ID = $UpdateId',
    ' $p = Start-Process -FilePath $FinalPath -ArgumentList @("--after-update","--update-id=$UpdateId") -WorkingDirectory (Split-Path -Parent $FinalPath) -PassThru -WindowStyle Hidden -ErrorAction Stop',
    ' if (-not $p -or -not $p.Id) { Log "spawn failed"; exit 1 }',
    ' Log ("new pid=" + $p.Id)',
    ' $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)',
    ' $readyOk = $false',
    ' while ((Get-Date) -lt $deadline) {',
    '   if ($p.HasExited) { Log "new exited before ready"; break }',
    '   if (Test-Path -LiteralPath $ReadyPath) {',
    '     try {',
    '       $ready = Get-Content -LiteralPath $ReadyPath -Raw -Encoding UTF8 | ConvertFrom-Json',
    '       if ($ready.status -eq "ready" -and $ready.updateId -eq $UpdateId -and [int]$ready.pid -gt 0) {',
    '         $readyOk = $true; break',
    '       }',
    '     } catch { }',
    '   }',
    '   Start-Sleep -Milliseconds 500',
    ' }',
    ' if ($readyOk) {',
    '   Log "ready ack ok — commit"',
    '   $code = RunNode $CommitJs $CommitJson',
    '   if ($code -ne 0) { Log "commit js failed"; exit 1 }',
    '   Remove-Item -LiteralPath $DownloadPath -Force -ErrorAction SilentlyContinue',
    '   Log "commit done"; exit 0',
    ' }',
    ' Log "ready failed — rollback"',
    ' try { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } } catch {}',
    ' $null = RunNode $RollbackJs $RollbackJson',
    ' exit 1',
  ].join('\r\n')

  fs.writeFileSync(helperPath, `\uFEFF${script}`, 'utf8')
  const child = spawn('powershell.exe', [
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
    commitPayload,
    rollbackPayload,
    electronExe,
  ], { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
  if (!child.pid) throw new Error('无法启动更新交接助手')
  return { helperPid: child.pid, updateId, prepared }
}

/**
 * Called by helper after READY ACK observed.
 */
async function finalizeCommit(opts) {
  const userDataPath = String(opts.userDataPath || '')
  const prepared = readPrepared(userDataPath)
  const updateId = String(opts.updateId || prepared?.updateId || '')
  if (!prepared || prepared.updateId !== updateId) {
    return { ok: false, reason: 'prepared_mismatch' }
  }
  const installDir = path.dirname(String(opts.finalPath || prepared.exePath))
  const committed = writeCommitted(userDataPath, {
    updateId,
    exePath: opts.finalPath || prepared.exePath,
    oldExePath: opts.currentExe || prepared.oldExePath,
    version: opts.version || prepared.version,
    buildId: opts.buildId || prepared.buildId,
    releaseSequence: opts.releaseSequence || prepared.releaseSequence,
    sha256: opts.expectedSha256 || prepared.sha256,
  })
  recordHighestCommittedReleaseSequence(committed.releaseSequence, userDataPath)
  clearFailedUpdate(userDataPath)
  const entries = commitLaunchEntries({
    installDir,
    newExePath: committed.exePath,
    oldExePath: committed.oldExePath,
    committed,
  })
  // Retain current + previous versioned; extras cleaned. Old path may now be overwritten copy of new.
  cleanupOldVersionedExes(installDir, {
    keepPaths: [committed.exePath, committed.oldExePath, entries.stableLauncherPath],
    maxExtras: 0,
  })
  setPhase(userDataPath, PHASE.COMMITTED, { updateId })
  return { ok: true, committed, stableLauncher: entries.stableLauncherPath }
}

/**
 * Rollback to old EXE after new failed READY.
 */
async function finalizeRollback(opts) {
  const userDataPath = String(opts.userDataPath || '')
  const prepared = readPrepared(userDataPath)
  const updateId = String(opts.updateId || prepared?.updateId || '')
  const reason = String(opts.reason || 'NEW_READY_TIMEOUT')
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
  writeInstallCurrentPointers(installDir, {
    pending: null,
    current: {
      currentPortableExePath: path.resolve(oldExe),
      rolledBackAt: new Date().toISOString(),
      updateId,
    },
  })
  // Do NOT delete old; restart old with --update-rollback
  if (oldExe && fs.existsSync(oldExe)) {
    const child = spawn(oldExe, ['--update-rollback', `--update-id=${updateId}`], {
      cwd: path.dirname(oldExe),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        PORTABLE_EXECUTABLE_FILE: oldExe,
        PORTABLE_EXECUTABLE_DIR: path.dirname(oldExe),
      },
    })
    child.unref()
    if (!child.pid) {
      setPhase(userDataPath, PHASE.FAILED, { updateId, reason: 'rollback_spawn_failed' })
      return { ok: false, reason: 'rollback_spawn_failed' }
    }
    setPhase(userDataPath, PHASE.ROLLED_BACK, { updateId, oldPid: child.pid })
    return { ok: true, oldPid: child.pid, reason }
  }
  setPhase(userDataPath, PHASE.FAILED, { updateId, reason: 'old_missing' })
  return { ok: false, reason: 'old_missing' }
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
  STABLE_LAUNCHER_NAME,
  waitForReadyAck,
  validateReadyAck,
  newUpdateId,
}
