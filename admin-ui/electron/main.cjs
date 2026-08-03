const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, clipboard, screen, shell } = require('electron')

// 部分机器 GPU/驱动异常会导致进程在但窗口不显示/白屏
try { app.disableHardwareAcceleration() } catch {}
const { createHash, randomUUID } = require('crypto')
const { createReadStream, createWriteStream, existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, unlinkSync, statSync } = require('fs')
const { readdir, stat } = require('fs/promises')
const { pipeline } = require('stream/promises')
const { spawn, execFile } = require('child_process')
const { promisify } = require('util')
const net = require('net')
const http = require('http')
const https = require('https')
const path = require('path')
const { initStorage, saveSetting, getSettings, upsertInstance, listStoredInstances, removeInstance, removeInactiveInstancesByPorts, saveLog, listLogs, clearLogs, saveApiSample, saveEvent, listMemberJoins, listFriendAddStatuses, createTask, listTasks, getTaskItems, setTaskStatus, cancelTask, setTaskItemStatus, setTaskItemStarted, setTaskItemResult, recoverInterruptedTasks, repairConfirmedSendTextResults, reserveFriendDailyAttempt, reserveQrJoinDailyAttempt, hasDeliveredContent, recordDeliveredContent, hasDirectoryOwnership, syncDirectorySnapshot, remoteSyncSnapshot, saveQrItem, listQrItems, deleteQrItems, updateQrScanResult, getChatAddRule, saveChatAddRule, upsertChatAddCandidate, listChatAddCandidates, markChatAddCandidatesTasked, clearChatAddCandidates, hasQrContentHash } = require('./storage.cjs')
const { MAX_MESSAGE_BYTES, LengthPrefixedDecoder, hasFrequentEvidence, isVerifiedSuccess, evaluateFriendAddResult } = require('./protocol.cjs')
const { createSerialExecutor, parseInjectorOutput, decodeInjectorChunks, waitForInjectorClose } = require('./instance-runtime.cjs')
const { rawErrorMessage, toUserErrorMessage } = require('./user-error.cjs')
const { parseProfileCredentials, rawStructure } = require('./friend-profile.cjs')
const { startRemoteAgent, stopRemoteAgent, getStatus: getRemoteAgentStatus, openAdminConsole, DEFAULT_BASE } = require('./remote-agent.cjs')
const softwareAuth = require('./software-auth.cjs')
const { safeFolderName, classifyQrText, qrTypeLabel, contentHash, messageTableName, rowsFromApi, valueOf, fieldString, existingImagePath, cdnDownloadRequest, downloadRequest, decodeNativeImages, accurateFileName, prepareHistoryMessageRow, yieldMain, normalizeQrText } = require('./qr-collector.cjs')
const {
  parseInvitePreview,
  mergeInvitePreview,
  buildInvitePageRequest,
  extractA8KeyHttpHeaders,
  hasUsableInvitePreview,
  a8keyResponseUseful,
  evaluateEnterRoomResult,
  formatInvitePreviewLine,
  findRoomId,
} = require('./qr-join.cjs')
const { mergeMonitorRooms, extractRoomsFromApiRaw } = require('./qr-monitor-rooms.cjs')

/** 历史采集进行中标记，防止重复点击叠任务把主进程拖死 */
let historyCollectRunning = false

/**
 * 尝试 CDN 下载图片；优先一档，失败再回退一档，缩短超时避免卡死。
 * @param {object} record 微信实例
 * @param {unknown} row 消息行或事件
 * @param {string} temporaryPath 临时文件路径
 * @param {{ timeoutMs?: number, maxAttempts?: number }} [opts]
 * @returns {Promise<boolean>} 是否已写出有效文件
 */
async function tryDownloadQrImageViaCdn(record, row, temporaryPath, opts = {}) {
  const base = cdnDownloadRequest(row, temporaryPath)
  if (!base) return false
  const timeoutMs = Math.max(Number(opts.timeoutMs) || 12000, 3000)
  const maxAttempts = Math.max(Number(opts.maxAttempts) || 2, 1)
  const types = [...new Set([base.imgType, 2, 1, 3])].slice(0, maxAttempts)
  for (const imgType of types) {
    try {
      await requestApi(record, '/api/cdn_download', { ...base, imgType }, timeoutMs)
    } catch { /* 继续尝试下一档 */ }
    try {
      if (existsSync(temporaryPath) && statSync(temporaryPath).size > 64) return true
    } catch { /* ignore */ }
    deleteTemporaryImage(temporaryPath)
  }
  return false
}
const { matchChatAddRule } = require('./chat-add-friend.cjs')
const { isWeixinExe, detectPreferredWeixin, readFileVersion } = require('./weixin-detect.cjs')
const { BUILD_ID, VERSION, RELEASE_SEQUENCE } = require('./device-identity.cjs')
const {
  startUpdateScheduler,
  stopUpdateScheduler,
  DEFAULT_BASE: UPDATE_BASE,
  ipcCheckClientUpdate,
  ipcApplyClientUpdate,
  markStartupUpdateDone,
} = require('./client-updater.cjs')
const { safeCloneForIpc } = require('./ipc-safe.cjs')

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (app.isReady()) showMainWindow()
    else app.once('ready', showMainWindow)
  })
}

const isDev = !app.isPackaged

/**
 * 解析微信注入组件目录（禁止依赖本机绝对路径，保证换电脑可用）。
 * 打包后：resources/hook/4.1.8.27
 * 开发态：仓库相对路径 / admin-ui/resources 副本
 * @returns {string}
 */
function resolveHookSourceDir() {
  const packaged = path.join(process.resourcesPath || '', 'hook', '4.1.8.27')
  if (app.isPackaged && existsSync(path.join(packaged, 'inject.exe'))) return packaged
  const candidates = [
    path.join(__dirname, '..', 'resources', 'hook', '4.1.8.27'),
    path.join(__dirname, '..', '..', '4.1.8.27', '4.1.8.27'),
    path.join(process.cwd(), 'resources', 'hook', '4.1.8.27'),
    path.join(process.cwd(), '..', '4.1.8.27', '4.1.8.27'),
  ]
  for (const candidate of candidates) {
    if (existsSync(path.join(candidate, 'inject.exe'))) return candidate
  }
  return candidates[0]
}
const instances = new Map()
const contractsById = new Map()
const enqueueStart = createSerialExecutor()
const execFileAsync = promisify(execFile)
let diskMetricsCache = { bytes: 0, measuredAt: 0 }
let mainWindow = null
let splashWindow = null
let tray = null
let quitting = false
let runtimeAllowed = true
let qrMonitorConfig = { enabled: false, watchAll: false, rooms: [], outputDir: '', folder: '默认分组' }
/** roomId → 监控群配置，150+ 群时 O(1) 命中 */
let qrMonitorRoomById = new Map()
/** 监控去重哈希缓存，避免每张图全表扫库 */
let qrMonitorContentHashes = null
/** 非监控群图片忽略日志节流：roomHint → 上次记录时间 */
const qrMonitorSkipLogAt = new Map()
/** 每微信实例的监控下载队列：有限并发，避免 150 群同时发图时排成长龙 */
const qrMonitorQueues = new Map()
const QR_MONITOR_CONCURRENCY = 2
/** watchAll 模式下定时从微信拉群列表，自动并入新进群 */
const QR_MONITOR_SYNC_INTERVAL_MS = 45000
let qrMonitorSyncTimer = undefined
let qrMonitorSyncRunning = false
const qrValidityCache = new Map()

/**
 * 重建监控群索引（开启/恢复配置时调用）。
 */
function rebuildQrMonitorRoomIndex() {
  const map = new Map()
  for (const room of Array.isArray(qrMonitorConfig.rooms) ? qrMonitorConfig.rooms : []) {
    const roomId = String(room?.roomId || '').trim()
    if (roomId) map.set(roomId, room)
  }
  qrMonitorRoomById = map
}

/**
 * 向渲染进程广播监控群列表变化（用于 UI 自增长显示）。
 * @param {{ added?: Array<{ instanceId: string, roomId: string, name: string }>, reason?: string }} [detail]
 */
function notifyQrMonitorRoomsChanged(detail = {}) {
  const payload = {
    enabled: Boolean(qrMonitorConfig.enabled),
    watchAll: Boolean(qrMonitorConfig.watchAll),
    watchedCount: qrMonitorRoomById.size,
    rooms: Array.isArray(qrMonitorConfig.rooms) ? qrMonitorConfig.rooms : [],
    added: Array.isArray(detail.added) ? detail.added : [],
    reason: String(detail.reason || ''),
  }
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send('qr:monitor-rooms-changed', payload) } catch { /* ignore */ }
  }
}

/**
 * 增量合并监控群；有新增时重建索引并持久化。
 * @param {Array<{ instanceId: string, roomId: string, name?: string }>} rooms
 * @param {{ reason?: string, persist?: boolean }} [options]
 * @returns {{ added: Array<{ instanceId: string, roomId: string, name: string }>, rooms: Array<{ instanceId: string, roomId: string, name: string }> }}
 */
function addQrMonitorRooms(rooms, options = {}) {
  const { rooms: nextRooms, added } = mergeMonitorRooms(qrMonitorConfig.rooms, rooms)
  if (!added.length && nextRooms.length === (qrMonitorConfig.rooms || []).length) {
    // 可能仅更新了 instanceId/name，仍以合并结果为准
    const changed = JSON.stringify(nextRooms) !== JSON.stringify(qrMonitorConfig.rooms || [])
    if (!changed) return { added: [], rooms: nextRooms }
  }
  qrMonitorConfig = { ...qrMonitorConfig, rooms: nextRooms }
  rebuildQrMonitorRoomIndex()
  if (options.persist !== false) {
    try { saveSetting('qrMonitor', qrMonitorConfig) } catch { /* 回写失败不阻断 */ }
  }
  if (added.length) {
    appLog('INFO', `监控群列表已自动扩容 +${added.length}`, {
      module: '二维码监控',
      operation: '自动扩容',
      reason: options.reason || '',
      added: added.slice(0, 5).map((item) => item.roomId),
      watchedCount: qrMonitorRoomById.size,
      watchAll: Boolean(qrMonitorConfig.watchAll),
    })
    notifyQrMonitorRoomsChanged({ added, reason: options.reason || '' })
  }
  return { added, rooms: nextRooms }
}

/**
 * 启动/停止 watchAll 定时同步。
 */
function ensureQrMonitorSyncTimer() {
  const shouldRun = Boolean(qrMonitorConfig.enabled && qrMonitorConfig.watchAll)
  if (!shouldRun) {
    if (qrMonitorSyncTimer) {
      clearInterval(qrMonitorSyncTimer)
      qrMonitorSyncTimer = undefined
    }
    return
  }
  if (qrMonitorSyncTimer) return
  qrMonitorSyncTimer = setInterval(() => { void syncQrMonitorRoomsFromWechat('定时刷新') }, QR_MONITOR_SYNC_INTERVAL_MS)
  // 开启后立刻同步一次，避免等满一个周期
  setImmediate(() => { void syncQrMonitorRoomsFromWechat('开启后首次刷新') })
}

/**
 * 从在线微信拉取群列表，把新群并入监控（仅 watchAll）。
 * @param {string} [reason]
 */
async function syncQrMonitorRoomsFromWechat(reason = '同步群列表') {
  if (!qrMonitorConfig.enabled || !qrMonitorConfig.watchAll || qrMonitorSyncRunning) return
  qrMonitorSyncRunning = true
  try {
    const online = [...instances.values()].filter((item) => item.status === 'ONLINE')
    if (!online.length) return
    const incoming = []
    for (const record of online) {
      try {
        const [listRes, detailRes] = await Promise.all([
          requestApi(record, '/api/get_chatroom_list', {}, 30000),
          requestApi(record, '/api/get_all_room_detail', {}, 90000),
        ])
        const rows = [
          ...extractRoomsFromApiRaw(listRes.response.ok ? listRes.raw : null),
          ...extractRoomsFromApiRaw(detailRes.response.ok ? detailRes.raw : null),
        ]
        for (const row of rows) {
          incoming.push({ instanceId: record.id, roomId: row.roomId, name: row.name })
        }
      } catch (error) {
        appLog('WARN', '监控群列表刷新失败', {
          instanceId: record.id,
          module: '二维码监控',
          operation: '自动扩容',
          error: rawErrorMessage(error),
        })
      }
    }
    if (incoming.length) addQrMonitorRooms(incoming, { reason })
  } finally {
    qrMonitorSyncRunning = false
  }
}

/**
 * 从事件快速提取可能的群 ID（优先常见字段，避免对 150 群逐个深遍历）。
 * @param {unknown} event
 * @returns {string[]}
 */
function extractEventRoomIds(event) {
  const ids = []
  const push = (value) => {
    const text = String(value || '').trim()
    if (text.endsWith('@chatroom') && !ids.includes(text)) ids.push(text)
  }
  if (!event || typeof event !== 'object') return ids
  push(fieldString(event, ['toUserName', 'to_user_name', 'fromUserName', 'from_user_name', 'roomId', 'room_id', 'chatroomName', 'chatRoomName', 'chatroomId']))
  for (const key of ['data', 'raw', 'msg', 'message', 'content']) {
    const nested = event[key]
    if (nested && typeof nested === 'object') {
      push(fieldString(nested, ['toUserName', 'to_user_name', 'fromUserName', 'from_user_name', 'roomId', 'room_id']))
    }
  }
  return ids
}

/**
 * 深遍历一次事件，命中任一监控 roomId 即返回（用于字段缺失的回调形态）。
 * @param {unknown} event
 * @returns {{ instanceId: string, roomId: string, name: string } | null}
 */
