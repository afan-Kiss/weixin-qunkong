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
  if (Number(sourceId) === 438557574) return raw?.errCode === 1
  if (Number(sourceId) === 438557576) return raw?.code === 0
  if (Number(sourceId) === 438557503) return raw?.baseResponse?.ret === 0 || raw?.data?.baseResponse?.ret === 0
  return null
}

module.exports = { MAX_MESSAGE_BYTES, LengthPrefixedDecoder, encodeFrame, hasFrequentEvidence, isVerifiedSuccess }
