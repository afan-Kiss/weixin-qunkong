const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { isMemberJoinEvent, extractMemberJoin, extractMemberJoins, diffNewMembers } = require('../electron/member-join.cjs')
const storage = require('../electron/storage.cjs')

test('detects member join callback and rejects leave/nickname events', () => {
  assert.equal(isMemberJoinEvent({
    event_type: 1010,
    event_desc: '群成员进群通知',
    data: {
      createtime: 1761110902,
      roomid: '49767299448@chatroom',
      memberlist: { userName: 'wxid_new', nickName: '新人', inviterUserName: 'wxid_host', addChatRoomSceneNewXml: '邀请进群' },
    },
  }), true)
  assert.equal(isMemberJoinEvent({ event_type: 1012, event_desc: '群员昵称修改通知', data: { roomid: '1@chatroom', memberlist: { userName: 'wxid_a' } } }), false)
  assert.equal(isMemberJoinEvent({ event_desc: '群成员退群通知', data: { roomid: '1@chatroom', memberlist: { userName: 'wxid_a', addChatRoomSceneNewXml: '群成员场景XML' } } }), false)
  // 退群回调结构相似且带 scene 字段，但不能仅凭字段存在判为进群
  assert.equal(isMemberJoinEvent({
    data: {
      createtime: 1761110902,
      roomid: '1@chatroom',
      memberlist: { userName: 'wxid_leave', addChatRoomSceneNewXml: '群成员场景XML' },
    },
  }), false)
})

test('extracts join time and multiple members from callback', () => {
  const row = extractMemberJoin({
    event_desc: '有人进群',
    data: {
      createtime: 1761110902,
      roomid: '49767299448@chatroom',
      memberlist: { userName: 'wxid_new', nickName: '新人', bigHeadImgUrl: 'http://a', inviterUserName: 'wxid_host' },
    },
  })
  assert.equal(row.roomId, '49767299448@chatroom')
  assert.equal(row.memberWxid, 'wxid_new')
  assert.equal(row.nickname, '新人')
  assert.equal(row.joinAt, new Date(1761110902 * 1000).toISOString())

  const rows = extractMemberJoins({
    event_desc: '多人进群',
    data: {
      createtime: 1761110902,
      roomid: '49767299448@chatroom',
      memberlist: [
        { userName: 'wxid_a', nickName: 'A' },
        { userName: 'wxid_b', nickName: 'B' },
        { userName: 'wxid_a', nickName: 'A-dup' },
      ],
    },
  })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((item) => item.memberWxid), ['wxid_a', 'wxid_b'])
})

test('snapshot diff ignores first baseline and only returns newly appeared members', () => {
  assert.deepEqual(diffNewMembers([], [{ wxid: 'a' }, { wxid: 'b' }]), [])
  assert.deepEqual(diffNewMembers(['a'], [{ wxid: 'a' }, { wxid: 'b', nickname: 'B' }]), [{ wxid: 'b', nickname: 'B', avatar: '', inviter: '' }])
})

test('saveEvent and snapshot sync persist latest join members with frequent-ready statuses query', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-member-join-'))
  storage.initStorage(folder)
  storage.upsertInstance({ id: 'inst-1', apiPort: 19088, tcpPort: 61108, pid: 1, accountWxid: 'wxid_self', status: 'ONLINE', managed: true })

  const saved = storage.saveEvent('inst-1', {
    event_desc: '群成员进群通知',
    data: {
      createtime: 1761110902,
      roomid: 'room1@chatroom',
      memberlist: [
        { userName: 'wxid_join', nickName: '新进', inviterUserName: 'wxid_host' },
        { userName: 'wxid_join2', nickName: '新进2' },
      ],
    },
  })
  assert.equal(saved.joinRecorded, true)
  assert.equal(saved.joinCount, 2)
  assert.equal(storage.listMemberJoins({ instanceIds: ['inst-1'] }).length, 2)

  storage.syncDirectorySnapshot({
    contacts: [],
    groups: [{ roomId: 'room1@chatroom', name: '测试群', members: 1, owner: 'wxid_self', saved: true, sourceInstanceId: 'inst-1' }],
    members: [{ wxid: 'wxid_old', nickname: '老人', avatar: '', inviter: '', flag: 0, roomId: 'room1@chatroom', sourceInstanceId: 'inst-1' }],
    replacement: { memberRooms: [{ instanceId: 'inst-1', roomId: 'room1@chatroom' }], groupInstanceIds: ['inst-1'] },
  })
  assert.equal(storage.listMemberJoins({ roomIds: ['room1@chatroom'] }).some((row) => row.wxid === 'wxid_old'), false)

  storage.syncDirectorySnapshot({
    contacts: [],
    groups: [{ roomId: 'room1@chatroom', name: '测试群', members: 2, owner: 'wxid_self', saved: true, sourceInstanceId: 'inst-1' }],
    members: [
      { wxid: 'wxid_old', nickname: '老人', avatar: '', inviter: '', flag: 0, roomId: 'room1@chatroom', sourceInstanceId: 'inst-1' },
      { wxid: 'wxid_snap', nickname: '快照新人', avatar: '', inviter: '', flag: 0, roomId: 'room1@chatroom', sourceInstanceId: 'inst-1' },
    ],
    replacement: { memberRooms: [{ instanceId: 'inst-1', roomId: 'room1@chatroom' }] },
  })
  const joins = storage.listMemberJoins({ roomIds: ['room1@chatroom'] })
  assert.equal(joins.some((row) => row.wxid === 'wxid_snap' && row.source === 'snapshot'), true)

  const task = storage.createTask(
    { id: 'task-join', name: '最新入群', type: 'ADD_FRIEND', status: 'COOLING_DOWN', config: {} },
    [{ id: 'item-join', instanceId: 'inst-1', targetKey: 'wxid_join', actionType: 'ADD_FRIEND', status: 'SUBMITTED', request: {} }],
  )
  assert.equal(task.inserted, 1)
  storage.setTaskItemResult('item-join', 'SUBMITTED', { msg: '操作频繁，请稍后再试' }, '检测到明确频繁状态')
  const statuses = storage.listFriendAddStatuses([{ instanceId: 'inst-1', targetKey: 'wxid_join' }])
  assert.equal(statuses['inst-1\u0000wxid_join'].taskStatus, 'COOLING_DOWN')
  assert.match(statuses['inst-1\u0000wxid_join'].error, /频繁/)
})

test('groups page uses joinRows as latest-member source and avoids frequent double count', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'GroupsMembersPage.vue'), 'utf8')
  assert.match(page, /function friendStatusKey/)
  assert.match(page, /friendStatusKey\(row\.instanceId, row\.wxid\)/)
  assert.match(page, /instanceId: item\.sourceInstanceId, targetKey: item\.wxid/)
  assert.match(page, /if \(onlyLatestJoins\.value\)/)
  assert.match(page, /joinRows\.value\.map/)
  assert.match(page, /function hasFrequentMark/)
  assert.match(page, /!hasFrequentMark\(item\.error, item\.status\)/)
  assert.match(page, /已经频繁/)
  assert.match(page, /mergedGroups/)
  assert.match(page, /请先勾选要添加的最新入群成员/)
  // 冷却中的排队项不得计入「已经频繁」
  assert.doesNotMatch(page, /COOLING_DOWN' \? '已经频繁'/)
  assert.doesNotMatch(page, /task\.status === 'COOLING_DOWN' && \['QUEUED', 'RUNNING'\]/)
})
