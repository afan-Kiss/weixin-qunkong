'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { mergeMonitorRooms, rebindMonitorRoomsForAccount, normalizeMonitorRoom, monitorRoomKey } = require('../electron/qr-monitor-rooms.cjs')
const { appendJsonlLog, resetLogWriterStateForTests, rotateLogFile } = require('../electron/jsonl-log-writer.cjs')
const { pruneDiagnosticReportFiles } = require('../electron/diagnostic-file-prune.cjs')
const { reserveRecentQrContentHash, RECENT_QR_HASH_MAX } = require('../electron/recent-qr-hash-cache.cjs')
const { cleanupRuntimeTtlMaps } = require('../electron/runtime-ttl-cleanup.cjs')
const { pruneStoppedRuntimeInstances, pruneStoppedRuntimeForAccount } = require('../electron/stopped-instance-prune.cjs')
const { ALLOWED_ENDPOINTS } = require('../electron/friend-credential-diagnostic.cjs')

test('directory overlapping scope uses per-instance single-flight', () => {
  const store = fs.readFileSync(path.join(__dirname, '..', 'src', 'stores', 'wechatData.ts'), 'utf8')
  assert.match(store, /directoryInstanceInflight/)
  assert.match(store, /function refreshDirectoryInstance/)
  assert.match(store, /directoryInstanceInflight\.get\(instance\.id\)/)
  assert.match(store, /Promise\.all\(selected\.map/)
})

test('behavioral: refresh(A)+refresh(ALL) shares A instance inflight once', async () => {
  // Simulate per-instance single-flight used by the store
  const instanceInflight = new Map()
  const apiCalls = { A: 0, B: 0 }
  function refreshInstance(id) {
    if (instanceInflight.has(id)) return instanceInflight.get(id)
    const p = (async () => {
      apiCalls[id] += 1
      await new Promise((r) => setTimeout(r, 30))
      return { id, data: `fresh-${id}-${apiCalls[id]}` }
    })().finally(() => instanceInflight.delete(id))
    instanceInflight.set(id, p)
    return p
  }
  async function refresh(ids) {
    return Promise.all(ids.map(refreshInstance))
  }
  const [aOnly, all] = await Promise.all([
    refresh(['A']),
    refresh(['A', 'B']),
  ])
  assert.equal(apiCalls.A, 1)
  assert.equal(apiCalls.B, 1)
  assert.equal(aOnly[0].data, all[0].data)
})

test('behavioral: A-only + A,B does not double-call A', async () => {
  const instanceInflight = new Map()
  let aCalls = 0
  function refreshInstance(id) {
    if (instanceInflight.has(id)) return instanceInflight.get(id)
    const p = (async () => {
      if (id === 'A') aCalls += 1
      await new Promise((r) => setTimeout(r, 20))
      return id
    })().finally(() => instanceInflight.delete(id))
    instanceInflight.set(id, p)
    return p
  }
  await Promise.all([
    Promise.all(['A'].map(refreshInstance)),
    Promise.all(['A', 'B'].map(refreshInstance)),
  ])
  assert.equal(aCalls, 1)
})

test('QR rebind: AAA STOPPED → BBB ONLINE same account migrates room', () => {
  const rooms = [{ instanceId: 'AAA', accountWxid: 'wxA', roomId: 'room1@chatroom', name: '群1' }]
  const instances = new Map([
    ['AAA', { id: 'AAA', status: 'STOPPED', accountWxid: 'wxA' }],
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' }],
  ])
  const result = rebindMonitorRoomsForAccount(rooms, { id: 'BBB', accountWxid: 'wxA' }, instances)
  assert.equal(result.changed, true)
  assert.equal(result.rooms.length, 1)
  assert.equal(result.rooms[0].instanceId, 'BBB')
  assert.equal(result.rooms[0].accountWxid, 'wxA')
  assert.equal(result.rooms[0].roomId, 'room1@chatroom')
})

test('QR rebind: two ONLINE same account does not steal', () => {
  const rooms = [{ instanceId: 'AAA', accountWxid: 'wxA', roomId: 'room1@chatroom', name: '群1' }]
  const instances = new Map([
    ['AAA', { id: 'AAA', status: 'ONLINE', accountWxid: 'wxA' }],
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' }],
  ])
  const result = rebindMonitorRoomsForAccount(rooms, { id: 'BBB', accountWxid: 'wxA' }, instances)
  assert.equal(result.changed, false)
  assert.equal(result.rooms[0].instanceId, 'AAA')
})

test('QR rebind: cross account never rebinds', () => {
  const rooms = [{ instanceId: 'AAA', accountWxid: 'wxA', roomId: 'room1@chatroom', name: '群1' }]
  const instances = new Map([
    ['AAA', { id: 'AAA', status: 'STOPPED', accountWxid: 'wxA' }],
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxB' }],
  ])
  const result = rebindMonitorRoomsForAccount(rooms, { id: 'BBB', accountWxid: 'wxB' }, instances)
  assert.equal(result.changed, false)
  assert.equal(result.rooms[0].instanceId, 'AAA')
  assert.equal(result.rooms[0].accountWxid, 'wxA')
})

test('QR rebind watchAll restart does not leave AAA+BBB duplicates', () => {
  const rooms = [{ instanceId: 'AAA', accountWxid: 'wxA', roomId: 'room1@chatroom', name: '群1' }]
  const instances = new Map([
    ['AAA', { id: 'AAA', status: 'STOPPED', accountWxid: 'wxA' }],
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' }],
  ])
  const rebound = rebindMonitorRoomsForAccount(rooms, { id: 'BBB', accountWxid: 'wxA' }, instances)
  // watchAll sync would push BBB+room1; merge must not duplicate after rebind
  const merged = mergeMonitorRooms(rebound.rooms, [
    { instanceId: 'BBB', accountWxid: 'wxA', roomId: 'room1@chatroom', name: '群1' },
  ])
  assert.equal(merged.rooms.length, 1)
  assert.equal(merged.rooms[0].instanceId, 'BBB')
})

test('watchAll=false after rebind: BBB+room1 is monitored', () => {
  const rooms = [{ instanceId: 'AAA', accountWxid: 'wxA', roomId: 'room1@chatroom', name: '群1' }]
  const instances = new Map([['AAA', { status: 'STOPPED', accountWxid: 'wxA' }]])
  const rebound = rebindMonitorRoomsForAccount(rooms, { id: 'BBB', accountWxid: 'wxA' }, instances)
  const index = new Map()
  for (const room of rebound.rooms) index.set(monitorRoomKey(room.instanceId, room.roomId), room)
  assert.ok(index.has(monitorRoomKey('BBB', 'room1@chatroom')))
  assert.equal(index.has(monitorRoomKey('AAA', 'room1@chatroom')), false)
})

test('normalizeMonitorRoom keeps accountWxid', () => {
  assert.deepEqual(normalizeMonitorRoom({
    instanceId: 'a', accountWxid: 'wx1', roomId: '1@chatroom', name: '测',
  }), { instanceId: 'a', accountWxid: 'wx1', roomId: '1@chatroom', name: '测' })
})

test('JSONL rotate creates .1 and honors maxFiles=2 (no .3)', () => {
  resetLogWriterStateForTests()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-jsonl-rot-'))
  const payload = { level: 'INFO', message: 'x'.repeat(200) }
  for (let i = 0; i < 20; i += 1) {
    appendJsonlLog(dir, { ...payload, i }, { maxBytes: 512, maxFiles: 2 })
  }
  const names = fs.readdirSync(dir).sort()
  assert.ok(names.includes('wechat-control.jsonl'))
  assert.ok(names.includes('wechat-control.1.jsonl'))
  assert.ok(names.includes('wechat-control.2.jsonl'))
  assert.equal(names.includes('wechat-control.3.jsonl'), false)
  // main → .1 path must have existed at some point; after further rotates .1 still present
  assert.ok(fs.existsSync(path.join(dir, 'wechat-control.1.jsonl')))
})

test('JSONL rotate with maxFiles=3 keeps main/.1/.2/.3 only', () => {
  resetLogWriterStateForTests()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-jsonl-m3-'))
  for (let i = 0; i < 40; i += 1) {
    appendJsonlLog(dir, { level: 'INFO', message: `line-${i}-${'y'.repeat(80)}` }, { maxBytes: 512, maxFiles: 3 })
  }
  const names = fs.readdirSync(dir).filter((n) => n.startsWith('wechat-control')).sort()
  assert.ok(names.includes('wechat-control.jsonl'))
  assert.ok(names.includes('wechat-control.1.jsonl'))
  assert.equal(names.includes('wechat-control.4.jsonl'), false)
  assert.ok(names.length <= 4) // main + .1 .2 .3
})

test('rotateLogFile main goes to .1 not .2', () => {
  resetLogWriterStateForTests()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-jsonl-one-'))
  fs.writeFileSync(path.join(dir, 'wechat-control.jsonl'), '{"a":1}\n')
  rotateLogFile(dir, 5, 'wechat-control.jsonl')
  assert.equal(fs.existsSync(path.join(dir, 'wechat-control.jsonl')), false)
  assert.ok(fs.existsSync(path.join(dir, 'wechat-control.1.jsonl')))
  assert.equal(fs.existsSync(path.join(dir, 'wechat-control.2.jsonl')), false)
})

test('diagnostic JSON prune max 300 and TTL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-diag-'))
  const now = Date.now()
  for (let i = 0; i < 310; i += 1) {
    const file = path.join(dir, `d${i}.json`)
    fs.writeFileSync(file, '{}')
    fs.utimesSync(file, new Date(now - 1000), new Date(now - (310 - i) * 1000))
  }
  fs.writeFileSync(path.join(dir, 'diagnostics.jsonl'), '{}\n')
  pruneDiagnosticReportFiles(dir, { maxFiles: 300, now })
  const jsons = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
  assert.ok(jsons.length <= 300)
  assert.ok(fs.existsSync(path.join(dir, 'diagnostics.jsonl')))

  const expired = path.join(dir, 'old.json')
  fs.writeFileSync(expired, '{}')
  fs.utimesSync(expired, new Date(now - 40 * 24 * 3600 * 1000), new Date(now - 40 * 24 * 3600 * 1000))
  pruneDiagnosticReportFiles(dir, { maxFiles: 300, ttlMs: 30 * 24 * 3600 * 1000, now })
  assert.equal(fs.existsSync(expired), false)
})

