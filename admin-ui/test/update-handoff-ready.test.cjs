'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')

const state = require('../electron/update-state.cjs')
const handoff = require('../electron/update-handoff.cjs')
const drain = require('../electron/update-drain.cjs')

test('prepared marker is not ready', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'upd-prep-'))
  const prepared = state.writePrepared(dir, {
    updateId: 'abc',
    exePath: path.join(dir, 'new.exe'),
    oldExePath: path.join(dir, 'old.exe'),
    sha256: 'aa'.repeat(32),
    releaseSequence: 9,
    version: '1.103',
    buildId: 'b',
  })
  assert.equal(prepared.status, 'prepared')
  assert.equal(state.readReady(dir), null)
  assert.notEqual(state.getPhase(dir).phase, state.PHASE.COMMITTED)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('ready requires matching updateId/exe/sha and live pid', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'upd-ready-'))
  const exe = path.join(dir, 'new.exe')
  writeFileSync(exe, 'bytes')
  const sha = createHash('sha256').update('bytes').digest('hex')
  state.writePrepared(dir, {
    updateId: 'uid-1',
    exePath: exe,
    oldExePath: path.join(dir, 'old.exe'),
    sha256: sha,
    releaseSequence: 3,
  })
  const ready = state.writeReadyAck(dir, {
    updateId: 'uid-1',
    exePath: exe,
    sha256: sha,
    releaseSequence: 3,
  })
  const ok = state.validateReadyAck(state.readPrepared(dir), ready)
  assert.equal(ok.ok, true)
  const bad = state.validateReadyAck(state.readPrepared(dir), { ...ready, updateId: 'other' })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'updateId_mismatch')
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('highest sequence recorded only after commit', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'upd-commit-seq-'))
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 0)
  state.recordHighestCommittedReleaseSequence(5, dir)
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 5)
  // failed update does not raise committed
  state.writeFailedUpdate(dir, { releaseSequence: 9, sha256: 'bb'.repeat(32), reason: 'NEW_READY_TIMEOUT' })
  assert.equal(state.loadHighestCommittedReleaseSequence(dir), 5)
  const blocked = state.isFailedUpdateBlocked({ releaseSequence: 9, sha256: 'bb'.repeat(32) }, dir)
  assert.equal(blocked.blocked, true)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('task admission denied during drain', async () => {
  drain.endUpdateDrain()
  assert.equal(drain.canAcceptNewWork().ok, true)
  drain.beginUpdateDrain({})
  assert.equal(drain.canAcceptNewWork().ok, false)
  assert.equal(drain.canAcceptNewWork().code, 'UPDATE_DRAINING')
  const result = await drain.waitForUpdateDrain({
    timeoutMs: 200,
    isMandatory: true,
    isRemote: false,
    hooks: {
      getRunningTasks: () => [{ id: 't1', status: 'RUNNING', name: 'busy' }],
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.needsConfirm, true)
  assert.equal(result.state, drain.DRAIN_STATE.TIMEOUT_NEEDS_CONFIRM)
  drain.endUpdateDrain()
})

test('remote mandatory timeout stays pending', async () => {
  drain.endUpdateDrain()
  const result = await drain.waitForUpdateDrain({
    timeoutMs: 150,
    isMandatory: true,
    isRemote: true,
    hooks: { getRunningTasks: () => [{ id: 't1', status: 'RUNNING', name: 'busy' }] },
  })
  assert.equal(result.ok, false)
  assert.equal(result.pending, true)
  drain.endUpdateDrain()
})

test('emitNewVersionReadyAck refuses without --after-update', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'upd-ack-'))
  const exe = path.join(dir, 'n.exe')
  writeFileSync(exe, 'x')
  const sha = createHash('sha256').update('x').digest('hex')
  state.writePrepared(dir, { updateId: 'u', exePath: exe, oldExePath: exe, sha256: sha, releaseSequence: 1 })
  const denied = handoff.emitNewVersionReadyAck({
    userDataPath: dir,
    argv: ['node', 'app'],
    exePath: exe,
  })
  assert.equal(denied.ok, false)
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

test('parseUpdateCliArgs reads update id flags', () => {
  const a = handoff.parseUpdateCliArgs(['--after-update', '--update-id=abc'])
  assert.equal(a.afterUpdate, true)
  assert.equal(a.updateId, 'abc')
  const b = handoff.parseUpdateCliArgs(['--update-rollback', '--update-id', 'xyz'])
  assert.equal(b.updateRollback, true)
  assert.equal(b.updateId, 'xyz')
})
