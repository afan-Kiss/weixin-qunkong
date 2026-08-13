'use strict'

/**
 * Fail-safe round-2: old-exit confirmation, rollback fallbacks, commit atomicity, publish secret.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')

const state = require('../electron/update-state.cjs')
const handoff = require('../electron/update-handoff.cjs')
const { buildPublishChildArgs, assertNoSecretInArgs } = require('../scripts/build-publish-invocation.cjs')

function shaOf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function makeDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

test('helper confirms old exit and aborts when old still alive', () => {
  const dir = makeDir('upd-old-')
  const install = path.join(dir, 'inst')
  const work = path.join(dir, 'work')
  mkdirSync(install)
  mkdirSync(work)
  const oldExe = path.join(install, '微信群控系统v1.104.exe')
  const finalPath = path.join(install, '微信群控系统v1.105.exe')
  const downloadPath = path.join(work, 'dl.bin')
  writeFileSync(oldExe, 'OLD')
  writeFileSync(finalPath, 'NEW')
  writeFileSync(downloadPath, 'NEW')
  let scriptPath = ''
  handoff.schedulePortableHandoff({
    currentExe: oldExe,
    finalPath,
    downloadPath,
    expectedSha256: shaOf('NEW'),
    userDataPath: dir,
    manifest: { version: '1.105', buildId: 'b', releaseSequence: 105 },
    electronExe: process.execPath,
    spawnImpl: (_cmd, args) => {
      scriptPath = args[args.indexOf('-File') + 1]
      return { pid: 9001, unref() {} }
    },
  })
  const script = readFileSync(scriptPath, 'utf8')
  assert.match(script, /function Confirm-OldProcessExited/)
  assert.match(script, /function Test-ProcessAlive/)
  assert.match(script, /Invoke-AbortOldStillRunning "OLD_EXIT_TIMEOUT"/)
  assert.match(script, /\$rbCode = RunNode \$RollbackJs/)
  assert.match(script, /ROLLBACK_FALLBACK/)
  // oldExited only after Confirm-OldProcessExited succeeds (not after bare poll loop)
  assert.match(script, /Confirm-OldProcessExited[\s\S]*\$oldExited = \$true/)
  assert.match(script, /if \(-not \(Confirm-OldProcessExited[\s\S]*Invoke-AbortOldStillRunning "OLD_EXIT_TIMEOUT"/)
  cleanup(dir)
})

test('abort old still running writes ABORTED_OLD_STILL_RUNNING', () => {
  const dir = makeDir('upd-abort-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  state.writePrepared(dir, {
    updateId: 'a1',
    exePath: path.join(install, 'n.exe'),
    oldExePath: path.join(install, 'o.exe'),
    sha256: 'aa'.repeat(32),
    releaseSequence: 1,
  })
  state.writeApplyingLock(dir, { updateId: 'a1', helperPid: 1 })
  const r = handoff.finalizeAbortOldStillRunning({
    userDataPath: dir,
    updateId: 'a1',
    installDir: install,
    reason: 'OLD_EXIT_TIMEOUT',
  })
  assert.equal(r.ok, true)
  assert.equal(state.readHandoffResult(dir).result, 'ABORTED_OLD_STILL_RUNNING')
  assert.equal(state.getPhase(dir).phase, state.PHASE.ABORTED)
  assert.equal(existsSync(path.join(state.resolveUpdateStateDir(dir), 'applying.lock')), false)
  cleanup(dir)
})

test('rollback level2 uses verified artifact when original restore fails', async () => {
  const dir = makeDir('upd-l2-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const oldExe = path.join(install, '微信群控系统v1.104.exe')
  const newExe = path.join(install, '微信群控系统v1.200.exe')
  writeFileSync(oldExe, 'OLD_BYTES')
  writeFileSync(newExe, 'BAD')
  const art = state.prepareRollbackArtifact(dir, { updateId: 'l2', oldExePath: oldExe })
  assert.equal(art.ok, true)
  // Make original path unrestorable by pointing oldExe to a directory name conflict via skipLevel1
  state.writePrepared(dir, {
    updateId: 'l2',
    exePath: newExe,
    oldExePath: oldExe,
    rollbackArtifactPath: art.artifactPath,
    rollbackSha256: art.sha256,
    sha256: shaOf('BAD'),
    releaseSequence: 200,
  })
  state.recordHighestCommittedReleaseSequence(100, dir)
  let spawned = null
  const result = await handoff.finalizeRollback({
    userDataPath: dir,
    updateId: 'l2',
    currentExe: oldExe,
    finalPath: newExe,
    expectedSha256: shaOf('BAD'),
    releaseSequence: 200,
    reason: 'COMMIT_FAILED',
    skipLevel1: true,
    spawnImpl: (cmd) => {
      spawned = cmd
      return { pid: 5555, unref() {} }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.result, 'ROLLED_BACK_ARTIFACT_DIRECT')
  assert.equal(path.resolve(spawned), path.resolve(art.artifactPath))
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 100)
  cleanup(dir)
})

test('rollback level3 restores stable launcher', async () => {
  const dir = makeDir('upd-l3-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const oldExe = path.join(install, '微信群控系统v1.104.exe')
  const newExe = path.join(install, '微信群控系统v1.201.exe')
  writeFileSync(oldExe, 'OLD_L3')
  writeFileSync(newExe, 'BAD')
  const art = state.prepareRollbackArtifact(dir, { updateId: 'l3', oldExePath: oldExe })
  state.writePrepared(dir, {
    updateId: 'l3',
    exePath: newExe,
    oldExePath: oldExe,
    rollbackArtifactPath: art.artifactPath,
    rollbackSha256: art.sha256,
    sha256: shaOf('BAD'),
    releaseSequence: 201,
  })
  let spawned = null
  const result = await handoff.finalizeRollback({
    userDataPath: dir,
    updateId: 'l3',
    currentExe: oldExe,
    finalPath: newExe,
    skipLevel1: true,
    // Force level2 spawn fail by returning null pid once then succeed — simpler: monkey via spawnImpl counting
    spawnImpl: (cmd) => {
      if (String(cmd).includes('previous.exe')) {
        return { pid: 0, unref() {} } // invalid pid → level2 fail
      }
      spawned = cmd
      return { pid: 6666, unref() {} }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(result.result, 'ROLLED_BACK_STABLE_LAUNCHER')
  assert.ok(String(spawned).endsWith(state.STABLE_LAUNCHER_NAME) || String(spawned).includes(state.STABLE_LAUNCHER_NAME))
  assert.equal(state.hashFileSync(path.join(install, state.STABLE_LAUNCHER_NAME)), art.sha256)
  cleanup(dir)
})

test('all rollback fallbacks fail → FAILED_UNRECOVERABLE with recovery metadata', async () => {
  const dir = makeDir('upd-fail-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const oldExe = path.join(install, 'o.exe')
  const newExe = path.join(install, 'n.exe')
  writeFileSync(oldExe, 'O')
  writeFileSync(newExe, 'N')
  state.writePrepared(dir, {
    updateId: 'f1',
    exePath: newExe,
    oldExePath: oldExe,
    sha256: shaOf('N'),
    releaseSequence: 9,
  })
  // No rollback artifact
  const result = await handoff.finalizeRollback({
    userDataPath: dir,
    updateId: 'f1',
    currentExe: oldExe,
    finalPath: newExe,
    skipLevel1: true,
    spawnImpl: () => ({ pid: 0, unref() {} }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.result, 'FAILED_UNRECOVERABLE')
  assert.ok(result.recovery)
  assert.equal(state.readHandoffResult(dir).result, 'FAILED_UNRECOVERABLE')
  cleanup(dir)
})

test('highest write fail leaves no committed marker', async () => {
  const dir = makeDir('upd-hi-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const newExe = path.join(install, '微信群控系统v1.106.exe')
  const oldExe = path.join(install, '微信群控系统v1.104.exe')
  writeFileSync(newExe, 'GOOD')
  writeFileSync(oldExe, 'OLD')
  const sha = shaOf('GOOD')
  const art = state.prepareRollbackArtifact(dir, { updateId: 'h1', oldExePath: oldExe })
  state.writePrepared(dir, {
    updateId: 'h1',
    exePath: newExe,
    oldExePath: oldExe,
    rollbackArtifactPath: art.artifactPath,
    rollbackSha256: art.sha256,
    sha256: sha,
    releaseSequence: 106,
  })
  state.writeReadyAck(dir, {
    updateId: 'h1',
    exePath: newExe,
    sha256: sha,
    releaseSequence: 106,
  })
  state.recordHighestCommittedReleaseSequence(100, dir)
  const result = await handoff.finalizeCommit({
    userDataPath: dir,
    updateId: 'h1',
    finalPath: newExe,
    currentExe: oldExe,
    expectedSha256: sha,
    releaseSequence: 106,
    expectedNewPid: process.pid,
    injectHighestWriteFail: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'HIGHEST_COMMITTED_WRITE_FAILED')
  assert.equal(state.readCommitted(dir), null)
  assert.notEqual(state.getPhase(dir).phase, state.PHASE.COMMITTED)
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 100)
  cleanup(dir)
})

test('ghost committed marker cleaned on rollback and reconcile', async () => {
  const dir = makeDir('upd-ghost-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const oldExe = path.join(install, 'o.exe')
  const newExe = path.join(install, 'n.exe')
  writeFileSync(oldExe, 'OLDG')
  writeFileSync(newExe, 'NEWG')
  const art = state.prepareRollbackArtifact(dir, { updateId: 'g1', oldExePath: oldExe })
  state.writePrepared(dir, {
    updateId: 'g1',
    exePath: newExe,
    oldExePath: oldExe,
    rollbackArtifactPath: art.artifactPath,
    rollbackSha256: art.sha256,
    sha256: shaOf('NEWG'),
    releaseSequence: 77,
  })
  // Simulate ghost: committed.json written for failed update
  state.writeCommittedMarker(dir, {
    updateId: 'g1',
    exePath: newExe,
    oldExePath: oldExe,
    sha256: shaOf('NEWG'),
    releaseSequence: 77,
  })
  state.setPhase(dir, state.PHASE.ROLLING_BACK, { updateId: 'g1' })
  const rb = await handoff.finalizeRollback({
    userDataPath: dir,
    updateId: 'g1',
    currentExe: oldExe,
    finalPath: newExe,
    spawnImpl: () => ({ pid: 4242, unref() {} }),
  })
  assert.equal(rb.ok, true)
  assert.equal(state.readCommitted(dir), null)

  // Historical conflict: phase rolled back + committed ghost
  state.writeCommittedMarker(dir, {
    updateId: 'g1',
    exePath: newExe,
    sha256: shaOf('NEWG'),
    releaseSequence: 77,
  })
  state.writeHandoffResult(dir, { updateId: 'g1', result: 'ROLLED_BACK', reason: 'x' })
  state.setPhase(dir, state.PHASE.ROLLED_BACK, { updateId: 'g1' })
  const cleaned = state.reconcileConflictingMarkers(dir)
  assert.equal(cleaned.cleaned, true)
  assert.equal(cleaned.reason, 'STALE_COMMITTED_MARKER_REMOVED')
  assert.equal(state.readCommitted(dir), null)
  cleanup(dir)
})

test('publish child args never include secret or -Password', () => {
  const secret = 'WXQK_TEST_SECRET_123'
  const args = buildPublishChildArgs({
    baseUrl: 'https://example.test/wxqk',
    exePath: 'C:\\tmp\\微信群控系统v1.105.exe',
    targetClientIds: ['client-a'],
  })
  const check = assertNoSecretInArgs(args, secret)
  assert.equal(check.ok, true)
  assert.equal(args.includes('-Password'), false)
  assert.equal(args.join(' ').includes(secret), false)
})

test('successful commit writes highest before committed marker', async () => {
  const dir = makeDir('upd-order-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const newExe = path.join(install, '微信群控系统v1.107.exe')
  const oldExe = path.join(install, '微信群控系统v1.104.exe')
  writeFileSync(newExe, 'OK107')
  writeFileSync(oldExe, 'OLD104')
  const sha = shaOf('OK107')
  const art = state.prepareRollbackArtifact(dir, { updateId: 'ord', oldExePath: oldExe })
  state.writePrepared(dir, {
    updateId: 'ord',
    exePath: newExe,
    oldExePath: oldExe,
    rollbackArtifactPath: art.artifactPath,
    rollbackSha256: art.sha256,
    sha256: sha,
    releaseSequence: 107,
  })
  state.writeReadyAck(dir, { updateId: 'ord', exePath: newExe, sha256: sha, releaseSequence: 107 })
  state.recordHighestCommittedReleaseSequence(100, dir)
  const result = await handoff.finalizeCommit({
    userDataPath: dir,
    updateId: 'ord',
    finalPath: newExe,
    currentExe: oldExe,
    expectedSha256: sha,
    releaseSequence: 107,
    expectedNewPid: process.pid,
  })
  assert.equal(result.ok, true)
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 107)
  assert.equal(state.readCommitted(dir).updateId, 'ord')
  assert.equal(state.readHandoffResult(dir).result, 'COMMITTED')
  cleanup(dir)
})
