'use strict'

/**
 * 从 runtime Map 风格结构中清旧 STOPPED（不碰 SQLite）。
 * @param {Map<string, { id: string, status: string, stoppedAt?: number, accountWxid?: string }>} instanceMap
 * @param {{ now?: number, maxStopped?: number, ttlMs?: number }} [options]
 */
function pruneStoppedRuntimeInstances(instanceMap, options = {}) {
  const now = Number(options.now) || Date.now()
  const maxStopped = Number(options.maxStopped) > 0 ? Number(options.maxStopped) : 20
  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : 24 * 60 * 60 * 1000
  const stopped = [...instanceMap.values()]
    .filter((item) => item.status === 'STOPPED')
    .sort((a, b) => Number(a.stoppedAt || 0) - Number(b.stoppedAt || 0))
  for (const record of stopped) {
    const age = now - Number(record.stoppedAt || now)
    if (age >= ttlMs) instanceMap.delete(record.id)
  }
  const remaining = [...instanceMap.values()]
    .filter((item) => item.status === 'STOPPED')
    .sort((a, b) => Number(a.stoppedAt || 0) - Number(b.stoppedAt || 0))
  while (remaining.length > maxStopped) {
    const oldest = remaining.shift()
    if (!oldest) break
    instanceMap.delete(oldest.id)
  }
}

/**
 * 同账号 ONLINE 后清同账号 STOPPED runtime。
 */
function pruneStoppedRuntimeForAccount(instanceMap, record) {
  const accountWxid = String(record?.accountWxid || '').trim()
  if (!accountWxid) return
  for (const item of [...instanceMap.values()]) {
    if (item.id === record.id) continue
    if (item.status !== 'STOPPED') continue
    if (String(item.accountWxid || '') !== accountWxid) continue
    instanceMap.delete(item.id)
  }
}

module.exports = {
  pruneStoppedRuntimeInstances,
  pruneStoppedRuntimeForAccount,
}
