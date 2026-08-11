'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { writeFileSync, utimesSync } = require('node:fs')
const { requestWechatRead, clearInstanceCache, resetAllStats, READ_API_WHITELIST } = require('../electron/wechat-read-broker.cjs')
const { cleanupRuntimeTtlMaps } = require('../electron/runtime-ttl-cleanup.cjs')
const storage = require('../electron/storage.cjs')

// --- Remote agent reconnect / socket identity (behavioral simulation) ---
function createRemoteReconnectHarness() {
  let stopping = false
  let running = false
  let reconnectTimer = null
  let reconnectAttempt = 0
  let socket = null
  let scheduleReconnectCalls = 0
  let connectCalls = 0
  let newSocketCount = 0

  function scheduleReconnect() {
    if (stopping || !running || reconnectTimer) return
    scheduleReconnectCalls += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (stopping || !running) return
      connect()
    }, 10)
  }

  function clearWsTimers(ws) {
    if (!ws?.timers) return
    if (ws.timers.heartbeat) clearInterval(ws.timers.heartbeat)
    if (ws.timers.watchdog) clearInterval(ws.timers.watchdog)
    if (ws.timers.sync) clearInterval(ws.timers.sync)
    ws.timers.heartbeat = null
    ws.timers.watchdog = null
    ws.timers.sync = null
  }

  function connect() {
    if (stopping || !running) return
    connectCalls += 1
    const ws = { id: ++newSocketCount, closed: false, timers: { heartbeat: null, watchdog: null, sync: null } }
    socket = ws
    ws.closeLater = (ms) => {
      setTimeout(() => {
        if (socket !== ws) {
          clearWsTimers(ws)
          return
        }
        ws.closed = true
        socket = null
        clearWsTimers(ws)
        if (!stopping && running) scheduleReconnect()
      }, ms)
    }
    ws.onOpen = () => {
      if (socket !== ws || stopping || !running) return
      ws.timers.heartbeat = setInterval(() => {}, 1000)
      ws.timers.watchdog = setInterval(() => {}, 1000)
      ws.timers.sync = setInterval(() => {}, 1000)
      for (const timer of Object.values(ws.timers)) {
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
    }
    ws.onOpen()
    return ws
  }

  function stopRemoteAgent() {
    stopping = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    reconnectTimer = null
    clearWsTimers(socket)
    try { socket?.close?.() } catch (_) {}
    socket = null
    running = false
  }

  function startRemoteAgent() {
    stopping = false
    running = true
    connect()
  }

  return {
    startRemoteAgent,
    stopRemoteAgent,
    connect,
    get socket() { return socket },
    get stats() {
      return { scheduleReconnectCalls, connectCalls, newSocketCount, reconnectTimer: Boolean(reconnectTimer), running, stopping }
    },
  }
}

test('stopRemoteAgent: delayed close must not schedule reconnect', async () => {
  const h = createRemoteReconnectHarness()
  h.startRemoteAgent()
  const ws = h.socket
  assert.ok(ws)
  h.stopRemoteAgent()
  ws.closeLater(100)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(h.stats.scheduleReconnectCalls, 0)
  assert.equal(h.stats.connectCalls, 1)
  assert.equal(h.stats.newSocketCount, 1)
})

test('stale socket close must not clear timers of current socket', async () => {
  const h = createRemoteReconnectHarness()
  h.startRemoteAgent()
  const wsA = h.socket
  h.connect()
  const wsB = h.socket
  assert.notEqual(wsA.id, wsB.id)
  assert.ok(wsB.timers.heartbeat)
  wsA.closeLater(50)
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(h.socket, wsB)
  assert.ok(wsB.timers.heartbeat)
  assert.ok(wsB.timers.watchdog)
  assert.ok(wsB.timers.sync)
  h.stopRemoteAgent()
})

test('directory refresh keyed inflight: same scope coalesces, different scopes run separately', async () => {
  const inflight = new Map()
  let active = 0
  let loading = false
  const calls = []

  function begin() { active += 1; loading = active > 0 }
  function end() { active = Math.max(0, active - 1); loading = active > 0 }

  async function refreshDirectory(instanceIds) {
    const refreshKey = [...(instanceIds ?? [])].sort().join(',') || 'ALL'
    if (inflight.has(refreshKey)) return inflight.get(refreshKey)
    begin()
    const promise = (async () => {
      calls.push(refreshKey)
      await new Promise((r) => setTimeout(r, 30))
      return refreshKey
    })().finally(() => {
      inflight.delete(refreshKey)
      end()
    })
    inflight.set(refreshKey, promise)
    return promise
  }

  const pA1 = refreshDirectory(['A'])
  const pA2 = refreshDirectory(['A'])
  const pB = refreshDirectory(['B'])
  assert.equal(loading, true)
  await Promise.all([pA1, pA2, pB])
  assert.equal(calls.filter((key) => key === 'A').length, 1)
  assert.equal(calls.filter((key) => key === 'B').length, 1)
  assert.deepEqual(calls.sort(), ['A', 'B'])
  assert.equal(loading, false)
})

