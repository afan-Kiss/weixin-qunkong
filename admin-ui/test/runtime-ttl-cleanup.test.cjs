const test = require('node:test')
const assert = require('node:assert/strict')
const { cleanupRuntimeTtlMaps } = require('../electron/runtime-ttl-cleanup.cjs')

const QR_INVITE_PREVIEW_TTL_MS = 90000
const QR_MONITOR_EVENT_DEDUP_TTL_MS = 90000

function makeMaps() {
  return {
    qrInvitePreviewCache: new Map(),
    qrMonitorRecentEvents: new Map(),
    QR_MONITOR_EVENT_DEDUP_TTL_MS,
  }
}

test('qrInvitePreviewCache: expired keys removed after TTL sweep', () => {
  const maps = makeMaps()
  const now = Date.now()
  for (let i = 0; i < 10000; i += 1) {
    maps.qrInvitePreviewCache.set(`inst|url-${i}`, {
      preview: { id: i },
      expiresAt: now - 1000,
    })
  }
  maps.qrInvitePreviewCache.set('inst|fresh', {
    preview: { id: 'fresh' },
    expiresAt: now + QR_INVITE_PREVIEW_TTL_MS,
  })
  cleanupRuntimeTtlMaps(maps, now)
  assert.equal(maps.qrInvitePreviewCache.size, 1)
  assert.ok(maps.qrInvitePreviewCache.has('inst|fresh'))
})

test('qrMonitorRecentEvents: expired keys removed after TTL sweep', () => {
  const maps = makeMaps()
  const now = Date.now()
  for (let i = 0; i < 10000; i += 1) {
    maps.qrMonitorRecentEvents.set(`inst|room|msg-${i}`, now - QR_MONITOR_EVENT_DEDUP_TTL_MS - 1)
  }
  maps.qrMonitorRecentEvents.set('inst|room|fresh', now - 1000)
  cleanupRuntimeTtlMaps(maps, now)
  assert.equal(maps.qrMonitorRecentEvents.size, 1)
  assert.ok(maps.qrMonitorRecentEvents.has('inst|room|fresh'))
})

test('TTL cleanup does not remove still-valid entries from other instances', () => {
  const maps = makeMaps()
  const now = Date.now()
  maps.qrInvitePreviewCache.set('inst-a|u1', { preview: {}, expiresAt: now + 60000 })
  maps.qrInvitePreviewCache.set('inst-b|u2', { preview: {}, expiresAt: now - 1 })
  maps.qrMonitorRecentEvents.set('inst-a|r|m1', now - 1000)
  maps.qrMonitorRecentEvents.set('inst-b|r|m2', now - QR_MONITOR_EVENT_DEDUP_TTL_MS - 5000)
  cleanupRuntimeTtlMaps(maps, now)
  assert.ok(maps.qrInvitePreviewCache.has('inst-a|u1'))
  assert.equal(maps.qrInvitePreviewCache.has('inst-b|u2'), false)
  assert.ok(maps.qrMonitorRecentEvents.has('inst-a|r|m1'))
  assert.equal(maps.qrMonitorRecentEvents.has('inst-b|r|m2'), false)
})

test('main.cjs wires periodic runtime TTL cleanup', () => {
  const fs = require('node:fs')
  const path = require('node:path')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /cleanupRuntimeTtlMaps/)
  assert.match(main, /RUNTIME_CACHE_CLEANUP_INTERVAL_MS = 60000/)
  assert.match(main, /runtime-ttl-cleanup\.cjs/)
  assert.match(main, /Date\.now\(\) >= cached\.expiresAt/)
  assert.match(main, /qrMonitorRecentEvents\.delete\(dedupKey\)/)
})