function findMonitoredRoomDeep(event) {
  if (!qrMonitorRoomById.size) return null
  const seen = new Set()
  let found = null
  const walk = (value) => {
    if (found || value == null) return
    if (typeof value === 'string') {
      if (qrMonitorRoomById.has(value)) found = qrMonitorRoomById.get(value)
      return
    }
    if (typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    for (const child of Object.values(value)) walk(child)
  }
  walk(event)
  return found
}

/**
 * 轻量判断是否像图片消息，避免对每条 TCP 回调 JSON.stringify。
 * @param {unknown} event
 * @returns {boolean}
 */
function looksLikeImageEvent(event) {
  const type = Number(valueOf(event, ['type', 'local_type', 'message_type', 'msgType']))
  if (type === 3) return true
  const desc = String(valueOf(event, ['messageDesc', 'event_desc', 'eventDesc', 'message_desc']) || '')
  if (/自己发送的图片|图片消息|\bimage\b/i.test(desc)) return true
  if (valueOf(event, ['cdnmidImgUrl', 'cdnmidimgurl', 'cdnbigImgUrl', 'cdnbigimgurl', 'aeskey', 'aesKey'])) return true
  const content = fieldString(event, ['content', 'message_content', 'msgContent', 'content_xml', 'xml'])
  if (content && /cdnmidImgUrl|cdnbigImgUrl|cdnthumbImgUrl|<img\b|aeskey|KLUv\//i.test(content.slice(0, 6000))) return true
  return false
}

/**
 * 监控下载队列：每微信最多 QR_MONITOR_CONCURRENCY 路并发。
 * @param {string} instanceId
 * @param {() => Promise<unknown>} job
 * @returns {Promise<unknown>}
 */
function enqueueQrMonitorJob(instanceId, job) {
  let state = qrMonitorQueues.get(instanceId)
  if (!state) {
    state = { active: 0, pending: [] }
    qrMonitorQueues.set(instanceId, state)
  }
  return new Promise((resolve, reject) => {
    state.pending.push({ job, resolve, reject })
    pumpQrMonitorQueue(instanceId)
  })
}

/**
 * 推进指定微信的监控下载队列。
 * @param {string} instanceId
 */
function pumpQrMonitorQueue(instanceId) {
  const state = qrMonitorQueues.get(instanceId)
  if (!state) return
  while (state.active < QR_MONITOR_CONCURRENCY && state.pending.length) {
    const item = state.pending.shift()
    state.active += 1
    Promise.resolve()
      .then(() => item.job())
      .then(item.resolve, item.reject)
      .finally(() => {
        state.active -= 1
        if (!state.pending.length && state.active <= 0) qrMonitorQueues.delete(instanceId)
        else pumpQrMonitorQueue(instanceId)
      })
  }
}

/**
 * 监控用内容哈希集合（进程内缓存）。
 * @returns {Set<string>}
 */
function monitorContentHashes() {
  if (!qrMonitorContentHashes) qrMonitorContentHashes = qrContentHashSet()
  return qrMonitorContentHashes
}

function pauseActiveTasks(reason = '管理员已暂停软件运行') {
  for (const task of listTasks()) {
    if (['RUNNING', 'QUEUED', 'COOLING_DOWN'].includes(task.status)) {
      setTaskStatus(task.id, 'PAUSED')
      appLog('INFO', reason, { taskId: task.id, previousStatus: task.status })
    }
  }
}

function remoteAgentOptions(account, baseUrl = DEFAULT_BASE) {
  return {
    userDataDir: app.getPath('userData'), baseUrl, account,
    onLog: (message, details) => appLog('INFO', message, details || {}),
    onPolicy: async (allowed, message) => {
      runtimeAllowed = Boolean(allowed)
      appLog(allowed ? 'INFO' : 'ERROR', allowed ? '后台已恢复软件运行' : '后台已暂停软件运行', { reason: message?.message || '' })
      if (!allowed) pauseActiveTasks('后台暂停运行，任务已停止')
      if (!allowed && mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, { type: 'warning', title: '软件已暂停', message: String(message?.message || '管理员已暂停本软件运行') })
    },
    onAnnouncement: async (message) => {
      if (mainWindow && !mainWindow.isDestroyed()) await dialog.showMessageBox(mainWindow, { type: 'info', title: String(message?.title || '公告'), message: String(message?.text || '管理员发送了一条公告') })
    },
    getSyncSnapshot: () => remoteSyncSnapshot(),
  }
}

function requireRuntime() { if (!runtimeAllowed) throw new Error('管理员已暂停软件运行，请联系管理员') }

async function pathSize(target) {
  try {
    const info = await stat(target)
    if (info.isFile()) return info.size
    if (!info.isDirectory()) return 0
    const entries = await readdir(target, { withFileTypes: true })
    let total = 0
    for (const entry of entries) if (!entry.isSymbolicLink()) total += await pathSize(path.join(target, entry.name))
    return total
  } catch { return 0 }
}

async function softwareMetrics() {
  const metrics = app.getAppMetrics()
  const cpuPercent = metrics.reduce((sum, item) => sum + Number(item.cpu?.percentCPUUsage || 0), 0)
  const memoryBytes = metrics.reduce((sum, item) => sum + Number(item.memory?.workingSetSize || 0) * 1024, 0)
  if (!diskMetricsCache.measuredAt || Date.now() - diskMetricsCache.measuredAt > 30000) {
    const targets = app.isPackaged ? [process.resourcesPath, app.getPath('userData')] : [app.getPath('userData')]
    diskMetricsCache = { bytes: (await Promise.all([...new Set(targets)].map(pathSize))).reduce((sum, size) => sum + size, 0), measuredAt: Date.now() }
  }
  return { uptimeSeconds: process.uptime(), cpuPercent: Math.min(Math.max(cpuPercent, 0), 100), memoryBytes, diskBytes: diskMetricsCache.bytes, processCount: metrics.length, measuredAt: new Date().toISOString() }
}

function generalSettings() {
  const value = getSettings().general
  return value && typeof value === 'object' ? value : {}
}

/**
 * 读取当前配置的微信路径；无效时不回落到硬编码盘符。
 * @returns {string}
 */
function configuredWeixinExe() {
  const configured = generalSettings().weixinExe
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured.trim())
  return ''
}

/**
 * 启动或启动微信前确保有可用 Weixin.exe：优先已有有效配置，否则自动探测并写入设置。
 * @param {{ force?: boolean }} [options] force=true 时重新探测并覆盖无效路径
 * @returns {{ ok: boolean, exePath: string, version: string, source: string, candidates: Array<{ exePath: string, version: string, source: string }>, message?: string }}
 */
function ensureWeixinPathConfigured(options = {}) {
  const current = configuredWeixinExe()
  // 已配置且文件仍在：启动路径直接返回，禁止为读版本再拉起 PowerShell
  if (!options.force && isWeixinExe(current)) {
    return {
      ok: true,
      exePath: current,
      version: '',
      source: 'settings',
      candidates: [{ exePath: current, version: '', source: 'settings' }],
    }
  }
  const detected = detectPreferredWeixin()
  if (detected?.exePath && isWeixinExe(detected.exePath)) {
    const next = normalizeSettings({ ...generalSettings(), weixinExe: detected.exePath })
    saveSetting('general', next)
    appLog('INFO', '已自动识别微信安装路径', {
      module: '文件位置',
      operation: '自动探测微信',
      path: detected.exePath,
      version: detected.version || '',
      source: detected.source,
    })
    return {
      ok: true,
      exePath: detected.exePath,
      version: detected.version || '',
      source: detected.source || 'auto',
      candidates: detected.candidates || [],
    }
  }
  const message = '未能自动找到本机微信（Weixin.exe），请到“日志与设置 - 文件位置”手动选择'
  appLog('WARNING', message, { module: '文件位置', operation: '自动探测微信' })
  return { ok: false, exePath: current || '', version: '', source: '', candidates: [], message }
}

function validPort(value, fallback) {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : fallback
}

function normalizeSettings(value) {
  const source = value && typeof value === 'object' ? value : {}
  const intervalMin = Math.max(Number(source.intervalMin) || 20, 1)
  const apiPort = validPort(source.httpPort, 19088)
  let tcpPort = validPort(source.tcpPort, 61108)
  if (tcpPort === apiPort) tcpPort = apiPort < 65534 ? apiPort + 2 : apiPort - 2
  const weixinExe = typeof source.weixinExe === 'string' && source.weixinExe.trim()
    ? path.resolve(source.weixinExe.trim())
    : ''
  return {
    intervalMin,
    intervalMax: Math.max(Number(source.intervalMax) || 40, intervalMin),
    httpPort: apiPort,
    tcpPort,
    friendDailyLimit: Math.max(Number(source.friendDailyLimit) || 50, 1),
    qrDir: typeof source.qrDir === 'string' ? source.qrDir : '',
    weixinExe,
  }
}

function appLog(level, message, details = {}) {
  const entry = { time: new Date().toISOString(), level, message, ...details }
  try {
    const logDir = path.join(app.getPath('userData'), 'logs')
    mkdirSync(logDir, { recursive: true })
    appendFileSync(path.join(logDir, 'wechat-control.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {}
  try { saveLog(entry) } catch {}
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('wechat:log', entry)
}

const apiOperationLabels = {
  '/api/send_text_msg': '发送文字消息', '/api/send_image_msg': '发送图片消息', '/api/add_friend': '添加好友',
  '/api/get_contact_list2': '读取好友列表', '/api/get_chatroom_list': '读取群聊列表', '/api/batch_getroom_cache': '读取群聊资料', '/api/get_all_room_detail': '读取全量群详情',
  '/api/get_room_members': '读取群成员', '/api/get_group_member_contact': '读取群成员资料', '/api/save_chatroom_to_contact': '保存群聊到通讯录',
  '/api/check_login': '检测微信登录状态', '/api/get_profile_cache': '读取微信资料',
  '/api/qrscan': '识别二维码', '/api/get_db_handle': '读取消息库', '/api/sqlite3_exec': '读取群聊历史', '/api/download_img': '下载历史图片', '/api/cdn_download': '下载高清原图', '/api/get_a8key': '验证二维码有效期',
}

const DEFAULT_FRIEND_VERIFY_CONTENT = '你好，我是群里的朋友'

function apiOperationLabel(apiPath) {
  return apiOperationLabels[apiPath] || '执行微信功能'
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file).on('error', reject).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex').toUpperCase()))
  })
}

function quoteSqlIdentifier(value) { return `"${String(value).replaceAll('"', '""')}"` }
function deleteTemporaryImage(file) { try { if (file && existsSync(file)) unlinkSync(file) } catch {} }

/**
 * 采集单个群的历史图片二维码（轻量路径：少列查询、快扫码、跳过链接有效期校验）。
 * @param {object} record 微信实例
 * @param {{ roomId: string, name: string }} room 群
 * @param {{ outputDir: string, folder: string, maxImages?: number, onProgress?: Function, existingHashes?: Set<string> }} options
 * @param {{ databaseNames: string[]|null, tables: Map<string, string[]> }} context
 */
async function collectRoomQrImages(record, room, options, context) {
  if (!context.databaseNames) {
    const handleResult = await requestApi(record, '/api/get_db_handle', {}, 5000)
    if (!handleResult.response.ok) throw new Error('无法读取微信消息库')
    context.databaseNames = rowsFromApi(handleResult.raw).map((item) => String(item.name || '')).filter((name) => /^message_\d+\.db$/i.test(name))
  }
  const expectedTable = messageTableName(room.roomId)
  const result = { checked: 0, saved: 0, duplicates: 0, expired: 0, nonQr: 0, unavailable: 0 }
  const existingHashes = options.existingHashes || qrContentHashSet()
  // 0 / 未传 = 检查该群全部图片消息；若显式传入正数则按该上限（防极端大群拖死可设安全顶）
  const rawLimit = Number(options.maxImages)
  const unlimited = !Number.isFinite(rawLimit) || rawLimit <= 0
  const limit = unlimited ? 0 : Math.min(Math.max(Math.floor(rawLimit), 1), 10000)
  for (const databaseName of context.databaseNames) {
    if (!context.tables.has(databaseName)) {
      const schemaResult = await requestApi(record, '/api/sqlite3_exec', { db_name: databaseName, sql_fmt: "SELECT name FROM sqlite_master WHERE type='table'" }, 8000)
      context.tables.set(databaseName, schemaResult.response.ok ? rowsFromApi(schemaResult.raw).map((row) => String(valueOf(row, ['name']) || '')).filter(Boolean) : [])
      await yieldMain()
    }
    const table = context.tables.get(databaseName).find((name) => name.toLowerCase() === expectedTable.toLowerCase())
    if (!table) continue
    const columnsResult = await requestApi(record, '/api/sqlite3_exec', { db_name: databaseName, sql_fmt: `PRAGMA table_info(${quoteSqlIdentifier(table)})` }, 8000)
    await yieldMain()
    const columns = rowsFromApi(columnsResult.raw).map((row) => String(valueOf(row, ['name']) || '')).filter(Boolean)
    const typeColumn = columns.find((name) => ['local_type', 'type', 'message_type'].includes(name.toLowerCase()))
    const orderColumn = columns.find((name) => ['create_time', 'sort_seq', 'local_id'].includes(name.toLowerCase()))
    if (!typeColumn) continue
    // 只取 CDN 所需列，不取 source（再解压一份会拖慢）
    const selectCols = ['local_id', 'server_id', 'message_content', typeColumn, orderColumn].filter(Boolean)
      .filter((name, index, arr) => arr.findIndex((item) => String(item).toLowerCase() === String(name).toLowerCase()) === index)
      .map((name) => quoteSqlIdentifier(name))
    const limitSql = limit > 0 ? ` LIMIT ${limit}` : ''
    const sql = `SELECT ${selectCols.join(', ')} FROM ${quoteSqlIdentifier(table)} WHERE ${quoteSqlIdentifier(typeColumn)}=3${orderColumn ? ` ORDER BY ${quoteSqlIdentifier(orderColumn)} DESC` : ''}${limitSql}`
    const messagesResult = await requestApi(record, '/api/sqlite3_exec', { db_name: databaseName, sql_fmt: sql }, 20000)
    if (!messagesResult.response.ok) continue
    const rows = rowsFromApi(messagesResult.raw)
    await yieldMain()
    for (const rawRow of rows) {
      result.checked += 1
      if (typeof options.onProgress === 'function') {
        try { options.onProgress({ roomName: room.name, checked: result.checked, total: rows.length, saved: result.saved }) } catch { /* ignore */ }
      }
      const row = prepareHistoryMessageRow(rawRow)
      const temporaryFolder = path.join(app.getPath('temp'), 'wx-group-qr-collector')
      mkdirSync(temporaryFolder, { recursive: true })
      const temporaryPath = path.join(temporaryFolder, `${randomUUID()}.jpg`)
      // 历史采集只用 CDN（单次超时），避免 download_img 长时间挂起导致假死
      const viaCdn = await tryDownloadQrImageViaCdn(record, row, temporaryPath, { timeoutMs: 8000, maxAttempts: 1 })
      if (!viaCdn) {
        deleteTemporaryImage(temporaryPath)
        result.unavailable += 1
        await yieldMain()
        continue
      }
      const classified = await saveClassifiedQrImage(record, room, temporaryPath, row, {
        ...options,
        validateLinks: false,
        decodeMode: 'fast',
        existingHashes,
      })
      result.saved += classified.saved
      result.duplicates += classified.duplicates
      result.expired += classified.expired || 0
      if (!classified.detected) result.nonQr += 1
      deleteTemporaryImage(temporaryPath)
      await yieldMain()
    }
  }
  return result
}

/**
 * 从库中收集「内容哈希」集合（忽略重复落库行的 dup: 前缀）。
 * @returns {Set<string>}
 */
function qrContentHashSet() {
  const set = new Set()
  for (const item of listQrItems()) {
    const sha = String(item.sha256 || '')
    if (sha.startsWith('dup:')) {
      const real = sha.slice(4).split(':')[0]
      if (real) set.add(real.toUpperCase())
    } else if (sha) {
      set.add(sha.toUpperCase())
    }
    // 用当前归一化规则重算，兼容历史「未去参」链接，避免同邀请再存一份
    if (item.decodedText) set.add(contentHash(item.decodedText))
  }
  return set
}

/**
 * 解码图片中全部二维码；同图多码保留多条内容记录，但共享一个物理图片文件。
 * @param {object} record 微信实例
 * @param {{ roomId: string, name: string }} room 监控群
 * @param {string} sourcePath 图片路径
 * @param {unknown} message 消息事件
 * @param {{ outputDir: string, folder: string }} options 保存配置
 * @returns {Promise<{ detected: number, saved: number, duplicates: number, expired: number, types: string[] }>}
 */
async function saveClassifiedQrImage(record, room, sourcePath, message, options) {
  const decodeMode = options?.decodeMode === 'fast' ? 'fast' : 'full'
  const decodedValues = await decodeNativeImages(nativeImage.createFromPath(sourcePath), { mode: decodeMode })
  // 同图内先按归一化内容去重（海报常贴两个一模一样的群码）
  const recognized = []
  const seenInImage = new Set()
  for (const decodedText of decodedValues) {
    const qrType = classifyQrText(decodedText)
    if (qrType === 'UNKNOWN') continue
    const hash = contentHash(decodedText)
    if (!hash || seenInImage.has(hash)) continue
    seenInImage.add(hash)
    recognized.push({ decodedText: normalizeQrText(decodedText) || String(decodedText || '').trim(), qrType, hash })
  }
  const result = { detected: recognized.length, saved: 0, duplicates: 0, expired: 0, types: [] }
  const existing = options?.existingHashes instanceof Set
    ? options.existingHashes
    : qrContentHashSet()
  const validateLinks = options?.validateLinks !== false
  const extension = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'].includes(path.extname(sourcePath).toLowerCase())
    ? path.extname(sourcePath).toLowerCase()
    : '.jpg'
  const imageFileHash = await sha256(sourcePath)
  let sharedDestination = ''
  for (const item of recognized) {
    const hash = item.hash
    // 先占位，避免监控并发 2 路同时通过「未存在」检查而各存一份
    if (existing.has(hash) || hasQrContentHash(hash)) {
      existing.add(hash)
      result.duplicates += 1
      continue
    }
    existing.add(hash)
    // 历史批量采集跳过 a8key，避免每张图网络校验把界面卡死；监控实时仍校验
    if (validateLinks && !await isQrLinkCurrentlyValid(record, item.decodedText, item.qrType)) {
      existing.delete(hash)
      result.expired += 1
      continue
    }
    // 二次确认：异步校验期间另一路可能已入库
    if (hasQrContentHash(hash)) {
      result.duplicates += 1
      continue
    }
    const typeLabel = qrTypeLabel(item.qrType)
    if (!sharedDestination) {
      const destinationFolder = path.join(options.outputDir, safeFolderName(options.folder, '默认分组'), typeLabel)
      mkdirSync(destinationFolder, { recursive: true })
      // 文件名使用整张图片哈希：同一海报即使含多个不同二维码，也只保存一份图片。
      sharedDestination = path.join(
        destinationFolder,
        `${safeFolderName(typeLabel, '未知类型')}_${String(imageFileHash).slice(0, 16).toUpperCase()}${extension}`,
      )
    }
    const destination = sharedDestination
    if (existsSync(destination)) {
      if (!hasQrContentHash(hash)) {
        saveQrItem({
          id: randomUUID(),
          sha256: hash,
          source: `${record.nickname || record.accountWxid} · ${room.name}`,
          localPath: destination,
          decodedText: item.decodedText,
          qrType: item.qrType,
          status: 'CLASSIFIED',
        })
        result.saved += 1
      } else {
        result.duplicates += 1
      }
      if (!result.types.includes(typeLabel)) result.types.push(typeLabel)
      continue
    }
    await copyVerified(sourcePath, destination)
    if (hasQrContentHash(hash)) {
      // 同图多码共享文件；并发输家不能删除可能已被其他二维码记录引用的文件。
      result.duplicates += 1
      continue
    }
    saveQrItem({
      id: randomUUID(),
      sha256: hash,
      source: `${record.nickname || record.accountWxid} · ${room.name}`,
      localPath: destination,
      decodedText: item.decodedText,
      qrType: item.qrType,
      status: 'CLASSIFIED',
    })
    result.saved += 1
    if (!result.types.includes(typeLabel)) result.types.push(typeLabel)
  }
  return result
}

/**
 * 校验二维码链接是否仍有效。
 * 群码走 a8key 确认特征；个人码仅在明确过期时拒绝；QQ 群码网络失败仍允许保存。
 * @param {object} record 微信实例
 * @param {string} decodedText 链接文本
 * @param {string} qrType 分类
 * @returns {Promise<boolean>}
 */
async function isQrLinkCurrentlyValid(record, decodedText, qrType) {
  const key = contentHash(decodedText)
  const cached = qrValidityCache.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.valid
  let valid = false
  try {
    if (qrType === 'GROUP_LINK') {
      const checked = await requestApi(record, '/api/get_a8key', { url: decodedText, urlType: '0', scene: '0' }, 10000)
      const body = JSON.stringify(checked.raw || {})
      const expired = /二维码.{0,8}(?:过期|失效)|邀请.{0,8}(?:过期|失效)|expired|invalid|"ret"\s*:\s*-[1-9]/i.test(body)
      const confirmed = /addchatroombyinvite|"ret"\s*:\s*0|"status"\s*:\s*"?success|"ok"\s*:\s*true/i.test(body)
      valid = checked.response.ok && confirmed && !expired
    } else if (qrType === 'PERSONAL_LINK') {
      // 个人码 a8key 返回形态多样，不要求群邀请特征；仅明确过期才拒绝
      const checked = await requestApi(record, '/api/get_a8key', { url: decodedText, urlType: '0', scene: '0' }, 10000)
      const body = JSON.stringify(checked.raw || {})
      const expired = /二维码.{0,8}(?:过期|失效)|邀请.{0,8}(?:过期|失效)|链接.{0,8}(?:过期|失效)|expired|invalid|已失效|"ret"\s*:\s*-[1-9]/i.test(body)
      if (!checked.response.ok) {
        valid = true
      } else {
        valid = !expired
      }
    } else if (qrType === 'QQ_GROUP_LINK') {
      try {
        const response = await fetch(decodedText, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) })
        const body = await response.text()
        const expired = /二维码.{0,8}(?:过期|失效)|邀请.{0,8}(?:过期|失效)|链接.{0,8}(?:过期|失效)|expired|invalid|已失效/i.test(body)
        // QQ 群链接常有跳转/拦截页，只要未明确过期就保存
        valid = !expired
      } catch {
        valid = true
      }
    } else {
      const response = await fetch(decodedText, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 MicroMessenger/8.0' }, signal: AbortSignal.timeout(10000) })
      const body = await response.text()
      const expired = /二维码.{0,8}(?:过期|失效)|邀请.{0,8}(?:过期|失效)|链接.{0,8}(?:过期|失效)|expired|invalid/i.test(body)
      valid = response.ok && !expired
    }
  } catch { valid = qrType === 'QQ_GROUP_LINK' }
  qrValidityCache.set(key, { valid, expiresAt: Date.now() + (valid ? 60 * 60 * 1000 : 10 * 60 * 1000) })
  if (!valid) appLog('INFO', '二维码已过期或无法确认有效，未保存', { instanceId: record.id, module: '二维码监控', operation: '验证二维码有效期', qrType })
  return valid
}

