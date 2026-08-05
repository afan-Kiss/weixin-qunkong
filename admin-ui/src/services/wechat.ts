import { userErrorMessage } from '../utils/error'

export interface WechatInstance {
  id: string
  apiPort: number
  tcpPort: number
  pid?: number
  accountWxid?: string
  /** 用户可见微信号（profile.alias），未设置时可能为空 */
  alias?: string
  nickname?: string
  avatar?: string
  status: 'STOPPED' | 'RESTORING' | 'STARTING' | 'WAITING_LOGIN' | 'ONLINE' | 'ERROR'
  managed?: boolean
}

export interface ApiResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  sourceId?: number
  contractStatus?: string
  raw?: unknown
}

const instances = new Map<string, WechatInstance>()
let nextId = 1

function pickPorts() {
  const used = new Set([...instances.values()].flatMap((item) => [item.apiPort, item.tcpPort]))
  let apiPort = 19088
  while (used.has(apiPort)) apiPort += 2
  let tcpPort = 61108
  while (used.has(tcpPort) || tcpPort === apiPort) tcpPort += 2
  return { apiPort, tcpPort }
}

export async function listInstances(): Promise<WechatInstance[]> {
  if (window.wxControl?.listInstances) return window.wxControl.listInstances()
  return [...instances.values()]
}

export async function startInstance(): Promise<ApiResult<WechatInstance>> {
  if (window.wxControl?.startInstance) return window.wxControl.startInstance()
  const ports = pickPorts()
  const instance: WechatInstance = { id: `instance-${nextId++}`, ...ports, status: 'STARTING' }
  instances.set(instance.id, instance)
  return { ok: true, data: instance }
}

export async function stopInstance(id: string, closeWechat = true): Promise<ApiResult<{ closedWechat: boolean }>> {
  if (window.wxControl?.stopInstance) return window.wxControl.stopInstance(id, closeWechat)
  instances.delete(id)
  return { ok: true, data: { closedWechat: false } }
}

export async function callWechat<T>(instance: WechatInstance, path: string, body?: unknown, sourceId?: number, timeoutMs = 30000): Promise<ApiResult<T>> {
  if (window.wxControl?.callApi) return window.wxControl.callApi(instance.id, path, body, sourceId, timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${instance.apiPort}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    const raw = await response.json()
    return { ok: response.ok, data: raw as T, raw, sourceId, contractStatus: 'RESPONSE_VERIFY' }
  } catch (error) {
    return { ok: false, error: userErrorMessage(error, '微信操作失败'), sourceId, contractStatus: 'RESPONSE_VERIFY' }
  }
}

function findFriendCredential(value: unknown, key: 'v3' | 'v4'): string {
  const seen = new Set<unknown>()
  function walk(item: unknown): string {
    if (typeof item === 'string') {
      const text = item.trim()
      if (text.toLowerCase().startsWith(`${key}_`)) return text
      if ((text.startsWith('{') || text.startsWith('[')) && text.length < 2_000_000) {
        try { return walk(JSON.parse(text)) } catch { /* 不是 JSON 字符串 */ }
      }
      return ''
    }
    if (!item || typeof item !== 'object' || seen.has(item)) return ''
    seen.add(item)
    const source = item as Record<string, unknown>
    const candidates = key === 'v3'
      ? [source.encryptUserName, source.encryptedUserName, source.encrypt_user_name, source.userName, source.user_name]
      : [source.antispamTicket, source.antispamticket, source.antiSpamTicket, source.antispam_ticket, source.anti_spam_ticket]
    for (const candidate of candidates) {
      const text = typeof candidate === 'string'
        ? candidate
        : candidate && typeof candidate === 'object' && typeof (candidate as Record<string, unknown>).String === 'string'
          ? String((candidate as Record<string, unknown>).String)
          : ''
      if (text && (key === 'v4' ? text.toLowerCase().startsWith('v4') : text.toLowerCase().startsWith('v3'))) return text
    }
    for (const child of Object.values(source)) {
      const result = walk(child)
      if (result) return result
    }
    return ''
  }
  const found = walk(value)
  if (found) return found
  // 兼容凭证藏在 XML、日志文本或未解析 protobuf 字符串中的响应。
  let serialized = ''
  try { serialized = typeof value === 'string' ? value : JSON.stringify(value) } catch {}
  const match = serialized.match(new RegExp(`${key}_[^"'\\s<>]+`, 'i'))
  return match?.[0] || ''
}

