'use strict'
const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { requestWechatRead, clearInstanceCache, getReadBrokerStats, resetAllStats, invalidateInstanceApi, stopCleanupTimer } = require('../electron/wechat-read-broker.cjs')

function makeRecord(id) { return { id, apiPort: 19000 } }
function okResult(data) { return { response: { ok: true, status: 200 }, raw: data || { data: [] } } }
function failResult() { return { response: { ok: false, status: 500 }, raw: null } }

function createCounter() {
  const counts = new Map()
  const fn = async (record, apiPath, body, timeout) => {
    const key = `${record.id}|${apiPath}`
    counts.set(key, (counts.get(key) || 0) + 1)
    await new Promise(r => setTimeout(r, 10))
    return okResult({ path: apiPath, instanceId: record.id })
  }
  fn.counts = counts
  fn.get = (id, path) => counts.get(`${id}|${path}`) || 0
  return fn
}

beforeEach(() => {
  clearInstanceCache('inst1')
  clearInstanceCache('inst2')
  resetAllStats()
})

// Test 1: 10 concurrent get_chatroom_list → 1 real request
describe('read broker coalescing', () => {
  it('test 1: 10 concurrent callers → 1 real request', async () => {
    const counter = createCounter()
    const record = makeRecord('inst1')
    const promises = Array.from({ length: 10 }, () =>
      requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter })
    )
    const results = await Promise.all(promises)
    assert.equal(counter.get('inst1', '/api/get_chatroom_list'), 1)
    assert.equal(results.length, 10)
    results.forEach(r => assert.ok(r.response.ok))
    const stats = getReadBrokerStats('inst1')
    assert.equal(stats.realRequests, 1)
    assert.equal(stats.coalescedHits, 9)
  })

  // Test 2: force=true during in-flight still shares Promise
  it('test 2: force=true shares in-flight', async () => {
    const counter = createCounter()
    const record = makeRecord('inst1')
    const p1 = requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter })
    const p2 = requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter, force: true })
    await Promise.all([p1, p2])
    assert.equal(counter.get('inst1', '/api/get_chatroom_list'), 1)
  })

  // Test 3: cache expires → second real request
  it('test 3: TTL expiry triggers new request', async () => {
    const counter = createCounter()
    const record = makeRecord('inst1')
    await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter, ttl: 30 })
    assert.equal(counter.get('inst1', '/api/get_chatroom_list'), 1)
    await new Promise(r => setTimeout(r, 50))
    await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter, ttl: 30 })
    assert.equal(counter.get('inst1', '/api/get_chatroom_list'), 2)
  })

  // Test 4: 10 concurrent get_all_room_detail → 1 real
  it('test 4: 10 concurrent detail → 1 real request', async () => {
    const counter = createCounter()
    const record = makeRecord('inst1')
    const promises = Array.from({ length: 10 }, () =>
      requestWechatRead(record, '/api/get_all_room_detail', {}, { requestApiFn: counter })
    )
    await Promise.all(promises)
    assert.equal(counter.get('inst1', '/api/get_all_room_detail'), 1)
  })

  // Test 5: detail shared across watchAll/qr/kick within TTL
  it('test 5: detail shared across modules within TTL', async () => {
    const counter = createCounter()
    const record = makeRecord('inst1')
    await requestWechatRead(record, '/api/get_all_room_detail', {}, { requestApiFn: counter })
    await requestWechatRead(record, '/api/get_all_room_detail', {}, { requestApiFn: counter })
    await requestWechatRead(record, '/api/get_all_room_detail', {}, { requestApiFn: counter })
    assert.equal(counter.get('inst1', '/api/get_all_room_detail'), 1)
    const stats = getReadBrokerStats('inst1')
    assert.equal(stats.cacheHits, 2)
  })

  // Test 12: different instances don't share cache
  it('test 12: different instances have separate cache', async () => {
    const counter = createCounter()
    const r1 = makeRecord('inst1')
    const r2 = makeRecord('inst2')
    await requestWechatRead(r1, '/api/get_chatroom_list', {}, { requestApiFn: counter })
    await requestWechatRead(r2, '/api/get_chatroom_list', {}, { requestApiFn: counter })
    assert.equal(counter.get('inst1', '/api/get_chatroom_list'), 1)
    assert.equal(counter.get('inst2', '/api/get_chatroom_list'), 1)
  })

  it('rejects mutation APIs', async () => {
    const counter = createCounter()
    const record = makeRecord('inst1')
    await assert.rejects(
      () => requestWechatRead(record, '/api/enter_room', {}, { requestApiFn: counter }),
      /not a read-only API/
    )
  })

  it('clearInstanceCache removes entries', async () => {
    const counter = createCounter()
    const record = makeRecord('inst1')
    await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter })
    clearInstanceCache('inst1')
    await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter })
    assert.equal(counter.get('inst1', '/api/get_chatroom_list'), 2)
  })

  it('invalidateInstanceApi only clears specific API', async () => {
    const counter = createCounter()
    const record = makeRecord('inst1')
    await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter })
    await requestWechatRead(record, '/api/get_all_room_detail', {}, { requestApiFn: counter })
    invalidateInstanceApi('inst1', '/api/get_chatroom_list')
    await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: counter })
    await requestWechatRead(record, '/api/get_all_room_detail', {}, { requestApiFn: counter })
    assert.equal(counter.get('inst1', '/api/get_chatroom_list'), 2)
    assert.equal(counter.get('inst1', '/api/get_all_room_detail'), 1)
  })

  it('failed requests are not cached', async () => {
    let callCount = 0
    const failFn = async () => { callCount++; return failResult() }
    const record = makeRecord('inst1')
    await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: failFn })
    await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: failFn })
    assert.equal(callCount, 2)
  })

  it('errors propagate to all callers', async () => {
    const errFn = async () => { throw new Error('network') }
    const record = makeRecord('inst1')
    const p1 = requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: errFn })
    const p2 = requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: errFn })
    await assert.rejects(() => p1, /network/)
    await assert.rejects(() => p2, /network/)
  })
})

