const test = require('node:test')
const assert = require('node:assert/strict')
const { LengthPrefixedDecoder, encodeFrame, hasFrequentEvidence, isVerifiedSuccess, evaluateFriendAddResult } = require('../electron/protocol.cjs')

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
})

test('frequency detection needs explicit evidence', () => {
  assert.equal(hasFrequentEvidence({ msg: '操作频繁，请稍后再试' }), true)
  assert.equal(hasFrequentEvidence({ message: 'too many requests' }), true)
  assert.equal(hasFrequentEvidence({ message: 'network timeout' }), false)
})
