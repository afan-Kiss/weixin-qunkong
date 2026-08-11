'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const { initStorage, upsertChatAddCandidate, database } = require('../electron/storage.cjs')
const { waitForTaskInstance, TASK_INSTANCE_WAIT_TIMEOUT_MS } = require('../electron/task-instance-wait.cjs')
const { resolveTaskItemInstance } = require('../electron/task-instance-resolve.cjs')

function tempUserData() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wxqk-mig-'))
}

function chatAddColumns(db) {
  return new Set(db.prepare('PRAGMA table_info(chat_add_candidates)').all().map((c) => c.name))
}

function hasAccountUniqueIndex(db) {
  const indexes = db.prepare("PRAGMA index_list('chat_add_candidates')").all()
  for (const idx of indexes) {
    if (!idx.unique) continue
    const cols = db.prepare(`PRAGMA index_info('${idx.name}')`).all().map((c) => c.name)
    if (cols.includes('account_wxid') && cols.includes('sender_wxid') && cols.includes('source_room_id')) {
      return true
    }
  }
  return false
}

test('fresh empty DB initStorage creates chat_add account unique index', () => {
  const dir = tempUserData()
  initStorage(dir)
  const db = database()
  const cols = chatAddColumns(db)
  for (const name of ['account_wxid', 'source_room_id', 'source_room_name', 'source_instance_port', 'sender_v3', 'received_at']) {
    assert.equal(cols.has(name), true, `missing column ${name}`)
  }
  assert.equal(hasAccountUniqueIndex(db), true)
})