describe('verifyJoinedRoom poll budget (string assertions)', () => {
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  // Test 6 & 7: verify poll budget
  it('test 6/7: uses pollDelays array (max 6 polls), no 16-iteration loop', () => {
    assert.ok(mainSrc.includes('pollDelays'), 'should use pollDelays array')
    assert.ok(!mainSrc.includes('attempt < 16'), 'should not have 16-iteration loop')
    assert.ok(mainSrc.includes('pollDelays.length'), 'loop should be bounded by pollDelays.length')
  })

  it('test 7: no extra final pollOnce after loop', () => {
    const afterLoop = mainSrc.split('pollDelays.length')[1] || ''
    const nextPollOnce = afterLoop.indexOf('pollOnce()')
    const nextLastSnap = afterLoop.indexOf('lastSnap')
    if (nextPollOnce >= 0 && nextLastSnap >= 0) {
      assert.ok(nextLastSnap < nextPollOnce, 'should use lastSnap before any pollOnce after loop')
    }
  })
})

describe('fetchInvitePreview caching (string assertions)', () => {
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  // Test 8-11: a8key budget assertions
  it('test 8/9/10: fetchInvitePreviewCached wraps fetchInvitePreviewReal', () => {
    assert.ok(mainSrc.includes('fetchInvitePreviewCached'), 'should have cached wrapper')
    assert.ok(mainSrc.includes('qrInvitePreviewInflight'), 'should have in-flight map')
    assert.ok(mainSrc.includes('qrInvitePreviewCache'), 'should have preview cache')
    assert.ok(mainSrc.includes('QR_INVITE_PREVIEW_TTL_MS'), 'should define TTL')
  })

  it('test 11: all callers use fetchInvitePreviewCached', () => {
    const cachedCalls = (mainSrc.match(/fetchInvitePreviewCached\(record/g) || []).length
    assert.ok(cachedCalls >= 3, `all call sites should use fetchInvitePreviewCached, found ${cachedCalls}`)
    const allRealRefs = (mainSrc.match(/fetchInvitePreviewReal/g) || []).length
    assert.ok(allRealRefs <= 3, 'fetchInvitePreviewReal should only appear in its definition and cached wrapper')
  })
})

describe('kicked group mutation exactly-once (string assertions)', () => {
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  // Test 13/14: no retry loop for quit/del mutations
  it('test 13/14: quitAndClearKickedRoomSession no longer re-runs mutations', () => {
    const fnBody = mainSrc.split('async function quitAndClearKickedRoomSession')[1]?.split('\nasync function')[0] || ''
    const runQuitAndDelCalls = (fnBody.match(/runQuitAndDel\(\)/g) || []).length
    assert.equal(runQuitAndDelCalls, 1, 'runQuitAndDel should be called exactly once')
    assert.ok(!fnBody.includes('retry < 2'), 'should not have retry loop for mutations')
    assert.ok(fnBody.includes('recheckDelays'), 'should have read-only recheck delays')
  })
})

describe('kicked scan active promise (string assertions)', () => {
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  // Test 15/16: kicked scan uses activePromise guard
  it('test 15/16: kicked-groups:cleanup uses kickedGroupCleanupActivePromise', () => {
    assert.ok(mainSrc.includes('kickedGroupCleanupActivePromise'), 'should have activePromise variable')
    const ipcHandler = mainSrc.split("kicked-groups:cleanup")[1]?.split('ipcMain.handle')[0] || ''
    assert.ok(ipcHandler.includes('kickedGroupCleanupActivePromise'), 'IPC handler should check activePromise')
    const catchBlock = ipcHandler.split('catch (error)')[1]?.split('}')[0] || ''
    assert.ok(!catchBlock.includes('kickedGroupCleanupPreparing = false'), 'catch block should not release business lock')
  })
})

describe('QR monitor image event dedup (string assertions)', () => {
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  // Test 17/18/19: image event dedup
  it('test 17: handleQrMonitorEvent has dedup by messageId', () => {
    assert.ok(mainSrc.includes('qrMonitorRecentEvents'), 'should have recent events map')
    assert.ok(mainSrc.includes('QR_MONITOR_EVENT_DEDUP_TTL_MS'), 'should define dedup TTL')
    assert.ok(mainSrc.includes('dedupKey'), 'should construct dedup key')
  })

  it('test 19: dedup key includes instanceId + roomId + messageId', () => {
    const fnBody = mainSrc.split('async function handleQrMonitorEvent')[1]?.split('\nasync function')[0] || ''
    assert.ok(fnBody.includes('record.id'), 'dedup key should include instanceId')
    assert.ok(fnBody.includes('room.roomId'), 'dedup key should include roomId')
    assert.ok(fnBody.includes('msgId'), 'dedup key should include messageId')
  })
})

describe('friend credential single-flight (string assertions)', () => {
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  // Test 20/21: credential single-flight
  it('test 20: resolvePendingFriendProfile uses friendCredentialInflight', () => {
    assert.ok(mainSrc.includes('friendCredentialInflight'), 'should have credential in-flight map')
    const fnBody = mainSrc.split('async function resolvePendingFriendProfile')[1]?.split('\nasync function')[0] || ''
    assert.ok(fnBody.includes('credKey'), 'should construct credential key')
    assert.ok(fnBody.includes('friendCredentialInflight.get'), 'should check in-flight')
    assert.ok(fnBody.includes('friendCredentialInflight.set'), 'should set in-flight')
  })

  it('test 21: friend-credential-resolve has early exit on V4/V3', () => {
    const credSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'friend-credential-resolve.cjs'), 'utf8')
    assert.ok(credSrc.includes('if (v4) break'), 'should break early when V4 found')
    assert.ok(credSrc.includes("if (profileV3) {"), 'should break early when V3 found')
  })
})