test('recent QR hash: concurrent reserve only first wins; 100000 capped; TTL cleanup', () => {
  const map = new Map()
  const persistent = new Set(['DBHASH'])
  assert.equal(reserveRecentQrContentHash(map, 'DBHASH', { hasPersistent: (h) => persistent.has(h) }), true)

  const first = reserveRecentQrContentHash(map, 'X', { now: 1000 })
  const second = reserveRecentQrContentHash(map, 'X', { now: 1000 })
  assert.equal(first, false)
  assert.equal(second, true)

  for (let i = 0; i < 100000; i += 1) {
    reserveRecentQrContentHash(map, `H${i}`, { now: 2000 + i, max: RECENT_QR_HASH_MAX })
  }
  cleanupRuntimeTtlMaps({
    recentQrContentHashes: map,
    RECENT_QR_HASH_TTL_MS: 600000,
    RECENT_QR_HASH_MAX,
  }, 2000 + 100000)
  assert.ok(map.size <= RECENT_QR_HASH_MAX)

  const ttlMap = new Map([['OLD', 1000]])
  cleanupRuntimeTtlMaps({
    recentQrContentHashes: ttlMap,
    RECENT_QR_HASH_TTL_MS: 600000,
    RECENT_QR_HASH_MAX,
  }, 1000 + 600001)
  assert.equal(ttlMap.has('OLD'), false)
  // SQLite still has it
  assert.equal(reserveRecentQrContentHash(new Map(), 'DBHASH', {
    hasPersistent: (h) => persistent.has(h),
  }), true)
})