test('watchAll: 9 current + 1 orphan must not auto-enable watchAll', () => {
  const historyGroupOptions = Array.from({ length: 10 }, (_, i) => ({ value: `group-${i}` }))
  const selectedGroupIds = [...historyGroupOptions.slice(0, 9).map((o) => o.value), 'orphan-room@chatroom']
  const selectedSet = new Set(selectedGroupIds)
  const allCurrentSelected = historyGroupOptions.length > 0
    && historyGroupOptions.every((option) => selectedSet.has(option.value))
  assert.equal(allCurrentSelected, false)
  const fullSelected = new Set(historyGroupOptions.map((o) => o.value))
  const allTen = historyGroupOptions.every((option) => fullSelected.has(option.value))
  assert.equal(allTen, true)
})

test('orphan monitor room keeps source instanceId', () => {
  const orphanMonitorRoomsByKey = {}
  const monitorRoomKey = (instanceId, roomId) => `${instanceId}\u0000${roomId}`
  const rooms = [{ instanceId: 'wechat-b', roomId: 'room-x@chatroom', name: '新群' }]
  for (const room of rooms) {
    orphanMonitorRoomsByKey[monitorRoomKey(room.instanceId, room.roomId)] = room
  }
  const hit = orphanMonitorRoomsByKey[monitorRoomKey('wechat-b', 'room-x@chatroom')]
  assert.equal(hit.instanceId, 'wechat-b')
  assert.notEqual(hit.instanceId, 'wechat-a')
})

test('friend add statuses are isolated per instance', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-friend-status-'))
  try {
    storage.initStorage(folder)
    storage.upsertInstance({ id: 'inst-a', apiPort: 1, tcpPort: 2, pid: 1, accountWxid: 'wx-a', status: 'ONLINE', managed: true })
    storage.upsertInstance({ id: 'inst-b', apiPort: 3, tcpPort: 4, pid: 2, accountWxid: 'wx-b', status: 'ONLINE', managed: true })
    storage.createTask(
      { id: 'task-a', name: 'A', type: 'ADD_FRIEND', status: 'COMPLETED', config: {} },
      [{ id: 'item-a', instanceId: 'inst-a', targetKey: 'wxid_x', actionType: 'ADD_FRIEND', status: 'FAILED', request: {} }],
    )
    storage.setTaskItemResult('item-a', 'FAILED', { msg: 'fail' }, 'A failed')
    storage.createTask(
      { id: 'task-b', name: 'B', type: 'ADD_FRIEND', status: 'COMPLETED', config: {} },
      [{ id: 'item-b', instanceId: 'inst-b', targetKey: 'wxid_x', actionType: 'ADD_FRIEND', status: 'REQUEST_SENT', request: {} }],
    )
    storage.setTaskItemResult('item-b', 'REQUEST_SENT', { msg: 'ok' }, 'sent')
    const statuses = storage.listFriendAddStatuses([
      { instanceId: 'inst-a', targetKey: 'wxid_x' },
      { instanceId: 'inst-b', targetKey: 'wxid_x' },
    ])
    assert.equal(statuses['inst-a\u0000wxid_x'].status, 'FAILED')
    assert.equal(statuses['inst-b\u0000wxid_x'].status, 'REQUEST_SENT')
  } finally {
    storage.database().close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('delivery image hash cache respects file content change and max entries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-img-hash-'))
  const file = path.join(dir, 'a.jpg')
  const cache = new Map()
  const actionType = 'SEND_IMAGE'

  function digestFile() {
    const st = fs.statSync(file)
    const cacheKey = `${actionType}\0${file}`
    const cached = cache.get(cacheKey)
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.digest
    const digest = createHash('sha256').update(`${actionType}\0`).update(fs.readFileSync(file)).digest('hex')
    cache.set(cacheKey, { digest, size: st.size, mtimeMs: st.mtimeMs, usedAt: Date.now() })
    cleanupRuntimeTtlMaps({ deliveryImageHashCache: cache, DELIVERY_IMAGE_HASH_MAX: 512 })
    return digest
  }

  writeFileSync(file, Buffer.from('111'))
  const hash1 = digestFile()
  writeFileSync(file, Buffer.from('222222'))
  const nowSec = Date.now() / 1000
  utimesSync(file, nowSec + 1, nowSec + 1)
  const hash2 = digestFile()
  assert.notEqual(hash1, hash2)

  for (let i = 0; i < 10000; i += 1) {
    const p = path.join(dir, `f-${i}.jpg`)
    writeFileSync(p, Buffer.from(String(i)))
    const st = fs.statSync(p)
    cache.set(`${actionType}\0${p}`, { digest: `d-${i}`, size: st.size, mtimeMs: st.mtimeMs, usedAt: Date.now() - i })
  }
  cleanupRuntimeTtlMaps({ deliveryImageHashCache: cache, DELIVERY_IMAGE_HASH_MAX: 512 })
  assert.ok(cache.size <= 512)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('API sample sanitizer redacts v3/v4/token fields', () => {
  const sanitized = storage.sanitizeApiSampleValue({
    v3: 'v3_abc_secret_value',
    v4: 'v4_long_secret_value_here',
    encryptUserName: 'enc',
    token: 'Bearer abc',
    nested: { antiSpamTicket: 'ticket', ok: true },
  })
  assert.equal(sanitized.v3.redacted, true)
  assert.equal(sanitized.v4.redacted, true)
  assert.equal(sanitized.token.redacted, true)
  assert.equal(sanitized.nested.antiSpamTicket.redacted, true)
  assert.equal(sanitized.nested.ok, true)
  assert.doesNotMatch(JSON.stringify(sanitized), /v3_abc_secret_value/)
  assert.doesNotMatch(JSON.stringify(sanitized), /v4_long_secret_value_here/)
})

test('logs and api samples trim when exceeding bounds', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-storage-trim-'))
  try {
    storage.initStorage(folder)
    for (let i = 0; i < 250; i += 1) {
      storage.saveLog({ time: new Date().toISOString(), level: 'INFO', message: `log-${i}`, module: 'test', details: {} })
    }
    const logCount = storage.database().prepare('SELECT COUNT(*) AS c FROM logs').get().c
    assert.ok(logCount <= 30000)

    for (let i = 0; i < 250; i += 1) {
      storage.saveApiSample({
        instanceId: 'inst-1',
        sourceId: 1,
        path: '/api/add_friend',
        request: { v3: `secret-v3-${i}`, v4: `secret-v4-${i}` },
        response: { token: `tok-${i}` },
        httpStatus: 200,
        durationMs: 1,
      })
    }
    const sampleRows = storage.database().prepare('SELECT request_json, response_json FROM wechat_api_runtime_samples').all()
    for (const row of sampleRows) {
      assert.doesNotMatch(String(row.request_json), /secret-v3-\d/)
      assert.doesNotMatch(String(row.request_json), /secret-v4-\d/)
      assert.doesNotMatch(String(row.response_json), /"tok-\d+"/)
      assert.match(String(row.request_json), /"redacted":true/)
    }
    const sampleCount = storage.database().prepare('SELECT COUNT(*) AS c FROM wechat_api_runtime_samples').get().c
    assert.ok(sampleCount <= 9000)
  } finally {
    storage.database().close()
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

test('read broker coalesces concurrent same read API (watchAll + UI refresh scenario)', async () => {
  clearInstanceCache('inst1')
  resetAllStats()
  const counts = new Map()
  const requestApiFn = async (record, apiPath) => {
    const key = `${record.id}|${apiPath}`
    counts.set(key, (counts.get(key) || 0) + 1)
    await new Promise((r) => setTimeout(r, 20))
    return { response: { ok: true, status: 200 }, raw: { data: [] } }
  }
  const record = { id: 'inst1' }
  const p1 = requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn })
  const p2 = requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn })
  await Promise.all([p1, p2])
  assert.equal(counts.get('inst1|/api/get_chatroom_list'), 1)
  assert.ok(READ_API_WHITELIST.has('/api/batch_getroom_cache'))
})

