'use strict'

/**
 * 主窗口激活策略（可单测，不依赖 Electron）。
 * 后台事件不得抢前台；仅用户明确操作 / 首次 ready-to-show 可 focus。
 */

const SECOND_INSTANCE_FOCUS_COOLDOWN_MS = 1500

/**
 * @param {number} [cooldownMs]
 */
function createSecondInstanceGate(cooldownMs = SECOND_INSTANCE_FOCUS_COOLDOWN_MS) {
  let lastAcceptedAt = 0
  return {
    /**
     * @param {number} [now]
     * @returns {boolean} true = 应执行一次用户激活
     */
    tryAccept(now = Date.now()) {
      const t = Number(now) || Date.now()
      // lastAcceptedAt===0 表示从未接受过：首击必须放行（测试可用小时间戳）
      if (lastAcceptedAt > 0 && t - lastAcceptedAt < cooldownMs) return false
      lastAcceptedAt = t
      return true
    },
    /** @returns {number} */
    lastAcceptedAt() {
      return lastAcceptedAt
    },
    reset() {
      lastAcceptedAt = 0
    },
  }
}

/**
 * 是否应对 second-instance 做窗口激活（应用已 ready 且通过节流）。
 * 冷启动未 ready / 尚未首次 ready-to-show：由首次 show/focus 负责，不排队二次抢焦点。
 * @param {{
 *   appReady: boolean,
 *   gate: { tryAccept: (now?: number) => boolean },
 *   now?: number,
 *   firstShowDone?: boolean,
 * }} opts
 */
function shouldActivateOnSecondInstance(opts) {
  if (!opts || !opts.appReady) return false
  // 显式 false 时拦截；未传则不挡（单测兼容）
  if (opts.firstShowDone === false) return false
  if (!opts.gate || typeof opts.gate.tryAccept !== 'function') return false
  return opts.gate.tryAccept(opts.now)
}

module.exports = {
  SECOND_INSTANCE_FOCUS_COOLDOWN_MS,
  createSecondInstanceGate,
  shouldActivateOnSecondInstance,
}
