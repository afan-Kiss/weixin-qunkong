const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  isSelfKickedText,
  extractSelfKickedEvent,
  membersContainAccount,
  resolveSelfStillInMembers,
  canCleanupKickedRoom,
  preferKickEvidence,
  isImmediateKickEvidence,
  isLeaveCallbackEvidence,
  kickHitFromHistoryMessage,
} = require('../electron/kicked-group-cleanup.cjs')
const storage = require('../electron/storage.cjs')

test('detects self-kick system text from screenshot wording', () => {
  assert.equal(isSelfKickedText("你被'钟无艳'移出群聊"), true)
  assert.equal(isSelfKickedText('你已被移出群聊'), true)
  assert.equal(isSelfKickedText('无法在已退出的群聊中发送消息'), false)
  assert.equal(isSelfKickedText('张三退出了群聊'), false)
  assert.equal(isSelfKickedText("张三被'管理员'移出群聊"), false)
})

test('self leave-callback registers; other members / join ignored', () => {
  const leave = extractSelfKickedEvent({
    event_desc: '群成员退群通知',
    data: {
      roomid: 'kick1@chatroom',
      roomname: '测试群',
      memberlist: { userName: 'wxid_self', nickName: '我' },
    },
  }, 'wxid_self')
  assert.equal(leave?.roomId, 'kick1@chatroom')
  assert.equal(leave?.evidence, 'LEAVE_CALLBACK_SELF')
  assert.equal(leave?.roomName, '测试群')

  const other = extractSelfKickedEvent({
    event_desc: '群成员退群通知',
    data: {
      roomid: 'kick1@chatroom',
      memberlist: { userName: 'wxid_other', nickName: '别人' },
    },
  }, 'wxid_self')
  assert.equal(other, null)

  const join = extractSelfKickedEvent({
    event_desc: '群成员进群通知',
    data: {
      roomid: 'kick1@chatroom',
      memberlist: { userName: 'wxid_self', nickName: '我' },
    },
  }, 'wxid_self')
  assert.equal(join, null)

  const noAccount = extractSelfKickedEvent({
    event_desc: '群成员退群通知',
    data: {
      roomid: 'kick1@chatroom',
      memberlist: { userName: 'wxid_self' },
    },
  }, '')
  assert.equal(noAccount, null)

  const emptyMembers = extractSelfKickedEvent({
    event_desc: '群成员退群通知',
    data: { roomid: 'kick1@chatroom', memberlist: [] },
  }, 'wxid_self')
  assert.equal(emptyMembers, null)
})

test('system kick message requires system msg type; rejects chat replay', () => {
  const hit = extractSelfKickedEvent({
    fromUserName: { String: 'room9@chatroom' },
    real_content: "你被'管理员'移出群聊",
    msgType: 10000,
  }, 'wxid_self')
  assert.equal(hit?.roomId, 'room9@chatroom')
  assert.equal(hit?.evidence, 'SYSTEM_MSG_SELF_KICKED')

  const viaTypeField = extractSelfKickedEvent({
    fromUserName: { String: 'room9@chatroom' },
    real_content: "你被'管理员'移出群聊",
    type: 10000,
  }, 'wxid_self')
  assert.equal(viaTypeField?.evidence, 'SYSTEM_MSG_SELF_KICKED')

  // 带业务回调字段时，不能仅凭 type=10000 当成系统踢人消息
  const bizWithType = extractSelfKickedEvent({
    event_desc: '群成员进群通知',
    type: 10000,
    fromUserName: { String: 'room9@chatroom' },
    real_content: "你被'管理员'移出群聊",
  }, 'wxid_self')
  assert.equal(bizWithType, null)

  const xmlType = extractSelfKickedEvent({
    fromUserName: { String: 'room9@chatroom' },
    real_content: '你已被移出群聊',
    msgType: 10002,
  }, 'wxid_self')
  assert.equal(xmlType?.evidence, 'SYSTEM_MSG_SELF_KICKED')

  const replay = extractSelfKickedEvent({
    fromUserName: { String: 'room9@chatroom' },
    real_content: "你被'管理员'移出群聊",
    msgType: 1,
    member_info: { userName: 'wxid_joker' },
  }, 'wxid_self')
  assert.equal(replay, null)

  const noType = extractSelfKickedEvent({
    fromUserName: { String: 'room9@chatroom' },
    real_content: "你被'管理员'移出群聊",
  }, 'wxid_self')
  assert.equal(noType, null)
})