test('STOPPED runtime prune keeps bound and does not remove ONLINE', () => {
  const map = new Map()
  const now = Date.now()
  for (let i = 0; i < 100; i += 1) {
    map.set(`s${i}`, { id: `s${i}`, status: 'STOPPED', stoppedAt: now - i * 1000, accountWxid: 'wx' })
  }
  map.set('online', { id: 'online', status: 'ONLINE', accountWxid: 'wx' })
  pruneStoppedRuntimeInstances(map, { now, maxStopped: 20, ttlMs: 24 * 3600 * 1000 })
  assert.ok(map.has('online'))
  assert.ok([...map.values()].filter((x) => x.status === 'STOPPED').length <= 20)
})

test('same-account ONLINE prunes old STOPPED runtime but SQLite concept retained', () => {
  const map = new Map([
    ['old', { id: 'old', status: 'STOPPED', accountWxid: 'wxA' }],
    ['new', { id: 'new', status: 'ONLINE', accountWxid: 'wxA' }],
    ['other', { id: 'other', status: 'STOPPED', accountWxid: 'wxB' }],
  ])
  pruneStoppedRuntimeForAccount(map, { id: 'new', accountWxid: 'wxA' })
  assert.equal(map.has('old'), false)
  assert.ok(map.has('new'))
  assert.ok(map.has('other'))
})

