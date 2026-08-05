const test = require('node:test')
const assert = require('node:assert/strict')
const { LengthPrefixedDecoder, encodeFrame, hasFrequentEvidence, isVerifiedSuccess, buildAddFriendRequest, evaluateFriendAddResult, isRetryableFriendCredentialFailure } = require('../electron/protocol.cjs')

test('TCP decoder handles a split header and body', () => {
  const decoder = new LengthPrefixedDecoder()
  const frame = encodeFrame('{"ok":true}')
  assert.deepEqual(decoder.push(frame.subarray(0, 2)), [])
  assert.deepEqual(decoder.push(frame.subarray(2, 7)), [])
  assert.equal(decoder.push(frame.subarray(7))[0].toString(), '{"ok":true}')
})

test('TCP decoder handles sticky frames', () => {
  const decoder = new LengthPrefixedDecoder()
  const messages = decoder.push(Buffer.concat([encodeFrame('one'), encodeFrame('two')]))
  assert.deepEqual(messages.map((item) => item.toString()), ['one', 'two'])
})

test('TCP decoder enforces message limit', () => {
  const decoder = new LengthPrefixedDecoder(10)
  const header = Buffer.alloc(4); header.writeUInt32BE(11)
  assert.throws(() => decoder.push(header), RangeError)
})

test('endpoint-specific success parsers do not share codes', () => {
  assert.equal(isVerifiedSuccess(438557482, true, { code: 1 }), true)
  assert.equal(isVerifiedSuccess(438557485, true, { code: 1, msg: 'success' }), true)
  assert.equal(isVerifiedSuccess(438557485, true, { code: 0 }), false)
  assert.equal(isVerifiedSuccess(438557482, true, { errCode: 1, errMsg: '请求处理成功' }), true)
  assert.equal(isVerifiedSuccess(438557482, true, { code: 0 }), false)
  assert.equal(isVerifiedSuccess(438557576, true, { code: 0 }), true)
  assert.equal(isVerifiedSuccess(438557574, true, { errCode: 1, data: { scan_res: 'https://weixin.qq.com/g/x' } }), true)
  assert.equal(isVerifiedSuccess(438557574, true, { errCode: 1, data: {} }), false)
  assert.equal(isVerifiedSuccess(438557503, true, { baseResponse: { ret: 0 } }), true)
})

test('friend add rejects explicit business errors instead of reporting submitted', () => {
  const failed = evaluateFriendAddResult(true, { code: 500, data: null, msg: '[json.exception.type_error.302] type must be string, but is null' })
  assert.equal(failed.accepted, false)
  assert.match(failed.reason, /type must be string/)
  assert.equal(evaluateFriendAddResult(true, {}).accepted, true)
  assert.equal(evaluateFriendAddResult(false, {}).accepted, false)

  const wechatReject = evaluateFriendAddResult(true, {
    baseResponse: { ret: -24, errMsg: { String: '当前账号存在安全风险，需先到「微信团队」进行安全验证后才能继续使用当前功能。' } },
    verifyUserSpamInfo: { block: 0 },
  })
  assert.equal(wechatReject.accepted, false)
  assert.match(wechatReject.reason, /安全风险|微信团队/)

  const wechatOk = evaluateFriendAddResult(true, {
    baseResponse: { ret: 0, errMsg: {} },
    verifyUserSpamInfo: { block: 0 },
  })
  assert.equal(wechatOk.accepted, true)
})

test('buildAddFriendRequest always sends both scence and scene', () => {
  const group = buildAddFriendRequest({
    v3: 'v3_x',
    v4: 'v4_y',
    sourceRoomId: '45323899007@chatroom',
    targetWxid: 'wxid_demo',
    verifyContent: '测试+',
  })
  assert.equal(group.scence, '14')
  assert.equal(group.scene, '14')
  assert.equal(group.chatRoomUserName, '45323899007@chatroom')
  assert.equal(group.chatroomId, '45323899007@chatroom')
  assert.equal(group.wxid, 'wxid_demo')
  assert.equal(group.opcode, '2')
  assert.equal(group.verifyContent, '测试+')

  const plain = buildAddFriendRequest({ v3: 'v3_x', v4: 'v4_y', scene: '3' })
  assert.equal(plain.scence, '3')
  assert.equal(plain.scene, '3')
  assert.equal(plain.chatRoomUserName, undefined)
})

test('frequency detection needs explicit evidence', () => {
  assert.equal(hasFrequentEvidence({ msg: '操作频繁，请稍后再试' }), true)
  assert.equal(hasFrequentEvidence({ message: 'too many requests' }), true)
  assert.equal(hasFrequentEvidence({ message: 'network timeout' }), false)
})

test('credential Invalid argument is retryable; account policy is not', () => {
  const badPair = { baseResponse: { ret: -2, errMsg: { String: 'Invalid argument' } } }
  const badVerdict = evaluateFriendAddResult(true, badPair)
  assert.equal(isRetryableFriendCredentialFailure(true, badPair, badVerdict), true)
  const banned = { baseResponse: { ret: -24, errMsg: { String: '账号异常' } } }
  assert.equal(isRetryableFriendCredentialFailure(true, banned, evaluateFriendAddResult(true, banned)), false)
})