test('cleanup gate: system msg immediate; leave callback needs absent member', () => {
  assert.equal(canCleanupKickedRoom({
    instanceId: 'i1', roomId: 'a@chatroom', owned: true,
    evidence: 'SYSTEM_MSG_SELF_KICKED',
    selfStillInMembers: null, confirmCount: 0, liveRoomCount: 0,
  }).ok, true)

  // 退群回调：本人仍在群 → 禁止清理（防误退）
  assert.equal(canCleanupKickedRoom({
    instanceId: 'i1', roomId: 'a@chatroom', owned: true,
    evidence: 'LEAVE_CALLBACK_SELF',
    selfStillInMembers: true, confirmCount: 1, liveRoomCount: 10,
  }).ok, false)
  assert.equal(canCleanupKickedRoom({
    instanceId: 'i1', roomId: 'a@chatroom', owned: true,
    evidence: 'LEAVE_CALLBACK_SELF',
    selfStillInMembers: null, confirmCount: 1, liveRoomCount: 10,
  }).reason, 'MEMBER_CHECK_INCONCLUSIVE')

  // 退群回调：确认本人已不在群 → 允许
  assert.equal(canCleanupKickedRoom({
    instanceId: 'i1', roomId: 'a@chatroom', owned: false,
    evidence: 'LEAVE_CALLBACK_SELF',
    selfStillInMembers: false, confirmCount: 1, liveRoomCount: 0,
  }).ok, true)

  assert.equal(canCleanupKickedRoom({
    instanceId: 'i1', roomId: 'a@chatroom', owned: true,
    evidence: 'UNKNOWN_WEAK',
    inLiveRoomList: true, liveRoomCount: 10, selfStillInMembers: false,
    confirmCount: 2, evidenceStrength: 'strong',
  }).ok, true)
  assert.equal(canCleanupKickedRoom({
    instanceId: 'i1', roomId: 'a@chatroom', owned: true,
    evidence: 'UNKNOWN_WEAK',
    liveRoomCount: 10, selfStillInMembers: null, confirmCount: 9, evidenceStrength: 'strong',
  }).ok, false)
  assert.equal(canCleanupKickedRoom({
    instanceId: 'i1', roomId: 'not-a-room', owned: true,
    evidence: 'SYSTEM_MSG_SELF_KICKED',
  }).ok, false)

  assert.equal(isImmediateKickEvidence('SYSTEM_MSG_SELF_KICKED'), true)
  assert.equal(isImmediateKickEvidence('LEAVE_CALLBACK_SELF'), false)
  assert.equal(isLeaveCallbackEvidence('LEAVE_CALLBACK_SELF'), true)
  assert.equal(preferKickEvidence('LEAVE_CALLBACK_SELF', 'SYSTEM_MSG_SELF_KICKED'), 'SYSTEM_MSG_SELF_KICKED')
  assert.equal(preferKickEvidence('SYSTEM_MSG_SELF_KICKED', 'LEAVE_CALLBACK_SELF'), 'SYSTEM_MSG_SELF_KICKED')
})

test('membersContainAccount walks nested member payloads', () => {
  assert.equal(membersContainAccount({ memberList: [{ userName: 'wxid_a' }, { wxid: 'wxid_self' }] }, 'wxid_self'), true)
  assert.equal(membersContainAccount({ memberList: [{ userName: 'wxid_a' }] }, 'wxid_self'), false)
  assert.equal(membersContainAccount({
    memberList: [{ userName: { String: 'wxid_a' } }, { userName: { String: 'wxid_self' } }],
  }, 'wxid_self'), true)
  assert.equal(membersContainAccount({
    newChatroomData: { memberCount: 364, chatRoomMember: [] },
  }, 'wxid_self'), false)
})

