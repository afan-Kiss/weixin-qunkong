'use strict'

/**
 * IPC 超时上限：按 API path 白名单，禁止任意超长 timeout。
 * @param {string} apiPath
 * @param {unknown} timeoutMs
 * @returns {number}
 */
function resolveIpcApiTimeout(apiPath, timeoutMs) {
  const path = String(apiPath || '')
  const requested = Number(timeoutMs)
  const raw = Number.isFinite(requested) && requested > 0 ? requested : 30000
  const clampedMin = Math.max(raw, 500)
  const CAPS = {
    '/api/get_all_room_detail': 90000,
  }
  const hardCap = CAPS[path] || 30000
  const absoluteMax = 120000
  return Math.min(clampedMin, hardCap, absoluteMax)
}

module.exports = { resolveIpcApiTimeout }
