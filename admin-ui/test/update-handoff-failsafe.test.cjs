'use strict'

/**
 * Fail-safe handoff tests: post-exit rollback invariant, READY validation, launch entries, artifact.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, copyFileSync,
} = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')

const state = require('../electron/update-state.cjs')
const handoff = require('../electron/update-handoff.cjs')

function shaOf(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function makeDir(prefix) {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

test('rollback artifact prepared before old exit and SHA matches', () => {
  const dir = makeDir('upd-art-')
  const install = path.join(dir, 'install')
  mkdirSync(install)
  const oldExe = path.join(install, '微信群控系统v1.103.exe')
  writeFileSync(oldExe, 'OLD_BYTES_V103')
  const prepared = state.prepareRollbackArtifact(dir, { updateId: 'u1', oldExePath: oldExe })
  assert.equal(prepared.ok, true)
  assert.equal(existsSync(prepared.artifactPath), true)
  assert.equal(prepared.sha256, shaOf('OLD_BYTES_V103'))
  assert.equal(state.hashFileSync(prepared.artifactPath), prepared.sha256)
  cleanup(dir)
})

test('rollback artifact missing aborts prepare', () => {
  const dir = makeDir('upd-art-miss-')
  const bad = state.prepareRollbackArtifact(dir, {
    updateId: 'u2',
    oldExePath: path.join(dir, 'nope.exe'),
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'ROLLBACK_ARTIFACT_PREPARE_FAILED')
  cleanup(dir)
})

test('validateReadyAck requires expectedNewPid match', () => {
  const dir = makeDir('upd-pid-')
  const exe = path.join(dir, 'new.exe')
  writeFileSync(exe, 'NEW')
  const sha = shaOf('NEW')
  state.writePrepared(dir, {
    updateId: 'uid',
    exePath: exe,
    oldExePath: path.join(dir, 'old.exe'),
    sha256: sha,
    releaseSequence: 10,
  })
  const ready = state.writeReadyAck(dir, {
    updateId: 'uid',
    exePath: exe,
    sha256: sha,
    releaseSequence: 10,
  })
  const ok = state.validateReadyAck(state.readPrepared(dir), ready, { expectedNewPid: process.pid })
  assert.equal(ok.ok, true)
  const mismatch = state.validateReadyAck(state.readPrepared(dir), ready, { expectedNewPid: process.pid + 99999 })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.reason, 'pid_mismatch')
  cleanup(dir)
})

test('ready field mismatches fail closed', () => {
  const dir = makeDir('upd-ready-m-')
  const exe = path.join(dir, 'new.exe')
  writeFileSync(exe, 'X')
  const sha = shaOf('X')
  state.writePrepared(dir, {
    updateId: 'u',
    exePath: exe,
    oldExePath: path.join(dir, 'o.exe'),
    sha256: sha,
    releaseSequence: 7,
  })
  const base = {
    status: 'ready',
    updateId: 'u',
    pid: process.pid,
    exePath: exe,
    sha256: sha,
    releaseSequence: 7,
  }
  assert.equal(state.validateReadyAck(state.readPrepared(dir), { ...base, updateId: 'other' }).reason, 'updateId_mismatch')
  assert.equal(state.validateReadyAck(state.readPrepared(dir), { ...base, exePath: path.join(dir, 'other.exe') }).reason, 'exe_mismatch')
  assert.equal(state.validateReadyAck(state.readPrepared(dir), { ...base, sha256: 'aa'.repeat(32) }).reason, 'sha_mismatch')
  assert.equal(state.validateReadyAck(state.readPrepared(dir), { ...base, releaseSequence: 8 }).reason, 'seq_mismatch')
  cleanup(dir)
})

test('commitLaunchEntries fails when stable launcher write cannot verify', () => {
  const dir = makeDir('upd-launch-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const newExe = path.join(install, '微信群控系统v1.104.exe')
  const oldExe = path.join(install, '微信群控系统v1.103.exe')
  writeFileSync(newExe, 'NEW_EXE')
  writeFileSync(oldExe, 'OLD_EXE')
  const sha = shaOf('NEW_EXE')
  const bad = state.commitLaunchEntries({
    installDir: install,
    newExePath: newExe,
    oldExePath: oldExe,
    committed: {
      sha256: 'ff'.repeat(32), // wrong expected
      buildId: 'b',
      version: '1.104',
      releaseSequence: 100,
      updateId: 'u',
    },
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'LAUNCH_ENTRY_VERIFY_FAILED')
  cleanup(dir)
})

test('commitLaunchEntries succeeds and verifies both entries + pointer', () => {
  const dir = makeDir('upd-launch-ok-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const newExe = path.join(install, '微信群控系统v1.104.exe')
  const oldExe = path.join(install, '微信群控系统v1.103.exe')
  writeFileSync(newExe, 'NEW_EXE_OK')
  writeFileSync(oldExe, 'OLD_EXE')
  const sha = shaOf('NEW_EXE_OK')
  const ok = state.commitLaunchEntries({
    installDir: install,
    newExePath: newExe,
    oldExePath: oldExe,
    committed: {
      sha256: sha,
      buildId: 'b',
      version: '1.104',
      releaseSequence: 100,
      updateId: 'uid-ok',
      committedAt: new Date().toISOString(),
    },
  })
  assert.equal(ok.ok, true)
  assert.equal(ok.stableLauncher.shaMatch, true)
  assert.equal(ok.oldEntry.shaMatch, true)
  assert.equal(ok.currentPointer.valid, true)
  assert.equal(state.hashFileSync(path.join(install, state.STABLE_LAUNCHER_NAME)), sha)
  assert.equal(state.hashFileSync(oldExe), sha)
  cleanup(dir)
})

test('finalizeCommit re-validates READY and records highest only on success', async () => {
  const dir = makeDir('upd-fc-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const newExe = path.join(install, '微信群控系统v1.105.exe')
  const oldExe = path.join(install, '微信群控系统v1.103.exe')
  writeFileSync(newExe, 'COMMIT_NEW')
  writeFileSync(oldExe, 'COMMIT_OLD')
  const sha = shaOf('COMMIT_NEW')
  const art = state.prepareRollbackArtifact(dir, { updateId: 'fc1', oldExePath: oldExe })
  assert.equal(art.ok, true)
  state.writePrepared(dir, {
    updateId: 'fc1',
    exePath: newExe,
    oldExePath: oldExe,
    rollbackArtifactPath: art.artifactPath,
    rollbackSha256: art.sha256,
    sha256: sha,
    releaseSequence: 101,
    version: '1.105',
    buildId: 'b105',
  })
  state.writeReadyAck(dir, {
    updateId: 'fc1',
    exePath: newExe,
    sha256: sha,
    releaseSequence: 101,
  })
  state.recordHighestCommittedReleaseSequence(99, dir)
  const result = await handoff.finalizeCommit({
    userDataPath: dir,
    updateId: 'fc1',
    finalPath: newExe,
    currentExe: oldExe,
    expectedSha256: sha,
    releaseSequence: 101,
    version: '1.105',
    buildId: 'b105',
    expectedNewPid: process.pid,
  })
  assert.equal(result.ok, true)
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 101)
  assert.equal(state.readHandoffResult(dir).result, 'COMMITTED')
  cleanup(dir)
})

test('finalizeCommit fails on READY pid mismatch without raising highest', async () => {
  const dir = makeDir('upd-fc-pid-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const newExe = path.join(install, 'n.exe')
  const oldExe = path.join(install, 'o.exe')
  writeFileSync(newExe, 'N')
  writeFileSync(oldExe, 'O')
  const sha = shaOf('N')
  state.writePrepared(dir, {
    updateId: 'p1',
    exePath: newExe,
    oldExePath: oldExe,
    sha256: sha,
    releaseSequence: 50,
  })
  state.writeReadyAck(dir, { updateId: 'p1', exePath: newExe, sha256: sha, releaseSequence: 50 })
  state.recordHighestCommittedReleaseSequence(49, dir)
  const result = await handoff.finalizeCommit({
    userDataPath: dir,
    updateId: 'p1',
    finalPath: newExe,
    currentExe: oldExe,
    expectedSha256: sha,
    releaseSequence: 50,
    expectedNewPid: process.pid + 424242,
  })
  assert.equal(result.ok, false)
  assert.match(String(result.reason), /READY_INVALID_pid_mismatch/)
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 49)
  cleanup(dir)
})

test('finalizeRollback restores old entry and leaves highest unchanged', async () => {
  const dir = makeDir('upd-rb-')
  const install = path.join(dir, 'inst')
  mkdirSync(install)
  const newExe = path.join(install, '微信群控系统v1.200.exe')
  const oldExe = path.join(install, '微信群控系统v1.103.exe')
  writeFileSync(oldExe, 'OLD_ONLY')
  writeFileSync(newExe, 'BAD_NEW')
  const art = state.prepareRollbackArtifact(dir, { updateId: 'rb1', oldExePath: oldExe })
  assert.equal(art.ok, true)
  // Simulate partial commit that overwrote old entry with new bytes
  writeFileSync(oldExe, 'BAD_NEW')
  state.writePrepared(dir, {
    updateId: 'rb1',
    exePath: newExe,
    oldExePath: oldExe,
    rollbackArtifactPath: art.artifactPath,
    rollbackSha256: art.sha256,
    sha256: shaOf('BAD_NEW'),
    releaseSequence: 200,
  })
  state.recordHighestCommittedReleaseSequence(99, dir)
  let spawned = null
  const result = await handoff.finalizeRollback({
    userDataPath: dir,
    updateId: 'rb1',
    currentExe: oldExe,
    finalPath: newExe,
    expectedSha256: shaOf('BAD_NEW'),
    releaseSequence: 200,
    reason: 'COMMIT_FAILED',
    spawnImpl: (cmd, args) => {
      spawned = { cmd, args }
      return { pid: 7777, unref() {} }
    },
  })
  assert.equal(result.ok, true)
  assert.equal(state.hashFileSync(oldExe), shaOf('OLD_ONLY'))
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 99)
  assert.equal(state.readHandoffResult(dir).result, 'ROLLED_BACK')
  assert.ok(spawned && String(spawned.cmd).includes('微信群控系统v1.103.exe'))
  const blocked = state.isFailedUpdateBlocked({ releaseSequence: 200, sha256: shaOf('BAD_NEW') }, dir)
  assert.equal(blocked.blocked, true)
  cleanup(dir)
})

test('schedulePortableHandoff refuses when rollback artifact cannot be prepared', () => {
  const dir = makeDir('upd-sched-')
  const work = path.join(dir, 'work')
  mkdirSync(work)
  assert.throws(() => {
    handoff.schedulePortableHandoff({
      currentExe: path.join(dir, 'missing-old.exe'),
      finalPath: path.join(work, 'new.exe'),
      downloadPath: path.join(work, 'dl.exe'),
      expectedSha256: 'aa'.repeat(32),
      userDataPath: dir,
      manifest: { version: '1', buildId: 'b', releaseSequence: 1 },
      electronExe: process.execPath,
    })
  }, /ROLLBACK_ARTIFACT/)
  cleanup(dir)
})

test('inspectStaleApplying prefers rollback when helper dead', () => {
  const dir = makeDir('upd-stale-')
  state.setPhase(dir, state.PHASE.WAITING_NEW_READY, { updateId: 's1' })
  state.writeApplyingLock(dir, {
    updateId: 's1',
    helperPid: 1,
    createdAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    ttlMs: 10 * 60 * 1000,
  })
  const row = state.inspectStaleApplying(dir)
  assert.equal(row.stale, true)
  assert.equal(row.action, 'rollback')
  cleanup(dir)
})

test('helper script routes post-exit failures through Invoke-Rollback', () => {
  const dir = makeDir('upd-ps-')
  const install = path.join(dir, 'inst')
  const work = path.join(dir, 'work')
  mkdirSync(install)
  mkdirSync(work)
  const oldExe = path.join(install, '微信群控系统v1.103.exe')
  const finalPath = path.join(install, '微信群控系统v1.104.exe')
  const downloadPath = path.join(work, 'dl.bin')
  writeFileSync(oldExe, 'OLD')
  writeFileSync(finalPath, 'NEW')
  writeFileSync(downloadPath, 'NEW')
  const sha = shaOf('NEW')
  let scriptPath = ''
  handoff.schedulePortableHandoff({
    currentExe: oldExe,
    finalPath,
    downloadPath,
    expectedSha256: sha,
    userDataPath: dir,
    manifest: { version: '1.104', buildId: 'b', releaseSequence: 104 },
    electronExe: process.execPath,
    readyTimeoutMs: 5000,
    spawnImpl: (_cmd, args) => {
      scriptPath = args[args.indexOf('-File') + 1]
      return { pid: 4242, unref() {} }
    },
  })
  const script = readFileSync(scriptPath, 'utf8')
  assert.match(script, /\$oldExited = \$false/)
  assert.match(script, /\$oldExited = \$true/)
  assert.match(script, /function Invoke-Rollback/)
  assert.match(script, /Invoke-Rollback "FINAL_MISSING"/)
  assert.match(script, /Invoke-Rollback "FINAL_SHA_MISMATCH"/)
  assert.match(script, /Invoke-Rollback "NEW_SPAWN_FAILED"/)
  assert.match(script, /Invoke-Rollback "NEW_PID_INVALID"/)
  assert.match(script, /Invoke-Rollback "NEW_PROCESS_EXITED_BEFORE_READY"/)
  assert.match(script, /Invoke-Rollback "NEW_READY_TIMEOUT"/)
  assert.match(script, /Invoke-Rollback "COMMIT_FAILED"/)
  assert.doesNotMatch(script, /Log "final missing"; exit 1/)
  cleanup(dir)
})