test('resolveSelfStillInMembers treats empty/denied as absent only with usable payload', () => {
  assert.equal(resolveSelfStillInMembers(
    { newChatroomData: { memberCount: 0, chatRoomMember: [] } },
    'q197271614',
    { httpOk: true, strongEvidence: true },
  ), false)
  assert.equal(resolveSelfStillInMembers(null, 'q197271614', { httpOk: false, strongEvidence: true }), null)
  assert.equal(resolveSelfStillInMembers(
    { newChatroomData: { memberCount: 2, chatRoomMember: [{ userName: 'wxid_a' }, { userName: 'q197271614' }] } },
    'q197271614',
    { httpOk: true, strongEvidence: true },
  ), true)
})

test('main process quits only after safe gates', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /markChatroomBlocked/)
  assert.match(main, /\/api\/remov_chatroom_to_contact/)
  assert.match(main, /\/api\/quit_and_del_chat_room/)
  assert.match(main, /isImmediateKickEvidence/)
  assert.match(main, /isLeaveCallbackEvidence/)
  assert.match(main, /手动创建被踢群清理任务/)
  assert.match(main, /kicked-groups:cleanup/)
  assert.match(main, /discoverKickedGroupsFromHistory/)
  assert.match(main, /prepareKickedGroupCleanupTask/)
  assert.match(main, /cleanupOneKickedGroupRoom/)
  assert.match(main, /KICKED_GROUP_CLEANUP/)
  assert.match(main, /formatKickCleanupMessage/)
  assert.match(main, /resolveKickRoomLabel/)
  assert.match(main, /getKickedGroupCleanup/)
  assert.match(main, /listActiveKickedCleanupTargets/)
  assert.match(main, /SELF_STILL_MEMBER_ABORT/)
  assert.match(main, /REINVITED_SELF_STILL_MEMBER/)
  assert.match(main, /BLOCKED_MEMBER_CHECK_INCONCLUSIVE/)
  assert.match(main, /notifyDirectoryBlockedChanged/)
  assert.match(main, /dbStatus === 'DONE'/)
  assert.match(main, /dbStatus === 'CANCELLED'/)
  assert.match(main, /isContactRoomMutationOk/)
  assert.match(main, /kickedGroupCleanupPreparing/)
  assert.match(main, /fullyCleaned/)
  assert.match(main, /rebindKickedGroupPendingToInstance/)
  assert.doesNotMatch(main, /ensureKickedGroupCleanupTimer|KICKED_GROUP_CLEANUP_INTERVAL|定时巡检/)
  assert.doesNotMatch(main, /runKickedGroupCleanupSweep|kickedGroupCleanupRunning/)
  const discover = main.slice(main.indexOf('async function discoverKickedGroupsFromHistory'), main.indexOf('async function loadLiveRoomIdsForKickGate'))
  assert.match(discover, /HISTORY_TAIL\s*=\s*10/)
  assert.match(discover, /LIMIT \$\{HISTORY_TAIL\}/)
  assert.match(discover, /instanceId: record\.id/)
  assert.doesNotMatch(discover, /WHERE .+ IN \(10000,10002\).+LIMIT 40/s)
  assert.match(discover, /typeNum !== 10000 && typeNum !== 10002/)
  const cleanup = main.slice(main.indexOf('async function cleanupOneKickedGroupRoom'), main.indexOf('async function prepareKickedGroupCleanupTask'))
  assert.match(cleanup, /isImmediateKickEvidence/)
  assert.match(cleanup, /isLeaveCallbackEvidence/)
  assert.match(cleanup, /quit_and_del_chat_room/)
  assert.match(cleanup, /formatKickCleanupMessage/)
  assert.match(cleanup, /kickStatus/)
  assert.match(main, /群昵称：\$\{roomName\}｜被踢状态：/)
  assert.ok(cleanup.includes('CANCELLED'))
  assert.ok(cleanup.indexOf('fullyCleaned') < cleanup.indexOf("status: 'DONE'"))
  const prepare = main.slice(main.indexOf('async function prepareKickedGroupCleanupTask'), main.indexOf('function bindQrMonitorRoom'))
  assert.match(prepare, /rebindKickedGroupPendingToInstance/)
  assert.match(prepare, /discoverKickedGroupsFromHistory/)
  assert.match(prepare, /createLocalTask/)
  assert.match(prepare, /KICKED_GROUP_CLEANUP/)
  assert.match(prepare, /activeKeys/)
  assert.match(prepare, /\$\{record\.id\}::\$\{roomId\}/)
  const runTask = main.slice(main.indexOf('async function runTask'), main.indexOf('function createLocalTask'))
  assert.match(runTask, /action_type === 'KICKED_GROUP_CLEANUP'/)
  assert.match(runTask, /cleanupOneKickedGroupRoom/)
  assert.match(runTask, /getKickedGroupCleanup/)
  assert.match(runTask, /formatKickCleanupMessage/)
  // 证据常量定义在判定模块，主进程通过 helper 引用，避免硬编码散落
  const logic = fs.readFileSync(path.join(__dirname, '..', 'electron', 'kicked-group-cleanup.cjs'), 'utf8')
  assert.match(logic, /SYSTEM_MSG_SELF_KICKED/)
  assert.match(logic, /LEAVE_CALLBACK_SELF/)
  assert.match(logic, /kickHitFromHistoryMessage/)
  assert.match(logic, /typeNum !== 10000 && typeNum !== 10002/)
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'stores', 'wechatData.ts'), 'utf8')
  assert.match(page, /listBlockedRoomIds/)
  assert.match(page, /applyBlockedRoomRemoved/)
  const settings = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'SettingsLogsPage.vue'), 'utf8')
  assert.match(settings, /cleanupKickedGroups/)
  assert.match(settings, /创建清理任务/)
  assert.match(settings, /promptGoToTaskCenter/)
  assert.match(settings, /最近 10 条/)
  assert.match(settings, /系统通知/)
  const status = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'status.ts'), 'utf8')
  assert.match(status, /KICKED_GROUP_CLEANUP:\s*'清理被踢群'/)
  const tasksPage = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'TasksPage.vue'), 'utf8')
  assert.match(tasksPage, /被踢群/)
  assert.match(tasksPage, /KICKED_GROUP_CLEANUP/)
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  assert.match(preload, /cleanupKickedGroups/)
})