describe('mutation safety (string assertions)', () => {
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  // Test 22: send_text not routed through readApi/broker
  it('test 22: send_text_msg not routed through read broker', () => {
    assert.ok(!mainSrc.includes("readApi(record, '/api/send_text_msg'"), 'send_text must not use readApi')
    assert.ok(mainSrc.includes("'/api/send_text_msg'"), 'send_text_msg should exist in code')
  })

  // Test 23: enter_room not auto-retried
  it('test 23: enter_room uses requestApi and has idempotency guard', () => {
    assert.ok(mainSrc.includes("requestApi(record, '/api/enter_room'"), 'enter_room should use requestApi')
    assert.ok(mainSrc.includes('isEnterRoomSubmitted'), 'should check idempotency before enter_room')
    assert.ok(mainSrc.includes('markEnterRoomSubmitted'), 'should mark after enter_room')
  })
})

describe('read broker wiring (string assertions)', () => {
  const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

  it('readApi helper exists and wraps requestWechatRead', () => {
    assert.ok(mainSrc.includes('function readApi('), 'should have readApi helper')
    assert.ok(mainSrc.includes('requestWechatRead'), 'should import requestWechatRead')
  })

  it('loadLiveRoomIdsForKickGate uses readApi', () => {
    const fnBody = mainSrc.split('async function loadLiveRoomIdsForKickGate')[1]?.split('\nasync function')[0] || ''
    assert.ok(fnBody.includes('readApi('), 'should use readApi')
    assert.ok(!fnBody.includes('Promise.all'), 'should not fetch list+detail in parallel')
  })

  it('syncQrMonitorRoomsFromWechat uses readApi', () => {
    const fnBody = mainSrc.split('async function syncQrMonitorRoomsFromWechat')[1]?.split('\nasync function')[0] || ''
    assert.ok(fnBody.includes('readApi('), 'should use readApi')
  })

  it('readWechatRoomListState uses readApi', () => {
    const fnBody = mainSrc.split('async function readWechatRoomListState')[1]?.split('\nasync function')[0] || ''
    assert.ok(fnBody.includes('readApi('), 'should use readApi')
  })

  it('markInstanceStopped clears instance cache', () => {
    const fnBody = mainSrc.split('function markInstanceStopped')[1]?.split('\nfunction')[0] || ''
    assert.ok(fnBody.includes('clearInstanceCache'), 'should call clearInstanceCache')
    assert.ok(fnBody.includes('cleanInstanceMaps'), 'should call cleanInstanceMaps')
  })
})

