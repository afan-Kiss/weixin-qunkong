'use strict'

/**
 * Pure TTL sweep for runtime preview/dedup maps (testable without loading main.cjs).
 * @param {{ qrInvitePreviewCache: Map, qrMonitorRecentEvents: Map, QR_MONITOR_EVENT_DEDUP_TTL_MS: number }} maps
 * @param {number} [now]
 */
function cleanupRuntimeTtlMaps(maps, now = Date.now()) {
  const { qrInvitePreviewCache, qrMonitorRecentEvents, QR_MONITOR_EVENT_DEDUP_TTL_MS } = maps
  for (const [key, item] of qrInvitePreviewCache) {
    if (!item || Number(item.expiresAt) <= now) {
      qrInvitePreviewCache.delete(key)
    }
  }
  for (const [key, timestamp] of qrMonitorRecentEvents) {
    if (now - Number(timestamp || 0) >= QR_MONITOR_EVENT_DEDUP_TTL_MS) {
      qrMonitorRecentEvents.delete(key)
    }
  }
}

module.exports = { cleanupRuntimeTtlMaps }
