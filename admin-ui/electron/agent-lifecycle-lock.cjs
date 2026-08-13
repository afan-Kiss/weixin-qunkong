'use strict'

/**
 * Machine-level exclusive lock for WXQK Agent install/repair/upgrade/msh writes.
 * Uses %PROGRAMDATA%\WXQK\locks\agent-lifecycle.lock (cross-user on same PC).
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const LOCK_NAME = 'agent-lifecycle.lock'

function resolveLockPath() {
  if (process.env.WXQK_AGENT_LOCK_DIR && String(process.env.WXQK_AGENT_LOCK_DIR).trim()) {
    return path.join(path.resolve(String(process.env.WXQK_AGENT_LOCK_DIR).trim()), LOCK_NAME)
  }
  const pd = process.env.ProgramData
    || (process.env.SystemDrive ? path.join(process.env.SystemDrive, 'ProgramData') : '')
    || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(pd, 'WXQK', 'locks', LOCK_NAME)
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * @param {() => Promise<any> | any} fn
 * @param {{ timeoutMs?: number, lockPath?: string, fs?: typeof fs }} [opts]
 */
async function withAgentLifecycleLock(fn, opts = {}) {
  const api = opts.fs || fs
  const lockPath = opts.lockPath || resolveLockPath()
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 120000)
  const started = Date.now()
  api.mkdirSync(path.dirname(lockPath), { recursive: true })

  while (Date.now() - started < timeoutMs) {
    let fd = null
    try {
      fd = api.openSync(lockPath, 'wx')
      api.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        at: new Date().toISOString(),
      }))
      try {
        return await fn()
      } finally {
        try { api.closeSync(fd) } catch { /* ignore */ }
        try { api.unlinkSync(lockPath) } catch { /* ignore */ }
      }
    } catch (err) {
      if (!(err && (err.code === 'EEXIST' || /EEXIST/i.test(String(err.message || ''))))) {
        throw err
      }
      try {
        const raw = api.readFileSync(lockPath, 'utf8')
        const row = JSON.parse(raw)
        if (!pidAlive(Number(row?.pid || 0))) {
          try { api.unlinkSync(lockPath) } catch { /* ignore */ }
          continue
        }
      } catch {
        try { api.unlinkSync(lockPath) } catch { /* ignore */ }
        continue
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  const err = new Error('WXQK agent lifecycle lock timeout')
  err.code = 'MESH_LIFECYCLE_LOCK_TIMEOUT'
  throw err
}

module.exports = {
  LOCK_NAME,
  resolveLockPath,
  withAgentLifecycleLock,
  pidAlive,
}
