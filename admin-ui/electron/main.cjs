const { app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage, clipboard, screen, shell, session } = require('electron')

// 部分机器 GPU/驱动异常会导致进程在但窗口不显示/白屏
try { app.disableHardwareAcceleration() } catch {}
const { createHash, randomUUID } = require('crypto')
const { createReadStream, createWriteStream, existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync, unlinkSync, statSync, readdirSync } = require('fs')
const { readdir, stat } = require('fs/promises')
const { pipeline } = require('stream/promises')
const { spawn, execFile } = require('child_process')
const { promisify } = require('util')
const net = require('net')
const http = require('http')
const https = require('https')
const path = require('path')
const { initStorage, saveSetting, getSettings, upsertInstance, listStoredInstances, removeInstance, removeInactiveInstancesByPorts, saveLog, listLogs, clearLogs, clearRuntimeCaches, clearApiSamplesOnly, saveApiSample, saveEvent, listMessageEventsForKickScan, listMemberJoins, listFriendAddStatuses, createTask, listTasks, getTaskItems, setTaskStatus, cancelTask, setTaskItemStatus, setTaskItemStarted, setTaskItemResult, patchTaskItemRequest, patchTaskConfig, recoverInterruptedTasks, repairConfirmedSendTextResults, reserveFriendDailyAttempt, reserveQrJoinDailyAttempt, releaseFriendDailyAttempt, releaseQrJoinDailyAttempt, updateTaskItemInstanceId, migrateDirectorySnapshotToInstance, rebindChatAddCandidatesForAccount, hasDeliveredContent, recordDeliveredContent, hasDirectoryOwnership, loadDirectoryOwnershipSet, syncDirectorySnapshot, remoteSyncSnapshot, saveQrItem, listQrItems, deleteQrItems, updateQrScanResult, updateQrItemType, getChatAddRule, saveChatAddRule, upsertChatAddCandidate, listChatAddCandidates, markChatAddCandidatesTasked, clearChatAddCandidates, upsertKickedGroupPending, getKickedGroupCleanup, listKickedGroupPending, listActiveKickedCleanupTargets, rebindKickedGroupPendingToInstance, updateKickedGroupCleanup, removeLocalChatroomOwnership, listOwnedChatrooms, markChatroomBlocked, isChatroomBlocked, isChatroomBlockedForInstance, loadBlockedRoomIdSet, loadBlockedRoomIdSetForInstance, loadDirectoryExcludedRoomIdSetForInstance, listBlockedChatrooms, hasQrContentHash } = require('./storage.cjs')
const { MAX_MESSAGE_BYTES, LengthPrefixedDecoder, hasFrequentEvidence, isVerifiedSuccess, buildAddFriendRequest, evaluateFriendAddResult, isRetryableFriendCredentialFailure } = require('./protocol.cjs')
const { createSerialExecutor, parseInjectorOutput, decodeInjectorChunks, waitForInjectorClose } = require('./instance-runtime.cjs')
const { rawErrorMessage, toUserErrorMessage } = require('./user-error.cjs')
const { parseProfileCredentials, rawStructure } = require('./friend-profile.cjs')
const { resolveFriendProfileCredentials } = require('./friend-credential-resolve.cjs')
const { requestWechatRead, clearInstanceCache, invalidateInstanceApi, getReadBrokerStats, resetAllStats, READ_API_WHITELIST } = require('./wechat-read-broker.cjs')
const { runFriendCredentialDiagnostic } = require('./friend-credential-diagnostic.cjs')
const { resolveTaskItemInstance } = require('./task-instance-resolve.cjs')
const {
  waitForTaskInstance,
  TASK_INSTANCE_WAIT_TIMEOUT_MS,
  TASK_INSTANCE_WAIT_INTERVAL_MS,
} = require('./task-instance-wait.cjs')
const { resolveIpcApiTimeout } = require('./ipc-api-timeout.cjs')
const { buildHistoryImagePageSql } = require('./qr-history-pagination.cjs')
const { startRemoteAgent, stopRemoteAgent, getStatus: getRemoteAgentStatus, openAdminConsole, DEFAULT_BASE } = require('./remote-agent.cjs')
const meshRemote = require('./mesh-remote-bridge.cjs')
meshRemote.setParentWindowGetter(() => mainWindow)
const softwareAuth = require('./software-auth.cjs')
const { safeFolderName, classifyQrText, qrTypeLabel, contentHash, messageTableName, rowsFromApi, valueOf, fieldString, existingImagePath, cdnDownloadRequest, downloadRequest, decodeNativeImages, accurateFileName, prepareHistoryMessageRow, yieldMain, normalizeQrText } = require('./qr-collector.cjs')
const {
  parseInvitePreview,
  mergeInvitePreview,
  buildInvitePageRequest,
  hasUsableInvitePreview,
  hasReliableJoinTarget,
  scoreInvitePreviewCandidate,
  evaluateEnterRoomResult,
  confirmJoinedFromRoomList,
  findAlreadyJoinedRoom,
  formatInvitePreviewLine,
  findRoomIdInUrl,
  isExpandedInviteUrl,
  isShortGroupInviteUrl,
  isJoinApplicationPending,
} = require('./qr-join.cjs')
const { mergeMonitorRooms, extractRoomsFromApiRaw, monitorRoomKey, rebindMonitorRoomsForAccount, normalizeMonitorRoom } = require('./qr-monitor-rooms.cjs')
const { pruneDiagnosticReportFiles } = require('./diagnostic-file-prune.cjs')
const {
  RECENT_QR_HASH_TTL_MS,
  RECENT_QR_HASH_MAX,
  reserveRecentQrContentHash: reserveRecentQrHashInMap,
  releaseRecentQrContentHash: releaseRecentQrHashInMap,
} = require('./recent-qr-hash-cache.cjs')
const {
  pruneStoppedRuntimeInstances: pruneStoppedRuntimeInMap,
  pruneStoppedRuntimeForAccount: pruneStoppedRuntimeForAccountInMap,
} = require('./stopped-instance-prune.cjs')
const { extractSelfKickedEvent, resolveSelfStillInMembers, canCleanupKickedRoom, isImmediateKickEvidence, isLeaveCallbackEvidence, kickHitFromHistoryMessage } = require('./kicked-group-cleanup.cjs')
const { scrubLegacyCachesOnStartup } = require('./startup-cache-scrub.cjs')
const { installServiceCertificateTrust } = require('./service-tls.cjs')

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
  resolvePortableExePath,
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
/** @type {{ t0: number, bytes0: number, lastT: number, lastBytes: number, speedBps: number } | null} */
let updateDownloadMeter = null
let runtimeAllowed = true
let qrMonitorConfig = { enabled: false, watchAll: false, rooms: [], outputDir: '', folder: '默认分组' }
/** instanceId+roomId → 监控群配置，150+ 群时 O(1) 命中 */
let qrMonitorRoomByKey = new Map()
/** 监控去重哈希缓存，避免每张图全表扫库 */
let qrMonitorContentHashes = null // legacy unused; realtime uses recentQrContentHashes
/** 实时监控内容哈希预约缓存（非全库加载）：hash → expiresAt */
const recentQrContentHashes = new Map()
/** 非监控群图片忽略日志节流：roomHint → 上次记录时间 */
const qrMonitorSkipLogAt = new Map()
/** 每微信实例的监控下载队列：有限并发，避免 150 群同时发图时排成长龙 */
const qrMonitorQueues = new Map()
const QR_MONITOR_CONCURRENCY = 2
/** watchAll 模式下定时从微信拉群列表，自动并入新进群 */
const QR_MONITOR_SYNC_INTERVAL_MS = 45000
/** get_all_room_detail 最短间隔（ms），避免高频全量拉群详情 */
const QR_MONITOR_DETAIL_TTL_MS = 300000
let qrMonitorSyncTimer = undefined
let qrMonitorSyncRunning = false
/** @type {Map<string, number>} instanceId → 上次拉全量详情的时间戳 */
const lastRoomDetailFetchAt = new Map()
/** @type {Map<string, Promise<unknown>>} instanceId → 进行中的 get_all_room_detail Promise（请求合并） */
const roomDetailInflight = new Map()
const qrValidityCache = new Map()

/** 被踢群清理：扫描历史并创建任务时防重入（真正退出在任务中心执行） */
let kickedGroupCleanupPreparing = false
/** 被踢群扫描真正在跑的 Promise（timeout 不能释放此锁） */
let kickedGroupCleanupActivePromise = null

/** @type {Map<string, { promise: Promise, createdAt: number }>} key: instanceId|normalizedUrl */
const qrInvitePreviewInflight = new Map()
/** @type {Map<string, { preview: object, expiresAt: number }>} key: instanceId|normalizedUrl */
const qrInvitePreviewCache = new Map()
const QR_INVITE_PREVIEW_TTL_MS = 90000

/** @type {Map<string, Promise>} key: instanceId|roomId|wxid */
const friendCredentialInflight = new Map()

/** @type {Map<string, number>} key: instanceId|roomId|messageId → timestamp of last enqueue */
const qrMonitorRecentEvents = new Map()
const QR_MONITOR_EVENT_DEDUP_TTL_MS = 90000
const deliveryImageHashCache = new Map()
const DELIVERY_IMAGE_HASH_TTL_MS = 10 * 60 * 1000
const DELIVERY_IMAGE_HASH_MAX = 512
const { cleanupRuntimeTtlMaps: sweepRuntimeTtlMaps } = require('./runtime-ttl-cleanup.cjs')
const { appendJsonlLog } = require('./jsonl-log-writer.cjs')
const {
  hasDiagnosticIdempotency,
  markDiagnosticProcessing,
  markDiagnosticDone,
  clearDiagnosticProcessing,
  cleanupDiagnosticIdempotency,
} = require('./diagnostic-idempotency.cjs')
const RUNTIME_CACHE_CLEANUP_INTERVAL_MS = 60000
let runtimeCacheCleanupTimer = null

function cleanupRuntimeTtlMaps(now = Date.now()) {
  sweepRuntimeTtlMaps({
    qrInvitePreviewCache,
    qrMonitorRecentEvents,
    QR_MONITOR_EVENT_DEDUP_TTL_MS,
    qrValidityCache,
    qrMonitorSkipLogAt,
    QR_MONITOR_SKIP_LOG_TTL_MS: 600000,
    deliveryImageHashCache,
    DELIVERY_IMAGE_HASH_TTL_MS,
    DELIVERY_IMAGE_HASH_MAX,
    recentQrContentHashes,
    RECENT_QR_HASH_TTL_MS,
    RECENT_QR_HASH_MAX,
    chatAddMissLogAt,
    CHAT_ADD_MISS_LOG_TTL_MS: 600000,
  }, now)
  cleanupDiagnosticIdempotency(now)
}

function startRuntimeCacheCleanupTimer() {
  if (runtimeCacheCleanupTimer) return
  runtimeCacheCleanupTimer = setInterval(() => cleanupRuntimeTtlMaps(), RUNTIME_CACHE_CLEANUP_INTERVAL_MS)
  if (typeof runtimeCacheCleanupTimer.unref === 'function') runtimeCacheCleanupTimer.unref()
}
startRuntimeCacheCleanupTimer()

/** per taskId+instanceId+roomId mutation tracking for kicked group cleanup */
const kickedMutationDone = new Map()

/**
 * 重建监控群索引（开启/恢复配置时调用）。
 */
function rebuildQrMonitorRoomIndex() {
  const map = new Map()
  for (const room of Array.isArray(qrMonitorConfig.rooms) ? qrMonitorConfig.rooms : []) {
    const normalized = normalizeMonitorRoom(room)
    if (normalized) map.set(monitorRoomKey(normalized.instanceId, normalized.roomId), normalized)
  }
  qrMonitorRoomByKey = map
}

/**
 * 微信 ONLINE 且 accountWxid 明确后：把同账号旧 instance 的监控配置迁到当前实例。
 * @param {{ id: string, accountWxid?: string, status?: string }} record
 * @returns {boolean}
 */
function rebindQrMonitorRoomsForInstance(record) {
  if (!record?.id || !record?.accountWxid) return false
  if (!Array.isArray(qrMonitorConfig.rooms) || !qrMonitorConfig.rooms.length) return false
  const { rooms, changed, rebound } = rebindMonitorRoomsForAccount(qrMonitorConfig.rooms, record, instances)
  // 最终按 pair 去重，避免 AAA-room1 与 BBB-room1 并存或重复
  const dedup = new Map()
  for (const room of rooms) {
    const normalized = normalizeMonitorRoom(room)
    if (!normalized) continue
    const key = monitorRoomKey(normalized.instanceId, normalized.roomId)
    const prev = dedup.get(key)
    if (!prev) {
      dedup.set(key, normalized)
      continue
    }
    dedup.set(key, {
      ...prev,
      accountWxid: normalized.accountWxid || prev.accountWxid || '',
      name: (normalized.name && normalized.name !== '群聊') ? normalized.name : prev.name,
    })
  }
  const nextRooms = [...dedup.values()]
  const dedupChanged = JSON.stringify(nextRooms) !== JSON.stringify(qrMonitorConfig.rooms || [])
  if (!changed && !dedupChanged) return false
  qrMonitorConfig = { ...qrMonitorConfig, rooms: nextRooms }
  rebuildQrMonitorRoomIndex()
  try { saveSetting('qrMonitor', qrMonitorConfig) } catch { /* ignore */ }
  notifyQrMonitorRoomsChanged({ reason: 'instance-rebind', added: [] })
  appLog('INFO', `群消息监控已绑定到新微信实例（${rebound} 个群）`, {
    instanceId: record.id, module: '二维码监控', accountWxid: record.accountWxid, rebound,
  })
  return true
}

/**
 * 启动时回填历史 monitor rooms 的 accountWxid（若旧 instance 仍在）。
 */
function migrateQrMonitorAccountWxids() {
  if (!Array.isArray(qrMonitorConfig.rooms) || !qrMonitorConfig.rooms.length) return
  let changed = false
  const rooms = qrMonitorConfig.rooms.map((room) => {
    const normalized = normalizeMonitorRoom(room)
    if (!normalized) return room
    if (normalized.accountWxid) return normalized
    const owner = instances.get(normalized.instanceId)
    if (owner?.accountWxid) {
      changed = true
      return { ...normalized, accountWxid: String(owner.accountWxid) }
    }
    return normalized
  })
  if (!changed) return
  qrMonitorConfig = { ...qrMonitorConfig, rooms }
  rebuildQrMonitorRoomIndex()
  try { saveSetting('qrMonitor', qrMonitorConfig) } catch { /* ignore */ }
}

/**
 * 向渲染进程广播监控群列表变化（用于 UI 自增长显示）。
 * @param {{ added?: Array<{ instanceId: string, roomId: string, name: string }>, reason?: string }} [detail]
 */


const CLIPBOARD_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const CLIPBOARD_IMAGE_MAX = 200

function collectProtectedClipboardPaths() {
  const protectedPaths = new Set()
  try {
    for (const task of listTasks()) {
      if (!['QUEUED', 'RUNNING', 'PAUSED', 'COOLING_DOWN', 'WAITING_CONFIRMATION'].includes(String(task.status || ''))) continue
      for (const item of getTaskItems(task.id)) {
        if (String(item.action_type || '') !== 'SEND_IMAGE') continue
        if (!['QUEUED', 'RUNNING', 'PAUSED', 'COOLING_DOWN', 'WAITING_CONFIRMATION', 'PROFILE_PENDING', 'CREDENTIALS_READY'].includes(String(item.status || ''))) continue
        let req = {}
        try { req = JSON.parse(item.request_json || '{}') } catch { req = {} }
        const fp = String(req.filepath || req.imagePath || req.filePath || req.path || '').trim()
        if (fp) protectedPaths.add(path.normalize(fp))
      }
    }
  } catch { /* ignore */ }
  return protectedPaths
}

function pruneClipboardImageCache(folder) {
  try {
    if (!existsSync(folder)) return
    const protectedPaths = collectProtectedClipboardPaths()
    const now = Date.now()
    const files = readdirSync(folder)
      .filter((name) => /^clipboard-.*\.png$/i.test(name))
      .map((name) => {
        const full = path.join(folder, name)
        let mtimeMs = 0
        try { mtimeMs = statSync(full).mtimeMs } catch { mtimeMs = 0 }
        return { full, mtimeMs }
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs)
    for (const file of files) {
      if (protectedPaths.has(path.normalize(file.full))) continue
      if (now - file.mtimeMs > CLIPBOARD_IMAGE_TTL_MS) {
        try { unlinkSync(file.full) } catch { /* ignore */ }
      }
    }
    const remaining = files.filter((file) => existsSync(file.full) && !protectedPaths.has(path.normalize(file.full)))
    while (remaining.length > CLIPBOARD_IMAGE_MAX) {
      const oldest = remaining.shift()
      if (!oldest) break
      try { unlinkSync(oldest.full) } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function safeBroadcast(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win || win.isDestroyed()) continue
      if (!win.webContents || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, payload)
    } catch {
      /* 绝不能 appLog，避免广播失败递归 */
    }
  }
}

function notifyQrMonitorRoomsChanged(detail = {}) {
  const payload = {
    enabled: Boolean(qrMonitorConfig.enabled),
    watchAll: Boolean(qrMonitorConfig.watchAll),
    watchedCount: qrMonitorRoomByKey.size,
    rooms: Array.isArray(qrMonitorConfig.rooms) ? qrMonitorConfig.rooms : [],
    added: Array.isArray(detail.added) ? detail.added : [],
    reason: String(detail.reason || ''),
  }
  safeBroadcast('qr:monitor-rooms-changed', payload)
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
      watchedCount: qrMonitorRoomByKey.size,
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
        const listRes = await readApi(record, '/api/get_chatroom_list', {})
        const listRooms = extractRoomsFromApiRaw(listRes.response.ok ? listRes.raw : null)
        const rows = [...listRooms]
        const knownKeys = new Set([...qrMonitorRoomByKey.keys()])
        const hasNewUnnamed = listRooms.some((r) => {
          const key = monitorRoomKey(record.id, r.roomId)
          return !knownKeys.has(key) || (!r.name || r.name === '群聊')
        })
        if (hasNewUnnamed) {
          const detailRes = await readApi(record, '/api/get_all_room_detail', {}, { force: true })
          rows.push(...extractRoomsFromApiRaw(detailRes.response.ok ? detailRes.raw : null))
        }
        for (const row of rows) {
          if (isChatroomBlockedForInstance(record.id, row.roomId)) continue
          incoming.push({
            instanceId: record.id,
            accountWxid: String(record.accountWxid || ''),
            roomId: row.roomId,
            name: row.name,
          })
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
 * 深遍历一次事件，严格按 instanceId+roomId 命中监控配置。
 * @param {{ id: string }} record
 * @param {unknown} event
 * @returns {{ instanceId: string, roomId: string, name: string } | null}
 */
function findMonitoredRoomDeep(record, event) {
  if (!qrMonitorRoomByKey.size) return null
  const seen = new Set()
  let found = null
  const walk = (value) => {
    if (found || value == null) return
    if (typeof value === 'string') {
      const text = String(value).trim()
      if (text.endsWith('@chatroom')) {
        const hit = qrMonitorRoomByKey.get(monitorRoomKey(record.id, text))
        if (hit) found = hit
      }
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
  if (!qrMonitorConfig.enabled) return Promise.resolve({ skipped: true })
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
  if (!qrMonitorConfig.enabled) return
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
        if (!qrMonitorConfig.enabled) {
          // stop 后不再 pump；active 归零则清 Map
          if ((state.active || 0) <= 0 && !(state.pending?.length)) qrMonitorQueues.delete(instanceId)
          return
        }
        if (!state.pending.length && state.active <= 0) qrMonitorQueues.delete(instanceId)
        else pumpQrMonitorQueue(instanceId)
      })
  }
}

/**
 * 监控用近期内容哈希预约（进程内 TTL）；永久去重以 SQLite hasQrContentHash 为准。
 * @returns {Map<string, number>}
 */
function monitorContentHashes() {
  return recentQrContentHashes
}

function reserveRecentQrContentHash(hash) {
  return reserveRecentQrHashInMap(recentQrContentHashes, hash, { hasPersistent: hasQrContentHash })
}

function releaseRecentQrContentHash(hash) {
  releaseRecentQrHashInMap(recentQrContentHashes, hash)
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
    onFriendCredentialDiagnostic: async (message) => {
      await handleFriendCredentialDiagnosticCommand(message)
    },
    onCheckClientUpdate: async (message) => {
      await handleRemoteCheckClientUpdate(message)
    },
  }
}

async function postDiagnosticReport(baseUrl, report) {
  const url = `${String(baseUrl || DEFAULT_BASE).replace(/\/$/, '')}/api/friend-diagnostic/report`
  const body = JSON.stringify(report)
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(30000) })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.ok === false) throw new Error(data?.message || `diagnostic report HTTP ${response.status}`)
  return data
}

