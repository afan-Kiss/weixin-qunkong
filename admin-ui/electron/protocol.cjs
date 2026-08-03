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
 * 添加好友接口没有稳定成功回包，但明确的 HTTP/业务错误必须判为失败。
 * @param {boolean} responseOk
 * @param {unknown} raw
 * @returns {{ accepted: boolean, reason: string }}
 */
function evaluateFriendAddResult(responseOk, raw) {
  if (!responseOk) return { accepted: false, reason: '添加好友接口请求失败' }
  const source = raw && typeof raw === 'object' ? raw : {}
  const code = Number(source.code ?? source.errCode ?? source.baseResponse?.ret)
  const message = String(source.msg ?? source.message ?? source.errMsg ?? source.baseResponse?.errMsg ?? '').trim()
  if ((Number.isFinite(code) && (code >= 400 || code < 0)) || /exception|error|失败|参数|不能为空|类型/i.test(message)) {
    return { accepted: false, reason: message || `添加好友失败（错误码 ${code}）` }
  }
  return { accepted: true, reason: '好友申请已提交，等待对方确认' }
}

module.exports = { MAX_MESSAGE_BYTES, LengthPrefixedDecoder, encodeFrame, hasFrequentEvidence, isVerifiedSuccess, evaluateFriendAddResult }