test('history message rows detect self-kick and ignore others', () => {
  const hit = kickHitFromHistoryMessage('room9@chatroom', "你被'管理员'移出群聊", 10000)
  assert.equal(hit?.roomId, 'room9@chatroom')
  assert.equal(hit?.evidence, 'SYSTEM_MSG_SELF_KICKED')
  assert.equal(kickHitFromHistoryMessage('room9@chatroom', '张三退出了群聊', 10000), null)
  assert.equal(kickHitFromHistoryMessage('not-a-room', '你已被移出群聊', 10000), null)
  // 普通用户发言类型即使文案相同也忽略
  assert.equal(kickHitFromHistoryMessage('room9@chatroom', "你被'管理员'移出群聊", 1), null)
  assert.equal(kickHitFromHistoryMessage('room9@chatroom', '你已被移出群聊', undefined), null)
  const xml = kickHitFromHistoryMessage(
    'xml@chatroom',
    '<sysmsg type="delchatroommember"><text><![CDATA[你被\'管理\'移出群聊]]></text></sysmsg>',
    10002,
  )
  assert.equal(xml?.evidence, 'SYSTEM_MSG_SELF_KICKED')
})

test('xml system kick content is stripped before matching', () => {
  const hit = extractSelfKickedEvent({
    fromUserName: { String: 'xmlroom@chatroom' },
    msgType: 10002,
    real_content: '<sysmsg type="delchatroommember"><text><![CDATA[你被\'管理\'移出群聊]]></text></sysmsg>',
  }, 'wxid_self')
  assert.equal(hit?.roomId, 'xmlroom@chatroom')
  assert.equal(hit?.evidence, 'SYSTEM_MSG_SELF_KICKED')
})

test('system msg evidence allows cleanup without account wxid', () => {
  assert.equal(canCleanupKickedRoom({
    instanceId: 'i1', roomId: 'a@chatroom', owned: false,
    evidence: 'SYSTEM_MSG_SELF_KICKED',
  }).ok, true)
})

