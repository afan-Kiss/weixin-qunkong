'use strict'

/**
 * Soft drain gate + task admission control before applying updates.
 */

const DRAIN_STATE = Object.freeze({
  IDLE: 'IDLE',
  DRAINING: 'DRAINING',
  READY: 'READY',
  TIMEOUT_PENDING: 'TIMEOUT_PENDING',
  TIMEOUT_NEEDS_CONFIRM: 'TIMEOUT_NEEDS_CONFIRM',
  TIMEOUT_WARN: 'TIMEOUT_WARN', // legacy alias → needs confirm for local mandatory
})

let updateDrainActive = false
/** @type {import('./update-drain.cjs').DrainHooks} */
let activeHooks = {}

/**
 * @typedef {{
 *   getRunningTasks?: () => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>,
 *   getCriticalLabels?: () => string[] | Promise<string[]>,
 *   flushDatabase?: () => void | Promise<void>,
 * }} DrainHooks
 */

function setUpdateDrainActive(value) {
  updateDrainActive = Boolean(value)
}

function isUpdateDrainActive() {
  return updateDrainActive
}

/**
 * Close admission BEFORE waiting for existing work.
 */
function beginUpdateDrain(hooks = {}) {
  updateDrainActive = true
  activeHooks = hooks && typeof hooks === 'object' ? hooks : {}
  return { active: true }
}

function endUpdateDrain() {
  updateDrainActive = false
  activeHooks = {}
  return { active: false }
}

/**
 * New critical/write work must be rejected while draining.
 * Read-only operations are unaffected by callers skipping this gate.
 */
function canAcceptNewWork() {
  if (updateDrainActive) {
    return { ok: false, code: 'UPDATE_DRAINING', message: '软件正在准备更新，暂时不能启动新任务。' }
  }
  return { ok: true }
}

/**
 * @param {DrainHooks} [hooks]
 */
async function collectActiveCriticalWork(hooks = {}) {
  /** @type {Array<{ kind: string, id?: string, label: string }>} */
  const items = []
  const use = Object.keys(hooks || {}).length ? hooks : activeHooks
  try {
    const tasks = typeof use.getRunningTasks === 'function' ? await use.getRunningTasks() : []
    for (const task of Array.isArray(tasks) ? tasks : []) {
      const status = String(task?.status || '')
      if (!['RUNNING', 'QUEUED', 'COOLING_DOWN', 'WAITING_CONFIRMATION', 'PAUSED'].includes(status)) continue
      items.push({
        kind: 'task',
        id: String(task?.id || ''),
        label: String(task?.name || task?.id || status),
      })
    }
  } catch { /* ignore */ }
  try {
    const labels = typeof use.getCriticalLabels === 'function' ? await use.getCriticalLabels() : []
    for (const label of Array.isArray(labels) ? labels : []) {
      const text = String(label || '').trim()
      if (text) items.push({ kind: 'critical', label: text })
    }
  } catch { /* ignore */ }
  return { busy: items.length > 0, items }
}

async function flushDatabaseBestEffort(hooks = {}) {
  const use = Object.keys(hooks || {}).length ? hooks : activeHooks
  if (typeof use.flushDatabase !== 'function') return { ok: false, skipped: true }
  try {
    await use.flushDatabase()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
  }
}

/**
 * Wait until critical work clears or timeout.
 * Local mandatory timeout → TIMEOUT_NEEDS_CONFIRM (ok=false) — never auto-kill tasks.
 * Remote mandatory timeout → TIMEOUT_PENDING.
 * Security emergency may proceed after flush.
 *
 * @param {{
 *   timeoutMs?: number,
 *   isEmergency?: boolean,
 *   isRemote?: boolean,
 *   isMandatory?: boolean,
 *   forceAfterConfirm?: boolean,
 *   pollMs?: number,
 *   hooks?: DrainHooks,
 *   onState?: (state: string, detail?: object) => void,
 * }} [options]
 */
async function waitForUpdateDrain(options = {}) {
  const isEmergency = Boolean(options.isEmergency)
  const forceAfterConfirm = Boolean(options.forceAfterConfirm)
  const timeoutMs = Math.max(
    0,
    Number(options.timeoutMs != null
      ? options.timeoutMs
      : (isEmergency ? 5_000 : 60_000)) || 0,
  )
  const pollMs = Math.max(200, Number(options.pollMs || 500) || 500)
  const hooks = options.hooks || activeHooks || {}
  beginUpdateDrain(hooks)
  const started = Date.now()
  options.onState?.(DRAIN_STATE.DRAINING, { timeoutMs, updateDrainActive: true })

  try {
    while (true) {
      const snap = await collectActiveCriticalWork(hooks)
      if (!snap.busy) {
        await flushDatabaseBestEffort(hooks)
        options.onState?.(DRAIN_STATE.READY, { items: [] })
        return { ok: true, state: DRAIN_STATE.READY, items: [], waitedMs: Date.now() - started }
      }
      const waited = Date.now() - started
      if (waited >= timeoutMs) {
        if (options.isRemote && !isEmergency) {
          const state = DRAIN_STATE.TIMEOUT_PENDING
          options.onState?.(state, { items: snap.items, waitedMs: waited })
          return { ok: false, state, items: snap.items, waitedMs: waited, pending: true }
        }
        if (isEmergency || forceAfterConfirm) {
          await flushDatabaseBestEffort(hooks)
          options.onState?.(DRAIN_STATE.TIMEOUT_WARN, { items: snap.items, forced: true })
          return {
            ok: true,
            state: DRAIN_STATE.TIMEOUT_WARN,
            items: snap.items,
            waitedMs: waited,
            forced: true,
          }
        }
        // Local mandatory / optional: require explicit user force — do NOT auto-continue
        const state = DRAIN_STATE.TIMEOUT_NEEDS_CONFIRM
        options.onState?.(state, { items: snap.items, waitedMs: waited })
        return {
          ok: false,
          state,
          items: snap.items,
          waitedMs: waited,
          needsConfirm: true,
          code: 'DRAIN_NEEDS_CONFIRM',
        }
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  } catch (err) {
    endUpdateDrain()
    throw err
  }
}

module.exports = {
  DRAIN_STATE,
  setUpdateDrainActive,
  isUpdateDrainActive,
  beginUpdateDrain,
  endUpdateDrain,
  canAcceptNewWork,
  collectActiveCriticalWork,
  flushDatabaseBestEffort,
  waitForUpdateDrain,
}