async function handleFriendCredentialDiagnosticCommand(message) {
  const payload = {
    diagnosticId: String(message.diagnosticId || message.payload?.diagnosticId || randomUUID()),
    targetClientId: String(message.targetClientId || message.payload?.targetClientId || ''),
    targetInstanceId: String(message.targetInstanceId || message.payload?.targetInstanceId || ''),
    targetAccountWxid: String(message.targetAccountWxid || message.payload?.targetAccountWxid || ''),
    roomId: String(message.roomId || message.payload?.roomId || ''),
    memberUserName: String(message.memberUserName || message.payload?.memberUserName || ''),
    expectedNickname: String(message.expectedNickname || message.payload?.expectedNickname || ''),
    dryRun: message.dryRun !== false && message.payload?.dryRun !== false,
    allowSingleAddFriendAfterVerified: Boolean(message.allowSingleAddFriendAfterVerified || message.payload?.allowSingleAddFriendAfterVerified),
    expiresAt: String(message.expiresAt || message.payload?.expiresAt || ''),
    idempotencyKey: String(message.idempotencyKey || message.payload?.idempotencyKey || ''),
  }
  if (payload.idempotencyKey) {
    if (hasDiagnosticIdempotency(payload.idempotencyKey)) {
      appLog('WARN', 'FRIEND_CREDENTIAL_DIAGNOSTIC 幂等跳过', { module: '凭证诊断', idempotencyKey: payload.idempotencyKey })
      return
    }
    if (!markDiagnosticProcessing(payload.idempotencyKey)) {
      appLog('WARN', 'FRIEND_CREDENTIAL_DIAGNOSTIC 幂等跳过', { module: '凭证诊断', idempotencyKey: payload.idempotencyKey })
      return
    }
  }
  const selfId = String(getRemoteAgentStatus()?.clientId || '')
  if (payload.targetClientId && selfId && payload.targetClientId !== selfId) {
    if (payload.idempotencyKey) clearDiagnosticProcessing(payload.idempotencyKey)
    throw new Error('targetClientId 与本机不符')
  }
  try {
  const record = [...instances.values()].find((item) => item.id === payload.targetInstanceId)
    || [...instances.values()].find((item) => String(item.accountWxid || '') === payload.targetAccountWxid && item.status === 'ONLINE')
  let dllPath = ''
  let dllSha256 = ''
  try {
    const hookDll = path.join(process.resourcesPath || '', 'hook', '4.1.8.27', 'libGLESv1.dll')
    const candidates = [record?.dllPath, hookDll].filter(Boolean)
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) {
        dllPath = candidate
        dllSha256 = createHash('sha256').update(readFileSync(candidate)).digest('hex')
        break
      }
    }
  } catch { /* ignore */ }
  const wechatVersion = String(record?.weixinVersion || record?.wechatVersion || '')
  const report = await runFriendCredentialDiagnostic({
    requestApi,
    record: record || { id: '', accountWxid: '', status: 'OFFLINE', apiPort: 0 },
    payload,
    clientMeta: {
      clientId: selfId || payload.targetClientId,
      clientVersion: VERSION,
      wechatVersion,
      dllPath,
      dllSha256,
    },
  })
  try {
    const dir = path.join(app.getPath('userData'), 'friend-diagnostics')
    mkdirSync(dir, { recursive: true })
    const { sanitizeLogEntry } = require('./sensitive-redaction.cjs')
    const safeReport = sanitizeLogEntry({ t: new Date().toISOString(), ...report })
    appendJsonlLog(dir, safeReport, { basename: 'diagnostics.jsonl', maxBytes: 10 * 1024 * 1024, maxFiles: 3 })
    writeFileSync(path.join(dir, `${report.diagnosticId || Date.now()}.json`), JSON.stringify(safeReport, null, 2), 'utf8')
    pruneDiagnosticReportFiles(dir)
  } catch (error) {
    appLog('WARN', '诊断结果本地落盘失败', { module: '凭证诊断', error: rawErrorMessage(error) })
  }
  appLog('INFO', 'FRIEND_CREDENTIAL_DIAGNOSTIC 完成', {
    module: '凭证诊断',
    diagnosticId: report.diagnosticId,
    finalClassification: report.finalClassification,
    credentialSource: report.credentialSource,
    elapsedMs: report.elapsedMs,
    probeCount: Array.isArray(report.probes) ? report.probes.length : 0,
  })
  // 同步关键字段进 sqlite 日志，便于 wx_sync
  for (const probe of report.probes || []) {
    appLog('INFO', '凭证诊断探针', {
      module: '凭证诊断',
      operation: 'FRIEND_CREDENTIAL_DIAGNOSTIC',
      diagnosticId: report.diagnosticId,
      endpoint: probe.endpoint,
      requestBodyWxid: probe.requestWxid,
      requestBodyRoomId: probe.requestRoomId,
      httpStatus: probe.httpStatus,
      baseRet: probe.baseRet,
      contactCount: probe.contactCount,
      matchedContact: probe.matchedTarget,
      hasV3: probe.hasV3,
      v3Prefix: probe.v3Prefix,
      v3Length: probe.v3Length,
      hasV4: probe.hasV4,
      v4Prefix: probe.v4Prefix,
      v4Length: probe.v4Length,
      rawPreview: probe.rawPreview,
      elapsedMs: probe.elapsedMs,
      parserVersion: 'friend-credential-diagnostic-v1',
      accountWxid: report.accountWxid,
      targetWxid: report.targetUserName,
      roomId: report.roomId,
      instanceId: report.instanceId,
      instancePort: report.instancePort,
      clientVersion: report.clientVersion,
      wechatVersion: report.wechatVersion,
      dllSha256: report.dllSha256,
      finalClassification: report.finalClassification,
    })
  }
  await postDiagnosticReport(DEFAULT_BASE, report)
  if (payload.idempotencyKey) markDiagnosticDone(payload.idempotencyKey)
  } catch (error) {
    if (payload.idempotencyKey) clearDiagnosticProcessing(payload.idempotencyKey)
    throw error
  }
}

async function handleRemoteCheckClientUpdate(message) {
  const selfId = String(getRemoteAgentStatus()?.clientId || '')
  appLog('INFO', '收到定向更新命令', { module: '软件更新', commandId: message?.commandId || message?.id, clientId: selfId })
  const result = await ipcApplyClientUpdate({
    app,
    baseUrl: UPDATE_BASE,
    currentBuild: BUILD_ID,
    currentVersion: VERSION,
    currentReleaseSequence: RELEASE_SEQUENCE,
    clientId: selfId,
    isPackaged: app.isPackaged,
    allowRemoteForce: true,
    onLog: (level, msg, details) => appLog(level, msg, details),
  })
  if (!result?.ok) throw new Error(result?.message || '定向更新未执行')
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
  const apiPort = validPort(source.httpPort, 19088)
  let tcpPort = validPort(source.tcpPort, 61108)
  if (tcpPort === apiPort) tcpPort = apiPort < 65534 ? apiPort + 2 : apiPort - 2
  const weixinExe = typeof source.weixinExe === 'string' && source.weixinExe.trim()
    ? path.resolve(source.weixinExe.trim())
    : ''
  return {
    httpPort: apiPort,
    tcpPort,
    friendDailyLimit: Math.max(Number(source.friendDailyLimit) || 50, 1),
    qrDir: typeof source.qrDir === 'string' ? source.qrDir : '',
    weixinExe,
  }
}

/** 确认执行未写入 intervalMs 时的安全默认间隔（避免升级前定时任务 0ms 连发） */
const DEFAULT_TASK_PACE_INTERVAL_MS = 1000

/**
 * 任务项之间的固定执行间隔（毫秒）。确认执行时写入 config.intervalMs；显式 0 表示不等待。
 * @param {{ config?: Record<string, unknown> } | null | undefined} task
 */
function resolveTaskPaceIntervalMs(task) {
  if (!task?.config || !Object.prototype.hasOwnProperty.call(task.config, 'intervalMs')) {
    return DEFAULT_TASK_PACE_INTERVAL_MS
  }
  const raw = Number(task.config.intervalMs)
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_TASK_PACE_INTERVAL_MS
  return Math.floor(raw)
}

function appLog(level, message, details = {}) {
  const entry = { time: new Date().toISOString(), level, message, ...details }
  try {
    const logDir = path.join(app.getPath('userData'), 'logs')
    appendJsonlLog(logDir, entry)
  } catch {}
  try { saveLog(entry) } catch {}
  safeBroadcast('wechat:log', entry)
}

const apiOperationLabels = {
  '/api/send_text_msg': '发送文字消息', '/api/send_image_msg': '发送图片消息', '/api/add_friend': '添加好友',
  '/api/get_contact_list2': '读取好友列表', '/api/get_chatroom_list': '读取群聊列表', '/api/batch_getroom_cache': '读取群聊资料', '/api/get_all_room_detail': '读取全量群详情',
  '/api/get_room_members': '读取群成员', '/api/get_group_member_contact': '读取群成员资料', '/api/save_chatroom_to_contact': '保存群聊到通讯录',
  '/api/remov_chatroom_to_contact': '取消群聊通讯录', '/api/quit_and_del_chat_room': '清除群聊会话',
  '/api/check_login': '检测微信登录状态', '/api/get_profile_cache': '读取微信资料',
  '/api/qrscan': '识别二维码', '/api/get_db_handle': '读取消息库', '/api/sqlite3_exec': '读取群聊历史', '/api/download_img': '下载历史图片', '/api/cdn_download': '下载高清原图', '/api/get_a8key': '验证二维码有效期', '/api/enter_room': '提交进群申请',
}