/** 群聊加好友未命中原因节流，避免刷屏 */
const chatAddMissLogAt = new Map()

/**
 * 微信重启后 instanceId 会变：把监听规则自动绑到当前在线实例（同账号优先）。
 * @param {{ id: string, accountWxid?: string, status?: string }} record
 * @returns {ReturnType<typeof getChatAddRule>}
 */
function ensureChatAddRuleBound(record) {
  const rule = getChatAddRule()
  if (!rule.enabled) return rule
  if (!record?.id) return rule
  if (rule.instanceId && rule.instanceId === record.id) return rule

  const bound = rule.instanceId ? instances.get(rule.instanceId) : null
  const boundOnline = Boolean(bound && bound.status === 'ONLINE')
  if (boundOnline && rule.instanceId !== record.id) return rule

  const boundWxid = String(bound?.accountWxid || '')
  const currentWxid = String(record.accountWxid || '')
  // 旧实例已不在线/不存在时，自动改绑；多开时仅同账号才改绑
  if (rule.instanceId && boundWxid && currentWxid && boundWxid !== currentWxid) return rule

  const next = {
    enabled: rule.enabled,
    instanceId: record.id,
    roomIds: rule.roomIds,
    keywords: rule.keywords,
    excludeText: rule.excludeText,
  }
  saveChatAddRule(next)
  appLog('INFO', '群聊加好友监听已自动绑定到当前微信实例', {
    instanceId: record.id,
    module: '群聊加好友',
    operation: '自动绑定实例',
    previousInstanceId: rule.instanceId || '',
    accountWxid: currentWxid,
  })
  return getChatAddRule()
}

/**
 * 处理群聊发言加好友：命中监听规则后写入候选表，供页面生成任务。
 * @param {{ id: string, accountWxid?: string }} record 微信实例
 * @param {unknown} event TCP 回调事件
 * @returns {{ accepted: boolean, reason?: string } | undefined}
 */
function handleChatAddFriendEvent(record, event) {
  let rule = getChatAddRule()
  if (!rule.enabled) return { accepted: false, reason: 'DISABLED' }
  rule = ensureChatAddRuleBound(record)
  const matched = matchChatAddRule(event, { ...rule, accountWxid: record.accountWxid }, record.id)
  if (!matched.accepted || !matched.hit) {
    const reason = matched.reason || 'REJECTED'
    if (reason === 'INSTANCE_MISMATCH' || reason === 'ROOM_FILTER') {
      const key = `${record.id}:${reason}`
      const now = Date.now()
      const last = chatAddMissLogAt.get(key) || 0
      if (now - last > 30000) {
        chatAddMissLogAt.set(key, now)
        appLog('WARN', `群聊加好友未命中：${reason === 'INSTANCE_MISMATCH' ? '监听微信实例已失效（将尝试自动改绑）' : '消息群不在监听列表'}`, {
          instanceId: record.id,
          module: '群聊加好友',
          operation: '过滤',
          reason,
          ruleInstanceId: rule.instanceId,
          roomCount: Array.isArray(rule.roomIds) ? rule.roomIds.length : 0,
        })
      }
    }
    return { accepted: false, reason }
  }
  const saved = upsertChatAddCandidate({
    ...matched.hit,
    sourceInstancePort: record.apiPort,
    accountWxid: record.accountWxid || '',
  })
  if (saved.accepted) {
    appLog('INFO', '已记录群聊发言加好友候选', {
      instanceId: record.id,
      module: '群聊加好友',
      operation: '发言命中',
      roomId: matched.hit.roomId,
      senderWxid: matched.hit.senderWxid,
      matchedKeyword: matched.hit.matchedKeyword || '(全量)',
    })
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('chat-add:candidate', { instanceId: record.id, candidateId: saved.id, hit: matched.hit })
    }
  }
  return saved
}

/**
 * 绑定监控群到当前微信实例（重启后 instanceId 会变）。
 * @param {{ id: string }} record
 * @param {{ instanceId: string, roomId: string, name: string } | null} room
 * @returns {{ instanceId: string, roomId: string, name: string } | null}
 */
function bindQrMonitorRoom(record, room) {
  if (!room) return null
  if (room.instanceId !== record.id) {
    room.instanceId = record.id
    try { saveSetting('qrMonitor', qrMonitorConfig) } catch { /* 回写失败不阻断采集 */ }
    appLog('INFO', '群消息二维码监控已自动绑定到当前微信实例', {
      instanceId: record.id, module: '二维码监控', roomId: room.roomId, roomName: room.name,
    })
  }
  return room
}

/**
 * 解析监控配置中的目标群：先按常见字段 O(1) 查索引；仅必要时深遍历。
 * @param {{ id: string }} record 当前微信实例
 * @param {unknown} event TCP 回调事件
 * @param {{ allowDeep?: boolean }} [options]
 * @returns {{ instanceId: string, roomId: string, name: string } | null}
 */
function resolveQrMonitorRoom(record, event, options = {}) {
  if (!qrMonitorRoomById.size) return null
  for (const roomId of extractEventRoomIds(event)) {
    const hit = qrMonitorRoomById.get(roomId)
    if (hit) return bindQrMonitorRoom(record, hit)
  }
  if (options.allowDeep === false) return null
  return bindQrMonitorRoom(record, findMonitoredRoomDeep(event))
}

/**
 * 处理监控命中后的下载/识别（由队列调度，勿直接 await 拖死 TCP）。
 * @param {object} record
 * @param {{ instanceId: string, roomId: string, name: string }} room
 * @param {unknown} event
 * @param {number} type
 */
async function processQrMonitorImage(record, room, event, type) {
  let sourcePath = existingImagePath(event)
  let temporaryPath = ''
  if (!sourcePath) {
    const temporaryFolder = path.join(app.getPath('temp'), 'wx-group-qr-monitor')
    mkdirSync(temporaryFolder, { recursive: true })
    temporaryPath = path.join(temporaryFolder, `${randomUUID()}.jpg`)
    const viaCdn = await tryDownloadQrImageViaCdn(record, event, temporaryPath, { timeoutMs: 12000, maxAttempts: 2 })
    if (!viaCdn) {
      const normalRequest = downloadRequest(event, room.roomId, record.accountWxid, temporaryPath)
      if (!normalRequest) {
        deleteTemporaryImage(temporaryPath)
        appLog('WARN', '群图片监控：无法解析下载参数（自己发图需 cdnmidImgUrl+aeskey）', {
          instanceId: record.id, module: '二维码监控', roomName: room.name,
          msgType: type, messageDesc: valueOf(event, ['messageDesc', 'event_desc', 'message_desc']),
        })
        return
      }
      const downloaded = await requestApi(record, '/api/download_img', normalRequest, 20000)
      if (!downloaded.response.ok || !existsSync(temporaryPath)) {
        deleteTemporaryImage(temporaryPath)
        appLog('WARN', '群图片监控：图片下载失败', { instanceId: record.id, module: '二维码监控', roomName: room.name })
        return
      }
    }
    sourcePath = temporaryPath
  }
  // 大批量监控用 fast 解码 + 跳过 a8key，保持吞吐；进群执行前仍可再验
  const result = await saveClassifiedQrImage(record, room, sourcePath, event, {
    ...qrMonitorConfig,
    validateLinks: false,
    decodeMode: 'fast',
    existingHashes: monitorContentHashes(),
  })
  deleteTemporaryImage(temporaryPath)
  if (result.detected) {
    const typeText = Array.isArray(result.types) && result.types.length ? `（${result.types.join('、')}）` : ''
    const monitorMessage = result.saved
      ? `群消息二维码已自动保存${typeText}`
      : result.expired
        ? '群消息二维码已过期，未保存'
        : '群消息二维码已去重'
    appLog('INFO', monitorMessage, {
      instanceId: record.id, module: '二维码监控', operation: '监控群消息图片', roomName: room.name,
      queuePending: qrMonitorQueues.get(record.id)?.pending?.length || 0,
      ...result,
    })
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('qr:monitor-result', { roomName: room.name, ...result })
  }
}

async function handleQrMonitorEvent(record, event) {
  if (!qrMonitorConfig.enabled) return
  // 先用字段 O(1) 匹配；普通文字绝不深遍历，150+ 群时避免拖死主进程
  let room = resolveQrMonitorRoom(record, event, { allowDeep: false })
  const type = Number(valueOf(event, ['type', 'local_type', 'message_type', 'msgType']))
  const maybeImage = looksLikeImageEvent(event)
  if (!room) {
    // watchAll：未在列表中的群有图片时，自动纳入监控再下载
    if (qrMonitorConfig.watchAll && maybeImage) {
      const roomIds = extractEventRoomIds(event)
      const roomId = roomIds.find((id) => String(id).endsWith('@chatroom'))
      if (roomId) {
        addQrMonitorRooms([{ instanceId: record.id, roomId, name: '群聊' }], { reason: '新群图片自动纳入' })
        room = qrMonitorRoomById.get(roomId) || null
      }
    }
    if (!room) {
      if (!maybeImage) return
      room = resolveQrMonitorRoom(record, event, { allowDeep: true })
      if (!room) {
        const toName = fieldString(event, ['toUserName', 'to_user_name'])
        const fromName = fieldString(event, ['fromUserName', 'from_user_name'])
        const roomHint = [toName, fromName].find((item) => String(item || '').endsWith('@chatroom')) || toName || fromName || '未知'
        const throttleKey = `${record.id}:${roomHint}`
        const now = Date.now()
        const last = qrMonitorSkipLogAt.get(throttleKey) || 0
        if (now - last > 60000) {
          qrMonitorSkipLogAt.set(throttleKey, now)
          appLog('INFO', '群图片监控：收到图片，但不在当前监控群列表，已忽略', {
            instanceId: record.id,
            module: '二维码监控',
            roomHint,
            watchedCount: qrMonitorRoomById.size,
            msgType: type,
          })
        }
        return
      }
    }
  }
  if (!maybeImage) return
  const state = qrMonitorQueues.get(record.id)
  const pending = state?.pending?.length || 0
  if (pending >= 80) {
    const throttleKey = `${record.id}:backlog`
    const now = Date.now()
    const last = qrMonitorSkipLogAt.get(throttleKey) || 0
    if (now - last > 10000) {
      qrMonitorSkipLogAt.set(throttleKey, now)
      appLog('WARN', '群图片监控：下载队列过长，暂时丢弃新图片以免拖垮主进程', {
        instanceId: record.id, module: '二维码监控', roomName: room.name, pending,
      })
    }
    return
  }
  const hitLogKey = `${record.id}:hit:${room.roomId}`
  const now = Date.now()
  const lastHitLog = qrMonitorSkipLogAt.get(hitLogKey) || 0
  if (now - lastHitLog > 8000) {
    qrMonitorSkipLogAt.set(hitLogKey, now)
    appLog('INFO', '群图片监控：命中监控群，排队下载识别', {
      instanceId: record.id, module: '二维码监控', roomName: room.name, roomId: room.roomId, msgType: type,
      pending,
    })
  }
  // 入队后立即返回，不阻塞 TCP 回调线程
  void enqueueQrMonitorJob(record.id, () => processQrMonitorImage(record, room, event, type))
    .catch((error) => appLog('ERROR', '群消息二维码自动保存失败', {
      instanceId: record.id, module: '二维码监控', roomName: room.name, error: rawErrorMessage(error),
    }))
}

function loadApiContracts() {
  const candidates = [path.join(__dirname, '..', 'docs', 'generated', 'wechat-api-contracts.json'), path.join(process.resourcesPath || '', 'docs', 'generated', 'wechat-api-contracts.json')]
  const file = candidates.find((candidate) => existsSync(candidate))
  if (!file) throw new Error('缺少微信接口配置文件')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  for (const contract of parsed.contracts ?? []) if (contract.sourceId && typeof contract.path === 'string' && contract.path.startsWith('/')) contractsById.set(Number(contract.sourceId), contract)
}

function validateContract(sourceId, apiPath) {
  const contract = contractsById.get(Number(sourceId))
  if (!contract) return '找不到该功能的微信接口配置'
  if (contract.path !== apiPath) return '微信功能与接口配置不匹配'
  return ''
}

async function copyVerified(source, destination) {
  const sourceHash = await sha256(source)
  if (existsSync(destination) && await sha256(destination) === sourceHash) return destination
  await pipeline(createReadStream(source), createWriteStream(destination))
  if (await sha256(destination) !== sourceHash) throw new Error(`运行文件校验失败：${path.basename(source)}`)
  return destination
}

async function prepareRuntime() {
  const sourceDir = resolveHookSourceDir()
  if (!existsSync(path.join(sourceDir, 'inject.exe')) || !existsSync(path.join(sourceDir, 'libGLESv1.dll'))) {
    throw new Error(`找不到微信注入组件，请确认已安装完整程序包（期望目录：${sourceDir}）`)
  }
  const runtime = path.join(app.getPath('userData'), 'runtime', '4.1.8.27')
  mkdirSync(runtime, { recursive: true })
  const injectExe = await copyVerified(path.join(sourceDir, 'inject.exe'), path.join(runtime, 'inject.exe'))
  const dll = await copyVerified(path.join(sourceDir, 'libGLESv1.dll'), path.join(runtime, 'libGLESv1.dll'))
  let weixinExe = configuredWeixinExe()
  if (!isWeixinExe(weixinExe)) {
    const ensured = ensureWeixinPathConfigured({ force: true })
    weixinExe = ensured.exePath
    if (!isWeixinExe(weixinExe)) {
      throw new Error(ensured.message || '未能自动找到本机微信，请到“日志与设置 - 文件位置”手动选择 Weixin.exe')
    }
  }
  return { injectExe, dll, weixinExe }
}

