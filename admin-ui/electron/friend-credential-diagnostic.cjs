/**
 * 白名单好友凭证远程诊断（仅 localhost 微信 API，禁止系统命令/任意 URL）。
 * V3/V4 永不输出全文，只上报存在性、前缀、长度、SHA-256 前 16 位。
 */
const { createHash } = require('crypto')
const { readString, payloadLayers, parseProfileCredentials, rawStructure } = require('./friend-profile.cjs')

const ALLOWED_ENDPOINTS = Object.freeze([
  '/api/get_room_members',
  '/api/get_groupmember_bysql',
  '/api/get_group_memeber_info',
  '/api/get_group_member_contact',
  '/api/get_contact',
  '/api/get_contact_fast',
  '/api/net_scene_search_contact',
  '/api/update_single_profile',
  '/api/batch_get_wxids',
  '/api/get_contact_list2',
])

const MAX_PREVIEW = 5000
const EXPECTED_WECHAT_VERSION = '4.1.8.27'

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function redactPreview(raw) {
  let text
  try { text = typeof raw === 'string' ? raw : JSON.stringify(raw) } catch { text = String(raw) }
  return text
    .replace(/v3_[^"'\s<>]+/gi, (v) => `${v.slice(0, 12)}...[${v.length}]`)
    .replace(/v4_[^"'\s<>]+/gi, (v) => `${v.slice(0, 12)}...[${v.length}]`)
    .slice(0, MAX_PREVIEW)
}

function credentialMeta(value) {
  const text = String(value || '')
  if (!text) return { present: false, prefix: '', length: 0, sha16: '' }
  const sha16 = createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
  return { present: true, prefix: text.slice(0, 12), length: text.length, sha16 }
}

function topLevelKeys(raw) {
  const parsed = typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return null } })() : raw
  if (!isRecord(parsed)) return []
  return Object.keys(parsed).slice(0, 80)
}

function collectFieldNames(obj, limit = 80) {
  if (!isRecord(obj)) return []
  return Object.keys(obj).slice(0, limit)
}

function findMember(list, userName) {
  const target = String(userName || '')
  for (const item of list || []) {
    if (!isRecord(item)) continue
    const names = [
      readString(item.userName),
      readString(item.wxid),
      readString(item.friendUserName),
      readString(item.memberUserName),
      readString(item.memeberId),
    ]
    if (names.includes(target)) return item
  }
  return null
}

function extractSearchCredentials(raw) {
  let baseRet
  let errMsg = ''
  let userName = ''
  let nickName = ''
  let antispamTicket = ''
  let bigHeadImgUrl = ''
  let smallHeadImgUrl = ''
  let signature = ''
  let sex
  let matchType
  let extFlag
  const topKeys = []
  for (const payload of payloadLayers(raw)) {
    if (!topKeys.length) topKeys.push(...Object.keys(payload).slice(0, 80))
    const base = isRecord(payload.baseResponse) ? payload.baseResponse : null
    if (base && baseRet === undefined && (typeof base.ret === 'number' || typeof base.ret === 'string')) {
      baseRet = Number(base.ret)
      errMsg = readString(base.errMsg) || readString(base.err_msg) || ''
    }
    userName ||= readString(payload.userName)
    nickName ||= readString(payload.nickName)
    antispamTicket ||= readString(payload.antispamTicket) || readString(payload.antispamticket)
    bigHeadImgUrl ||= readString(payload.bigHeadImgUrl)
    smallHeadImgUrl ||= readString(payload.smallHeadImgUrl)
    signature ||= readString(payload.signature)
    if (sex === undefined && (typeof payload.sex === 'number' || typeof payload.sex === 'string')) sex = Number(payload.sex)
    if (matchType === undefined && payload.matchType !== undefined) matchType = payload.matchType
    if (extFlag === undefined && payload.extFlag !== undefined) extFlag = payload.extFlag
  }
  const v3Ok = /^v3_/i.test(userName)
  const v4Ok = /^v4_/i.test(antispamTicket)
  return {
    baseRet, errMsg, userName, nickName, antispamTicket, bigHeadImgUrl, smallHeadImgUrl,
    signature, sex, matchType, extFlag, topKeys,
    hasV3: v3Ok, hasV4: v4Ok,
    v3: v3Ok ? userName : '',
    v4: v4Ok ? antispamTicket : '',
  }
}

function identityMatch({ nickName, expectedNickname, bigHeadImgUrl, smallHeadImgUrl, memberAvatar }) {
  const nick = String(nickName || '').trim()
  const expected = String(expectedNickname || '').trim()
  const nickOk = Boolean(expected) && nick === expected
  const avatar = String(memberAvatar || '').trim()
  const heads = [String(bigHeadImgUrl || ''), String(smallHeadImgUrl || '')].filter(Boolean)
  let avatarOk = false
  if (avatar && heads.length) {
    avatarOk = heads.some((h) => h === avatar || (avatar.length > 24 && h.includes(avatar.slice(-40))) || (h.length > 24 && avatar.includes(h.slice(-40))))
  }
  if (nickOk || avatarOk) return { matched: true, by: nickOk ? 'nickName' : 'avatar' }
  if (expected && nick && nick !== expected && heads.length && avatar && !avatarOk) {
    return { matched: false, by: 'conflict' }
  }
  if (expected && nick && nick !== expected) return { matched: false, by: 'nickName' }
  return { matched: false, by: 'unknown' }
}

/**
 * @param {{
 *   requestApi: (record: object, path: string, body: object, timeout?: number) => Promise<{ response: Response, raw: any }>,
 *   record: object,
 *   payload: object,
 *   clientMeta?: object,
 * }} options
 */
async function runFriendCredentialDiagnostic(options) {
  const payload = options.payload || {}
  const record = options.record
  const startedAll = Date.now()
  const diagnosticId = String(payload.diagnosticId || '')
  const roomId = String(payload.roomId || '')
  const memberUserName = String(payload.memberUserName || '')
  const expectedNickname = String(payload.expectedNickname || '')
  const targetInstanceId = String(payload.targetInstanceId || '')
  const targetAccountWxid = String(payload.targetAccountWxid || '')
  const dryRun = payload.dryRun !== false
  const expiresAt = Date.parse(String(payload.expiresAt || ''))
  const idempotencyKey = String(payload.idempotencyKey || '')

  const report = {
    diagnosticId,
    idempotencyKey,
    clientId: String(payload.targetClientId || options.clientMeta?.clientId || ''),
    clientVersion: String(options.clientMeta?.clientVersion || ''),
    instanceId: String(record?.id || ''),
    accountWxid: String(record?.accountWxid || ''),
    instancePort: Number(record?.apiPort) || 0,
    wechatVersion: String(options.clientMeta?.wechatVersion || ''),
    dllPath: String(options.clientMeta?.dllPath || ''),
    dllSha256: String(options.clientMeta?.dllSha256 || ''),
    roomId,
    targetUserName: memberUserName,
    expectedNickname,
    dryRun,
    probes: [],
    finalClassification: '',
    credentialSource: '',
    error: '',
    elapsedMs: 0,
  }

  if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
    report.finalClassification = 'EXPIRED'
    report.error = '诊断任务已过期'
    report.elapsedMs = Date.now() - startedAll
    return report
  }

  if (!record || record.status !== 'ONLINE') {
    report.finalClassification = 'WRONG_INSTANCE'
    report.error = '目标实例不在线'
    report.elapsedMs = Date.now() - startedAll
    return report
  }
  if (targetInstanceId && record.id !== targetInstanceId) {
    report.finalClassification = 'WRONG_INSTANCE'
    report.error = 'instanceId 不匹配'
    report.elapsedMs = Date.now() - startedAll
    return report
  }
  if (targetAccountWxid && String(record.accountWxid || '') !== targetAccountWxid) {
    report.finalClassification = 'WRONG_INSTANCE'
    report.error = 'accountWxid 不匹配'
    report.elapsedMs = Date.now() - startedAll
    return report
  }

  const call = async (endpoint, body, { retries = 0 } = {}) => {
    if (!ALLOWED_ENDPOINTS.includes(endpoint)) {
      return {
        endpoint,
        requestBodyKeys: Object.keys(body || {}),
        skipped: true,
        classification: 'CONTRACT_UNVERIFIED',
        error: 'endpoint_not_allowlisted',
      }
    }
    const startedAt = Date.now()
    let lastErr = null
    for (let attempt = 1; attempt <= Math.max(1, retries + 1); attempt += 1) {
      try {
        const { response, raw } = await options.requestApi(record, endpoint, body, 30000)
        const struct = rawStructure(raw)
        struct.rawPreview = redactPreview(raw)
        const profile = parseProfileCredentials(raw, memberUserName, roomId)
        const v3Meta = credentialMeta(profile.v3)
        const v4Meta = credentialMeta(profile.v4)
        return {
          endpoint,
          requestBodyKeys: Object.keys(body || {}),
          requestWxid: String(body?.wxid || body?.search || body?.memeberId || ''),
          requestRoomId: String(body?.roomId || body?.room_id || ''),
          httpStatus: response.status,
          baseRet: profile.baseRet,
          contactCount: profile.contactCount,
          contactListLength: profile.contactListLength,
          matchedContact: profile.matchedContact,
          matchedTicket: profile.matchedTicket,
          hasV3: v3Meta.present,
          v3Prefix: v3Meta.prefix,
          v3Length: v3Meta.length,
          v3Sha16: v3Meta.sha16,
          hasV4: v4Meta.present,
          v4Prefix: v4Meta.prefix,
          v4Length: v4Meta.length,
          v4Sha16: v4Meta.sha16,
          rawTopLevelKeys: struct.rawTopLevelKeys,
          dataTopLevelKeys: struct.dataTopLevelKeys,
          rawPreview: struct.rawPreview,
          elapsedMs: Date.now() - startedAt,
          attempt,
          _raw: raw,
          _v3: profile.v3,
          _v4: profile.v4,
        }
      } catch (error) {
        lastErr = error
        const msg = String(error?.message || error)
        const retriable = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|5\d\d|network/i.test(msg)
        if (!retriable || attempt > retries) {
          return {
            endpoint,
            requestBodyKeys: Object.keys(body || {}),
            requestWxid: String(body?.wxid || body?.search || body?.memeberId || ''),
            requestRoomId: String(body?.roomId || body?.room_id || ''),
            httpStatus: 0,
            error: msg.slice(0, 300),
            classification: 'API_ERROR',
            elapsedMs: Date.now() - startedAt,
            attempt,
          }
        }
      }
    }
    return {
      endpoint,
      error: String(lastErr?.message || lastErr || 'unknown').slice(0, 300),
      classification: 'API_ERROR',
    }
  }

  let memberAvatar = ''
  let memberHit = null

  // A1 get_room_members
  {
    const probe = await call('/api/get_room_members', { room_id: roomId }, { retries: 2 })
    const raw = probe._raw
    let memberCount = 0
    let chatRoomMemberCount = 0
    let allMemberUserNameListCount = 0
    let fieldNames = []
    for (const layer of payloadLayers(raw)) {
      const members = Array.isArray(layer.chatRoomMember) ? layer.chatRoomMember
        : Array.isArray(layer.memberList) ? layer.memberList
          : Array.isArray(layer.members) ? layer.members : []
      if (members.length) {
        chatRoomMemberCount = Math.max(chatRoomMemberCount, members.length)
        memberCount = Math.max(memberCount, members.length)
        memberHit = findMember(members, memberUserName) || memberHit
        if (memberHit) fieldNames = collectFieldNames(memberHit)
      }
      const names = layer.allMemberUserNameList
      if (Array.isArray(names)) allMemberUserNameListCount = Math.max(allMemberUserNameListCount, names.length)
    }
    if (memberHit) {
      memberAvatar = readString(memberHit.bigHeadImgUrl) || readString(memberHit.smallHeadImgUrl) || readString(memberHit.avatar) || memberAvatar
    }
    delete probe._raw
    delete probe._v3
    delete probe._v4
    report.probes.push({
      ...probe,
      memberCount,
      chatRoomMemberCount,
      allMemberUserNameListCount,
      matchedTarget: Boolean(memberHit),
      matchedIdentity: memberHit ? {
        userName: readString(memberHit.userName),
        nickName: readString(memberHit.nickName),
        displayName: readString(memberHit.displayName),
        alias: readString(memberHit.alias),
        wxid: readString(memberHit.wxid),
        friendUserName: readString(memberHit.friendUserName),
        hasEncryptUserName: Boolean(readString(memberHit.encryptUserName)),
        inviterUserName: readString(memberHit.inviterUserName),
        fieldNames,
      } : null,
      classification: probe.error ? 'API_ERROR' : (memberHit ? 'OK' : 'TARGET_NOT_FOUND'),
    })
  }

  // A2 get_groupmember_bysql
  {
    const probe = await call('/api/get_groupmember_bysql', { roomId }, { retries: 2 })
    let fieldNames = []
    let hit = null
    for (const layer of payloadLayers(probe._raw)) {
      const members = Array.isArray(layer.members) ? layer.members
        : Array.isArray(layer.memberList) ? layer.memberList : []
      hit = findMember(members, memberUserName) || hit
      if (hit) fieldNames = collectFieldNames(hit)
    }
    if (hit) {
      memberHit = memberHit || hit
      memberAvatar = memberAvatar || readString(hit.bigHeadImgUrl) || readString(hit.smallHeadImgUrl)
    }
    delete probe._raw
    delete probe._v3
    delete probe._v4
    report.probes.push({
      ...probe,
      matchedTarget: Boolean(hit),
      memberFieldNames: fieldNames,
      matchedIdentity: hit ? {
        userName: readString(hit.userName),
        nickName: readString(hit.nickName),
        displayName: readString(hit.displayName),
        fieldNames,
      } : null,
      classification: probe.error ? 'API_ERROR' : (hit ? 'OK' : 'TARGET_NOT_FOUND'),
    })
  }

  // A3 get_group_memeber_info (keep HAR spelling)
  {
    const probe = await call('/api/get_group_memeber_info', { roomId, memeberId: memberUserName }, { retries: 2 })
    const profile = probe.hasV3 || probe.hasV4 ? probe : probe
    delete probe._raw
    const v3 = probe._v3
    const v4 = probe._v4
    delete probe._v3
    delete probe._v4
    report.probes.push({
      ...probe,
      matchedTarget: Boolean(profile.matchedContact || profile.hasV3 || profile.hasV4),
      classification: probe.error ? 'API_ERROR'
        : (probe.hasV3 && probe.hasV4 ? 'DETAIL_ROUTE_READY' : 'OK'),
      _keepV3: v3,
      _keepV4: v4,
    })
  }

  // B4 get_group_member_contact
  const groupContact = await call('/api/get_group_member_contact', { wxid: memberUserName, roomId }, { retries: 2 })
  {
    const v3 = groupContact._v3
    const v4 = groupContact._v4
    delete groupContact._raw
    delete groupContact._v3
    delete groupContact._v4
    report.probes.push({
      ...groupContact,
      matchedTarget: Boolean(groupContact.matchedContact),
      classification: groupContact.error ? 'API_ERROR'
        : (groupContact.hasV3 && groupContact.hasV4 ? 'GROUP_ROUTE_READY' : 'OK'),
      _keepV3: v3,
      _keepV4: v4,
    })
  }

  // B5 get_contact
  const contactProbe = await call('/api/get_contact', { wxid: memberUserName }, { retries: 2 })
  {
    const v3 = contactProbe._v3
    const v4 = contactProbe._v4
    delete contactProbe._raw
    delete contactProbe._v3
    delete contactProbe._v4
    report.probes.push({
      ...contactProbe,
      matchedTarget: Boolean(contactProbe.matchedContact),
      classification: contactProbe.error ? 'API_ERROR'
        : (contactProbe.hasV3 && contactProbe.hasV4 ? 'DETAIL_ROUTE_READY' : 'OK'),
      _keepV3: v3,
      _keepV4: v4,
    })
  }

  // B6 get_contact_fast
  {
    const probe = await call('/api/get_contact_fast', { wxid: memberUserName }, { retries: 2 })
    const v3 = probe._v3
    const v4 = probe._v4
    delete probe._raw
    delete probe._v3
    delete probe._v4
    report.probes.push({
      ...probe,
      matchedTarget: Boolean(probe.matchedContact),
      classification: probe.error ? 'API_ERROR'
        : (probe.hasV3 && probe.hasV4 ? 'DETAIL_ROUTE_READY' : 'OK'),
      _keepV3: v3,
      _keepV4: v4,
    })
  }

  // C7 net_scene_search_contact — critical
  let searchReady = false
  let searchMismatch = false
  {
    const startedAt = Date.now()
    let probe
    try {
      const { response, raw } = await options.requestApi(record, '/api/net_scene_search_contact', { search: memberUserName }, 30000)
      const parsed = extractSearchCredentials(raw)
      const id = identityMatch({
        nickName: parsed.nickName,
        expectedNickname,
        bigHeadImgUrl: parsed.bigHeadImgUrl,
        smallHeadImgUrl: parsed.smallHeadImgUrl,
        memberAvatar,
      })
      const v3Meta = credentialMeta(parsed.v3)
      const v4Meta = credentialMeta(parsed.v4)
      searchReady = Boolean(parsed.hasV3 && parsed.hasV4 && id.matched)
      searchMismatch = Boolean(id.by === 'conflict' || (expectedNickname && parsed.nickName && !id.matched && parsed.hasV3))
      probe = {
        endpoint: '/api/net_scene_search_contact',
        requestBodyKeys: ['search'],
        requestWxid: memberUserName,
        requestRoomId: '',
        httpStatus: response.status,
        baseRet: parsed.baseRet,
        errMsg: parsed.errMsg,
        rawTopLevelKeys: parsed.topKeys.join(','),
        nickName: parsed.nickName,
        userNameIsV3: parsed.hasV3,
        userNameLength: parsed.userName.length,
        userNamePrefix: parsed.userName.slice(0, 12),
        hasV3: v3Meta.present,
        v3Prefix: v3Meta.prefix,
        v3Length: v3Meta.length,
        v3Sha16: v3Meta.sha16,
        hasV4: v4Meta.present,
        v4Prefix: v4Meta.prefix,
        v4Length: v4Meta.length,
        v4Sha16: v4Meta.sha16,
        bigHeadImgUrl: String(parsed.bigHeadImgUrl || '').slice(0, 200),
        smallHeadImgUrl: String(parsed.smallHeadImgUrl || '').slice(0, 200),
        signature: String(parsed.signature || '').slice(0, 120),
        sex: parsed.sex,
        matchType: parsed.matchType,
        extFlag: parsed.extFlag,
        identityMatched: id.matched,
        matchedContactBy: id.by,
        rawPreview: redactPreview(raw),
        elapsedMs: Date.now() - startedAt,
        classification: searchMismatch ? 'IDENTITY_MISMATCH'
          : (searchReady ? 'SEARCH_ROUTE_CREDENTIALS_READY' : (parsed.hasV3 || parsed.hasV4 ? 'PARTIAL' : 'OK')),
        _keepV3: parsed.v3,
        _keepV4: parsed.v4,
      }
    } catch (error) {
      probe = {
        endpoint: '/api/net_scene_search_contact',
        requestBodyKeys: ['search'],
        requestWxid: memberUserName,
        httpStatus: 0,
        error: String(error?.message || error).slice(0, 300),
        classification: 'API_ERROR',
        elapsedMs: Date.now() - startedAt,
      }
    }
    report.probes.push(probe)
  }

  // D8 confirmed supplements
  {
    const probe = await call('/api/update_single_profile', { wxid: memberUserName }, { retries: 1 })
    const v3 = probe._v3
    const v4 = probe._v4
    delete probe._raw
    delete probe._v3
    delete probe._v4
    report.probes.push({
      ...probe,
      classification: probe.error ? 'API_ERROR'
        : (probe.hasV3 && probe.hasV4 ? 'DETAIL_ROUTE_READY' : 'OK'),
      _keepV3: v3,
      _keepV4: v4,
    })
  }
  {
    const probe = await call('/api/batch_get_wxids', { wxids: memberUserName }, { retries: 1 })
    const v3 = probe._v3
    const v4 = probe._v4
    delete probe._raw
    delete probe._v3
    delete probe._v4
    report.probes.push({
      ...probe,
      classification: probe.error ? 'API_ERROR'
        : (probe.hasV3 && probe.hasV4 ? 'DETAIL_ROUTE_READY' : 'OK'),
      _keepV3: v3,
      _keepV4: v4,
    })
  }
  // null-body contracts → mark unverified, do not guess
  report.probes.push({
    endpoint: '/api/batch_getroom_contact',
    skipped: true,
    classification: 'CONTRACT_UNVERIFIED',
    reason: 'requestBodySchema/example null in HAR contract',
  })
  report.probes.push({
    endpoint: '/api/wechat_init',
    skipped: true,
    classification: 'CONTRACT_UNVERIFIED',
    reason: 'requestBodySchema/example null; long-running',
  })

  // strip secrets before return
  let bestSource = ''
  let bestClass = 'V3_UNAVAILABLE_ON_ORIGINAL_ACCOUNT'
  for (const probe of report.probes) {
    if (probe.classification === 'GROUP_ROUTE_READY') {
      bestClass = 'GROUP_ROUTE_READY'
      bestSource = probe.endpoint
      break
    }
  }
  if (bestClass === 'V3_UNAVAILABLE_ON_ORIGINAL_ACCOUNT') {
    for (const probe of report.probes) {
      if (probe.classification === 'SEARCH_ROUTE_CREDENTIALS_READY') {
        bestClass = 'SEARCH_ROUTE_READY'
        bestSource = probe.endpoint
        break
      }
    }
  }
  if (bestClass === 'V3_UNAVAILABLE_ON_ORIGINAL_ACCOUNT') {
    for (const probe of report.probes) {
      if (probe.classification === 'DETAIL_ROUTE_READY') {
        bestClass = 'DETAIL_ROUTE_READY'
        bestSource = probe.endpoint
        break
      }
    }
  }
  if (searchMismatch) bestClass = 'IDENTITY_MISMATCH'
  if (report.probes.some((p) => p.classification === 'API_ERROR') && bestClass === 'V3_UNAVAILABLE_ON_ORIGINAL_ACCOUNT') {
    const allFailed = report.probes.filter((p) => !p.skipped).every((p) => p.classification === 'API_ERROR')
    if (allFailed) bestClass = 'API_ERROR'
  }

  for (const probe of report.probes) {
    delete probe._keepV3
    delete probe._keepV4
    delete probe._raw
    delete probe._v3
    delete probe._v4
  }

  report.finalClassification = bestClass
  report.credentialSource = bestSource
  report.elapsedMs = Date.now() - startedAll
  report.wechatVersionExpected = EXPECTED_WECHAT_VERSION
  return report
}

module.exports = {
  ALLOWED_ENDPOINTS,
  runFriendCredentialDiagnostic,
  redactPreview,
  credentialMeta,
  extractSearchCredentials,
  identityMatch,
}