/** 按微信接口能力逐级补齐陌生群成员的 v3/v4 加好友凭证。 */
export async function resolveFriendCredentialsLegacy(instance: WechatInstance, wxid: string, roomId: string) {
  let v3 = String(wxid || '').toLowerCase().startsWith('v3_') ? String(wxid) : ''
  let v4 = String(wxid || '').toLowerCase().startsWith('v4_') ? String(wxid) : ''
  const attempts: string[] = []
  const merge = (raw: unknown, label: string) => {
    const nextV3 = findFriendCredential(raw, 'v3')
    const nextV4 = findFriendCredential(raw, 'v4')
    v3 ||= nextV3
    v4 ||= nextV4
    attempts.push(`${label}[v3:${nextV3 ? 'yes' : 'no'},v4:${nextV4 ? 'yes' : 'no'}]`)
  }

  const waitForProfileCache = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds))

  const group = await callWechat(instance, '/api/get_group_member_contact', { wxid, roomId }, 438557510)
  if (group.ok) merge(group.raw, '群成员资料')
  if (!v3 || !v4) {
    const contact = await callWechat(instance, '/api/get_contact', { wxid }, 438557509)
    if (contact.ok) merge(contact.raw, '网络联系人资料')
  }
  if (!v3 || !v4) {
    const fast = await callWechat(instance, '/api/get_contact_fast', { wxid }, 438557522)
    if (fast.ok) merge(fast.raw, '联系人缓存')
  }
  if (!v3 || !v4) {
    // Network profile requests may finish before WeChat writes the profile into its contact cache.
    for (let round = 1; round <= 3 && (!v3 || !v4); round += 1) {
      await waitForProfileCache(round === 1 ? 800 : 1200)
      const contact = await callWechat(instance, '/api/get_contact', { wxid }, 438557509)
      if (contact.ok) merge(contact.raw, `network-profile-retry-${round}`)
      if (v3 && v4) break
      const fast = await callWechat(instance, '/api/get_contact_fast', { wxid }, 438557522)
      if (fast.ok) merge(fast.raw, `contact-cache-retry-${round}`)
    }
    const searched = await callWechat(instance, '/api/net_scene_search_contact', { search: wxid }, 438557506)
    if (searched.ok) merge(searched.raw, '网络搜索资料')
  }
  return { v3, v4, attempts, missing: [!v3 ? 'v3' : '', !v4 ? 'v4' : ''].filter(Boolean) }
}

type AnyRecord = Record<string, unknown>

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readWechatString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!isRecord(value)) return undefined
  for (const key of ['String', 'string', 'value']) {
    const nested = value[key]
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
  }
  return undefined
}

function unwrapWechatPayload(raw: unknown): AnyRecord {
  if (!isRecord(raw)) return {}
  const data = raw.data
  if (isRecord(data) && ('contactList' in data || 'verifyUserValidTicketList' in data || 'baseResponse' in data)) return data
  return raw
}

function toRecordArray(value: unknown): AnyRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord)
  return isRecord(value) ? [value] : []
}

export interface GroupMemberAddCredentials {
  targetWxid: string
  roomId: string
  v3?: string
  v4?: string
  missing: Array<'v3' | 'v4'>
  baseRet?: number
  contactCount: number
  contactListLength: number
  matchedContact: boolean
  matchedTicket: boolean
}

export function resolveGroupMemberAddCredentials(rawResponse: unknown, targetWxid: string, requestedRoomId: string): GroupMemberAddCredentials {
  const payload = unwrapWechatPayload(rawResponse)
  const baseResponse = isRecord(payload.baseResponse) ? payload.baseResponse : undefined
  const baseRet = typeof baseResponse?.ret === 'number' ? baseResponse.ret : undefined
  const contacts = Array.isArray(payload.contactList) ? payload.contactList.filter(isRecord) : []
  const matchedContact = contacts.find((contact) => {
    const username = readWechatString(contact.userName)
    const friendUsername = readWechatString(contact.friendUserName)
    return username === targetWxid || friendUsername === targetWxid
  }) ?? contacts[0]
  const tickets = toRecordArray(payload.verifyUserValidTicketList)
  const matchedTicket = tickets.find((ticket) => readWechatString(ticket.username) === targetWxid) ?? tickets[0]
  let v3 = matchedContact ? readWechatString(matchedContact.encryptUserName) : undefined
  // update_single_profile 等扁平响应：encryptUserName 在顶层
  if (!v3) v3 = readWechatString(payload.encryptUserName)
  if (!v3 && matchedContact) {
    const candidate = readWechatString(matchedContact.userName)
    if (candidate?.toLowerCase().startsWith('v3_')) v3 = candidate
  }
  const v4 = matchedTicket
    ? readWechatString(matchedTicket.antispamticket) ?? readWechatString(matchedTicket.antispamTicket)
    : readWechatString(payload.antispamticket) ?? readWechatString(payload.antispamTicket)
  const roomData = matchedContact && isRecord(matchedContact.newChatroomData) ? matchedContact.newChatroomData : undefined
  const responseRoomId = roomData ? readWechatString(roomData.chatRoomUserName) : undefined
  const validV3 = v3?.toLowerCase().startsWith('v3_') ? v3 : undefined
  const validV4 = v4?.toLowerCase().startsWith('v4_') ? v4 : undefined
  const missing: Array<'v3' | 'v4'> = []
  if (!validV3) missing.push('v3')
  if (!validV4) missing.push('v4')
  return {
    targetWxid, roomId: responseRoomId ?? requestedRoomId, v3: validV3, v4: validV4, missing, baseRet,
    contactCount: typeof payload.contactCount === 'number' ? payload.contactCount : contacts.length,
    contactListLength: contacts.length, matchedContact: Boolean(matchedContact), matchedTicket: Boolean(matchedTicket),
  }
}