test('legacy chat_add upgrade reaches same schema; second init is idempotent', () => {
  const dir = tempUserData()
  const dataDir = path.join(dir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const sqlitePath = path.join(dataDir, 'wechat-control.sqlite')
  const legacy = new DatabaseSync(sqlitePath)
  legacy.exec(`
    CREATE TABLE chat_add_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      room_id TEXT NOT NULL,
      sender_wxid TEXT NOT NULL,
      nickname TEXT,
      message_preview TEXT,
      matched_keyword TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TEXT NOT NULL,
      UNIQUE(instance_id, sender_wxid)
    );
    INSERT INTO chat_add_candidates(instance_id,room_id,sender_wxid,nickname,message_preview,matched_keyword,status,created_at)
      VALUES('AAA','R1@chatroom','U1','n','m','k','PENDING','2020-01-01T00:00:00.000Z');
  `)
  legacy.close()

  initStorage(dir)
  const db = database()
  assert.equal(hasAccountUniqueIndex(db), true)
  const cols = chatAddColumns(db)
  assert.equal(cols.has('account_wxid'), true)
  assert.equal(cols.has('source_room_id'), true)
  const count1 = db.prepare('SELECT COUNT(*) AS c FROM chat_add_candidates').get().c

  initStorage(dir)
  const db2 = database()
  assert.equal(hasAccountUniqueIndex(db2), true)
  assert.equal(db2.prepare('SELECT COUNT(*) AS c FROM chat_add_candidates').get().c, count1)
})

test('same account different instances cannot duplicate candidate; different account can', () => {
  const dir = tempUserData()
  initStorage(dir)
  const a = upsertChatAddCandidate({
    instanceId: 'AAA', accountWxid: 'wxA', senderWxid: 'U1', roomId: 'R1@chatroom',
    nickname: 'n', messagePreview: 'hi', matchedKeyword: 'k',
  })
  assert.equal(a.accepted, true)
  const b = upsertChatAddCandidate({
    instanceId: 'BBB', accountWxid: 'wxA', senderWxid: 'U1', roomId: 'R1@chatroom',
    nickname: 'n2', messagePreview: 'hi2', matchedKeyword: 'k',
  })
  assert.equal(b.accepted, true)
  assert.equal(b.id, a.id)
  assert.equal(database().prepare('SELECT COUNT(*) AS c FROM chat_add_candidates').get().c, 1)
  assert.equal(database().prepare('SELECT instance_id FROM chat_add_candidates WHERE id=?').get(a.id).instance_id, 'BBB')

  const c = upsertChatAddCandidate({
    instanceId: 'CCC', accountWxid: 'wxB', senderWxid: 'U1', roomId: 'R1@chatroom',
    nickname: 'n3', messagePreview: 'hi3', matchedKeyword: 'k',
  })
  assert.equal(c.accepted, true)
  assert.notEqual(c.id, a.id)
  assert.equal(database().prepare('SELECT COUNT(*) AS c FROM chat_add_candidates').get().c, 2)
})

test('waitForTaskInstance succeeds when instance appears; pause/cancel/ambiguous/timeout', async () => {
  const item = { id: 'i1', instance_id: 'AAA', account_wxid: 'wxA' }

  // success after delay
  const mapOk = new Map()
  let clock = 0
  const resultOk = await waitForTaskInstance(item, {
    getInstances: () => mapOk,
    getTaskStatus: () => 'QUEUED',
    isRuntimeAllowed: () => true,
    now: () => clock,
    timeoutMs: 10000,
    intervalMs: 1000,
    sleep: async (ms) => {
      clock += ms
      if (!mapOk.has('BBB')) mapOk.set('BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' })
    },
  })
  assert.equal(resultOk.ok, true)
  assert.equal(resultOk.record.id, 'BBB')

  // timeout — mutation path must not proceed
  clock = 0
  const timed = await waitForTaskInstance(item, {
    getInstances: () => new Map(),
    getTaskStatus: () => 'QUEUED',
    isRuntimeAllowed: () => true,
    now: () => clock,
    timeoutMs: 5000,
    intervalMs: 1000,
    sleep: async (ms) => { clock += ms },
  })
  assert.equal(timed.ok, false)
  assert.equal(timed.timedOut, true)
  assert.match(String(timed.reason), /5 秒/)

  // pause
  clock = 0
  let status = 'QUEUED'
  const pauseResult = await waitForTaskInstance(item, {
    getInstances: () => new Map(),
    getTaskStatus: () => status,
    isRuntimeAllowed: () => true,
    now: () => clock,
    timeoutMs: 20000,
    intervalMs: 1000,
    sleep: async (ms) => {
      clock += ms
      status = 'PAUSED'
    },
  })
  assert.equal(pauseResult.stopped, true)
  assert.equal(pauseResult.reason, 'PAUSED')

  // cancel
  clock = 0
  status = 'QUEUED'
  const cancelResult = await waitForTaskInstance(item, {
    getInstances: () => new Map(),
    getTaskStatus: () => status,
    isRuntimeAllowed: () => true,
    now: () => clock,
    timeoutMs: 20000,
    intervalMs: 1000,
    sleep: async (ms) => {
      clock += ms
      status = 'CANCELLED'
    },
  })
  assert.equal(cancelResult.stopped, true)
  assert.equal(cancelResult.reason, 'CANCELLED')

  // ambiguous — fail fast, no wait-out
  const mapAmb = new Map([
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' }],
    ['CCC', { id: 'CCC', status: 'ONLINE', accountWxid: 'wxA' }],
  ])
  const amb = await waitForTaskInstance(item, {
    getInstances: () => mapAmb,
    getTaskStatus: () => 'QUEUED',
    isRuntimeAllowed: () => true,
    now: () => 0,
    timeoutMs: 20000,
    intervalMs: 1000,
    sleep: async () => { throw new Error('should not sleep on ambiguous') },
  })
  assert.equal(amb.ok, false)
  assert.equal(amb.code, 'AMBIGUOUS_INSTANCE')
  assert.equal(amb.stopped, false)
})

test('legacy missing accountWxid never guesses another instance', () => {
  const map = new Map([['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' }]])
  const r = resolveTaskItemInstance({ instance_id: 'AAA', account_wxid: '' }, map)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'MISSING')
  assert.match(String(r.reason), /缺少账号身份/)
})

test('main awaits restore before resumeQueuedTasks; wait constants present', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /restoreInstancesThenResumeQueuedTasks/)
  assert.match(main, /function resumeQueuedTasks/)
  assert.match(main, /waitForTaskInstance/)
  assert.match(main, /TASK_INSTANCE_WAIT_TIMEOUT_MS/)
  assert.equal(TASK_INSTANCE_WAIT_TIMEOUT_MS, 120000)
  assert.doesNotMatch(main, /restoreInstances\(\)\.then\([\s\S]*?for \(const task of listTasks\(\)\.filter/)
  // login/register also use restore-then-resume
  assert.match(main, /auth:login[\s\S]*restoreInstancesThenResumeQueuedTasks/)
  assert.match(main, /auth:register[\s\S]*restoreInstancesThenResumeQueuedTasks/)
})
