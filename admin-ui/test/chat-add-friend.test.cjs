const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  parseGroupTextMessage,
  matchKeywords,
  isExcluded,
  matchChatAddRule,
  splitRules,
} = require('../electron/chat-add-friend.cjs')

function sampleEvent(overrides = {}) {
  return {
    msgType: 1,
    fromUserName: { String: '123@chatroom' },
    content: { String: 'wxid_abc:\n你好合作一下' },
    real_content: '你好合作一下',
    sender_nick: '张三',
    member_info: { userName: 'wxid_abc', nickName: '张三' },
    newMsgId: '10001',
    ...overrides,
  }
}

test('parses group text message and skips self', () => {
  const parsed = parseGroupTextMessage(sampleEvent())
  assert.equal(parsed.roomId, '123@chatroom')
  assert.equal(parsed.senderWxid, 'wxid_abc')
  assert.equal(parsed.text, '你好合作一下')
  assert.equal(parseGroupTextMessage(sampleEvent(), { accountWxid: 'wxid_abc' }), null)
  assert.equal(parseGroupTextMessage(sampleEvent({ msgType: 3 })), null)
})

test('keywords empty matches all; multiple keywords use OR; case-insensitive', () => {
  assert.deepEqual(matchKeywords('任意内容', []), { matched: true, matchedKeyword: '' })
  assert.equal(matchKeywords('请加我好友', ['合作', '加我']).matched, true)
  assert.equal(matchKeywords('请加我好友', ['合作', '加我']).matchedKeyword, '加我')
  assert.equal(matchKeywords('你好', ['合作', '加我']).matched, false)
  assert.equal(matchKeywords('Please ADD ME', ['add me']).matched, true)
  assert.equal(matchKeywords('Please ADD ME', ['add me']).matchedKeyword, 'add me')
})

test('exclude matches wxid or nickname case-insensitively', () => {
  assert.equal(isExcluded({ senderWxid: 'wxid_ABC', nickname: '张三' }, ['wxid_abc']), true)
  assert.equal(isExcluded({ senderWxid: 'wxid_1', nickname: '李四' }, ['李四']), true)
  assert.equal(isExcluded({ senderWxid: 'wxid_1', nickname: '李四' }, ['王五']), false)
  assert.deepEqual(splitRules('a\nb，c'), ['a', 'b', 'c'])
})

test('matchChatAddRule accepts enabled room keyword hits and rejects excluded', () => {
  const rule = {
    enabled: true,
    instanceId: 'ins-1',
    roomIds: ['123@chatroom'],
    keywords: ['合作'],
    excludeText: '',
  }
  const ok = matchChatAddRule(sampleEvent(), rule, 'ins-1')
  assert.equal(ok.accepted, true)
  assert.equal(ok.hit.senderWxid, 'wxid_abc')
  assert.equal(ok.hit.matchedKeyword, '合作')

  const excluded = matchChatAddRule(sampleEvent(), { ...rule, excludeText: '张三' }, 'ins-1')
  assert.equal(excluded.accepted, false)
  assert.equal(excluded.reason, 'EXCLUDED')

  const disabled = matchChatAddRule(sampleEvent(), { ...rule, enabled: false }, 'ins-1')
  assert.equal(disabled.accepted, false)
})

test('parses room from toUserName and ignores event.type as msgType', () => {
  const viaTo = parseGroupTextMessage({
    msgType: 1,
    fromUserName: { String: 'wxid_other' },
    toUserName: { String: '999@chatroom' },
    real_content: '你好',
    member_info: { userName: 'wxid_other', nickName: '李四' },
  })
  assert.equal(viaTo.roomId, '999@chatroom')
  assert.equal(viaTo.senderWxid, 'wxid_other')

  const withEventType = parseGroupTextMessage(sampleEvent({ type: 49, event_type: 10002 }))
  assert.equal(withEventType.roomId, '123@chatroom')
  assert.equal(withEventType.senderWxid, 'wxid_abc')

  const viaRoomSender = parseGroupTextMessage({
    msgType: 1,
    fromUserName: { String: '888@chatroom' },
    real_content: '合作',
    room_sender_by: 'wxid_from_room_sender',
  })
  assert.equal(viaRoomSender.senderWxid, 'wxid_from_room_sender')
})

