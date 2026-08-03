/**
 * 二维码进群：解析 a8key 预览、判定进群是否真正成功。
 */

/**
 * 递归收集对象中的字符串值。
 * @param {unknown} value
 * @param {string[]} [out]
 * @param {Set<object>} [seen]
 * @returns {string[]}
 */
function collectStrings(value, out = [], seen = new Set()) {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value)
    return out
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return out
  seen.add(value)
  if (typeof value.String === 'string' && value.String.trim()) out.push(value.String)
  for (const child of Object.values(value)) collectStrings(child, out, seen)
  return out
}

/**
 * 在对象树中按候选键名取第一个有意义的值。
 * @param {unknown} root
 * @param {string[]} names
 * @returns {unknown}
 */
function findByNames(root, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  const seen = new Set()
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined
    seen.add(value)
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(String(key).toLowerCase()) && child !== undefined && child !== null && child !== '') {
        if (typeof child === 'object' && child && ('String' in child || 'string' in child)) {
          return child.String ?? child.string
        }
        return child
      }
    }
    for (const child of Object.values(value)) {
      const found = walk(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  return walk(root)
}

/**
 * 规范化群名：过滤链接、群 ID、无意义占位。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRoomName(value) {
  let roomName = typeof value === 'string' ? value.trim() : ''
  if (!roomName) return ''
  roomName = roomName
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!roomName) return ''
  if (roomName.endsWith('@chatroom')) return ''
  if (/^https?:\/\//i.test(roomName)) return ''
  if (/^(微信|WeChat|邀请你加入群聊|加入群聊)$/i.test(roomName)) return ''
  if (roomName.length > 80) roomName = roomName.slice(0, 80)
  return roomName
}

/**
 * 从文本/HTML 中提取群名与人数（邀请页常见文案）。
 * @param {string} text
 * @returns {{ roomName: string, memberCount: number }}
 */
function parseInvitePageText(text) {
  const raw = String(text || '')
  if (!raw.trim()) return { roomName: '', memberCount: 0 }
  // 无登录态时微信返回下载跳转页，不应误解析
  if (/weixin_getdownurl|getdownurl_sms|请在微信客户端打开|请在微信中打开/i.test(raw) && !/memberCount|member_count|人已加入/i.test(raw)) {
    return { roomName: '', memberCount: 0 }
  }

  let memberCount = 0
  const countPatterns = [
    /"member[_]?count"\s*:\s*(\d+)/i,
    /"memberNum"\s*:\s*(\d+)/i,
    /"chatroomMemberCount"\s*:\s*(\d+)/i,
    /memberCount\s*[:=]\s*['"]?(\d+)/i,
    /(\d{1,5})\s*人(?:已加入|在群|)/,
    /群(?:聊)?人数[：:\s]*(\d{1,5})/,
    /共\s*(\d{1,5})\s*人/,
  ]
  for (const pattern of countPatterns) {
    const match = raw.match(pattern)
    if (!match) continue
    const n = Number(match[1])
    if (Number.isFinite(n) && n > 0 && n < 100000) {
      memberCount = n
      break
    }
  }

  let roomName = ''
  const namePatterns = [
    /"nick[_]?name"\s*:\s*"([^"\\]{1,80})"/i,
    /"topic"\s*:\s*"([^"\\]{1,80})"/i,
    /"chatroom[_]?name"\s*:\s*"([^"\\]{1,80})"/i,
    /"roomName"\s*:\s*"([^"\\]{1,80})"/i,
    /"group[_]?name"\s*:\s*"([^"\\]{1,80})"/i,
    /nickName\s*[:=]\s*['"]([^'"]{1,80})['"]/i,
    /邀请你加入群聊[\s\S]{0,120}?([^\n\r<>]{2,40})\s*(?:\d{1,5}\s*人|群聊)/,
    /加入群聊[「“"']([^」”"']{1,40})[」”"']/,
    /群(?:名|名称|聊)[：:\s]*([^\n\r<>]{2,40})/,
    /class="[^"]*(?:nickname|title|group[_-]?name|invite[_-]?title)[^"]*"[^>]*>\s*([^<]{2,40})\s*</i,
    /<(?:h1|h2|strong|p)[^>]*>\s*([^<]{2,40})\s*<\/(?:h1|h2|strong|p)>/i,
    /<title>([^<]{1,80})<\/title>/i,
  ]
  for (const pattern of namePatterns) {
    const match = raw.match(pattern)
    if (!match) continue
    roomName = normalizeRoomName(match[1])
    if (roomName) break
  }

  // 从内嵌 JSON 片段再扫一遍（邀请页 script 常见）
  if (!roomName || !memberCount) {
    const jsonBlocks = raw.match(/\{[^{}]{0,1200}"(?:nick[_]?name|member[_]?count|topic|roomName|group[_]?name)"[^{}]{0,1200}\}/gi) || []
    for (const block of jsonBlocks) {
      try {
        const obj = JSON.parse(block)
        if (!roomName) {
          roomName = normalizeRoomName(obj.nickName || obj.nickname || obj.nick_name || obj.topic || obj.roomName || obj.groupName || obj.group_name)
        }
        if (!memberCount) {
          const n = Number(obj.memberCount || obj.member_count || obj.memberNum || obj.chatroomMemberCount)
          if (Number.isFinite(n) && n > 0) memberCount = n
        }
      } catch { /* 非严格 JSON 忽略 */ }
      if (roomName && memberCount) break
    }
  }

  return { roomName, memberCount }
}

