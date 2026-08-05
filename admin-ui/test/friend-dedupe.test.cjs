const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const storage = require('../electron/storage.cjs')

test('friend targets can be recreated for the same account after previous tasks', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-friend-dedupe-'))
  storage.initStorage(folder)
  storage.upsertInstance({ id: 'instance-a', apiPort: 19088, tcpPort: 61108, pid: 1, accountWxid: 'wxid_same', status: 'ONLINE', managed: true })
  storage.upsertInstance({ id: 'instance-b', apiPort: 19090, tcpPort: 61110, pid: 2, accountWxid: 'wxid_same', status: 'ONLINE', managed: true })
  const item = (id, instanceId, targetKey) => ({ id, instanceId, targetKey, actionType: 'ADD_FRIEND', status: 'QUEUED', request: {} })
  const task = (id) => ({ id, name: id, type: 'ADD_FRIEND', status: 'WAITING_CONFIRMATION', config: {} })

  assert.deepEqual(storage.createTask(task('task-1'), [item('item-1', 'instance-a', 'member-one')]), { inserted: 1, duplicates: 0 })
  // 不互斥：同一微信号、同一成员可再次创建任务
  assert.deepEqual(storage.createTask(task('task-2'), [item('item-2', 'instance-b', 'member-one')]), { inserted: 1, duplicates: 0 })
  assert.deepEqual(storage.createTask(task('task-3'), [item('item-3', 'instance-b', 'member-two')]), { inserted: 1, duplicates: 0 })
  assert.equal(storage.listTasks().some((row) => row.id === 'task-2'), true)
  assert.equal(storage.listTasks().find((row) => row.id === 'task-3').total, 1)

  storage.cancelTask('task-1')
  assert.deepEqual(storage.createTask(task('task-4'), [item('item-4', 'instance-a', 'member-one')]), { inserted: 1, duplicates: 0 })
})

test('friend daily limit is reserved by account wxid regardless of instance and result', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-friend-limit-'))
  storage.initStorage(folder)
  assert.deepEqual(storage.reserveFriendDailyAttempt('wxid_account', 'attempt-1', 'member-1', 2), { accepted: true, count: 1 })
  assert.deepEqual(storage.reserveFriendDailyAttempt('wxid_account', 'attempt-2', 'member-2', 2), { accepted: true, count: 2 })
  assert.deepEqual(storage.reserveFriendDailyAttempt('wxid_account', 'attempt-3', 'member-3', 2), { accepted: false, reason: 'LIMIT_REACHED', count: 2 })
  assert.deepEqual(storage.reserveFriendDailyAttempt('', 'attempt-4', 'member-4', 2), { accepted: false, reason: 'ACCOUNT_REQUIRED', count: 0 })
})

test('instance alias is persisted and preferred in task account summary', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-instance-alias-'))
  storage.initStorage(folder)
  storage.upsertInstance({
    id: 'instance-alias',
    apiPort: 19088,
    tcpPort: 61108,
    pid: 1,
    accountWxid: 'wxid_internal',
    nickname: '测试昵称',
    alias: 'myWeChatId',
    status: 'ONLINE',
    managed: true,
  })
  const stored = storage.listStoredInstances().find((row) => row.id === 'instance-alias')
  assert.equal(stored.alias, 'myWeChatId')
  assert.equal(stored.accountWxid, 'wxid_internal')

  storage.createTask(
    { id: 'task-alias', name: 'alias', type: 'ADD_FRIEND', status: 'WAITING_CONFIRMATION', config: {} },
    [{ id: 'item-alias', instanceId: 'instance-alias', targetKey: 'member-x', actionType: 'ADD_FRIEND', status: 'QUEUED', request: {} }],
  )
  const summary = storage.listTasks().find((row) => row.id === 'task-alias')?.accountSummary || ''
  assert.match(summary, /测试昵称（myWeChatId）/)
  assert.doesNotMatch(summary, /wxid_internal/)
})
