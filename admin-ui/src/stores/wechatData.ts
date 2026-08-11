import { computed, ref } from 'vue'
import { callWechat, listInstances, type WechatInstance } from '../services/wechat'

export interface ContactRow {
  wxid: string
  nickname: string
  remark: string
  alias: string
  avatar: string
  isGroup: boolean
  sourceInstanceId: string
}

export interface GroupRow {
  id: string
  roomId: string
  name: string
  members: number
  owner: string
  avatar: string
  saved: boolean
  sourceInstanceId: string
  raw: Record<string, unknown>
}

export interface MemberRow {
  wxid: string
  nickname: string
  avatar: string
  inviter: string
  flag: number
  roomId: string
  sourceInstanceId: string
  raw: Record<string, unknown>
}

export const instances = ref<WechatInstance[]>([])
export const contacts = ref<ContactRow[]>([])
export const groups = ref<GroupRow[]>([])
export const members = ref<MemberRow[]>([])
export const loading = ref(false)
let directoryRefreshPromise: Promise<{ contacts: ContactRow[]; groups: GroupRow[] }> | null = null
let directoryRefreshKey = ''
let directoryRefreshedAt = 0
export const friends = computed(() => contacts.value.filter((item) => !item.isGroup))
export const savedGroups = computed(() => contacts.value.filter((item) => item.isGroup))

/**
 * 被踢群清理完成后立刻从内存通讯录移除，避免仍显示「已保存」。
 */
export function applyBlockedRoomRemoved(payload: { instanceId?: string; roomId?: string }) {
  const instanceId = String(payload?.instanceId || '')
  const roomId = String(payload?.roomId || '')
  if (!instanceId || !roomId.endsWith('@chatroom')) return
  contacts.value = contacts.value.filter((item) => !(item.sourceInstanceId === instanceId && item.wxid === roomId))
  groups.value = groups.value.filter((item) => !(item.sourceInstanceId === instanceId && item.roomId === roomId))
  members.value = members.value.filter((item) => !(item.sourceInstanceId === instanceId && item.roomId === roomId))
}

let stopBlockedListener: (() => void) | undefined
let directoryRestoreTimer: ReturnType<typeof setTimeout> | undefined
const directoryRestorePending = new Set<string>()

export function ensureBlockedDirectoryListener() {
  if (stopBlockedListener || typeof window === 'undefined') return
  stopBlockedListener = window.wxControl?.onBlockedDirectoryChanged?.((payload) => {
    const action = String((payload as { action?: string })?.action || 'exclude')
    const instanceId = String(payload?.instanceId || '')
    if (action === 'restore') {
      if (!instanceId) return
      directoryRestorePending.add(instanceId)
      if (directoryRestoreTimer) clearTimeout(directoryRestoreTimer)
      directoryRestoreTimer = setTimeout(() => {
        const ids = [...directoryRestorePending]
        directoryRestorePending.clear()
        directoryRestoreTimer = undefined
        for (const id of ids) void refreshDirectory([id], { force: true }).catch(() => { /* ignore */ })
      }, 300)
      return
    }
    applyBlockedRoomRemoved(payload)
  })
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringOf(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string') return value
    if (value && typeof value === 'object' && typeof object(value).String === 'string') return object(value).String as string
  }
  return ''
}

function numberOf(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = Number(source[key])
    if (Number.isFinite(value)) return value
  }
  return 0
}

function directorySyncPayload(replacement: { contactInstanceIds?: string[]; groupInstanceIds?: string[]; memberRooms?: Array<{ instanceId: string; roomId: string }> } = {}) {
  return {
    contacts: contacts.value.map(({ wxid, nickname, remark, alias, avatar, isGroup, sourceInstanceId }) => ({ wxid, nickname, remark, alias, avatar, isGroup, sourceInstanceId })),
    groups: groups.value.map(({ roomId, name, members: memberCount, owner, avatar, saved, sourceInstanceId }) => ({ roomId, name, members: memberCount, owner, avatar, saved, sourceInstanceId })),
    members: members.value.map(({ wxid, nickname, avatar, inviter, flag, roomId, sourceInstanceId }) => ({ wxid, nickname, avatar, inviter, flag, roomId, sourceInstanceId })),
    replacement,
  }
}

