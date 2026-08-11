'use strict'

const { resolveTaskItemInstance } = require('./task-instance-resolve.cjs')

const TASK_INSTANCE_WAIT_TIMEOUT_MS = 120000
const TASK_INSTANCE_WAIT_INTERVAL_MS = 1500

/**
 * 等待同 accountWxid 的执行微信 ONLINE；可注入 clock/sleep 便于测试。
 * @param {object} item
 * @param {{
 *   getInstances: () => Map<string, object>,
 *   isStopRequested?: () => boolean,
 *   getTaskStatus?: () => string,
 *   isRuntimeAllowed?: () => boolean,
 *   resolve?: typeof resolveTaskItemInstance,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   onWaiting?: (resolved: object) => void,
 * }} options
 */
async function waitForTaskInstance(item, options = {}) {
  const resolve = typeof options.resolve === 'function' ? options.resolve : resolveTaskItemInstance
  const getInstances = typeof options.getInstances === 'function' ? options.getInstances : () => new Map()
  const isStopRequested = typeof options.isStopRequested === 'function' ? options.isStopRequested : () => false
  const getTaskStatus = typeof options.getTaskStatus === 'function' ? options.getTaskStatus : () => ''
  const isRuntimeAllowed = typeof options.isRuntimeAllowed === 'function' ? options.isRuntimeAllowed : () => true
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || TASK_INSTANCE_WAIT_TIMEOUT_MS)
  const intervalMs = Math.max(100, Number(options.intervalMs) || TASK_INSTANCE_WAIT_INTERVAL_MS)
  const accountWxid = String(item?.account_wxid || item?.accountWxid || '').trim()
  const startedAt = now()

  while (true) {
    if (!isRuntimeAllowed()) return { ok: false, stopped: true, reason: 'RUNTIME_DENIED', code: 'STOPPED' }
    const status = String(getTaskStatus() || '')
    if (status === 'PAUSED') return { ok: false, stopped: true, reason: 'PAUSED', code: 'STOPPED' }
    if (status === 'CANCELLED') return { ok: false, stopped: true, reason: 'CANCELLED', code: 'STOPPED' }
    if (isStopRequested()) return { ok: false, stopped: true, reason: 'STOPPED', code: 'STOPPED' }

    const resolved = resolve(item, getInstances())
    if (resolved.ok) return { ...resolved, stopped: false }

    if (resolved.code === 'AMBIGUOUS_INSTANCE' || resolved.code === 'ACCOUNT_MISMATCH') {
      return { ...resolved, stopped: false }
    }
    if (resolved.code === 'MISSING' || !accountWxid) {
      return { ...resolved, stopped: false }
    }
    // 仅 WAITING_INSTANCE（及带 account 的短暂 OFFLINE 语义）进入等待
    if (resolved.code !== 'WAITING_INSTANCE' && resolved.code !== 'OFFLINE') {
      return { ...resolved, stopped: false }
    }

    if (now() - startedAt >= timeoutMs) {
      return {
        ok: false,
        stopped: false,
        timedOut: true,
        code: 'WAITING_INSTANCE',
        reason: `执行微信未上线，等待 ${Math.round(timeoutMs / 1000)} 秒后仍未恢复`,
      }
    }
    if (typeof options.onWaiting === 'function') {
      try { options.onWaiting(resolved) } catch { /* ignore */ }
    }
    await sleep(intervalMs)
  }
}

module.exports = {
  waitForTaskInstance,
  TASK_INSTANCE_WAIT_TIMEOUT_MS,
  TASK_INSTANCE_WAIT_INTERVAL_MS,
}
