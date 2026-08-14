'use strict'

/**
 * Machine-wide Device Channel ownership lock.
 * Prevents two Windows user sessions from opening duplicate WSS for the same machine clientId.
 *
 * Preferred (win32): Global named pipe listen (machine-wide).
 * Fallback: exclusive file under ProgramData with stale-PID reclaim.
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const net = require('net')
const { createHash } = require('crypto')

/** @type {{ createMutex?: Function, releaseMutex?: Function, platform?: string, programData?: string, netCreateServer?: Function }} */
let deps = {}

function setMachineChannelLockDepsForTest(overrides = {}) {
  deps = { ...deps, ...overrides }
}

function resetMachineChannelLockDepsForTest() {
  deps = {}
}

function mutexNameForClientId(clientId) {
  const id = String(clientId || '').trim()
  const digest = createHash('sha256').update(id || 'unknown').digest('hex').slice(0, 24)
  return `Global\\WXQK-DeviceChannel-${digest}`
}

function pipeNameForClientId(clientId) {
  const digest = createHash('sha256').update(String(clientId || 'unknown')).digest('hex').slice(0, 24)
  return `\\\\.\\pipe\\WXQK-DeviceChannel-${digest}`
}

function fileLockPath(clientId) {
  const root = deps.programData
    || process.env.WXQK_MACHINE_DATA_DIR
    || process.env.ProgramData
    || path.join(os.homedir(), 'AppData', 'Local')
  const dir = path.join(root, 'WXQK', 'locks')
  fs.mkdirSync(dir, { recursive: true })
  const digest = createHash('sha256').update(String(clientId || 'unknown')).digest('hex').slice(0, 24)
  return path.join(dir, `device-channel-${digest}.lock`)
}

function isPidAlive(pid) {
  const n = Number(pid) || 0
  if (!n) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error && error.code === 'EPERM'
  }
}

function tryAcquireNamedPipe(clientId) {
  const createServer = deps.netCreateServer || net.createServer
  const pipe = pipeNameForClientId(clientId)
  return new Promise((resolve) => {
    const server = createServer(() => { /* ignore clients */ })
    const done = (result) => {
      try { server.removeAllListeners('error') } catch { /* ignore */ }
      resolve(result)
    }
    server.once('error', (error) => {
      if (error && (error.code === 'EADDRINUSE' || error.code === 'EACCES')) {
        done({ ok: false, code: 'OWNER_OTHER_SESSION', message: '设备后台通道由本机另一用户会话维护' })
        return
      }
      done({ ok: false, code: 'LOCK_ERROR', message: String(error?.message || error) })
    })
    try {
      server.listen(pipe, () => {
        done({ ok: true, code: 'OWNED', handle: { __pipeServer: server, pipe } })
      })
    } catch (error) {
      done({ ok: false, code: 'LOCK_ERROR', message: String(error?.message || error) })
    }
  })
}

function tryAcquireFileLock(clientId) {
  const lockFile = fileLockPath(clientId)
  const tryOpen = () => {
    const fd = fs.openSync(lockFile, 'wx')
    fs.writeFileSync(fd, JSON.stringify({
      pid: process.pid,
      clientId: String(clientId || ''),
      at: new Date().toISOString(),
    }))
    return { ok: true, code: 'OWNED', handle: { fd, lockFile } }
  }
  try {
    return tryOpen()
  } catch (error) {
    if (error && (error.code === 'EEXIST' || error.code === 'EACCES')) {
      try {
        const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8') || '{}')
        const ownerPid = Number(raw?.pid) || 0
        if (ownerPid && !isPidAlive(ownerPid)) {
          try { fs.unlinkSync(lockFile) } catch { /* ignore */ }
          try {
            return tryOpen()
          } catch (retryErr) {
            if (retryErr && (retryErr.code === 'EEXIST' || retryErr.code === 'EACCES')) {
              return { ok: false, code: 'OWNER_OTHER_SESSION', message: '设备后台通道由本机另一用户会话维护' }
            }
            return { ok: false, code: 'LOCK_ERROR', message: String(retryErr?.message || retryErr) }
          }
        }
      } catch { /* ignore parse */ }
      return { ok: false, code: 'OWNER_OTHER_SESSION', message: '设备后台通道由本机另一用户会话维护' }
    }
    return { ok: false, code: 'LOCK_ERROR', message: String(error?.message || error) }
  }
}

/**
 * Try to acquire exclusive machine channel ownership.
 * @returns {Promise<{ ok: boolean, code: string, handle?: any, message?: string }> | { ok: boolean, code: string, handle?: any, message?: string }}
 */
function tryAcquireMachineChannelLock(clientId) {
  const platform = deps.platform || process.platform
  const name = mutexNameForClientId(clientId)
  if (typeof deps.createMutex === 'function') {
    try {
      const handle = deps.createMutex(name)
      if (!handle) {
        return { ok: false, code: 'OWNER_OTHER_SESSION', message: '设备后台通道由本机另一用户会话维护' }
      }
      return { ok: true, code: 'OWNED', handle: { __mutex: true, raw: handle } }
    } catch (error) {
      return { ok: false, code: 'LOCK_ERROR', message: String(error?.message || error) }
    }
  }
  if (platform === 'win32') {
    return tryAcquireNamedPipe(clientId).then((pipeResult) => {
      if (pipeResult.ok) return pipeResult
      // Fall through to file lock if pipe unavailable (rare); still machine-scoped via ProgramData.
      return tryAcquireFileLock(clientId)
    })
  }
  return tryAcquireFileLock(clientId)
}

function releaseMachineChannelLock(handle) {
  if (!handle) return
  if (handle.__pipeServer) {
    try { handle.__pipeServer.close() } catch { /* ignore */ }
    return
  }
  if (typeof deps.releaseMutex === 'function' && handle && handle.__mutex) {
    try { deps.releaseMutex(handle.raw || handle) } catch { /* ignore */ }
    return
  }
  if (handle.fd != null) {
    try { fs.closeSync(handle.fd) } catch { /* ignore */ }
  }
  if (handle.lockFile) {
    try { fs.unlinkSync(handle.lockFile) } catch { /* ignore */ }
  }
}

module.exports = {
  mutexNameForClientId,
  pipeNameForClientId,
  tryAcquireMachineChannelLock,
  releaseMachineChannelLock,
  setMachineChannelLockDepsForTest,
  resetMachineChannelLockDepsForTest,
}
