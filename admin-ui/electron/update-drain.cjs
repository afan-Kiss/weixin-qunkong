/**
 * Soft drain gate before applying an update / exiting the old process.
 */

const DRAIN_STATE = Object.freeze({
  IDLE: 'IDLE',
  DRAINING: 'DRAINING',
  READY: 'READY',
  TIMEOUT_PENDING: 'TIMEOUT_PENDING',
  TIMEOUT_WARN: 'TIMEOUT_WARN',
})

/**
 * @typedef {{
 *   getRunningTasks?: () => Array<Record<string, unknown>> | Promise<Array<Record<string, unknown>>>,
 *   getCriticalLabels?: () => string[] | Promise<string[]>,
 * }} DrainHooks
 */

/**
 * Collect active critical work via injectable getters (tasks, etc.).
 * @param {DrainHooks} [hooks]
 * @returns {Promise<{ busy: boolean, items: Array<{ kind: string, id?: string, label: string }> }>}
 */
async function collectActiveCriticalWork(hooks = {}) {
  /** @type {Array<{ kind: string, id?: string, label: string }>} */
  const items = []
  try {
    const tasks = typeof hooks.getRunningTasks === 'function' ? await hooks.getRunningTasks() : []
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
    const labels = typeof hooks.getCriticalLabels === 'function' ? await hooks.getCriticalLabels() : []
    for (const label of Array.isArray(labels) ? labels : []) {
      const text = String(label || '').trim()
      if (text) items.push({ kind: 'critical', label: text })
    }
  } catch { /* ignore */ }
  return { busy: items.length > 0, items }
}

/**
 * Wait until critical work clears or timeout.
 * Emergency shortens timeout; remote timeout → pending; mandatory timeout → warn.
 * @param {{
 *   timeoutMs?: number,
 *   isEmergency?: boolean,
 *   isRemote?: boolean,
 *   isMandatory?: boolean,
 *   pollMs?: number,
 *   hooks?: DrainHooks,
 *   onState?: (state: string, detail?: object) => void,
 * }} [options]
 * @returns {Promise<{ ok: boolean, state: string, items: Array<{ kind: string, id?: string, label: string }>, waitedMs: number }>}
 */
async function waitForUpdateDrain(options = {}) {
  const isEmergency = Boolean(options.isEmergency)
  const timeoutMs = Math.max(
    0,
    Number(options.timeoutMs != null
      ? options.timeoutMs
      : (isEmergency ? 5_000 : 60_000)) || 0,
  )
  const pollMs = Math.max(200, Number(options.pollMs || 500) || 500)
  const hooks = options.hooks || {}
  const started = Date.now()
  options.onState?.(DRAIN_STATE.DRAINING, { timeoutMs })

  while (true) {
    const snap = await collectActiveCriticalWork(hooks)
    if (!snap.busy) {
      options.onState?.(DRAIN_STATE.READY, { items: [] })
      return { ok: true, state: DRAIN_STATE.READY, items: [], waitedMs: Date.now() - started }
    }
    const waited = Date.now() - started
    if (waited >= timeoutMs) {
      const state = options.isRemote
        ? DRAIN_STATE.TIMEOUT_PENDING
        : DRAIN_STATE.TIMEOUT_WARN
      options.onState?.(state, { items: snap.items, waitedMs: waited })
      // Emergency still proceeds; remote pending blocks; mandatory warns but may proceed for security
      if (options.isRemote && !isEmergency) {
        return { ok: false, state, items: snap.items, waitedMs: waited }
      }
      return {
        ok: isEmergency || Boolean(options.isMandatory),
        state,
        items: snap.items,
        waitedMs: waited,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

module.exports = {
  DRAIN_STATE,
  collectActiveCriticalWork,
  waitForUpdateDrain,
}
