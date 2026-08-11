'use strict'

/**
 * Pure TTL sweep for runtime preview/dedup maps (testable without loading main.cjs).
 * @param {object} maps
 * @param {number} [now]
 */
function cleanupRuntimeTtlMaps(maps, now = Date.now()) {
  const {
    qrInvitePreviewCache,
    qrMonitorRecentEvents,
    QR_MONITOR_EVENT_DEDUP_TTL_MS,
    qrValidityCache,
    qrMonitorSkipLogAt,
    QR_MONITOR_SKIP_LOG_TTL_MS = 600000,
    deliveryImageHashCache,
    DELIVERY_IMAGE_HASH_TTL_MS = 600000,
    DELIVERY_IMAGE_HASH_MAX = 512,
  } = maps

  if (qrInvitePreviewCache) {
    for (const [key, item] of qrInvitePreviewCache) {
      if (!item || Number(item.expiresAt) <= now) {
        qrInvitePreviewCache.delete(key)
      }
    }
  }

  if (qrMonitorRecentEvents) {
    for (const [key, timestamp] of qrMonitorRecentEvents) {
      if (now - Number(timestamp || 0) >= QR_MONITOR_EVENT_DEDUP_TTL_MS) {
        qrMonitorRecentEvents.delete(key)
      }
    }
  }

  if (qrValidityCache) {
    for (const [key, item] of qrValidityCache) {
      if (!item || Number(item.expiresAt) <= now) {
        qrValidityCache.delete(key)
      }
    }
  }

  if (qrMonitorSkipLogAt) {
    for (const [key, timestamp] of qrMonitorSkipLogAt) {
      if (now - Number(timestamp || 0) >= QR_MONITOR_SKIP_LOG_TTL_MS) {
        qrMonitorSkipLogAt.delete(key)
      }
    }
  }

  if (deliveryImageHashCache) {
    for (const [key, entry] of deliveryImageHashCache) {
      if (!entry || now - Number(entry.usedAt || 0) > DELIVERY_IMAGE_HASH_TTL_MS) {
        deliveryImageHashCache.delete(key)
      }
    }
    while (deliveryImageHashCache.size > DELIVERY_IMAGE_HASH_MAX) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, entry] of deliveryImageHashCache) {
        const usedAt = Number(entry?.usedAt || 0)
        if (usedAt < oldestAt) { oldestAt = usedAt; oldestKey = key }
      }
      if (!oldestKey) break
      deliveryImageHashCache.delete(oldestKey)
    }
  }
}

module.exports = { cleanupRuntimeTtlMaps }
