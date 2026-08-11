'use strict'

const READ_API_WHITELIST = new Set([
  '/api/get_chatroom_list',
  '/api/get_all_room_detail',
  '/api/get_room_members',
  '/api/get_groupmember_bysql',
  '/api/get_profile_cache',
  '/api/get_contact_list2',
  '/api/get_group_member_contact',
  '/api/get_contact',
  '/api/update_single_profile',
  '/api/get_db_handle',
])

const DEFAULT_TTLS = {
  '/api/get_chatroom_list': 1500,
  '/api/get_all_room_detail': 300000,
  '/api/update_single_profile': 0,
  '/api/get_group_member_contact': 0,
}
const DEFAULT_TTL = 2000

const DEFAULT_TIMEOUTS = {
  '/api/get_all_room_detail': 90000,
}
const DEFAULT_TIMEOUT = 30000

// instanceId|apiPath|bodyHash → { promise }
const inflight = new Map()
// instanceId|apiPath|bodyHash → { result, expiresAt }
const cache = new Map()
// instanceId → { realRequests, coalescedHits, cacheHits }
const stats = new Map()

function stableBodyHash(body) {
  if (!body || typeof body !== 'object' || !Object.keys(body).length) return '{}'
  const sorted = {}
  for (const key of Object.keys(body).sort()) sorted[key] = body[key]
  return JSON.stringify(sorted)
}

function makeKey(instanceId, apiPath, body) {
  return `${instanceId}|${apiPath}|${stableBodyHash(body)}`
}

function getStats(instanceId) {
  let s = stats.get(instanceId)
  if (!s) { s = { realRequests: 0, coalescedHits: 0, cacheHits: 0 }; stats.set(instanceId, s) }
  return s
}

async function requestWechatRead(record, apiPath, body, options = {}) {
  const requestApiFn = options.requestApiFn
  if (typeof requestApiFn !== 'function') throw new Error('requestApiFn is required')
  if (!READ_API_WHITELIST.has(apiPath)) throw new Error(`API ${apiPath} is not a read-only API, cannot use read broker`)

  const instanceId = record.id || record.instanceId || ''
  const key = makeKey(instanceId, apiPath, body)
  const force = Boolean(options.force)
  const ttl = typeof options.ttl === 'number' ? options.ttl : (DEFAULT_TTLS[apiPath] ?? DEFAULT_TTL)
  const timeout = typeof options.timeout === 'number' ? options.timeout : (DEFAULT_TIMEOUTS[apiPath] ?? DEFAULT_TIMEOUT)
  const s = getStats(instanceId)

  // Check in-flight first (even for force requests)
  const existing = inflight.get(key)
  if (existing) {
    s.coalescedHits += 1
    return existing.promise
  }

  // Check cache (unless force)
  if (!force) {
    const cached = cache.get(key)
    if (cached && Date.now() < cached.expiresAt) {
      s.cacheHits += 1
      return cached.result
    }
  }

  // Real request
  s.realRequests += 1
  const promise = requestApiFn(record, apiPath, body, timeout)
    .then((result) => {
      inflight.delete(key)
      if (result?.response?.ok) {
        cache.set(key, { result, expiresAt: Date.now() + ttl })
      }
      return result
    })
    .catch((err) => {
      inflight.delete(key)
      throw err
    })

  inflight.set(key, { promise })
  return promise
}

function clearInstanceCache(instanceId) {
  const prefix = `${instanceId}|`
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) inflight.delete(key)
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
  stats.delete(instanceId)
}

function invalidateInstanceApi(instanceId, apiPath) {
  const prefix = `${instanceId}|${apiPath}|`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

function getReadBrokerStats(instanceId) {
  return { ...(stats.get(instanceId) || { realRequests: 0, coalescedHits: 0, cacheHits: 0 }) }
}

function resetAllStats() {
  stats.clear()
}

// Periodic cleanup of expired cache entries
let cleanupTimer = null
function startCleanupTimer() {
  if (cleanupTimer) return
  cleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of cache) {
      if (now >= entry.expiresAt) cache.delete(key)
    }
  }, 60000)
  if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref()
}
startCleanupTimer()

function stopCleanupTimer() {
  if (cleanupTimer) { clearInterval(cleanupTimer); cleanupTimer = null }
}

module.exports = {
  requestWechatRead,
  clearInstanceCache,
  invalidateInstanceApi,
  getReadBrokerStats,
  resetAllStats,
  READ_API_WHITELIST,
  stopCleanupTimer,
}