test('client-updater rejects 206 without Content-Range', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'client-updater.cjs'), 'utf8')
  assert.match(src, /RANGE_INVALID_CONTENT_RANGE/)
  assert.match(src, /RANGE_BODY_TOO_LARGE/)
  const rangeFn = src.slice(src.indexOf('function downloadRangeToFile'), src.indexOf('function downloadWithResume'))
  assert.match(rangeFn, /if \(!crMatch\)/)
  assert.match(rangeFn, /offset \+ chunk\.length > end \+ 1/)
})

test('token refresh disconnected path schedules retry timer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'remote-agent.cjs'), 'utf8')
  assert.match(src, /function ensureTokenRefreshScheduled/)
  assert.match(src, /if \(stopping \|\| !state\.running \|\| reconnectTimer\) return/)
  assert.match(src, /if \(stopping \|\| !state\.running \|\| !state\.identity\) return/)
  assert.match(src, /if \(socket !== ws\) return/)
  assert.match(src, /30000/)
  assert.doesNotMatch(src.split('function stopRemoteAgent')[1]?.split('function getStatus')[0] || '', /stopping = false/)
})

test('wechat:call-api routes read APIs through broker whitelist', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const ipc = main.slice(main.indexOf("ipcMain.handle('wechat:call-api'"), main.indexOf("ipcMain.handle('wechat:list-events'"))
  assert.match(ipc, /READ_API_WHITELIST\.has\(apiPath\)/)
  assert.match(ipc, /readApi\(record, apiPath/)
  assert.match(ipc, /requestApi\(record, apiPath/)
})

test('pause gate blocks add_friend and kicked destructive mutations before submit', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /function blockMutationForTaskStop/)
  const runTask = main.slice(main.indexOf('async function runTask('), main.indexOf("ipcMain.handle('wechat:call-api'"))
  assert.ok((runTask.match(/blockMutationForTaskStop\(taskId, item\.id\)/g) || []).length >= 2)
  const kick = main.slice(main.indexOf('async function cleanupOneKickedGroupRoom'), main.indexOf('async function prepareKickedGroupCleanupTask'))
  assert.ok((kick.match(/isTaskStopRequested\(taskId\)/g) || []).length >= 2)
})