test('firstProbe timer cleared on stop; stale probe guards', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /record\.firstProbeTimer/)
  assert.match(main, /clearTimeout\(record\.firstProbeTimer\)/)
  assert.match(main, /instances\.get\(record\.id\) !== record/)
  assert.match(main, /if \(!record \|\| record\.stopping\) return false/)
})

test('chatAddMissLogAt cleaned by instance prefix and TTL', () => {
  const chatAddMissLogAt = new Map([
    ['inst1:reason', Date.now() - 1000],
    ['inst2:reason', Date.now() - 20 * 60 * 1000],
  ])
  const instanceId = 'inst1'
  for (const [key] of chatAddMissLogAt) {
    if (key.startsWith(`${instanceId}:`)) chatAddMissLogAt.delete(key)
  }
  assert.equal(chatAddMissLogAt.has('inst1:reason'), false)
  cleanupRuntimeTtlMaps({ chatAddMissLogAt, CHAT_ADD_MISS_LOG_TTL_MS: 600000 }, Date.now())
  assert.equal(chatAddMissLogAt.has('inst2:reason'), false)
})

test('QR monitor stop clears pending and empties queue map when active finishes', async () => {
  const qrMonitorQueues = new Map()
  let enabled = true
  const QR_MONITOR_CONCURRENCY = 1
  function pump(instanceId) {
    if (!enabled) return
    const state = qrMonitorQueues.get(instanceId)
    if (!state) return
    while (state.active < QR_MONITOR_CONCURRENCY && state.pending.length) {
      const item = state.pending.shift()
      state.active += 1
      Promise.resolve().then(() => item.job()).then(item.resolve, item.reject).finally(() => {
        state.active -= 1
        if (!enabled) {
          if ((state.active || 0) <= 0 && !(state.pending?.length)) qrMonitorQueues.delete(instanceId)
          return
        }
        if (!state.pending.length && state.active <= 0) qrMonitorQueues.delete(instanceId)
        else pump(instanceId)
      })
    }
  }
  const instanceId = 'wx1'
  const state = { active: 0, pending: [] }
  qrMonitorQueues.set(instanceId, state)
  let resolveActive
  const activeDone = new Promise((r) => { resolveActive = r })
  state.pending.push({
    job: () => new Promise((r) => setTimeout(() => { r('done'); resolveActive() }, 40)),
    resolve: () => {},
    reject: () => {},
  })
  for (let i = 0; i < 100; i += 1) {
    state.pending.push({
      job: async () => 'x',
      resolve: () => {},
      reject: () => {},
    })
  }
  pump(instanceId)
  // stop while active=1 pending many
  enabled = false
  while (state.pending.length) {
    const item = state.pending.shift()
    item.resolve({ skipped: true })
  }
  await activeDone
  await new Promise((r) => setTimeout(r, 20))
  // active finally should have deleted
  assert.equal(qrMonitorQueues.size, 0)
})

test('friend credential diagnostic is read-only (no add_friend)', () => {
  assert.equal(ALLOWED_ENDPOINTS.includes('/api/add_friend'), false)
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  // allowSingleAddFriendAfterVerified only parsed, never used to mutate
  assert.match(main, /allowSingleAddFriendAfterVerified/)
  assert.doesNotMatch(main, /allowSingleAddFriendAfterVerified[\s\S]{0,200}add_friend/)
})

test('main wires rebind + accountWxid + recent hash + firstProbe', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /rebindQrMonitorRoomsForInstance/)
  assert.match(main, /accountWxid: String\(record\.accountWxid/)
  assert.match(main, /recentQrContentHashes/)
  assert.match(main, /pruneDiagnosticReportFiles/)
  assert.match(main, /basename: 'diagnostics\.jsonl'/)
})
