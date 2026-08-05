const test = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

test('directory ownership remains separate for the same target on two WeChat accounts', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'wx-directory-ownership-'))
  const storage = require('../electron/storage.cjs')
  try {
    storage.initStorage(dataRoot)
    storage.syncDirectorySnapshot({
      contacts: [
        { wxid: 'friend-one', sourceInstanceId: 'wechat-a', nickname: '好友', isGroup: false },
        { wxid: 'friend-one', sourceInstanceId: 'wechat-b', nickname: '好友', isGroup: false },
      ],
      groups: [
        { roomId: 'room-one@chatroom', sourceInstanceId: 'wechat-a', name: '同一个群', members: 3 },
        { roomId: 'room-one@chatroom', sourceInstanceId: 'wechat-b', name: '同一个群', members: 3 },
      ],
      members: [
        { roomId: 'room-one@chatroom', sourceInstanceId: 'wechat-a', wxid: 'member-one' },
        { roomId: 'room-one@chatroom', sourceInstanceId: 'wechat-b', wxid: 'member-one' },
      ],
    })
    assert.equal(storage.database().prepare("SELECT COUNT(*) AS n FROM contacts WHERE wxid='friend-one'").get().n, 2)
    assert.equal(storage.database().prepare("SELECT COUNT(*) AS n FROM chatrooms WHERE room_id='room-one@chatroom'").get().n, 2)
    assert.equal(storage.database().prepare("SELECT COUNT(*) AS n FROM chatroom_members WHERE member_wxid='member-one'").get().n, 2)
    assert.equal(storage.hasDirectoryOwnership('wechat-a', 'friend-one', false), true)
    assert.equal(storage.hasDirectoryOwnership('wechat-b', 'room-one@chatroom', true), true)
    assert.equal(storage.hasDirectoryOwnership('wechat-c', 'friend-one', false), false)
  } finally {
    storage.database().close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('UI and task creation preserve instance ownership', () => {
  const root = path.join(__dirname, '..')
  const store = readFileSync(path.join(root, 'src', 'stores', 'wechatData.ts'), 'utf8')
  const groups = readFileSync(path.join(root, 'src', 'pages', 'GroupsMembersPage.vue'), 'utf8')
  const broadcast = readFileSync(path.join(root, 'src', 'pages', 'BroadcastPage.vue'), 'utf8')
  const main = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  assert.match(store, /ownershipKey\(instance\.id, wxid\)/)
  assert.match(store, /ownershipKey\(instance\.id, roomId\)/)
  assert.match(groups, /value: item\.id/)
  assert.match(groups, /item\.id === groupKey/)
  assert.match(broadcast, /selectedInstanceIds/)
  assert.match(broadcast, /instanceId: target\.sourceInstanceId/)
  assert.match(broadcast, /rowKey: `\$\{item\.sourceInstanceId\}::/)
  assert.doesNotMatch(broadcast, /allocationPool|accountWeights/)
  assert.match(main, /hasDirectoryOwnership\(instanceId, targetKey, isGroup\)/)
  assert.match(main, /hasDirectoryOwnership\(item\.instance_id, item\.target_key, isGroup\)/)
  assert.match(main, /该微信当前已不包含这个接收对象，任务已停止/)
  assert.match(main, /markInstanceIdentityMismatch/)
  assert.match(main, /requireIdentityVerification: true/)
  assert.match(main, /record\.requireIdentityVerification \|\| !wasOnline/)
  assert.match(main, /if \(!profileAccountWxid\) throw new Error/)
  assert.match(main, /expectedAccountWxid !== profileAccountWxid/)
})

test('partial replacement removes stale rows without touching another WeChat account', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'wx-directory-replacement-'))
  const storage = require('../electron/storage.cjs')
  try {
    storage.initStorage(dataRoot)
    storage.syncDirectorySnapshot({
      contacts: [
        { wxid: 'a-keep', sourceInstanceId: 'wechat-a', isGroup: false },
        { wxid: 'a-remove', sourceInstanceId: 'wechat-a', isGroup: false },
        { wxid: 'b-keep', sourceInstanceId: 'wechat-b', isGroup: false },
      ],
      groups: [
        { roomId: 'a-keep@chatroom', sourceInstanceId: 'wechat-a' },
        { roomId: 'a-remove@chatroom', sourceInstanceId: 'wechat-a' },
        { roomId: 'b-keep@chatroom', sourceInstanceId: 'wechat-b' },
      ],
      members: [
        { roomId: 'a-keep@chatroom', sourceInstanceId: 'wechat-a', wxid: 'a-old-member' },
        { roomId: 'a-remove@chatroom', sourceInstanceId: 'wechat-a', wxid: 'a-orphan' },
        { roomId: 'b-keep@chatroom', sourceInstanceId: 'wechat-b', wxid: 'b-member' },
      ],
    })
    storage.syncDirectorySnapshot({
      contacts: [
        { wxid: 'a-keep', sourceInstanceId: 'wechat-a', isGroup: false },
        { wxid: 'b-keep', sourceInstanceId: 'wechat-b', isGroup: false },
      ],
      groups: [
        { roomId: 'a-keep@chatroom', sourceInstanceId: 'wechat-a' },
        { roomId: 'b-keep@chatroom', sourceInstanceId: 'wechat-b' },
      ],
      members: [
        { roomId: 'a-keep@chatroom', sourceInstanceId: 'wechat-a', wxid: 'a-new-member' },
        { roomId: 'b-keep@chatroom', sourceInstanceId: 'wechat-b', wxid: 'b-member' },
      ],
      replacement: {
        contactInstanceIds: ['wechat-a'],
        groupInstanceIds: ['wechat-a'],
        memberRooms: [{ instanceId: 'wechat-a', roomId: 'a-keep@chatroom' }],
      },
    })
    assert.equal(storage.hasDirectoryOwnership('wechat-a', 'a-remove', false), false)
    assert.equal(storage.hasDirectoryOwnership('wechat-a', 'a-keep', false), true)
    assert.equal(storage.hasDirectoryOwnership('wechat-a', 'a-remove@chatroom', true), false)
    assert.equal(storage.hasDirectoryOwnership('wechat-b', 'b-keep', false), true)
    assert.equal(storage.hasDirectoryOwnership('wechat-b', 'b-keep@chatroom', true), true)
    assert.equal(storage.database().prepare("SELECT COUNT(*) AS n FROM chatroom_members WHERE source_instance_id='wechat-a' AND room_id='a-keep@chatroom' AND member_wxid='a-old-member'").get().n, 0)
    assert.equal(storage.database().prepare("SELECT COUNT(*) AS n FROM chatroom_members WHERE source_instance_id='wechat-a' AND room_id='a-keep@chatroom' AND member_wxid='a-new-member'").get().n, 1)
    assert.equal(storage.database().prepare("SELECT COUNT(*) AS n FROM chatroom_members WHERE source_instance_id='wechat-b' AND member_wxid='b-member'").get().n, 1)
  } finally {
    storage.database().close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('legacy single-owner directory tables migrate without losing rows', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'wx-directory-migration-'))
  const dataDir = path.join(dataRoot, 'data')
  require('node:fs').mkdirSync(dataDir, { recursive: true })
  const legacy = new DatabaseSync(path.join(dataDir, 'wechat-control.sqlite'))
  legacy.exec(`
    CREATE TABLE contacts (wxid TEXT PRIMARY KEY,nickname TEXT,remark TEXT,alias TEXT,avatar TEXT,is_group INTEGER NOT NULL DEFAULT 0,source_instance_id TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE chatrooms (room_id TEXT PRIMARY KEY,name TEXT,member_count INTEGER,owner_wxid TEXT,saved INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL);
    CREATE TABLE chatroom_sources (room_id TEXT NOT NULL,instance_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(room_id,instance_id));
    CREATE TABLE chatroom_members (room_id TEXT NOT NULL,member_wxid TEXT NOT NULL,nickname TEXT,avatar TEXT,inviter_wxid TEXT,member_flag INTEGER,updated_at TEXT NOT NULL,PRIMARY KEY(room_id,member_wxid));
    INSERT INTO contacts VALUES('friend-old','旧好友','','','',0,'wechat-old','2026-01-01');
    INSERT INTO chatrooms VALUES('room-old@chatroom','旧群',2,'',1,'2026-01-01');
    INSERT INTO chatroom_sources VALUES('room-old@chatroom','wechat-old','2026-01-01');
    INSERT INTO chatroom_members VALUES('room-old@chatroom','member-old','旧成员','','',0,'2026-01-01');
  `)
  legacy.close()
  const storage = require('../electron/storage.cjs')
  try {
    storage.initStorage(dataRoot)
    assert.equal(storage.hasDirectoryOwnership('wechat-old', 'friend-old', false), true)
    assert.equal(storage.hasDirectoryOwnership('wechat-old', 'room-old@chatroom', true), true)
    assert.equal(storage.database().prepare("SELECT source_instance_id AS source FROM chatroom_members WHERE member_wxid='member-old'").get().source, 'wechat-old')
  } finally {
    storage.database().close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})