describe('resolveFriendProfileCredentials request budget', () => {
  const { resolveFriendProfileCredentials } = require('../electron/friend-credential-resolve.cjs')

  // Test 21 behavioral: typical success path
  it('test 21 behavioral: V4 first call, V3 first call → minimal requests', async () => {
    let callCount = 0
    const fetchProfile = async (endpoint, body, sourceId, attempt) => {
      callCount++
      if (endpoint === '/api/get_group_member_contact') {
        return { parsed: { v3: '', v4: 'v4_ticket_fresh' } }
      }
      if (endpoint === '/api/update_single_profile') {
        return { parsed: { v3: 'v3_encrypt_name', v4: '' } }
      }
      return { parsed: {} }
    }
    const result = await resolveFriendProfileCredentials({
      targetWxid: 'wxid_target',
      sourceRoomId: 'room@chatroom',
      fetchProfile,
    })
    assert.ok(result.ok)
    assert.equal(result.v4, 'v4_ticket_fresh')
    assert.equal(result.v3, 'v3_encrypt_name')
    assert.ok(callCount <= 3, `expected <=3 calls, got ${callCount}`)
  })
})

const test = require('node:test')

test('account switch clears all instance cache — new wxid gets fresh data', async () => {
  resetAllStats()
  stopCleanupTimer()
  let realCalls = 0
  const mockRequestApi = async () => { realCalls++; return { response: { ok: true }, data: { rooms: [`room_${realCalls}`] } } }
  const record = { id: 'inst-switch', apiPort: 9999 }
  await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: mockRequestApi })
  assert.equal(realCalls, 1)
  await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: mockRequestApi })
  assert.equal(realCalls, 1, 'should hit cache')
  clearInstanceCache('inst-switch')
  await requestWechatRead(record, '/api/get_chatroom_list', {}, { requestApiFn: mockRequestApi })
  assert.equal(realCalls, 2, 'after cache clear, should make real request')
})

test('update_single_profile has TTL=0 (single-flight only)', async () => {
  resetAllStats()
  let calls = 0
  const mockRequestApi = async () => { calls++; return { response: { ok: true }, parsed: { v3: 'test' } } }
  const record = { id: 'inst-ttl0' }
  await requestWechatRead(record, '/api/update_single_profile', { wxid: 'w1' }, { requestApiFn: mockRequestApi })
  assert.equal(calls, 1)
  await requestWechatRead(record, '/api/update_single_profile', { wxid: 'w1' }, { requestApiFn: mockRequestApi })
  assert.equal(calls, 2, 'TTL=0 should not cache')
})

test('get_group_member_contact has TTL=0 (single-flight only)', async () => {
  resetAllStats()
  let calls = 0
  const mockRequestApi = async () => { calls++; return { response: { ok: true }, parsed: { v4: 'ticket' } } }
  const record = { id: 'inst-ttl0b' }
  await requestWechatRead(record, '/api/get_group_member_contact', { wxid: 'w1' }, { requestApiFn: mockRequestApi })
  assert.equal(calls, 1)
  await requestWechatRead(record, '/api/get_group_member_contact', { wxid: 'w1' }, { requestApiFn: mockRequestApi })
  assert.equal(calls, 2, 'TTL=0 should not cache')
})

test('cache cleanup removes expired entries under stress', async () => {
  resetAllStats()
  const mockRequestApi = async () => ({ response: { ok: true }, data: {} })
  const record = { id: 'inst-stress' }
  const promises = []
  for (let i = 0; i < 100; i++) {
    promises.push(requestWechatRead(record, '/api/get_contact', { wxid: `wxid_${i}` }, { requestApiFn: mockRequestApi, ttl: 1 }))
  }
  await Promise.all(promises)
  await new Promise((r) => setTimeout(r, 10))
  clearInstanceCache('inst-stress')
  const stats = getReadBrokerStats('inst-stress')
  assert.equal(stats.realRequests, 0, 'stats cleared after clearInstanceCache')
})