function ownershipKey(instanceId: string, objectId: string) { return `${instanceId}\u0000${objectId}` }

function groupMemberCount(source: Record<string, unknown>) {
  for (const container of [source, object(source.newChatroomData), object(source.new_chatroom_data)]) {
    for (const key of ['allMemberCount', 'memberCount', 'member_count']) {
      if (container[key] !== undefined && container[key] !== null) {
        const value = Number(container[key])
        if (Number.isFinite(value) && value >= 0) return value
      }
    }
    for (const key of ['chatRoomMember', 'members', 'memberList']) {
      if (Array.isArray(container[key])) return container[key].length
    }
  }
  return -1
}

function groupDisplayName(primary: Record<string, unknown>, fallback: Record<string, unknown>, selfWxid: string, count: number, roomId: string) {
  const explicit = stringOf(primary, ['nickName', 'nick_name', 'nickname', 'name', 'displayName']) || stringOf(fallback, ['nickName', 'nick_name', 'nickname', 'name', 'displayName'])
  if (explicit && explicit !== roomId && explicit !== '未命名群聊') return explicit
  const memberRows = findArray(primary, ['chatRoomMember', 'members', 'memberList']).length
    ? findArray(primary, ['chatRoomMember', 'members', 'memberList'])
    : findArray(fallback, ['chatRoomMember', 'members', 'memberList'])
  const names = memberRows
    .filter((member) => stringOf(member, ['userName', 'username', 'wxid']) !== selfWxid)
    .map((member) => stringOf(member, ['displayName', 'nickName', 'nickname']))
    .filter(Boolean)
  if (names.length) {
    const shown = names.slice(0, 2).join('、')
    return count > names.slice(0, 2).length ? `${shown}...(${count})` : count >= 0 ? `${shown}(${count})` : shown
  }
  return count >= 0 ? `群聊（${count}人）` : '群聊'
}

function findArray(value: unknown, preferredKeys: string[], seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  if (Array.isArray(value)) {
    if (value.some((item) => item && typeof item === 'object')) return value.map(object)
    return []
  }
  const source = object(value)
  for (const key of preferredKeys) {
    if (Array.isArray(source[key])) return (source[key] as unknown[]).map(object)
  }
  for (const child of Object.values(source)) {
    const found = findArray(child, preferredKeys, seen)
    if (found.length) return found
  }
  return []
}

/**
 * 判断对象是否像群聊条目（含 @chatroom 标识）。
 * @param raw 单条候选数据
 * @returns 是否群聊
 */
function isChatroomLike(raw: Record<string, unknown>) {
  const roomId = stringOf(raw, ['roomId', 'room_id', 'chatroomId', 'userName', 'username', 'wxid', 'UserName'])
  return Boolean(roomId && roomId.endsWith('@chatroom'))
}

/**
 * 在嵌套结构中选出「含群聊对象最多」的数组，避免误命中小数组导致群列表被截断。
 * @param value 接口原始响应
 * @param seen 循环引用保护
 * @returns 群聊候选对象数组
 */
function findLargestChatroomArray(value: unknown, seen = new Set<unknown>()): Record<string, unknown>[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return []
  seen.add(value)
  let best: Record<string, unknown>[] = []
  const score = (rows: Record<string, unknown>[]) => rows.filter(isChatroomLike).length
  if (Array.isArray(value)) {
    const rows = value.filter((item) => item && typeof item === 'object').map(object)
    if (score(rows) > score(best)) best = rows
    for (const child of value) {
      const found = findLargestChatroomArray(child, seen)
      if (score(found) > score(best)) best = found
    }
    return best
  }
  for (const child of Object.values(value)) {
    const found = findLargestChatroomArray(child, seen)
    if (score(found) > score(best)) best = found
  }
  return best
}

/**
 * 从群相关接口响应中收集群聊行；优先约定字段，回退为最大群聊数组。
 * @param raw 接口原始响应
 * @returns 群聊对象列表
 */
