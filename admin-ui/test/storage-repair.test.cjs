const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const storage = require('../electron/storage.cjs')

test('repairs a text message that WeChat confirmed as successful', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'wx-task-repair-'))
  try {
    storage.initStorage(root)
    storage.createTask(
      { id: 'task-1', name: '发送消息', type: 'SEND_TEXT_TO_FRIEND', status: 'RUNNING', config: {} },
      [{ id: 'item-1', instanceId: 'wechat-1', targetKey: 'friend-1', actionType: 'SEND_TEXT', status: 'QUEUED', request: { msg: '测试' } }],
    )
    storage.setTaskItemStarted('item-1')
    storage.setTaskItemResult('item-1', 'FAILED', { account_wxid: 'wxid_test', data: {}, errCode: 1, errMsg: '请求处理成功' }, '发送结果无法确认')
    storage.setTaskStatus('task-1', 'PARTIAL_FAILED')

    assert.equal(storage.repairConfirmedSendTextResults(), 1)
    assert.equal(storage.getTaskItems('task-1')[0].status, 'COMPLETED')
    const task = storage.listTasks()[0]
    assert.equal(task.status, 'COMPLETED')
    assert.equal(task.success, 1)
    assert.equal(task.failed, 0)
  } finally {
    storage.database().close()
    rmSync(root, { recursive: true, force: true })
  }
})