function startTcpReceiver(record) {
  const server = net.createServer((socket) => {
    const decoder = new LengthPrefixedDecoder(MAX_MESSAGE_BYTES)
    socket.on('data', (chunk) => {
      try {
        for (const payload of decoder.push(chunk)) {
        let event
        try { event = JSON.parse(payload.toString('utf8')) } catch { event = { rawText: payload.toString('utf8') } }
        record.lastCallbackAt = new Date().toISOString()
        record.events.push({ time: record.lastCallbackAt, data: event })
        try {
          const saved = saveEvent(record.id, event)
          if (saved?.joinRecorded) appLog('INFO', '已记录最新入群成员', { instanceId: record.id, module: '群成员', operation: '进群回调' })
        } catch (error) { appLog('ERROR', '回调入库失败', { instanceId: record.id, error: error.message }) }
        if (record.events.length > 1000) record.events.shift()
        const eventPayload = safeCloneForIpc({ instanceId: record.id, event }, { instanceId: record.id, event: { type: 'opaque' } })
        for (const win of BrowserWindow.getAllWindows()) {
          try { win.webContents.send('wechat:event', eventPayload) } catch (error) {
            appLog('ERROR', '推送微信事件失败', { instanceId: record.id, error: rawErrorMessage(error) })
          }
        }
        void handleQrMonitorEvent(record, event)
        try { handleChatAddFriendEvent(record, event) } catch (error) { appLog('ERROR', '群聊发言加好友处理失败', { instanceId: record.id, error: error.message }) }
        }
      } catch (error) {
        appLog('ERROR', 'TCP 回调超过 10 MB，连接已关闭', { instanceId: record.id, error: error.message })
        socket.destroy()
      }
    })
    socket.on('error', (error) => appLog('ERROR', 'TCP 回调连接错误', { instanceId: record.id, error: error.message }))
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(record.tcpPort, '127.0.0.1', () => resolve(server))
  })
}

