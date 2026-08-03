const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { mergeMonitorRooms, extractRoomsFromApiRaw, normalizeMonitorRoom } = require('../electron/qr-monitor-rooms.cjs')

test('normalizeMonitorRoom rejects invalid entries', () => {
  assert.equal(normalizeMonitorRoom(null), null)
  assert.equal(normalizeMonitorRoom({ instanceId: 'a', roomId: 'x' }), null)
  assert.deepEqual(normalizeMonitorRoom({ instanceId: 'a', roomId: '1@chatroom', name: '测试' }), {
    instanceId: 'a',
    roomId: '1@chatroom',
    name: '测试',
  })
})

test('mergeMonitorRooms grows list and dedupes by roomId', () => {
  const first = mergeMonitorRooms([], [
    { instanceId: 'ins1', roomId: '100@chatroom', name: '群A' },
    { instanceId: 'ins1', roomId: '101@chatroom', name: '群B' },
  ])
  assert.equal(first.rooms.length, 2)
  assert.equal(first.added.length, 2)

  const second = mergeMonitorRooms(first.rooms, [
    { instanceId: 'ins1', roomId: '101@chatroom', name: '群B改名' },
    { instanceId: 'ins1', roomId: '102@chatroom', name: '新进群' },
  ])
  assert.equal(second.rooms.length, 3)
  assert.equal(second.added.length, 1)
  assert.equal(second.added[0].roomId, '102@chatroom')
  assert.equal(second.rooms.find((item) => item.roomId === '101@chatroom').name, '群B改名')
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

test('qr monitor auto-grow wiring exists in main/preload/ui', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'QrTasksPage.vue'), 'utf8')

  assert.match(main, /watchAll/)
  assert.match(main, /addQrMonitorRooms/)
  assert.match(main, /syncQrMonitorRoomsFromWechat/)
  assert.match(main, /qr:monitor-rooms-changed/)
  assert.match(main, /二维码进群成功/)
  assert.match(preload, /onQrMonitorRoomsChanged/)
  assert.match(preload, /syncQrMonitorRooms/)
  assert.match(page, /monitorWatchAll/)
  assert.match(page, /监控全部群/)
  assert.match(page, /syncMonitorRoomsNow/)
  assert.match(page, /applyMonitorRoomsToSelection/)
})
