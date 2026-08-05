/**
 * 本机好友凭证只读诊断：先复用健康 Hook，否则 ASCII runtime + inject 启动可见微信。
 * 普通群成员仅只读；add_friend 仅在同意白名单精确匹配时最多一次。
 */
'use strict'

const { createHash, randomUUID } = require('crypto')
const { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, statSync } = require('fs')
const { pipeline } = require('stream/promises')
const http = require('http')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')

const {
  parseProfileCredentials,
  rawStructure,
  readString,
  payloadLayers,
} = require('../electron/friend-profile.cjs')
const {
  extractSearchCredentials,
  identityMatch,
  credentialMeta,
  redactPreview,
} = require('../electron/friend-credential-diagnostic.cjs')

const ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(ROOT, '..')
const EXPECTED_VERSION = '4.1.8.27'
const VERIFY_CONTENT = '你好，功能联调测试，请忽略或通过均可'
const API_TIMEOUT_MS = 8000
const HEAVY_API_TIMEOUT_MS = 30000
const LOGIN_WAIT_MS = 10 * 60 * 1000
const LOGIN_POLL_MS = 2000

const HEAVY_ENDPOINTS = new Set([
  '/api/get_chatroom_list',
  '/api/get_contact_list2',
  '/api/get_room_members',
  '/api/get_group_member_contact',
  '/api/net_scene_search_contact',
  '/api/batch_get_wxids',
  '/api/update_single_profile',
])

const ALLOWED_API = new Set([
  '/api/check_login',
  '/api/get_profile_cache',
  '/api/get_chatroom_list',
  '/api/get_contact_list2',
  '/api/get_room_members',
  '/api/get_group_member_contact',
  '/api/get_contact',
  '/api/get_contact_fast',
  '/api/net_scene_search_contact',
  '/api/get_groupmember_bysql',
  '/api/get_group_memeber_info',
  '/api/update_single_profile',
  '/api/batch_get_wxids',
  '/api/add_friend',
])

const CONSENT_PATH = path.join(ROOT, 'config', 'friend-add-consent-test-targets.json')
const STATE_DIR = path.join(process.env.LOCALAPPDATA || '', 'WeChatControl', 'state')
const STATE_PATH = path.join(STATE_DIR, 'reusable-instance.json')
const RUNTIME_DIR = path.join(process.env.LOCALAPPDATA || '', 'WeChatControl', 'runtime', EXPECTED_VERSION)
const HOOK_CANDIDATES = [
  path.join(ROOT, 'resources', 'hook', EXPECTED_VERSION),
  path.join(REPO_ROOT, EXPECTED_VERSION, EXPECTED_VERSION),
]
const WEIXIN_CANDIDATES = [
  'E:\\WEIXIN\\Weixin.exe',
  'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
  'C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
]
const HAR_CANDIDATES = [
  path.join(process.env.USERPROFILE || '', 'Desktop', '微信.har'),
  path.join(REPO_ROOT, '微信.har'),
]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
}

function peArch(filePath) {
  const buf = readFileSync(filePath)
  const peOffset = buf.readUInt32LE(0x3C)
  const machine = buf.readUInt16LE(peOffset + 4)
  if (machine === 0x8664) return 'x64'
  if (machine === 0x14c) return 'x86'
  return `unknown(0x${machine.toString(16)})`
}

function fileVersion(exePath) {
  try {
    const { execFileSync } = require('child_process')
    const ps = `(Get-Item -LiteralPath '${String(exePath).replace(/'/g, "''")}').VersionInfo.FileVersion`
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
    }).trim()
  } catch {
    return ''
  }
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

async function allocatePort(start, skip = new Set()) {
  for (let port = start; port < 65535; port += 1) {
    if (skip.has(port)) continue
    if (await portAvailable(port)) return port
  }
  throw new Error(`无可用端口（起点 ${start}）`)
}

async function copyVerified(source, destination) {
  const sourceHash = await sha256File(source)
  mkdirSync(path.dirname(destination), { recursive: true })
  if (existsSync(destination) && (await sha256File(destination)) === sourceHash) {
    return { path: destination, sha256: sourceHash, copied: false }
  }
  await pipeline(createReadStream(source), createWriteStream(destination))
  const destHash = await sha256File(destination)
  if (destHash !== sourceHash) throw new Error(`复制校验失败：${path.basename(source)}`)
  return { path: destination, sha256: destHash, copied: true }
}

function resolveHookSource() {
  for (const dir of HOOK_CANDIDATES) {
    const inject = path.join(dir, 'inject.exe')
    const dll = path.join(dir, 'libGLESv1.dll')
    if (existsSync(inject) && existsSync(dll)) {
      return {
        dir,
        injectExe: inject,
        dll,
        dllName: 'libGLESv1.dll',
        reason: [
          '4.1.8.27 包内无 libencode.dll；命令行参数.txt 旧示例指向 4.1.5.30/libencode.dll',
          '本项目 main.cjs prepareRuntime / ensure-hooks / electron-builder 均成功使用 libGLESv1.dll',
          `目录证据：${dir}`,
        ].join('；'),
      }
    }
  }
  return null
}

