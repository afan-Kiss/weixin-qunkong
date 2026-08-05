/**
 * 被踢出群聊的检测与清理判定（纯逻辑，可供单测）。
 *
 * 安全原则（宁可漏清，不可误退正常群）：
 * 1) 系统消息「你被…移出群聊」（msgType 10000/10002）→ 强证据，可立刻清
 * 2) 「群成员退群回调」且 memberlist 仅证明「本人离开」→ 登记后必须再确认
 *    成员列表已不含本人，才允许 quit；若本人仍在群 → 一律取消，绝不退群
 * 3) 别人退群 / 进群 / 改昵称 / 普通聊天复读踢人文案 → 一律忽略
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function stringField(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value && typeof value === 'object' && typeof value.String === 'string') return value.String
  return ''
}

/**
 * 本人被踢的系统文案（必须含「你」指向本人；绝不匹配「张三退出了群聊」等）。
 * @param {string} text
 * @returns {boolean}
 */
function isSelfKickedText(text) {
  const value = String(text || '').replace(/\s+/g, '')
  // 仅本人被踢：你被xxx移出群聊 / 你已被移出群聊（兼容「移出了群聊」）
  if (/你被[^。\n]{0,40}移出了?群聊/.test(value)) return true
  if (/你已被移出了?群聊/.test(value)) return true
  return false
}