export async function resolveFriendCredentials(instance: WechatInstance, wxid: string, roomId: string) {
  const startedAt = Date.now()
  const attempts: string[] = []
  const diagnostics: Array<Record<string, unknown>> = []
  let resolved: GroupMemberAddCredentials | undefined
  const delays = [0, 400, 1000]
  for (let index = 0; index < delays.length; index += 1) {
    if (delays[index]) await new Promise((resolve) => window.setTimeout(resolve, delays[index]))
    const result = await callWechat(instance, '/api/get_group_member_contact', { wxid, roomId }, 438557510)
    resolved = resolveGroupMemberAddCredentials(result.raw, wxid, roomId)
    attempts.push(`get_group_member_contact#${index + 1}[${resolved.missing.join('+') || 'complete'}]`)
    diagnostics.push({
      endpoint: '/api/get_group_member_contact', httpStatus: result.ok ? 200 : 0, baseRet: resolved.baseRet,
      contactCount: resolved.contactCount, contactListLength: resolved.contactListLength,
      matchedContact: resolved.matchedContact, matchedTicket: resolved.matchedTicket,
      hasV3: Boolean(resolved.v3), v3Prefix: resolved.v3?.slice(0, 10), v3Length: resolved.v3?.length || 0,
      hasV4: Boolean(resolved.v4), v4Prefix: resolved.v4?.slice(0, 10), v4Length: resolved.v4?.length || 0,
      missing: resolved.missing.join(','), attempt: index + 1, elapsedMs: Date.now() - startedAt,
      nextAction: resolved.missing.length ? (index < 2 ? 'RETRY_GROUP_PROFILE' : 'FALLBACK_GET_CONTACT') : 'CREATE_TASK', parserVersion: 'har-v1',
    })
    if (result.ok && (resolved.baseRet === 0 || resolved.baseRet === undefined) && !resolved.missing.length) break
  }
  if (resolved?.missing.length) {
    const fallback = await callWechat(instance, '/api/get_contact', { wxid }, 438557509)
    const parsed = resolveGroupMemberAddCredentials(fallback.raw, wxid, roomId)
    attempts.push(`get_contact[${parsed.missing.join('+') || 'complete'}]`)
    diagnostics.push({
      endpoint: '/api/get_contact', httpStatus: fallback.ok ? 200 : 0, baseRet: parsed.baseRet,
      contactCount: parsed.contactCount, contactListLength: parsed.contactListLength,
      matchedContact: parsed.matchedContact, matchedTicket: parsed.matchedTicket,
      hasV3: Boolean(parsed.v3), v3Prefix: parsed.v3?.slice(0, 10), v3Length: parsed.v3?.length || 0,
      hasV4: Boolean(parsed.v4), v4Prefix: parsed.v4?.slice(0, 10), v4Length: parsed.v4?.length || 0,
      missing: parsed.missing.join(','), attempt: 4, elapsedMs: Date.now() - startedAt,
      nextAction: parsed.missing.length ? 'FALLBACK_UPDATE_SINGLE_PROFILE' : 'CREATE_TASK', parserVersion: 'har-v1',
    })
    if (!parsed.missing.length) resolved = parsed
    else {
      // 群接口常仅有 V4；资料接口可补 V3（本机 4.1.8.27 已验证可与 scene 双字段一起发送）
      const profile = await callWechat(instance, '/api/update_single_profile', { wxid }, 438557572)
      const profileParsed = resolveGroupMemberAddCredentials(profile.raw, wxid, roomId)
      const mergedV3 = profileParsed.v3 || resolved.v3
      const mergedV4 = resolved.v4 || profileParsed.v4
      const missing: Array<'v3' | 'v4'> = []
      if (!mergedV3) missing.push('v3')
      if (!mergedV4) missing.push('v4')
      attempts.push(`update_single_profile[${missing.join('+') || 'complete'}]`)
      diagnostics.push({
        endpoint: '/api/update_single_profile', httpStatus: profile.ok ? 200 : 0, baseRet: profileParsed.baseRet,
        hasV3: Boolean(mergedV3), v3Prefix: mergedV3?.slice(0, 10), v3Length: mergedV3?.length || 0,
        hasV4: Boolean(mergedV4), v4Prefix: mergedV4?.slice(0, 10), v4Length: mergedV4?.length || 0,
        missing: missing.join(','), attempt: 5, elapsedMs: Date.now() - startedAt,
        nextAction: missing.length ? 'STOP_MISSING_CREDENTIALS' : 'CREATE_TASK', parserVersion: 'har-v1',
      })
      resolved = {
        ...resolved,
        v3: mergedV3,
        v4: mergedV4,
        missing,
      }
    }
  }
  resolved ??= resolveGroupMemberAddCredentials({}, wxid, roomId)
  return { ...resolved, attempts, diagnostics }
}