async function requestApi(record, apiPath, body, timeout = 30000) {
  const previous = record.apiQueue ?? Promise.resolve()
  let release
  const turn = new Promise((resolve) => { release = resolve })
  record.apiQueue = previous.catch(() => {}).then(() => turn)
  await previous.catch(() => {})
  record.apiBusy = true
  try {
    const response = await fetch(`http://127.0.0.1:${record.apiPort}${apiPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeout) })
    const text = await response.text()
    let raw
    try { raw = JSON.parse(text) } catch { raw = text }
    return { response, raw }
  } finally {
    record.apiBusy = false
    release()
  }
}

async function probeInstance(record) {
  if (record.apiBusy) return true
  if (record.status !== 'STARTING' && record.pid) {
    const executable = await getProcessExecutablePath(record.pid)
    if (!sameExecutable(executable, record.weixinExe || configuredWeixinExe())) {
      markInstanceStopped(record, executable ? '原微信进程已被其他程序占用' : '微信已关闭')
      return false
    }
  }
  try {
    const { response, raw } = await requestApi(record, '/api/check_login', {}, 3000)
    if (!response.ok) throw new Error(`微信接口返回 ${response.status}`)
    const payload = raw && typeof raw === 'object' ? raw : null
    const data = payload?.data ?? payload
    const loggedIn = data?.status === true || data?.status === 1
    const wasOnline = record.status === 'ONLINE'
    const expectedAccountWxid = record.accountWxid || ''
    const observedValue = payload?.account_wxid ?? data?.account_wxid ?? data?.wxid ?? ''
    const observedAccountWxid = typeof observedValue === 'string' ? observedValue : typeof observedValue?.String === 'string' ? observedValue.String : ''
    if (loggedIn && expectedAccountWxid && observedAccountWxid && expectedAccountWxid !== observedAccountWxid) {
      markInstanceIdentityMismatch(record)
      return false
    }
    if (loggedIn && (record.requireIdentityVerification || !wasOnline || !record.accountWxid || !record.nickname)) {
      const profile = await requestApi(record, '/api/get_profile_cache', {}, 5000)
      if (!profile.response.ok) throw new Error('无法读取当前登录微信资料')
      const info = profile.raw?.userInfo ?? {}
      const text = (value) => typeof value === 'string' ? value : value?.String
      const profileAccountWxid = text(info.userName) || ''
      if (!profileAccountWxid) throw new Error('无法确认当前登录微信号')
      if (expectedAccountWxid && expectedAccountWxid !== profileAccountWxid) {
        markInstanceIdentityMismatch(record)
        return false
      }
      record.nickname = text(info.nickName) || record.nickname
      record.avatar = profile.raw?.userInfoExt?.bigHeadImgUrl || profile.raw?.userInfoExt?.smallHeadImgUrl || record.avatar
      record.accountWxid = profileAccountWxid
      record.requireIdentityVerification = false
    }
    record.status = response.ok ? (loggedIn ? 'ONLINE' : 'WAITING_LOGIN') : 'ERROR'
    record.probeFailures = 0
    record.error = undefined
    record.lastProbeAt = new Date().toISOString()
    record.accountWxid = observedAccountWxid || record.accountWxid
    if (loggedIn && record.status === 'ONLINE') {
      try { ensureChatAddRuleBound(record) } catch { /* 改绑失败不阻断探测 */ }
    }
    const nextInterval = loggedIn ? 10000 : 2000
    if (record.probeIntervalMs !== nextInterval) startProbeLoop(record, nextInterval)
    upsertInstance({ ...record, pid: record.child?.pid ?? record.pid })
    return true
  } catch (error) {
    record.probeFailures = (record.probeFailures || 0) + 1
    if (record.status !== 'STOPPED' && record.probeFailures >= 3) record.status = 'ERROR'
    record.error = record.probeFailures >= 3 ? toUserErrorMessage(error, '检测微信状态失败') : undefined
    if (record.probeFailures >= 3) appLog('ERROR', '检测微信状态失败', { instanceId: record.id, error: rawErrorMessage(error) })
    upsertInstance({ ...record, pid: record.child?.pid ?? record.pid })
    return false
  }
}

const runningTasks = new Set()
async function waitForTaskTime(taskId, timestamp) {
  while (Date.now() < timestamp) {
    if (!runtimeAllowed) return false
    const task = listTasks().find((item) => item.id === taskId)
    if (!task || ['PAUSED', 'CANCELLED'].includes(task.status)) return false
    await new Promise((resolve) => setTimeout(resolve, Math.min(timestamp - Date.now(), 1000)))
  }
  return true
}
function deliveryContentHash(actionType, request) {
  const hash = createHash('sha256').update(`${actionType}\0`)
  if (actionType === 'SEND_TEXT') hash.update(String(request?.msg || ''))
  else if (actionType === 'SEND_IMAGE') {
    const file = String(request?.filepath || '')
    if (file && existsSync(file)) hash.update(readFileSync(file))
    else hash.update(file)
  }
  return hash.digest('hex')
}
/**
 * 用 Node http(s) 抓取邀请页（必须能带上 Cookie）。
 * Electron/Chromium 的 fetch 会把 Cookie 当成禁止头丢掉，导致邀请页落到“下载微信”跳转页，解析不到群名/人数。
 * @param {string} pageUrl
 * @param {Record<string, string>} headers
 * @param {number} [redirectsLeft]
 * @param {{ method?: 'GET'|'POST' }} [options]
 * @returns {Promise<string>}
 */
function fetchInvitePageBody(pageUrl, headers = {}, redirectsLeft = 5, options = {}) {
  const target = String(pageUrl || '').trim()
  if (!target || !/^https?:\/\//i.test(target)) return Promise.resolve('')
  const method = String(options?.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(typeof value === 'string' ? value : '')
    }
    try {
      const parsed = new URL(target)
      const lib = parsed.protocol === 'https:' ? https : http
      const reqHeaders = { ...(headers && typeof headers === 'object' ? headers : {}) }
      if (!reqHeaders['Accept-Encoding'] && !reqHeaders['accept-encoding']) {
        reqHeaders['Accept-Encoding'] = 'identity'
      }
      if (method === 'POST') {
        if (!reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
          reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded'
        }
        reqHeaders['Content-Length'] = '0'
      }
      const req = lib.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: `${parsed.pathname || '/'}${parsed.search || ''}`,
        method,
        headers: reqHeaders,
        timeout: 10000,
      }, (res) => {
        const status = Number(res.statusCode || 0)
        const location = String(res.headers.location || '').trim()
        const nextHeaders = { ...reqHeaders }
        const setCookie = res.headers['set-cookie']
        if (setCookie) {
          const parts = (Array.isArray(setCookie) ? setCookie : [setCookie])
            .map((item) => String(item).split(';')[0].trim())
            .filter(Boolean)
          if (parts.length) {
            const prev = String(nextHeaders.Cookie || nextHeaders.cookie || '').trim()
            nextHeaders.Cookie = prev ? `${prev}; ${parts.join('; ')}` : parts.join('; ')
            delete nextHeaders.cookie
          }
        }
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          res.resume()
          let nextUrl = location
          try { nextUrl = new URL(location, target).toString() } catch { /* keep location */ }
          fetchInvitePageBody(nextUrl, nextHeaders, redirectsLeft - 1, options).then(finish, () => finish(''))
          return
        }
        const chunks = []
        res.on('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
        res.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
        res.on('error', () => finish(''))
      })
      req.on('timeout', () => { try { req.destroy() } catch { /* ignore */ }; finish('') })
      req.on('error', () => finish(''))
      req.end()
    } catch {
      finish('')
    }
  })
}

/**
 * 通过 get_a8key + 邀请页抓取解析群邀请预览（群名/人数/完整进群链接）。
 * @param {object} record 微信实例
 * @param {string} url 群二维码/短链
 * @returns {Promise<{ roomId: string, roomName: string, memberCount: number, fullUrl: string, expired: boolean, label: string, error?: string }>}
 */
async function fetchInvitePreview(record, url) {
  const sourceUrl = String(url || '').trim()
  if (!sourceUrl) return { roomId: '', roomName: '', memberCount: 0, fullUrl: '', expired: false, label: '空链接', error: '链接为空' }
  try {
    // 短链 / 完整邀请链在不同 urlType、scene 下返回差异大；依次尝试
    const paramSets = [
      { url: sourceUrl, urlType: '0', scene: '0' },
      { url: sourceUrl, urlType: '1', scene: '4' },
      { url: sourceUrl, urlType: '2', scene: '4' },
      { url: sourceUrl, urlType: '0', scene: '4' },
    ]
    let response = null
    let raw = null
    let preview = { roomId: '', roomName: '', memberCount: 0, fullUrl: sourceUrl, expired: false }
    for (const params of paramSets) {
      const startedAt = Date.now()
      const result = await requestApi(record, '/api/get_a8key', params, 12000)
      const currentResponse = result.response
      const currentRaw = result.raw
      saveApiSample({
        instanceId: record.id, sourceId: 438557511, path: '/api/get_a8key',
        request: params, response: currentRaw,
        httpStatus: currentResponse.status, durationMs: Date.now() - startedAt,
      })
      const currentPreview = parseInvitePreview(currentRaw, sourceUrl)
      const currentHeaders = extractA8KeyHttpHeaders(currentRaw)
      // 保留信息更完整的一轮；仅拿到 FullURL 不能提前结束，后续参数可能返回 Cookie/群资料。
      const currentScore = (hasUsableInvitePreview(currentPreview) ? 4 : 0)
        + (currentHeaders.Cookie || currentHeaders.cookie ? 2 : 0)
        + (a8keyResponseUseful(currentRaw) ? 1 : 0)
      const savedHeaders = extractA8KeyHttpHeaders(raw)
      const savedScore = (hasUsableInvitePreview(preview) ? 4 : 0)
        + (savedHeaders.Cookie || savedHeaders.cookie ? 2 : 0)
        + (a8keyResponseUseful(raw) ? 1 : 0)
      if (!raw || currentScore > savedScore) {
        response = currentResponse
        raw = currentRaw
        preview = currentPreview
      }
      if (currentPreview.expired || hasUsableInvitePreview(currentPreview) || currentHeaders.Cookie || currentHeaders.cookie) break
    }

    // get_a8key 多数只返回 FullURL/HttpHeader，需再抓邀请页才能拿到群名/人数
    if (!preview.expired && (!preview.roomName || !preview.memberCount)) {
      const pageReq = buildInvitePageRequest(raw, sourceUrl)
      const urlsToFetch = []
      if (pageReq.url) urlsToFetch.push(pageReq.url)
      if (sourceUrl && sourceUrl !== pageReq.url) urlsToFetch.push(sourceUrl)
      let sawDownloadGate = false
      for (const pageUrl of urlsToFetch) {
        if (preview.roomName && preview.memberCount) break
        let pageBody = await fetchInvitePageBody(pageUrl, pageReq.headers, 5, { method: 'GET' })
        if (pageBody && /weixin_getdownurl|请在微信中打开|下载微信|getdownurl_sms/i.test(pageBody)) {
          sawDownloadGate = true
          pageBody = await fetchInvitePageBody(pageUrl, pageReq.headers, 5, { method: 'POST' })
        }
        if (!pageBody) continue
        if (/weixin_getdownurl|请在微信中打开|下载微信|getdownurl_sms/i.test(pageBody)) {
          sawDownloadGate = true
          continue
        }
        preview = mergeInvitePreview(preview, parseInvitePreview(pageBody, pageUrl))
      }
      if (!hasUsableInvitePreview(preview) && sawDownloadGate && !pageReq.headers.Cookie && !pageReq.headers.cookie) {
        preview = { ...preview, notice: '暂时无法读取群名和人数，执行任务时仍会尝试进群' }
      }
    }

    const label = formatInvitePreviewLine(preview)
    if (preview.expired) return { ...preview, label, error: '邀请已过期或无效' }
    if (response && !response.ok && !hasUsableInvitePreview(preview) && !preview.fullUrl) {
      return { ...preview, label, error: '无法解析群资料，请确认链接有效且微信在线' }
    }
    if (!hasUsableInvitePreview(preview) && preview.fullUrl && !preview.error) {
      return { ...preview, label, notice: preview.notice || '暂时无法读取群名和人数，执行任务时仍会尝试进群' }
    }
    return { ...preview, label }
  } catch (error) {
    return {
      roomId: '', roomName: '', memberCount: 0, fullUrl: sourceUrl, expired: false,
      label: `解析失败：${rawErrorMessage(error)}`, error: rawErrorMessage(error),
    }
  }
}

/**
 * 处理二维码进群：先 a8key 解析完整邀请链，再 enter_room；用业务结果判定是否真进群。
 * @param {object} record 微信实例
 * @param {object} task 任务
 * @param {object} item 任务项
 * @param {string} decodedText 二维码/链接文本
 * @param {string} taskId 任务 ID
 * @returns {Promise<object>} 处理结果
 */
async function readWechatRoomIds(record) {
  try {
    const { response, raw } = await requestApi(record, '/api/get_chatroom_list', {}, 15000)
    if (!response.ok) return new Set()
    return new Set(extractRoomsFromApiRaw(raw).map((room) => room.roomId).filter(Boolean))
  } catch {
    return new Set()
  }
}

async function verifyJoinedRoom(record, beforeRoomIds, expectedRoomId = '') {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 1500))
    const current = await readWechatRoomIds(record)
    if (expectedRoomId && current.has(expectedRoomId)) return expectedRoomId
    for (const roomId of current) if (!beforeRoomIds.has(roomId)) return roomId
  }
  return ''
}

async function applyQrOptions(record, task, item, decodedText, taskId) {
  const text = String(decodedText || '')
  const type = classifyQrText(text)
  if (type === 'PERSONAL_LINK' && task?.config?.skipPersonal) {
    appLog('INFO', '已跳过个人二维码', { instanceId: record.id, taskId })
    return { skippedPersonal: true }
  }
  if (type !== 'GROUP_LINK') return { scannedOnly: true }
  const reservation = reserveQrJoinDailyAttempt(record.accountWxid, item.id, item.target_key, task?.config?.limitPerAccount)
  if (!reservation.accepted) {
    const reason = reservation.reason === 'ACCOUNT_REQUIRED' ? '未读取到登录微信号，已跳过进群申请' : '已达到本微信今日进群上限'
    appLog('INFO', reason, { instanceId: record.id, taskId })
    return { skippedLimit: true, reason }
  }

  const preview = await fetchInvitePreview(record, text)
  appLog('INFO', `进群前群资料：${preview.label}`, {
    instanceId: record.id, taskId, module: '二维码进群',
    roomName: preview.roomName, memberCount: preview.memberCount, roomId: preview.roomId,
  })
  if (preview.expired) {
    return { joinSubmitted: false, joinOk: false, reason: '邀请已过期或无效', preview, joinResponse: null }
  }

  const applyText = String(task?.config?.applyText || '').replaceAll('{昵称}', record.nickname || record.accountWxid || '微信用户')
  // 短链 weixin.qq.com/g/ 直接 enter_room 常返回空成功；优先用 a8key 解析出的完整邀请 URL
  const joinUrl = String(preview.fullUrl || text).trim() || text
  const joinRequest = {
    url: joinUrl,
    link: joinUrl,
    inviteUrl: joinUrl,
    msg: applyText,
    verifyContent: applyText,
    applyText,
  }
  const beforeRoomIds = await readWechatRoomIds(record)
  const startedAt = Date.now()
  let { response, raw } = await requestApi(record, '/api/enter_room', joinRequest)
  saveApiSample({ instanceId: record.id, sourceId: 438557545, path: '/api/enter_room', request: joinRequest, response: raw, httpStatus: response.status, durationMs: Date.now() - startedAt })
  if (hasFrequentEvidence(raw)) {
    appLog('ERROR', '进群检测到明确频繁状态', { instanceId: record.id, taskId, status: response.status })
    return { frequent: true, joinResponse: raw, preview }
  }
  let verdict = evaluateEnterRoomResult(response.ok, raw)
  if (!verdict.ok) {
    let verifiedRoomId = await verifyJoinedRoom(record, beforeRoomIds, preview.roomId)
    if (!verifiedRoomId && response.ok) {
      const retryStartedAt = Date.now()
      const retry = await requestApi(record, '/api/enter_room', { url: joinUrl })
      response = retry.response
      raw = retry.raw
      saveApiSample({ instanceId: record.id, sourceId: 438557545, path: '/api/enter_room', request: { url: joinUrl }, response: raw, httpStatus: response.status, durationMs: Date.now() - retryStartedAt })
      if (hasFrequentEvidence(raw)) {
        appLog('ERROR', '进群重试检测到明确频繁状态', { instanceId: record.id, taskId, status: response.status })
        return { frequent: true, joinResponse: raw, preview }
      }
      verdict = evaluateEnterRoomResult(response.ok, raw)
      if (!verdict.ok) verifiedRoomId = await verifyJoinedRoom(record, beforeRoomIds, preview.roomId)
    }
    if (verifiedRoomId) verdict = { ok: true, reason: '已从群列表确认进群', roomId: verifiedRoomId }
  }
  appLog(verdict.ok ? 'INFO' : 'ERROR', verdict.ok ? `进群成功：${preview.label}` : `进群未确认：${verdict.reason}`, {
    instanceId: record.id, taskId, module: '二维码进群', operation: '提交进群并核验群列表',
    sourceId: 438557545, path: '/api/enter_room', status: response.status, roomId: verdict.roomId, targetKey: item.target_key,
  })
  if (verdict.ok && task?.config?.saveContact) {
    const roomId = verdict.roomId || preview.roomId || findRoomId(raw)
    if (roomId) {
      const saved = await requestApi(record, '/api/save_chatroom_to_contact', { roomId })
      saveApiSample({ instanceId: record.id, sourceId: 438557556, path: '/api/save_chatroom_to_contact', request: { roomId }, response: saved.raw, httpStatus: saved.response.status, durationMs: 0 })
      appLog(saved.response.ok ? 'INFO' : 'ERROR', saved.response.ok ? '群聊已保存到通讯录' : '群聊保存到通讯录失败', { instanceId: record.id, taskId, roomId })
    } else appLog('INFO', '进群结果尚未返回群标识，暂时无法保存到通讯录', { instanceId: record.id, taskId })
  }
  // 监控开启且「全部群含新进群」时：进群成功立刻并入监控列表
  if (verdict.ok && qrMonitorConfig.enabled && qrMonitorConfig.watchAll) {
    const roomId = String(verdict.roomId || preview.roomId || findRoomId(raw) || '').trim()
    if (roomId.endsWith('@chatroom')) {
      addQrMonitorRooms([{
        instanceId: record.id,
        roomId,
        name: preview.roomName || '群聊',
      }], { reason: '二维码进群成功' })
    }
  }
  return {
    joinSubmitted: true,
    joinResponse: raw,
    joinOk: verdict.ok,
    reason: verdict.ok ? `已进群：${preview.label}` : verdict.reason,
    roomId: verdict.roomId,
    preview,
  }
}

async function applyQrOptionsWithConnectionRetry(record, task, item, decodedText, taskId) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await applyQrOptions(record, task, item, decodedText, taskId)
    } catch (error) {
      const message = rawErrorMessage(error)
      const transient = /fetch failed|econnrefused|connect.*refused|socket hang up|econnreset/i.test(message)
      if (!transient || attempt === 3) throw error
      appLog('WARN', '微信控制接口暂时不可用，等待恢复后重试二维码任务', {
        instanceId: record.id, taskId, module: '二维码进群', attempt, waitMs: 2500,
      })
      await new Promise((resolve) => setTimeout(resolve, 2500))
    }
  }
  throw new Error('微信控制接口重试失败')
}

async function resolvePendingFriendProfile(record, request, taskId) {
  const targetWxid = String(request.targetWxid || '')
  const sourceRoomId = String(request.sourceRoomId || '')
  const sourceRoomName = String(request.sourceRoomName || '')
  const sourceInstanceId = String(request.sourceInstanceId || record.id)
  const sourceInstancePort = Number(request.sourceInstancePort)
  const profilePort = sourceInstancePort > 0 ? sourceInstancePort : record.apiPort
  const requestUrl = `http://127.0.0.1:${profilePort}/api/get_group_member_contact`
  appLog('INFO', 'MESSAGE_CANDIDATE -> PROFILE_RESOLUTION', {
    module: '群聊加好友', operation: 'PROFILE_RESOLUTION', taskId,
    accountWxid: String(request.accountWxid || record.accountWxid || ''), targetWxid,
    sourceRoomId, sourceRoomName, sourceInstanceId, sourceInstancePort: profilePort,
    instanceId: record.id, instancePort: profilePort, requestUrl,
  })
  if (!targetWxid || !sourceRoomId || sourceInstanceId !== record.id) {
    return { ok: false, missing: ['source'], diagnostics: [], reason: '候选来源实例或群标识无效' }
  }
  const profileRecord = profilePort === record.apiPort ? record : { ...record, apiPort: profilePort, apiQueue: Promise.resolve(), apiBusy: false }
  const diagnostics = []
  const fetchProfile = async (endpoint, body, sourceId, attempt) => {
    const startedAt = Date.now()
    const url = `http://127.0.0.1:${profilePort}${endpoint}`
    const { response, raw } = await requestApi(profileRecord, endpoint, body)
    const parsed = parseProfileCredentials(raw, targetWxid, sourceRoomId)
    const diagnostic = {
      endpoint, requestUrl: url, requestBodyWxid: String(body.wxid || ''), requestBodyRoomId: String(body.roomId || ''),
      httpStatus: response.status, ...rawStructure(raw), parserVersion: 'profile-resolution-v2',
      baseRet: parsed.baseRet, contactCount: parsed.contactCount, contactListLength: parsed.contactListLength,
      matchedContact: parsed.matchedContact, matchedTicket: parsed.matchedTicket,
      hasV3: Boolean(parsed.v3), hasV4: Boolean(parsed.v4), missing: parsed.missing.join(','),
      attempt, elapsedMs: Date.now() - startedAt,
    }
    diagnostics.push(diagnostic)
    appLog('INFO', '群成员资料原始响应结构（凭证已脱敏）', {
      module: '群聊加好友', operation: 'PROFILE_RESOLUTION_RAW', taskId, instanceId: record.id,
      accountWxid: String(request.accountWxid || record.accountWxid || ''), targetWxid, sourceRoomId, sourceRoomName,
      ...diagnostic,
    })
    return { response, parsed }
  }
  const group = await fetchProfile('/api/get_group_member_contact', { wxid: targetWxid, roomId: sourceRoomId }, 438557510, 1)
  let v3 = /^v3_/i.test(String(request.senderV3 || '')) ? String(request.senderV3) : group.parsed.v3
  let v4 = group.parsed.v4
  if (!v3 || !v4) {
    const contact = await fetchProfile('/api/get_contact', { wxid: targetWxid }, 438557509, 2)
    v3 ||= contact.parsed.v3
    v4 ||= contact.parsed.v4
  }
  const missing = [v3 ? '' : 'v3', v4 ? '' : 'v4'].filter(Boolean)
  return { ok: !missing.length, v3, v4, missing, diagnostics, reason: missing.length ? `凭证解析失败：缺少 ${missing.join('、')}` : '' }
}
async function runTask(taskId) {
  if (runningTasks.has(taskId)) return
  runningTasks.add(taskId)
  const task = listTasks().find((item) => item.id === taskId)
  try {
    if (!runtimeAllowed) {
      setTaskStatus(taskId, 'PAUSED')
      return
    }
    const scheduledAt = Date.parse(String(task?.config?.scheduledAt || ''))
    if (Number.isFinite(scheduledAt) && scheduledAt > Date.now() && !await waitForTaskTime(taskId, scheduledAt)) return
    setTaskStatus(taskId, 'RUNNING')
    const taskItems = getTaskItems(taskId)
    for (const [itemIndex, item] of taskItems.entries()) {
      if (!runtimeAllowed) {
        setTaskStatus(taskId, 'PAUSED')
        break
      }
      const latest = listTasks().find((candidate) => candidate.id === taskId)
      if (!latest || ['PAUSED', 'CANCELLED'].includes(latest.status)) break
      const record = instances.get(item.instance_id)
      if (!record) { setTaskItemResult(item.id, 'FAILED', null, '实例不在线'); continue }
      if (record.status !== 'ONLINE' && item.action_type !== 'QR_SCAN') { setTaskItemResult(item.id, 'FAILED', null, '微信尚未登录'); continue }
      let request
      try { request = JSON.parse(item.request_json || '{}') } catch { request = {} }
      let apiPath = ''
      let sourceId
      if (item.action_type === 'SEND_TEXT') { apiPath = '/api/send_text_msg'; sourceId = 438557482 }
      else if (item.action_type === 'SEND_IMAGE') { apiPath = '/api/send_image_msg'; sourceId = 438557485 }
      else if (item.action_type === 'QR_SCAN') { apiPath = '/api/qrscan'; sourceId = 438557574 }
      else if (item.action_type === 'ADD_FRIEND') { apiPath = '/api/add_friend'; sourceId = 438557515 }
      else { setTaskItemResult(item.id, 'SKIPPED', null, '接口未验证'); continue }
      if (item.action_type === 'ADD_FRIEND') {
        if (!request.v3 || !request.v4) {
          const resolution = await resolvePendingFriendProfile(record, request, taskId)
          if (!resolution.ok) {
            setTaskItemResult(item.id, 'RESOLUTION_FAILED', { diagnostics: resolution.diagnostics, missing: resolution.missing }, resolution.reason)
            appLog('ERROR', '群成员资料解析最终失败', {
              module: '群聊加好友', operation: 'PROFILE_RESOLUTION', taskId, instanceId: record.id,
              accountWxid: String(request.accountWxid || record.accountWxid || ''), targetWxid: String(request.targetWxid || item.target_key),
              sourceRoomId: String(request.sourceRoomId || ''), sourceRoomName: String(request.sourceRoomName || ''),
              missing: resolution.missing.join(','), parserVersion: 'profile-resolution-v2',
            })
            continue
          }
          request.v3 = resolution.v3
          request.v4 = resolution.v4
          setTaskItemStatus(item.id, 'CREDENTIALS_READY')
        }
        const scene = String(request.scence ?? request.scene ?? '3')
        const verifyContent = String(request.verifyContent ?? request.msg ?? '').trim() || DEFAULT_FRIEND_VERIFY_CONTENT
        request = {
          v3: String(request.v3 ?? ''),
          v4: String(request.v4 ?? ''),
          scence: scene,
          friendFlg: String(request.friendFlg ?? '0'),
          verifyContent,
        }
      }
      let contentHash = ''
      try {
        const settings = generalSettings()
        if (item.action_type === 'SEND_TEXT' || item.action_type === 'SEND_IMAGE') {
          const isGroup = String(task?.type || '').endsWith('_TO_GROUP')
          if (!hasDirectoryOwnership(item.instance_id, item.target_key, isGroup)) {
            setTaskItemResult(item.id, 'SKIPPED', null, '该微信当前已不包含这个接收对象，任务已停止')
            continue
          }
        }
        if (item.action_type === 'ADD_FRIEND') {
          const reservation = reserveFriendDailyAttempt(record.accountWxid, item.id, item.target_key, settings.friendDailyLimit)
          if (!reservation.accepted) {
            const message = reservation.reason === 'ACCOUNT_REQUIRED' ? '未读取到登录微信号，为避免绕过上限已跳过' : '已达到本微信今日添加好友上限'
            setTaskItemResult(item.id, 'SKIPPED', null, message)
            continue
          }
        }
        contentHash = item.action_type === 'SEND_TEXT' || item.action_type === 'SEND_IMAGE' ? deliveryContentHash(item.action_type, request) : ''
        if (contentHash && task?.config?.skipSame && record.accountWxid && hasDeliveredContent(record.accountWxid, item.target_key, contentHash)) {
          setTaskItemResult(item.id, 'SKIPPED', null, '该微信已向此对象发送过相同内容')
          continue
        }
        setTaskItemStarted(item.id)
        const isSend = item.action_type === 'SEND_TEXT' || item.action_type === 'SEND_IMAGE'
        const retryCount = isSend && task?.config?.autoRetry ? Math.max(Number(task.config.retryTimes) || 0, 0) : 0
        const retryWaitMs = Math.max(Number(task?.config?.retryMinutes) || 1, 1) * 60000
        // 链接进群：无需本地图片扫码，直接走 enter_room
        if (item.action_type === 'QR_SCAN' && (request.url || request.link || request.decodedText)) {
          const linkText = String(request.url || request.link || request.decodedText || '')
          const joinResult = await applyQrOptionsWithConnectionRetry(record, task, item, linkText, taskId)
          if (joinResult.frequent) {
            setTaskItemResult(item.id, 'FREQUENT', joinResult.joinResponse, '已经频繁')
            setTaskStatus(taskId, 'COOLING_DOWN')
            const coolUntil = Date.now() + Math.max(Number(task?.config?.coolMinutes) || 30, 1) * 60000
            if (!await waitForTaskTime(taskId, coolUntil)) {
              if (!runtimeAllowed) setTaskStatus(taskId, 'PAUSED')
              return
            }
            const cooled = listTasks().find((candidate) => candidate.id === taskId)
            if (!cooled || ['PAUSED', 'CANCELLED'].includes(cooled.status)) return
            if (cooled.status === 'COOLING_DOWN') setTaskStatus(taskId, 'RUNNING')
          } else if (joinResult.skippedPersonal) {
            setTaskItemResult(item.id, 'SKIPPED', joinResult, '已跳过个人二维码')
          } else if (joinResult.skippedLimit) {
            setTaskItemResult(item.id, 'SKIPPED', joinResult, joinResult.reason || '已达到今日进群上限')
          } else if (joinResult.scannedOnly || !joinResult.joinSubmitted) {
            // 非微信群链接（个人码未跳过配置、QQ 群等）不得记为进群成功
            const linkType = classifyQrText(linkText)
            const reason = joinResult.reason || (linkType === 'QQ_GROUP_LINK'
              ? 'QQ群链接不支持微信进群，已跳过'
              : linkType === 'PERSONAL_LINK'
                ? '个人二维码不支持进群，已跳过'
                : '非微信群二维码，已跳过')
            setTaskItemResult(item.id, joinResult.joinOk === false ? 'FAILED' : 'SKIPPED', joinResult, reason)
          } else {
            const ok = joinResult.joinOk === true
            const detail = ok
              ? (joinResult.reason || '进群成功')
              : (joinResult.reason || '进群未确认成功（接口空结果不能算完成）')
            setTaskItemResult(item.id, ok ? 'COMPLETED' : 'FAILED', joinResult.joinResponse ?? joinResult, ok ? detail : detail)
          }
          if (itemIndex < taskItems.length - 1) {
            const settings = generalSettings()
            const min = Math.max(Number(settings.intervalMin) || 1, 1)
            const max = Math.max(Number(settings.intervalMax) || min, min)
            const waitMs = (min + Math.random() * (max - min)) * 1000
            await new Promise((resolve) => setTimeout(resolve, waitMs))
          }
          continue
        }
        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
          const startedAt = Date.now()
          const { response, raw } = await requestApi(record, apiPath, request)
          const durationMs = Date.now() - startedAt
          saveApiSample({ instanceId: record.id, sourceId, path: apiPath, request, response: raw, httpStatus: response.status, durationMs })
          const operation = apiOperationLabel(apiPath)
          appLog(response.ok ? 'INFO' : 'ERROR', response.ok ? `${operation}完成` : `${operation}失败`, { instanceId: record.id, module: operation, operation, taskId, sourceId, path: apiPath, status: response.status, durationMs, attempt: attempt + 1 })
          if (hasFrequentEvidence(raw)) {
            setTaskItemResult(item.id, 'FREQUENT', raw, '已经频繁')
            setTaskStatus(taskId, 'COOLING_DOWN')
            appLog('ERROR', '任务因频繁状态冷却中', { instanceId: record.id, taskId, sourceId, evidence: raw })
            const coolUntil = Date.now() + Math.max(Number(task?.config?.coolMinutes) || 30, 1) * 60000
            if (!await waitForTaskTime(taskId, coolUntil)) {
              if (!runtimeAllowed) setTaskStatus(taskId, 'PAUSED')
              return
            }
            const cooled = listTasks().find((candidate) => candidate.id === taskId)
            if (!cooled || ['PAUSED', 'CANCELLED'].includes(cooled.status)) return
            if (cooled.status === 'COOLING_DOWN') setTaskStatus(taskId, 'RUNNING')
            break
          }
          if (item.action_type === 'ADD_FRIEND') {
            const verdict = evaluateFriendAddResult(response.ok, raw)
            if (!verdict.accepted) {
              appLog('ERROR', '添加好友业务请求被拒绝', {
                instanceId: record.id,
                taskId,
                sourceId,
                status: response.status,
                businessCode: raw?.code ?? raw?.errCode ?? raw?.data?.code ?? null,
                reason: verdict.reason,
              })
            }
            setTaskItemResult(item.id, verdict.accepted ? 'REQUEST_SENT' : 'FAILED', raw, verdict.reason)
            break
          }
          const success = isVerifiedSuccess(sourceId, response.ok, raw)
          if (success === null) {
            setTaskItemResult(item.id, 'UNSAFE_RESUME', raw, '该接口没有已验证的成功解析器')
            setTaskStatus(taskId, 'UNSAFE_RESUME')
            return
          }
          if (!success && attempt < retryCount) {
            appLog('INFO', `${operation}将自动重试`, { instanceId: record.id, taskId, attempt: attempt + 2, waitMinutes: retryWaitMs / 60000 })
            if (!await waitForTaskTime(taskId, Date.now() + retryWaitMs)) return
            continue
          }
          if (item.action_type === 'QR_SCAN') {
            updateQrScanResult(item.target_key, raw, success)
            if (success) {
              const decodedText = raw?.data?.scan_res ?? raw?.scan_res ?? ''
              const storedQr = listQrItems().find((candidate) => candidate.sha256 === item.target_key || candidate.id === item.target_key)
              const storedGroupText = storedQr?.qrType === 'GROUP_LINK' ? String(storedQr.decodedText || '') : ''
              const effectiveDecodedText = storedGroupText || decodedText
              const joinResult = await applyQrOptionsWithConnectionRetry(record, task, item, effectiveDecodedText, taskId)
              if (joinResult.frequent) {
                setTaskItemResult(item.id, 'FREQUENT', joinResult.joinResponse, '已经频繁')
                setTaskStatus(taskId, 'COOLING_DOWN')
                const coolUntil = Date.now() + Math.max(Number(task?.config?.coolMinutes) || 30, 1) * 60000
                if (!await waitForTaskTime(taskId, coolUntil)) {
                  if (!runtimeAllowed) setTaskStatus(taskId, 'PAUSED')
                  return
                }
                const cooled = listTasks().find((candidate) => candidate.id === taskId)
                if (!cooled || ['PAUSED', 'CANCELLED'].includes(cooled.status)) return
                if (cooled.status === 'COOLING_DOWN') setTaskStatus(taskId, 'RUNNING')
                break
              }
              if (joinResult.skippedPersonal) {
                setTaskItemResult(item.id, 'SKIPPED', joinResult, '已跳过个人二维码')
                break
              }
              if (joinResult.skippedLimit) {
                setTaskItemResult(item.id, 'SKIPPED', joinResult, joinResult.reason || '已达到今日进群上限')
                break
              }
              if (joinResult.scannedOnly || !joinResult.joinSubmitted) {
                const linkType = classifyQrText(effectiveDecodedText)
                const reason = joinResult.reason || (linkType === 'QQ_GROUP_LINK'
                  ? 'QQ群链接不支持微信进群，已跳过'
                  : linkType === 'PERSONAL_LINK'
                    ? '个人二维码不支持进群，已跳过'
                    : '非微信群二维码，已跳过')
                setTaskItemResult(item.id, joinResult.joinOk === false ? 'FAILED' : 'SKIPPED', joinResult, reason)
                break
              }
              {
                const ok = joinResult.joinOk === true
                const detail = ok
                  ? (joinResult.reason || '进群成功')
                  : (joinResult.reason || '进群未确认成功（接口空结果不能算完成）')
                setTaskItemResult(item.id, ok ? 'COMPLETED' : 'FAILED', joinResult.joinResponse ?? joinResult, detail)
              }
              break
            }
          }
          if (success && contentHash && record.accountWxid) recordDeliveredContent(record.accountWxid, item.target_key, contentHash, item.id)
          setTaskItemResult(item.id, success ? 'COMPLETED' : 'FAILED', raw, success ? null : '接口返回未达到成功条件')
          break
        }
      } catch (error) {
        const operation = apiOperationLabel(apiPath)
        appLog('ERROR', `${operation}失败`, { instanceId: record.id, module: operation, operation, taskId, path: apiPath, error: rawErrorMessage(error) })
        if (item.action_type === 'ADD_FRIEND') {
          setTaskItemResult(item.id, 'FAILED', null, toUserErrorMessage(error, '添加好友请求失败'))
        } else if (item.action_type === 'SEND_TEXT' || item.action_type === 'SEND_IMAGE') {
          if (contentHash && record.accountWxid) recordDeliveredContent(record.accountWxid, item.target_key, contentHash, item.id)
          setTaskItemResult(item.id, 'UNSAFE_RESUME', null, '请求结果不确定，为避免重复发送已停止任务')
          setTaskStatus(taskId, 'UNSAFE_RESUME')
          break
        } else setTaskItemResult(item.id, 'FAILED', null, toUserErrorMessage(error, '任务执行失败'))
      }
      if (itemIndex < taskItems.length - 1) {
        const settings = generalSettings()
        const min = Math.max(Number(settings.intervalMin) || 1, 1)
        const max = Math.max(Number(settings.intervalMax) || min, min)
        const waitMs = (min + Math.random() * (max - min)) * 1000
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }
    const finalTask = listTasks().find((item) => item.id === taskId)
    if (finalTask?.status === 'RUNNING') setTaskStatus(taskId, finalTask.failed > 0 ? 'PARTIAL_FAILED' : 'COMPLETED')
  } finally { runningTasks.delete(taskId) }
}

function createLocalTask(payload) {
  const allowed = new Set(['SEND_TEXT_TO_FRIEND', 'SEND_TEXT_TO_GROUP', 'SEND_IMAGE_TO_FRIEND', 'SEND_IMAGE_TO_GROUP', 'SEND_MIXED_TO_FRIEND', 'SEND_MIXED_TO_GROUP', 'QR_SCAN', 'ADD_FRIEND'])
  if (!payload || !allowed.has(payload.type)) throw new Error('不支持的任务类型')
  if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('任务没有目标')
  const task = { id: randomUUID(), name: String(payload.name || payload.type), type: payload.type, status: 'WAITING_CONFIRMATION', config: payload.config ?? {} }
  const items = payload.items.map((item) => {
    const defaultAction = payload.type === 'QR_SCAN' ? 'QR_SCAN' : payload.type === 'ADD_FRIEND' ? 'ADD_FRIEND' : payload.type.startsWith('SEND_IMAGE') ? 'SEND_IMAGE' : 'SEND_TEXT'
    const actionType = String(item.actionType || defaultAction)
    if (!['SEND_TEXT', 'SEND_IMAGE', 'QR_SCAN', 'ADD_FRIEND'].includes(actionType)) throw new Error('任务包含不支持的发送内容')
    const instanceId = String(item.instanceId)
    const targetKey = String(item.targetKey)
    if (actionType === 'SEND_TEXT' || actionType === 'SEND_IMAGE') {
      const isGroup = payload.type.endsWith('_TO_GROUP')
      if (!hasDirectoryOwnership(instanceId, targetKey, isGroup)) throw new Error('所选微信不包含这个接收对象，请刷新通讯录后重试')
    }
    const itemStatus = actionType === 'ADD_FRIEND' && item.status === 'PROFILE_PENDING' ? 'PROFILE_PENDING' : 'QUEUED'
    return { id: randomUUID(), instanceId, targetKey, actionType, status: itemStatus, request: item.request }
  })
  const created = createTask(task, items)
  if (!created.inserted) throw new Error('这些成员已经创建过加好友任务，本次没有重复添加')
  return { ...listTasks().find((item) => item.id === task.id), deduplicated: created.duplicates }
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
  for (let port = start; port < 65535; port += 2) if (!skip.has(port) && await portAvailable(port)) return port
  throw new Error('没有可用的本机端口')
}

async function getProcessExecutablePath(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return ''
  const command = `(Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" -ErrorAction SilentlyContinue).ExecutablePath`
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 5000 })
    return stdout.trim()
  } catch { return '' }
}