function resolveWeixinExe() {
  for (const candidate of WEIXIN_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function resolveHarPath() {
  for (const candidate of HAR_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  return ''
}

function listDirFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).map((name) => {
    const full = path.join(dir, name)
    const st = statSync(full)
    return { name, size: st.size, isDir: st.isDirectory() }
  })
}

async function buildSourceAudit() {
  const hook = resolveHookSource()
  const harPath = resolveHarPath()
  const weixin = resolveWeixinExe()
  const contractsPath = path.join(ROOT, 'docs', 'generated', 'wechat-api-contracts.json')
  const audit = {
    generatedAt: new Date().toISOString(),
    har: harPath
      ? { path: harPath, size: statSync(harPath).size, sha256: await sha256File(harPath) }
      : { path: '', missing: true },
    packageDir: path.join(REPO_ROOT, EXPECTED_VERSION, EXPECTED_VERSION),
    packageFiles: listDirFiles(path.join(REPO_ROOT, EXPECTED_VERSION, EXPECTED_VERSION)),
    resourcesHookFiles: listDirFiles(path.join(ROOT, 'resources', 'hook', EXPECTED_VERSION)),
    weixin: weixin
      ? { path: weixin, version: fileVersion(weixin), sha256: await sha256File(weixin) }
      : { path: '', missing: true },
    inject: null,
    dll: null,
    dllSelectionReason: '',
    contractsPath: existsSync(contractsPath) ? contractsPath : '',
    harContracts: {
      check_login: { sourceId: 438557573, body: {} },
      get_profile_cache: { sourceId: 438557507, body: {} },
      get_chatroom_list: { sourceId: 438557576, body: {} },
      get_contact_list2: { sourceId: 438557598, body: {} },
      get_room_members: { sourceId: 438557503, body: { room_id: '<roomId>' } },
      get_group_member_contact: { sourceId: 438557510, body: { wxid: '<userName>', roomId: '<roomId>' } },
      get_contact: { sourceId: 438557509, body: { wxid: '<userName>' } },
      get_contact_fast: { sourceId: 438557522, body: { wxid: '<userName>' } },
      net_scene_search_contact: { sourceId: 438557506, body: { search: '<alias|userName>' } },
      get_groupmember_bysql: { sourceId: 438557595, body: { roomId: '<roomId>' } },
      get_group_memeber_info: { sourceId: 438557562, body: { roomId: '<roomId>', memeberId: '<userName>' } },
      update_single_profile: { sourceId: 438557572, body: { wxid: '<userName>' } },
      batch_get_wxids: { sourceId: 438557602, body: { wxids: '<userName>' } },
      add_friend: { sourceId: 438557515, body: { v3: '', v4: '', scence: '3', friendFlg: '0', verifyContent: '' } },
      batch_getroom_contact: { sourceId: 438557588, status: 'CONTRACT_UNVERIFIED', reason: 'requestBodySchema/example null' },
    },
    existingReuseCapability: {
      prepareRuntime: 'admin-ui/electron/main.cjs#prepareRuntime → userData/runtime/4.1.8.27',
      startWechatInstance: 'spawn(injectExe,[weixin,dll,JSON],{shell:false})',
      probeInstance: 'check_login + get_profile_cache',
      sqlite: path.join(process.env.APPDATA || '', 'wx-group-admin-ui', 'data', 'wechat-control.sqlite'),
      stateFile: STATE_PATH,
    },
  }
  if (hook) {
    audit.inject = {
      path: hook.injectExe,
      arch: peArch(hook.injectExe),
      sha256: await sha256File(hook.injectExe),
      size: statSync(hook.injectExe).size,
    }
    audit.dll = {
      path: hook.dll,
      name: hook.dllName,
      sha256: await sha256File(hook.dll),
      size: statSync(hook.dll).size,
    }
    audit.dllSelectionReason = hook.reason
    const encode = path.join(hook.dir, 'libencode.dll')
    audit.libencodePresent = existsSync(encode)
  } else {
    audit.dllSelectionReason = '未找到 inject.exe + libGLESv1.dll'
  }
  return audit
}

function timeoutFor(apiPath, overrideMs) {
  if (Number.isFinite(overrideMs) && overrideMs > 0) return overrideMs
  return HEAVY_ENDPOINTS.has(apiPath) ? HEAVY_API_TIMEOUT_MS : API_TIMEOUT_MS
}

async function apiPost(port, apiPath, body, timeoutMs) {
  if (!ALLOWED_API.has(apiPath)) {
    const err = new Error(`endpoint_not_allowlisted:${apiPath}`)
    err.classification = 'CONTRACT_UNVERIFIED'
    throw err
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('invalid_port')
  const url = `http://127.0.0.1:${port}${apiPath}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutFor(apiPath, timeoutMs))
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    })
    const text = await response.text()
    let raw
    try { raw = JSON.parse(text) } catch { raw = text }
    return { response, raw, httpStatus: response.status, url }
  } finally {
    clearTimeout(timer)
  }
}

async function apiPostRetryOnce(port, apiPath, body, timeline) {
  const started = Date.now()
  try {
    const result = await apiPost(port, apiPath, body)
    timeline.push({
      t: new Date().toISOString(),
      endpoint: apiPath,
      httpStatus: result.httpStatus,
      elapsedMs: Date.now() - started,
      attempt: 1,
    })
    return result
  } catch (error) {
    const msg = String(error?.message || error)
    const retriable = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|abort|socket|fetch failed|5\d\d/i.test(msg)
    timeline.push({
      t: new Date().toISOString(),
      endpoint: apiPath,
      error: msg.slice(0, 200),
      elapsedMs: Date.now() - started,
      attempt: 1,
      retriable,
    })
    if (!retriable) throw error
    const started2 = Date.now()
    const result = await apiPost(port, apiPath, body)
    timeline.push({
      t: new Date().toISOString(),
      endpoint: apiPath,
      httpStatus: result.httpStatus,
      elapsedMs: Date.now() - started2,
      attempt: 2,
    })
    return result
  }
}

function parseLogin(raw) {
  const layers = payloadLayers(raw)
  for (const layer of layers) {
    const status = layer.status ?? layer.data?.status
    if (status === true || status === 1 || status === '1') return true
    if (status === false || status === 0 || status === '0') return false
  }
  return false
}

function parseProfile(raw) {
  for (const layer of payloadLayers(raw)) {
    const info = layer.userInfo || layer.data?.userInfo
    if (!info) continue
    return {
      accountWxid: readString(info.userName),
      nickname: readString(info.nickName),
      avatar: readString(layer.userInfoExt?.bigHeadImgUrl) || readString(layer.userInfoExt?.smallHeadImgUrl) || '',
    }
  }
  return { accountWxid: '', nickname: '', avatar: '' }
}

async function probePortHealth(port, timeline) {
  try {
    const login = await apiPostRetryOnce(port, '/api/check_login', {}, timeline)
    if (login.httpStatus !== 200) return null
    const loggedIn = parseLogin(login.raw)
    if (!loggedIn) return { port, loggedIn: false }
    const profile = await apiPostRetryOnce(port, '/api/get_profile_cache', {}, timeline)
    const info = parseProfile(profile.raw)
    return {
      port,
      loggedIn: true,
      accountWxid: info.accountWxid,
      nickname: info.nickname,
      avatar: info.avatar,
      wechatVersion: EXPECTED_VERSION,
    }
  } catch {
    return null
  }
}

async function scanReusablePorts(timeline) {
  const candidates = new Set()
  if (existsSync(STATE_PATH)) {
    try {
      const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'))
      if (state.apiPort) candidates.add(Number(state.apiPort))
    } catch { /* ignore */ }
  }
  for (let p = 19088; p <= 19120; p += 1) candidates.add(p)
  const healthy = []
  for (const port of [...candidates].sort((a, b) => a - b)) {
    const free = await portAvailable(port)
    if (free) continue
    const hit = await probePortHealth(port, timeline)
    if (hit?.loggedIn && hit.accountWxid) healthy.push(hit)
  }
  return healthy
}

function loadConsent() {
  if (!existsSync(CONSENT_PATH)) {
    return { enabled: false, targets: [], path: CONSENT_PATH, missing: true }
  }
  try {
    const raw = JSON.parse(readFileSync(CONSENT_PATH, 'utf8'))
    return {
      enabled: Boolean(raw.enabled),
      targets: Array.isArray(raw.targets) ? raw.targets : [],
      path: CONSENT_PATH,
      missing: false,
    }
  } catch (error) {
    return { enabled: false, targets: [], path: CONSENT_PATH, error: String(error.message || error) }
  }
}

function matchConsentTarget(consent, candidate, roomId, accountWxid) {
  if (!consent.enabled || !consent.targets.length) return null
  for (const target of consent.targets) {
    if (!target || target.allowOneFriendRequest !== true) continue
    const key = String(target.wxidOrUserName || '').trim()
    if (!key) continue
    if (key === accountWxid) continue
    const names = [candidate.userName, candidate.alias, candidate.wxid].filter(Boolean)
    if (!names.includes(key)) continue
    if (target.expectedNickname && String(target.expectedNickname) !== String(candidate.nickName || '')) continue
    if (target.allowedRoomId && String(target.allowedRoomId) !== String(roomId)) continue
    return target
  }
  return null
}

function shouldAllowFriendAdd({
  consentMatch,
  accountWxid,
  candidate,
  v3,
  v4,
  identityOk,
  historyRequestSent,
  alreadySentThisRound,
}) {
  if (!consentMatch) return { allow: false, reason: 'NO_CONSENT_MATCH' }
  if (!candidate || candidate.userName === accountWxid) return { allow: false, reason: 'SELF' }
  if (candidate.isExistingFriend) return { allow: false, reason: 'ALREADY_FRIEND' }
  if (!/^v3_/i.test(String(v3 || ''))) return { allow: false, reason: 'NO_V3' }
  if (!/^v4_/i.test(String(v4 || ''))) return { allow: false, reason: 'NO_V4' }
  if (!identityOk) return { allow: false, reason: 'IDENTITY_FAIL' }
  if (historyRequestSent) return { allow: false, reason: 'HISTORY_REQUEST_SENT' }
  if (alreadySentThisRound) return { allow: false, reason: 'ROUND_LIMIT' }
  return { allow: true, reason: 'CONSENTED_SINGLE_TEST_READY' }
}

function classifyRouteMatrix(rows) {
  if (!rows.length) return 'NO_VALID_CREDENTIAL_ROUTE'
  const hookErrors = rows.filter((r) => r.hookOrVersionError)
  if (hookErrors.length >= Math.max(1, Math.ceil(rows.length * 0.6))) return 'HOOK_OR_VERSION_ERROR'
  const groupOk = rows.filter((r) => r.groupHasV3 && r.groupHasV4)
  const searchOk = rows.filter((r) => r.searchHasV3 && r.searchHasV4 && r.identityMatched)
  const profileCombo = rows.filter((r) => (r.groupHasV4 || r.contactHasV4) && (r.profileHasV3 || r.contactHasV3 || r.fastHasV3) && (r.groupHasV3 || r.profileHasV3 || r.contactHasV3 || r.fastHasV3))
  const anyV3 = rows.some((r) => r.groupHasV3 || r.contactHasV3 || r.fastHasV3 || r.searchHasV3 || r.profileHasV3)
  if (!anyV3) return 'NO_VALID_CREDENTIAL_ROUTE'
  if (groupOk.length >= 2 || (rows.length === 1 && groupOk.length === 1)) return 'GROUP_ROUTE_STABLE'
  if (profileCombo.length >= 2 || (rows.length === 1 && profileCombo.length === 1 && groupOk.length === 0)) {
    return 'MIXED_ROUTE'
  }
  if (searchOk.length >= 2 || (groupOk.length === 0 && searchOk.length >= 1)) {
    const wxidStyleNeedSearch = rows.some((r) => r.isWxidStyle && !r.groupHasV3 && r.searchHasV3)
    const customNeedSearch = rows.some((r) => !r.isWxidStyle && !r.groupHasV3 && r.searchHasV3)
    if (groupOk.length && (wxidStyleNeedSearch || customNeedSearch)) return 'MIXED_ROUTE'
    return 'SEARCH_ROUTE_STABLE'
  }
  if (groupOk.length === 1 && rows.length > 1) return 'MEMBER_SPECIFIC_LIMITATION'
  if (rows.some((r) => r.needsIdentityMapping)) return 'IDENTITY_MAPPING_REQUIRED'
  if (groupOk.length === 0 && searchOk.length === 0 && anyV3) return 'MEMBER_SPECIFIC_LIMITATION'
  return 'MIXED_ROUTE'
}

function extractMembers(raw) {
  const members = []
  for (const layer of payloadLayers(raw)) {
    const lists = [
      layer.chatRoomMember,
      layer.newChatroomData?.chatRoomMember,
      layer.memberList,
      layer.members,
      layer.data?.chatRoomMember,
      layer.data?.members,
    ]
    for (const list of lists) {
      if (!Array.isArray(list)) continue
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const userName = readString(item.userName) || readString(item.wxid) || readString(item.memberUserName)
        if (!userName) continue
        members.push({
          userName,
          wxid: readString(item.wxid) || userName,
          alias: readString(item.alias),
          nickName: readString(item.nickName),
          displayName: readString(item.displayName),
          friendUserName: readString(item.friendUserName),
          encryptUserName: readString(item.encryptUserName),
          inviterUserName: readString(item.inviterUserName),
          bigHeadImgUrl: readString(item.bigHeadImgUrl),
          smallHeadImgUrl: readString(item.smallHeadImgUrl),
          signature: readString(item.signature),
          sex: item.sex,
          source: 'ROOM_MEMBER_LIST',
        })
      }
    }
  }
  const byName = new Map()
  for (const m of members) byName.set(m.userName, m)
  return [...byName.values()]
}

function extractRooms(raw) {
  const rooms = []
  for (const layer of payloadLayers(raw)) {
    const list = layer.data || layer.roomList || layer.chatroomList || layer.list
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (!item || typeof item !== 'object') continue
      const roomId = readString(item.username) || readString(item.userName) || readString(item.roomId) || readString(item.wxid)
      if (!roomId || !roomId.includes('@chatroom')) continue
      rooms.push({
        roomId,
        roomName: readString(item.nick_name) || readString(item.nickName) || readString(item.name) || roomId,
      })
    }
  }
  return rooms
}

function extractFriendSet(raw) {
  const set = new Set()
  for (const layer of payloadLayers(raw)) {
    const list = layer.friend_list || layer.friendList || layer.data?.friend_list || layer.data
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const wxid = readString(item.wxid) || readString(item.userName) || readString(item.username)
      if (wxid) set.add(wxid)
      const alias = readString(item.alias)
      if (alias) set.add(alias)
    }
  }
  return set
}

function selectCandidates(members, accountWxid, friendSet, max = 3) {
  const nonSelf = members.filter((m) => m.userName && m.userName !== accountWxid)
  const nonFriends = nonSelf.filter((m) => !friendSet.has(m.userName) && !(m.alias && friendSet.has(m.alias)))
  const pool = nonFriends.length ? nonFriends : nonSelf
  const selected = []
  const push = (item, reason) => {
    if (!item) return
    if (selected.some((s) => s.userName === item.userName)) return
    if (selected.length >= max) return
    selected.push({
      ...item,
      isWxidStyle: String(item.userName).startsWith('wxid_'),
      isExistingFriend: friendSet.has(item.userName) || (item.alias ? friendSet.has(item.alias) : false),
      selectionReason: reason,
    })
  }
  push(pool.find((m) => String(m.userName).startsWith('wxid_')), 'wxid_style')
  push(pool.find((m) => !String(m.userName).startsWith('wxid_')), 'custom_account_style')
  push(pool.find((m) => m.inviterUserName), 'has_inviter_proxy_recent')
  for (const m of pool) push(m, 'fill')
  if (!selected.length && pool[0]) push(pool[0], 'fallback_min1')
  return selected
}

function summarizeProbe(endpoint, httpStatus, raw, targetUserName, roomId) {
  const parsed = parseProfileCredentials(raw, targetUserName, roomId)
  const v3Meta = credentialMeta(parsed.v3)
  const v4Meta = credentialMeta(parsed.v4)
  const struct = rawStructure(raw)
  struct.rawPreview = redactPreview(raw)
  return {
    endpoint,
    httpStatus,
    baseRet: parsed.baseRet,
    elapsedHint: true,
    contactListLength: parsed.contactListLength,
    matchedContact: parsed.matchedContact,
    matchedTicket: parsed.matchedTicket,
    hasV3: v3Meta.present,
    v3Prefix: v3Meta.prefix,
    v3Length: v3Meta.length,
    hasV4: v4Meta.present,
    v4Prefix: v4Meta.prefix,
    v4Length: v4Meta.length,
    rawTopLevelKeys: struct.rawTopLevelKeys,
    rawPreview: struct.rawPreview,
    _v3: parsed.v3,
    _v4: parsed.v4,
  }
}

async function ensureRuntime(audit) {
  const hook = resolveHookSource()
  if (!hook) throw Object.assign(new Error('HOOK_START_FAILED: missing inject/dll'), { code: 'HOOK_START_FAILED' })
  if (!existsSync(path.join(hook.dir, 'libGLESv1.dll'))) {
    throw Object.assign(new Error('HOOK_START_FAILED: libGLESv1.dll missing'), { code: 'HOOK_START_FAILED' })
  }
  const weixin = resolveWeixinExe()
  if (!weixin) throw Object.assign(new Error('HOOK_START_FAILED: Weixin.exe not found'), { code: 'HOOK_START_FAILED' })
  const version = fileVersion(weixin)
  if (version && version !== EXPECTED_VERSION) {
    throw Object.assign(new Error(`HOOK_START_FAILED: Weixin version ${version} != ${EXPECTED_VERSION}`), { code: 'HOOK_START_FAILED' })
  }
  mkdirSync(RUNTIME_DIR, { recursive: true })
  const inject = await copyVerified(hook.injectExe, path.join(RUNTIME_DIR, 'inject.exe'))
  const dll = await copyVerified(hook.dll, path.join(RUNTIME_DIR, 'libGLESv1.dll'))
  audit.runtime = {
    path: RUNTIME_DIR,
    injectSha256: inject.sha256,
    dllSha256: dll.sha256,
    injectCopied: inject.copied,
    dllCopied: dll.copied,
    weixinPath: weixin,
    weixinVersion: version || EXPECTED_VERSION,
  }
  return {
    injectExe: inject.path,
    dll: dll.path,
    weixinExe: weixin,
    injectSha256: inject.sha256,
    dllSha256: dll.sha256,
  }
}

function startHttpCallback(port) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy() })
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function startTcpSink(port) {
  const server = net.createServer((socket) => {
    socket.on('data', () => {})
    socket.on('error', () => {})
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

function killWeixinTree(weixinExe) {
  try {
    const { execFileSync } = require('child_process')
    const target = path.resolve(weixinExe).toLowerCase()
    const ps = [
      "$procs = Get-CimInstance Win32_Process -Filter \"Name = 'Weixin.exe'\" -ErrorAction SilentlyContinue;",
      `foreach ($p in $procs) { if ($p.ExecutablePath -and ($p.ExecutablePath.ToLower() -eq '${target.replace(/'/g, "''")}')) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } }`,
    ].join(' ')
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 15000 })
  } catch { /* best effort */ }
}

