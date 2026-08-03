/**
 * 群聊实时发言加好友：解析群文本消息、匹配监听规则。
 * 用途：TCP 回调旁路、单元测试、候选入库前过滤。
 */

/**
 * 从嵌套 String 对象或原始值提取字符串。
 * @param {unknown} value 原始字段
 * @returns {string}
 */
function stringField(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value && typeof value === 'object' && typeof value.String === 'string') return value.String
  return ''
}

/**
 * 规范化多行/逗号分隔的规则文本为去重小写列表。
 * @param {string|string[]} text 用户输入或已解析数组
 * @returns {string[]}
 */
function splitRules(text) {
  const source = Array.isArray(text) ? text.join('\n') : String(text || '')
  const seen = new Set()
  const result = []
  for (const part of source.split(/[\r\n,，]+/)) {
    const value = part.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(value)
  }
  return result
}

/**
 * 从事件中解析群 ID（优先 from，其次 to / 显式字段）。
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function extractRoomId(event) {
  const candidates = [
    event.fromUserName ?? event.from_user_name,
    event.toUserName ?? event.to_user_name,
    event.roomId ?? event.room_id,
    event.chatroomName ?? event.chatRoomName,
  ]
  for (const candidate of candidates) {
    const value = stringField(candidate)
    if (value.endsWith('@chatroom')) return value
  }
  return ''
}

/**
 * 判断消息是否为群聊文本消息。
 * @param {unknown} event TCP/Hook 原始事件
 * @returns {boolean}
 */
function isGroupTextMessage(event) {
  if (!event || typeof event !== 'object') return false
  const roomId = extractRoomId(event)
  if (!roomId) return false
  // 只用明确的消息类型字段；勿把 event.type / event_type（业务事件名）当成 msgType
  const msgType = Number(event.msgType ?? event.msg_type ?? event.local_type ?? event.message_type)
  if (Number.isFinite(msgType) && msgType !== 1) return false
  const text = extractMessageText(event)
  return Boolean(text || msgType === 1)
}

/**
 * 提取群消息正文（优先 real_content，否则去掉 wxid: 前缀）。
 * @param {Record<string, unknown>} event 消息事件
 * @returns {string}
 */
function extractMessageText(event) {
  const real = stringField(event.real_content ?? event.realContent)
  if (real) return real.trim()
  const content = stringField(event.content ?? event.Content)
  if (!content) return ''
  const matched = content.match(/^([^\n:：]+)[:：]\s*([\s\S]*)$/)
  if (matched) return String(matched[2] || '').trim()
  return content.trim()
}

/**
 * 提取发送者 wxid / 昵称。
 * @param {Record<string, unknown>} event 消息事件
 * @returns {{ senderWxid: string, nickname: string }}
 */
function extractSender(event) {
  const member = event.member_info && typeof event.member_info === 'object' ? event.member_info : {}
  let senderWxid = stringField(
    member.userName ?? member.username ?? member.wxid
    ?? event.room_sender_by ?? event.roomSenderBy
    ?? event.senderWxid ?? event.sender_wxid,
  )
  let nickname = stringField(event.sender_nick ?? event.senderNick ?? member.nickName ?? member.nickname)
  if (!senderWxid) {
    const content = stringField(event.content ?? event.Content)
    const matched = content.match(/^([^\n:：]+)[:：]/)
    if (matched) senderWxid = matched[1].trim()
  }
  // 群 ID 不能当发送者
  if (senderWxid.endsWith('@chatroom')) senderWxid = ''
  return { senderWxid, nickname }
}

/**
 * 解析群聊文本消息为结构化命中候选。
 * @param {unknown} event 原始回调
 * @param {{ accountWxid?: string }} [options] 当前登录微信，用于跳过自己
 * @returns {{ roomId: string, senderWxid: string, nickname: string, text: string, msgId: string } | null}
 */
