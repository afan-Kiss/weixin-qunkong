const MAX_MESSAGE_BYTES = 10 * 1024 * 1024

class LengthPrefixedDecoder {
  constructor(maxBytes = MAX_MESSAGE_BYTES) { this.maxBytes = maxBytes; this.buffer = Buffer.alloc(0) }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages = []
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0)
      if (length > this.maxBytes) throw new RangeError(`TCP message exceeds ${this.maxBytes} bytes`)
      if (this.buffer.length < length + 4) break
      messages.push(this.buffer.subarray(4, length + 4))
      this.buffer = this.buffer.subarray(length + 4)
    }
    return messages
  }
}

function encodeFrame(value) {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

function hasFrequentEvidence(raw) {
  const text = JSON.stringify(raw ?? '').toLowerCase()
  return text.includes('频繁') || text.includes('frequent') || text.includes('too many requests')
}

function isVerifiedSuccess(sourceId, responseOk, raw) {
  if (!responseOk) return false
  if (Number(sourceId) === 438557482) return raw?.code === 1 || raw?.errCode === 1
  if (Number(sourceId) === 438557485) return raw?.code === 1 || raw?.errCode === 1
  if (Number(sourceId) === 438557574) {
    const scanResult = raw?.data?.scan_res ?? raw?.scan_res
    return raw?.errCode === 1 && typeof scanResult === 'string' && scanResult.trim().length > 0
  }
  if (Number(sourceId) === 438557576) return raw?.code === 0
  if (Number(sourceId) === 438557503) return raw?.baseResponse?.ret === 0 || raw?.data?.baseResponse?.ret === 0
  return null
}

/**
 * 读取微信/DLL 返回中的可读错误文案（兼容 errMsg.String 对象）。
 * @param {Record<string, unknown>} source
 */
function readFriendAddMessage(source) {
  const baseErr = source.baseResponse && typeof source.baseResponse === 'object'
    ? /** @type {Record<string, unknown>} */ (source.baseResponse).errMsg
    : undefined
  if (typeof baseErr === 'string' && baseErr.trim()) return baseErr.trim()
  if (baseErr && typeof baseErr === 'object') {
    const nested = /** @type {Record<string, unknown>} */ (baseErr)
    const text = nested.String ?? nested.string ?? nested.errMsg ?? nested.message
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  for (const key of ['msg', 'message', 'errMsg']) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

/**
 * 构造本机 4.1.8.27 DLL 可用的 /api/add_friend 请求体。
 * HAR 合同要求 scence；实测还必须同步传 scene，否则 DLL 返回
 * code=500 / type must be string, but is null。
 * 群来源时默认 scene=14，并附带群标识字段。
 * @param {{
 *   v3?: unknown,
 *   v4?: unknown,
 *   scene?: unknown,
 *   scence?: unknown,
 *   friendFlg?: unknown,
 *   verifyContent?: unknown,
 *   sourceRoomId?: unknown,
 *   targetWxid?: unknown,
 *   defaultVerifyContent?: string,
 * }} input
 */
function buildAddFriendRequest(input = {}) {
  const sourceRoomId = String(input.sourceRoomId || '').trim()
  const fromGroup = sourceRoomId.endsWith('@chatroom')
  const scene = String(input.scence ?? input.scene ?? (fromGroup ? '14' : '3')).trim() || (fromGroup ? '14' : '3')
  const verifyDefault = String(input.defaultVerifyContent || '你好，我是群里的朋友')
  const verifyContent = String(input.verifyContent ?? '').trim() || verifyDefault
  const targetWxid = String(input.targetWxid || '').trim()
  /** @type {Record<string, string>} */
  const body = {
    v3: String(input.v3 ?? ''),
    v4: String(input.v4 ?? ''),
    scence: scene,
    scene,
    friendFlg: String(input.friendFlg ?? '0'),
    verifyContent,
    opcode: '2',
  }
  if (fromGroup) {
    body.chatRoomUserName = sourceRoomId
    body.chatroomId = sourceRoomId
  }
  if (targetWxid) body.wxid = targetWxid
  return body
}

/**
 * 添加好友：优先看 baseResponse.ret；明确业务错误返回微信原文。
 * @param {boolean} responseOk
 * @param {unknown} raw
 * @returns {{ accepted: boolean, reason: string }}
 */
function evaluateFriendAddResult(responseOk, raw) {
  if (!responseOk) return { accepted: false, reason: '添加好友接口请求失败' }
  const source = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const message = readFriendAddMessage(source)
  const baseRet = source.baseResponse && typeof source.baseResponse === 'object'
    ? Number(/** @type {Record<string, unknown>} */ (source.baseResponse).ret)
    : NaN
  if (Number.isFinite(baseRet)) {
    if (baseRet === 0) return { accepted: true, reason: '好友申请已提交，等待对方确认' }
    return { accepted: false, reason: message || `添加好友失败（错误码 ${baseRet}）` }
  }
  const code = Number(source.code ?? source.errCode)
  if ((Number.isFinite(code) && (code >= 400 || code < 0)) || /exception|error|失败|参数|不能为空|类型|安全风险|无法添加/i.test(message)) {
    return { accepted: false, reason: message || `添加好友失败（错误码 ${code}）` }
  }
  return { accepted: true, reason: '好友申请已提交，等待对方确认' }
}

/**
 * 凭证类失败可自动刷新后重试；账号策略类（如 -24）不可重试。
 * @param {boolean} responseOk
 * @param {unknown} raw
 * @param {{ accepted?: boolean, reason?: string }} [verdict]
 */
function isRetryableFriendCredentialFailure(responseOk, raw, verdict = {}) {
  if (verdict.accepted) return false
  const source = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {}
  const baseRet = source.baseResponse && typeof source.baseResponse === 'object'
    ? Number(/** @type {Record<string, unknown>} */ (source.baseResponse).ret)
    : NaN
  if (baseRet === -24) return false
  if (baseRet === -2) return true
  const reason = String(verdict.reason || readFriendAddMessage(source) || '')
  if (/invalid argument|缺少\s*v3|缺少\s*v4|type must be string|凭证/i.test(reason)) return true
  if (!responseOk && /fetch failed|econnrefused|socket hang up|timeout/i.test(reason)) return true
  return false
}

module.exports = {
  MAX_MESSAGE_BYTES,
  LengthPrefixedDecoder,
  encodeFrame,
  hasFrequentEvidence,
  isVerifiedSuccess,
  buildAddFriendRequest,
  evaluateFriendAddResult,
  isRetryableFriendCredentialFailure,
  readFriendAddMessage,
}