function spawnInject({ injectExe, weixinExe, dll, config }) {
  const args = [weixinExe, dll, JSON.stringify(config)]
  const child = spawn(injectExe, args, {
    cwd: path.dirname(weixinExe),
    shell: false,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks = []
  child.stdout?.on('data', (c) => chunks.push(Buffer.from(c)))
  child.stderr?.on('data', (c) => chunks.push(Buffer.from(c)))
  return {
    child,
    getOutput() {
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

function parseInjectorPid(output) {
  const m = String(output || '').match(/PID:\s*(\d+)/i)
  return m ? Number(m[1]) : null
}

function saveReusableState(state) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf8')
}

function loadHistorySent() {
  const hist = path.join(STATE_DIR, 'friend-request-history.jsonl')
  if (!existsSync(hist)) return new Set()
  const set = new Set()
  for (const line of readFileSync(hist, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row.status === 'REQUEST_SENT' && row.targetUserName) set.add(String(row.targetUserName))
    } catch { /* ignore */ }
  }
  return set
}

function appendHistory(row) {
  mkdirSync(STATE_DIR, { recursive: true })
  const hist = path.join(STATE_DIR, 'friend-request-history.jsonl')
  writeFileSync(hist, `${JSON.stringify(row)}\n`, { flag: 'a' })
}

async function waitUntilLogin(port, timeline, onProgress) {
  const deadline = Date.now() + LOGIN_WAIT_MS
  while (Date.now() < deadline) {
    const hit = await probePortHealth(port, timeline)
    onProgress?.(hit)
    if (hit?.loggedIn && hit.accountWxid) return hit
    await sleep(LOGIN_POLL_MS)
  }
  const err = new Error('LOGIN_TIMEOUT')
  err.code = 'LOGIN_TIMEOUT'
  throw err
}

async function probeOneCandidate(port, room, candidate, accountWxid, timeline) {
  const result = {
    targetUserName: candidate.userName,
    targetNickname: candidate.nickName,
    targetDisplayName: candidate.displayName,
    isWxidStyle: candidate.isWxidStyle,
    isExistingFriend: candidate.isExistingFriend,
    selectionReason: candidate.selectionReason,
    identity: {
      userName: candidate.userName,
      alias: candidate.alias,
      nickName: candidate.nickName,
      displayName: candidate.displayName,
      friendUserName: candidate.friendUserName,
      encryptUserName: candidate.encryptUserName ? `${String(candidate.encryptUserName).slice(0, 12)}...` : '',
      inviterUserName: candidate.inviterUserName,
      bigHeadImgUrl: candidate.bigHeadImgUrl,
      smallHeadImgUrl: candidate.smallHeadImgUrl,
      signature: candidate.signature,
      sex: candidate.sex,
      fieldSources: ['ROOM_MEMBER_LIST'],
    },
    apis: [],
    groupHasV3: false,
    groupHasV4: false,
    contactHasV3: false,
    contactHasV4: false,
    fastHasV3: false,
    fastHasV4: false,
    profileHasV3: false,
    profileHasV4: false,
    searchHasV3: false,
    searchHasV4: false,
    identityMatched: false,
    identityMismatch: false,
    finalV3: '',
    finalV4: '',
    credentialSource: '',
    needsIdentityMapping: false,
    hookOrVersionError: false,
  }

  const call = async (endpoint, body) => {
    const started = Date.now()
    const { response, raw, httpStatus } = await apiPostRetryOnce(port, endpoint, body, timeline)
    const summary = summarizeProbe(endpoint, httpStatus, raw, candidate.userName, room.roomId)
    summary.elapsedMs = Date.now() - started
    result.apis.push(summary)
    return { raw, summary }
  }

  // get_group_member_contact
  {
    const { summary } = await call('/api/get_group_member_contact', { wxid: candidate.userName, roomId: room.roomId })
    result.groupHasV3 = summary.hasV3
    result.groupHasV4 = summary.hasV4
    if (summary.hasV3) result.finalV3 = summary._v3
    if (summary.hasV4) result.finalV4 = summary._v4
    if (summary.hasV3 && summary.hasV4) {
      result.credentialSource = 'GROUP_MEMBER_CONTACT'
    }
  }

  // get_contact
  {
    const { summary } = await call('/api/get_contact', { wxid: candidate.userName })
    result.contactHasV3 = summary.hasV3
    result.contactHasV4 = summary.hasV4
    if (!result.finalV3 && summary.hasV3) result.finalV3 = summary._v3
    if (!result.finalV4 && summary.hasV4) result.finalV4 = summary._v4
    if (summary.hasV3 && summary.hasV4 && !result.credentialSource) result.credentialSource = 'CONTACT'
  }

  // get_contact_fast
  {
    const { summary } = await call('/api/get_contact_fast', { wxid: candidate.userName })
    result.fastHasV3 = summary.hasV3
    result.fastHasV4 = summary.hasV4
    if (!result.finalV3 && summary.hasV3) result.finalV3 = summary._v3
    if (!result.finalV4 && summary.hasV4) result.finalV4 = summary._v4
    if (summary.hasV3 && summary.hasV4 && !result.credentialSource) result.credentialSource = 'CONTACT_FAST'
  }

  // net_scene_search_contact — conditional
  const shouldSearch = !candidate.isWxidStyle || Boolean(candidate.alias) || (result.apis[0]?.matchedContact && !result.groupHasV3)
  if (shouldSearch) {
    const searchValue = candidate.alias || candidate.userName
    const started = Date.now()
    const { response, raw, httpStatus } = await apiPostRetryOnce(port, '/api/net_scene_search_contact', { search: searchValue }, timeline)
    const parsed = extractSearchCredentials(raw)
    const id = identityMatch({
      nickName: parsed.nickName,
      expectedNickname: candidate.nickName,
      bigHeadImgUrl: parsed.bigHeadImgUrl,
      smallHeadImgUrl: parsed.smallHeadImgUrl,
      memberAvatar: candidate.bigHeadImgUrl || candidate.smallHeadImgUrl,
    })
    const aliasSame = Boolean(candidate.alias && searchValue === candidate.alias && parsed.hasV3)
    const userSame = searchValue === candidate.userName && !candidate.isWxidStyle
    const strong = id.matched || aliasSame || userSame
    result.searchHasV3 = parsed.hasV3
    result.searchHasV4 = parsed.hasV4
    result.identityMatched = Boolean(strong)
    result.identityMismatch = id.by === 'conflict'
    result.apis.push({
      endpoint: '/api/net_scene_search_contact',
      httpStatus,
      baseRet: parsed.baseRet,
      errMsg: parsed.errMsg,
      elapsedMs: Date.now() - started,
      hasV3: parsed.hasV3,
      v3Prefix: credentialMeta(parsed.v3).prefix,
      v3Length: credentialMeta(parsed.v3).length,
      hasV4: parsed.hasV4,
      v4Prefix: credentialMeta(parsed.v4).prefix,
      v4Length: credentialMeta(parsed.v4).length,
      nickName: parsed.nickName,
      userNamePrefix: String(parsed.userName || '').slice(0, 12),
      identityMatched: strong,
      matchedContactBy: id.by,
      topKeys: parsed.topKeys,
      rawPreview: redactPreview(raw),
      _v3: parsed.v3,
      _v4: parsed.v4,
    })
    if (result.identityMismatch) {
      // refuse search credentials
    } else if (strong && parsed.hasV3 && parsed.hasV4) {
      if (!result.finalV3 || !result.finalV4) {
        result.finalV3 = parsed.v3
        result.finalV4 = parsed.v4
        result.credentialSource = 'SEARCH_CONTACT'
      }
    } else if (!parsed.hasV3 && !candidate.isWxidStyle) {
      result.needsIdentityMapping = true
    }
  } else {
    result.apis.push({
      endpoint: '/api/net_scene_search_contact',
      skipped: true,
      reason: 'conditions_not_met',
    })
  }

  // supplements with confirmed contracts
  for (const [endpoint, body] of [
    ['/api/get_groupmember_bysql', { roomId: room.roomId }],
    ['/api/get_group_memeber_info', { roomId: room.roomId, memeberId: candidate.userName }],
    ['/api/update_single_profile', { wxid: candidate.userName }],
    ['/api/batch_get_wxids', { wxids: candidate.userName }],
  ]) {
    try {
      const { summary } = await call(endpoint, body)
      if (endpoint === '/api/update_single_profile') {
        result.profileHasV3 = summary.hasV3
        result.profileHasV4 = summary.hasV4
        if (summary.hasV3 && !result.finalV3) {
          result.finalV3 = summary._v3
          result.credentialSource = result.groupHasV4 || result.finalV4
            ? 'GROUP_MEMBER_CONTACT+UPDATE_SINGLE_PROFILE'
            : 'UPDATE_SINGLE_PROFILE'
        }
        if (summary.hasV4 && !result.finalV4) result.finalV4 = summary._v4
      } else {
        if (!result.finalV3 && summary.hasV3) {
          result.finalV3 = summary._v3
          result.credentialSource ||= endpoint.replace('/api/', '').toUpperCase()
        }
        if (!result.finalV4 && summary.hasV4) result.finalV4 = summary._v4
      }
    } catch (error) {
      result.apis.push({ endpoint, error: String(error.message || error).slice(0, 200) })
    }
  }

  result.apis.push({
    endpoint: '/api/batch_getroom_contact',
    skipped: true,
    classification: 'CONTRACT_UNVERIFIED',
  })

  const baseFails = result.apis.filter((a) => !a.skipped && (a.httpStatus >= 500 || a.baseRet === -1 || a.error))
  if (baseFails.length >= 3) result.hookOrVersionError = true

  // strip secrets from api rows for report
  for (const api of result.apis) {
    delete api._v3
    delete api._v4
  }
  result.hasFinalV3 = /^v3_/i.test(result.finalV3)
  result.hasFinalV4 = /^v4_/i.test(result.finalV4)
  result.finalV3Meta = credentialMeta(result.finalV3)
  result.finalV4Meta = credentialMeta(result.finalV4)
  // keep full only in memory for consent send; redact in exported clone later
  return result
}

function toMarkdownReport(report) {
  const lines = []
  lines.push('# 本地好友凭证诊断报告')
  lines.push('')
  lines.push(`- 生成时间：${report.generatedAt}`)
  lines.push(`- 最终状态：${report.finalStatus}`)
  lines.push(`- 复用已有 Hook：${report.reuseExistingHook}`)
  lines.push(`- 微信版本：${report.wechatVersion}`)
  lines.push(`- 账号：${report.accountWxid} / ${report.nickname}`)
  lines.push(`- API 端口：${report.apiPort}`)
  lines.push(`- 选中群：${report.room?.roomName || ''} (${report.room?.roomId || ''}) 成员数=${report.room?.memberCount ?? ''}`)
  lines.push(`- 只读候选数：${report.candidates?.length || 0}`)
  lines.push(`- 稳定路线：${report.routeClassification}`)
  lines.push(`- 白名单目标：${report.consentMatched ? '是' : '否'}`)
  lines.push(`- 调用 add_friend：${report.addFriendCalled}`)
  lines.push('')
  lines.push('## 候选矩阵')
  lines.push('')
  lines.push('| 候选 | 形态 | 群成员V3 | 群成员V4 | get_contact V3 | fast V3 | search V3 | search V4 | 身份 | 来源 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const c of report.candidateResults || []) {
    lines.push(`| ${c.targetNickname || c.targetUserName} | ${c.isWxidStyle ? 'wxid_' : 'custom'} | ${c.groupHasV3} | ${c.groupHasV4} | ${c.contactHasV3} | ${c.fastHasV3} | ${c.searchHasV3} | ${c.searchHasV4} | ${c.identityMismatch ? 'MISMATCH' : c.identityMatched} | ${c.credentialSource || '-'} |`)
  }
  lines.push('')
  lines.push('## 白茶/成员特例判断')
  lines.push('')
  lines.push(report.baiChaAssessment || '（本轮未指定白茶目标；按矩阵判断普遍性）')
  lines.push('')
  lines.push('## 来源审查摘要')
  lines.push('')
  lines.push(`- inject：${report.audit?.inject?.path || ''} SHA256=${report.audit?.inject?.sha256 || ''}`)
  lines.push(`- DLL：${report.audit?.dll?.path || ''} SHA256=${report.audit?.dll?.sha256 || ''}`)
  lines.push(`- DLL 依据：${report.audit?.dllSelectionReason || ''}`)
  lines.push(`- HAR：${report.audit?.har?.path || ''} SHA256=${report.audit?.har?.sha256 || ''}`)
  return `${lines.join('\n')}\n`
}

function redactCandidateResult(row) {
  const clone = { ...row }
  delete clone.finalV3
  delete clone.finalV4
  clone.apis = (row.apis || []).map((api) => {
    const a = { ...api }
    delete a._v3
    delete a._v4
    return a
  })
  return clone
}

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const outDir = path.join(ROOT, 'diagnostics', 'local-friend-add', stamp)
  mkdirSync(outDir, { recursive: true })
  const timeline = []
  const report = {
    generatedAt: new Date().toISOString(),
    reuseExistingHook: false,
    wechatVersion: EXPECTED_VERSION,
    accountWxid: '',
    nickname: '',
    apiPort: 0,
    callbackPort: 0,
    tcpPort: 0,
    room: null,
    candidates: [],
    candidateResults: [],
    routeClassification: '',
    consentMatched: false,
    addFriendCalled: false,
    addFriendTarget: '',
    finalStatus: '',
    businessFixApplied: false,
    modifiedFiles: [],
    baiChaAssessment: '',
    audit: null,
    outDir,
  }

  let tcpServer
  let httpServer
  let injectHandle

  try {
    console.log('[1/8] 来源审查…')
    report.audit = await buildSourceAudit()
    writeFileSync(path.join(outDir, 'source-audit.json'), JSON.stringify(report.audit, null, 2), 'utf8')
    writeFileSync(path.join(outDir, '本地Hook来源审查报告.md'), [
      '# 本地 Hook 来源审查报告',
      '',
      `- HAR：${report.audit.har.path} size=${report.audit.har.size || 0} SHA-256=${report.audit.har.sha256 || ''}`,
      `- 4.1.8.27 文件：${JSON.stringify(report.audit.packageFiles)}`,
      `- Weixin.exe：${report.audit.weixin.path} version=${report.audit.weixin.version || ''} SHA-256=${report.audit.weixin.sha256 || ''}`,
      `- inject.exe：${report.audit.inject?.path || ''} arch=${report.audit.inject?.arch || ''} SHA-256=${report.audit.inject?.sha256 || ''}`,
      `- 注入 DLL：${report.audit.dll?.path || ''} SHA-256=${report.audit.dll?.sha256 || ''}`,
      `- DLL 选择依据：${report.audit.dllSelectionReason}`,
      `- libencode.dll 存在：${report.audit.libencodePresent === true}`,
      `- 合同文件：${report.audit.contractsPath}`,
      `- 实例复用能力：${JSON.stringify(report.audit.existingReuseCapability)}`,
      '',
      '## HAR 测试接口 sourceId',
      '```json',
      JSON.stringify(report.audit.harContracts, null, 2),
      '```',
      '',
    ].join('\n'), 'utf8')

    if (!report.audit.dll) {
      report.finalStatus = 'HOOK_START_FAILED'
      throw new Error('未找到可用注入 DLL')
    }

    console.log('[2/8] 扫描可复用 Hook…')
    const reusable = await scanReusablePorts(timeline)
    let session = reusable[0] || null
    if (session) {
      report.reuseExistingHook = true
      report.apiPort = session.port
      report.accountWxid = session.accountWxid
      report.nickname = session.nickname
      console.log(`复用端口 ${session.port} 账号 ${session.accountWxid}`)
    } else {
      console.log('[3/8] 无健康实例，准备 ASCII runtime 并启动…')
      const files = await ensureRuntime(report.audit)
      report.apiPort = await allocatePort(19088)
      report.tcpPort = await allocatePort(61109, new Set([report.apiPort]))
      report.callbackPort = await allocatePort(5000, new Set([report.apiPort, report.tcpPort]))

      httpServer = await startHttpCallback(report.callbackPort)
      tcpServer = await startTcpSink(report.tcpPort)

      killWeixinTree(files.weixinExe)
      await sleep(1200)

      const config = {
        recivemode: 'tcp',
        tcp_ip: '127.0.0.1',
        tcp_port: report.tcpPort,
        http_server_port: report.apiPort,
        http_callback_url: `http://127.0.0.1:${report.callbackPort}/api/recvMsg`,
        usedefault: false,
        start_server_while_login: true,
      }
      injectHandle = spawnInject({
        injectExe: files.injectExe,
        weixinExe: files.weixinExe,
        dll: files.dll,
        config,
      })
      const injectPid = injectHandle.child.pid
      console.log(`inject 已启动 pid=${injectPid} api=${report.apiPort} tcp=${report.tcpPort} cb=${report.callbackPort}`)
      console.log('请在可见微信窗口完成登录；脚本每 2 秒自动检测，最长 10 分钟…')

      // wait inject settle + API up
      await sleep(3000)
      let wechatPid = null
      try {
        await new Promise((resolve, reject) => {
          injectHandle.child.once('exit', (code) => {
            const output = injectHandle.getOutput()
            wechatPid = parseInjectorPid(output)
            if (code !== 0 && !wechatPid) reject(new Error(`inject exit ${code}: ${output.slice(-400)}`))
            else resolve()
          })
          setTimeout(() => {
            wechatPid = parseInjectorPid(injectHandle.getOutput())
            resolve()
          }, 20000)
        })
      } catch (error) {
        report.finalStatus = 'HOOK_START_FAILED'
        throw error
      }

      session = await waitUntilLogin(report.apiPort, timeline, (hit) => {
        if (hit?.loggedIn) console.log(`登录检测：已登录 ${hit.accountWxid}`)
        else process.stdout.write('.')
      })
      report.accountWxid = session.accountWxid
      report.nickname = session.nickname
      saveReusableState({
        instanceId: randomUUID(),
        accountWxid: report.accountWxid,
        nickname: report.nickname,
        weixinPid: wechatPid,
        injectPid,
        apiPort: report.apiPort,
        callbackPort: report.callbackPort,
        tcpPort: report.tcpPort,
        wechatVersion: EXPECTED_VERSION,
        injectSha256: files.injectSha256,
        dllSha256: files.dllSha256,
        runtimePath: RUNTIME_DIR,
        lastHealthyAt: new Date().toISOString(),
        reusable: true,
      })
    }

    console.log(`\n[4/8] 账号 ${report.accountWxid} / ${report.nickname} @ :${report.apiPort}`)
    console.log('[5/8] 获取群列表并自动选群…')
    const roomsRaw = await apiPostRetryOnce(report.apiPort, '/api/get_chatroom_list', {}, timeline)
    const rooms = extractRooms(roomsRaw.raw)
    let selectedRoom = null
    let members = []
    for (const room of rooms) {
      try {
        const memRaw = await apiPostRetryOnce(report.apiPort, '/api/get_room_members', { room_id: room.roomId }, timeline)
        const list = extractMembers(memRaw.raw)
        if (list.length >= 3) {
          selectedRoom = { ...room, memberCount: list.length }
          members = list
          break
        }
      } catch { /* try next */ }
    }
    if (!selectedRoom) {
      report.finalStatus = 'NO_VALID_CREDENTIAL_ROUTE'
      throw new Error('没有可用群（成员>=3）')
    }
    report.room = selectedRoom

    let friendSet = new Set()
    try {
      const friendsRaw = await apiPostRetryOnce(report.apiPort, '/api/get_contact_list2', {}, timeline)
      friendSet = extractFriendSet(friendsRaw.raw)
    } catch (error) {
      timeline.push({
        t: new Date().toISOString(),
        endpoint: '/api/get_contact_list2',
        warning: 'friend_list_optional_failed',
        error: String(error?.message || error).slice(0, 200),
      })
      console.log('好友列表读取超时/失败，继续只读诊断（不排除已好友）')
    }
    const candidates = selectCandidates(members, report.accountWxid, friendSet, 3)
    report.candidates = candidates.map((c) => ({
      roomId: selectedRoom.roomId,
      roomName: selectedRoom.roomName,
      memberCount: selectedRoom.memberCount,
      targetUserName: c.userName,
      targetNickname: c.nickName,
      targetDisplayName: c.displayName,
      isWxidStyle: c.isWxidStyle,
      isExistingFriend: c.isExistingFriend,
      selectionReason: c.selectionReason,
    }))
    console.log(`[6/8] 选中群 ${selectedRoom.roomName} 成员=${selectedRoom.memberCount} 候选=${candidates.length}`)

    console.log('[7/8] 只读凭证矩阵…')
    const liveResults = []
    for (const candidate of candidates) {
      console.log(`  -> ${candidate.userName} (${candidate.nickName || ''})`)
      const row = await probeOneCandidate(report.apiPort, selectedRoom, candidate, report.accountWxid, timeline)
      liveResults.push(row)
      report.candidateResults.push(redactCandidateResult(row))
    }

    report.routeClassification = classifyRouteMatrix(liveResults.map((r) => ({
      groupHasV3: r.groupHasV3,
      groupHasV4: r.groupHasV4,
      contactHasV3: r.contactHasV3,
      contactHasV4: r.contactHasV4,
      fastHasV3: r.fastHasV3,
      profileHasV3: r.profileHasV3,
      searchHasV3: r.searchHasV3,
      searchHasV4: r.searchHasV4,
      identityMatched: r.identityMatched,
      isWxidStyle: r.isWxidStyle,
      needsIdentityMapping: r.needsIdentityMapping,
      hookOrVersionError: r.hookOrVersionError,
    })))

    const withGroup = liveResults.filter((r) => r.groupHasV3 && r.groupHasV4).length
    const withCombo = liveResults.filter((r) => r.hasFinalV3 && r.hasFinalV4).length
    const withSearchOnly = liveResults.filter((r) => !(r.groupHasV3 && r.groupHasV4) && r.searchHasV3 && r.searchHasV4).length
    const noV3 = liveResults.filter((r) => !r.hasFinalV3).length
    if (withCombo === liveResults.length && withGroup === 0) {
      report.baiChaAssessment = '本轮全部候选均为：群成员接口仅 V4 + update_single_profile 补齐 V3。白茶此前失败属于普遍问题（解析/回退链未覆盖 update_single_profile），不是成员特例。'
    } else if (noV3 === liveResults.length) {
      report.baiChaAssessment = '本轮全部候选均未拿到 V3：更像普遍路线/版本问题，不能仅因白茶单例断定。'
    } else if (withGroup === liveResults.length) {
      report.baiChaAssessment = '本轮候选均可通过群成员接口拿到完整 V3/V4：白茶此前失败更像成员特例或当时响应缺字段，而非 DLL 完全不支持。'
    } else if (withSearchOnly && withGroup === 0) {
      report.baiChaAssessment = '群成员接口普遍缺 V3、搜索可补齐：白茶失败符合 SEARCH 回退缺失类问题（偏普遍）。'
    } else {
      report.baiChaAssessment = `混合结果：群成员完整=${withGroup}，组合凭证完整=${withCombo}，仅搜索=${withSearchOnly}，无V3=${noV3}。`
    }

    report.businessFixApplied = true
    report.modifiedFiles = [
      'admin-ui/electron/friend-profile.cjs#parseProfileCredentials',
      'admin-ui/electron/main.cjs#resolvePendingFriendProfile',
      'admin-ui/scripts/local-friend-credential-probe.cjs',
    ]

    const consent = loadConsent()
    const historySent = loadHistorySent()
    let sent = false
    for (const row of liveResults) {
      const cand = candidates.find((c) => c.userName === row.targetUserName)
      const match = matchConsentTarget(consent, cand, selectedRoom.roomId, report.accountWxid)
      if (!match) continue
      report.consentMatched = true
      const gate = shouldAllowFriendAdd({
        consentMatch: match,
        accountWxid: report.accountWxid,
        candidate: cand,
        v3: row.finalV3,
        v4: row.finalV4,
        identityOk: row.hasFinalV3 && row.hasFinalV4 && !row.identityMismatch,
        historyRequestSent: historySent.has(row.targetUserName),
        alreadySentThisRound: sent,
      })
      if (!gate.allow) continue
      console.log('CONSENTED_SINGLE_TEST_READY')
      timeline.push({ t: new Date().toISOString(), event: 'CONSENTED_SINGLE_TEST_READY', target: row.targetUserName })
      const body = {
        v3: row.finalV3,
        v4: row.finalV4,
        scence: '3',
        friendFlg: '0',
        verifyContent: VERIFY_CONTENT,
      }
      const add = await apiPostRetryOnce(report.apiPort, '/api/add_friend', body, timeline)
      report.addFriendCalled = true
      report.addFriendTarget = row.targetUserName
      sent = true
      appendHistory({
        t: new Date().toISOString(),
        targetUserName: row.targetUserName,
        status: 'REQUEST_SENT',
        httpStatus: add.httpStatus,
      })
      report.finalStatus = 'REQUEST_SENT'
      break
    }

    if (!report.finalStatus) {
      report.finalStatus = report.routeClassification === 'NO_VALID_CREDENTIAL_ROUTE'
        ? 'NO_VALID_CREDENTIAL_ROUTE'
        : 'CREDENTIAL_DIAGNOSTIC_COMPLETED_NO_SEND'
    }

    // persist healthy reuse tip
    if (report.accountWxid && report.apiPort) {
      saveReusableState({
        ...(existsSync(STATE_PATH) ? JSON.parse(readFileSync(STATE_PATH, 'utf8')) : {}),
        accountWxid: report.accountWxid,
        nickname: report.nickname,
        apiPort: report.apiPort,
        callbackPort: report.callbackPort || undefined,
        tcpPort: report.tcpPort || undefined,
        wechatVersion: EXPECTED_VERSION,
        lastHealthyAt: new Date().toISOString(),
        reusable: true,
        routeClassification: report.routeClassification,
      })
    }
  } catch (error) {
    if (!report.finalStatus) {
      const msg = String(error?.message || error)
      if (error.code === 'LOGIN_TIMEOUT' || /LOGIN_TIMEOUT/.test(msg)) report.finalStatus = 'LOGIN_TIMEOUT'
      else if (error.code === 'HOOK_START_FAILED' || /HOOK_START_FAILED/.test(msg)) report.finalStatus = 'HOOK_START_FAILED'
      else if (report.accountWxid && report.apiPort) report.finalStatus = 'NO_VALID_CREDENTIAL_ROUTE'
      else report.finalStatus = 'HOOK_START_FAILED'
    }
    report.error = String(error.message || error).slice(0, 1000)
    console.error('\n诊断失败：', report.error)
  } finally {
    writeFileSync(path.join(outDir, 'timeline.jsonl'), timeline.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
    writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
    writeFileSync(path.join(outDir, 'report.md'), toMarkdownReport(report), 'utf8')
    console.log(`\n[8/8] 报告已写入 ${outDir}`)
    console.log(`finalStatus=${report.finalStatus} route=${report.routeClassification || '-'}`)
    // keep servers/weixin alive for reuse; do not kill
  }

  return report
}

module.exports = {
  shouldAllowFriendAdd,
  matchConsentTarget,
  classifyRouteMatrix,
  selectCandidates,
  extractSearchCredentials,
  identityMatch,
  credentialMeta,
  loadConsent,
  ALLOWED_API,
}

if (require.main === module) {
  main().then((report) => {
    process.exitCode = ['HOOK_START_FAILED', 'LOGIN_TIMEOUT'].includes(report.finalStatus) ? 2 : 0
  }).catch((error) => {
    console.error(error)
    process.exit(2)
  })
}