/**
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function extractRoomId(event) {
  const data = event.data && typeof event.data === 'object' ? /** @type {Record<string, unknown>} */ (event.data) : null
  const candidates = [
    data?.roomid,
    data?.roomId,
    data?.room_id,
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
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
function extractMessageText(event) {
  const real = stringField(event.real_content ?? event.realContent)
  if (real) return stripSysmsgNoise(real)
  const push = stringField(event.pushContent ?? event.push_content)
  if (push && isSelfKickedText(stripSysmsgNoise(push))) return stripSysmsgNoise(push)
  const content = stringField(event.content ?? event.Content)
  if (!content) return ''
  // 群消息常见「wxid:\n正文」前缀，系统踢人文案也可能带此前缀
  const matched = content.match(/^([^\n:：]+)[:：]\s*([\s\S]*)$/)
  if (matched) return stripSysmsgNoise(String(matched[2] || ''))
  return stripSysmsgNoise(content)
}

/**
 * 10002 等系统消息常包在 XML / CDATA 里，抽出可读文案再匹配。
 * @param {string} text
 * @returns {string}
 */
function stripSysmsgNoise(text) {
  let value = String(text || '').trim()
  if (!value) return ''
  if (/<[^>]+>/.test(value)) {
    value = value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  }
  return value
}

/**
 * 必须是微信系统提示类型，避免普通聊天复读「你被移出群聊」误退。
 * 优先 msgType；仅在没有业务回调字段时才用 type 兜底（避免和 event_type 混淆）。
 * @param {Record<string, unknown>} event
 * @returns {boolean}
 */
function looksLikeSystemKickMessage(event) {
  const primary = [event.msgType, event.msg_type, event.local_type, event.message_type]
  for (const raw of primary) {
    const msgType = Number(raw)
    if (msgType === 10000 || msgType === 10002) return true
  }
  const hasBizCallback = event.event_type != null || event.eventType != null
    || Boolean(String(event.event_desc ?? event.eventDesc ?? '').trim())
  if (hasBizCallback) return false
  const fallback = Number(event.type)
  return fallback === 10000 || fallback === 10002
}

/**
 * 群系统消息：你被…移出群聊。
 * @param {unknown} event
 * @returns {{ roomId: string, roomName: string, evidence: string, strength: 'strong' } | null}
 */
function extractSelfKickedFromSystemMessage(event) {
  if (!event || typeof event !== 'object') return null
  const source = /** @type {Record<string, unknown>} */ (event)
  if (!looksLikeSystemKickMessage(source)) return null
  const text = extractMessageText(source)
  const desc = String(source.event_desc ?? source.eventDesc ?? source.messageDesc ?? '')
  if (!isSelfKickedText(text) && !isSelfKickedText(desc)) return null
  // 拒绝「别人被踢 / 别人退出」类文案混入（正文必须指向你）
  const compact = String(text || '').replace(/\s+/g, '')
  if (/^(?!你)[^。\n]{0,40}(被移出群聊|退出了群聊|离开了群聊)/.test(compact)) return null
  const roomId = extractRoomId(source)
  if (!roomId.endsWith('@chatroom')) return null
  return {
    roomId,
    roomName: '',
    evidence: 'SYSTEM_MSG_SELF_KICKED',
    strength: 'strong',
  }
}

/**
 * 是否为「群成员退群」类业务回调描述（收紧匹配，避免误伤进群/改名）。
 * @param {string} desc
 * @returns {boolean}
 */
function isLeaveCallbackDesc(desc) {
  const value = String(desc || '').trim()
  if (!value) return false
  if (/进群|入群|加入群|昵称修改|改名/.test(value)) return false
  // 官方文案多为「群成员退群通知」；兼容含移出/踢出的描述
  if (/群成员退群/.test(value)) return true
  if (/退群通知/.test(value)) return true
  if (/被移出群|踢出群/.test(value)) return true
  return false
}

/**
 * 从退群回调 data.memberlist 提取成员 wxid 列表。
 * @param {unknown} membersRaw
 * @returns {string[]}
 */
function extractLeaveMemberWxids(membersRaw) {
  const rows = Array.isArray(membersRaw) ? membersRaw : membersRaw ? [membersRaw] : []
  /** @type {string[]} */
  const out = []
  for (const row of rows) {
    const wxid = unwrapWxid(
      row && typeof row === 'object'
        ? (/** @type {Record<string, unknown>} */ (row).userName
          ?? /** @type {Record<string, unknown>} */ (row).username
          ?? /** @type {Record<string, unknown>} */ (row).UserName
          ?? /** @type {Record<string, unknown>} */ (row).wxid
          ?? /** @type {Record<string, unknown>} */ (row).memberWxid)
        : row,
    ).trim()
    if (wxid && !wxid.endsWith('@chatroom')) out.push(wxid)
  }
  return out
}

/**
 * 群成员退群回调：仅当 memberlist 含本人时登记（别人退群绝不触发）。
 * 注意：本证据不能单独立刻退群，必须再过成员列表确认本人已不在群。
 * @param {unknown} event
 * @param {string} accountWxid
 * @returns {{ roomId: string, roomName: string, evidence: string, strength: 'strong' } | null}
 */
function extractSelfKickedFromLeave(event, accountWxid = '') {
  const account = String(accountWxid || '').trim()
  if (!account || account.endsWith('@chatroom') || !event || typeof event !== 'object') return null
  const source = /** @type {Record<string, unknown>} */ (event)
  const desc = String(source.event_desc ?? source.eventDesc ?? source.messageDesc ?? '')
  if (!isLeaveCallbackDesc(desc)) return null
  const data = source.data && typeof source.data === 'object'
    ? /** @type {Record<string, unknown>} */ (source.data)
    : null
  if (!data) return null
  // 退群回调 roomId 只信 data 内字段，避免串到其它消息的 fromUserName
  const roomId = stringField(data.roomid ?? data.roomId ?? data.room_id)
  if (!roomId.endsWith('@chatroom')) return null
  const memberWxids = extractLeaveMemberWxids(data.memberlist ?? data.memberList ?? data.member)
  if (!memberWxids.length) return null
  if (!memberWxids.includes(account)) return null
  return {
    roomId,
    roomName: stringField(data.roomname ?? data.roomName ?? data.room_name),
    evidence: 'LEAVE_CALLBACK_SELF',
    strength: 'strong',
  }
}

/**
 * 系统消息本人被踢，或退群回调含本人。
 * @param {unknown} event
 * @param {string} [accountWxid]
 * @returns {{ roomId: string, roomName: string, evidence: string, strength: 'strong' } | null}
 */
function extractSelfKickedEvent(event, accountWxid = '') {
  return extractSelfKickedFromSystemMessage(event) || extractSelfKickedFromLeave(event, accountWxid)
}

/**
 * 证据优先级：系统踢人文案 > 退群回调本人。
 * @param {string} current
 * @param {string} incoming
 * @returns {string}
 */
function preferKickEvidence(current, incoming) {
  const rank = (value) => {
    if (value === 'SYSTEM_MSG_SELF_KICKED') return 3
    if (value === 'LEAVE_CALLBACK_SELF') return 2
    if (value) return 1
    return 0
  }
  return rank(incoming) >= rank(current) ? incoming : current
}

/**
 * 解开微信常见的 { String: "wxid" } 包装。
 * @param {unknown} value
 * @returns {string}
 */
function unwrapWxid(value) {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value && typeof value === 'object') {
    const row = /** @type {Record<string, unknown>} */ (value)
    const nested = row.String ?? row.string ?? row.userName ?? row.username ?? row.wxid ?? row.memberWxid
    if (nested !== value) return unwrapWxid(nested)
  }
  return ''
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function looksLikeMemberWxid(value) {
  const wxid = String(value || '').trim()
  if (!wxid || wxid.endsWith('@chatroom') || wxid.startsWith('[')) return false
  if (/^https?:\/\//i.test(wxid) || wxid.includes('<') || wxid.length > 96) return false
  if (/^(wxid_|gh_|fmessage|tmessage|weixin|qqmail|medianote)/i.test(wxid)) return true
  if (/^[a-zA-Z][\w.-]{1,63}$/.test(wxid)) return true
  return false
}

/**
 * @param {unknown} raw
 * @returns {{ declared: boolean, empty: boolean, count: number, sawList: boolean, listCount: number, reportedCount: number }}
 */
function inspectMemberPayload(raw) {
  let sawList = false
  let listCount = 0
  let reportedCount = 0
  const seen = new Set()
  const walk = (value, depth = 0) => {
    if (value == null || depth > 8) return
    if (typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const row = /** @type {Record<string, unknown>} */ (value)
    for (const key of ['memberCount', 'member_count', 'MemberCount']) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) continue
      const n = Number(row[key])
      if (Number.isFinite(n) && n >= 0) reportedCount = Math.max(reportedCount, n)
    }
    for (const key of ['chatRoomMember', 'memberList', 'members', 'memberlist', 'allMemberUserNameList', 'memberUserNameList']) {
      if (!Object.prototype.hasOwnProperty.call(row, key)) continue
      const list = row[key]
      if (!Array.isArray(list)) continue
      sawList = true
      listCount = Math.max(listCount, list.length)
    }
    for (const key of Object.keys(row)) walk(row[key], depth + 1)
  }
  walk(raw)
  const declared = sawList || reportedCount > 0
  const count = sawList ? listCount : reportedCount
  const empty = sawList ? listCount === 0 : (declared && reportedCount === 0)
  return { declared, empty, count, sawList, listCount, reportedCount }
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isMemberAccessDenied(raw) {
  if (raw == null || typeof raw !== 'object') return false
  const body = /** @type {Record<string, unknown>} */ (raw)
  const code = Number(body.errCode ?? body.code ?? body.ret ?? body?.baseResponse?.ret)
  const msg = String(
    body.errMsg ?? body.message ?? body.msg
    ?? (body.baseResponse && typeof body.baseResponse === 'object'
      ? (/** @type {Record<string, unknown>} */ (body.baseResponse).errMsg ?? '')
      : ''),
  )
  const text = typeof msg === 'object' ? JSON.stringify(msg) : msg
  if (/移出|退出|不在群|不是群成员|no\s*permission|not\s*in\s*chatroom|ticket/i.test(text)) return true
  if (Number.isFinite(code) && code !== 0 && code !== 1) {
    const payload = inspectMemberPayload(raw)
    if (!payload.declared || payload.empty) return true
  }
  return false
}

/**
 * @param {unknown} raw
 * @param {string} accountWxid
 * @returns {boolean|null}
 */
function membersContainAccount(raw, accountWxid) {
  const account = String(accountWxid || '').trim()
  if (!account || raw == null) return null
  const found = new Set()
  const seen = new Set()
  const walk = (value, depth = 0) => {
    if (value == null || depth > 8) return
    if (typeof value === 'string') {
      if (looksLikeMemberWxid(value)) found.add(value.trim())
      return
    }
    if (typeof value !== 'object') return
    if (seen.has(value)) return
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    const row = /** @type {Record<string, unknown>} */ (value)
    const wxid = unwrapWxid(
      row.userName ?? row.username ?? row.UserName ?? row.wxid ?? row.memberWxid ?? row.member_wxid,
    )
    if (looksLikeMemberWxid(wxid)) found.add(wxid)
    for (const key of Object.keys(row)) walk(row[key], depth + 1)
  }
  walk(raw)
  if (found.size) return found.has(account)
  const payload = inspectMemberPayload(raw)
  if (payload.empty) return false
  if (isMemberAccessDenied(raw)) return false
  if (payload.declared && payload.count > 0) return null
  return null
}

/**
 * @param {unknown} raw
 * @param {string} accountWxid
 * @param {{ httpOk?: boolean, strongEvidence?: boolean }} [opts]
 * @returns {boolean|null}
 */
function resolveSelfStillInMembers(raw, accountWxid, opts = {}) {
  const account = String(accountWxid || '').trim()
  if (!account) return null
  if (opts.httpOk === false) {
    if (opts.strongEvidence && raw != null && (isMemberAccessDenied(raw) || inspectMemberPayload(raw).empty)) {
      return false
    }
    return null
  }
  const hit = membersContainAccount(raw, account)
  if (hit !== null) return hit
  if (opts.strongEvidence && raw != null && isMemberAccessDenied(raw)) return false
  return null
}

/**
 * 是否允许执行「取消通讯录 + quit_and_del + 永久屏蔽」。
 * @param {{
 *   instanceId?: string,
 *   roomId?: string,
 *   owned?: boolean,
 *   inLiveRoomList?: boolean,
 *   liveRoomCount?: number,
 *   selfStillInMembers?: boolean|null,
 *   confirmCount?: number,
 *   evidenceStrength?: string,
 *   evidence?: string,
 * }} input
 * @returns {{ ok: boolean, reason: string }}
 */
function canCleanupKickedRoom(input = {}) {
  const instanceId = String(input.instanceId || '').trim()
  const roomId = String(input.roomId || '').trim()
  if (!instanceId || !roomId.endsWith('@chatroom')) return { ok: false, reason: 'INVALID_TARGET' }

  const evidence = String(input.evidence || '')

  // 系统消息「你被移出」：文案已明确本人被踢，允许立刻清理
  if (evidence === 'SYSTEM_MSG_SELF_KICKED') {
    return { ok: true, reason: 'SYSTEM_MSG_READY' }
  }

  // 退群回调含本人：可能是误报，必须确认本人已不在成员列表；仍在群则禁止清理
  if (evidence === 'LEAVE_CALLBACK_SELF') {
    if (input.selfStillInMembers === true) return { ok: false, reason: 'SELF_STILL_MEMBER' }
    if (input.selfStillInMembers !== false) return { ok: false, reason: 'MEMBER_CHECK_INCONCLUSIVE' }
    return { ok: true, reason: 'LEAVE_CALLBACK_CONFIRMED' }
  }

  if (!input.owned) return { ok: false, reason: 'NOT_OWNED_BY_INSTANCE' }

  // 其它历史弱证据：更严，需两次确认本人不在群
  const liveRoomCount = Math.max(Number(input.liveRoomCount) || 0, 0)
  if (liveRoomCount < 1) return { ok: false, reason: 'LIVE_LIST_EMPTY' }
  if (input.selfStillInMembers !== false) {
    return { ok: false, reason: input.selfStillInMembers === true ? 'SELF_STILL_MEMBER' : 'MEMBER_CHECK_INCONCLUSIVE' }
  }
  const strength = String(input.evidenceStrength || '')
  const confirmCount = Math.max(Number(input.confirmCount) || 0, 0)
  if ((strength === 'strong' || strength === 'weak') && confirmCount >= 2) return { ok: true, reason: 'READY' }
  return { ok: false, reason: 'NEED_MORE_CONFIRM' }
}

/**
 * 是否属于可立刻清理、无需成员复核的证据。
 * @param {string} evidence
 * @returns {boolean}
 */
function isImmediateKickEvidence(evidence) {
  return String(evidence || '') === 'SYSTEM_MSG_SELF_KICKED'
}

/**
 * 是否属于需成员复核后才能清理的退群回调证据。
 * @param {string} evidence
 * @returns {boolean}
 */
function isLeaveCallbackEvidence(evidence) {
  return String(evidence || '') === 'LEAVE_CALLBACK_SELF'
}

/**
 * 从微信历史消息行构造可判定事件。
 * 仅接受系统通知类型 10000/10002，用户发言（1 等）即使文案相同也忽略。
 * @param {string} roomId
 * @param {string} content
 * @param {unknown} msgType
 * @returns {{ roomId: string, roomName: string, evidence: string, strength: 'strong' } | null}
 */
function kickHitFromHistoryMessage(roomId, content, msgType) {
  const room = String(roomId || '').trim()
  if (!room.endsWith('@chatroom')) return null
  const typeNum = Number(msgType)
  if (typeNum !== 10000 && typeNum !== 10002) return null
  const text = String(content || '')
  if (!text) return null
  const event = {
    fromUserName: room,
    roomId: room,
    msgType: typeNum,
    real_content: text,
    content: text,
  }
  return extractSelfKickedEvent(event, '')
}

module.exports = {
  isSelfKickedText,
  extractSelfKickedEvent,
  extractSelfKickedFromLeave,
  extractSelfKickedFromSystemMessage,
  looksLikeSystemKickMessage,
  isLeaveCallbackDesc,
  preferKickEvidence,
  membersContainAccount,
  resolveSelfStillInMembers,
  inspectMemberPayload,
  isMemberAccessDenied,
  canCleanupKickedRoom,
  isImmediateKickEvidence,
  isLeaveCallbackEvidence,
  kickHitFromHistoryMessage,
}