function collectChatroomRows(raw: unknown): Record<string, unknown>[] {
  const preferred = findArray(raw, ['chatrooms', 'rooms', 'room_list', 'list', 'data'])
  const preferredCount = preferred.filter(isChatroomLike).length
  if (preferredCount > 0 && preferredCount >= Math.max(1, Math.floor(preferred.length * 0.2))) return preferred
  return findLargestChatroomArray(raw)
}

/**
 * 将单条群聊写入 groupMap（多源合并时以已有字段为底，新数据补全）。
 * @param groupMap 群聊结果集
 * @param instance 当前微信实例
 * @param contactMap 通讯录（用于 saved）
 * @param roomId 群 ID
 * @param raw 主数据
 * @param cached 缓存资料（可为空）
 */
function upsertGroupRow(
  groupMap: Map<string, GroupRow>,
  instance: WechatInstance,
  contactMap: Map<string, ContactRow>,
  roomId: string,
  raw: Record<string, unknown>,
  cached: Record<string, unknown> = {},
) {
  if (!roomId.endsWith('@chatroom')) return
  const key = ownershipKey(instance.id, roomId)
  const previous = groupMap.get(key)
  const mergedRaw = { ...(previous?.raw || {}), ...raw, ...cached }
  const members = groupMemberCount(cached) >= 0
    ? groupMemberCount(cached)
    : groupMemberCount(raw) >= 0
      ? groupMemberCount(raw)
      : (previous?.members ?? -1)
  const name = groupDisplayName(cached, raw, instance.accountWxid || '', members, roomId)
    || previous?.name
    || roomId
  groupMap.set(key, {
    id: key,
    roomId,
    name: name && name !== '未命名群聊' ? name : (previous?.name || name || roomId),
    members,
    owner: stringOf(cached, ['chatRoomOwner', 'owner']) || stringOf(raw, ['chatRoomOwner', 'owner']) || previous?.owner || '',
    avatar: stringOf(cached, ['big_head_url', 'small_head_url', 'bigHeadImgUrl', 'smallHeadImgUrl'])
      || stringOf(raw, ['big_head_url', 'small_head_url', 'bigHeadImgUrl', 'smallHeadImgUrl'])
      || previous?.avatar
      || '',
    // saved 仅看通讯录；勿用 previous.saved 粘滞，否则取消保存后合并阶段会一直显示已保存
    saved: contactMap.has(key),
    sourceInstanceId: instance.id,
    raw: mergedRaw,
  })
}

export async function refreshInstances() {
  instances.value = await listInstances()
  return instances.value
}