function parseGroupTextMessage(event, options = {}) {
  if (!isGroupTextMessage(event)) return null
  const source = event
  const roomId = extractRoomId(source)
  const { senderWxid, nickname } = extractSender(source)
  const text = extractMessageText(source)
  if (!roomId.endsWith('@chatroom') || !senderWxid) return null
  const selfWxid = String(options.accountWxid || '')
  if (selfWxid && senderWxid === selfWxid) return null
  const msgId = stringField(source.newMsgId ?? source.new_msg_id ?? source.msgId ?? source.msg_id)
  return { roomId, senderWxid, nickname, text, msgId }
}

/**
 * 判断文本是否命中关键词（空关键词 = 全量命中；多个关键词 OR；忽略大小写）。
 * @param {string} text 消息正文
 * @param {string[]} keywords 关键词列表
 * @returns {{ matched: boolean, matchedKeyword: string }}
 */
function matchKeywords(text, keywords) {
  const list = (keywords || []).map((item) => String(item || '').trim()).filter(Boolean)
  if (!list.length) return { matched: true, matchedKeyword: '' }
  // 忽略大小写，避免「加我」漏掉「加我」以外大小写变体
  const haystack = String(text || '').toLowerCase()
  for (const keyword of list) {
    if (haystack.includes(keyword.toLowerCase())) return { matched: true, matchedKeyword: keyword }
  }
  return { matched: false, matchedKeyword: '' }
}

/**
 * 判断发送者是否在排除列表（WXID / 昵称精确匹配，忽略大小写）。
 * @param {{ senderWxid: string, nickname: string }} sender 发送者
 * @param {string[]} excludeList 排除项
 * @returns {boolean} true 表示应排除
 */
function isExcluded(sender, excludeList) {
  const rules = (excludeList || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
  if (!rules.length) return false
  const wxid = String(sender.senderWxid || '').trim().toLowerCase()
  const nickname = String(sender.nickname || '').trim().toLowerCase()
  return rules.some((rule) => rule === wxid || (nickname && rule === nickname))
}

/**
 * 用监听规则判断消息是否应进入候选。
 * @param {unknown} event 原始消息
 * @param {{ enabled?: boolean, instanceId?: string, roomIds?: string[], keywords?: string[]|string, excludeText?: string|string[], accountWxid?: string }} rule 规则
 * @param {string} instanceId 当前实例 ID
 * @returns {{ accepted: boolean, reason?: string, hit?: object }}
 */
function matchChatAddRule(event, rule, instanceId) {
  if (!rule || !rule.enabled) return { accepted: false, reason: 'DISABLED' }
  if (rule.instanceId && String(rule.instanceId) !== String(instanceId)) return { accepted: false, reason: 'INSTANCE_MISMATCH' }
  const parsed = parseGroupTextMessage(event, { accountWxid: rule.accountWxid })
  if (!parsed) return { accepted: false, reason: 'NOT_GROUP_TEXT' }
  const roomIds = Array.isArray(rule.roomIds) ? rule.roomIds.map(String) : []
  if (!roomIds.length || !roomIds.includes(parsed.roomId)) return { accepted: false, reason: 'ROOM_FILTER' }
  const keywords = Array.isArray(rule.keywords) ? rule.keywords : splitRules(rule.keywords)
  const keywordHit = matchKeywords(parsed.text, keywords)
  if (!keywordHit.matched) return { accepted: false, reason: 'KEYWORD_MISS' }
  const excludes = Array.isArray(rule.excludeText) ? rule.excludeText : splitRules(rule.excludeText)
  if (isExcluded(parsed, excludes)) return { accepted: false, reason: 'EXCLUDED' }
  return {
    accepted: true,
    hit: {
      instanceId: String(instanceId),
      roomId: parsed.roomId,
      senderWxid: parsed.senderWxid,
      nickname: parsed.nickname,
      messagePreview: parsed.text.slice(0, 200),
      matchedKeyword: keywordHit.matchedKeyword,
      msgId: parsed.msgId,
    },
  }
}

module.exports = {
  stringField,
  splitRules,
  extractRoomId,
  isGroupTextMessage,
  extractMessageText,
  extractSender,
  parseGroupTextMessage,
  matchKeywords,
  isExcluded,
  matchChatAddRule,
}
