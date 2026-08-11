const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { mergeMonitorRooms, extractRoomsFromApiRaw, normalizeMonitorRoom, monitorRoomKey } = require('../electron/qr-monitor-rooms.cjs')

test('normalizeMonitorRoom rejects invalid entries', () => {
  assert.equal(normalizeMonitorRoom(null), null)
  assert.equal(normalizeMonitorRoom({ instanceId: 'a', roomId: 'x' }), null)
  assert.deepEqual(normalizeMonitorRoom({ instanceId: 'a', roomId: '1@chatroom', name: '测试' }), {
    instanceId: 'a',
    roomId: '1@chatroom',
    name: '测试',
  })
})

test('mergeMonitorRooms keeps A-roomX and B-roomX as separate pairs', () => {
  const roomX = 'room-x@chatroom'
  const merged = mergeMonitorRooms([], [
    { instanceId: 'wechat-a', roomId: roomX, name: 'A群' },
    { instanceId: 'wechat-b', roomId: roomX, name: 'B群' },
  ])
  assert.equal(merged.rooms.length, 2)
  assert.equal(merged.added.length, 2)
  const a = merged.rooms.find((item) => item.instanceId === 'wechat-a')
  const b = merged.rooms.find((item) => item.instanceId === 'wechat-b')
  assert.equal(a?.name, 'A群')
  assert.equal(b?.name, 'B群')
})

test('mergeMonitorRooms rename updates only same instance pair', () => {
  const roomX = 'room-x@chatroom'
  const base = mergeMonitorRooms([], [
    { instanceId: 'wechat-a', roomId: roomX, name: '旧名' },
    { instanceId: 'wechat-b', roomId: roomX, name: 'B群' },
  ])
  const updated = mergeMonitorRooms(base.rooms, [
    { instanceId: 'wechat-a', roomId: roomX, name: '新名' },
  ])
  assert.equal(updated.rooms.length, 2)
  assert.equal(updated.added.length, 0)
  assert.equal(updated.rooms.find((item) => item.instanceId === 'wechat-a')?.name, '新名')
  assert.equal(updated.rooms.find((item) => item.instanceId === 'wechat-b')?.name, 'B群')
})

test('monitorRoomKey is stable pair identity', () => {
  const key = monitorRoomKey('inst-a', 'room@chatroom')
  assert.equal(key, 'inst-a\u0000room@chatroom')
})

test('extractRoomsFromApiRaw finds nested chatroom ids', () => {
  const rows = extractRoomsFromApiRaw({
    data: {
      list: [
        { userName: 'aaa@chatroom', nickName: '甲群' },
        { room_id: 'bbb@chatroom', remark: '乙群' },
        { userName: 'not-a-room' },
      ],
    },
  })
  assert.equal(rows.length, 2)
  assert.ok(rows.some((item) => item.roomId === 'aaa@chatroom' && item.name === '甲群'))
  assert.ok(rows.some((item) => item.roomId === 'bbb@chatroom' && item.name === '乙群'))
})

test('qr monitor pair-key wiring exists in main/preload/ui', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'QrTasksPage.vue'), 'utf8')

  assert.match(main, /qrMonitorRoomByKey/)
  assert.match(main, /monitorRoomKey/)
  assert.doesNotMatch(main, /function bindQrMonitorRoom/)
  assert.match(main, /resolveQrMonitorRoom/)
  assert.match(preload, /onQrMonitorRoomsChanged/)
  assert.match(page, /selectedMonitorRoomKeys/)
  assert.match(page, /orphanMonitorRoomsByKey/)
})