export async function refreshDirectory(instanceIds?: string[], options?: { force?: boolean }) {
  const force = Boolean(options?.force)
  const refreshKey = [...(instanceIds ?? [])].sort().join(',') || 'ALL'
  // 取消保存等写操作后必须强制重拉；否则 5 秒缓存 / 进行中的旧刷新会让 UI 仍显示「已保存」
  if (!force && directoryRefreshPromise) return directoryRefreshPromise
  if (!force && refreshKey === directoryRefreshKey && Date.now() - directoryRefreshedAt < 5000) {
    return { contacts: contacts.value, groups: groups.value }
  }
  if (force && directoryRefreshPromise) {
    try { await directoryRefreshPromise } catch { /* 旧刷新失败不阻断强制刷新 */ }
  }
  loading.value = true
  directoryRefreshPromise = (async () => {
    await refreshInstances()
    const selected = instances.value.filter((item) => item.status === 'ONLINE' && (!instanceIds?.length || instanceIds.includes(item.id)))
    const blockedByInstance = await window.wxControl?.listBlockedRoomIds?.(selected.map((item) => item.id)) ?? {}
    const contactMap = new Map(contacts.value.map((item) => [ownershipKey(item.sourceInstanceId, item.wxid), item]))
    const groupMap = new Map(groups.value.map((item) => [ownershipKey(item.sourceInstanceId, item.roomId), item]))
    const refreshedContactInstances: string[] = []
    const refreshedGroupInstances: string[] = []
    const refreshFailures: string[] = []
    for (const instance of selected) {
      const blockedRooms = new Set(blockedByInstance[instance.id] || [])
      // 群聊列表接口常不完整：需合并群列表、群缓存、通讯录群、全量群详情
      const [contactResponse, groupResponse, groupCacheResponse, allRoomResponse] = await Promise.all([
        callWechat(instance, '/api/get_contact_list2', {}, 438557598),
        callWechat(instance, '/api/get_chatroom_list', {}, 438557576),
        callWechat(instance, '/api/batch_getroom_cache', {}, 438557589),
        callWechat(instance, '/api/get_all_room_detail', {}, 438557605, 90000),
      ])
      const failed = [
        ['好友列表', contactResponse],
        ['群聊列表', groupResponse],
        ['群聊资料', groupCacheResponse],
        ['全量群详情', allRoomResponse],
      ].filter(([, response]) => !(response as { ok: boolean }).ok)
      for (const [operation, rawResponse] of failed) {
        const response = rawResponse as { error?: string }
        // 全量群详情为增强源，失败不阻断；其余失败继续合并可用源
        if (operation === '全量群详情') continue
        refreshFailures.push(`${instance.nickname || instance.accountWxid || '当前微信'}读取${operation}失败：${response.error || '微信接口未正常返回'}`)
      }
      if (contactResponse.ok) {
        refreshedContactInstances.push(instance.id)
        for (const key of [...contactMap.keys()]) if (key.startsWith(`${instance.id}\u0000`)) contactMap.delete(key)
        for (const raw of findArray(contactResponse.raw, ['friend_list', 'contacts', 'data'])) {
          const wxid = stringOf(raw, ['wxid', 'userName', 'UserName'])
          if (!wxid) continue
          if (wxid.endsWith('@chatroom') && blockedRooms.has(wxid)) continue
          contactMap.set(ownershipKey(instance.id, wxid), {
            wxid,
            nickname: stringOf(raw, ['nick_name', 'nickName', 'nickname']),
            remark: stringOf(raw, ['remark', 'displayName']),
            alias: stringOf(raw, ['alias']),
            avatar: stringOf(raw, ['big_head_url', 'bigHeadImgUrl', 'small_head_url']),
            isGroup: wxid.endsWith('@chatroom'),
            sourceInstanceId: instance.id,
          })
        }
      }
      const cachedGroups = new Map<string, Record<string, unknown>>()
      for (const raw of collectChatroomRows(groupCacheResponse.ok ? groupCacheResponse.raw : null)) {
        const roomId = stringOf(raw, ['roomId', 'room_id', 'chatroomId', 'userName', 'username', 'wxid', 'UserName'])
        if (roomId.endsWith('@chatroom') && !blockedRooms.has(roomId)) cachedGroups.set(roomId, raw)
      }
      for (const raw of collectChatroomRows(allRoomResponse.ok ? allRoomResponse.raw : null)) {
        const roomId = stringOf(raw, ['roomId', 'room_id', 'chatroomId', 'userName', 'username', 'wxid', 'UserName'])
        if (!roomId.endsWith('@chatroom') || blockedRooms.has(roomId)) continue
        cachedGroups.set(roomId, { ...(cachedGroups.get(roomId) || {}), ...raw })
      }
      const listRows = collectChatroomRows(groupResponse.ok ? groupResponse.raw : null)
      const hasAuthoritativeGroupSource = groupResponse.ok || groupCacheResponse.ok || allRoomResponse.ok
      if (hasAuthoritativeGroupSource) {
        refreshedGroupInstances.push(instance.id)
        for (const key of [...groupMap.keys()]) if (key.startsWith(`${instance.id}\u0000`)) groupMap.delete(key)
      }
      let mergedCount = 0
      for (const raw of listRows) {
        const roomId = stringOf(raw, ['roomId', 'room_id', 'chatroomId', 'userName', 'username', 'wxid', 'UserName'])
        if (!roomId || blockedRooms.has(roomId)) continue
        upsertGroupRow(groupMap, instance, contactMap, roomId, raw, cachedGroups.get(roomId) || {})
        mergedCount += 1
      }
      // 群缓存 / 全量详情中有、但群列表未返回的群，一并补齐
      for (const [roomId, cached] of cachedGroups) {
        if (blockedRooms.has(roomId)) continue
        if (groupMap.has(ownershipKey(instance.id, roomId))) continue
        upsertGroupRow(groupMap, instance, contactMap, roomId, cached, {})
        mergedCount += 1
      }
      // 通讯录里保存的群（get_chatroom_list 经常漏掉未会话群）
      for (const contact of contactMap.values()) {
        if (contact.sourceInstanceId !== instance.id || !contact.isGroup) continue
        if (blockedRooms.has(contact.wxid)) continue
        if (groupMap.has(ownershipKey(instance.id, contact.wxid))) continue
        upsertGroupRow(groupMap, instance, contactMap, contact.wxid, {
          username: contact.wxid,
          nick_name: contact.nickname,
          remark: contact.remark,
          big_head_url: contact.avatar,
          small_head_url: contact.avatar,
        }, cachedGroups.get(contact.wxid) || {})
        mergedCount += 1
      }
      // 已屏蔽被踢群：确保不会残留在内存目录
      for (const roomId of blockedRooms) {
        contactMap.delete(ownershipKey(instance.id, roomId))
        groupMap.delete(ownershipKey(instance.id, roomId))
      }
      if (!hasAuthoritativeGroupSource && mergedCount > 0 && !refreshedGroupInstances.includes(instance.id)) {
        refreshedGroupInstances.push(instance.id)
      }
    }
    contacts.value = [...contactMap.values()]
    groups.value = [...groupMap.values()].map((item) => ({ ...item, saved: refreshedContactInstances.includes(item.sourceInstanceId) ? contactMap.has(ownershipKey(item.sourceInstanceId, item.roomId)) : item.saved }))
    for (const reason of refreshFailures) await window.wxControl?.reportError?.('刷新通讯录部分失败', { reason })
    try {
      await window.wxControl?.syncDirectory?.(directorySyncPayload({ contactInstanceIds: refreshedContactInstances, groupInstanceIds: refreshedGroupInstances }))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`通讯录读取成功，但保存读取结果失败：${reason}`)
    }
    directoryRefreshKey = refreshKey
    directoryRefreshedAt = Date.now()
    return { contacts: contacts.value, groups: groups.value }
  })().catch(async (error) => {
    const message = error instanceof Error ? error.message : '刷新通讯录失败'
    await window.wxControl?.reportError?.('刷新通讯录失败', { reason: message })
    throw error
  }).finally(() => { loading.value = false; directoryRefreshPromise = null })
  return directoryRefreshPromise
}