test('upsert prefers system kick evidence and can revive CANCELLED', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-kick-upsert-'))
  storage.initStorage(folder)
  storage.upsertKickedGroupPending({
    instanceId: 'inst-1',
    roomId: 'room1@chatroom',
    accountWxid: 'wxid_self',
    evidence: 'LEAVE_CALLBACK_SELF',
  })
  storage.updateKickedGroupCleanup('inst-1', 'room1@chatroom', {
    status: 'CANCELLED',
    lastError: 'SELF_STILL_MEMBER_ABORT',
  })
  storage.upsertKickedGroupPending({
    instanceId: 'inst-1',
    roomId: 'room1@chatroom',
    accountWxid: 'wxid_self',
    evidence: 'SYSTEM_MSG_SELF_KICKED',
  })
  const rows = storage.listKickedGroupPending({ instanceId: 'inst-1', status: 'PENDING' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].evidence, 'SYSTEM_MSG_SELF_KICKED')

  // 系统证据在库后，弱退群回调不得降级
  storage.upsertKickedGroupPending({
    instanceId: 'inst-1',
    roomId: 'room1@chatroom',
    accountWxid: 'wxid_self',
    evidence: 'LEAVE_CALLBACK_SELF',
  })
  const again = storage.listKickedGroupPending({ instanceId: 'inst-1', status: 'PENDING' })
  assert.equal(again[0].evidence, 'SYSTEM_MSG_SELF_KICKED')
})

test('rebind moves PENDING kicked cleanup to new instance after restart', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-kick-rebind-'))
  storage.initStorage(folder)
  storage.upsertInstance({
    id: 'old-inst', apiPort: 19088, tcpPort: 61108, pid: 1,
    accountWxid: 'wxid_self', status: 'STOPPED', managed: true,
  })
  storage.upsertKickedGroupPending({
    instanceId: 'old-inst',
    roomId: 'kick-me@chatroom',
    accountWxid: 'wxid_self',
    roomName: '被踢群',
    evidence: 'SYSTEM_MSG_SELF_KICKED',
  })
  storage.updateKickedGroupCleanup('old-inst', 'kick-me@chatroom', {
    confirmCount: 2,
    unsaveStatus: 'FAILED',
    deleteChatStatus: 'PENDING',
  })
  // 模拟重启后新实例 id
  storage.upsertInstance({
    id: 'new-inst', apiPort: 19089, tcpPort: 61109, pid: 2,
    accountWxid: 'wxid_self', status: 'ONLINE', managed: true,
  })
  const moved = storage.rebindKickedGroupPendingToInstance('new-inst', 'wxid_self')
  assert.equal(moved, 1)
  assert.equal(storage.listKickedGroupPending({ instanceId: 'old-inst', status: 'PENDING' }).length, 0)
  const rows = storage.listKickedGroupPending({ instanceId: 'new-inst', status: 'PENDING' })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].roomId, 'kick-me@chatroom')
  assert.equal(rows[0].confirmCount, 2)
  assert.equal(rows[0].unsaveStatus, 'FAILED')
  assert.equal(rows[0].evidence, 'SYSTEM_MSG_SELF_KICKED')
})

test('blocked chatrooms persist by account and exclude ownership/sync', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'wx-blocked-'))
  storage.initStorage(folder)
  storage.upsertInstance({ id: 'inst-1', apiPort: 19088, tcpPort: 61108, pid: 1, accountWxid: 'wxid_self', status: 'ONLINE', managed: true })
  storage.syncDirectorySnapshot({
    contacts: [{ wxid: 'gone@chatroom', sourceInstanceId: 'inst-1', nickname: '被踢群', isGroup: true }],
    groups: [
      { roomId: 'gone@chatroom', sourceInstanceId: 'inst-1', name: '被踢群', members: 10, saved: true },
      { roomId: 'keep@chatroom', sourceInstanceId: 'inst-1', name: '正常群', members: 3, saved: false },
    ],
    members: [],
    replacement: { contactInstanceIds: ['inst-1'], groupInstanceIds: ['inst-1'] },
  })
  assert.equal(storage.hasDirectoryOwnership('inst-1', 'gone@chatroom', true), true)
  storage.markChatroomBlocked({
    accountWxid: 'wxid_self',
    roomId: 'gone@chatroom',
    roomName: '被踢群',
    reason: 'KICKED',
    evidence: 'SYSTEM_MSG_SELF_KICKED',
    sourceInstanceId: 'inst-1',
  })
  assert.equal(storage.isChatroomBlocked('wxid_self', 'gone@chatroom'), true)
  assert.equal(storage.hasDirectoryOwnership('inst-1', 'gone@chatroom', true), false)
  assert.equal(storage.hasDirectoryOwnership('inst-1', 'keep@chatroom', true), true)
})