test('INSTANCE_MISMATCH is returned when rule binds another instance', () => {
  const rule = {
    enabled: true,
    instanceId: 'ins-old',
    roomIds: ['123@chatroom'],
    keywords: [],
  }
  const missed = matchChatAddRule(sampleEvent(), rule, 'ins-new')
  assert.equal(missed.accepted, false)
  assert.equal(missed.reason, 'INSTANCE_MISMATCH')
})

test('empty roomIds rejects all messages (never means listen-all)', () => {
  const rule = {
    enabled: true,
    instanceId: 'ins-1',
    roomIds: [],
    keywords: [],
  }
  const missed = matchChatAddRule(sampleEvent(), rule, 'ins-1')
  assert.equal(missed.accepted, false)
  assert.equal(missed.reason, 'ROOM_FILTER')
})

test('chat add friend page, route, sidebar and main wiring exist', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ChatAddFriendPage.vue'), 'utf8')
  const router = fs.readFileSync(path.join(__dirname, '..', 'src', 'router', 'index.ts'), 'utf8')
  const layout = fs.readFileSync(path.join(__dirname, '..', 'src', 'layout', 'MainLayout.vue'), 'utf8')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  const storage = fs.readFileSync(path.join(__dirname, '..', 'electron', 'storage.cjs'), 'utf8')

  assert.match(page, /创建加好友任务/)
  assert.match(page, /已经频繁/)
  assert.match(page, /请先勾选要添加的发言候选/)
  assert.match(page, /getChatAddRule/)
  assert.match(page, /markChatAddCandidatesTasked/)
  assert.match(page, /已经创建过加好友任务，已从待创建中移除/)
  assert.match(page, /watch\(selectedInstanceId, \(next, prev\)/)
  assert.match(page, /@click="saveRule\(\)"/)
  assert.match(page, /roomIdFromSelectKey/)
  assert.match(page, /previousRoomIds/)
  assert.match(page, /loadingRule/)
  assert.match(page, /saveRule\(true, true\)/)
  assert.match(page, /formatLocalDateTime/)
  assert.match(page, /DEFAULT_FRIEND_VERIFY_CONTENT/)
  assert.match(page, /status: 'PROFILE_PENDING'/)
  assert.match(page, /sourceRoomId: row\.sourceRoomId \|\| row\.roomId/)
  assert.doesNotMatch(page, /验证内容不能为空/)
  assert.match(page, /prop="displayTime" label="接收时间"/)
  assert.match(page, /请先选择监听微信/)
  assert.match(page, /:disabled="!selectedInstanceId/)
  assert.match(page, /停止监听只阻止新增候选，不清空已有候选/)
  assert.doesNotMatch(page, /!activeRule\?\.enabled \|\| !activeRule\.instanceId/)
  assert.doesNotMatch(page, /since: activeRule\.updatedAt/)
  // 全选按钮不得包在 label 内，否则点击标题会误触全选
  assert.doesNotMatch(page, /<label class="span-2">/)
  assert.doesNotMatch(page, /@click="saveRule\(false\)"/)
  assert.doesNotMatch(page, /taskStatus === 'COOLING_DOWN' && \(friend\.status === 'SUBMITTED'/)
  assert.match(router, /chat-add-friend/)
  assert.match(layout, /群聊加好友/)
  assert.match(main, /handleChatAddFriendEvent/)
  assert.match(main, /ensureChatAddRuleBound/)
  assert.match(main, /chatAdd:getRule/)
  assert.match(preload, /onChatAddCandidate/)
  assert.match(storage, /chat_add_candidates/)
  assert.match(storage, /UNIQUE\(instance_id, sender_wxid, source_room_id\)/)
  assert.match(storage, /filters\.instanceId/)
  assert.match(storage, /filters\.roomIds/)
})