export async function loadMembers(instanceId: string, roomId: string) {
  const instance = instances.value.find((item) => item.id === instanceId) ?? (await refreshInstances()).find((item) => item.id === instanceId)
  if (!instance) throw new Error('找不到所选微信，请刷新后重试')
  const blocked = await window.wxControl?.listBlockedRoomIds?.([instanceId]) ?? {}
  if ((blocked[instanceId] || []).includes(roomId)) throw new Error('该群已被确认为被踢群并永久屏蔽，不再加载成员')
  loading.value = true
  const response = await callWechat(instance, '/api/get_room_members', { room_id: roomId }, 438557503)
  if (!response.ok) { loading.value = false; throw new Error(response.error || '获取群成员失败') }
  members.value = findArray(response.raw, ['chatRoomMember', 'members', 'memberList']).map((raw) => ({
    wxid: stringOf(raw, ['userName', 'username', 'wxid', 'memberWxid']),
    nickname: stringOf(raw, ['nickName', 'nickname', 'displayName']),
    avatar: stringOf(raw, ['bigHeadImgUrl', 'smallHeadImgUrl']),
    inviter: stringOf(raw, ['inviterUserName']),
    flag: numberOf(raw, ['chatroomMemberFlag', 'memberFlag']),
    roomId,
    sourceInstanceId: instance.id,
    raw,
  })).filter((item) => item.wxid)
  const count = groupMemberCount(object(response.raw))
  groups.value = groups.value.map((group) => group.roomId === roomId && group.sourceInstanceId === instance.id ? { ...group, members: count >= 0 ? count : members.value.length } : group)
  await window.wxControl?.syncDirectory?.(directorySyncPayload({ memberRooms: [{ instanceId: instance.id, roomId }] }))
  loading.value = false
  return members.value
}