/**
 * 从任意响应中找群 ID。
 * @param {unknown} raw
 * @returns {string}
 */
function findRoomId(raw) {
  const direct = findByNames(raw, [
    'roomId', 'room_id', 'chatRoomId', 'chatroomid', 'chatroomUserName', 'ChatRoomUserName',
  ])
  if (typeof direct === 'string' && direct.endsWith('@chatroom')) return direct
  // userName 仅在明确是群 ID 时采用，避免误取个人 wxid
  const userName = findByNames(raw, ['userName', 'username'])
  if (typeof userName === 'string' && userName.endsWith('@chatroom')) return userName
  for (const text of collectStrings(raw)) {
    if (/^\d+@chatroom$/i.test(text)) return text
    const match = text.match(/(\d{5,}@chatroom)/i)
    if (match) return match[1]
  }
  return ''
}

/**
 * 提取完整邀请 URL。
 * @param {unknown} raw
 * @param {string} [sourceUrl]
 * @returns {string}
 */
function findInviteFullUrl(raw, sourceUrl = '') {
  const keyed = findByNames(raw, ['FullURL', 'fullURL', 'fullUrl', 'full_url', 'ShareURL', 'shareUrl'])
  if (typeof keyed === 'string' && /addchatroombyinvite|weixin\.qq\.com\/g\//i.test(keyed)) {
    return keyed.trim()
  }
  const urlCandidates = collectStrings(raw).filter((text) => /addchatroombyinvite|weixin\.qq\.com\/g\//i.test(text))
  const fullUrl = urlCandidates.find((text) => /addchatroombyinvite/i.test(text))
    || urlCandidates[0]
    || ''
  if (fullUrl) return fullUrl
  // 仅当源链接本身已是邀请链时才回退，避免把短链误当成“已解析完成”
  if (/addchatroombyinvite/i.test(String(sourceUrl || ''))) return String(sourceUrl)
  return String(sourceUrl || '')
}

/**
 * 从 a8key / 进群响应 / 邀请页文本解析群预览信息。
 * @param {unknown} raw get_a8key 或 enter_room 响应
 * @param {string} [sourceUrl] 原始链接
 * @returns {{ roomId: string, roomName: string, memberCount: number, fullUrl: string, expired: boolean, rawText: string }}
 */
function parseInvitePreview(raw, sourceUrl = '') {
  const rawText = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})
  const expired = /二维码.{0,8}(?:过期|失效)|邀请.{0,8}(?:过期|失效)|链接.{0,8}(?:过期|失效)|expired|invalid|已失效/i.test(rawText)
  const roomId = findRoomId(raw)

  // 优先取邀请语义字段；避免 DFS 先撞到成员 nickName / 通用 name
  const nameCandidates = [
    findByNames(raw, ['topic', 'ChatRoomTopic', 'chatroomTopic', 'roomName', 'room_name', 'chatroomName', 'ChatRoomName', 'groupName']),
    findByNames(raw, ['Title', 'title']),
    findByNames(raw, ['nickName', 'nickname', 'chatroomNickname']),
  ]
  let roomName = ''
  for (const candidate of nameCandidates) {
    roomName = normalizeRoomName(candidate)
    if (roomName) break
  }

  const countRaw = findByNames(raw, [
    'memberCount', 'member_count', 'MemberCount', 'chatroomMemberCount', 'memberNum', 'membernum', 'allMemberCount', 'roomMemberCount',
  ])
  let memberCount = Number(countRaw)
  if (!Number.isFinite(memberCount) || memberCount <= 0) memberCount = 0

  // a8key 的 Content / Title 常带邀请页 HTML 或文案
  const contentBits = [
    findByNames(raw, ['Content', 'content', 'Title', 'title']),
    ...collectStrings(raw).filter((text) => /邀请|群聊|member|addchatroombyinvite/i.test(text)).slice(0, 8),
  ]
  for (const bit of contentBits) {
    if (typeof bit !== 'string' || bit.length < 4) continue
    const parsed = parseInvitePageText(bit)
    if (!roomName && parsed.roomName) roomName = parsed.roomName
    if (!memberCount && parsed.memberCount) memberCount = parsed.memberCount
    if (roomName && memberCount) break
  }

  // 整包再扫一遍（兼容 Content 被嵌套/转义）
  if (!roomName || !memberCount) {
    const parsedAll = parseInvitePageText(rawText)
    if (!roomName) roomName = parsedAll.roomName
    if (!memberCount) memberCount = parsedAll.memberCount
  }

  const fullUrl = findInviteFullUrl(raw, sourceUrl)
  return {
    roomId,
    roomName,
    memberCount: Number.isFinite(memberCount) && memberCount > 0 ? memberCount : 0,
    fullUrl,
    expired,
    rawText: rawText.slice(0, 2000),
  }
}