const DEFAULT_FRIEND_VERIFY_CONTENT = '你好，我是群里的朋友'
/** 需群主确认的群二维码：申请理由为空时用此默认文案，避免空 msg 导致无法提交 */
const DEFAULT_QR_APPLY_TEXT = '你好，想加入群聊'

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
    const handleResult = await readApi(record, '/api/get_db_handle', {}, { timeout: 5000 })
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
    const pageSize = 300
    let remaining = unlimited ? null : limit
    let afterLocalId = null
    const orderKey = orderColumn || 'local_id'
    while (remaining == null || remaining > 0) {
      const page = buildHistoryImagePageSql({
        table,
        typeColumn,
        orderColumn: orderKey,
        pageSize,
        afterLocalId,
        maxRemaining: remaining,
      })
      const sql = page.sql.replace(/^SELECT \*/, `SELECT ${selectCols.join(', ')}`)
      const messagesResult = await requestApi(record, '/api/sqlite3_exec', {
        db_name: databaseName,
        sql_fmt: sql,
      }, 20000)
      if (!messagesResult.response.ok) break
      const rows = rowsFromApi(messagesResult.raw)
      if (!rows.length) break
      await yieldMain()
      for (const rawRow of rows) {
        result.checked += 1
        if (typeof options.onProgress === 'function') {
          try { options.onProgress({ roomName: room.name, checked: result.checked, pageSize, saved: result.saved }) } catch { /* ignore */ }
        }
        const row = prepareHistoryMessageRow(rawRow)
        afterLocalId = valueOf(rawRow, [orderKey, 'local_id', 'server_id']) ?? afterLocalId
        const temporaryFolder = path.join(app.getPath('temp'), 'wx-group-qr-collector')
        mkdirSync(temporaryFolder, { recursive: true })
        const temporaryPath = path.join(temporaryFolder, `${randomUUID()}.jpg`)
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
      if (remaining != null) remaining -= rows.length
      if (rows.length < page.limit) break
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
  const existing = options?.existingHashes instanceof Set ? options.existingHashes : null
  const validateLinks = options?.validateLinks !== false
  const extension = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp'].includes(path.extname(sourcePath).toLowerCase())
    ? path.extname(sourcePath).toLowerCase()
    : '.jpg'
  const imageFileHash = await sha256(sourcePath)
  let sharedDestination = ''
  for (const item of recognized) {
    const hash = item.hash
    // 先占位，避免监控并发 2 路同时通过「未存在」检查而各存一份
    if (existing) {
      if (existing.has(hash) || hasQrContentHash(hash)) {
        existing.add(hash)
        result.duplicates += 1
        continue
      }
      existing.add(hash)
    } else if (reserveRecentQrContentHash(hash)) {
      result.duplicates += 1
      continue
    }
    // 历史批量采集跳过 a8key，避免每张图网络校验把界面卡死；监控实时仍校验
    if (validateLinks && !await isQrLinkCurrentlyValid(record, item.decodedText, item.qrType)) {
      if (existing) existing.delete(hash)
      else releaseRecentQrContentHash(hash)
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
  const key = `${record.id}|${contentHash(decodedText)}`
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

  const currentWxid = String(record.accountWxid || '').trim()
  const bound = rule.instanceId ? instances.get(rule.instanceId) : null
  const boundWxid = String(rule.accountWxid || bound?.accountWxid || '').trim()
  const sameInstance = Boolean(rule.instanceId && rule.instanceId === record.id)

  // 实例已对齐时，仅回填缺失的账号字段
  if (sameInstance) {
    if (!rule.accountWxid && currentWxid) {
      return saveChatAddRule({
        enabled: rule.enabled,
        instanceId: record.id,
        accountWxid: currentWxid,
        roomIds: rule.roomIds,
        keywords: rule.keywords,
        excludeText: rule.excludeText,
      })
    }
    return rule
  }

  const boundOnline = Boolean(bound && bound.status === 'ONLINE')
  const sameAccount = Boolean(boundWxid && currentWxid && boundWxid === currentWxid)
  // 跨账号：绝不改绑（多开时其他微信的消息会走到这里）
  if (boundWxid && currentWxid && boundWxid !== currentWxid) return rule
  // 同账号且旧实例仍在线：仅当「当前实例刚有消息/探测」且旧实例不是最近活跃时才改绑，避免双 ONLINE 乒乓
  const boundGone = !rule.instanceId || !bound || !boundOnline
  if (!sameAccount && !boundGone) return rule
  if (!sameAccount && boundOnline) return rule
  if (sameAccount && boundOnline && rule.instanceId !== record.id) {
    const boundLast = Number(bound?.lastCallbackAt || bound?.lastProbeAt || 0)
    const currentLast = Number(record.lastCallbackAt || record.lastProbeAt || Date.now())
    // 旧实例仍有更新的回调/探测 → 不抢绑；当前明显更新才改
    if (boundLast && currentLast && boundLast >= currentLast - 2000) return rule
  }

  const next = {
    enabled: rule.enabled,
    instanceId: record.id,
    accountWxid: currentWxid || boundWxid || rule.accountWxid || '',
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
    accountWxid: next.accountWxid,
    sameAccount,
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
  const matched = matchChatAddRule(event, {
    ...rule,
    // 规则缺账号时用当前实例 wxid，避免自己的群消息进候选
    accountWxid: rule.accountWxid || record.accountWxid,
  }, record.id)
  if (!matched.accepted || !matched.hit) {
    const reason = matched.reason || 'REJECTED'
    if (reason === 'INSTANCE_MISMATCH' || reason === 'ROOM_FILTER') {
      const key = `${record.id}:${reason}`
      const now = Date.now()
      const last = chatAddMissLogAt.get(key) || 0
      if (now - last > 30000) {
        chatAddMissLogAt.set(key, now)
        const ruleWxid = String(rule.accountWxid || '').trim()
        const currentWxid = String(record.accountWxid || '').trim()
        const crossAccount = Boolean(ruleWxid && currentWxid && ruleWxid !== currentWxid)
        const mismatchHint = crossAccount
          ? '非监听微信号，已忽略'
          : (reason === 'INSTANCE_MISMATCH' ? '监听实例未对齐且未能自动改绑' : '消息群不在监听列表')
        appLog(crossAccount ? 'INFO' : 'WARN', `群聊加好友未命中：${mismatchHint}`, {
          instanceId: record.id,
          module: '群聊加好友',
          operation: '过滤',
          reason,
          ruleInstanceId: rule.instanceId,
          ruleAccountWxid: ruleWxid,
          accountWxid: currentWxid,
          roomCount: Array.isArray(rule.roomIds) ? rule.roomIds.length : 0,
        })
      }
    }
    return { accepted: false, reason }
  }
  if (isChatroomBlockedForInstance(record.id, matched.hit.roomId)
    || (record.accountWxid && isChatroomBlocked(record.accountWxid, matched.hit.roomId))
    || loadDirectoryExcludedRoomIdSetForInstance(record.id).has(String(matched.hit.roomId || ''))) {
    return { accepted: false, reason: 'BLOCKED_KICKED_ROOM' }
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
    safeBroadcast('chat-add:candidate', { instanceId: record.id, candidateId: saved.id, hit: matched.hit })
  }
  return saved
}


/**
 * 从本机通讯录缓存解析群昵称。
 * @param {string} instanceId
 * @param {string} roomId
 * @param {string} [fallback]
 */
function resolveKickRoomLabel(instanceId, roomId, fallback = '') {
  const raw = String(fallback || '').trim()
  if (raw && raw !== '群聊' && raw !== '未命名群聊') return raw
  try {
    const hit = listOwnedChatrooms(instanceId).find((row) => String(row.roomId || '') === String(roomId || ''))
    const name = String(hit?.name || '').trim()
    if (name) return name
  } catch { /* ignore */ }
  return raw || '未命名群聊'
}

/**
 * @param {string} evidence
 */
function kickEvidenceStatusLabel(evidence) {
  const value = String(evidence || '')
  if (value === 'SYSTEM_MSG_SELF_KICKED') return '已被踢（系统通知）'
  if (value === 'LEAVE_CALLBACK_SELF') return '疑似被踢（退群回调）'
  return '待确认被踢'
}

/**
 * 统一被踢清理日志文案：群昵称 + 被踢状态 + 退出结果。
 * @param {{ roomName?: string, evidence?: string, kickStatus?: string, result: string }} input
 */
function formatKickCleanupMessage(input) {
  const roomName = String(input.roomName || '未命名群聊').trim() || '未命名群聊'
  const kickStatus = String(input.kickStatus || kickEvidenceStatusLabel(input.evidence) || '待确认被踢').trim()
  const result = String(input.result || '').trim() || '-'
  return `群昵称：${roomName}｜被踢状态：${kickStatus}｜退出结果：${result}`
}

function notifyDirectoryBlockedChanged(instanceId, roomId, roomName, action = 'exclude') {
  safeBroadcast('directory:blocked-changed', {
    instanceId,
    roomId,
    roomName: roomName || '',
    action: action === 'restore' ? 'restore' : 'exclude',
  })
}

/**
 * 强证据被踢：立刻从本机目录摘掉并通知界面不要再加载。
 * @param {{ id: string }} record
 * @param {string} roomId
 * @param {string} [roomName]
 */
function hideKickedRoomFromDirectory(record, roomId, roomName = '') {
  const id = String(roomId || '').trim()
  if (!record?.id || !id.endsWith('@chatroom')) return
  try { removeLocalChatroomOwnership(record.id, id) } catch { /* ignore */ }
  notifyDirectoryBlockedChanged(record.id, id, roomName || '', 'exclude')
}

/**
 * 误判取消后：通知界面强制重拉该号通讯录，把群加回来。
 * @param {{ id: string }} record
 * @param {string} roomId
 * @param {string} [roomName]
 */
function restoreKickedRoomToDirectory(record, roomId, roomName = '') {
  const id = String(roomId || '').trim()
  if (!record?.id || !id.endsWith('@chatroom')) return
  notifyDirectoryBlockedChanged(record.id, id, roomName || '', 'restore')
}

/**
 * TCP 回调：系统消息「你被…移出群聊」或退群回调含本人 → 登记后走清理。
 * 别人退群 / 普通聊天复读一律忽略。退群回调还会再核验成员列表，防止误退。
 * @param {{ id: string, accountWxid?: string }} record
 * @param {unknown} event
 */
function handleKickedGroupEvent(record, event) {
  const hit = extractSelfKickedEvent(event, record.accountWxid || '')
  if (!hit) return
  const accountWxid = String(record.accountWxid || '').trim()
  if (accountWxid && isChatroomBlocked(accountWxid, hit.roomId)) return
  const roomName = resolveKickRoomLabel(record.id, hit.roomId, hit.roomName || '')
  hit.roomName = roomName
  upsertKickedGroupPending({
    instanceId: record.id,
    roomId: hit.roomId,
    accountWxid,
    roomName,
    evidence: hit.evidence,
    evidenceStrength: hit.strength,
  })
  // 仅系统踢人强证据立刻隐藏；退群回调等成员核验后再隐藏，避免误藏仍在群
  if (isImmediateKickEvidence(hit.evidence)) {
    hideKickedRoomFromDirectory(record, hit.roomId, roomName)
  }
  appLog('INFO', formatKickCleanupMessage({
    roomName,
    evidence: hit.evidence,
    result: '已登记待清理，请到「日志与设置」创建任务后在任务中心确认执行',
  }), {
    instanceId: record.id,
    module: '被踢群清理',
    operation: '登记',
    roomId: hit.roomId,
    roomName,
    evidence: hit.evidence,
    kickStatus: kickEvidenceStatusLabel(hit.evidence),
    result: '已登记待清理',
  })
}

/**
 * 判断取消通讯录/清会话类接口是否业务成功。
 * @param {boolean} httpOk
 * @param {unknown} raw
 */
function isContactRoomMutationOk(httpOk, raw) {
  if (!httpOk) return false
  if (raw == null || typeof raw !== 'object') return true
  const body = /** @type {Record<string, unknown>} */ (raw)
  const code = Number(body.errCode ?? body.code ?? body.ret ?? body?.baseResponse?.ret)
  if (Number.isFinite(code) && code !== 0 && code !== 1) return false
  const msg = String(body.errMsg ?? body.message ?? body.msg ?? '').toLowerCase()
  if (/fail|error|失败|无效|不存在/.test(msg) && !/成功|success/.test(msg)) return false
  return true
}

/**
 * 退群/取消通讯录请求体：Hook 字段名不统一，补齐别名避免「HTTP 成功但微信未生效」。
 * @param {string} roomId
 */
function buildKickRoomMutationBody(roomId) {
  const id = String(roomId || '').trim()
  return {
    roomId: id,
    room_id: id,
    chatroomId: id,
    chatRoomId: id,
    username: id,
    userName: id,
    wxid: id,
    chatroomUserName: id,
    chatRoomUserName: id,
  }
}

/**
 * 删除联系人/会话兜底请求体（群 ID 当作 wxid）。
 * @param {string} roomId
 */
function buildKickRoomDelContactBody(roomId) {
  const id = String(roomId || '').trim()
  return { wxid: id, username: id, userName: id, roomId: id, room_id: id }
}

/**
 * quit_and_del_chat_room 后仍调 del_contact：实测 quit 接口 HTTP 200 但群列表仍残留时，
 * del_contact 可补清通讯录/会话；delContactOk 亦作为 deleteOk 的兜底成功信号（见 kicked-group-cleanup 测试）。
 * 未核验到「已不在群列表」前，不把清理当作真正成功（避免本地屏蔽后界面消失、微信仍在）。
 * @param {{ id: string }} record
 * @param {string} roomId
 */
async function quitAndClearKickedRoomSession(record, roomId) {
  const body = buildKickRoomMutationBody(roomId)
  const unsave = await requestApi(record, '/api/remov_chatroom_to_contact', body, 20000)
  saveApiSample({
    instanceId: record.id, sourceId: 438557557, path: '/api/remov_chatroom_to_contact',
    request: body, response: unsave.raw, httpStatus: unsave.response.status, durationMs: 0,
  })
  const unsaveOk = isContactRoomMutationOk(unsave.response.ok, unsave.raw)
  invalidateInstanceApi(record.id, '/api/get_chatroom_list')

  const runQuitAndDel = async () => {
    const deleted = await requestApi(record, '/api/quit_and_del_chat_room', body, 20000)
    saveApiSample({
      instanceId: record.id, sourceId: 438557540, path: '/api/quit_and_del_chat_room',
      request: body, response: deleted.raw, httpStatus: deleted.response.status, durationMs: 0,
    })
    let deleteOk = isContactRoomMutationOk(deleted.response.ok, deleted.raw)

    const delBody = buildKickRoomDelContactBody(roomId)
    const delContact = await requestApi(record, '/api/del_contact', delBody, 20000)
    saveApiSample({
      instanceId: record.id, sourceId: 438557532, path: '/api/del_contact',
      request: delBody, response: delContact.raw, httpStatus: delContact.response.status, durationMs: 0,
    })
    const delContactOk = isContactRoomMutationOk(delContact.response.ok, delContact.raw)
    if (delContactOk) deleteOk = true
    return { deleted, deleteOk, delContact, delContactOk }
  }

  const { deleted, deleteOk, delContact, delContactOk } = await runQuitAndDel()

  /** @type {boolean|null} */
  let stillPresent = null
  const recheckPresence = async () => {
    try {
      const live = await loadLiveRoomIdsForKickGate(record)
      if (live == null) return null
      return live.has(roomId)
    } catch {
      return null
    }
  }

  const recheckDelays = [1500, 2500, 4000, 6000, 8000]
  for (const delay of recheckDelays) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    stillPresent = await recheckPresence()
    if (stillPresent === false) break
  }

  const verifiedGone = stillPresent === false
  const apiOk = unsaveOk && deleteOk
  const ok = verifiedGone || (apiOk && stillPresent !== true)
  return {
    unsaveStatus: unsaveOk ? 'DONE' : 'FAILED',
    deleteChatStatus: ok ? 'DONE' : 'FAILED',
    delContactOk,
    stillPresent,
    verifiedGone,
    ok,
    unsaveRaw: unsave.raw,
    deleteRaw: deleted.raw,
    delContactRaw: delContact.raw,
    deleteHttpStatus: deleted.response.status,
  }
}


/**
 * 从本机已落库事件 + 微信群聊历史系统消息中发现被踢群，登记为 PENDING。
 * @param {{ id: string, accountWxid?: string }} record
 * @returns {Promise<{ localHits: number, historyHits: number, roomsScanned: number }>}
 */
async function discoverKickedGroupsFromHistory(record) {
  const accountWxid = String(record.accountWxid || '').trim()
  let localHits = 0
  let historyHits = 0
  let roomsScanned = 0
  const seenRooms = new Set()

  const registerHit = (hit, source) => {
    if (!hit?.roomId || seenRooms.has(hit.roomId)) return false
    if (accountWxid && isChatroomBlocked(accountWxid, hit.roomId)) return false
    seenRooms.add(hit.roomId)
    const roomName = resolveKickRoomLabel(record.id, hit.roomId, hit.roomName || '')
    hit.roomName = roomName
    upsertKickedGroupPending({
      instanceId: record.id,
      roomId: hit.roomId,
      accountWxid,
      roomName,
      evidence: hit.evidence,
      evidenceStrength: hit.strength || 'strong',
    })
    if (isImmediateKickEvidence(hit.evidence)) {
      hideKickedRoomFromDirectory(record, hit.roomId, roomName)
    }
    appLog('INFO', formatKickCleanupMessage({
      roomName,
      evidence: hit.evidence,
      result: `历史扫描已登记（${source}）`,
    }), {
      instanceId: record.id,
      module: '被踢群清理',
      operation: '历史扫描',
      roomId: hit.roomId,
      roomName,
      evidence: hit.evidence,
      kickStatus: kickEvidenceStatusLabel(hit.evidence),
      result: `已登记（${source}）`,
    })
    return true
  }

  // 1) 本软件已落库的 TCP 回调/消息事件（按实例过滤，避免串号）
  try {
    const rows = listMessageEventsForKickScan({ instanceId: record.id, limit: 8000 })
    for (const row of rows) {
      let event
      try { event = JSON.parse(String(row.eventJson || '{}')) } catch { continue }
      const hit = extractSelfKickedEvent(event, accountWxid)
      if (hit && registerHit(hit, '本地事件')) localHits += 1
    }
  } catch (error) {
    appLog('WARN', '扫描本地消息事件失败', {
      instanceId: record.id, module: '被踢群清理', error: rawErrorMessage(error),
    })
  }

  // 2) 微信消息库：只看每个群「最近 10 条」里的系统通知（10000/10002），不扫用户发言
  const HISTORY_TAIL = 10
  try {
    const listRes = await readApi(record, '/api/get_chatroom_list', {})
    const detailRes = await readApi(record, '/api/get_all_room_detail', {})
    const roomMap = new Map()
    for (const row of [
      ...extractRoomsFromApiRaw(listRes.response.ok ? listRes.raw : null),
      ...extractRoomsFromApiRaw(detailRes.response.ok ? detailRes.raw : null),
    ]) {
      if (row.roomId) roomMap.set(row.roomId, row)
    }
    for (const row of listOwnedChatrooms(record.id)) {
      if (row.roomId && !roomMap.has(row.roomId)) {
        roomMap.set(row.roomId, { roomId: row.roomId, name: row.name || '', saved: row.saved })
      }
    }
    const rooms = [...roomMap.values()]
    // 优先扫仍在通讯录/会话里的群（被踢残留更常见）
    rooms.sort((a, b) => Number(b.saved || 0) - Number(a.saved || 0))

    const context = { databaseNames: null, tables: new Map() }
    const handleResult = await readApi(record, '/api/get_db_handle', {}, { timeout: 5000 })
    if (handleResult.response.ok) {
      context.databaseNames = rowsFromApi(handleResult.raw)
        .map((item) => String(item.name || ''))
        .filter((name) => /^message_\d+\.db$/i.test(name))
    }
    if (!context.databaseNames?.length) {
      return { localHits, historyHits, roomsScanned }
    }

    for (const room of rooms) {
      const roomId = String(room.roomId || '')
      if (!roomId.endsWith('@chatroom')) continue
      if (accountWxid && isChatroomBlocked(accountWxid, roomId)) continue
      roomsScanned += 1
      const expectedTable = messageTableName(roomId)
      let found = null
      for (const databaseName of context.databaseNames) {
        if (!context.tables.has(databaseName)) {
          const schemaResult = await requestApi(record, '/api/sqlite3_exec', {
            db_name: databaseName,
            sql_fmt: "SELECT name FROM sqlite_master WHERE type='table'",
          }, 8000)
          context.tables.set(
            databaseName,
            schemaResult.response.ok
              ? rowsFromApi(schemaResult.raw).map((row) => String(valueOf(row, ['name']) || '')).filter(Boolean)
              : [],
          )
          await yieldMain()
        }
        const table = context.tables.get(databaseName)
          .find((name) => name.toLowerCase() === expectedTable.toLowerCase())
        if (!table) continue
        const columnsResult = await requestApi(record, '/api/sqlite3_exec', {
          db_name: databaseName,
          sql_fmt: `PRAGMA table_info(${quoteSqlIdentifier(table)})`,
        }, 8000)
        await yieldMain()
        const columns = rowsFromApi(columnsResult.raw).map((row) => String(valueOf(row, ['name']) || '')).filter(Boolean)
        const typeColumn = columns.find((name) => ['local_type', 'type', 'message_type'].includes(name.toLowerCase()))
        const orderColumn = columns.find((name) => ['create_time', 'sort_seq', 'local_id'].includes(name.toLowerCase()))
        const contentColumn = columns.find((name) => ['message_content', 'content'].includes(name.toLowerCase()))
        if (!typeColumn || !contentColumn || !orderColumn) continue
        const selectCols = [contentColumn, typeColumn, orderColumn]
          .filter((name, index, arr) => arr.findIndex((item) => String(item).toLowerCase() === String(name).toLowerCase()) === index)
          .map((name) => quoteSqlIdentifier(name))
        // 最近 N 条会话消息（含用户发言），再在应用层只认系统通知类型
        const sql = `SELECT ${selectCols.join(', ')} FROM ${quoteSqlIdentifier(table)}`
          + ` ORDER BY ${quoteSqlIdentifier(orderColumn)} DESC`
          + ` LIMIT ${HISTORY_TAIL}`
        const messagesResult = await requestApi(record, '/api/sqlite3_exec', {
          db_name: databaseName, sql_fmt: sql,
        }, 20000)
        if (!messagesResult.response.ok) continue
        for (const rawRow of rowsFromApi(messagesResult.raw)) {
          const msgType = valueOf(rawRow, ['local_type', 'type', 'message_type'])
          const typeNum = Number(msgType)
          // 只处理系统通知，跳过普通用户发言等其它类型
          if (typeNum !== 10000 && typeNum !== 10002) continue
          const prepared = prepareHistoryMessageRow(rawRow)
          const hit = kickHitFromHistoryMessage(
            roomId,
            prepared.message_content || prepared._decodedBlob || '',
            typeNum,
          )
          if (hit) {
            hit.roomName = String(room.name || room.roomName || '')
            found = hit
            break
          }
        }
        if (found) break
      }
      if (found && registerHit(found, '群聊历史')) historyHits += 1
      if (roomsScanned % 8 === 0) await yieldMain()
    }
  } catch (error) {
    appLog('WARN', '扫描微信群聊历史失败', {
      instanceId: record.id, module: '被踢群清理', error: rawErrorMessage(error),
    })
  }

  return { localHits, historyHits, roomsScanned }
}


/**
 * 拉取当前实例可见群 ID（退群回调核验用）。
 * @param {{ id: string }} record
 * @returns {Promise<Set<string>>}
 */
async function loadLiveRoomIdsForKickGate(record) {
  try {
    const listRes = await readApi(record, '/api/get_chatroom_list', {})
    if (listRes?.response?.ok) {
      const ids = extractRoomsFromApiRaw(listRes.raw).map((row) => row.roomId).filter(Boolean)
      if (ids.length) return new Set(ids)
      return new Set()
    }
    const detailRes = await readApi(record, '/api/get_all_room_detail', {})
    if (detailRes?.response?.ok) {
      const ids = extractRoomsFromApiRaw(detailRes.raw).map((row) => row.roomId).filter(Boolean)
      if (ids.length) return new Set(ids)
      return new Set()
    }
  } catch (error) {
    appLog('WARN', '被踢群清理：拉取群列表失败', {
      instanceId: record.id, module: '被踢群清理', error: rawErrorMessage(error),
    })
  }
  return null
}

/**
 * 清理单个被踢群：取消通讯录 + 退出并清除会话 + 永久屏蔽。
 * @param {{ id: string, accountWxid?: string }} record
 * @param {Record<string, unknown>} row
 * @param {{ reason?: string, liveIds?: Set<string>, taskId?: string }} [opts]
 * @returns {Promise<{ outcome: 'COMPLETED'|'FAILED'|'SKIPPED', message: string, roomName: string, roomId: string, evidence: string, unsaveStatus?: string, deleteChatStatus?: string }>}
 */
async function cleanupOneKickedGroupRoom(record, row, opts = {}) {
  const reason = String(opts.reason || '任务执行')
  const taskId = opts.taskId ? String(opts.taskId) : ''
  const liveListUnavailable = opts.liveIds === null
  const liveIds = opts.liveIds instanceof Set ? opts.liveIds : new Set()
  const accountWxid = String(record.accountWxid || row.accountWxid || '').trim()
  const roomId = String(row.roomId || row.room_id || '').trim()
  const roomLabel = resolveKickRoomLabel(record.id, roomId, row.roomName || row.room_name || '')
  const evidence = String(row.evidence || '')
  const kickStatus = kickEvidenceStatusLabel(evidence)
  const immediateKick = isImmediateKickEvidence(evidence)
  const leaveCallback = isLeaveCallbackEvidence(evidence)
  const base = { roomName: roomLabel, roomId, evidence, kickStatus }

  const logKick = (level, result, extra = {}) => {
    const message = formatKickCleanupMessage({ roomName: roomLabel, kickStatus, evidence, result })
    appLog(level, message, {
      instanceId: record.id,
      module: '被踢群清理',
      operation: reason,
      taskId: taskId || undefined,
      roomName: roomLabel,
      roomId,
      evidence,
      kickStatus,
      result,
      ...extra,
    })
    return message
  }

  if (!roomId.endsWith('@chatroom')) {
    updateKickedGroupCleanup(record.id, roomId || String(row.roomId || ''), {
      status: 'CANCELLED',
      lastError: 'INVALID_ROOM_ID',
    })
    const message = logKick('WARN', '已跳过：群标识无效')
    return { ...base, outcome: 'SKIPPED', message }
  }

  if (accountWxid && isChatroomBlocked(accountWxid, roomId)) {
    // 已屏蔽后若被重新拉回群，必须先核验本人是否仍在群，避免误退
    let selfStillInMembers = null
    try {
      const mem = await readApi(record, '/api/get_room_members', { room_id: roomId }, { timeout: 15000 })
      selfStillInMembers = resolveSelfStillInMembers(mem.raw, accountWxid, {
        httpOk: Boolean(mem.response?.ok),
        strongEvidence: true,
      })
      if (selfStillInMembers === null) {
        try {
          const bySql = await readApi(record, '/api/get_groupmember_bysql', {
            roomId, room_id: roomId,
          }, { timeout: 15000 })
          const sqlHit = resolveSelfStillInMembers(bySql.raw, accountWxid, {
            httpOk: Boolean(bySql.response?.ok),
            strongEvidence: true,
          })
          if (sqlHit !== null) selfStillInMembers = sqlHit
        } catch { /* ignore */ }
      }
    } catch { /* keep null */ }
    if (selfStillInMembers === true) {
      updateKickedGroupCleanup(record.id, roomId, {
        status: 'CANCELLED',
        lastError: 'REINVITED_SELF_STILL_MEMBER',
      })
      restoreKickedRoomToDirectory(record, roomId, roomLabel)
      const message = logKick('WARN', '已跳过：疑似重新入群，成员列表仍含本人，未退出')
      return { ...base, outcome: 'SKIPPED', message }
    }
    // 成员核验不确定时绝不继续退群（可能已重新入群）
    if (selfStillInMembers !== false) {
      updateKickedGroupCleanup(record.id, roomId, { lastError: 'BLOCKED_MEMBER_CHECK_INCONCLUSIVE' })
      const message = logKick('WARN', '退出失败：已屏蔽群成员核验不确定，暂未退出')
      return { ...base, outcome: 'FAILED', message }
    }

    let unsaveStatus = String(row.unsaveStatus || row.unsave_status || 'PENDING')
    let deleteChatStatus = String(row.deleteChatStatus || row.delete_chat_status || 'PENDING')
    // 已屏蔽群也一律重跑退群：此前可能 HTTP 假成功，微信会话仍在
    if (taskId && isTaskStopRequested(taskId)) {
      const message = logKick('WARN', '已暂停：清理已取消')
      return { ...base, outcome: 'SKIPPED', message }
    }
    {
      const cleared = await quitAndClearKickedRoomSession(record, roomId)
      unsaveStatus = cleared.unsaveStatus
      deleteChatStatus = cleared.deleteChatStatus
      if (!cleared.ok) {
        updateKickedGroupCleanup(record.id, roomId, {
          unsaveStatus,
          deleteChatStatus,
          status: 'PENDING',
          lastError: cleared.stillPresent === true
            ? 'QUIT_STILL_IN_ROOM_LIST'
            : `RETRY_${unsaveStatus}_${deleteChatStatus}`,
          roomName: roomLabel,
        })
        const detail = cleared.stillPresent === true
          ? '退出失败：接口已调用但微信群列表仍残留该群'
          : `退出失败：清理未完成（通讯录${unsaveStatus}，会话${deleteChatStatus}）`
        const message = logKick('WARN', detail, {
          unsaveStatus, deleteChatStatus, stillPresent: cleared.stillPresent,
          deleteHttpStatus: cleared.deleteHttpStatus,
        })
        return { ...base, outcome: 'FAILED', message, unsaveStatus, deleteChatStatus }
      }
    }
    removeLocalChatroomOwnership(record.id, roomId)
    updateKickedGroupCleanup(record.id, roomId, {
      unsaveStatus: 'DONE',
      deleteChatStatus: 'DONE',
      status: 'DONE',
      lastError: null,
      roomName: roomLabel,
    })
    notifyDirectoryBlockedChanged(record.id, roomId, roomLabel)
    const message = logKick('INFO', '退出成功：已取消通讯录并清除会话', { unsaveStatus: 'DONE', deleteChatStatus: 'DONE' })
    return { ...base, outcome: 'COMPLETED', message, unsaveStatus: 'DONE', deleteChatStatus: 'DONE' }
  }

  let selfStillInMembers = null
  let confirmCount = Math.max(Number(row.confirmCount || row.confirm_count) || 0, 0)
  if (!immediateKick) {
    if (leaveCallback && !accountWxid) {
      updateKickedGroupCleanup(record.id, roomId, { lastError: 'MISSING_ACCOUNT_WXID' })
      const message = logKick('WARN', '退出失败：缺少本机微信号，无法核验')
      return { ...base, outcome: 'FAILED', message }
    }
    if (liveListUnavailable) {
      updateKickedGroupCleanup(record.id, roomId, { lastError: 'LIVE_LIST_UNAVAILABLE' })
      const message = logKick('WARN', '退出失败：群列表暂时不可用，暂未清理')
      return { ...base, outcome: 'FAILED', message }
    }
    if (!liveIds.size && !leaveCallback) {
      updateKickedGroupCleanup(record.id, roomId, { lastError: 'LIVE_LIST_EMPTY' })
      const message = logKick('WARN', '退出失败：群列表为空，暂未清理')
      return { ...base, outcome: 'FAILED', message }
    }
    const strongEvidence = leaveCallback
      || String(row.evidenceStrength || row.evidence_strength || 'strong') === 'strong'
      || evidence.includes('SELF')
    try {
      const mem = await readApi(record, '/api/get_room_members', { room_id: roomId }, { timeout: 15000 })
      selfStillInMembers = resolveSelfStillInMembers(mem.raw, accountWxid, {
        httpOk: Boolean(mem.response?.ok),
        strongEvidence,
      })
      if (selfStillInMembers === null) {
        try {
          const bySql = await readApi(record, '/api/get_groupmember_bysql', {
            roomId, room_id: roomId,
          }, { timeout: 15000 })
          const sqlHit = resolveSelfStillInMembers(bySql.raw, accountWxid, {
            httpOk: Boolean(bySql.response?.ok),
            strongEvidence,
          })
          if (sqlHit !== null) selfStillInMembers = sqlHit
        } catch { /* ignore */ }
      }
    } catch { /* keep null */ }

    if (selfStillInMembers === true) {
      updateKickedGroupCleanup(record.id, roomId, {
        confirmCount: 0,
        status: 'CANCELLED',
        lastError: 'SELF_STILL_MEMBER_ABORT',
      })
      restoreKickedRoomToDirectory(record, roomId, roomLabel)
      const message = logKick('WARN', '已跳过：成员列表仍含本人，未退出以免误退')
      return { ...base, outcome: 'SKIPPED', message }
    }
    if (selfStillInMembers !== false) {
      updateKickedGroupCleanup(record.id, roomId, { lastError: 'MEMBER_CHECK_INCONCLUSIVE' })
      const message = logKick('WARN', '退出失败：成员核验不确定，暂未退出')
      return { ...base, outcome: 'FAILED', message }
    }
    confirmCount += 1
    updateKickedGroupCleanup(record.id, roomId, {
      confirmCount,
      lastAbsentAt: new Date().toISOString(),
      lastError: null,
      roomName: roomLabel,
    })
    // 退群回调已核验本人不在群：此时再隐藏，避免未确认前误藏
    hideKickedRoomFromDirectory(record, roomId, roomLabel)
  } else {
    confirmCount = Math.max(confirmCount, 1)
    updateKickedGroupCleanup(record.id, roomId, {
      confirmCount,
      lastAbsentAt: new Date().toISOString(),
      lastError: null,
      roomName: roomLabel,
    })
  }

  const decision = canCleanupKickedRoom({
    instanceId: record.id,
    roomId,
    owned: immediateKick || Boolean(accountWxid),
    inLiveRoomList: liveIds.has(roomId),
    liveRoomCount: liveIds.size || (immediateKick ? 1 : 0),
    selfStillInMembers: immediateKick ? false : selfStillInMembers,
    confirmCount,
    evidenceStrength: row.evidenceStrength || row.evidence_strength || 'strong',
    evidence,
  })
  if (!decision.ok) {
    updateKickedGroupCleanup(record.id, roomId, { lastError: String(decision.reason || 'NOT_READY') })
    const message = logKick('WARN', `退出失败：未满足清理条件（${decision.reason || 'NOT_READY'}）`)
    return { ...base, outcome: 'FAILED', message }
  }

  let unsaveStatus = String(row.unsaveStatus || row.unsave_status || 'PENDING')
  let deleteChatStatus = String(row.deleteChatStatus || row.delete_chat_status || 'PENDING')
  if (unsaveStatus !== 'DONE' || deleteChatStatus !== 'DONE') {
    if (taskId && isTaskStopRequested(taskId)) {
      const message = logKick('WARN', '已暂停：清理已取消')
      return { ...base, outcome: 'SKIPPED', message }
    }
    const cleared = await quitAndClearKickedRoomSession(record, roomId)
    unsaveStatus = cleared.unsaveStatus
    deleteChatStatus = cleared.deleteChatStatus
    if (cleared.unsaveStatus === 'DONE') logKick('INFO', '取消通讯录成功')
    else logKick('WARN', '取消通讯录失败', { status: cleared.deleteHttpStatus })
    if (cleared.ok) logKick('INFO', '退出并清除会话成功', {
      delContactOk: cleared.delContactOk, verifiedGone: cleared.verifiedGone, stillPresent: cleared.stillPresent,
    })
    else {
      updateKickedGroupCleanup(record.id, roomId, {
        unsaveStatus,
        deleteChatStatus,
        lastError: cleared.stillPresent === true
          ? 'QUIT_STILL_IN_ROOM_LIST'
          : `DELETE_CHAT_FAILED_${cleared.deleteHttpStatus || 'UNKNOWN'}`,
      })
      const detail = cleared.stillPresent === true
        ? '退出/清除会话失败：微信群列表仍残留该群'
        : '退出/清除会话失败'
      logKick('WARN', detail, {
        status: cleared.deleteHttpStatus,
        stillPresent: cleared.stillPresent,
        delContactOk: cleared.delContactOk,
      })
    }
  }

  const fullyCleaned = unsaveStatus === 'DONE' && deleteChatStatus === 'DONE'
  if (!fullyCleaned) {
    updateKickedGroupCleanup(record.id, roomId, {
      unsaveStatus,
      deleteChatStatus,
      status: 'PENDING',
      lastError: `PARTIAL_${unsaveStatus}_${deleteChatStatus}`,
    })
    const message = logKick('WARN', `退出失败：清理未完成（通讯录${unsaveStatus}，会话${deleteChatStatus}）`, { unsaveStatus, deleteChatStatus })
    return { ...base, outcome: 'FAILED', message, unsaveStatus, deleteChatStatus }
  }

  if (accountWxid) {
    markChatroomBlocked({
      accountWxid,
      roomId,
      roomName: roomLabel,
      reason: 'KICKED',
      evidence: evidence || '',
      sourceInstanceId: record.id,
    })
  }
  removeLocalChatroomOwnership(record.id, roomId)
  updateKickedGroupCleanup(record.id, roomId, {
    unsaveStatus,
    deleteChatStatus,
    status: 'DONE',
    lastError: null,
    roomName: roomLabel,
  })
  const message = logKick('INFO', '退出成功：已取消通讯录并清除会话，并永久屏蔽', {
    unsaveStatus, deleteChatStatus,
  })
  notifyDirectoryBlockedChanged(record.id, roomId, roomLabel)
  return { ...base, outcome: 'COMPLETED', message, unsaveStatus, deleteChatStatus }
}

/**
 * 扫描历史被踢 → 登记 PENDING → 创建「清理被踢群」任务（不自动执行）。
 * @param {string} [reason]
 * @param {{ instanceId?: string }} [options] 指定 instanceId 时只处理该微信；留空则处理全部在线微信
 */
async function prepareKickedGroupCleanupTask(reason = '手动创建被踢群清理任务', options = {}) {
  if (kickedGroupCleanupPreparing) {
    return { ok: false, queued: true, message: '正在扫描并创建任务，请稍候' }
  }
  kickedGroupCleanupPreparing = true
  let reboundTotal = 0
  let pendingTotal = 0
  let onlineCount = 0
  let historyDiscoveredTotal = 0
  try {
    const wantedId = String(options.instanceId || '').trim()
    const onlineAll = [...instances.values()].filter((item) => item.status === 'ONLINE')
    const online = wantedId
      ? onlineAll.filter((item) => item.id === wantedId)
      : onlineAll
    onlineCount = online.length
    if (wantedId && !onlineCount) {
      const exists = instances.get(wantedId)
      return {
        ok: false,
        online: 0,
        pending: 0,
        historyDiscovered: 0,
        instanceId: wantedId,
        message: exists
          ? `所选微信当前未在线（${exists.nickname || exists.accountWxid || '微信'}），请先登录后再清理`
          : '所选微信不存在，请刷新后重选',
      }
    }
    if (!onlineCount) {
      return { ok: false, online: 0, pending: 0, historyDiscovered: 0, message: '没有在线微信，无法创建清理任务' }
    }
    /** @type {Array<{ instanceId: string, targetKey: string, actionType: string, request: Record<string, unknown> }>} */
    const items = []
    const activeKeys = new Set(
      listActiveKickedCleanupTargets().map((row) => `${row.instanceId}::${row.roomId}`),
    )
    let skippedActive = 0
    for (const record of online) {
      const accountWxid = String(record.accountWxid || '').trim()
      if (accountWxid) {
        try {
          reboundTotal += Number(rebindKickedGroupPendingToInstance(record.id, accountWxid) || 0)
        } catch (error) {
          appLog('WARN', '被踢群待清理任务迁回当前实例失败', {
            instanceId: record.id, module: '被踢群清理', operation: reason, error: rawErrorMessage(error),
          })
        }
      }
      try {
        const discovered = await discoverKickedGroupsFromHistory(record)
        const localHits = Number(discovered.localHits || 0)
        const historyHits = Number(discovered.historyHits || 0)
        historyDiscoveredTotal += localHits + historyHits
        if (localHits || historyHits) {
          appLog('INFO', `历史扫描登记被踢群：本地事件${localHits}，群聊历史${historyHits}，已扫群${discovered.roomsScanned || 0}`, {
            instanceId: record.id, module: '被踢群清理', operation: reason,
            localHits, historyHits, roomsScanned: discovered.roomsScanned || 0,
          })
        }
      } catch (error) {
        appLog('WARN', '被踢群历史扫描失败', {
          instanceId: record.id, module: '被踢群清理', operation: reason, error: rawErrorMessage(error),
        })
      }
      // 假成功残留：本地已屏蔽/已完成，但微信群列表仍有该群 → 重新入队
      try {
        const liveIds = await loadLiveRoomIdsForKickGate(record)
        if (!(liveIds instanceof Set)) {
          appLog('WARN', '被踢群残留复检跳过：群列表暂时不可用', {
            instanceId: record.id, module: '被踢群清理', operation: reason,
          })
        } else {
        const blockedIds = accountWxid ? loadBlockedRoomIdSet(accountWxid) : new Set()
        let residual = 0
        for (const roomId of liveIds) {
          if (!roomId.endsWith('@chatroom')) continue
          const existing = getKickedGroupCleanup(record.id, roomId)
          const wasDoneOrBlocked = (existing && ['DONE', 'CANCELLED'].includes(String(existing.status || '')))
            || blockedIds.has(roomId)
          if (!wasDoneOrBlocked) continue
          const roomName = resolveKickRoomLabel(record.id, roomId, existing?.roomName || '')
          upsertKickedGroupPending({
            instanceId: record.id,
            roomId,
            accountWxid,
            roomName,
            evidence: String(existing?.evidence || 'SYSTEM_MSG_SELF_KICKED'),
            evidenceStrength: String(existing?.evidenceStrength || 'strong'),
          })
          updateKickedGroupCleanup(record.id, roomId, {
            status: 'PENDING',
            unsaveStatus: 'PENDING',
            deleteChatStatus: 'PENDING',
            lastError: 'REQUEUE_STILL_IN_ROOM_LIST',
            roomName,
          })
          hideKickedRoomFromDirectory(record, roomId, roomName)
          residual += 1
        }
        if (residual) {
          historyDiscoveredTotal += residual
          appLog('INFO', `发现 ${residual} 个已清理但仍在微信群列表的残留群，已重新入队`, {
            instanceId: record.id, module: '被踢群清理', operation: reason, residual,
          })
        }
        }
      } catch (error) {
        appLog('WARN', '扫描被踢残留群列表失败', {
          instanceId: record.id, module: '被踢群清理', operation: reason, error: rawErrorMessage(error),
        })
      }
      const pendingAfter = listKickedGroupPending({ instanceId: record.id, status: 'PENDING' })
      for (const row of pendingAfter) {
        const roomId = String(row.roomId || '').trim()
        if (!roomId.endsWith('@chatroom')) continue
        if (activeKeys.has(`${record.id}::${roomId}`)) { skippedActive += 1; continue }
        const roomName = resolveKickRoomLabel(record.id, roomId, row.roomName || '')
        if (roomName && roomName !== String(row.roomName || '').trim()) {
          try { updateKickedGroupCleanup(record.id, roomId, { roomName }) } catch { /* ignore */ }
        }
        items.push({
          instanceId: record.id,
          // 多账号同群时 target_key 不能只靠 roomId，避免 UNIQUE 冲突
          targetKey: `${record.id}::${roomId}`,
          actionType: 'KICKED_GROUP_CLEANUP',
          request: {
            roomId,
            roomName,
            evidence: String(row.evidence || ''),
            evidenceStrength: String(row.evidenceStrength || 'strong'),
            accountWxid: String(row.accountWxid || accountWxid || ''),
            unsaveStatus: String(row.unsaveStatus || 'PENDING'),
            deleteChatStatus: String(row.deleteChatStatus || 'PENDING'),
            confirmCount: Number(row.confirmCount) || 0,
          },
        })
        activeKeys.add(`${record.id}::${roomId}`)
      }
    }
    pendingTotal = items.length
    if (!pendingTotal) {
      const message = skippedActive
        ? `有 ${skippedActive} 个群已在任务中心排队/执行中，未重复创建`
        : (historyDiscoveredTotal
          ? `历史扫描发现 ${historyDiscoveredTotal} 条，但当前没有可清理的待处理项`
          : '当前没有待清理的被踢群')
      appLog('INFO', `被踢群清理任务未创建：${message}`, {
        module: '被踢群清理', operation: reason, online: onlineCount, rebound: reboundTotal,
        historyDiscovered: historyDiscoveredTotal, skippedActive,
      })
      return {
        ok: true, online: onlineCount, rebound: reboundTotal, pending: 0, skippedActive,
        historyDiscovered: historyDiscoveredTotal, message,
      }
    }
    const created = createLocalTask({
      name: wantedId
        ? `清理被踢群（${String(online[0]?.nickname || online[0]?.accountWxid || '指定微信').trim()}） ${new Date().toLocaleString()}`
        : `清理被踢群 ${new Date().toLocaleString()}`,
      type: 'KICKED_GROUP_CLEANUP',
      config: wantedId ? { instanceId: wantedId } : {},
      items,
    })
    const taskId = String(created?.id || '')
    appLog('INFO', `已创建被踢群清理任务：${pendingTotal} 个群（历史发现${historyDiscoveredTotal}，迁回${reboundTotal}${wantedId ? '，指定微信' : ''}）`, {
      module: '被踢群清理', operation: reason, taskId, online: onlineCount, instanceId: wantedId || undefined,
      rebound: reboundTotal, pending: pendingTotal, historyDiscovered: historyDiscoveredTotal,
    })
    return {
      ok: true,
      taskId,
      online: onlineCount,
      instanceId: wantedId || '',
      rebound: reboundTotal,
      pending: pendingTotal,
      historyDiscovered: historyDiscoveredTotal,
      message: `已创建清理任务：${pendingTotal} 个群（历史扫描发现 ${historyDiscoveredTotal}${wantedId ? '，仅所选微信' : ''}）。请到任务中心确认执行。`,
    }
  } catch (error) {
    const message = toUserErrorMessage(error, '创建被踢群清理任务失败')
    appLog('ERROR', message, {
      module: '被踢群清理', operation: reason, error: rawErrorMessage(error),
    })
    throw new Error(message)
  } finally {
    kickedGroupCleanupPreparing = false
  }
}

/**
 * 解析监控配置中的目标群：严格匹配 instanceId+roomId。
 * @param {{ id: string }} record 当前微信实例
 * @param {unknown} event TCP 回调事件
 * @param {{ allowDeep?: boolean }} [options]
 * @returns {{ instanceId: string, roomId: string, name: string } | null}
 */
function resolveQrMonitorRoom(record, event, options = {}) {
  if (!qrMonitorRoomByKey.size) return null
  for (const roomId of extractEventRoomIds(event)) {
    const hit = qrMonitorRoomByKey.get(monitorRoomKey(record.id, roomId))
    if (hit) return hit
  }
  if (options.allowDeep === false) return null
  return findMonitoredRoomDeep(record, event)
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
    safeBroadcast('qr:monitor-result', { roomName: room.name, ...result })
  }
}

async function handleQrMonitorEvent(record, event) {
  if (!qrMonitorConfig.enabled) return
  // 先用字段 O(1) 匹配；普通文字绝不深遍历，150+ 群时避免拖死主进程
  let room = resolveQrMonitorRoom(record, event, { allowDeep: false })
  if (room && isChatroomBlockedForInstance(record.id, room.roomId)) return
  const type = Number(valueOf(event, ['type', 'local_type', 'message_type', 'msgType']))
  const maybeImage = looksLikeImageEvent(event)
  if (!room) {
    // watchAll：未在列表中的群有图片时，自动纳入监控再下载
    if (qrMonitorConfig.watchAll && maybeImage) {
      const roomIds = extractEventRoomIds(event)
      const roomId = roomIds.find((id) => String(id).endsWith('@chatroom'))
      if (roomId) {
        addQrMonitorRooms([{
          instanceId: record.id,
          accountWxid: String(record.accountWxid || ''),
          roomId,
          name: '群聊',
        }], { reason: '新群图片自动纳入' })
        room = qrMonitorRoomByKey.get(monitorRoomKey(record.id, roomId)) || null
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
            watchedCount: qrMonitorRoomByKey.size,
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
  // 事件级去重：同一 instanceId + roomId + messageId 不重复入队
  const msgId = String(valueOf(event, ['server_id', 'local_id', 'msgId', 'clientMsgId', 'newMsgId']) || '').trim()
  if (msgId) {
    const dedupKey = `${record.id}|${room.roomId}|${msgId}`
    const lastEnqueue = qrMonitorRecentEvents.get(dedupKey) || 0
    if (lastEnqueue) {
      if (Date.now() - lastEnqueue >= QR_MONITOR_EVENT_DEDUP_TTL_MS) {
        qrMonitorRecentEvents.delete(dedupKey)
      } else {
        return
      }
    }
    qrMonitorRecentEvents.set(dedupKey, Date.now())
  }
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
        safeBroadcast('wechat:event', eventPayload)
        void handleQrMonitorEvent(record, event)
        try { handleChatAddFriendEvent(record, event) } catch (error) { appLog('ERROR', '群聊发言加好友处理失败', { instanceId: record.id, error: error.message }) }
        try { handleKickedGroupEvent(record, event) } catch (error) { appLog('ERROR', '被踢群检测失败', { instanceId: record.id, error: error.message }) }
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

function readApi(record, apiPath, body, options = {}) {
  return requestWechatRead(record, apiPath, body, { ...options, requestApiFn: requestApi })
}

async function probeInstance(record) {
  if (!record || record.stopping) return false
  if (instances.get(record.id) !== record) return false
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
    if (loggedIn && (record.requireIdentityVerification || !wasOnline || !record.accountWxid || !record.nickname || record.alias == null)) {
      const profile = await readApi(record, '/api/get_profile_cache', {}, { timeout: 5000 })
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
      record.alias = text(info.alias) || ''
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
      try { rebindQrMonitorRoomsForInstance(record) } catch { /* rebind 失败不阻断探测 */ }
      try {
        for (const old of [...instances.values()]) {
          if (old.id === record.id) continue
          if (old.status !== 'STOPPED') continue
          if (String(old.accountWxid || '') !== String(record.accountWxid || '')) continue
          try { migrateDirectorySnapshotToInstance(old.id, record.id) } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
      try {
        const onlineIds = [...instances.values()].filter((x) => x.status === 'ONLINE').map((x) => x.id)
        rebindChatAddCandidatesForAccount(record.accountWxid, record.id, onlineIds)
      } catch { /* ignore */ }
      try { pruneStoppedRuntimeForAccount(record) } catch { /* prune 失败不阻断 */ }
    }
    const nextInterval = loggedIn ? 10000 : 2000
    if (record.probeIntervalMs !== nextInterval) startProbeLoop(record, nextInterval)
    upsertInstance({ ...record, pid: record.child?.pid ?? record.pid })
    return true
  } catch (error) {
    if (instances.get(record.id) !== record) return false
    record.probeFailures = (record.probeFailures || 0) + 1
    if (record.status !== 'STOPPED' && record.probeFailures >= 3) record.status = 'ERROR'
    record.error = record.probeFailures >= 3 ? toUserErrorMessage(error, '检测微信状态失败') : undefined
    if (record.probeFailures >= 3) appLog('ERROR', '检测微信状态失败', { instanceId: record.id, error: rawErrorMessage(error) })
    upsertInstance({ ...record, pid: record.child?.pid ?? record.pid })
    return false
  }
}

const runningTasks = new Set()
/**
 * 任务是否已暂停/取消（执行循环与进群长流程中途都要查）。
 * @param {string} taskId
 * @returns {boolean}
 */
function isTaskStopRequested(taskId) {
  const task = listTasks().find((item) => item.id === taskId)
  return !task || ['PAUSED', 'CANCELLED'].includes(String(task.status || ''))
}

/**
 * 暂停/取消后阻止尚未提交的 Mutation；返回 true 表示已拦截。
 * @param {string} taskId
 * @param {string} itemId
 * @returns {boolean}
 */
function blockMutationForTaskStop(taskId, itemId) {
  if (!taskId || !isTaskStopRequested(taskId)) return false
  const task = listTasks().find((item) => item.id === taskId)
  const cancelled = String(task?.status || '') === 'CANCELLED'
  setTaskItemResult(itemId, cancelled ? 'CANCELLED' : 'PAUSED', null, cancelled ? '任务已取消' : '任务已暂停')
  return true
}
/**
 * 等待到指定时间；暂停/取消时返回 false。
 * earlyContinueStatuses：冷却等待中若用户点「继续」把状态改成这些值，则立刻返回 true 继续执行。
 */
async function waitForTaskTime(taskId, timestamp, options = {}) {
  const earlyContinueStatuses = Array.isArray(options.earlyContinueStatuses)
    ? options.earlyContinueStatuses.map((item) => String(item || ''))
    : []
  while (Date.now() < timestamp) {
    if (!runtimeAllowed) return false
    if (isTaskStopRequested(taskId)) return false
    const task = listTasks().find((item) => item.id === taskId)
    if (earlyContinueStatuses.length && task && earlyContinueStatuses.includes(String(task.status || ''))) return true
    await new Promise((resolve) => setTimeout(resolve, Math.min(timestamp - Date.now(), 1000)))
  }
  return true
}
function deliveryContentHash(actionType, request) {
  if (actionType === 'SEND_IMAGE') {
    const file = String(request?.filepath || '')
    if (file && existsSync(file)) {
      const cacheKey = `${actionType}\0${file}`
      try {
        const st = statSync(file)
        const cached = deliveryImageHashCache.get(cacheKey)
        if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
          cached.usedAt = Date.now()
          return cached.digest
        }
        const digest = createHash('sha256').update(`${actionType}\0`).update(readFileSync(file)).digest('hex')
        deliveryImageHashCache.set(cacheKey, { digest, size: st.size, mtimeMs: st.mtimeMs, usedAt: Date.now() })
        cleanupRuntimeTtlMaps()
        return digest
      } catch {
        /* fall through to hash without cache */
      }
    }
  }
  const hash = createHash('sha256').update(`${actionType}\0`)
  if (actionType === 'SEND_TEXT') hash.update(String(request?.msg || ''))
  else if (actionType === 'SEND_IMAGE') hash.update(String(request?.filepath || ''))
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
async function fetchInvitePreviewCached(record, url) {
  const sourceUrl = String(url || '').trim()
  if (!sourceUrl) return fetchInvitePreviewReal(record, url)
  const key = `${record.id}|${normalizeQrText(sourceUrl)}`
  const cached = qrInvitePreviewCache.get(key)
  if (cached) {
    if (Date.now() >= cached.expiresAt) {
      qrInvitePreviewCache.delete(key)
    } else {
      return { ...cached.preview }
    }
  }
  const existing = qrInvitePreviewInflight.get(key)
  if (existing) return existing.promise
  const promise = fetchInvitePreviewReal(record, url).then((result) => {
    qrInvitePreviewInflight.delete(key)
    if (result && !result.error) {
      qrInvitePreviewCache.set(key, { preview: { ...result }, expiresAt: Date.now() + QR_INVITE_PREVIEW_TTL_MS })
    }
    return result
  }).catch((err) => {
    qrInvitePreviewInflight.delete(key)
    throw err
  })
  qrInvitePreviewInflight.set(key, { promise, createdAt: Date.now() })
  return promise
}

async function fetchInvitePreviewReal(record, url) {
  const sourceUrl = String(url || '').trim()
  if (!sourceUrl) return { roomId: '', roomName: '', memberCount: 0, fullUrl: '', expired: false, label: '空链接', error: '链接为空' }
  try {
    // 短链 / 完整邀请链在不同 urlType、scene 下返回差异大；优先能扩成 addchatroomby* 的组合
    const paramSets = [
      { url: sourceUrl, urlType: '1', scene: '4' },
      { url: sourceUrl, urlType: '2', scene: '4' },
      { url: sourceUrl, urlType: '0', scene: '4' },
      { url: sourceUrl, urlType: '0', scene: '0' },
      { url: sourceUrl, urlType: '1', scene: '0' },
      { url: sourceUrl, urlType: '2', scene: '0' },
    ]
    let response = null
    let raw = null
    let preview = { roomId: '', roomName: '', memberCount: 0, fullUrl: sourceUrl, expired: false }
    let bestScore = -1
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
      const currentScore = scoreInvitePreviewCandidate(currentPreview, currentRaw)
      // 合并多轮非空字段，避免后一轮空响应覆盖前一轮群标识
      preview = mergeInvitePreview(preview, currentPreview)
      if (currentScore > bestScore) {
        bestScore = currentScore
        response = currentResponse
        raw = currentRaw
      } else if (!raw) {
        response = currentResponse
        raw = currentRaw
      }
      // 过期立即停；已有 roomId +（群名或完整链）也可提前结束
      if (currentPreview.expired) {
        preview = mergeInvitePreview(preview, currentPreview)
        raw = currentRaw
        response = currentResponse
        break
      }
      if (
        String(preview.roomId || '').endsWith('@chatroom')
        && (usableQrRoomName(preview.roomName) || isExpandedInviteUrl(preview.fullUrl))
      ) break
    }

    // get_a8key 多数只返回 FullURL/HttpHeader，需再抓邀请页才能拿到群名/人数
    if (!preview.expired && (!preview.roomName || !preview.memberCount || !preview.roomId)) {
      const pageReq = buildInvitePageRequest(raw, sourceUrl)
      const urlsToFetch = []
      if (pageReq.url) urlsToFetch.push(pageReq.url)
      if (sourceUrl && sourceUrl !== pageReq.url) urlsToFetch.push(sourceUrl)
      if (preview.fullUrl && preview.fullUrl !== pageReq.url && preview.fullUrl !== sourceUrl) {
        urlsToFetch.push(preview.fullUrl)
      }
      let sawDownloadGate = false
      for (const pageUrl of urlsToFetch) {
        if (preview.roomName && preview.memberCount && preview.roomId) break
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
        const roomFromUrl = findRoomIdInUrl(pageUrl)
        if (roomFromUrl && !preview.roomId) preview.roomId = roomFromUrl
      }
      if (!hasUsableInvitePreview(preview) && sawDownloadGate && !pageReq.headers.Cookie && !pageReq.headers.cookie) {
        preview = { ...preview, notice: '暂时无法读取群名和人数（邀请页需微信登录态），执行任务时仍会尝试进群' }
      } else if (!hasUsableInvitePreview(preview) && sawDownloadGate) {
        preview = { ...preview, notice: '暂时无法读取群名和人数，执行任务时仍会尝试进群' }
      }
    }

    if (!preview.roomId) {
      const roomFromUrl = findRoomIdInUrl(preview.fullUrl) || findRoomIdInUrl(sourceUrl)
      if (roomFromUrl) preview.roomId = roomFromUrl
    }

    const label = formatInvitePreviewLine(preview)
    if (preview.expired) return { ...preview, label, error: '邀请已过期或无效' }
    if (response && !response.ok && !hasUsableInvitePreview(preview) && !preview.fullUrl) {
      return { ...preview, label, error: '无法解析群资料，请确认链接有效且微信在线' }
    }
    if (!hasUsableInvitePreview(preview) && preview.fullUrl && !preview.error) {
      const shortOnly = isShortGroupInviteUrl(preview.fullUrl) && !isExpandedInviteUrl(preview.fullUrl)
      return {
        ...preview,
        label,
        notice: preview.notice
          || (shortOnly
            ? '短链未能解析出群标识/完整邀请链，执行期将继续尝试进群并核验群列表'
            : '暂时无法读取群名和人数，执行任务时仍会尝试进群'),
      }
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
    const { response, raw } = await readApi(record, '/api/get_chatroom_list', {})
    if (!response.ok) return new Set()
    return new Set(extractRoomsFromApiRaw(raw).map((room) => room.roomId).filter(Boolean))
  } catch {
    return new Set()
  }
}

/**
 * 读取群列表（含成功标记）；接口失败时 ok=false，避免当成「空通讯录」误进群。
 * 默认只用 get_chatroom_list，避免每条进群都打 get_all_room_detail 狂刷接口。
 * @param {{ id: string }} record
 * @param {{ includeDetail?: boolean }} [options]
 * @returns {Promise<{ ok: boolean, rooms: Array<{ roomId: string, name: string }>, ids: Set<string> }>}
 */
async function readWechatRoomListState(record, options = {}) {
  try {
    const listRes = await readApi(record, '/api/get_chatroom_list', {}, { force: Boolean(options.force) })
    if (!listRes?.response?.ok) return { ok: false, rooms: [], ids: new Set() }
    const map = new Map()
    for (const room of extractRoomsFromApiRaw(listRes.raw)) {
      const roomId = String(room.roomId || '').trim()
      if (!roomId.endsWith('@chatroom')) continue
      map.set(roomId, { roomId, name: String(room.name || '').trim() })
    }
    if (options.includeDetail) {
      try {
        const detailRes = await readApi(record, '/api/get_all_room_detail', {})
        if (detailRes?.response?.ok) {
          for (const room of extractRoomsFromApiRaw(detailRes.raw)) {
            const roomId = String(room.roomId || '').trim()
            if (!roomId.endsWith('@chatroom')) continue
            const prev = map.get(roomId)
            const name = String(room.name || '').trim()
            if (!prev || (name && name !== '群聊' && (!prev.name || prev.name === '群聊'))) {
              map.set(roomId, { roomId, name: name || prev?.name || '' })
            }
          }
        }
      } catch { /* 详情失败时仍可用列表做 roomId / 已有名称判断 */ }
    }
    const rooms = [...map.values()]
    return { ok: true, rooms, ids: new Set(rooms.map((room) => room.roomId)) }
  } catch {
    return { ok: false, rooms: [], ids: new Set() }
  }
}

/**
 * 读取当前微信群列表（含群名），用于进群后回填任务明细目标列。
 * @param {{ id: string }} record
 * @returns {Promise<Array<{ roomId: string, name: string }>>}
 */
async function readWechatRooms(record) {
  try {
    const listRes = await readApi(record, '/api/get_chatroom_list', {})
    const map = new Map()
    for (const room of extractRoomsFromApiRaw(listRes?.response?.ok ? listRes.raw : null)) {
      if (!room?.roomId) continue
      map.set(room.roomId, room)
    }
    const detailRes = await readApi(record, '/api/get_all_room_detail', {})
    for (const room of extractRoomsFromApiRaw(detailRes?.response?.ok ? detailRes.raw : null)) {
      if (!room?.roomId) continue
      const prev = map.get(room.roomId)
      if (!prev || (room.name && room.name !== '群聊' && prev.name === '群聊')) map.set(room.roomId, room)
    }
    return [...map.values()]
  } catch {
    return []
  }
}

/**
 * 可读群名（排除占位文案）。
 * @param {unknown} value
 * @returns {string}
 */
function usableQrRoomName(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (text === '未知群名' || /^二维码/.test(text) || /@chatroom$/i.test(text)) return ''
  if (/^未知群名/.test(text)) return ''
  return text
}

/**
 * 把可读群名写回任务项，任务中心「目标」列不再显示「二维码目标」。
 * @param {string} itemId
 * @param {{ roomName?: string, label?: string, memberCount?: number, roomId?: string } | null | undefined} preview
 */
function persistQrTaskDisplay(itemId, preview) {
  if (!itemId || !preview) return
  const roomName = usableQrRoomName(preview.roomName)
  const memberCount = Number(preview.memberCount) || 0
  const roomId = String(preview.roomId || '').trim()
  const label = roomName
    ? formatInvitePreviewLine({ roomName, memberCount, roomId })
    : ''
  if (!roomName && !roomId) return
  try {
    patchTaskItemRequest(itemId, {
      ...(roomName ? { roomName, label } : {}),
      ...(memberCount > 0 ? { memberCount } : {}),
      ...(roomId.endsWith('@chatroom') ? { resolvedRoomId: roomId } : {}),
    })
  } catch { /* ignore */ }
}

/**
 * 任务项上的二维码查找键：兼容 `instanceId::sha256`（多执行号同群）与旧版纯 sha/id。
 * @param {{ target_key?: string, id?: string } | null | undefined} item
 * @param {Record<string, unknown> | null | undefined} request
 * @returns {string}
 */
function resolveQrItemLookupKey(item, request = {}) {
  const fromRequest = String(request?.qrSha || request?.qrItemId || '').trim()
  if (fromRequest) return fromRequest
  const key = String(item?.target_key || item?.id || '').trim()
  if (!key) return ''
  const sep = key.indexOf('::')
  if (sep > 0) return key.slice(sep + 2)
  return key
}

/**
 * 任务执行时解析二维码类型：优先用手改/入库类型，避免自动分类覆盖人工纠正。
 * @param {{ request_json?: string, target_key?: string, id?: string }} item
 * @param {Record<string, unknown>} request
 * @param {string} decodedText
 * @returns {string}
 */
function resolveTaskQrType(item, request, decodedText) {
  const allowed = new Set(['GROUP_LINK', 'PERSONAL_LINK', 'QQ_GROUP_LINK', 'UNKNOWN', 'INVALID'])
  const fromRequest = String(request?.qrType || '').trim()
  if (allowed.has(fromRequest)) return fromRequest
  const key = resolveQrItemLookupKey(item, request)
  if (key) {
    try {
      const stored = listQrItems().find((row) => row.sha256 === key || row.id === key)
      const fromStore = String(stored?.qrType || '').trim()
      if (allowed.has(fromStore)) return fromStore
    } catch { /* ignore */ }
  }
  return classifyQrText(decodedText)
}

/**
 * 邀请页没解析出群名时，用已进群的 roomId 从微信群列表反查名称。
 * 禁止默认打 get_all_room_detail；优先任务内缓存 / 群列表，缺名时最多补一次详情。
 * @param {{ id: string }} record
 * @param {Record<string, unknown>} preview
 * @param {string} [roomIdHint]
 * @param {{ loadRoomState?: (options?: object) => Promise<{ ok: boolean, rooms: Array<{ roomId: string, name: string }> }> }} [helpers]
 */
async function enrichPreviewRoomName(record, preview, roomIdHint = '', helpers = {}) {
  const source = preview && typeof preview === 'object' ? { ...preview } : {}
  const existingName = usableQrRoomName(source.roomName)
  if (existingName) {
    source.roomName = existingName
    source.label = formatInvitePreviewLine(source)
    return source
  }
  const roomId = String(roomIdHint || source.roomId || '').trim()
  if (roomId.endsWith('@chatroom')) {
    const loadState = typeof helpers.loadRoomState === 'function'
      ? helpers.loadRoomState
      : async (opts) => readWechatRoomListState(record, opts)
    let state = await loadState({ includeDetail: false })
    let hit = (state.rooms || []).find((row) => row.roomId === roomId)
    if (!usableQrRoomName(hit?.name)) {
      state = await loadState({ includeDetail: true })
      hit = (state.rooms || []).find((row) => row.roomId === roomId)
    }
    const lookedUp = usableQrRoomName(hit?.name)
    if (lookedUp) {
      source.roomName = lookedUp
      source.roomId = roomId
    } else if (!source.roomId) {
      source.roomId = roomId
    }
  }
  source.label = formatInvitePreviewLine(source)
  return source
}

/**
 * 核验是否已进群。轮询只用 get_chatroom_list；按群名匹配时整次核验最多补一次详情，禁止每轮 get_all_room_detail。
 * @param {{ id: string }} record
 * @param {Set<string>|string[]} beforeRoomIds
 * @param {string} [expectedRoomId]
 * @param {{ finalize?: boolean, taskId?: string, expectedRoomName?: string, loadRoomState?: Function }} [options]
 */
async function verifyJoinedRoom(record, beforeRoomIds, expectedRoomId = '', options = {}) {
  const target = String(expectedRoomId || '').trim()
  const before = beforeRoomIds instanceof Set ? beforeRoomIds : new Set(beforeRoomIds || [])
  const finalize = Boolean(options.finalize)
  const taskId = String(options.taskId || '')
  if (target.endsWith('@chatroom') && before.has(target)) {
    return { status: 'ALREADY_IN', roomId: target, reason: '进群前已在该群中，不算本次进群成功' }
  }
  const expectedRoomName = String(options.expectedRoomName || '').trim()
  const needNames = !target.endsWith('@chatroom') && Boolean(expectedRoomName)
  const loadPollState = typeof options.loadRoomState === 'function'
    ? options.loadRoomState
    : async (opts) => readWechatRoomListState(record, opts)
  let detailFetched = false

  const pollOnce = async () => {
    // 轮询强制刷新列表；仅当出现「无名称的新群」时整次核验最多补一次详情
    let state = await loadPollState({ force: true, includeDetail: false })
    if (needNames && !detailFetched && state.ok) {
      const rooms = state.rooms || []
      const ids = state.ids instanceof Set ? state.ids : new Set(rooms.map((row) => row.roomId).filter(Boolean))
      const added = [...ids].filter((id) => String(id).endsWith('@chatroom') && !before.has(id))
      const addedMissingName = added.some((id) => {
        const hit = rooms.find((row) => row.roomId === id)
        return !usableQrRoomName(hit?.name)
      })
      if (addedMissingName) {
        const enriched = await loadPollState({ force: true, includeDetail: true })
        detailFetched = true
        if (enriched.ok) state = enriched
      }
    }
    const rooms = state.ok ? (state.rooms || []) : []
    const current = state.ok
      ? (state.ids instanceof Set ? state.ids : new Set(rooms.map((row) => row.roomId).filter(Boolean)))
      : new Set()
    const roomNameById = new Map(rooms.map((row) => [row.roomId, row.name || '']))
    return { current, roomNameById, ok: Boolean(state.ok) }
  }

  const pollDelays = [0, 1500, 2500, 4000, 6000, 8000]
  let lastSnap = null
  for (let attempt = 0; attempt < pollDelays.length; attempt += 1) {
    if (taskId && isTaskStopRequested(taskId)) {
      if (lastSnap) {
        const last = confirmJoinedFromRoomList(before, lastSnap.current, target, {
          expectedRoomName, roomNameById: lastSnap.roomNameById,
        })
        if (last.status === 'JOINED' || last.status === 'ALREADY_IN') return last
      }
      return { status: 'CANCELLED', roomId: target, reason: '任务已取消，停止等待进群确认' }
    }
    if (pollDelays[attempt]) await new Promise((resolve) => setTimeout(resolve, pollDelays[attempt]))
    lastSnap = await pollOnce()
    const verdict = confirmJoinedFromRoomList(before, lastSnap.current, target, {
      expectedRoomName, roomNameById: lastSnap.roomNameById,
    })
    if (verdict.status === 'JOINED' || verdict.status === 'ALREADY_IN') {
      return verdict
    }
  }
  if (!target.endsWith('@chatroom') && lastSnap) {
    const finalVerdict = confirmJoinedFromRoomList(before, lastSnap.current, target, {
      expectedRoomName, roomNameById: lastSnap.roomNameById,
    })
    if (finalVerdict.status === 'JOINED' || finalVerdict.status === 'ALREADY_IN') return finalVerdict
    const added = [...lastSnap.current].filter((id) => String(id).endsWith('@chatroom') && !before.has(id))
    if (added.length > 1) {
      if (!finalize) {
        return {
          status: 'NOT_YET',
          roomId: '',
          reason: '短链缺少群标识且新增多群，继续等待可确认目标',
        }
      }
      return {
        status: 'MISSING_TARGET',
        roomId: '',
        reason: '无法确认目标群（缺少群标识且新增多群），不能凭任意新群判成功',
      }
    }
    if (!finalize) {
      return {
        status: 'NOT_YET',
        roomId: '',
        reason: '短链缺少群标识，群列表尚未出现新群',
      }
    }
    return {
      status: 'MISSING_TARGET',
      roomId: '',
      reason: '无法确认目标群（短链缺少群标识，且轮询期间未观察到唯一新群）',
    }
  }
  return { status: 'NOT_YET', roomId: target, reason: '群列表未出现目标群，未能确认进群成功' }
}

async function applyQrOptions(record, task, item, decodedText, taskId, helpers = {}) {
  const text = String(decodedText || '')
  let requestMeta = {}
  try { requestMeta = JSON.parse(item.request_json || '{}') } catch { requestMeta = {} }
  const type = resolveTaskQrType(item, requestMeta, text)
  if (type === 'PERSONAL_LINK' && task?.config?.skipPersonal) {
    appLog('INFO', '已跳过个人二维码', { instanceId: record.id, taskId, qrType: type })
    return { skippedPersonal: true }
  }
  if (type === 'QQ_GROUP_LINK') {
    return { scannedOnly: true, reason: 'QQ群链接不支持微信进群，已跳过', qrType: type }
  }
  if (type !== 'GROUP_LINK') return { scannedOnly: true, qrType: type }
  if (isTaskStopRequested(taskId)) {
    return { cancelled: true, reason: '任务已取消' }
  }

  const loadRoomState = typeof helpers.loadRoomState === 'function'
    ? helpers.loadRoomState
    : async (opts = {}) => readWechatRoomListState(record, { includeDetail: Boolean(opts?.includeDetail) })
  const rememberJoinedRoom = typeof helpers.rememberJoinedRoom === 'function'
    ? helpers.rememberJoinedRoom
    : null
  const isEnterRoomSubmitted = typeof helpers.isEnterRoomSubmitted === 'function'
    ? helpers.isEnterRoomSubmitted : () => null
  const markEnterRoomSubmitted = typeof helpers.markEnterRoomSubmitted === 'function'
    ? helpers.markEnterRoomSubmitted : () => {}
  const aliasEnterRoomTarget = typeof helpers.aliasEnterRoomTarget === 'function'
    ? helpers.aliasEnterRoomTarget : () => {}

  let preview = await fetchInvitePreviewCached(record, text)
  // 创建任务时已写入的群名优先保留，避免执行期邀请页再解析失败后目标列变回「群聊」
  const priorName = usableQrRoomName(requestMeta.roomName)
  if (priorName && !usableQrRoomName(preview.roomName)) {
    preview = {
      ...preview,
      roomName: priorName,
      memberCount: Number(preview.memberCount) || Number(requestMeta.memberCount) || 0,
      roomId: String(preview.roomId || requestMeta.resolvedRoomId || '').trim(),
    }
    preview.label = formatInvitePreviewLine(preview)
  }
  // 尽早回填群名，任务明细/日志不再显示「二维码目标」
  persistQrTaskDisplay(item.id, preview)
  appLog('INFO', `进群前群资料：${preview.label}`, {
    instanceId: record.id, taskId, module: '二维码进群',
    roomName: preview.roomName, memberCount: preview.memberCount, label: preview.label,
  })
  if (preview.expired) {
    return { joinSubmitted: false, joinOk: false, reason: '邀请已过期或无效', preview, joinResponse: null }
  }
  if (isTaskStopRequested(taskId)) {
    return { cancelled: true, reason: '任务已取消', preview }
  }

  const configuredApply = String(task?.config?.applyText || '').trim()
  const applyText = (configuredApply || DEFAULT_QR_APPLY_TEXT)
    .replaceAll('{昵称}', record.nickname || record.accountWxid || '微信用户')
    .trim() || DEFAULT_QR_APPLY_TEXT
  // 短链 weixin.qq.com/g/ 直接 enter_room 常返回空成功；优先用 a8key 解析出的完整邀请 URL
  const buildJoinRequest = (joinUrlValue) => {
    const joinUrl = String(joinUrlValue || '').trim()
    return {
      url: joinUrl,
      link: joinUrl,
      inviteUrl: joinUrl,
      // 多字段兼容：需申请理由的群依赖 msg/verifyContent
      msg: applyText,
      verifyContent: applyText,
      applyText,
      reason: applyText,
    }
  }
  let joinUrl = String(preview.fullUrl || text).trim() || text
  if (isShortGroupInviteUrl(joinUrl) && !isExpandedInviteUrl(joinUrl)) {
    appLog('INFO', '短链尚未解析为完整邀请链，进群前再尝试一次 a8key', {
      instanceId: record.id, taskId, module: '二维码进群', roomName: preview.roomName || '',
    })
    const refreshed = await fetchInvitePreviewCached(record, text)
    preview = mergeInvitePreview(preview, refreshed)
    if (priorName && !usableQrRoomName(preview.roomName)) {
      preview.roomName = priorName
      preview.memberCount = Number(preview.memberCount) || Number(requestMeta.memberCount) || 0
    }
    if (!usableQrRoomName(preview.roomName) && usableQrRoomName(refreshed.roomName)) {
      preview.roomName = refreshed.roomName
    }
    preview.label = formatInvitePreviewLine(preview)
    persistQrTaskDisplay(item.id, preview)
    joinUrl = String(preview.fullUrl || text).trim() || text
  }
  let joinRequest = buildJoinRequest(joinUrl)
  if (preview.needApply) {
    appLog('INFO', `该群需申请理由进群，已提交验证文案（${applyText.length}字）`, {
      instanceId: record.id, taskId, module: '二维码进群', roomName: preview.roomName || '',
    })
  }
  if (!hasReliableJoinTarget(preview) && isShortGroupInviteUrl(joinUrl) && !isExpandedInviteUrl(joinUrl)) {
    appLog('WARN', '仍将使用短链提交进群（可能仅返回空成功），将以群列表核验为准', {
      instanceId: record.id, taskId, module: '二维码进群',
    })
  }
  if (isTaskStopRequested(taskId)) {
    return { cancelled: true, reason: '任务已取消', preview }
  }
  // 进群前必须能读到群列表：失败时跳过，避免误判「不在群」而重复 enter_room 刷「欢迎回到群聊」
  // 同一任务内按执行号缓存；仅缺 roomId、需按群名判断时才补详情，禁止每条都全量拉群
  const needNameMatch = Boolean(usableQrRoomName(preview.roomName) || priorName)
    && !String(preview.roomId || requestMeta.resolvedRoomId || '').trim().endsWith('@chatroom')
  let roomListState = await loadRoomState({ includeDetail: needNameMatch })
  if (!roomListState.ok) {
    await new Promise((resolve) => setTimeout(resolve, 800))
    roomListState = await loadRoomState({ force: true, includeDetail: needNameMatch })
  }
  if (!roomListState.ok) {
    const reason = '无法读取当前微信群列表，已跳过进群以免重复加入'
    appLog('ERROR', reason, { instanceId: record.id, taskId, module: '二维码进群' })
    return { joinSubmitted: false, joinOk: false, skippedNoRoomList: true, reason, preview }
  }
  const beforeRoomIds = roomListState.ids instanceof Set
    ? roomListState.ids
    : new Set(roomListState.ids || [])
  const already = findAlreadyJoinedRoom(roomListState.rooms || [], {
    roomId: String(preview.roomId || requestMeta.resolvedRoomId || '').trim(),
    roomName: usableQrRoomName(preview.roomName) || priorName || '',
  })
  if (already) {
    preview = {
      ...preview,
      roomId: already.roomId || preview.roomId,
      roomName: already.roomName || preview.roomName,
    }
    preview.label = formatInvitePreviewLine(preview)
    persistQrTaskDisplay(item.id, preview)
    appLog('INFO', `进群前已在该群中：${preview.roomName || preview.label}`, {
      instanceId: record.id, taskId, module: '二维码进群', roomName: preview.roomName || '', label: preview.label,
    })
    return {
      joinSubmitted: false,
      joinOk: false,
      alreadyIn: true,
      reason: already.reason,
      roomId: already.roomId,
      preview,
      roomName: preview.roomName || '',
      label: preview.label,
      joinResponse: null,
    }
  }

  // 幂等检查：同一执行微信 + 同一群目标只允许调用一次 enter_room
  const resolvedRoomId = String(preview.roomId || requestMeta.resolvedRoomId || '').trim()
  const idempotencyTarget = resolvedRoomId.endsWith('@chatroom') ? resolvedRoomId : joinUrl
  const priorSubmission = isEnterRoomSubmitted(idempotencyTarget)
  if (priorSubmission) {
    const skipReason = `二维码进群已提交过，跳过重复 enter_room（幂等key=${idempotencyTarget.slice(0, 40)}，首次itemId=${priorSubmission.itemId}，状态=${priorSubmission.status}）`
    appLog('INFO', skipReason, { instanceId: record.id, taskId, module: '二维码进群', idempotencyKey: idempotencyTarget.slice(0, 40) })
    return { skippedDuplicate: true, reason: skipReason, preview, idempotencyKey: idempotencyTarget }
  }

  // 确认需要真正进群后再占当日额度，避免取消/已在群误扣次数
  const reservation = reserveQrJoinDailyAttempt(record.accountWxid, item.id, item.target_key, task?.config?.limitPerAccount)
  if (!reservation.accepted) {
    const reason = reservation.reason === 'ACCOUNT_REQUIRED' ? '未读取到登录微信号，已跳过进群申请' : '已达到本微信今日进群上限'
    appLog('INFO', reason, { instanceId: record.id, taskId })
    return { skippedLimit: true, reason }
  }
  if (isTaskStopRequested(taskId)) {
    try { releaseQrJoinDailyAttempt(item.id) } catch { /* ignore */ }
    return { cancelled: true, reason: '任务已取消', preview }
  }

  // 标记 SUBMITTING 状态，防止并发竞争
  markEnterRoomSubmitted(idempotencyTarget, item.id, 'SUBMITTING')
  appLog('INFO', `二维码进群真实提交 enter_room attempt=1 idempotencyKey=${idempotencyTarget.slice(0, 40)}`, {
    instanceId: record.id, taskId, itemId: item.id, module: '二维码进群',
    roomId: resolvedRoomId || '', roomName: preview.roomName || '',
    idempotencyKey: idempotencyTarget.slice(0, 40), enterRoomAttempt: 1,
  })
  const startedAt = Date.now()
  let { response, raw } = await requestApi(record, '/api/enter_room', joinRequest)
  saveApiSample({ instanceId: record.id, sourceId: 438557545, path: '/api/enter_room', request: joinRequest, response: raw, httpStatus: response.status, durationMs: Date.now() - startedAt })
  invalidateInstanceApi(record.id, '/api/get_chatroom_list')
  markEnterRoomSubmitted(idempotencyTarget, item.id, 'SUBMITTED')
  // 如果解析出 roomId，同时标记 roomId 别名
  const postRoomId = String(preview.roomId || '').trim()
  if (postRoomId.endsWith('@chatroom') && postRoomId !== idempotencyTarget) {
    aliasEnterRoomTarget(idempotencyTarget, postRoomId)
  }
  if (hasFrequentEvidence(raw)) {
    markEnterRoomSubmitted(idempotencyTarget, item.id, 'FAILED_HARD')
    appLog('ERROR', '进群检测到明确频繁状态', { instanceId: record.id, taskId, status: response.status })
    return { frequent: true, joinResponse: raw, preview }
  }

  let apiVerdict = evaluateEnterRoomResult(response.ok, raw)
  // 硬失败（过期/负错误码等）不再重试；其余一律以群列表核验为准
  if (apiVerdict.hardFail) {
    markEnterRoomSubmitted(idempotencyTarget, item.id, 'FAILED_HARD')
    appLog('ERROR', `进群失败：${apiVerdict.reason}`, {
      instanceId: record.id, taskId, module: '二维码进群', operation: '提交进群并核验群列表',
      sourceId: 438557545, path: '/api/enter_room', status: response.status,
      roomName: preview.roomName, reason: apiVerdict.reason,
    })
    return {
      joinSubmitted: true,
      joinResponse: raw,
      joinOk: false,
      reason: apiVerdict.reason,
      roomId: apiVerdict.roomId || preview.roomId || '',
      preview,
    }
  }

  // 接口已明确「申请待确认」：群列表不会立刻出现，记为申请已提交
  if (apiVerdict.pendingApply || (preview.needApply && isJoinApplicationPending(raw))) {
    markEnterRoomSubmitted(idempotencyTarget, item.id, 'PENDING_APPROVAL')
    const pendingReason = '进群申请已提交，等待群主确认'
    persistQrTaskDisplay(item.id, preview)
    appLog('INFO', pendingReason, {
      instanceId: record.id, taskId, module: '二维码进群', operation: '提交进群申请',
      sourceId: 438557545, path: '/api/enter_room', status: response.status,
      roomName: preview.roomName || '', reason: pendingReason,
    })
    return {
      joinSubmitted: true,
      joinOk: false,
      requestSent: true,
      reason: pendingReason,
      roomId: apiVerdict.roomId || preview.roomId || '',
      preview,
      roomName: preview.roomName || '',
      label: preview.label,
      joinResponse: raw,
    }
  }

  let expectedRoomId = String(preview.roomId || apiVerdict.roomId || '').trim()
  let listVerdict = await verifyJoinedRoom(record, beforeRoomIds, expectedRoomId, {
    expectedRoomName: usableQrRoomName(preview.roomName) || '',
    finalize: false,
    taskId,
    loadRoomState,
  })

  // 列表未确认时仅继续轮询群列表，绝对不再调用第二次 enter_room
  if (listVerdict.status === 'NOT_YET' && response.ok) {
    if (isTaskStopRequested(taskId)) {
      return { cancelled: true, reason: '任务已取消', preview, joinResponse: raw, joinSubmitted: true }
    }
    // 如果短链尚未完全展开，尝试解析完整 URL 获取 roomId（仅用于确认身份，不再 enter_room）
    if (isShortGroupInviteUrl(joinUrl) && !isExpandedInviteUrl(joinUrl)) {
      const refreshed = await fetchInvitePreviewCached(record, text)
      preview = mergeInvitePreview(preview, refreshed)
      preview.label = formatInvitePreviewLine(preview)
      persistQrTaskDisplay(item.id, preview)
      const refreshedRoomId = String(preview.roomId || '').trim()
      if (refreshedRoomId.endsWith('@chatroom')) {
        expectedRoomId = refreshedRoomId
        aliasEnterRoomTarget(idempotencyTarget, refreshedRoomId)
      }
    }
    if (isTaskStopRequested(taskId)) {
      return { cancelled: true, reason: '任务已取消', preview, joinResponse: raw, joinSubmitted: true }
    }
    appLog('INFO', '群列表暂未确认，继续轮询（不再重复 enter_room）', {
      instanceId: record.id, taskId, module: '二维码进群', expectedRoomId,
    })
    // 进入 finalize 轮询：给微信群列表同步更多时间
    listVerdict = await verifyJoinedRoom(record, beforeRoomIds, expectedRoomId, {
      expectedRoomName: usableQrRoomName(preview.roomName) || '',
      finalize: true,
      taskId,
      loadRoomState,
    })
  }

  if (listVerdict.status === 'CANCELLED') {
    return { cancelled: true, reason: listVerdict.reason || '任务已取消', preview, joinResponse: raw, joinSubmitted: true }
  }

  if (listVerdict.status === 'JOINED') {
    const roomId = listVerdict.roomId
    markEnterRoomSubmitted(idempotencyTarget, item.id, 'JOINED')
    if (roomId && roomId !== idempotencyTarget) aliasEnterRoomTarget(idempotencyTarget, roomId)
    preview = await enrichPreviewRoomName(record, preview, roomId, { loadRoomState })
    persistQrTaskDisplay(item.id, preview)
    if (rememberJoinedRoom && roomId) {
      rememberJoinedRoom(record.id, {
        roomId,
        name: usableQrRoomName(preview.roomName) || '',
      })
    }
    appLog('INFO', `进群成功：${preview.roomName || preview.label}`, {
      instanceId: record.id, taskId, module: '二维码进群', operation: '提交进群并核验群列表',
      sourceId: 438557545, path: '/api/enter_room', status: response.status,
      roomName: preview.roomName || '', label: preview.label, reason: listVerdict.reason,
    })
    if (task?.config?.saveContact && roomId) {
      const saved = await requestApi(record, '/api/save_chatroom_to_contact', {
        roomId,
        room_id: roomId,
        chatroomId: roomId,
      })
      saveApiSample({
        instanceId: record.id, sourceId: 438557556, path: '/api/save_chatroom_to_contact',
        request: { roomId, room_id: roomId, chatroomId: roomId },
        response: saved.raw, httpStatus: saved.response.status, durationMs: 0,
      })
      appLog(saved.response.ok ? 'INFO' : 'ERROR', saved.response.ok ? `群聊已保存到通讯录：${preview.roomName || preview.label}` : `群聊保存到通讯录失败：${preview.roomName || preview.label}`, { instanceId: record.id, taskId, roomName: preview.roomName || '' })
    }
    if (qrMonitorConfig.enabled && qrMonitorConfig.watchAll && roomId.endsWith('@chatroom')) {
      addQrMonitorRooms([{
        instanceId: record.id,
        roomId,
        name: preview.roomName || '群聊',
      }], { reason: '二维码进群成功' })
    }
    return {
      joinSubmitted: true,
      joinResponse: raw,
      joinOk: true,
      reason: `已进群：${preview.roomName || preview.label}`,
      roomId,
      preview,
      roomName: preview.roomName || '',
      label: preview.label,
    }
  }

  if (listVerdict.status === 'ALREADY_IN') {
    preview = await enrichPreviewRoomName(record, preview, listVerdict.roomId, { loadRoomState })
    persistQrTaskDisplay(item.id, preview)
    appLog('INFO', `进群前已在该群中：${preview.roomName || preview.label}`, {
      instanceId: record.id, taskId, module: '二维码进群', roomName: preview.roomName || '', label: preview.label,
    })
    return {
      joinSubmitted: true,
      joinResponse: raw,
      joinOk: false,
      alreadyIn: true,
      reason: listVerdict.reason,
      roomId: listVerdict.roomId,
      preview,
      roomName: preview.roomName || '',
      label: preview.label,
    }
  }

  // 无 roomId 的短链在 finalize 后仍可能是 NOT_YET（有 roomId 时）；统一收口失败文案
  if (listVerdict.status === 'NOT_YET' && !String(expectedRoomId || '').endsWith('@chatroom')) {
    listVerdict = {
      status: 'MISSING_TARGET',
      roomId: '',
      reason: '无法确认目标群（短链缺少群标识，且轮询期间未观察到唯一新群）',
    }
  }

  const failReason = listVerdict.reason
    || apiVerdict.reason
    || '群列表未出现目标群，未能确认进群成功'
  if (expectedRoomId || listVerdict.roomId) {
    preview = await enrichPreviewRoomName(record, preview, expectedRoomId || listVerdict.roomId, { loadRoomState })
    persistQrTaskDisplay(item.id, preview)
  }
  // 需申请进群的群：提交后群列表不会立刻出现，按「申请已提交」处理，避免误报失败
  const treatAsRequestSent = Boolean(preview.needApply)
    || apiVerdict.pendingApply
    || isJoinApplicationPending(raw)
  if (treatAsRequestSent && listVerdict.status !== 'JOINED') {
    const pendingReason = '进群申请已提交，等待群主确认'
    appLog('INFO', pendingReason, {
      instanceId: record.id, taskId, module: '二维码进群', operation: '提交进群申请',
      sourceId: 438557545, path: '/api/enter_room', status: response.status,
      roomName: preview.roomName || '', label: preview.label, reason: pendingReason,
    })
    return {
      joinSubmitted: true,
      joinResponse: raw,
      joinOk: false,
      requestSent: true,
      reason: pendingReason,
      roomId: expectedRoomId || listVerdict.roomId || '',
      preview,
      roomName: preview.roomName || '',
      label: preview.label,
    }
  }
  appLog('ERROR', `进群未确认：${failReason}`, {
    instanceId: record.id, taskId, module: '二维码进群', operation: '提交进群并核验群列表',
    sourceId: 438557545, path: '/api/enter_room', status: response.status,
    roomName: preview.roomName || '', label: preview.label, reason: failReason,
  })
  return {
    joinSubmitted: true,
    joinResponse: raw,
    joinOk: false,
    reason: failReason,
    roomId: expectedRoomId || listVerdict.roomId || '',
    preview,
    roomName: preview.roomName || '',
    label: preview.label,
  }
}

async function applyQrOptionsWithConnectionRetry(record, task, item, decodedText, taskId, helpers = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (isTaskStopRequested(taskId)) {
      return { cancelled: true, reason: '任务已取消' }
    }
    try {
      return await applyQrOptions(record, task, item, decodedText, taskId, helpers)
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
  // 同源实例一律用当前在线端口；候选里缓存的 sourceInstancePort 会在重启后失效
  const profilePort = Number(record.apiPort)
  const requestUrl = `http://127.0.0.1:${profilePort}/api/get_group_member_contact`
  appLog('INFO', 'MESSAGE_CANDIDATE -> PROFILE_RESOLUTION', {
    module: '群聊加好友', operation: 'PROFILE_RESOLUTION', taskId,
    accountWxid: String(request.accountWxid || record.accountWxid || ''), targetWxid,
    sourceRoomId, sourceRoomName, sourceInstanceId, sourceInstancePort: profilePort,
    cachedSourcePort: Number(request.sourceInstancePort) || 0,
    instanceId: record.id, instancePort: profilePort, requestUrl,
  })
  if (!targetWxid || !sourceRoomId || sourceInstanceId !== record.id) {
    return { ok: false, missing: ['source'], diagnostics: [], reason: '候选来源实例或群标识无效' }
  }
  if (!sourceRoomId.endsWith('@chatroom')) {
    return { ok: false, missing: ['sourceRoomId'], diagnostics: [], reason: '群标识无效，无法按群场景加好友' }
  }
  const profileRecord = record
  const diagnostics = []
  const fetchProfile = async (endpoint, body, sourceId, attempt) => {
    const startedAt = Date.now()
    const url = `http://127.0.0.1:${profilePort}${endpoint}`
    const { response, raw } = await requestApi(profileRecord, endpoint, body)
    const parsed = parseProfileCredentials(raw, targetWxid, sourceRoomId)
    const diagnostic = {
      endpoint, requestUrl: url, requestBodyWxid: String(body.wxid || ''), requestBodyRoomId: String(body.roomId || ''),
      httpStatus: response.status, ...rawStructure(raw), parserVersion: 'profile-resolution-v3',
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
  const credKey = `${record.id}|${sourceRoomId}|${targetWxid}`
  const existingCred = friendCredentialInflight.get(credKey)
  if (existingCred) {
    const shared = await existingCred
    return { ...shared, diagnostics: [] }
  }
  const credPromise = resolveFriendProfileCredentials({
    targetWxid,
    sourceRoomId,
    fetchProfile,
  }).finally(() => { friendCredentialInflight.delete(credKey) })
  friendCredentialInflight.set(credKey, credPromise)
  const resolved = await credPromise
  return { ...resolved, diagnostics }
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
    if (!task || ['PAUSED', 'CANCELLED'].includes(String(task.status || ''))) return
    const scheduledAt = Date.parse(String(task?.config?.scheduledAt || ''))
    if (Number.isFinite(scheduledAt) && scheduledAt > Date.now() && !await waitForTaskTime(taskId, scheduledAt)) return
    if (isTaskStopRequested(taskId)) return
    setTaskStatus(taskId, 'RUNNING')
    if (isTaskStopRequested(taskId)) return
    /** @type {Map<string, Set<string>>} */
    const kickLiveRoomIdsByInstance = new Map()
    /** 二维码进群：某执行号触发频繁后，仅跳过该号剩余项，不影响其他执行号 */
    /** @type {Set<string>} */
    const qrFrequentInstanceIds = new Set()
    /**
     * 二维码进群幂等状态：instanceId::roomId/target → 提交状态
     * 防止同一执行微信对同一群目标多次调用 enter_room（无论来自多少个不同二维码）
     * @type {Map<string, { status: string, itemId: string, submittedAt: number }>}
     */
    const enterRoomSubmittedByKey = new Map()
    /** 同一任务内按执行号缓存群列表，避免每条进群都重复打微信接口 */
    /** @type {Map<string, { ok: boolean, rooms: Array<{ roomId: string, name: string }>, ids: Set<string>, detailed?: boolean }>} */
    const qrRoomStateByInstance = new Map()
    /**
     * @param {{ id: string }} record
     */
    const qrHelpersFor = (record) => ({
      async loadRoomState(options = {}) {
        const force = Boolean(options?.force)
        const wantDetail = Boolean(options?.includeDetail)
        const cached = qrRoomStateByInstance.get(record.id)
        if (!force && cached?.ok) {
          if (wantDetail && !cached.detailed) {
            const enriched = await readWechatRoomListState(record, { includeDetail: true })
            if (enriched.ok) {
              qrRoomStateByInstance.set(record.id, { ...enriched, detailed: true })
              return enriched
            }
          }
          return cached
        }
        // 默认只拉群列表；仅当调用方明确需要按群名匹配时再补一次详情
        const state = await readWechatRoomListState(record, { includeDetail: wantDetail })
        if (state.ok) {
          const prev = qrRoomStateByInstance.get(record.id)
          // 强制刷新仅列表时，保留此前详情里的可读群名，避免核验轮询冲掉名称
          if (!wantDetail && prev?.detailed && Array.isArray(prev.rooms)) {
            const nameById = new Map(prev.rooms.map((row) => [row.roomId, row.name || '']))
            for (const room of state.rooms || []) {
              const prevName = usableQrRoomName(nameById.get(room.roomId))
              if (prevName && !usableQrRoomName(room.name)) room.name = prevName
            }
          }
          qrRoomStateByInstance.set(record.id, {
            ...state,
            detailed: Boolean(wantDetail || prev?.detailed),
          })
        }
        return state
      },
      rememberJoinedRoom(instanceId, room) {
        const roomId = String(room?.roomId || '').trim()
        if (!roomId.endsWith('@chatroom')) return
        const cached = qrRoomStateByInstance.get(String(instanceId || ''))
        if (!cached?.ok) return
        if (!cached.ids.has(roomId)) {
          cached.ids.add(roomId)
          cached.rooms.push({ roomId, name: String(room?.name || '').trim() })
        } else {
          const hit = cached.rooms.find((row) => row.roomId === roomId)
          const name = String(room?.name || '').trim()
          if (hit && name && (!hit.name || hit.name === '群聊')) hit.name = name
        }
      },
      /** 检查某执行号+群目标是否已提交过 enter_room */
      isEnterRoomSubmitted(targetKey) {
        const key = `${record.id}::${targetKey}`
        return enterRoomSubmittedByKey.get(key) || null
      },
      /** 记录 enter_room 已提交 */
      markEnterRoomSubmitted(targetKey, itemId, status) {
        const key = `${record.id}::${targetKey}`
        enterRoomSubmittedByKey.set(key, { status: status || 'SUBMITTED', itemId, submittedAt: Date.now() })
      },
      /** 当解析出 roomId 后，将该 roomId 也标记为已提交（防同群不同二维码重复） */
      aliasEnterRoomTarget(oldKey, newKey) {
        if (!oldKey || !newKey || oldKey === newKey) return
        const keyOld = `${record.id}::${oldKey}`
        const keyNew = `${record.id}::${newKey}`
        const existing = enterRoomSubmittedByKey.get(keyOld)
        if (existing && !enterRoomSubmittedByKey.has(keyNew)) {
          enterRoomSubmittedByKey.set(keyNew, existing)
        }
      },
    })
    const taskItems = getTaskItems(taskId)
    // REQUEST_SENT/UNSAFE_RESUME 也必须跳过，否则恢复加好友/不确定项会重复提交
    const doneItemStatuses = new Set(['COMPLETED', 'SKIPPED', 'FAILED', 'SUBMITTED', 'REQUEST_SENT', 'FREQUENT', 'RESOLUTION_FAILED', 'CANCELLED', 'UNSAFE_RESUME'])
    for (const [itemIndex, item] of taskItems.entries()) {
      if (!runtimeAllowed) {
        setTaskStatus(taskId, 'PAUSED')
        break
      }
      if (isTaskStopRequested(taskId)) break
      // 恢复已暂停任务时跳过已结束项，避免对已成功目标重复发送
      if (doneItemStatuses.has(String(item.status || ''))) continue
      // 中断时停在 RUNNING 的项结果不确定，禁止自动重放
      if (String(item.status || '') === 'RUNNING') {
        setTaskItemResult(item.id, 'UNSAFE_RESUME', null, '暂停或中断时该项结果不确定，为避免重复操作已跳过')
        continue
      }
      const resolved = await resolveTaskItemInstanceWithWait(taskId, item)
      if (resolved.stopped) {
        if (resolved.reason === 'PAUSED' || String(listTasks().find((t) => t.id === taskId)?.status || '') === 'PAUSED') {
          setTaskStatus(taskId, 'PAUSED')
        }
        break
      }
      if (!resolved.ok) {
        setTaskItemResult(item.id, 'FAILED', null, resolved.reason || '实例不在线')
        continue
      }
      const record = resolved.record
      if (resolved.rebound) {
        try { updateTaskItemInstanceId(item.id, record.id) } catch { /* ignore */ }
        item.instance_id = record.id
        appLog('INFO', '任务项已绑定到同账号新微信实例', {
          taskId, itemId: item.id, accountWxid: item.account_wxid || record.accountWxid, instanceId: record.id,
        })
      }
      if (item.action_type === 'QR_SCAN' && qrFrequentInstanceIds.has(String(item.instance_id || ''))) {
        setTaskItemResult(item.id, 'SKIPPED', null, '该微信本任务内已触发加群频繁，剩余进群已跳过')
        continue
      }
      if (item.action_type === 'KICKED_GROUP_CLEANUP') {
        let request
        try { request = JSON.parse(item.request_json || '{}') } catch { request = {} }
        const roomId = String(request.roomId || '').trim()
          || (String(item.target_key || '').includes('::')
            ? String(item.target_key).slice(String(item.target_key).indexOf('::') + 2)
            : String(item.target_key || '')).trim()
        const dbRow = getKickedGroupCleanup(record.id, roomId) || {}
        const evidence = String(dbRow.evidence || request.evidence || '')
        const roomName = resolveKickRoomLabel(record.id, roomId, dbRow.roomName || request.roomName || '')
        const kickStatus = kickEvidenceStatusLabel(evidence)
        const dbStatus = String(dbRow.status || '')
        if (dbStatus === 'DONE') {
          const message = formatKickCleanupMessage({
            roomName, kickStatus, evidence, result: '已跳过：该群此前已清理完成',
          })
          setTaskItemResult(item.id, 'SKIPPED', dbRow, message)
          appLog('INFO', message, {
            instanceId: record.id, taskId, module: '被踢群清理', operation: '任务执行',
            roomId, roomName, evidence, kickStatus, result: '已跳过（已完成）',
          })
          continue
        }
        if (dbStatus === 'CANCELLED') {
          const message = formatKickCleanupMessage({
            roomName, kickStatus, evidence, result: `已跳过：清理已取消（${dbRow.lastError || 'CANCELLED'}）`,
          })
          setTaskItemResult(item.id, 'SKIPPED', dbRow, message)
          appLog('INFO', message, {
            instanceId: record.id, taskId, module: '被踢群清理', operation: '任务执行',
            roomId, roomName, evidence, kickStatus, result: '已跳过（已取消）',
          })
          continue
        }
        setTaskItemStarted(item.id)
        appLog('INFO', formatKickCleanupMessage({
          roomName, kickStatus, evidence, result: '开始清理（排队执行中）',
        }), {
          instanceId: record.id, taskId, module: '被踢群清理', operation: '任务执行',
          roomId, roomName, evidence, kickStatus, result: '开始清理',
        })
        try {
          const needsGate = !isImmediateKickEvidence(evidence)
          let liveIds = kickLiveRoomIdsByInstance.has(record.id)
            ? kickLiveRoomIdsByInstance.get(record.id)
            : undefined
          if (needsGate && !kickLiveRoomIdsByInstance.has(record.id)) {
            liveIds = await loadLiveRoomIdsForKickGate(record)
            kickLiveRoomIdsByInstance.set(record.id, liveIds)
          }
          const result = await cleanupOneKickedGroupRoom(record, {
            roomId,
            roomName,
            evidence,
            evidenceStrength: dbRow.evidenceStrength || request.evidenceStrength || 'strong',
            accountWxid: dbRow.accountWxid || request.accountWxid || record.accountWxid || '',
            unsaveStatus: dbRow.unsaveStatus || request.unsaveStatus || 'PENDING',
            deleteChatStatus: dbRow.deleteChatStatus || request.deleteChatStatus || 'PENDING',
            confirmCount: Number(dbRow.confirmCount ?? request.confirmCount) || 0,
          }, {
            reason: '任务执行',
            liveIds: needsGate ? liveIds : new Set(),
            taskId,
          })
          setTaskItemResult(item.id, result.outcome, result, result.message)
        } catch (error) {
          const message = formatKickCleanupMessage({
            roomName, kickStatus, evidence,
            result: toUserErrorMessage(error, '退出失败'),
          })
          appLog('ERROR', message, {
            instanceId: record.id, taskId, module: '被踢群清理', operation: '任务执行',
            roomId, roomName, evidence, kickStatus, result: '退出失败', error: rawErrorMessage(error),
          })
          setTaskItemResult(item.id, 'FAILED', null, message)
        }
        if (itemIndex < taskItems.length - 1) {
          const waitMs = resolveTaskPaceIntervalMs(task)
          if (waitMs > 0 && !await waitForTaskTime(taskId, Date.now() + waitMs)) {
            if (!runtimeAllowed) setTaskStatus(taskId, 'PAUSED')
            break
          }
        }
        continue
      }
      let request
      try { request = JSON.parse(item.request_json || '{}') } catch { request = {} }
      let apiPath = ''
      let sourceId
      if (item.action_type === 'SEND_TEXT') { apiPath = '/api/send_text_msg'; sourceId = 438557482 }
      else if (item.action_type === 'SEND_IMAGE') { apiPath = '/api/send_image_msg'; sourceId = 438557485 }
      else if (item.action_type === 'QR_SCAN') { apiPath = '/api/qrscan'; sourceId = 438557574 }
      else if (item.action_type === 'ADD_FRIEND') { apiPath = '/api/add_friend'; sourceId = 438557515 }
      else { setTaskItemResult(item.id, 'SKIPPED', null, '接口未验证'); continue }
      let friendRequestMeta = null
      if (item.action_type === 'ADD_FRIEND') {
        // 执行前一律现取凭证：预缓存的 V4 会过期；消息 senderV3 不可信。
        friendRequestMeta = { ...request }
        const sourceRoomId = String(friendRequestMeta.sourceRoomId || '')
        if (sourceRoomId.endsWith('@chatroom') && isChatroomBlockedForInstance(record.id, sourceRoomId)) {
          setTaskItemResult(item.id, 'SKIPPED', null, '来源群已被确认为被踢群并永久屏蔽，已跳过')
          continue
        }
        const resolution = await resolvePendingFriendProfile(record, friendRequestMeta, taskId)
        if (!resolution.ok) {
          const resolveReason = resolution.reason || `凭证解析失败：缺少 ${(resolution.missing || []).join('、') || '资料'}`
          setTaskItemResult(item.id, 'RESOLUTION_FAILED', { diagnostics: resolution.diagnostics, missing: resolution.missing }, resolveReason)
          appLog('ERROR', `加好友失败：${resolveReason}`, {
            module: '群聊加好友', operation: 'PROFILE_RESOLUTION', taskId, instanceId: record.id,
            accountWxid: String(friendRequestMeta.accountWxid || record.accountWxid || ''), targetWxid: String(friendRequestMeta.targetWxid || item.target_key),
            sourceRoomId: String(friendRequestMeta.sourceRoomId || ''), sourceRoomName: String(friendRequestMeta.sourceRoomName || ''),
            missing: (resolution.missing || []).join(','), parserVersion: 'profile-resolution-v3',
            reason: resolveReason, result: 'RESOLUTION_FAILED',
          })
          continue
        }
        if (blockMutationForTaskStop(taskId, item.id)) continue
        friendRequestMeta.v3 = resolution.v3
        friendRequestMeta.v4 = resolution.v4
        friendRequestMeta.credentialSource = resolution.credentialSource || ''
        if (!/^v3_/i.test(String(friendRequestMeta.v3 || '')) || !/^v4_/i.test(String(friendRequestMeta.v4 || ''))) {
          setTaskItemResult(item.id, 'RESOLUTION_FAILED', { missing: ['v3', 'v4'].filter((key) => key === 'v3' ? !/^v3_/i.test(String(friendRequestMeta.v3 || '')) : !/^v4_/i.test(String(friendRequestMeta.v4 || ''))) }, '凭证格式无效')
          continue
        }
        if (!String(friendRequestMeta.sourceRoomId || '').endsWith('@chatroom')) {
          setTaskItemResult(item.id, 'RESOLUTION_FAILED', null, '缺少群标识，无法按群场景加好友')
          continue
        }
        setTaskItemStatus(item.id, 'CREDENTIALS_READY')
        appLog('INFO', '加好友凭证已就绪', {
          module: '群聊加好友', operation: 'CREDENTIALS_READY', taskId, instanceId: record.id,
          accountWxid: String(friendRequestMeta.accountWxid || record.accountWxid || ''),
          targetWxid: String(friendRequestMeta.targetWxid || item.target_key),
          sourceRoomId: String(friendRequestMeta.sourceRoomId || ''),
          credentialSource: resolution.credentialSource || '',
          hasV3: Boolean(resolution.v3), hasV4: Boolean(resolution.v4),
        })
        request = buildAddFriendRequest({
          v3: friendRequestMeta.v3,
          v4: friendRequestMeta.v4,
          scence: friendRequestMeta.scence,
          scene: friendRequestMeta.scene,
          friendFlg: friendRequestMeta.friendFlg,
          verifyContent: friendRequestMeta.verifyContent ?? friendRequestMeta.msg,
          sourceRoomId: friendRequestMeta.sourceRoomId,
          targetWxid: friendRequestMeta.targetWxid || item.target_key,
          defaultVerifyContent: DEFAULT_FRIEND_VERIFY_CONTENT,
        })
      }
      let contentHash = ''
      try {
        const settings = generalSettings()
        if (item.action_type === 'SEND_TEXT' || item.action_type === 'SEND_IMAGE') {
          const isGroup = String(task?.type || '').endsWith('_TO_GROUP')
          const targetIsGroup = String(item.target_key || '').endsWith('@chatroom')
          if (isGroup !== targetIsGroup) {
            setTaskItemResult(item.id, 'SKIPPED', null, isGroup ? '群聊群发任务中出现了好友对象，已跳过' : '好友群发任务中出现了群聊对象，已跳过')
            continue
          }
          // 执行前强制对齐目标，避免 request.wxid 与 target_key 不一致发错人
          request = {
            ...(request && typeof request === 'object' ? request : {}),
            wxid: String(item.target_key || ''),
          }
          if (item.action_type === 'SEND_TEXT' && !String(request.msg || '').trim()) {
            setTaskItemResult(item.id, 'FAILED', null, '文字内容为空')
            continue
          }
          if (item.action_type === 'SEND_IMAGE') {
            const filepath = String(request.filepath || '').trim()
            if (!filepath) {
              setTaskItemResult(item.id, 'FAILED', null, '图片路径为空')
              continue
            }
            if (!existsSync(filepath)) {
              setTaskItemResult(item.id, 'FAILED', null, '图片文件不存在或已被移动，请重新选择图片后创建任务')
              continue
            }
            request.filepath = filepath
          }
          if (!hasDirectoryOwnership(item.instance_id, item.target_key, isGroup)) {
            const blocked = isGroup && isChatroomBlockedForInstance(item.instance_id, item.target_key)
            setTaskItemResult(item.id, 'SKIPPED', null, blocked ? '该群已被确认为被踢群并永久屏蔽，已跳过' : '该微信当前已不包含这个接收对象，已跳过')
            continue
          }
        }
        if (item.action_type === 'ADD_FRIEND') {
          if (blockMutationForTaskStop(taskId, item.id)) continue
          const reservation = reserveFriendDailyAttempt(record.accountWxid, item.id, item.target_key, settings.friendDailyLimit)
          if (!reservation.accepted) {
            const message = reservation.reason === 'ACCOUNT_REQUIRED' ? '未读取到登录微信号，为避免绕过上限已跳过' : '已达到本微信今日添加好友上限'
            setTaskItemResult(item.id, 'SKIPPED', null, message)
            continue
          }
        }
        contentHash = item.action_type === 'SEND_TEXT' || item.action_type === 'SEND_IMAGE' ? deliveryContentHash(item.action_type, request) : ''
        if (contentHash && task?.config?.skipSame && record.accountWxid && hasDeliveredContent(record.accountWxid, item.target_key, contentHash)) {
          if (item.action_type === 'ADD_FRIEND') {
            try { releaseFriendDailyAttempt(item.id) } catch { /* ignore */ }
          }
          setTaskItemResult(item.id, 'SKIPPED', null, '该微信已向此对象发送过相同内容')
          continue
        }
        setTaskItemStarted(item.id)
        const isSend = item.action_type === 'SEND_TEXT' || item.action_type === 'SEND_IMAGE'
        // SEND_*：禁止可能已送达后的自动重发；仅 ADD_FRIEND 允许凭证刷新重试 1 次
        const retryCount = item.action_type === 'ADD_FRIEND' ? 1 : 0
        const retryWaitMs = item.action_type === 'ADD_FRIEND'
          ? 800
          : Math.max(Number(task?.config?.retryMinutes) || 1, 1) * 60000
        // 链接进群：无需本地图片扫码，直接走 enter_room
        if (item.action_type === 'QR_SCAN' && (request.url || request.link || request.decodedText)) {
          const linkText = String(request.url || request.link || request.decodedText || '')
          const joinResult = await applyQrOptionsWithConnectionRetry(record, task, item, linkText, taskId, qrHelpersFor(record))
          if (joinResult.cancelled) {
            setTaskItemResult(item.id, 'CANCELLED', joinResult, joinResult.reason || '任务已取消')
            return
          } else if (joinResult.frequent) {
            setTaskItemResult(item.id, 'FREQUENT', joinResult.joinResponse, '已经频繁')
            // 仅冷却该执行号：不暂停整任务，其他执行号继续
            qrFrequentInstanceIds.add(String(record.id || ''))
            appLog('ERROR', '进群频繁：仅暂停该微信本任务剩余项', {
              instanceId: record.id, taskId, module: '二维码进群', coolMinutes: Number(task?.config?.coolMinutes) || 30,
            })
          } else if (joinResult.skippedPersonal) {
            setTaskItemResult(item.id, 'SKIPPED', joinResult, '已跳过个人二维码')
          } else if (joinResult.skippedLimit) {
            setTaskItemResult(item.id, 'SKIPPED', joinResult, joinResult.reason || '已达到今日进群上限')
          } else if (joinResult.skippedNoRoomList) {
            setTaskItemResult(item.id, 'SKIPPED', joinResult, joinResult.reason || '无法读取群列表，已跳过')
          } else if (joinResult.alreadyIn) {
            setTaskItemResult(item.id, 'SKIPPED', joinResult, joinResult.reason || '进群前已在该群中')
          } else if (joinResult.requestSent) {
            setTaskItemResult(item.id, 'REQUEST_SENT', joinResult, joinResult.reason || '进群申请已提交，等待群主确认')
            appLog('INFO', joinResult.reason || '进群申请已提交', {
              instanceId: record.id, taskId, module: '二维码进群', operation: '提交进群申请',
            })
          } else if (joinResult.scannedOnly || !joinResult.joinSubmitted) {
            // 非微信群链接（个人码未跳过配置、QQ 群等）不得记为进群成功
            const linkType = resolveTaskQrType(item, request, linkText)
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
              : (joinResult.reason || '群列表未出现目标群，未能确认进群成功')
            // 存完整 joinResult（含 preview.roomName），任务目标列可显示群名
            setTaskItemResult(item.id, ok ? 'COMPLETED' : 'FAILED', joinResult, detail)
          }
          if (itemIndex < taskItems.length - 1) {
            const waitMs = resolveTaskPaceIntervalMs(task)
            if (waitMs > 0 && !await waitForTaskTime(taskId, Date.now() + waitMs)) {
              if (!runtimeAllowed) setTaskStatus(taskId, 'PAUSED')
              break
            }
          }
          continue
        }
        for (let attempt = 0; attempt <= retryCount; attempt += 1) {
          if ((item.action_type === 'ADD_FRIEND' || isSend) && blockMutationForTaskStop(taskId, item.id)) {
            if (item.action_type === 'ADD_FRIEND') {
              try { releaseFriendDailyAttempt(item.id) } catch { /* ignore */ }
            }
            break
          }
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
            if (!await waitForTaskTime(taskId, coolUntil, { earlyContinueStatuses: ['QUEUED', 'RUNNING'] })) {
              if (!runtimeAllowed) setTaskStatus(taskId, 'PAUSED')
              return
            }
            const cooled = listTasks().find((candidate) => candidate.id === taskId)
            if (!cooled || ['PAUSED', 'CANCELLED'].includes(cooled.status)) return
            if (['COOLING_DOWN', 'QUEUED'].includes(String(cooled.status || ''))) setTaskStatus(taskId, 'RUNNING')
            break
          }
          if (item.action_type === 'ADD_FRIEND') {
            const verdict = evaluateFriendAddResult(response.ok, raw)
            const targetLabel = String(request.wxid || item.target_key || '')
            const friendNick = String(friendRequestMeta?.nickname || request.nickname || item.targetLabel || '').trim()
            const friendRoomName = String(friendRequestMeta?.sourceRoomName || request.sourceRoomName || '').trim()
            const businessCode = raw?.baseResponse?.ret ?? raw?.code ?? raw?.errCode ?? raw?.data?.code ?? null
            if (!verdict.accepted && attempt < retryCount && friendRequestMeta
              && isRetryableFriendCredentialFailure(response.ok, raw, verdict)) {
              appLog('WARN', `加好友凭证类失败，刷新凭证后自动重试：${verdict.reason}`, {
                instanceId: record.id, module: '群聊加好友', operation: 'ADD_FRIEND_RETRY', taskId,
                businessCode, targetWxid: targetLabel, nickname: friendNick, roomName: friendRoomName,
                accountWxid: String(record.accountWxid || ''),
                attempt: attempt + 2, reason: verdict.reason,
              })
              await new Promise((resolve) => setTimeout(resolve, retryWaitMs))
              const refreshed = await resolvePendingFriendProfile(record, friendRequestMeta, taskId)
              if (!refreshed.ok) {
                setTaskItemResult(item.id, 'RESOLUTION_FAILED', { diagnostics: refreshed.diagnostics, missing: refreshed.missing, previous: raw }, refreshed.reason || verdict.reason)
                break
              }
              friendRequestMeta.v3 = refreshed.v3
              friendRequestMeta.v4 = refreshed.v4
              friendRequestMeta.credentialSource = refreshed.credentialSource || ''
              request = buildAddFriendRequest({
                v3: friendRequestMeta.v3,
                v4: friendRequestMeta.v4,
                scence: friendRequestMeta.scence,
                scene: friendRequestMeta.scene,
                friendFlg: friendRequestMeta.friendFlg,
                verifyContent: friendRequestMeta.verifyContent ?? friendRequestMeta.msg,
                sourceRoomId: friendRequestMeta.sourceRoomId,
                targetWxid: friendRequestMeta.targetWxid || item.target_key,
                defaultVerifyContent: DEFAULT_FRIEND_VERIFY_CONTENT,
              })
              continue
            }
            if (!verdict.accepted) {
              appLog('ERROR', `加好友失败：${friendNick || '好友'}${verdict.reason ? `：${verdict.reason}` : ''}`, {
                instanceId: record.id,
                module: '群聊加好友',
                operation: 'ADD_FRIEND_RESULT',
                taskId,
                sourceId,
                path: apiPath,
                status: response.status,
                businessCode,
                targetWxid: targetLabel,
                nickname: friendNick,
                roomName: friendRoomName,
                accountWxid: String(record.accountWxid || ''),
                reason: verdict.reason,
                result: 'FAILED',
              })
            } else {
              appLog('INFO', `加好友成功：${friendNick || verdict.reason || '申请已提交'}`, {
                instanceId: record.id,
                module: '群聊加好友',
                operation: 'ADD_FRIEND_RESULT',
                taskId,
                sourceId,
                path: apiPath,
                status: response.status,
                businessCode: businessCode ?? 0,
                targetWxid: targetLabel,
                nickname: friendNick,
                roomName: friendRoomName,
                accountWxid: String(record.accountWxid || ''),
                reason: verdict.reason,
                result: 'REQUEST_SENT',
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
            updateQrScanResult(resolveQrItemLookupKey(item, request), raw, success)
            if (success) {
              const decodedText = raw?.data?.scan_res ?? raw?.scan_res ?? ''
              const qrLookupKey = resolveQrItemLookupKey(item, request)
              const storedQr = listQrItems().find((candidate) => candidate.sha256 === qrLookupKey || candidate.id === qrLookupKey)
              const storedGroupText = storedQr?.qrType === 'GROUP_LINK' ? String(storedQr.decodedText || '') : ''
              const effectiveDecodedText = storedGroupText || decodedText
              const joinResult = await applyQrOptionsWithConnectionRetry(record, task, item, effectiveDecodedText, taskId, qrHelpersFor(record))
              if (joinResult.cancelled) {
                setTaskItemResult(item.id, 'CANCELLED', joinResult, joinResult.reason || '任务已取消')
                return
              }
              if (joinResult.frequent) {
                setTaskItemResult(item.id, 'FREQUENT', joinResult.joinResponse, '已经频繁')
                qrFrequentInstanceIds.add(String(record.id || ''))
                appLog('ERROR', '进群频繁：仅暂停该微信本任务剩余项', {
                  instanceId: record.id, taskId, module: '二维码进群', coolMinutes: Number(task?.config?.coolMinutes) || 30,
                })
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
              if (joinResult.skippedNoRoomList) {
                setTaskItemResult(item.id, 'SKIPPED', joinResult, joinResult.reason || '无法读取群列表，已跳过')
                break
              }
              if (joinResult.alreadyIn) {
                setTaskItemResult(item.id, 'SKIPPED', joinResult, joinResult.reason || '进群前已在该群中')
                break
              }
              if (joinResult.requestSent) {
                setTaskItemResult(item.id, 'REQUEST_SENT', joinResult, joinResult.reason || '进群申请已提交，等待群主确认')
                appLog('INFO', joinResult.reason || '进群申请已提交', {
                  instanceId: record.id, taskId, module: '二维码进群', operation: '提交进群申请',
                })
                break
              }
              if (joinResult.scannedOnly || !joinResult.joinSubmitted) {
                const linkType = resolveTaskQrType(item, request, effectiveDecodedText)
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
                  : (joinResult.reason || '群列表未出现目标群，未能确认进群成功')
                setTaskItemResult(item.id, ok ? 'COMPLETED' : 'FAILED', joinResult, detail)
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
        const waitMs = resolveTaskPaceIntervalMs(task)
        if (waitMs > 0 && !await waitForTaskTime(taskId, Date.now() + waitMs)) {
          if (!runtimeAllowed) setTaskStatus(taskId, 'PAUSED')
          break
        }
      }
    }
    const finalTask = listTasks().find((item) => item.id === taskId)
    if (finalTask?.status === 'RUNNING') setTaskStatus(taskId, finalTask.failed > 0 ? 'PARTIAL_FAILED' : 'COMPLETED')
  } finally {
    runningTasks.delete(taskId)
    // 暂停退出与「继续」竞态时可能停在 QUEUED 且无执行体，这里补拉一次
    const leftover = listTasks().find((item) => item.id === taskId)
    if (leftover && leftover.status === 'QUEUED' && runtimeAllowed) {
      setImmediate(() => runTask(taskId))
    }
  }
}

function createLocalTask(payload) {
  try {
    if (payload == null) throw new Error('任务数据无法传输（可能勾选对象过多），请减少数量或重启软件后重试')
    const allowed = new Set(['SEND_TEXT_TO_FRIEND', 'SEND_TEXT_TO_GROUP', 'SEND_IMAGE_TO_FRIEND', 'SEND_IMAGE_TO_GROUP', 'SEND_MIXED_TO_FRIEND', 'SEND_MIXED_TO_GROUP', 'QR_SCAN', 'ADD_FRIEND', 'KICKED_GROUP_CLEANUP'])
    if (!payload || !allowed.has(payload.type)) throw new Error('不支持的任务类型')
    if (!Array.isArray(payload.items) || !payload.items.length) throw new Error('任务没有目标')
    const taskType = String(payload.type || '')
    const isSendTask = taskType.startsWith('SEND_')
    const isGroupTask = taskType.endsWith('_TO_GROUP')
    const task = {
      id: randomUUID(),
      name: String(payload.name || payload.type),
      type: payload.type,
      status: 'WAITING_CONFIRMATION',
      config: payload.config && typeof payload.config === 'object' ? payload.config : {},
    }
    // 两千级目标时避免逐条 SQL 校验归属；按实例预加载通讯录集合
    const ownershipCache = new Map()
    const ownedKeysOf = (instanceId) => {
      const key = String(instanceId || '')
      if (ownershipCache.has(key)) return ownershipCache.get(key)
      const set = loadDirectoryOwnershipSet(key, isGroupTask)
      ownershipCache.set(key, set)
      return set
    }
    const defaultActionOf = () => {
      if (taskType === 'QR_SCAN') return 'QR_SCAN'
      if (taskType === 'ADD_FRIEND') return 'ADD_FRIEND'
      if (taskType === 'KICKED_GROUP_CLEANUP') return 'KICKED_GROUP_CLEANUP'
      // SEND_MIXED 必须显式带 actionType；纯图片任务才默认 SEND_IMAGE
      if (taskType.startsWith('SEND_IMAGE') && !taskType.includes('MIXED')) return 'SEND_IMAGE'
      return 'SEND_TEXT'
    }
    const items = payload.items.map((item, index) => {
      const actionType = String(item.actionType || defaultActionOf())
      if (isSendTask && !['SEND_TEXT', 'SEND_IMAGE'].includes(actionType)) {
        throw new Error(`群发任务第 ${index + 1} 项内容类型无效`)
      }
      if (!['SEND_TEXT', 'SEND_IMAGE', 'QR_SCAN', 'ADD_FRIEND', 'KICKED_GROUP_CLEANUP'].includes(actionType)) throw new Error('任务包含不支持的发送内容')
      if (taskType.includes('MIXED') && !item.actionType) {
        throw new Error('图文混发必须标明每条是文字还是图片')
      }
      const instanceId = String(item.instanceId || '')
      const targetKey = String(item.targetKey || '').trim()
      if (!instanceId || !targetKey) throw new Error('任务目标缺少微信号或接收对象')
      const targetIsGroup = targetKey.endsWith('@chatroom')
      if (actionType === 'SEND_TEXT' || actionType === 'SEND_IMAGE') {
        if (isGroupTask && !targetIsGroup) throw new Error('群聊群发只能选择群聊对象')
        if (!isGroupTask && targetIsGroup) throw new Error('好友群发不能选择群聊对象')
        if (!ownedKeysOf(instanceId).has(targetKey)) {
          if (isGroupTask && loadDirectoryExcludedRoomIdSetForInstance(instanceId).has(targetKey)) {
            throw new Error('所选群包含已登记被踢或已屏蔽的群，请刷新通讯录后重选')
          }
          throw new Error('所选微信不包含这个接收对象，请刷新通讯录后重试')
        }
      }
      let request = null
      if (actionType === 'SEND_TEXT') {
        const msg = String(item.request?.msg || '').trim()
        if (!msg) throw new Error('文字内容不能为空')
        request = {
          wxid: targetKey,
          msg,
          nickname: String(item.request?.nickname || '').trim(),
        }
      } else if (actionType === 'SEND_IMAGE') {
        const filepath = String(item.request?.filepath || '').trim()
        if (!filepath) throw new Error('图片路径不能为空')
        if (!existsSync(filepath)) throw new Error('图片文件不存在，请重新选择图片')
        request = {
          wxid: targetKey,
          filepath,
          nickname: String(item.request?.nickname || '').trim(),
        }
      } else if (item.request && typeof item.request === 'object') {
        request = item.request
      }
      const itemStatus = actionType === 'ADD_FRIEND' && item.status === 'PROFILE_PENDING' ? 'PROFILE_PENDING' : 'QUEUED'
      const runtime = instances.get(instanceId)
      const accountWxid = String(item.accountWxid || runtime?.accountWxid || '').trim()
      if (!accountWxid && ['SEND_TEXT', 'SEND_IMAGE', 'ADD_FRIEND', 'QR_SCAN', 'KICKED_GROUP_CLEANUP'].includes(actionType)) {
        throw new Error('微信账号身份未就绪，请等待登录资料读取完成后再创建任务')
      }
      return { id: randomUUID(), instanceId, accountWxid, targetKey, actionType, status: itemStatus, request }
    })
    if (isSendTask) {
      const hasText = items.some((item) => item.actionType === 'SEND_TEXT')
      const hasImage = items.some((item) => item.actionType === 'SEND_IMAGE')
      if (taskType.includes('MIXED') && !(hasText && hasImage)) throw new Error('图文混发任务必须同时包含文字和图片步骤')
      if (taskType.startsWith('SEND_TEXT') && hasImage) throw new Error('文字群发任务不能包含图片步骤')
      if (taskType.startsWith('SEND_IMAGE') && !taskType.includes('MIXED') && hasText) throw new Error('图片群发任务不能包含文字步骤')
    }
    const created = createTask(task, items)
    if (!created.inserted) throw new Error('任务没有可写入的目标')
    const row = listTasks().find((item) => item.id === task.id)
    return safeCloneForIpc({ ...(row || { id: task.id, name: task.name, type: task.type, status: task.status }), deduplicated: created.duplicates }, { id: task.id, deduplicated: created.duplicates })
  } catch (error) {
    const message = toUserErrorMessage(error, '创建任务失败')
    appLog('ERROR', '创建任务失败', {
      module: '任务中心',
      operation: 'CREATE_TASK',
      error: rawErrorMessage(error),
      message,
      itemCount: Array.isArray(payload?.items) ? payload.items.length : 0,
      type: String(payload?.type || ''),
    })
    // SqliteError 等不可 structured-clone，统一转成普通 Error，避免界面只看到「数据传输失败」
    throw new Error(message)
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
  return { id: value.id, apiPort: value.apiPort, tcpPort: value.tcpPort, pid: value.child?.pid ?? value.pid ?? null, accountWxid: value.accountWxid, nickname: value.nickname, alias: value.alias, avatar: value.avatar, status: value.status, managed: Boolean(value.managed), error: value.error, lastCallbackAt: value.lastCallbackAt, lastProbeAt: value.lastProbeAt }
}

function markInstanceStopped(record, reason = '微信已关闭') {
  if (record.status === 'STOPPED') return
  if (record.firstProbeTimer) {
    clearTimeout(record.firstProbeTimer)
    record.firstProbeTimer = null
  }
  clearInterval(record.probe)
  record.probe = null
  record.tcpServer?.close()
  record.tcpServer = null
  record.status = 'STOPPED'
  record.stoppedAt = Date.now()
  record.error = undefined
  record.pid = null
  record.wechatPid = null
  clearInstanceCache(record.id)
  cleanInstanceMaps(record.id)
  upsertInstance(record)
  appLog('INFO', reason, { instanceId: record.id, module: '微信状态' })
  pruneStoppedRuntimeInstances()
}

function markInstanceIdentityMismatch(record) {
  if (record.firstProbeTimer) {
    clearTimeout(record.firstProbeTimer)
    record.firstProbeTimer = null
  }
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
  clearInstanceCache(record.id)
  cleanInstanceMaps(record.id)
  upsertInstance(record)
  appLog('ERROR', '检测到登录微信与原记录不一致，已停止复用', { instanceId: record.id, module: '微信状态' })
}

function cleanInstanceMaps(instanceId) {
  lastRoomDetailFetchAt.delete(instanceId)
  roomDetailInflight.delete(instanceId)
  for (const [key] of qrInvitePreviewInflight) { if (key.startsWith(`${instanceId}|`)) qrInvitePreviewInflight.delete(key) }
  for (const [key] of qrInvitePreviewCache) { if (key.startsWith(`${instanceId}|`)) qrInvitePreviewCache.delete(key) }
  for (const [key] of friendCredentialInflight) { if (key.startsWith(`${instanceId}|`)) friendCredentialInflight.delete(key) }
  for (const [key] of qrMonitorRecentEvents) { if (key.startsWith(`${instanceId}|`)) qrMonitorRecentEvents.delete(key) }
  for (const [key] of qrValidityCache) { if (key.startsWith(`${instanceId}|`)) qrValidityCache.delete(key) }
  for (const [key] of qrMonitorSkipLogAt) { if (key.startsWith(`${instanceId}:`) || key.startsWith(`${instanceId}|`)) qrMonitorSkipLogAt.delete(key) }
  for (const [key] of chatAddMissLogAt) { if (key.startsWith(`${instanceId}:`)) chatAddMissLogAt.delete(key) }
  for (const [key] of kickedMutationDone) { if (key.includes(`|${instanceId}|`)) kickedMutationDone.delete(key) }
}

const STOPPED_RUNTIME_MAX = 20
const STOPPED_RUNTIME_TTL_MS = 24 * 60 * 60 * 1000

/**
 * 清理内存中过旧的 STOPPED runtime（保留 SQLite 历史 metadata）。
 */
function pruneStoppedRuntimeInstances() {
  const before = new Set(instances.keys())
  pruneStoppedRuntimeInMap(instances, { maxStopped: STOPPED_RUNTIME_MAX, ttlMs: STOPPED_RUNTIME_TTL_MS })
  for (const id of before) {
    if (!instances.has(id)) cleanInstanceMaps(id)
  }
}

/**
 * 同账号新实例 ONLINE 后：从 runtime Map 移除同账号旧 STOPPED（SQLite 保留）。
 * @param {{ id: string, accountWxid?: string }} record
 */
function pruneStoppedRuntimeForAccount(record) {
  const before = new Set(instances.keys())
  pruneStoppedRuntimeForAccountInMap(instances, record)
  for (const id of before) {
    if (!instances.has(id)) cleanInstanceMaps(id)
  }
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

function resumeQueuedTasks() {
  for (const task of listTasks().filter((item) => item.status === 'QUEUED')) {
    setImmediate(() => runTask(task.id))
  }
}

/**
 * 启动/登录后：先恢复实例，再恢复 QUEUED 任务，避免抢跑 FAILED。
 */
async function restoreInstancesThenResumeQueuedTasks() {
  await restoreInstances()
  migrateQrMonitorAccountWxids()
  pruneStoppedRuntimeInstances()
  resumeQueuedTasks()
}

/**
 * 解析任务执行微信；WAITING_INSTANCE 时有上限等待，不把 item 提前 FAILED。
 * @param {string} taskId
 * @param {object} item
 */
async function resolveTaskItemInstanceWithWait(taskId, item) {
  const first = resolveTaskItemInstance(item, instances)
  if (first.ok) return { ...first, stopped: false }
  const accountWxid = String(item?.account_wxid || item?.accountWxid || '').trim()
  if (first.code === 'WAITING_INSTANCE' && accountWxid) {
    appLog('INFO', '等待执行微信上线', {
      taskId,
      itemId: item.id,
      accountWxid,
      instanceId: item.instance_id,
      waitTimeoutMs: TASK_INSTANCE_WAIT_TIMEOUT_MS,
    })
    return waitForTaskInstance(item, {
      getInstances: () => instances,
      isStopRequested: () => isTaskStopRequested(taskId),
      getTaskStatus: () => String(listTasks().find((t) => t.id === taskId)?.status || ''),
      isRuntimeAllowed: () => runtimeAllowed,
      timeoutMs: TASK_INSTANCE_WAIT_TIMEOUT_MS,
      intervalMs: TASK_INSTANCE_WAIT_INTERVAL_MS,
      onWaiting: () => {
        appLog('INFO', '仍在等待执行微信上线', {
          taskId, itemId: item.id, accountWxid, module: '任务执行',
        })
      },
    })
  }
  return { ...first, stopped: false }
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
    if (record.firstProbeTimer) clearTimeout(record.firstProbeTimer)
    record.firstProbeTimer = setTimeout(() => {
      record.firstProbeTimer = null
      if (record.stopping || instances.get(record.id) !== record) return
      void probeInstance(record)
    }, 1000)
    if (typeof record.firstProbeTimer.unref === 'function') record.firstProbeTimer.unref()
    return { ok: true, data: publicInstance(record) }
  } catch (error) {
    if (record?.firstProbeTimer) {
      clearTimeout(record.firstProbeTimer)
      record.firstProbeTimer = null
    }
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

let ipcRegistered = false

function registerIpc() {
  // 启动中途失败时 catch 仍会创建窗口；必须可重复调用，避免登录页出现 No handler registered
  if (ipcRegistered) return
  ipcRegistered = true
  ipcMain.handle('auth:session', () => softwareAuth.session())
  ipcMain.handle('auth:login', async (_event, username, password) => {
    try {
      const account = await softwareAuth.login(username, password)
      if (instances.size === 0) {
        await restoreInstancesThenResumeQueuedTasks()
      } else {
        resumeQueuedTasks()
      }
      startRemoteAgent(remoteAgentOptions(account.username)).catch(() => {})
      const selfId = String(getRemoteAgentStatus()?.clientId || '')
      meshRemote.ensureLocalMeshAgent(selfId).catch(() => {})
      return { ok: true, account }
    } catch (error) { return { ok: false, error: toUserErrorMessage(error, '登录失败，请稍后重试') } }
  })
  ipcMain.handle('auth:register', async (_event, username, password) => {
    try {
      const account = await softwareAuth.register(username, password)
      if (instances.size === 0) {
        await restoreInstancesThenResumeQueuedTasks()
      } else {
        resumeQueuedTasks()
      }
      startRemoteAgent(remoteAgentOptions(account.username)).catch(() => {})
      const selfId = String(getRemoteAgentStatus()?.clientId || '')
      meshRemote.ensureLocalMeshAgent(selfId).catch(() => {})
      return { ok: true, account }
    } catch (error) { return { ok: false, error: toUserErrorMessage(error, '注册失败，请稍后重试') } }
  })
  ipcMain.handle('auth:logout', async () => { await softwareAuth.logout(); stopRemoteAgent(); return true })
  ipcMain.handle('system:metrics', () => softwareMetrics())
  ipcMain.handle('wechat:list-instances', async () => {
    await synchronizeInstanceProcesses()
    pruneStoppedRuntimeInstances()
    return [...instances.values()].map(publicInstance)
  })
  ipcMain.handle('wechat:start-instance', () => { requireRuntime(); return enqueueWechatInstanceStart() })
  ipcMain.handle('wechat:stop-instance', async (_event, id, closeWechat = true) => {
    const record = instances.get(id)
    if (!record) return { ok: false, error: '实例不存在' }
    record.stopping = true
    if (record.firstProbeTimer) {
      clearTimeout(record.firstProbeTimer)
      record.firstProbeTimer = null
    }
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
    cleanInstanceMaps(id)
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
      const timeout = resolveIpcApiTimeout(apiPath, timeoutMs)
      const isReadApi = READ_API_WHITELIST.has(apiPath)
      const { response, raw } = isReadApi
        ? await readApi(record, apiPath, body, { timeout })
        : await requestApi(record, apiPath, body, timeout)
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
  ipcMain.handle('tasks:list', () => safeCloneForIpc(listTasks(), []))
  ipcMain.handle('tasks:items', (_event, id) => safeCloneForIpc(getTaskItems(id), []))
  ipcMain.handle('tasks:create', (_event, payload) => { requireRuntime(); return createLocalTask(payload) }) // createLocalTask 内部已 safeClone + 普通 Error
  ipcMain.handle('tasks:confirm', (_event, payload) => {
    requireRuntime()
    const id = typeof payload === 'string' ? payload : String(payload?.id || payload?.taskId || '')
    if (!id) throw new Error('任务不存在')
    const task = listTasks().find((item) => item.id === id)
    if (!task) throw new Error('任务不存在')
    if (task.status !== 'WAITING_CONFIRMATION') throw new Error('任务当前不可确认')
    const intervalRaw = typeof payload === 'object' && payload ? Number(payload.intervalMs) : Number.NaN
    if (!Number.isFinite(intervalRaw) || intervalRaw < 0 || !Number.isInteger(intervalRaw)) {
      throw new Error('请设置执行间隔（毫秒，整数，可填 0）')
    }
    patchTaskConfig(id, { intervalMs: intervalRaw })
    setTaskStatus(id, 'QUEUED')
    setImmediate(() => runTask(id))
    return true
  })
  ipcMain.handle('tasks:pause', (_event, id) => { setTaskStatus(id, 'PAUSED'); return true })
  ipcMain.handle('tasks:resume', (_event, id) => {
    requireRuntime()
    const task = listTasks().find((item) => item.id === id)
    if (!task) throw new Error('任务不存在')
    if (!['PAUSED', 'COOLING_DOWN'].includes(String(task.status || ''))) throw new Error('当前状态不可继续，仅已暂停/冷却中的任务可继续')
    setTaskStatus(id, 'QUEUED')
    // 冷却等待中 runTask 仍占着 runningTasks：只改状态，让现有循环提前结束冷却并继续
    if (runningTasks.has(id)) return true
    setImmediate(() => runTask(id))
    return true
  })
  ipcMain.handle('tasks:cancel', (_event, id) => {
    requireRuntime()
    const taskId = String(id || '')
    const result = cancelTask(taskId)
    appLog('INFO', '任务已取消，停止后续执行', { taskId, released: result.released, module: '任务中心' })
    return result
  })
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
  ipcMain.handle('kicked-groups:cleanup', async (_event, payload) => {
    requireRuntime()
    if (kickedGroupCleanupActivePromise) {
      return { ok: false, queued: true, running: true, message: '被踢群扫描仍在执行，请等待完成后再操作' }
    }
    const options = payload && typeof payload === 'object' ? payload : {}
    const work = prepareKickedGroupCleanupTask('手动创建被踢群清理任务', {
      instanceId: String(options.instanceId || '').trim(),
    })
    kickedGroupCleanupActivePromise = work.finally(() => {
      kickedGroupCleanupActivePromise = null
      kickedGroupCleanupPreparing = false
    })
    const timeoutMs = 600000
    let timer = null
    try {
      return await Promise.race([
        kickedGroupCleanupActivePromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('扫描被踢群时间较长仍未返回。后台仍在扫描中，完成前请勿重复狂点创建。')), timeoutMs)
          if (typeof timer.unref === 'function') timer.unref()
        }),
      ])
    } catch (error) {
      throw error
    } finally {
      if (timer) clearTimeout(timer)
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
    clientId: String(getRemoteAgentStatus()?.clientId || ''),
  }))
  ipcMain.handle('update:apply', async (event) => {
    const sendProgress = (payload) => {
      try { event.sender.send('update:progress', payload) } catch { /* ignore */ }
      safeBroadcast('update:progress', payload)
    }
    sendProgress({ phase: 'download', downloaded: 0, total: 0, percent: 0 })
    const result = await ipcApplyClientUpdate({
      app,
      baseUrl: UPDATE_BASE,
      currentBuild: BUILD_ID,
      currentVersion: VERSION,
      currentReleaseSequence: RELEASE_SEQUENCE,
      isPackaged: app.isPackaged,
      clientId: String(getRemoteAgentStatus()?.clientId || ''),
      onLog: (level, message, details) => appLog(level, message, details),
      onProgress: (downloaded, total) => {
        const percent = total > 0 ? (downloaded * 100) / total : 0
        const now = Date.now()
        if (!updateDownloadMeter) updateDownloadMeter = { t0: now, bytes0: 0, lastT: now, lastBytes: 0, speedBps: 0 }
        const meter = updateDownloadMeter
        const dt = Math.max(1, now - meter.lastT)
        if (now - meter.lastT >= 500) {
          meter.speedBps = ((downloaded - meter.lastBytes) * 1000) / dt
          meter.lastT = now
          meter.lastBytes = downloaded
        }
        sendProgress({
          phase: 'download',
          downloaded,
          total,
          percent,
          speedBps: meter.speedBps,
        })
      },
    })
    updateDownloadMeter = null
    if (result.ok) sendProgress({ phase: 'installing', percent: 100, message: result.message || '新版本已启动，正在关闭旧版本…' })
    else sendProgress({ phase: 'error', percent: 0, message: result.message || '更新失败' })
    return result
  })
  ipcMain.handle('update:mark-done', () => { markStartupUpdateDone(); return true })
  ipcMain.handle('directory:sync', (_event, payload) => { syncDirectorySnapshot(payload); return true })
  ipcMain.handle('directory:list-blocked', () => listBlockedChatrooms())
  ipcMain.handle('directory:blocked-room-ids', (_event, instanceIds) => {
    const ids = Array.isArray(instanceIds) ? instanceIds.map(String).filter(Boolean) : []
    /** @type {Record<string, string[]>} */
    const out = {}
    for (const id of ids) out[id] = [...loadDirectoryExcludedRoomIdSetForInstance(id)]
    return out
  })
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
    for (const link of links) {
      const decodedText = normalizeQrText(link) || link
      const hash = contentHash(decodedText)
      saveQrItem({
        id: randomUUID(),
        sha256: hash,
        source: '链接导入',
        decodedText,
        qrType: classifyQrText(decodedText),
        status: 'REFERENCE_ONLY',
      })
    }
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
    // 与多账号容量对齐，避免确认弹窗只预览前几条
    const limited = urls.slice(0, 100)
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
      const preview = await fetchInvitePreviewCached(record, url)
      rows.push({ url, qrType: type, ...preview })
      await yieldMain()
    }
    return rows
  })
  ipcMain.handle('qr:monitor-status', () => ({
    ...qrMonitorConfig,
    watchAll: Boolean(qrMonitorConfig.watchAll),
    watchedCount: qrMonitorRoomByKey.size,
    queueStats: [...qrMonitorQueues.entries()].map(([instanceId, state]) => ({
      instanceId,
      active: state.active || 0,
      pending: state.pending?.length || 0,
    })),
  }))
  ipcMain.handle('qr:monitor-start', (_event, payload) => {
    const outputDir = String(payload?.outputDir || '').trim()
    const rooms = Array.isArray(payload?.rooms)
      ? payload.rooms.map((room) => {
        const instanceId = String(room.instanceId || '')
        const record = instances.get(instanceId)
        return {
          instanceId,
          accountWxid: String(room.accountWxid || record?.accountWxid || ''),
          roomId: String(room.roomId || ''),
          name: String(room.name || '群聊'),
        }
      }).filter((room) => room.instanceId && room.roomId.endsWith('@chatroom'))
      : []
    if (!outputDir || !path.isAbsolute(outputDir)) throw new Error('请先选择二维码保存文件夹')
    if (!rooms.length) throw new Error('请至少选择一个需要监控的群聊')
    mkdirSync(outputDir, { recursive: true })
    const watchAll = Boolean(payload?.watchAll)
    qrMonitorConfig = { enabled: true, watchAll, rooms, outputDir, folder: String(payload?.folder || '默认分组') }
    rebuildQrMonitorRoomIndex()
    recentQrContentHashes.clear()
    saveSetting('qrMonitor', qrMonitorConfig)
    ensureQrMonitorSyncTimer()
    appLog('INFO', '群消息二维码监控已开启', {
      module: '二维码监控',
      operation: '开启监控',
      groupCount: rooms.length,
      watchAll,
      concurrency: QR_MONITOR_CONCURRENCY,
    })
    return { ...qrMonitorConfig, watchedCount: qrMonitorRoomByKey.size }
  })
  ipcMain.handle('qr:monitor-stop', () => {
    qrMonitorConfig = { ...qrMonitorConfig, enabled: false }
    for (const [, state] of qrMonitorQueues) {
      const pending = state?.pending || []
      while (pending.length) {
        const item = pending.shift()
        try { item.resolve({ skipped: true }) } catch { /* ignore */ }
      }
      if ((state.active || 0) <= 0 && !pending.length) {
        /* map entry cleaned in pump finally */
      }
    }
    for (const [instanceId, state] of [...qrMonitorQueues.entries()]) {
      if ((state.active || 0) <= 0 && !(state.pending?.length)) qrMonitorQueues.delete(instanceId)
    }
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
      watchedCount: qrMonitorRoomByKey.size,
    }
  })
  ipcMain.handle('qr:delete', (_event, ids) => { deleteQrItems(Array.isArray(ids) ? ids : []); return listQrItems() })
  ipcMain.handle('qr:update-type', (_event, payload) => {
    const id = payload && typeof payload === 'object' ? String(payload.id || '') : ''
    const qrType = payload && typeof payload === 'object' ? String(payload.qrType || '') : ''
    const ok = updateQrItemType(id, qrType)
    return { ok, items: listQrItems() }
  })
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
    pruneClipboardImageCache(folder)
    const imagePath = path.join(folder, `clipboard-${Date.now()}-${randomUUID()}.png`)
    writeFileSync(imagePath, png)
    let previewDataUrl = ''
    try {
      const size = image.getSize()
      const maxEdge = 800
      const scale = Math.min(1, maxEdge / Math.max(size.width || 1, size.height || 1))
      const preview = scale < 1
        ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) })
        : image
      previewDataUrl = preview.toDataURL()
    } catch { previewDataUrl = '' }
    return { ok: true, path: imagePath, dataUrl: previewDataUrl, previewDataUrl }
  })
  ipcMain.handle('files:select-directory', async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog({ defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : undefined, properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? '' : result.filePaths[0]
  })
  /** 在资源管理器中打开文件所在目录并选中；路径仅目录时则打开该目录。 */
  ipcMain.handle('files:reveal-in-folder', async (_event, targetPath) => {
    const raw = typeof targetPath === 'string' ? targetPath.trim().replace(/^["']|["']$/g, '') : ''
    if (!raw || raw === '-') return { ok: false, message: '该记录没有保存路径' }
    try {
      const normalized = path.normalize(raw)
      if (existsSync(normalized)) {
        const st = statSync(normalized)
        if (st.isDirectory()) {
          const err = await shell.openPath(normalized)
          return err ? { ok: false, message: err } : { ok: true }
        }
        shell.showItemInFolder(normalized)
        return { ok: true }
      }
      const dir = path.dirname(normalized)
      if (dir && existsSync(dir)) {
        const err = await shell.openPath(dir)
        return err ? { ok: false, message: err } : { ok: true, message: '图片文件已不存在，已打开所在文件夹' }
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
  // MeshCentral remote maintenance (tokens stay in main; never expose embedUrl to renderer)
  // Renderer may only pass clientId — nodeId is resolved server-side.
  ipcMain.handle('mesh:status', async (_event, clientId) => meshRemote.getRemoteStatus(clientId))
  ipcMain.handle('mesh:open-desktop', async (_event, clientId) => meshRemote.openDesktopSession(clientId))
  ipcMain.handle('mesh:open-files', async (_event, clientId) => meshRemote.openFilesSession(clientId))
  ipcMain.handle('mesh:close-session', async () => meshRemote.closeSessionWindow())
  ipcMain.handle('mesh:agent-status', async () => {
    try {
      return await require('./mesh-agent-manager.cjs').getMeshAgentStatus()
    } catch (err) {
      return { ok: false, status: 'error', message: String(err?.message || err) }
    }
  })
  ipcMain.handle('mesh:agent-ensure', async (_event, clientId) => meshRemote.ensureLocalMeshAgent(clientId))
  // Internal ops cleanup — not exposed in Vue menus; IPC still validates.
  ipcMain.handle('mesh:agent-uninstall', async () => {
    try {
      return await require('./mesh-agent-manager.cjs').uninstallMeshAgent()
    } catch (err) {
      return { ok: false, code: 'MESH_UNINSTALL_FAILED', message: String(err?.message || err) }
    }
  })
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

/**
 * 与便携包/桌面快捷方式同一套图标（electron-builder win.icon）。
 * @returns {string}
 */
function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, 'app-icon.ico'),
    path.join(process.resourcesPath || '', 'app-icon.ico'),
    path.join(__dirname, 'tray-icon.png'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return path.join(__dirname, 'app-icon.ico')
}

/**
 * @param {{ width?: number, height?: number }} [size]
 * @returns {import('electron').NativeImage}
 */
function resolveAppNativeImage(size = {}) {
  const iconPath = resolveAppIconPath()
  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
  }
  const width = Number(size.width) || 0
  const height = Number(size.height) || 0
  if (width > 0 && height > 0 && !icon.isEmpty()) return icon.resize({ width, height })
  return icon
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
    icon: resolveAppIconPath(),
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
  const appIconPath = resolveAppIconPath()
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F4F5F7',
    icon: appIconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })
  mainWindow = win
  try { win.setIcon(appIconPath) } catch { /* 部分环境 setIcon 不可用 */ }
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
    // 托盘也用桌面同款图标，避免任务栏/托盘两套图不一致
    const icon = resolveAppNativeImage({ width: 16, height: 16 })
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
  try { installServiceCertificateTrust(session.defaultSession) } catch {}
  createSplashWindow()
  try {
    initStorage(app.getPath('userData'))
    softwareAuth.initSoftwareAuth(app.getPath('userData'))
    // 尽早注册 IPC：后续步骤失败时登录页仍能拿到 auth:login 等通道
    registerIpc()
    // 新版首次启动：清旧缓存/诊断落盘，保留设置、任务、登录态与设备身份
    try {
      const scrub = scrubLegacyCachesOnStartup({
        userDataDir: app.getPath('userData'),
        version: VERSION,
        portableExePath: resolvePortableExePath(),
        storage: { clearApiSamplesOnly },
      })
      if (!scrub.skipped) {
        appLog('INFO', '已清理旧版缓存目录', {
          module: '启动清理',
          removed: scrub.removed.length,
          dbRows: scrub.dbRows,
        })
      }
    } catch (error) {
      appLog('WARN', '启动缓存清理未完成', { module: '启动清理', error: rawErrorMessage(error) })
    }
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
        recentQrContentHashes.clear()
        ensureQrMonitorSyncTimer()
      }
    }
    // 轻量同步工作：先出界面；重活放到窗口之后
    recoverInterruptedTasks()
    loadApiContracts()
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
        safeBroadcast('update:startup-check')
      },
    })

    // 账号校验走网络，绝不 await 挡住启动后续；超时也只影响恢复实例 / MeshAgent
    void softwareAuth.session().then((account) => {
      if (!account) return
      // 远程 Agent 可并行；QUEUED 任务必须等 restoreInstances 完成后再恢复
      startRemoteAgent(remoteAgentOptions(account.username))
        .then((st) => {
          const selfId = String(st?.clientId || getRemoteAgentStatus()?.clientId || '')
          return meshRemote.ensureLocalMeshAgent(selfId)
        })
        .catch((error) => appLog('ERROR', '设备连接失败', { error: rawErrorMessage(error) }))
      restoreInstancesThenResumeQueuedTasks()
        .catch((error) => appLog('ERROR', '恢复微信实例失败', { error: rawErrorMessage(error) }))
    }).catch((error) => appLog('ERROR', '读取登录会话失败', { error: rawErrorMessage(error) }))

    app.on('activate', () => { showMainWindow() })
  } catch (error) {
    appLog('ERROR', '软件启动失败', { error: rawErrorMessage(error) })
    try {
      await dialog.showErrorBox('软件启动失败', toUserErrorMessage(error, '启动时发生错误，请重试或重新下载便携版'))
    } catch {}
    // 存储/清理等失败时仍尽量挂上 IPC，避免登录直接报 No handler registered
    try {
      try { softwareAuth.initSoftwareAuth(app.getPath('userData')) } catch {}
      registerIpc()
    } catch (ipcError) {
      appLog('ERROR', '启动失败后注册 IPC 仍失败', { error: rawErrorMessage(ipcError) })
    }
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
  if (runtimeCacheCleanupTimer) {
    clearInterval(runtimeCacheCleanupTimer)
    runtimeCacheCleanupTimer = null
  }
  try { stopUpdateScheduler() } catch {}
  stopRemoteAgent()
  tray?.destroy()
  tray = null
  for (const record of instances.values()) {
    clearInterval(record.probe)
    record.tcpServer?.close()
  }
})
