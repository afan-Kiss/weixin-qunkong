const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const storage = require('../electron/storage.cjs')

test('high priority sync logs prefer friend-add over QR noise', () => {
  assert.equal(storage.isHighPrioritySyncLog({
    level: 'INFO',
    module: '群聊加好友',
    message: '加好友失败：安全风险',
    detailsJson: JSON.stringify({ operation: 'ADD_FRIEND_RESULT', businessCode: -24 }),
  }), true)
  assert.equal(storage.isHighPrioritySyncLog({
    level: 'ERROR',
    module: '任务',
    message: '接口失败',
    detailsJson: '{}',
  }), true)
  assert.equal(storage.isHighPrioritySyncLog({
    level: 'INFO',
    module: '被踢群清理',
    message: '已登记被踢群，立即取消通讯录并退出残留会话',
    detailsJson: JSON.stringify({ operation: '登记', evidence: 'LEAVE_CALLBACK_SELF' }),
  }), true)
  assert.equal(storage.isNoisySyncLog({
    module: '二维码监控',
    message: '群图片监控：命中监控群，排队下载识别',
  }), true)
  assert.equal(storage.isNoisySyncLog({
    module: '群聊加好友',
    message: '已记录群聊发言加好友候选',
  }), false)
})

test('selectLogsForRemoteSync keeps friend-add logs when QR spam floods recent window', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-sync-logs-'))
  storage.initStorage(folder)

  // Older but important friend-add failure
  storage.saveLog({
    time: '2026-08-04T06:30:10.000Z',
    level: 'ERROR',
    instanceId: 'inst-1',
    module: '群聊加好友',
    message: '加好友失败：对方账号无法添加',
    operation: 'ADD_FRIEND_RESULT',
    businessCode: -24,
    targetWxid: 'wxid_target',
    result: 'FAILED',
  })

  // Flood with recent QR noise
  for (let i = 0; i < 250; i += 1) {
    storage.saveLog({
      time: `2026-08-04T06:32:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z`,
      level: 'INFO',
      instanceId: 'inst-1',
      module: '二维码监控',
      message: '群图片监控：命中监控群，排队下载识别',
      roomId: `${1000 + i}@chatroom`,
    })
  }

  const selected = storage.selectLogsForRemoteSync({ total: 200, priorityMax: 100, scanLimit: 5000 })
  assert.ok(selected.some((row) => String(row.message).includes('加好友失败')))
  assert.ok(selected.filter((row) => storage.isHighPrioritySyncLog(row)).length >= 1)

  const snap = storage.remoteSyncSnapshot()
  assert.ok(Array.isArray(snap.logs))
  assert.ok(snap.logs.some((row) => String(row.message).includes('加好友失败')))
  assert.ok(Array.isArray(snap.taskItems))
})

test('remote sync includes finished task item errors', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-sync-tasks-'))
  storage.initStorage(folder)
  storage.upsertInstance({ id: 'inst-a', apiPort: 19088, tcpPort: 61108, pid: 1, accountWxid: 'wxid_a', nickname: 'A', status: 'ONLINE', managed: true })
  storage.createTask(
    { id: 'task-fail', name: '群聊发言加好友 x', type: 'ADD_FRIEND', status: 'WAITING_CONFIRMATION', config: {} },
    [{ id: 'item-fail', instanceId: 'inst-a', targetKey: 'wxid_b', actionType: 'ADD_FRIEND', status: 'QUEUED', request: {} }],
  )
  storage.setTaskItemResult('item-fail', 'FAILED', { baseResponse: { ret: -24 } }, '当前账号存在安全风险')
  const items = storage.listTaskItemDiagnostics(10)
  assert.equal(items[0].error, '当前账号存在安全风险')
  assert.equal(items[0].status, 'FAILED')
  const snap = storage.remoteSyncSnapshot()
  assert.ok(snap.taskItems.some((row) => row.error.includes('安全风险') && row.targetKey === 'wxid_b'))
})