/**
 * 合并多次预览结果（后到的非空字段覆盖）。
 * @param {...object} parts
 * @returns {object}
 */
function mergeInvitePreview(...parts) {
  const base = {
    roomId: '',
    roomName: '',
    memberCount: 0,
    fullUrl: '',
    expired: false,
    rawText: '',
  }
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue
    if (part.roomId) base.roomId = part.roomId
    if (part.roomName) base.roomName = part.roomName
    if (Number(part.memberCount) > 0) base.memberCount = Number(part.memberCount)
    if (part.fullUrl && /addchatroombyinvite/i.test(part.fullUrl)) base.fullUrl = part.fullUrl
    else if (part.fullUrl && !base.fullUrl) base.fullUrl = part.fullUrl
    if (part.expired) base.expired = true
    if (part.rawText) base.rawText = String(part.rawText).slice(0, 2000)
  }
  return base
}

/**
 * 判定 enter_room 是否真正进群成功（不能仅凭 HTTP/errCode=1 + 空 data）。
 * @param {boolean} responseOk HTTP 是否 2xx
 * @param {unknown} raw 响应体
 * @returns {{ ok: boolean, reason: string, roomId: string }}
 */
function evaluateEnterRoomResult(responseOk, raw) {
  const text = JSON.stringify(raw ?? '')
  if (!responseOk) return { ok: false, reason: '进群接口 HTTP 失败', roomId: '' }
  if (/频繁|frequent|too many requests/i.test(text)) return { ok: false, reason: '已经频繁', roomId: '' }
  if (/二维码.{0,8}(?:过期|失效)|邀请.{0,8}(?:过期|失效)|已失效|expired|invalid/i.test(text)) {
    return { ok: false, reason: '邀请已过期或无效', roomId: '' }
  }
  const roomId = findRoomId(raw)
  if (roomId) return { ok: true, reason: '已返回群标识', roomId }
  const data = raw && typeof raw === 'object' ? (raw.data ?? raw.Data ?? null) : null
  const emptyData = data == null
    || (typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0)
    || (Array.isArray(data) && data.length === 0)
  const errCode = Number(raw?.errCode ?? raw?.code ?? raw?.baseResponse?.ret)
  // 本项目常见空成功：errCode=1 + data:{} —— 不能算进群成功
  if (emptyData && (errCode === 1 || errCode === 0 || Number.isNaN(errCode))) {
    return { ok: false, reason: '接口返回空结果，未确认进群（短链需先解析群资料）', roomId: '' }
  }
  if (errCode < 0) return { ok: false, reason: `进群失败（错误码 ${errCode}）`, roomId: '' }
  // 有非空业务数据但无 roomId：记为已提交待确认，不算完成
  if (!emptyData) return { ok: false, reason: '已提交进群申请，但未返回群标识，请到微信确认是否入群', roomId: '' }
  return { ok: false, reason: '未能确认进群成功', roomId: '' }
}