function sameExecutable(left, right) {
  return Boolean(left && right && path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase())
}

async function killVerifiedProcessTree(pid, expectedExecutables) {
  const executable = await getProcessExecutablePath(pid)
  if (!executable) return true
  if (!expectedExecutables.some((expected) => sameExecutable(executable, expected))) {
    appLog('ERROR', '拒绝结束 PID：可执行文件不匹配', { pid, executable, expectedExecutables })
    return false
  }
  return new Promise((resolve) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => resolve(false))
    killer.once('exit', (code) => resolve(code === 0))
  })
}

function publicInstance(value) {
  return { id: value.id, apiPort: value.apiPort, tcpPort: value.tcpPort, pid: value.child?.pid ?? value.pid ?? null, accountWxid: value.accountWxid, nickname: value.nickname, avatar: value.avatar, status: value.status, managed: Boolean(value.managed), error: value.error, lastCallbackAt: value.lastCallbackAt, lastProbeAt: value.lastProbeAt }
}

function markInstanceStopped(record, reason = '微信已关闭') {
  if (record.status === 'STOPPED') return
  clearInterval(record.probe)
  record.probe = null
  record.tcpServer?.close()
  record.tcpServer = null
  record.status = 'STOPPED'
  record.error = undefined
  record.pid = null
  record.wechatPid = null
  upsertInstance(record)
  appLog('INFO', reason, { instanceId: record.id, module: '微信状态' })
}

function markInstanceIdentityMismatch(record) {
  clearInterval(record.probe)
  record.probe = null
  record.tcpServer?.close()
  record.tcpServer = null
  record.status = 'ERROR'
  record.error = '当前登录微信与原记录不一致，已停止复用以防账号串用'
  record.identityMismatch = true
  record.managed = false
  record.pid = null
  record.wechatPid = null
  upsertInstance(record)
  appLog('ERROR', '检测到登录微信与原记录不一致，已停止复用', { instanceId: record.id, module: '微信状态' })
}

async function synchronizeInstanceProcesses() {
  await Promise.all([...instances.values()].map(async (record) => {
    if (record.status === 'STOPPED' || record.status === 'STARTING' || record.status === 'RESTORING' || !record.pid) return
    const executable = await getProcessExecutablePath(record.pid)
    if (!sameExecutable(executable, record.weixinExe || configuredWeixinExe())) markInstanceStopped(record, executable ? '原微信进程已被其他程序占用' : '微信已关闭')
  }))
}

function startProbeLoop(record, intervalMs = 15000) {
  if (record.probe) clearInterval(record.probe)
  record.probeIntervalMs = intervalMs
  const probe = setInterval(() => probeInstance(record), intervalMs)
  probe.unref()
  record.probe = probe
}

async function restoreInstances() {
  for (const stored of listStoredInstances()) {
    const record = { ...stored, child: null, managed: Boolean(stored.managed), status: 'RESTORING', events: [], probeFailures: 0, weixinExe: configuredWeixinExe(), requireIdentityVerification: true }
    instances.set(record.id, record)
    try {
      const executable = await getProcessExecutablePath(record.pid)
      if (!executable) { markInstanceStopped(record); continue }
      if (!sameExecutable(executable, record.weixinExe)) { markInstanceStopped(record, '原微信进程已被其他程序占用'); continue }
      record.tcpServer = await startTcpReceiver(record)
      const apiAvailable = await probeInstance(record)
      if (record.identityMismatch) continue
      if (!apiAvailable) {
        record.status = 'ERROR'
        record.error = '微信进程存在，但 API 通道暂不可用'
        upsertInstance(record)
      }
      startProbeLoop(record, record.status === 'ONLINE' ? 10000 : 2000)
      appLog(apiAvailable ? 'INFO' : 'ERROR', apiAvailable ? '已恢复微信实例控制' : '微信实例已保留，API 通道待恢复', { instanceId: record.id, apiPort: record.apiPort, tcpPort: record.tcpPort })
    } catch (error) {
      record.tcpServer?.close()
      record.status = 'ERROR'
      record.error = toUserErrorMessage(error, '恢复微信实例失败')
      upsertInstance(record)
      appLog('ERROR', '恢复微信实例失败，记录已保留', { instanceId: record.id, error: rawErrorMessage(error), userMessage: record.error })
    }
  }
}

