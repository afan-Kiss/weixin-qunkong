'use strict'

/**
 * 实时 QR 内容哈希预约缓存（可单测，不依赖 main.cjs）。
 */

const RECENT_QR_HASH_TTL_MS = 10 * 60 * 1000
const RECENT_QR_HASH_MAX = 10000

/**
 * @param {Map<string, number>} map
 * @param {string} hash
 * @param {{ now?: number, ttlMs?: number, max?: number, hasPersistent?: (h: string) => boolean }} [options]
 * @returns {boolean} true = 已存在（duplicate）
 */
function reserveRecentQrContentHash(map, hash, options = {}) {
  const key = String(hash || '').toUpperCase()
  if (!key) return true
  const now = Number(options.now) || Date.now()
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : RECENT_QR_HASH_TTL_MS
  const max = Number(options.max) > 0 ? Number(options.max) : RECENT_QR_HASH_MAX
  const expiresAt = map.get(key)
  if (expiresAt && expiresAt > now) return true
  if (typeof options.hasPersistent === 'function' && options.hasPersistent(key)) {
    map.set(key, now + ttlMs)
    return true
  }
  map.set(key, now + ttlMs)
  while (map.size > max) {
    let oldestKey = null
    let oldestAt = Infinity
    for (const [k, exp] of map) {
      if (Number(exp) < oldestAt) { oldestAt = Number(exp); oldestKey = k }
    }
    if (!oldestKey) break
    map.delete(oldestKey)
  }
  return false
}

function releaseRecentQrContentHash(map, hash) {
  const key = String(hash || '').toUpperCase()
  if (key) map.delete(key)
}

module.exports = {
  RECENT_QR_HASH_TTL_MS,
  RECENT_QR_HASH_MAX,
  reserveRecentQrContentHash,
  releaseRecentQrContentHash,
}
