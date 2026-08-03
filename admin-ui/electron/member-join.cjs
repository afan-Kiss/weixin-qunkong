/**
 * 解析微信群成员进群回调，识别“最新入群成员”。
 * 用途：TCP 回调入库、快照差分、单元测试复用。
 */

/**
 * 判断文案是否表示退群/离开。
 * @param {string} text 事件描述或场景 XML
 * @returns {boolean}
 */
function isLeaveText(text) {
  return /退群|离开群|离开|移除|踢出/.test(String(text || ''))
}

/**
 * 判断文案是否表示进群/入群。
 * @param {string} text 事件描述或场景 XML
 * @returns {boolean}
 */
function isJoinText(text) {
  return /进群|入群|加入群|新成员|邀请进群/.test(String(text || ''))
}

/**
 * 将回调中的 memberlist 规范为成员数组。
 * @param {unknown} value 单个成员对象或数组
 * @returns {Array<{ wxid: string, nickname: string, avatar: string, inviter: string, addChatRoomSceneNewXml: string }>}
 */
function normalizeMemberList(value) {
  const rows = Array.isArray(value) ? value : value ? [value] : []
  return rows.map((row) => {
    if (!row || typeof row !== 'object') {
      return { wxid: '', nickname: '', avatar: '', inviter: '', addChatRoomSceneNewXml: '' }
    }
    const source = row
    return {
      wxid: String(source.userName || source.username || source.wxid || source.memberWxid || ''),
      nickname: String(source.nickName || source.nickname || source.displayName || ''),
      avatar: String(source.bigHeadImgUrl || source.smallHeadImgUrl || source.avatar || ''),
      inviter: String(source.inviterUserName || source.inviter || ''),
      addChatRoomSceneNewXml: String(source.addChatRoomSceneNewXml || source.sceneXml || ''),
    }
  }).filter((item) => item.wxid)
}

/**
 * 判断回调是否为群成员进群事件。
 * @param {unknown} event TCP/Hook 原始事件
 * @returns {boolean} 是否为进群事件；退群/改昵称返回 false
 */
function isMemberJoinEvent(event) {
  if (!event || typeof event !== 'object') return false
  const source = event
  const type = Number(source.event_type ?? source.eventType)
  const desc = String(source.event_desc ?? source.eventDesc ?? '')
  if (type === 1012) return false
  if (isLeaveText(desc)) return false
  if (isJoinText(desc)) return true
  const data = source.data && typeof source.data === 'object' ? source.data : null
  if (!data) return false
  const roomId = String(data.roomid || data.roomId || data.room_id || '')
  const members = normalizeMemberList(data.memberlist || data.memberList || data.member)
  if (!roomId.endsWith('@chatroom') || !members.length) return false
  // 退群回调结构相似且也可能带 scene XML，必须看到明确“进群”语义才认定
  const sceneText = members.map((item) => item.addChatRoomSceneNewXml).join('\n')
  if (isLeaveText(sceneText)) return false
  return isJoinText(sceneText)
}

/**
 * 解析回调中的入群时间。
 * @param {Record<string, unknown>} data 事件 data
 * @returns {string} ISO 时间
 */
function resolveJoinAt(data) {
  const rawTime = data.createtime ?? data.createTime ?? data.create_time
  const numeric = Number(rawTime)
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString()
  }
  if (typeof rawTime === 'string' && rawTime.trim()) {
    const parsed = Date.parse(rawTime)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

/**
 * 从进群回调提取全部可入库成员（兼容 memberlist 为对象或数组）。
 * @param {unknown} event TCP/Hook 原始事件
 * @returns {Array<{ roomId: string, memberWxid: string, nickname: string, avatar: string, inviter: string, joinAt: string }>}
 */
function extractMemberJoins(event) {
  if (!isMemberJoinEvent(event)) return []
  const source = event
  const data = source.data && typeof source.data === 'object' ? source.data : {}
  const roomId = String(data.roomid || data.roomId || data.room_id || '')
  if (!roomId) return []
  const joinAt = resolveJoinAt(data)
  const seen = new Set()
  const rows = []
  for (const member of normalizeMemberList(data.memberlist || data.memberList || data.member)) {
    if (seen.has(member.wxid)) continue
    seen.add(member.wxid)
    rows.push({
      roomId,
      memberWxid: member.wxid,
      nickname: member.nickname,
      avatar: member.avatar,
      inviter: member.inviter,
      joinAt,
    })
  }
  return rows
}

/**
 * 兼容旧接口：只返回第一名进群成员。
 * @param {unknown} event TCP/Hook 原始事件
 * @returns {{ roomId: string, memberWxid: string, nickname: string, avatar: string, inviter: string, joinAt: string } | null}
 */
function extractMemberJoin(event) {
  return extractMemberJoins(event)[0] || null
}

/**
 * 对比前后成员列表，找出新增成员（用于“重新采集”识别最新入群）。
 * @param {string[]} previousWxids 上次已落库的成员 wxid
 * @param {Array<{ wxid: string, nickname?: string, avatar?: string, inviter?: string }>} currentMembers 本次采集结果
 * @returns {Array<{ wxid: string, nickname: string, avatar: string, inviter: string }>} 新增成员；首次基线（previous 为空）返回空数组
 */
function diffNewMembers(previousWxids, currentMembers) {
  const previous = new Set((previousWxids || []).map(String).filter(Boolean))
  if (!previous.size) return []
  const seen = new Set()
  const added = []
  for (const row of currentMembers || []) {
    const wxid = String(row?.wxid || '')
    if (!wxid || previous.has(wxid) || seen.has(wxid)) continue
    seen.add(wxid)
    added.push({
      wxid,
      nickname: String(row.nickname || ''),
      avatar: String(row.avatar || ''),
      inviter: String(row.inviter || ''),
    })
  }
  return added
}

module.exports = {
  isLeaveText,
  isJoinText,
  isMemberJoinEvent,
  normalizeMemberList,
  extractMemberJoin,
  extractMemberJoins,
  diffNewMembers,
}