async function startWechatInstance() {
  let record
  try {
    const files = await prepareRuntime()
    const settings = generalSettings()
    const used = new Set([...instances.values()].flatMap((item) => [item.apiPort, item.tcpPort]))
    const apiPort = await allocatePort(validPort(settings.httpPort, 19088), used)
    used.add(apiPort)
    const tcpPort = await allocatePort(validPort(settings.tcpPort, 61108), used)
    removeInactiveInstancesByPorts(apiPort, tcpPort)
    const id = randomUUID()
    const config = { recivemode: 'tcp', tcp_ip: '127.0.0.1', tcp_port: tcpPort, http_server_port: apiPort, http_callback_url: 'http://127.0.0.1:5000/api/recvMsg', usedefault: false, start_server_while_login: true }
    record = { id, apiPort, tcpPort, child: null, managed: true, status: 'STARTING', events: [], probeFailures: 0, injectorExe: files.injectExe, weixinExe: files.weixinExe }
    instances.set(id, record)
    const child = spawn(files.injectExe, [files.weixinExe, files.dll, JSON.stringify(config)], { cwd: path.dirname(files.weixinExe), shell: false, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
    const outputChunks = []
    const errorChunks = []
    record.child = child
    record.pid = child.pid
    // 必须在 startTcpReceiver 之前挂上 stdout 累积，否则会漏掉早期输出导致误判失败
    child.stdout?.on('data', (chunk) => {
      outputChunks.push(Buffer.from(chunk))
      const output = decodeInjectorChunks([chunk]).trim().slice(0, 2000)
      const pidMatch = output.match(/PID:\s*(\d+)/i)
      if (pidMatch) { record.wechatPid = Number(pidMatch[1]); record.pid = record.wechatPid; upsertInstance({ ...record, pid: record.wechatPid }) }
      appLog('INFO', 'inject.exe 输出', { instanceId: id, output })
    })
    child.stderr?.on('data', (chunk) => {
      errorChunks.push(Buffer.from(chunk))
      appLog('ERROR', 'inject.exe 错误输出', { instanceId: id, output: decodeInjectorChunks([chunk]).trim().slice(0, 2000) })
    })
    const injectionClosed = waitForInjectorClose(child)
    record.tcpServer = await startTcpReceiver(record)
    upsertInstance({ ...record, pid: child.pid })
    appLog('INFO', '微信实例启动命令已提交', { instanceId: id, apiPort, tcpPort, pid: child.pid })
    let closeResult = { code: null, signal: null }
    try {
      closeResult = await injectionClosed
    } catch (error) {
      record.status = 'ERROR'
      record.error = toUserErrorMessage(error, '无法启动微信注入器')
      appLog('ERROR', '无法启动微信注入器', { instanceId: id, error: rawErrorMessage(error) })
      upsertInstance({ ...record, pid: child.pid })
    }
    const code = closeResult.code
    const parsedOutput = parseInjectorOutput(outputChunks.concat(errorChunks), { exitCode: code })
    if (parsedOutput.pid) { record.wechatPid = parsedOutput.pid; record.pid = parsedOutput.pid }
    record.child = null
    record.pid = record.wechatPid ?? null
    if (!record.stopping) {
      const injectionFailed = parsedOutput.failed || !parsedOutput.succeeded
      const detail = parsedOutput.output.trim().slice(-300).replace(/\s+/g, ' ')
      record.error = injectionFailed
        ? (detail ? `DLL 注入失败：${detail}` : 'DLL 注入失败')
        : code ? `inject.exe 退出码 ${code}` : undefined
      appLog(code || injectionFailed ? 'ERROR' : 'INFO', 'inject.exe 已退出', {
        instanceId: id, code, injectionFailed, succeeded: parsedOutput.succeeded, failed: parsedOutput.failed,
        output: parsedOutput.output.trim().slice(-2000),
      })
      record.status = code === 0 && !injectionFailed ? 'WAITING_LOGIN' : 'ERROR'
      if (record.status === 'WAITING_LOGIN') record.apiReadyAt = Date.now() + 750
      upsertInstance({ ...record, pid: record.wechatPid ?? null })
    }
    if (record.status === 'ERROR') {
      if (record.wechatPid) await killVerifiedProcessTree(record.wechatPid, [files.weixinExe])
      record.tcpServer?.close()
      instances.delete(id)
      removeInstance(id)
      return { ok: false, error: record.error || '微信 DLL 注入失败' }
    }
    startProbeLoop(record, 2000)
    const firstProbe = setTimeout(() => probeInstance(record), 1000)
    firstProbe.unref()
    return { ok: true, data: publicInstance(record) }
  } catch (error) {
    clearInterval(record?.probe)
    record?.tcpServer?.close()
    if (record?.child?.pid) await killVerifiedProcessTree(record.child.pid, [record.injectorExe])
    if (record) { instances.delete(record.id); removeInstance(record.id) }
    appLog('ERROR', '启动微信实例失败', { instanceId: record?.id, error: rawErrorMessage(error) })
    return { ok: false, error: toUserErrorMessage(error, '启动微信实例失败') }
  }
}

function enqueueWechatInstanceStart() {
  return enqueueStart(() => startWechatInstance())
}

function registerIpc() {
  ipcMain.handle('auth:session', () => softwareAuth.session())
  ipcMain.handle('auth:login', async (_event, username, password) => {
    try {
      const account = await softwareAuth.login(username, password)
      if (instances.size === 0) await restoreInstances()
      startRemoteAgent(remoteAgentOptions(account.username)).catch(() => {})
      return { ok: true, account }
    } catch (error) { return { ok: false, error: toUserErrorMessage(error, '登录失败，请稍后重试') } }
  })
  ipcMain.handle('auth:register', async (_event, username, password) => {
    try {
      const account = await softwareAuth.register(username, password)
      if (instances.size === 0) await restoreInstances()
      startRemoteAgent(remoteAgentOptions(account.username)).catch(() => {})
      return { ok: true, account }
    } catch (error) { return { ok: false, error: toUserErrorMessage(error, '注册失败，请稍后重试') } }
  })
  ipcMain.handle('auth:logout', async () => { await softwareAuth.logout(); stopRemoteAgent(); return true })
  ipcMain.handle('system:metrics', () => softwareMetrics())
  ipcMain.handle('wechat:list-instances', async () => { await synchronizeInstanceProcesses(); return [...instances.values()].map(publicInstance) })
  ipcMain.handle('wechat:start-instance', () => { requireRuntime(); return enqueueWechatInstanceStart() })
  ipcMain.handle('wechat:stop-instance', async (_event, id, closeWechat = true) => {
    const record = instances.get(id)
    if (!record) return { ok: false, error: '实例不存在' }
    record.stopping = true
    const targetPid = record.wechatPid ?? record.pid ?? record.child?.pid
    const canCloseWechat = Boolean(closeWechat && record.managed && targetPid)
    if (canCloseWechat && !await killVerifiedProcessTree(targetPid, [record.weixinExe || configuredWeixinExe()])) {
      record.stopping = false
      return { ok: false, error: '关闭微信进程失败，请重试' }
    }
    clearInterval(record.probe)
    record.tcpServer?.close()
    instances.delete(id)
    removeInstance(id)
    return { ok: true, data: { closedWechat: canCloseWechat } }
  })
  ipcMain.handle('wechat:call-api', async (_event, id, apiPath, body, sourceId, timeoutMs) => {
    requireRuntime()
    const record = instances.get(id)
    if (!record) return { ok: false, error: '实例不存在', sourceId, contractStatus: 'RESPONSE_VERIFY' }
    if (typeof apiPath !== 'string' || !apiPath.startsWith('/')) return { ok: false, error: '非法接口路径', sourceId }
    const contractError = validateContract(sourceId, apiPath)
    if (contractError) return { ok: false, error: contractError, sourceId }
    try {
      if (sourceId === 438557508 && record.apiReadyAt > Date.now()) {
        await new Promise((resolve) => setTimeout(resolve, record.apiReadyAt - Date.now()))
      }
      const startedAt = Date.now()
      const timeout = Math.min(Math.max(Number(timeoutMs) || 30000, 500), 30000)
      const { response, raw } = await requestApi(record, apiPath, body, timeout)
      saveApiSample({ instanceId: id, sourceId, path: apiPath, request: body, response: raw, httpStatus: response.status, durationMs: Date.now() - startedAt })
      const operation = apiOperationLabel(apiPath)
      appLog(response.ok ? 'INFO' : 'ERROR', response.ok ? `${operation}完成` : `${operation}失败`, { instanceId: id, module: operation, operation, sourceId, path: apiPath, status: response.status, durationMs: Date.now() - startedAt })
      if (sourceId === 438557508 && response.ok && raw?.baseResponse?.ret === 0) startProbeLoop(record, 2000)
      if (sourceId === 438557573 && response.ok) {
        const loginData = raw?.data ?? raw
        record.status = loginData?.status === true || loginData?.status === 1 ? 'ONLINE' : 'WAITING_LOGIN'
        record.accountWxid = raw?.account_wxid ?? loginData?.account_wxid ?? record.accountWxid
        upsertInstance({ ...record, pid: record.child?.pid ?? record.pid })
      }
      // 必须净化：微信原始 JSON 偶发含不可 clone 值，会在渲染进程炸出「操作失败」气泡
      const plain = safeCloneForIpc(raw, {})
      return { ok: response.ok, data: plain, raw: plain, sourceId, contractStatus: 'RESPONSE_VERIFY' }
    } catch (error) {
      const operation = apiOperationLabel(apiPath)
      appLog('ERROR', `${operation}失败`, { instanceId: id, module: operation, operation, sourceId, path: apiPath, error: rawErrorMessage(error) })
      return { ok: false, error: toUserErrorMessage(error, '微信接口调用失败'), sourceId, contractStatus: 'RESPONSE_VERIFY' }
    }
  })
  ipcMain.handle('wechat:list-events', (_event, id) => safeCloneForIpc(instances.get(id)?.events ?? [], []))
  ipcMain.handle('members:list-joins', (_event, filters) => listMemberJoins(filters || {}))
  ipcMain.handle('members:friend-statuses', (_event, targetKeys) => listFriendAddStatuses(Array.isArray(targetKeys) ? targetKeys : []))
  ipcMain.handle('chatAdd:getRule', () => getChatAddRule())
  ipcMain.handle('chatAdd:saveRule', (_event, rule) => { requireRuntime(); return saveChatAddRule(rule || {}) })
  ipcMain.handle('chatAdd:listCandidates', (_event, filters) => listChatAddCandidates(filters || {}))
  ipcMain.handle('chatAdd:clearCandidates', (_event, filters) => { requireRuntime(); return clearChatAddCandidates(filters || {}) })
  ipcMain.handle('chatAdd:markTasked', (_event, ids) => { requireRuntime(); return markChatAddCandidatesTasked(Array.isArray(ids) ? ids : []) })
  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:items', (_event, id) => getTaskItems(id))
  ipcMain.handle('tasks:create', (_event, payload) => { requireRuntime(); return createLocalTask(payload) })
  ipcMain.handle('tasks:confirm', (_event, id) => { requireRuntime(); const task = listTasks().find((item) => item.id === id); if (!task) throw new Error('任务不存在'); if (task.status !== 'WAITING_CONFIRMATION') throw new Error('任务当前不可确认'); setTaskStatus(id, 'QUEUED'); setImmediate(() => runTask(id)); return true })
  ipcMain.handle('tasks:pause', (_event, id) => { setTaskStatus(id, 'PAUSED'); return true })
  ipcMain.handle('tasks:cancel', (_event, id) => { requireRuntime(); return cancelTask(id) })
  ipcMain.handle('settings:get', () => {
    const settings = getSettings()
    const general = settings.general && typeof settings.general === 'object' ? settings.general : {}
    const exePath = typeof general.weixinExe === 'string' ? general.weixinExe : ''
    return {
      ...settings,
      general: {
        ...general,
        weixinVersion: isWeixinExe(exePath) ? readFileVersion(exePath) : '',
        weixinAutoDetected: Boolean(isWeixinExe(exePath)),
      },
    }
  })
  ipcMain.handle('settings:save', (_event, value) => {
    const normalized = normalizeSettings(value)
    // 允许先保存间隔/端口等；路径无效时保留原有效路径，避免改频率被微信路径拦住
    if (!isWeixinExe(normalized.weixinExe)) {
      const previous = configuredWeixinExe()
      if (isWeixinExe(previous)) normalized.weixinExe = previous
      else if (normalized.weixinExe) throw new Error('找不到所选微信程序，请重新选择 Weixin.exe；也可先点“重新检测”')
    }
    saveSetting('general', normalized)
    return {
      ...normalized,
      weixinVersion: isWeixinExe(normalized.weixinExe) ? readFileVersion(normalized.weixinExe) : '',
      weixinAutoDetected: Boolean(isWeixinExe(normalized.weixinExe)),
    }
  })
  ipcMain.handle('weixin:detect', () => {
    requireRuntime()
    const result = ensureWeixinPathConfigured({ force: true })
    if (!result.ok) throw new Error(result.message || '未能自动找到本机微信，请手动选择 Weixin.exe')
    return {
      exePath: result.exePath,
      version: result.version,
      source: result.source,
      candidates: result.candidates || [],
    }
  })
  ipcMain.handle('logs:list', (_event, limit) => listLogs(limit))
  ipcMain.handle('logs:clear', () => { clearLogs(); return true })
  ipcMain.handle('app:report-error', (_event, message, details = {}) => { appLog('ERROR', String(message || '界面操作失败'), { module: '界面操作', ...details }); return true })
  ipcMain.handle('update:check', () => ipcCheckClientUpdate({
    baseUrl: UPDATE_BASE,
    currentBuild: BUILD_ID,
    currentVersion: VERSION,
    currentReleaseSequence: RELEASE_SEQUENCE,
    isPackaged: app.isPackaged,
  }))
  ipcMain.handle('update:apply', async (event) => {
    const sendProgress = (payload) => {
      try { event.sender.send('update:progress', payload) } catch { /* ignore */ }
      for (const win of BrowserWindow.getAllWindows()) {
        try { win.webContents.send('update:progress', payload) } catch { /* ignore */ }
      }
    }
    sendProgress({ phase: 'download', downloaded: 0, total: 0, percent: 0 })
    const result = await ipcApplyClientUpdate({
      app,
      baseUrl: UPDATE_BASE,
      currentBuild: BUILD_ID,
      currentVersion: VERSION,
      currentReleaseSequence: RELEASE_SEQUENCE,
      isPackaged: app.isPackaged,
      onLog: (level, message, details) => appLog(level, message, details),
      onProgress: (downloaded, total) => {
        const percent = total > 0 ? (downloaded * 100) / total : 0
        sendProgress({ phase: 'download', downloaded, total, percent })
      },
    })
    if (result.ok) sendProgress({ phase: 'installing', percent: 100, message: result.message || '新版本已启动，正在关闭旧版本…' })
    else sendProgress({ phase: 'error', percent: 0, message: result.message || '更新失败' })
    return result
  })
  ipcMain.handle('update:mark-done', () => { markStartupUpdateDone(); return true })
  ipcMain.handle('directory:sync', (_event, payload) => { syncDirectorySnapshot(payload); return true })
  ipcMain.handle('qr:list', () => listQrItems())
  ipcMain.handle('qr:import-files', async () => {
    const result = await dialog.showOpenDialog({ defaultPath: generalSettings().qrDir || undefined, properties: ['openFile', 'multiSelections'], filters: [{ name: '二维码图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }] })
    if (result.canceled) return []
    for (const file of result.filePaths) {
      const decodedValues = await decodeNativeImages(nativeImage.createFromPath(file), { mode: 'full' })
      const recognized = new Map()
      for (const rawText of decodedValues) {
        const decodedText = normalizeQrText(rawText) || String(rawText || '').trim()
        const qrType = classifyQrText(decodedText)
        if (!decodedText || qrType === 'UNKNOWN') continue
        recognized.set(contentHash(decodedText), { decodedText, qrType })
      }
      if (!recognized.size) {
        saveQrItem({ id: randomUUID(), sha256: await sha256(file), source: '本地图片', localPath: file, qrType: 'UNKNOWN', status: 'WAITING_SCAN' })
        continue
      }
      // 同一张海报可包含多个群码：每个链接单独建任务记录，共享原图片文件。
      for (const [hash, item] of recognized) {
        saveQrItem({ id: randomUUID(), sha256: hash, source: '本地图片', localPath: file, decodedText: item.decodedText, qrType: item.qrType, status: 'READY' })
      }
    }
    return listQrItems()
  })
  ipcMain.handle('qr:import-links', (_event, text) => {
    const links = String(text || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    for (const link of links) saveQrItem({ id: randomUUID(), sha256: createHash('sha256').update(link).digest('hex').toUpperCase(), source: '链接导入', decodedText: link, qrType: classifyQrText(link), status: 'REFERENCE_ONLY' })
    return listQrItems()
  })
  ipcMain.handle('qr:collect-history', async (event, payload) => {
    requireRuntime()
    if (historyCollectRunning) throw new Error('正在采集历史图片，请稍候完成后再试')
    const outputDir = String(payload?.outputDir || '').trim()
    const rooms = Array.isArray(payload?.rooms) ? payload.rooms : []
    if (!outputDir || !path.isAbsolute(outputDir)) throw new Error('请先选择二维码保存文件夹')
    if (!rooms.length) throw new Error('请至少选择一个群聊')
    // 不限制群数量：同一微信内串行，多微信之间并行，150+ 群时更快且不压垮单实例接口
    const queueRooms = rooms.map((room) => ({
      instanceId: String(room?.instanceId || ''),
      roomId: String(room?.roomId || ''),
      name: String(room?.name || '群聊'),
    })).filter((room) => room.instanceId && room.roomId)
    mkdirSync(outputDir, { recursive: true })
    historyCollectRunning = true
    const totals = { groups: 0, checked: 0, saved: 0, duplicates: 0, expired: 0, nonQr: 0, unavailable: 0, skippedGroups: 0, queued: queueRooms.length }
    const existingHashes = qrContentHashSet()
    const emitProgress = (detail) => {
      try { event.sender.send('qr:collect-progress', safeCloneForIpc(detail)) } catch { /* ignore */ }
    }
    const byInstance = new Map()
    for (const room of queueRooms) {
      if (!byInstance.has(room.instanceId)) byInstance.set(room.instanceId, [])
      byInstance.get(room.instanceId).push(room)
    }
    let finishedRooms = 0
    const bumpProgress = (roomName, extra = {}) => {
      finishedRooms += 1
      emitProgress({ phase: 'room', roomName, roomIndex: finishedRooms, roomTotal: queueRooms.length, ...extra })
    }
    try {
      await Promise.all([...byInstance.entries()].map(async ([instanceId, instanceRooms]) => {
        const record = instances.get(instanceId)
        if (!record || record.status !== 'ONLINE') {
          totals.unavailable += instanceRooms.length
          for (const room of instanceRooms) bumpProgress(room.name, { skipped: true })
          return
        }
        const context = { databaseNames: null, tables: new Map() }
        for (const room of instanceRooms) {
          bumpProgress(room.name)
          await yieldMain()
          const current = await collectRoomQrImages(
            record,
            { roomId: room.roomId, name: room.name },
            {
              outputDir,
              folder: payload?.folder,
              maxImages: payload?.maxImages,
              existingHashes,
              onProgress: (detail) => emitProgress({
                phase: 'image',
                roomIndex: finishedRooms,
                roomTotal: queueRooms.length,
                ...detail,
              }),
            },
            context,
          )
          totals.groups += 1
          for (const key of ['checked', 'saved', 'duplicates', 'expired', 'nonQr', 'unavailable']) totals[key] += current[key]
          appLog('INFO', '群聊二维码采集完成', {
            instanceId: record.id, module: '二维码采集', operation: '读取群聊历史图片',
            roomName: room.name, queueIndex: finishedRooms, queueTotal: queueRooms.length, ...current,
          })
          await yieldMain()
        }
      }))
      // 不回传全量 records，避免巨量 IPC 克隆卡死；由前端自行 listQrItems
      return { ...totals }
    } finally {
      historyCollectRunning = false
    }
  })
  /**
   * 进群前预览：对勾选链接批量 get_a8key，返回群名/人数等。
   */
  ipcMain.handle('qr:preview-invites', async (_event, payload) => {
    requireRuntime()
    const instanceId = String(payload?.instanceId || '')
    const urls = Array.isArray(payload?.urls) ? payload.urls.map((item) => String(item || '').trim()).filter(Boolean) : []
    const record = instances.get(instanceId)
    if (!record || record.status !== 'ONLINE') throw new Error('没有可用的在线微信，无法解析群资料')
    if (!urls.length) return []
    const limited = urls.slice(0, 15)
    const rows = []
    for (const url of limited) {
      const type = classifyQrText(url)
      if (type !== 'GROUP_LINK') {
        rows.push({
          url,
          qrType: type,
          roomId: '',
          roomName: '',
          memberCount: 0,
          fullUrl: url,
          expired: false,
          label: type === 'PERSONAL_LINK' ? '个人二维码（不可进群）' : type === 'QQ_GROUP_LINK' ? 'QQ群链接（不可微信进群）' : '非微信群链接',
          error: '非微信群邀请',
        })
        continue
      }
      const preview = await fetchInvitePreview(record, url)
      rows.push({ url, qrType: type, ...preview })
      await yieldMain()
    }
    return rows
  })
  ipcMain.handle('qr:monitor-status', () => ({
    ...qrMonitorConfig,
    watchAll: Boolean(qrMonitorConfig.watchAll),
    watchedCount: qrMonitorRoomById.size,
    queueStats: [...qrMonitorQueues.entries()].map(([instanceId, state]) => ({
      instanceId,
      active: state.active || 0,
      pending: state.pending?.length || 0,
    })),
  }))
  ipcMain.handle('qr:monitor-start', (_event, payload) => {
    const outputDir = String(payload?.outputDir || '').trim()
    const rooms = Array.isArray(payload?.rooms) ? payload.rooms.map((room) => ({ instanceId: String(room.instanceId || ''), roomId: String(room.roomId || ''), name: String(room.name || '群聊') })).filter((room) => room.instanceId && room.roomId.endsWith('@chatroom')) : []
    if (!outputDir || !path.isAbsolute(outputDir)) throw new Error('请先选择二维码保存文件夹')
    if (!rooms.length) throw new Error('请至少选择一个需要监控的群聊')
    mkdirSync(outputDir, { recursive: true })
    const watchAll = Boolean(payload?.watchAll)
    qrMonitorConfig = { enabled: true, watchAll, rooms, outputDir, folder: String(payload?.folder || '默认分组') }
    rebuildQrMonitorRoomIndex()
    qrMonitorContentHashes = qrContentHashSet()
    saveSetting('qrMonitor', qrMonitorConfig)
    ensureQrMonitorSyncTimer()
    appLog('INFO', '群消息二维码监控已开启', {
      module: '二维码监控',
      operation: '开启监控',
      groupCount: rooms.length,
      watchAll,
      concurrency: QR_MONITOR_CONCURRENCY,
    })
    return { ...qrMonitorConfig, watchedCount: qrMonitorRoomById.size }
  })
  ipcMain.handle('qr:monitor-stop', () => {
    qrMonitorConfig = { ...qrMonitorConfig, enabled: false }
    rebuildQrMonitorRoomIndex()
    saveSetting('qrMonitor', qrMonitorConfig)
    ensureQrMonitorSyncTimer()
    appLog('INFO', '群消息二维码监控已停止', { module: '二维码监控', operation: '停止监控' })
    return qrMonitorConfig
  })
  ipcMain.handle('qr:monitor-sync', async () => {
    if (!qrMonitorConfig.enabled) throw new Error('请先开启群消息监控')
    if (!qrMonitorConfig.watchAll) throw new Error('当前未开启「含新进群自动加入」，无法同步扩容')
    await syncQrMonitorRoomsFromWechat('手动同步')
    return {
      ...qrMonitorConfig,
      watchedCount: qrMonitorRoomById.size,
    }
  })
  ipcMain.handle('qr:delete', (_event, ids) => { deleteQrItems(Array.isArray(ids) ? ids : []); return listQrItems() })
  ipcMain.handle('files:select-image', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] }] })
    return result.canceled ? '' : result.filePaths[0]
  })
  ipcMain.handle('files:paste-image', () => {
    const image = clipboard.readImage()
    if (image.isEmpty()) return { ok: false, error: '剪贴板里没有图片，请先复制图片后再粘贴' }
    const png = image.toPNG()
    if (!png.length) return { ok: false, error: '无法读取剪贴板图片，请重新复制后再试' }
    if (png.length > 20 * 1024 * 1024) return { ok: false, error: '粘贴的图片超过20 MB，请压缩后再试' }
    const folder = path.join(app.getPath('userData'), 'cache', 'clipboard-images')
    mkdirSync(folder, { recursive: true })
    const imagePath = path.join(folder, `clipboard-${Date.now()}-${randomUUID()}.png`)
    writeFileSync(imagePath, png)
    return { ok: true, path: imagePath, dataUrl: image.toDataURL() }
  })
  ipcMain.handle('files:select-directory', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog({ defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? '' : result.filePaths[0]
  })
  /** 在资源管理器中打开文件所在目录并选中；路径仅目录时则打开该目录。 */
  ipcMain.handle('files:reveal-in-folder', async (_event, targetPath) => {
    const raw = typeof targetPath === 'string' ? targetPath.trim() : ''
    if (!raw || raw === '-') return { ok: false, message: '该记录没有保存路径' }
    try {
      if (existsSync(raw)) {
        const st = statSync(raw)
        if (st.isDirectory()) {
          const err = await shell.openPath(raw)
          return err ? { ok: false, message: err } : { ok: true }
        }
        shell.showItemInFolder(raw)
        return { ok: true }
      }
      const dir = path.dirname(raw)
      if (dir && existsSync(dir)) {
        const err = await shell.openPath(dir)
        return err ? { ok: false, message: err } : { ok: true }
      }
      return { ok: false, message: '文件或目录不存在' }
    } catch (error) {
      return { ok: false, message: rawErrorMessage(error) || '无法打开目录' }
    }
  })
  ipcMain.handle('files:select-weixin', async (_event, defaultPath) => {
    const detected = detectPreferredWeixin()?.exePath || ''
    const initial = typeof defaultPath === 'string' && defaultPath && existsSync(defaultPath)
      ? defaultPath
      : (detected && existsSync(detected) ? detected : undefined)
    const result = await dialog.showOpenDialog({
      ...(initial ? { defaultPath: initial } : {}),
      properties: ['openFile'],
      filters: [{ name: '微信程序', extensions: ['exe'] }],
    })
    if (result.canceled) return ''
    const selected = result.filePaths[0]
    if (path.basename(selected).toLowerCase() !== 'weixin.exe') throw new Error('请选择微信安装目录中的 Weixin.exe')
    return selected
  })
  ipcMain.handle('remote:status', () => getRemoteAgentStatus())
  ipcMain.handle('remote:start', async (_event, options = {}) => startRemoteAgent(remoteAgentOptions(options.account || '微信群控本机', options.baseUrl || DEFAULT_BASE)))
  ipcMain.handle('remote:stop', () => { stopRemoteAgent(); return getRemoteAgentStatus() })
  ipcMain.handle('remote:open-console', (_event, token, baseUrl) => openAdminConsole(token || '', baseUrl || DEFAULT_BASE))
}

function resolveUiEntry() {
  if (isDev) return { type: 'url', value: process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173' }
  const candidates = [
    path.join(app.getAppPath(), 'dist', 'index.html'),
    path.join(__dirname, '..', 'dist', 'index.html'),
    path.join(process.resourcesPath || '', 'app.asar', 'dist', 'index.html'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { type: 'file', value: candidate }
  }
  return { type: 'file', value: candidates[0] }
}

function fitWindowBounds() {
  const display = screen.getPrimaryDisplay()
  const area = display.workArea || display.bounds
  const width = Math.max(800, Math.min(1440, Math.max(area.width - 40, 800)))
  const height = Math.max(560, Math.min(900, Math.max(area.height - 40, 560)))
  // 绝不超出工作区，避免小分辨率/高缩放下窗口跑出屏幕
  const finalWidth = Math.min(width, area.width)
  const finalHeight = Math.min(height, area.height)
  const x = Math.round(area.x + Math.max(0, (area.width - finalWidth) / 2))
  const y = Math.round(area.y + Math.max(0, (area.height - finalHeight) / 2))
  return {
    width: finalWidth,
    height: finalHeight,
    x,
    y,
    minWidth: Math.min(800, area.width),
    minHeight: Math.min(560, area.height),
  }
}

function closeSplashWindow() {
  const win = splashWindow
  splashWindow = null
  if (win && !win.isDestroyed()) win.destroy()
}

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow
  const win = new BrowserWindow({
    width: 300,
    height: 132,
    show: false,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  splashWindow = win
  win.on('closed', () => { if (splashWindow === win) splashWindow = null })
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{width:100%;height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#fff;color:#202124;font-family:"Microsoft YaHei UI","Microsoft YaHei",sans-serif;user-select:none;border:1px solid #dfe3e8}
    .content{display:flex;align-items:center;gap:18px}.spinner{width:34px;height:34px;border:4px solid #dce8ff;border-top-color:#1677ff;border-radius:50%;animation:spin .75s linear infinite}.title{font-size:16px;font-weight:600}.status{margin-top:7px;font-size:13px;color:#70757a}@keyframes spin{to{transform:rotate(360deg)}}
  </style></head><body><div class="content"><div class="spinner"></div><div><div class="title">微信群控管理平台</div><div class="status">正在启动，请稍候...</div></div></div></body></html>`
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .then(() => { if (!win.isDestroyed()) win.show() })
    .catch(() => { if (!win.isDestroyed()) win.show() })
  return win
}

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  const bounds = fitWindowBounds()
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F4F5F7',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  mainWindow = win
  win.setMenu(null)
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    win.show()
    win.focus()
    closeSplashWindow()
  })
  // 防止 ready-to-show 未触发时界面一直不出现
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show()
      win.focus()
      closeSplashWindow()
    }
  }, 2500).unref()

  const entry = resolveUiEntry()
  const loadPromise = entry.type === 'url' ? win.loadURL(entry.value) : win.loadFile(entry.value)
  loadPromise.catch(async (error) => {
    appLog('ERROR', '界面加载失败', { error: rawErrorMessage(error), entry: entry.value })
    try {
      await dialog.showMessageBox(win, {
        type: 'error',
        title: '界面加载失败',
        message: '主界面文件加载失败，请重新下载便携版或联系管理员。',
        detail: String(error?.message || error),
      })
    } catch {}
  })
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    appLog('ERROR', '界面渲染失败', { code, desc, url })
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    appLog('ERROR', '界面进程异常退出', { reason: details.reason, exitCode: details.exitCode })
  })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) appLog('ERROR', '界面脚本错误', { reason: String(message || '').slice(0, 1000), line, sourceId })
  })
  return win
}

function showMainWindow() {
  const win = createWindow()
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.setAlwaysOnTop(true)
  win.focus()
  setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(false) }, 300).unref()
}

function restartApp() {
  quitting = true
  try { stopRemoteAgent() } catch {}
  // 必须先释放单实例锁，否则新进程启动时会因锁失败而立刻退出
  try { app.releaseSingleInstanceLock() } catch {}
  try {
    const portableExe = process.env.PORTABLE_EXECUTABLE_FILE
    if (portableExe && existsSync(portableExe)) {
      // 便携版要用原始 exe 拉起，不能 relaunch 临时解压路径
      const child = spawn(portableExe, [], { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
    } else {
      app.relaunch({ execPath: process.execPath, args: process.argv.slice(1) })
    }
  } catch (error) {
    appLog('ERROR', '重启软件失败', { error: rawErrorMessage(error) })
  }
  app.exit(0)
}

function createTray() {
  if (tray) return tray
  try {
    let icon = nativeImage.createFromPath(path.join(__dirname, 'app-icon.ico'))
    if (icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'))
    if (icon.isEmpty()) {
      // 1x1 占位，避免部分机器因图标为空直接抛错导致启动中断
      icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
    } else {
      icon = icon.resize({ width: 16, height: 16 })
    }
    tray = new Tray(icon)
    tray.setToolTip('微信群控管理平台')
    const displayVersion = String(app.getVersion() || '').replace(/^(\d+\.\d+).*$/, '$1')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `版本号 ${displayVersion}`, click: () => {} },
      { label: '显示主界面', click: showMainWindow },
      { label: '重启软件', click: () => restartApp() },
      { label: '退出软件', click: () => { quitting = true; app.quit() } },
    ]))
    tray.on('double-click', showMainWindow)
  } catch (error) {
    appLog('ERROR', '系统托盘创建失败', { error: rawErrorMessage(error) })
    tray = null
  }
  return tray
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  createSplashWindow()
  try {
    initStorage(app.getPath('userData'))
    softwareAuth.initSoftwareAuth(app.getPath('userData'))
    saveSetting('general', normalizeSettings(getSettings().general))
    const storedQrMonitor = getSettings().qrMonitor
    if (storedQrMonitor && typeof storedQrMonitor === 'object') {
      qrMonitorConfig = {
        ...qrMonitorConfig,
        ...storedQrMonitor,
        watchAll: Boolean(storedQrMonitor.watchAll),
        rooms: Array.isArray(storedQrMonitor.rooms) ? storedQrMonitor.rooms : [],
      }
      rebuildQrMonitorRoomIndex()
      if (qrMonitorConfig.enabled) {
        qrMonitorContentHashes = qrContentHashSet()
        ensureQrMonitorSyncTimer()
      }
    }
    // 轻量同步工作：先出界面；重活放到窗口之后
    recoverInterruptedTasks()
    loadApiContracts()
    registerIpc()
    createWindow()
    createTray()
    showMainWindow()

    // 已配置微信路径时几乎零开销；未配置才后台探测，避免挡住首屏
    setImmediate(() => {
      try { ensureWeixinPathConfigured() } catch (error) {
        appLog('ERROR', '自动探测微信路径失败', { error: rawErrorMessage(error) })
      }
    })
    setImmediate(() => {
      try { repairConfirmedSendTextResults() } catch (error) {
        appLog('ERROR', '修复发送结果失败', { error: rawErrorMessage(error) })
      }
    })

    // 静默更新：冷启动通知渲染进程检查；有新版则进度条下载并自动替换重启（对齐开云）
    startUpdateScheduler({
      app,
      baseUrl: UPDATE_BASE,
      currentBuild: BUILD_ID,
      currentVersion: VERSION,
      currentReleaseSequence: RELEASE_SEQUENCE,
      isPackaged: app.isPackaged,
      onLog: (level, message, details) => appLog(level, message, details),
      onRequestStartupCheck: () => {
        for (const win of BrowserWindow.getAllWindows()) {
          try { win.webContents.send('update:startup-check') } catch { /* ignore */ }
        }
      },
    })

    // 账号校验走网络，绝不 await 挡住启动后续；超时也只影响恢复实例/远程桌面
    void softwareAuth.session().then((account) => {
      if (!account) return
      restoreInstances().catch((error) => appLog('ERROR', '恢复微信实例失败', { error: rawErrorMessage(error) }))
      for (const task of listTasks().filter((item) => item.status === 'QUEUED')) setImmediate(() => runTask(task.id))
      startRemoteAgent(remoteAgentOptions(account.username))
        .catch((error) => appLog('ERROR', '设备连接失败', { error: rawErrorMessage(error) }))
    }).catch((error) => appLog('ERROR', '读取登录会话失败', { error: rawErrorMessage(error) }))

    app.on('activate', () => { showMainWindow() })
  } catch (error) {
    appLog('ERROR', '软件启动失败', { error: rawErrorMessage(error) })
    try {
      await dialog.showErrorBox('软件启动失败', toUserErrorMessage(error, '启动时发生错误，请重试或重新下载便携版'))
    } catch {}
    createWindow()
    showMainWindow()
  }
})

app.on('window-all-closed', () => {
  if (quitting && process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  quitting = true
  closeSplashWindow()
  try { stopUpdateScheduler() } catch {}
  stopRemoteAgent()
  tray?.destroy()
  tray = null
  for (const record of instances.values()) {
    clearInterval(record.probe)
    record.tcpServer?.close()
  }
})
