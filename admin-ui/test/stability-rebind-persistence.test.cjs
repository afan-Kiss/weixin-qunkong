'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { resolveTaskItemInstance } = require('../electron/task-instance-resolve.cjs')
const { resolveIpcApiTimeout } = require('../electron/ipc-api-timeout.cjs')
const { buildHistoryImagePageSql } = require('../electron/qr-history-pagination.cjs')
const {
  migrateTaskItemsUnique,
  migrateWechatInstancesPortUnique,
  migrateDirectorySnapshotOwnership,
  rebindPendingChatAddCandidates,
} = require('../electron/storage-schema-migrations.cjs')
const { rebindMonitorRoomsForAccount, mergeMonitorRooms, monitorRoomKey } = require('../electron/qr-monitor-rooms.cjs')

function openTempDb() {
  const { DatabaseSync } = require('node:sqlite')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-stab-'))
  const db = new DatabaseSync(path.join(dir, 't.sqlite'))
  db.exec('PRAGMA foreign_keys=ON;')
  return { db, dir }
}

test('task_items UNIQUE includes instance_id; A/B same room both insert', () => {
  const { db } = openTempDb()
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, name TEXT, type TEXT, status TEXT, config_json TEXT, total INTEGER, success INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, skipped INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT);
    CREATE TABLE task_items (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, instance_id TEXT NOT NULL, target_key TEXT NOT NULL, action_type TEXT NOT NULL, status TEXT NOT NULL, request_json TEXT, response_json TEXT, error TEXT, started_at TEXT, finished_at TEXT, UNIQUE(task_id, target_key, action_type), FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE);
    CREATE TABLE wechat_instances (id TEXT PRIMARY KEY, api_port INTEGER UNIQUE NOT NULL, tcp_port INTEGER UNIQUE NOT NULL, pid INTEGER, account_wxid TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `)
  migrateWechatInstancesPortUnique(db)
  migrateTaskItemsUnique(db)
  db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('T1', 't', 'SEND_TEXT_TO_GROUP', 'QUEUED', '{}', 0, 0, 0, 0, 'now', 'now')
  const insert = db.prepare('INSERT INTO task_items(id,task_id,instance_id,account_wxid,target_key,action_type,status) VALUES(?,?,?,?,?,?,?)')
  insert.run('i1', 'T1', 'A', 'wxA', 'roomX@chatroom', 'SEND_TEXT', 'QUEUED')
  insert.run('i2', 'T1', 'B', 'wxB', 'roomX@chatroom', 'SEND_TEXT', 'QUEUED')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM task_items WHERE task_id=?').get('T1').c, 2)
  assert.throws(() => insert.run('i3', 'T1', 'A', 'wxA', 'roomX@chatroom', 'SEND_TEXT', 'QUEUED'))
})

test('resolveTaskItemInstance rebind / cross-account / ambiguous', () => {
  const map = new Map([
    ['AAA', { id: 'AAA', status: 'STOPPED', accountWxid: 'wxA' }],
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' }],
  ])
  const ok = resolveTaskItemInstance({ instance_id: 'AAA', account_wxid: 'wxA' }, map)
  assert.equal(ok.ok, true)
  assert.equal(ok.record.id, 'BBB')
  assert.equal(ok.rebound, true)

  const cross = resolveTaskItemInstance({ instance_id: 'AAA', account_wxid: 'wxA' }, new Map([
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxB' }],
  ]))
  assert.equal(cross.ok, false)

  const amb = resolveTaskItemInstance({ instance_id: 'AAA', account_wxid: 'wxA' }, new Map([
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' }],
    ['CCC', { id: 'CCC', status: 'ONLINE', accountWxid: 'wxA' }],
  ]))
  assert.equal(amb.code, 'AMBIGUOUS_INSTANCE')
})

test('wechat_instances port reuse keeps old metadata', () => {
  const { db } = openTempDb()
  db.exec(`CREATE TABLE wechat_instances (id TEXT PRIMARY KEY, api_port INTEGER UNIQUE NOT NULL, tcp_port INTEGER UNIQUE NOT NULL, pid INTEGER, account_wxid TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`)
  db.prepare('INSERT INTO wechat_instances VALUES(?,?,?,?,?,?,?,?)').run('AAA', 19088, 61108, null, 'wxA', 'STOPPED', 't', 't')
  migrateWechatInstancesPortUnique(db)
  db.prepare('INSERT INTO wechat_instances(id,api_port,tcp_port,pid,account_wxid,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('BBB', 19088, 61108, null, 'wxA', 'ONLINE', 't', 't')
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM wechat_instances').get().c, 2)
  assert.ok(db.prepare('SELECT id FROM wechat_instances WHERE id=?').get('AAA'))
})

test('directory snapshot migrate AAA→BBB no fake new members', () => {
  const { db } = openTempDb()
  db.exec(`
    CREATE TABLE contacts (wxid TEXT NOT NULL, source_instance_id TEXT NOT NULL, nickname TEXT, remark TEXT, alias TEXT, avatar TEXT, is_group INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(wxid,source_instance_id));
    CREATE TABLE chatrooms (room_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, name TEXT, member_count INTEGER, owner_wxid TEXT, saved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(room_id,source_instance_id));
    CREATE TABLE chatroom_sources (room_id TEXT NOT NULL, instance_id TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(room_id, instance_id));
    CREATE TABLE chatroom_members (room_id TEXT NOT NULL, source_instance_id TEXT NOT NULL, member_wxid TEXT NOT NULL, nickname TEXT, avatar TEXT, inviter_wxid TEXT, member_flag INTEGER, updated_at TEXT NOT NULL, PRIMARY KEY(room_id,source_instance_id,member_wxid));
  `)
  const now = new Date().toISOString()
  db.prepare('INSERT INTO chatrooms VALUES(?,?,?,?,?,?,?)').run('room1@chatroom', 'AAA', 'g', 3, '', 0, now)
  for (const u of ['U1', 'U2', 'U3']) {
    db.prepare('INSERT INTO chatroom_members VALUES(?,?,?,?,?,?,?,?)').run('room1@chatroom', 'AAA', u, u, '', '', 0, now)
  }
  migrateDirectorySnapshotOwnership(db, 'AAA', 'BBB')
  const members = db.prepare('SELECT member_wxid FROM chatroom_members WHERE source_instance_id=?').all('BBB').map((r) => r.member_wxid).sort()
  assert.deepEqual(members, ['U1', 'U2', 'U3'])
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM chatroom_members WHERE source_instance_id=?').get('AAA').c, 0)
  // simulate sync diff: previous BBB members vs new with U4
  const { diffNewMembers } = require('../electron/member-join.cjs')
  const prev = members
  const next = [...members, 'U4'].map((wxid) => ({ wxid }))
  const added = diffNewMembers(prev, next)
  assert.deepEqual(added.map((x) => x.wxid), ['U4'])
})

test('ipc timeout caps get_all_room_detail at 90000 and others 30000', () => {
  assert.equal(resolveIpcApiTimeout('/api/get_all_room_detail', 90000), 90000)
  assert.equal(resolveIpcApiTimeout('/api/get_contact_list2', 90000), 30000)
  assert.equal(resolveIpcApiTimeout('/api/get_all_room_detail', 500), 500)
})

test('history image page size bounded', () => {
  const page = buildHistoryImagePageSql({ table: 'Msg_x', typeColumn: 'type', orderColumn: 'local_id', pageSize: 300, afterLocalId: 999 })
  assert.match(page.sql, /LIMIT 300/)
  assert.match(page.sql, /local_id" < 999/)
  assert.ok(page.limit <= 300)
})

test('QR monitor rebind dedupes pairs', () => {
  const rooms = [
    { instanceId: 'AAA', accountWxid: 'wxA', roomId: 'room1@chatroom', name: 'g' },
    { instanceId: 'BBB', accountWxid: 'wxA', roomId: 'room1@chatroom', name: 'g' },
  ]
  const instances = new Map([
    ['AAA', { status: 'STOPPED', accountWxid: 'wxA' }],
    ['BBB', { id: 'BBB', status: 'ONLINE', accountWxid: 'wxA' }],
  ])
  const rebound = rebindMonitorRoomsForAccount(rooms.filter((r) => r.instanceId === 'AAA'), { id: 'BBB', accountWxid: 'wxA' }, instances)
  const merged = mergeMonitorRooms(rebound.rooms, [
    { instanceId: 'BBB', accountWxid: 'wxA', roomId: 'room1@chatroom', name: 'g' },
  ])
  assert.equal(merged.rooms.length, 1)
  assert.equal(merged.rooms[0].instanceId, 'BBB')
})

test('chat add candidates rebind PENDING to new instance', () => {
  const { db } = openTempDb()
  db.exec(`
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
      source_room_id TEXT NOT NULL,
      source_room_name TEXT,
      source_instance_port INTEGER,
      account_wxid TEXT,
      sender_v3 TEXT,
      received_at TEXT NOT NULL
    );
  `)
  db.prepare(`INSERT INTO chat_add_candidates(instance_id,room_id,sender_wxid,status,created_at,source_room_id,account_wxid,received_at)
    VALUES('AAA','r@chatroom','s1','PENDING','t','r@chatroom','wxA','t')`).run()
  const n = rebindPendingChatAddCandidates(db, 'wxA', 'BBB', ['BBB'])
  assert.equal(n, 1)
  assert.equal(db.prepare('SELECT instance_id FROM chat_add_candidates').get().instance_id, 'BBB')
})

test('UNSAFE_RESUME counted as failed in summarize SQL shape', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'storage.cjs'), 'utf8')
  assert.match(main, /UNSAFE_RESUME.*failed|failed.*UNSAFE_RESUME/)
})

test('SEND mutation gate and no send autoRetry in main', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /resolveTaskItemInstance/)
  assert.match(main, /isSend\) && blockMutationForTaskStop/)
  assert.match(main, /retryCount = item\.action_type === 'ADD_FRIEND' \? 1 : 0/)
  assert.match(main, /safeBroadcast/)
  assert.match(main, /buildHistoryImagePageSql/)
  assert.match(main, /pruneClipboardImageCache/)
  assert.match(main, /pageSize = 300/)
})

test('remote agent urgent chain not blocked by long tasks', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'electron', 'remote-agent.cjs'), 'utf8')
  assert.match(src, /agentControlChain/)
  assert.match(src, /agentLongTaskChain/)
  assert.match(src, /isLongAgentCommand/)
  assert.match(src, /appliedCommandIds/)
})