/**
 * 生成给用户看的群预览文案。
 * @param {{ roomName?: string, memberCount?: number, roomId?: string, fullUrl?: string, error?: string }} preview
 * @returns {string}
 */
function formatInvitePreviewLine(preview) {
  if (!preview) return '未知群'
  if (preview.error && !preview.roomName) return `失败：${preview.error}`
  const name = preview.roomName || '未知群名'
  const count = Number(preview.memberCount) > 0 ? `${preview.memberCount} 人` : '人数未知'
  const id = preview.roomId ? ` · ${preview.roomId}` : ''
  return `${name}（${count}${id}）`
}

/**
 * 从 a8key 响应提取可用于抓取邀请页的 HTTP 头。
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
function extractA8KeyHttpHeaders(raw) {
  const headers = {}
  const list = findByNames(raw, ['HttpHeader', 'httpHeader', 'http_header'])
  const rows = Array.isArray(list)
    ? list
    : (list && typeof list === 'object' ? Object.values(list) : [])
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const key = String(row.Key ?? row.key ?? row.name ?? row.Name ?? '').trim()
    const value = String(row.Value ?? row.value ?? row.val ?? row.Val ?? '').trim()
    if (key && value) headers[key] = value
  }
  // 兼容 Cookie 单独字段
  if (!headers.Cookie && !headers.cookie) {
    const cookie = findByNames(raw, ['Cookie', 'cookie', 'HttpCookie', 'httpCookie'])
    if (typeof cookie === 'string' && cookie.trim()) headers.Cookie = cookie.trim()
  }
  return headers
}

/**
 * 组装抓取邀请页所需的 URL 与请求头。
 * get_a8key 本身通常不含群名/人数，需要再 HTTP GET FullURL。
 * @param {unknown} raw get_a8key 响应
 * @param {string} [sourceUrl] 原始短链/邀请链
 * @returns {{ url: string, headers: Record<string, string> }}
 */
function buildInvitePageRequest(raw, sourceUrl = '') {
  const fullUrl = findInviteFullUrl(raw, sourceUrl)
  const url = String(fullUrl || sourceUrl || '').trim()
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 MicroMessenger/7.0.20',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    ...extractA8KeyHttpHeaders(raw),
  }
  return { url, headers }
}

/**
 * 判断预览是否已具备可展示的群资料。
 * @param {{ roomName?: string, memberCount?: number, roomId?: string, fullUrl?: string }} preview
 * @returns {boolean}
 */
function hasUsableInvitePreview(preview) {
  if (!preview || typeof preview !== 'object') return false
  return Boolean(preview.roomName) || Number(preview.memberCount) > 0 || Boolean(preview.roomId)
}

module.exports = {
  collectStrings,
  findByNames,
  findRoomId,
  findInviteFullUrl,
  normalizeRoomName,
  parseInvitePageText,
  parseInvitePreview,
  mergeInvitePreview,
  extractA8KeyHttpHeaders,
  buildInvitePageRequest,
  hasUsableInvitePreview,
  evaluateEnterRoomResult,
  formatInvitePreviewLine,
}
