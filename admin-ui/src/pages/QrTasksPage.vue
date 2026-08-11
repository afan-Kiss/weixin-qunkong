<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import StatCard from '../components/cards/StatCard.vue'
import { groups, instances, refreshDirectory, refreshInstances } from '../stores/wechatData'
import { statusLabel } from '../utils/status'
import { userErrorMessage } from '../utils/error'
import { promptGoToTaskCenter } from '../utils/taskFlow'
import { filterSelectOptions, SELECT_OPTION_LIMIT_SEARCH, useSelectSearchQuery } from '../utils/searchableSelect'

const router = useRouter()
const activeTab = ref('链接导入')
const qrTabs = ['链接导入', '图片采集', '识别结果']
const importText = ref('')
const qrFormatTip = '每行一条群邀请链接；导入后勾选可创建进群任务。个人码无法通过本流程进群（会跳过）；本地图片仍可识别后进群。'
const applyText = ref('你好，想加入群聊')
const skipPersonal = ref(true)
const saveContact = ref(true)
const creating = ref(false)
const folder = ref('默认分组')
const outputDir = ref('')
const selectedMonitorRoomKeys = ref<string[]>([])
/** 通讯录尚未刷到的监控群：保留 instanceId，禁止绑定「第一个在线微信」 */
const orphanMonitorRoomsByKey = ref<Record<string, { instanceId: string; roomId: string; name: string }>>({})
const groupSearch = useSelectSearchQuery(120)
const collecting = ref(false)
const collectProgressText = ref('')
const monitorEnabled = ref(false)
const monitorWatchAll = ref(true)
const monitorWatchedCount = ref(0)
const monitorQueueText = ref('')
let stopMonitorListener: (() => void) | undefined
let stopMonitorRoomsListener: (() => void) | undefined
let stopCollectProgress: (() => void) | undefined
let monitorQueueTimer: ReturnType<typeof setInterval> | undefined
/** 监控结果合并刷新，避免 150 群同时入库时疯狂弹窗/刷表 */
let monitorResultTimer: ReturnType<typeof setTimeout> | undefined
let monitorResultBucket = { saved: 0, duplicates: 0, expired: 0, rooms: new Set<string>() }
const limitPerAccount = ref(20)
const coolMinutes = ref(30)
const rawRecords = ref<Array<Record<string, unknown>>>([])
const selected = ref<Array<Record<string, unknown>>>([])
/** 执行方式：all=所选微信×全部已选群；manual=按群手动分配 */
const assignMode = ref<'all' | 'manual'>('all')
const selectedExecutorIds = ref<string[]>([])
const executorSearch = ref('')
/** 手动模式：二维码记录 id → 执行微信 instanceId 列表 */
const manualExecutorsByQrId = ref<Record<string, string[]>>({})
const assignPreviewOpen = ref(false)
const batchAssignVisible = ref(false)
const batchAssignIds = ref<string[]>([])
const batchAssignMode = ref<'add' | 'replace'>('add')
const batchDialogExecutorIds = ref<string[]>([])
const manualPickQrId = ref('')
const manualPickVisible = ref(false)
const manualPickIds = ref<string[]>([])
/**
 * 去重列文案与样式：重复未落盘为红色「重复-不下载」，否则绿色「可下载」。
 * @param row 原始二维码记录
 */
function dedupeDisplay(row: Record<string, unknown>) {
  const status = String(row.status || '')
  const sha = String(row.sha256 || '')
  const isDuplicate = status === 'DUPLICATE' || sha.startsWith('dup:')
  return isDuplicate
    ? { text: '重复-不下载', className: 'dedupe-dup' }
    : { text: '可下载', className: 'dedupe-ok' }
}

/** 缓存/入库时间：月-日 时:分 */
function formatCacheTime(value: unknown) {
  if (!value) return '-'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return '-'
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${month}-${day} ${hour}:${minute}`
}

/** 记录表类型筛选（统一筛选，不是逐行改类型） */
const typeFilter = ref('全部')
const qrTypeFilterChips = [
  { value: '全部', label: '全部' },
  { value: 'GROUP_LINK', label: '群二维码' },
  { value: 'PERSONAL_LINK', label: '个人二维码' },
  { value: 'QQ_GROUP_LINK', label: 'QQ群二维码' },
  { value: 'UNKNOWN', label: '未知/其他' },
]

const qrRecords = computed(() => {
  const mapped = rawRecords.value.map((row) => {
    const dedupe = dedupeDisplay(row)
    const qrType = String(row.qrType || 'UNKNOWN')
    return {
      ...row,
      thumb: row.localPath ? '图' : '链',
      cacheTime: formatCacheTime(row.createdAt),
      source: row.source,
      result: row.decodedText || '-',
      qrType,
      type: statusLabel(qrType),
      dedupe: dedupe.text,
      dedupeClass: dedupe.className,
      path: row.localPath || '-',
      status: statusLabel(row.status),
    }
  })
  if (typeFilter.value === '全部') return mapped
  if (typeFilter.value === 'UNKNOWN') {
    return mapped.filter((row) => !['GROUP_LINK', 'PERSONAL_LINK', 'QQ_GROUP_LINK'].includes(String(row.qrType)))
  }
  return mapped.filter((row) => String(row.qrType) === typeFilter.value)
})

/** 切换类型筛选时清空勾选，避免选中已隐藏行。 */
function setTypeFilter(value: string) {
  typeFilter.value = value
  selected.value = []
}
const qrOverview = computed(() => [{ title: '全部', value: String(rawRecords.value.length) }, { title: '待识别', value: String(rawRecords.value.filter((item) => item.status === 'WAITING_SCAN').length) }, { title: '链接归档', value: String(rawRecords.value.filter((item) => item.status === 'REFERENCE_ONLY').length) }, { title: '可执行图片', value: String(rawRecords.value.filter((item) => item.localPath).length) }])
const historyGroupOptions = computed(() => groups.value.map((item) => ({ label: `${item.name}（${instances.value.find((instance) => instance.id === item.sourceInstanceId)?.nickname || '所属微信'}）`, value: item.id })))
/** 当前勾选的群名，便于确认实时监控目标。 */
const selectedGroupNames = computed(() => {
  const map = new Map(historyGroupOptions.value.map((item) => [item.value, item.label]))
  return selectedMonitorRoomKeys.value.map((id) => map.get(id) || id)
})
const monitorTargetText = computed(() => {
  if (!monitorEnabled.value) return '未开启实时监控：发图不会自动采集，请先勾选目标群并点「开启群消息监控」。'
  const names = selectedGroupNames.value
  const count = monitorWatchedCount.value || names.length
  if (!count) return '监控已开，但未勾选群聊。'
  const shown = names.slice(0, 3).join('、')
  const more = names.length > 3 ? ` 等 ${count} 个群` : ''
  const grow = monitorWatchAll.value ? '；含新进群自动扩容' : ''
  const queue = monitorQueueText.value ? `；${monitorQueueText.value}` : ''
  return `实时监控中（${count} 个群，队列并发下载）${grow}：${shown}${more || (names.length ? '' : `已监控 ${count} 个群`)}${queue}`
})
const visibleHistoryGroupOptions = computed(() => filterSelectOptions(
  historyGroupOptions.value,
  groupSearch.query.value,
  selectedMonitorRoomKeys.value,
  groupSearch.query.value.trim() ? SELECT_OPTION_LIMIT_SEARCH : undefined,
))
/** 一键全选采集/监控群聊。 */
function selectAllHistoryGroups() {
  selectedMonitorRoomKeys.value = historyGroupOptions.value.map((item) => item.value)
}
/** 清空已选群聊。 */
function clearHistoryGroups() {
  selectedMonitorRoomKeys.value = []
}

/** 拉取监控下载队列状态，便于 150+ 群时感知积压。 */
async function refreshMonitorQueueStatus() {
  if (!monitorEnabled.value) {
    monitorQueueText.value = ''
    return
  }
  try {
    const status = await window.wxControl?.qrMonitorStatus()
    const stats = Array.isArray((status as { queueStats?: Array<{ active: number; pending: number }> })?.queueStats)
      ? (status as { queueStats: Array<{ active: number; pending: number }> }).queueStats
      : []
    const active = stats.reduce((sum, item) => sum + (Number(item.active) || 0), 0)
    const pending = stats.reduce((sum, item) => sum + (Number(item.pending) || 0), 0)
    monitorWatchedCount.value = Number((status as { watchedCount?: number })?.watchedCount || status?.rooms?.length || monitorWatchedCount.value)
    monitorQueueText.value = pending > 0 || active > 0 ? `下载中 ${active} / 排队 ${pending}` : '队列空闲'
  } catch {
    /* 状态读取失败不打断监控 */
  }
}

function startMonitorQueuePolling() {
  stopMonitorQueuePolling()
  void refreshMonitorQueueStatus()
  monitorQueueTimer = setInterval(() => { void refreshMonitorQueueStatus() }, 2500)
}
function stopMonitorQueuePolling() {
  if (monitorQueueTimer) clearInterval(monitorQueueTimer)
  monitorQueueTimer = undefined
  monitorQueueText.value = ''
}
async function refresh() { await refreshInstances(); await refreshDirectory(); rawRecords.value = (await window.wxControl?.listQrItems() ?? []) as Array<Record<string, unknown>> }
async function refreshRecords() { rawRecords.value = (await window.wxControl?.listQrItems() ?? []) as Array<Record<string, unknown>> }
async function importLinks() { if (!importText.value.trim()) return ElMessage.warning('请输入链接'); rawRecords.value = (await window.wxControl?.importQrLinks(importText.value) ?? []) as Array<Record<string, unknown>>; ElMessage.success('链接已按 SHA-256 去重归档') }
async function importFiles() { rawRecords.value = (await window.wxControl?.importQrFiles() ?? []) as Array<Record<string, unknown>> }
async function chooseOutputDir() { outputDir.value = await window.wxControl?.selectDirectory(outputDir.value) || outputDir.value }
/**
 * 双击识别结果 / 记录行：在资源管理器中定位并选中该二维码图片。
 * @param row 表格行
 */
async function revealQrImage(row: Record<string, unknown>) {
  const target = String(row.localPath || row.path || '').trim()
  if (!target || target === '-') {
    ElMessage.info('该记录没有本地二维码图片（链接导入项无图片文件）')
    return
  }
  try {
    const result = await window.wxControl?.revealInFolder?.(target)
    if (!result?.ok) ElMessage.warning(result?.message || '无法在资源管理器中定位该图片')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '定位图片失败')
  }
}
/**
 * 采集勾选群的历史图片二维码；按队列逐群下载，不限制群数量。
 */
async function collectHistory() {
  if (!selectedMonitorRoomKeys.value.length) return ElMessage.warning('请至少选择一个群聊')
  if (!outputDir.value) return ElMessage.warning('请先选择二维码保存文件夹')
  const selectedRooms = groups.value
    .filter((item) => selectedMonitorRoomKeys.value.includes(item.id))
    .map((item) => ({ instanceId: item.sourceInstanceId, roomId: item.roomId, name: item.name }))
  collecting.value = true
  collectProgressText.value = `队列准备中，共 ${selectedRooms.length} 个群…`
  // 先让出一帧，确保 loading / 进度文案渲染出来，避免一点击就假死
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)))
  stopCollectProgress?.()
  stopCollectProgress = window.wxControl?.onQrCollectProgress?.((detail) => {
    if (detail.phase === 'room') {
      collectProgressText.value = `队列 ${detail.roomIndex}/${detail.roomTotal}：${detail.roomName || ''}`
      return
    }
    collectProgressText.value = `队列 ${detail.roomIndex || '?'}/${detail.roomTotal || '?'} ${detail.roomName || ''} 图片 ${detail.checked || 0}/${detail.total || 0}（已保存 ${detail.saved || 0}）`
  })
  try {
    const result = await window.wxControl?.collectQrHistory({
      rooms: selectedRooms,
      outputDir: outputDir.value,
      folder: folder.value,
      maxImages: 0, // 0 = 每群检查全部历史图片
    })
    await refreshRecords()
    ElMessage.success(`采集完成：共 ${result?.groups || selectedRooms.length} 个群，保存 ${result?.saved || 0} 个，去重 ${result?.duplicates || 0} 个，非二维码 ${result?.nonQr || 0} 张，无法下载 ${result?.unavailable || 0} 张`)
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '群聊二维码采集失败，请到日志查看原因') }
  finally {
    collecting.value = false
    collectProgressText.value = ''
    stopCollectProgress?.()
    stopCollectProgress = undefined
  }
}
function monitorRoomKey(instanceId: string, roomId: string) {
  return `${instanceId}\u0000${roomId}`
}

function selectedRooms() {
  const keySet = new Set(selectedMonitorRoomKeys.value)
  const fromDirectory = groups.value.filter((item) => keySet.has(item.id))
  const knownKeys = new Set(fromDirectory.map((item) => item.id))
  const orphanRooms = selectedMonitorRoomKeys.value
    .map((key) => orphanMonitorRoomsByKey.value[key])
    .filter((item): item is { instanceId: string; roomId: string; name: string } => Boolean(item?.instanceId && item?.roomId))
    .filter((item) => !knownKeys.has(monitorRoomKey(item.instanceId, item.roomId)))
  return [
    ...fromDirectory.map((item) => ({ instanceId: item.sourceInstanceId, roomId: item.roomId, name: item.name })),
    ...orphanRooms,
  ]
}
/**
 * 用主进程监控 rooms 回填勾选（进群扩容后 UI 同步增长）。
 * @param rooms 监控群
 */
function applyMonitorRoomsToSelection(rooms: Array<{ roomId: string; instanceId?: string; name?: string }> = []) {
  const normalized = rooms
    .map((room) => ({
      instanceId: String(room.instanceId || '').trim(),
      roomId: String(room.roomId || '').trim(),
      name: String(room.name || '群聊'),
    }))
    .filter((room) => room.instanceId && room.roomId.endsWith('@chatroom'))
  if (!normalized.length) return
  const normalizedKeys = new Set(normalized.map((room) => monitorRoomKey(room.instanceId, room.roomId)))
  const matched = groups.value
    .filter((group) => normalizedKeys.has(monitorRoomKey(group.sourceInstanceId, group.roomId)))
    .map((group) => group.id)
  const orphans = normalized.filter((room) => !groups.value.some((group) => group.sourceInstanceId === room.instanceId && group.roomId === room.roomId))
  for (const room of orphans) {
    orphanMonitorRoomsByKey.value[monitorRoomKey(room.instanceId, room.roomId)] = room
  }
  selectedMonitorRoomKeys.value = [...new Set([
    ...matched,
    ...orphans.map((room) => monitorRoomKey(room.instanceId, room.roomId)),
  ])]
  monitorWatchedCount.value = normalized.length
}

async function startMonitor() {
  if (!selectedMonitorRoomKeys.value.length) return ElMessage.warning('请至少选择一个需要监控的群聊')
  if (!outputDir.value) return ElMessage.warning('请先选择二维码保存文件夹')
  try {
    const rooms = selectedRooms()
    const selectedSet = new Set(selectedMonitorRoomKeys.value)
    const allCurrentSelected = historyGroupOptions.value.length > 0
      && historyGroupOptions.value.every((option) => selectedSet.has(option.value))
    const watchAll = monitorWatchAll.value || allCurrentSelected
    monitorWatchAll.value = watchAll
    await window.wxControl?.startQrMonitor({ rooms, outputDir: outputDir.value, folder: folder.value, watchAll })
    monitorEnabled.value = true
    monitorWatchedCount.value = rooms.length
    startMonitorQueuePolling()
    ElMessage.success(watchAll
      ? `群消息二维码监控已开启（${rooms.length} 个群，新进群将自动加入）`
      : `群消息二维码监控已开启（${rooms.length} 个群，队列下载）`)
  } catch (error) { ElMessage.error(userErrorMessage(error, '开启群消息二维码监控失败')) }
}
async function stopMonitor() {
  try {
    await window.wxControl?.stopQrMonitor()
    monitorEnabled.value = false
    monitorWatchedCount.value = 0
    stopMonitorQueuePolling()
    ElMessage.success('群消息二维码监控已停止')
  } catch (error) { ElMessage.error(userErrorMessage(error, '停止群消息二维码监控失败')) }
}

/** 手动触发一次监控群列表扩容同步，并刷新本地通讯录勾选。 */
async function syncMonitorRoomsNow() {
  if (!monitorEnabled.value) return ElMessage.warning('请先开启群消息监控')
  if (!monitorWatchAll.value) return ElMessage.warning('请先勾选「监控全部群（含新进群自动扩容）」')
  try {
    const status = await window.wxControl?.syncQrMonitorRooms?.()
    await refreshDirectory()
    if (status?.rooms) applyMonitorRoomsToSelection(status.rooms)
    monitorWatchedCount.value = Number(status?.watchedCount || status?.rooms?.length || monitorWatchedCount.value)
    ElMessage.success(`已同步监控群：当前 ${monitorWatchedCount.value} 个`)
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '同步监控群失败'))
  }
}
/** 合并短时间内的监控入库结果，降低 UI 压力。 */
function flushMonitorResultBucket() {
  monitorResultTimer = undefined
  const bucket = monitorResultBucket
  monitorResultBucket = { saved: 0, duplicates: 0, expired: 0, rooms: new Set<string>() }
  void refreshRecords()
  if (bucket.saved > 0) {
    ElMessage.success(`监控入库：保存 ${bucket.saved} 个（${bucket.rooms.size || 1} 个群）`)
    return
  }
  if (bucket.expired > 0) {
    ElMessage.info(`监控：${bucket.expired} 个二维码已过期，未保存`)
    return
  }
  if (bucket.duplicates > 0) {
    ElMessage.info(`监控：${bucket.duplicates} 个已存在，未重复保存`)
  }
}
async function initialize() {
  try { await refresh() } catch (error) { ElMessage.error(userErrorMessage(error, '读取二维码采集信息失败')) }
  try {
    const settings = await window.wxControl?.getSettings?.()
    const qrDir = settings?.general && typeof settings.general === 'object'
      ? String((settings.general as Record<string, unknown>).qrDir || '')
      : ''
    if (qrDir && !outputDir.value) outputDir.value = qrDir
  } catch { /* 设置读取失败不阻断 */ }
  const status = await window.wxControl?.qrMonitorStatus()
  if (status) {
    monitorEnabled.value = status.enabled
    monitorWatchAll.value = Boolean(status.watchAll)
    outputDir.value = status.outputDir || outputDir.value
    folder.value = status.folder || folder.value
    monitorWatchedCount.value = Number(status.watchedCount || status.rooms?.length || 0)
    applyMonitorRoomsToSelection(status.rooms || [])
    if (status.enabled) startMonitorQueuePolling()
  }
  stopMonitorListener = window.wxControl?.onQrMonitorResult((result) => {
    if (result.saved) monitorResultBucket.saved += Number(result.saved) || 0
    if (result.duplicates) monitorResultBucket.duplicates += Number(result.duplicates) || 0
    if (result.expired) monitorResultBucket.expired += Number(result.expired) || 0
    if (result.roomName) monitorResultBucket.rooms.add(String(result.roomName))
    if (!monitorResultTimer) monitorResultTimer = setTimeout(flushMonitorResultBucket, 2000)
  })
  stopMonitorRoomsListener = window.wxControl?.onQrMonitorRoomsChanged?.(async (payload) => {
    monitorEnabled.value = Boolean(payload.enabled)
    monitorWatchAll.value = Boolean(payload.watchAll)
    monitorWatchedCount.value = Number(payload.watchedCount || payload.rooms?.length || 0)
    // 新进群后通讯录可能还没刷新：先扩勾选，再静默拉一次目录
    applyMonitorRoomsToSelection(payload.rooms || [])
    try {
      await refreshDirectory()
      applyMonitorRoomsToSelection(payload.rooms || [])
    } catch { /* 目录刷新失败不阻断监控 */ }
    if (payload.added?.length) {
      ElMessage.success(`监控群已自动扩容 +${payload.added.length}，当前 ${monitorWatchedCount.value} 个`)
    }
  })
}
/**
 * 判断记录是否可执行进群/识别（需先勾选）。
 * @param item 二维码记录
 */
function isExecutableQr(item: Record<string, unknown>) {
  const text = String(item.decodedText || '')
  const type = String(item.qrType || '')
  if (type === 'QQ_GROUP_LINK') return false
  if (text && (type === 'GROUP_LINK' || type === 'PERSONAL_LINK')) return true
  if (item.localPath) return true
  return Boolean(text) && (type === 'GROUP_LINK' || type === 'PERSONAL_LINK' || /weixin\.qq\.com\/g\/|addchatroombyinvite/i.test(text))
}

function instanceLabel(inst: { nickname?: string; alias?: string; accountWxid?: string; id: string }) {
  return String(inst.nickname || inst.alias || inst.accountWxid || inst.id).trim() || inst.id
}

function parseSourceParts(source: unknown) {
  const text = String(source || '').trim()
  if (!text) return { label: '-', wxid: '-' }
  const parts = text.split('·').map((part) => part.trim()).filter(Boolean)
  if (parts.length >= 2) return { label: parts[0], wxid: parts.slice(1).join(' · ') }
  return { label: text, wxid: '-' }
}

const executableSelected = computed(() => selected.value.filter((item) => isExecutableQr(item)))
const sourceAccountCount = computed(() => {
  const keys = new Set<string>()
  for (const row of rawRecords.value) {
    const src = String(row.source || '').trim()
    if (src) keys.add(src.split('·')[0]?.trim() || src)
  }
  return keys.size
})

const executorCandidates = computed(() => {
  const q = executorSearch.value.trim().toLowerCase()
  return instances.value
    .slice()
    .sort((a, b) => {
      const ao = a.status === 'ONLINE' ? 0 : 1
      const bo = b.status === 'ONLINE' ? 0 : 1
      if (ao !== bo) return ao - bo
      return instanceLabel(a).localeCompare(instanceLabel(b), 'zh-CN')
    })
    .filter((inst) => {
      if (!q) return true
      const hay = `${inst.nickname || ''} ${inst.alias || ''} ${inst.accountWxid || ''} ${inst.id}`.toLowerCase()
      return hay.includes(q)
    })
})

const selectedExecutors = computed(() => {
  const idSet = new Set(selectedExecutorIds.value)
  return instances.value.filter((inst) => idSet.has(inst.id) && inst.status === 'ONLINE')
})

function manualExecutorIdsFor(qrId: string) {
  return manualExecutorsByQrId.value[qrId] || []
}

function manualExecutorLabels(qrId: string) {
  const ids = manualExecutorIdsFor(qrId)
  if (!ids.length) return '未分配'
  return ids.map((id) => {
    const inst = instances.value.find((row) => row.id === id)
    return inst ? instanceLabel(inst) : id.slice(0, 8)
  }).join('、')
}

/** 预计任务对数（群×执行微信），不含限额裁剪 */
const plannedPairs = computed(() => {
  const groups = executableSelected.value
  if (!groups.length) return [] as Array<{ qr: Record<string, unknown>; instanceId: string }>
  if (assignMode.value === 'all') {
    const execs = selectedExecutors.value
    const pairs: Array<{ qr: Record<string, unknown>; instanceId: string }> = []
    for (const inst of execs) {
      for (const qr of groups) pairs.push({ qr, instanceId: inst.id })
    }
    return pairs
  }
  const pairs: Array<{ qr: Record<string, unknown>; instanceId: string }> = []
  for (const qr of groups) {
    const qrId = String(qr.id || '')
    const execIds = [...new Set(manualExecutorIdsFor(qrId))]
      .filter((id) => instances.value.some((inst) => inst.id === id && inst.status === 'ONLINE'))
    for (const instanceId of execIds) pairs.push({ qr, instanceId })
  }
  return pairs
})

const plannedTaskCount = computed(() => plannedPairs.value.length)

const accountWorkload = computed(() => {
  const map = new Map<string, number>()
  for (const pair of plannedPairs.value) {
    map.set(pair.instanceId, (map.get(pair.instanceId) || 0) + 1)
  }
  const limit = Math.max(Number(limitPerAccount.value) || 0, 0)
  return [...map.entries()].map(([id, assigned]) => {
    const inst = instances.value.find((row) => row.id === id)
    return {
      id,
      label: inst ? instanceLabel(inst) : id,
      assigned,
      capped: limit > 0 ? Math.min(assigned, limit) : assigned,
      limit,
    }
  })
})

function selectOnlineExecutors() {
  selectedExecutorIds.value = instances.value.filter((item) => item.status === 'ONLINE').map((item) => item.id)
}
function clearExecutors() {
  selectedExecutorIds.value = []
}
function selectNormalExecutors() {
  selectedExecutorIds.value = instances.value.filter((item) => item.status === 'ONLINE').map((item) => item.id)
}
function toggleExecutor(id: string, online: boolean) {
  if (!online) return
  const set = new Set(selectedExecutorIds.value)
  if (set.has(id)) set.delete(id)
  else set.add(id)
  selectedExecutorIds.value = [...set]
}
function setExecutorChecked(id: string, checked: boolean, online: boolean) {
  if (!online) return
  const set = new Set(selectedExecutorIds.value)
  if (checked) set.add(id)
  else set.delete(id)
  selectedExecutorIds.value = [...set]
}

function openManualPick(row: Record<string, unknown>) {
  const qrId = String(row.id || '')
  if (!qrId) return
  manualPickQrId.value = qrId
  manualPickIds.value = [...manualExecutorIdsFor(qrId)]
  manualPickVisible.value = true
}
function saveManualPick() {
  const qrId = manualPickQrId.value
  if (!qrId) return
  manualExecutorsByQrId.value = {
    ...manualExecutorsByQrId.value,
    [qrId]: [...new Set(manualPickIds.value.filter((id) => instances.value.some((inst) => inst.id === id && inst.status === 'ONLINE')))],
  }
  manualPickVisible.value = false
}
function openBatchAssign() {
  const ids = executableSelected.value.map((row) => String(row.id || '')).filter(Boolean)
  if (!ids.length) return ElMessage.warning('请先勾选要分配的群资源')
  batchAssignIds.value = ids
  batchDialogExecutorIds.value = []
  batchAssignMode.value = 'add'
  batchAssignVisible.value = true
}
function confirmBatchAssign() {
  const execIds = [...new Set(batchDialogExecutorIds.value)]
    .filter((id) => instances.value.some((inst) => inst.id === id && inst.status === 'ONLINE'))
  if (!execIds.length) return ElMessage.warning('请选择至少一个在线执行微信')
  const next = { ...manualExecutorsByQrId.value }
  for (const qrId of batchAssignIds.value) {
    if (batchAssignMode.value === 'replace') next[qrId] = [...execIds]
    else next[qrId] = [...new Set([...(next[qrId] || []), ...execIds])]
  }
  manualExecutorsByQrId.value = next
  batchAssignVisible.value = false
  ElMessage.success(`已为 ${batchAssignIds.value.length} 个群更新执行微信`)
}
function clearManualAssignSelected() {
  const ids = executableSelected.value.map((row) => String(row.id || '')).filter(Boolean)
  if (!ids.length) return ElMessage.warning('请先勾选要清除的群')
  const next = { ...manualExecutorsByQrId.value }
  for (const id of ids) delete next[id]
  manualExecutorsByQrId.value = next
  ElMessage.success(`已清除 ${ids.length} 个群的执行微信`)
}

function buildQrTaskItem(qr: Record<string, unknown>, instanceId: string, previewByUrl: Map<string, { roomName?: string; label?: string; memberCount?: number }>) {
  const qrKey = String(qr.sha256 || qr.id || '').trim()
  const targetKey = `${instanceId}::${qrKey}`
  const localPath = String(qr.localPath || '').trim()
  const sourceLabel = String(qr.source || '').trim()
  const qrType = String(qr.qrType || '').trim()
  const baseRequest: Record<string, unknown> = {
    qrSha: qrKey,
    qrItemId: String(qr.id || ''),
    sourceLabel,
    executorInstanceId: instanceId,
    ...(qrType ? { qrType } : {}),
  }
  if (qr.decodedText) {
    const url = String(qr.decodedText)
    const preview = previewByUrl.get(url.trim()) || previewByUrl.get(url)
    const roomName = String(preview?.roomName || '').trim()
    const usableName = roomName && roomName !== '未知群名' ? roomName : ''
    const labelRaw = String(preview?.label || '').trim()
    const label = usableName && labelRaw && !/未知群名|二维码目标/.test(labelRaw) ? labelRaw : ''
    const memberCount = Number(preview?.memberCount) || 0
    return {
      instanceId,
      targetKey,
      request: {
        ...baseRequest,
        url,
        ...(localPath ? { path: localPath, localPath } : {}),
        ...(usableName ? { roomName: usableName } : {}),
        ...(label ? { label } : {}),
        ...(memberCount > 0 ? { memberCount } : {}),
      },
    }
  }
  return {
    instanceId,
    targetKey,
    request: {
      ...baseRequest,
      path: localPath || qr.localPath,
      ...(localPath ? { localPath } : {}),
    },
  }
}

/**
 * 创建识别/进群任务：按「已选群 × 已选执行微信」生成账号-群任务（非轮询均分）。
 * @param rows 勾选记录
 */
async function createScanTask(rows = selected.value) {
  if (!rows.length) return ElMessage.warning('请选择至少一个微信群')
  const executable = rows.filter((item) => isExecutableQr(item))
  if (!executable.length) return ElMessage.warning('勾选的记录无可执行项：请勾选本地图片或群二维码链接')

  let pairs = plannedPairs.value
  if (rows !== selected.value) {
    // 单行快捷进群：仍要求已选执行微信（all 模式）或该行已手动分配
    if (assignMode.value === 'all') {
      const execs = selectedExecutors.value
      if (!execs.length) return ElMessage.warning('请选择至少一个执行微信')
      pairs = []
      for (const inst of execs) {
        for (const qr of executable) pairs.push({ qr, instanceId: inst.id })
      }
    } else {
      pairs = []
      for (const qr of executable) {
        const qrId = String(qr.id || '')
        const execIds = [...new Set(manualExecutorIdsFor(qrId))]
          .filter((id) => instances.value.some((inst) => inst.id === id && inst.status === 'ONLINE'))
        for (const instanceId of execIds) pairs.push({ qr, instanceId })
      }
    }
  }

  if (!pairs.length) {
    if (assignMode.value === 'manual') return ElMessage.warning('请为已选群分配至少一个在线执行微信')
    return ElMessage.warning('请选择至少一个执行微信')
  }
  const onlineExecIds = new Set(instances.value.filter((item) => item.status === 'ONLINE').map((item) => item.id))
  const usablePairs = pairs.filter((pair) => onlineExecIds.has(pair.instanceId))
  if (!usablePairs.length) return ElMessage.warning('当前没有可执行的微信账号（需在线已登录）')

  const uniqueGroups = new Set(usablePairs.map((pair) => String(pair.qr.id || pair.qr.sha256 || '')))
  const uniqueExecs = new Set(usablePairs.map((pair) => pair.instanceId))
  const previewInstanceId = [...uniqueExecs][0]
  const linkRows = [...new Map(
    usablePairs
      .map((pair) => pair.qr)
      .filter((item) => String(item.decodedText || '').trim())
      .map((item) => [String(item.sha256 || item.id), item]),
  ).values()]
  const imageOnly = uniqueGroups.size - linkRows.length
  creating.value = true
  try {
    let previewBlock = ''
    const previewByUrl = new Map<string, { roomName?: string; label?: string; memberCount?: number }>()
    if (linkRows.length && previewInstanceId) {
      ElMessage.info('正在解析群资料（群名/人数）…')
      // 创建确认只需抽样预览，避免一次对几十上百条邀请连环打 a8key
      const previewLimit = 20
      const previewRows = linkRows.slice(0, previewLimit)
      const previews = await window.wxControl?.previewQrInvites?.({
        instanceId: previewInstanceId,
        urls: previewRows.map((item) => String(item.decodedText)),
      }) ?? []
      previewRows.forEach((row, index) => {
        const preview = previews[index]
        if (!preview) return
        for (const key of [row.decodedText, preview.url, preview.fullUrl]) {
          const url = String(key || '').trim()
          if (url) previewByUrl.set(url, preview)
        }
      })
      const escapeHtml = (value: string) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
      const invalid = previews.filter((item) => item.expired || item.error)
      const invalidSet = new Set(invalid)
      const resolved = previews.filter((item) => !invalidSet.has(item) && (item.roomName || Number(item.memberCount) > 0))
      const pendingPreviewCount = previews.length - resolved.length - invalid.length
      const lines = resolved.slice(0, 20).map((item, index) => {
        const name = item.roomName || '未知群名'
        const count = Number(item.memberCount) > 0 ? `${item.memberCount} 人` : '人数未知'
        return `${index + 1}. <b>${escapeHtml(name)}</b>（${escapeHtml(count)}）`
      })
      if (linkRows.length > previewLimit) {
        lines.push(`另有 ${linkRows.length - previewLimit} 个群邀请未在创建前预览（执行时再解析，避免狂打接口）`)
      }
      if (pendingPreviewCount > 0) lines.push(`<b>${pendingPreviewCount} 个群邀请</b>暂时无法读取群名和人数，执行任务时仍会逐个尝试`)
      if (invalid.length > 0) lines.push(`<b>${invalid.length} 个邀请无效</b>：${escapeHtml(invalid[0].error || '邀请已过期')}`)
      previewBlock = lines.length
        ? `将进群的目标：<br/>${lines.join('<br/>')}<br/><br/>`
        : '未能解析出群资料，仍可尝试提交（结果以微信实际为准）。<br/><br/>'
    }
    if (imageOnly > 0) {
      previewBlock += `另有 ${imageOnly} 张本地图片将在任务中识别后再进群。<br/><br/>`
    }
    const personalNote = skipPersonal.value
      ? '个人码将自动跳过'
      : '个人码无法进群，执行时也会跳过'
    const modeNote = assignMode.value === 'all'
      ? '执行方式：每个选中的微信都会分别执行全部已选群。'
      : '执行方式：按群手动分配的执行微信生成任务。'
    await ElMessageBox.confirm(
      `${previewBlock}`
      + `已选群：<b>${uniqueGroups.size}</b><br/>`
      + `执行微信：<b>${uniqueExecs.size}</b><br/>`
      + `预计任务：<b>${usablePairs.length}</b><br/>`
      + `${assignMode.value === 'all'
        ? `${uniqueGroups.size} 个群 × ${uniqueExecs.size} 个微信 = ${usablePairs.length} 条执行任务`
        : `按手动分配合计 = ${usablePairs.length} 条执行任务`}<br/><br/>`
      + `${modeNote}<br/>${personalNote}；进群后${saveContact.value ? '会保存到通讯录' : '不会自动保存到通讯录'}。<br/>确认后到任务中心执行。`,
      '创建进群任务',
      {
        type: 'warning',
        confirmButtonText: `确认创建${usablePairs.length}条任务`,
        cancelButtonText: '取消',
        dangerouslyUseHTMLString: true,
        customClass: 'qr-invite-confirm-box',
      },
    )
    const items = usablePairs.map((pair) => buildQrTaskItem(pair.qr, pair.instanceId, previewByUrl))
    const created = await window.wxControl?.createTask({
      name: `二维码识别与进群 ${new Date().toLocaleString()}`,
      type: 'QR_SCAN',
      config: {
        applyText: applyText.value,
        skipPersonal: skipPersonal.value,
        saveContact: saveContact.value,
        folder: folder.value,
        limitPerAccount: limitPerAccount.value,
        coolMinutes: coolMinutes.value,
        assignMode: assignMode.value,
      },
      items,
    })
    const inserted = Number((created as { total?: number })?.total || items.length)
    const deduped = Number((created as { deduplicated?: number })?.deduplicated || 0)
    await promptGoToTaskCenter(
      router,
      `任务创建成功\n群资源：${uniqueGroups.size}\n执行微信：${uniqueExecs.size}\n生成任务：${items.length}\n跳过重复：${deduped}\n实际新增：${inserted}`,
    )
  } catch (error) {
    if (error === 'cancel' || (error && typeof error === 'object' && 'action' in error && (error as { action?: string }).action === 'cancel')) return
    ElMessage.error(userErrorMessage(error, '创建二维码任务失败'))
  } finally {
    creating.value = false
  }
}
async function removeSelected() { if (!selected.value.length) return; await ElMessageBox.confirm('仅删除本地数据库记录，不删除原图片。', '删除二维码记录', { type: 'warning' }); rawRecords.value = (await window.wxControl?.deleteQrItems(selected.value.map((item) => String(item.id))) ?? []) as Array<Record<string, unknown>> }
onMounted(async () => {
  await initialize()
  selectOnlineExecutors()
})
onBeforeUnmount(() => {
  stopMonitorListener?.()
  stopMonitorRoomsListener?.()
  stopCollectProgress?.()
  stopMonitorQueuePolling()
  if (monitorResultTimer) clearTimeout(monitorResultTimer)
})
</script>

<template>
  <div class="app-page">
    <PageHeader title="二维码任务" subtitle="勾选群资源并自选执行微信：默认每个执行微信都会分别处理全部已选群（群数×微信号=任务数）。" />

    <div class="chip-row">
      <button
        v-for="tab in qrTabs"
        :key="tab"
        class="chip"
        :class="{ 'is-active': activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ tab }}
      </button>
    </div>

    <section v-if="activeTab === '图片采集'" class="app-card block history-collector">
      <h3 class="section-title">采集群聊历史二维码</h3>
      <p class="tip muted">历史采集会检查所选群里的全部图片消息（去重后保存二维码）。开启监控并勾选「监控全部群」后：定时刷新群列表、进群成功、新群发图都会自动扩容；有二维码则入队下载。</p>
      <div class="collector-grid">
        <div>
          <div class="field-label-row">
            <span>选择群聊（可搜索）</span>
            <span class="field-select-actions">
              <span class="muted select-hint">已选 {{ selectedMonitorRoomKeys.length }} / {{ historyGroupOptions.length }}</span>
              <el-button class="field-select-all" link type="primary" :disabled="!historyGroupOptions.length" @click.stop="selectAllHistoryGroups">全选</el-button>
              <el-button link type="info" :disabled="!selectedMonitorRoomKeys.length" @click.stop="clearHistoryGroups">全不选</el-button>
            </span>
          </div>
          <el-select
            v-model="selectedMonitorRoomKeys"
            multiple
            filterable
            collapse-tags
            :max-collapse-tags="1"
            collapse-tags-tooltip
            placeholder="输入群名/群ID搜索；可全选 150+"
            style="width:100%"
            :filter-method="groupSearch.setQuery"
            @visible-change="(open: boolean) => { if (!open) groupSearch.clearQuery() }"
          >
            <el-option v-for="item in visibleHistoryGroupOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <span v-if="selectedMonitorRoomKeys.length" class="muted select-hint">
            {{ selectedGroupNames.slice(0, 2).join('、') }}<template v-if="selectedMonitorRoomKeys.length > 2"> 等 {{ selectedMonitorRoomKeys.length }} 个</template>
          </span>
          <span v-if="historyGroupOptions.length > visibleHistoryGroupOptions.length" class="muted select-hint">下拉仅渲染部分项防卡顿，继续输入可精确匹配全部 {{ historyGroupOptions.length }} 个</span>
        </div>
        <div><label>保存文件夹</label><el-input v-model="outputDir" readonly placeholder="请选择保存位置"><template #append><el-button @click="chooseOutputDir">选择</el-button></template></el-input></div>
        <div><label>分组名称</label><el-input v-model="folder" maxlength="40" placeholder="例如：客户群采集" /></div>
      </div>
      <div class="toolbar-left" style="margin-top:12px; flex-wrap: wrap; gap: 8px">
        <el-checkbox v-model="monitorWatchAll">监控全部群（含新进群自动扩容）</el-checkbox>
        <el-button type="primary" :loading="collecting" :disabled="!selectedMonitorRoomKeys.length || !outputDir" @click="collectHistory">采集历史图片</el-button>
        <el-button v-if="!monitorEnabled" type="success" :disabled="!selectedMonitorRoomKeys.length || !outputDir" @click="startMonitor">开启群消息监控</el-button>
        <el-button v-else type="danger" plain @click="stopMonitor">停止群消息监控</el-button>
        <el-button v-if="monitorEnabled && monitorWatchAll" plain @click="syncMonitorRoomsNow">立即同步新群</el-button>
        <StatusTag :text="monitorEnabled ? (monitorWatchAll ? '监控中·自动扩容' : '监控中') : '未监控'" />
        <span v-if="collectProgressText" class="muted select-hint">{{ collectProgressText }}</span>
      </div>
      <p class="tip" :class="monitorEnabled ? 'monitor-on-tip' : 'muted'">{{ monitorTargetText }}</p>
    </section>

    <div v-if="activeTab === '链接导入'" class="top-split">
      <section class="app-card block">
        <h3 class="section-title">批量导入二维码链接</h3>
        <el-input v-model="importText" type="textarea" :rows="8" />
        <p class="tip muted">{{ qrFormatTip }}</p>
        <div class="toolbar-left" style="margin-top: 10px">
          <el-button type="primary" @click="importLinks">导入链接</el-button>
          <el-button @click="importFiles">选择图片</el-button>
          <el-button @click="refreshRecords">刷新记录</el-button>
        </div>
      </section>

      <section class="app-card block">
        <h3 class="section-title">任务概览</h3>
        <div class="overview-grid">
          <StatCard
            v-for="item in qrOverview"
            :key="item.title"
            :title="item.title"
            :value="item.value"
            icon="Tickets"
            tone="primary"
          />
        </div>
      </section>
    </div>

    <div v-if="activeTab === '识别结果' || activeTab === '链接导入' || activeTab === '图片采集'" class="mid-split">
      <section class="app-card block">
        <div class="section-head">
          <h3 class="section-title">待进群资源</h3>
          <div class="resource-stats muted">
            已采集 {{ rawRecords.length }} · 当前选择 {{ executableSelected.length }} · 来源账号 {{ sourceAccountCount }}
          </div>
        </div>
        <p class="tip muted">来源微信仅表示该群由哪个账号采集，不决定实际执行账号。</p>
        <div class="chip-row qr-type-filter" style="margin: 0 0 10px">
          <button
            v-for="item in qrTypeFilterChips"
            :key="item.value"
            class="chip"
            :class="{ 'is-active': typeFilter === item.value }"
            type="button"
            @click="setTypeFilter(item.value)"
          >
            {{ item.label }}
          </button>
          <span class="muted" style="margin-left:4px;font-size:12px">当前 {{ qrRecords.length }} 条</span>
          <template v-if="assignMode === 'manual'">
            <el-button size="small" style="margin-left:auto" @click="openBatchAssign">批量分配执行微信</el-button>
            <el-button size="small" @click="clearManualAssignSelected">清除执行微信</el-button>
          </template>
        </div>
        <div class="table-wrap">
          <el-table :data="qrRecords" stripe height="320" style="width: 100%" @selection-change="selected = $event" @row-dblclick="(row: Record<string, unknown>) => revealQrImage(row)">
            <el-table-column type="selection" width="48" />
            <el-table-column label="缩略图" width="64">
              <template #default="{ row }">
                <div class="thumb">{{ row.thumb }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="cacheTime" label="采集时间" width="100" show-overflow-tooltip />
            <el-table-column label="来源微信" min-width="100" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="source-label">{{ parseSourceParts(row.source).label }}</span>
              </template>
            </el-table-column>
            <el-table-column v-if="assignMode === 'manual'" label="执行微信" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">
                <el-button link type="primary" @click.stop="openManualPick(row)">{{ manualExecutorLabels(String(row.id || '')) }}</el-button>
              </template>
            </el-table-column>
            <el-table-column label="识别结果" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">
                <span
                  class="qr-result-cell"
                  :title="row.localPath ? '双击在资源管理器中定位并选中该二维码图片' : '无本地图片可定位'"
                  @dblclick.stop="revealQrImage(row)"
                >{{ row.result }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="type" label="类型" width="100" show-overflow-tooltip />
            <el-table-column label="去重" width="100" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="row.dedupeClass">{{ row.dedupe }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="{ row }"><StatusTag :text="row.status" /></template>
            </el-table-column>
            <el-table-column label="操作" width="100" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" :disabled="!isExecutableQr(row)" @click="createScanTask([row])">{{ row.localPath ? '识别进群' : '进群' }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <aside class="app-card block config-panel panel-scroll">
        <div class="section-head">
          <h3 class="section-title">执行微信分配</h3>
          <el-tooltip
            content="群来源微信只表示二维码/群信息由哪个微信采集。执行微信由本页面单独选择。不同微信可以重复执行加入同一个群。"
            placement="top"
          >
            <span class="info-hint">ⓘ</span>
          </el-tooltip>
        </div>
        <div class="muted tiny-stats">已选群 {{ executableSelected.length }} · 已选微信 {{ selectedExecutors.length }} · 预计任务 {{ plannedTaskCount }}</div>

        <div class="form-stack" style="margin-top:10px">
          <div>
            <label>执行方式</label>
            <el-radio-group v-model="assignMode" class="assign-mode">
              <el-radio value="all">所选微信执行全部已选群（推荐）</el-radio>
              <el-radio value="manual">手动给群分配执行微信</el-radio>
            </el-radio-group>
            <p class="tip muted">{{ assignMode === 'all' ? '每个选中的微信都会分别执行全部已选群。' : '请在左侧群列表为每个群指定执行微信，支持批量分配。' }}</p>
          </div>

          <template v-if="assignMode === 'all'">
            <div>
              <label>选择执行微信</label>
              <el-input v-model="executorSearch" clearable placeholder="搜索昵称 / WXID" size="small" style="margin-bottom:8px" />
              <div class="toolbar-left" style="margin-bottom:8px;flex-wrap:wrap;gap:6px">
                <el-button size="small" @click="selectOnlineExecutors">全选在线微信</el-button>
                <el-button size="small" @click="clearExecutors">取消全选</el-button>
                <el-button size="small" @click="selectNormalExecutors">仅选择正常账号</el-button>
              </div>
              <div class="executor-list">
                <div
                  v-for="inst in executorCandidates"
                  :key="inst.id"
                  class="executor-row"
                  :class="{ offline: inst.status !== 'ONLINE', selected: selectedExecutorIds.includes(inst.id) }"
                  @click="toggleExecutor(inst.id, inst.status === 'ONLINE')"
                >
                  <el-checkbox
                    :model-value="selectedExecutorIds.includes(inst.id)"
                    :disabled="inst.status !== 'ONLINE'"
                    @click.stop
                    @change="(checked: boolean | string | number) => setExecutorChecked(inst.id, Boolean(checked), inst.status === 'ONLINE')"
                  />
                  <el-avatar :size="28" :src="inst.avatar || undefined">{{ instanceLabel(inst).slice(0, 1) }}</el-avatar>
                  <div class="executor-meta">
                    <div class="executor-name">{{ instanceLabel(inst) }}</div>
                    <div class="muted tiny">{{ inst.alias || inst.accountWxid || '微信号读取中' }}</div>
                    <div class="badge-row">
                      <span class="dot" :class="inst.status === 'ONLINE' ? 'ok' : 'off'" />
                      <span class="tag-mini" :class="inst.status === 'ONLINE' ? 'ok' : 'off'">{{ inst.status === 'ONLINE' ? '在线' : '离线' }}</span>
                      <span v-if="inst.status !== 'ONLINE'" class="tag-mini off">不可选择 · 当前未登录</span>
                    </div>
                  </div>
                </div>
                <div v-if="!executorCandidates.length" class="muted tiny">暂无微信账号，请先在微信管理中打开并登录</div>
              </div>
            </div>
          </template>

          <div class="preview-box">
            <div class="preview-title">本次任务预览</div>
            <div class="preview-grid">
              <div><span class="muted">群聊数量</span><strong>{{ executableSelected.length }}</strong></div>
              <div><span class="muted">执行微信</span><strong>{{ assignMode === 'all' ? selectedExecutors.length : new Set(plannedPairs.map((p) => p.instanceId)).size }}</strong></div>
              <div><span class="muted">预计任务</span><strong>{{ plannedTaskCount }}</strong></div>
            </div>
            <p class="tip" style="margin-top:8px">
              <template v-if="assignMode === 'all'">
                {{ executableSelected.length }} 个群 × {{ selectedExecutors.length }} 个微信 = {{ plannedTaskCount }} 条执行任务
              </template>
              <template v-else>
                手动分配合计 {{ plannedTaskCount }} 条执行任务
              </template>
            </p>
            <el-button link type="primary" @click="assignPreviewOpen = !assignPreviewOpen">{{ assignPreviewOpen ? '收起任务分配' : '查看任务分配' }}</el-button>
            <div v-if="assignPreviewOpen" class="workload-list">
              <div v-for="row in accountWorkload" :key="row.id" class="workload-row">
                <div>{{ row.label }}</div>
                <div class="muted tiny">分配 {{ row.assigned }} 个群 · 本轮最多执行 {{ row.capped }}（每账号上限 {{ row.limit || '—' }}）</div>
              </div>
              <div v-if="!accountWorkload.length" class="muted tiny">暂无分配</div>
            </div>
          </div>

          <h3 class="section-title" style="margin-top:4px">进群设置</h3>
          <div>
            <label>进群申请文案</label>
            <el-input v-model="applyText" type="textarea" :rows="3" placeholder="需群主确认的群必须填写；留空则使用默认「你好，想加入群聊」" />
            <el-button style="margin-top: 8px" size="small" @click="applyText += '{昵称}'">插入变量</el-button>
            <p class="tip muted">开启「群聊邀请确认」的群会把这段文字作为申请理由提交；群主同意后才会真正进群。</p>
          </div>
          <div>
            <label>执行间隔（毫秒）</label>
            <div class="muted">在任务中心确认执行时单独设置，单位毫秒</div>
          </div>
          <div class="switch-row">
            <span>遇到个人码自动跳过（推荐）</span>
            <el-switch v-model="skipPersonal" />
          </div>
          <p class="tip muted">个人码无法通过本流程进群；关闭开关时仍会跳过，只是任务说明不同。</p>
          <div class="switch-row">
            <span>加入后保存到通讯录（推荐开启）</span>
            <el-switch v-model="saveContact" />
          </div>
          <p class="tip muted">当前：{{ saveContact ? '进群成功后会保存到通讯录' : '进群后不会自动保存，需到通讯录页手动勾选保存' }}</p>
          <div>
            <label>分组保存</label>
            <el-input v-model="folder" maxlength="40" placeholder="输入保存分组名称" />
          </div>
          <div>
            <label>加群上限（每个账号）</label>
            <el-input-number v-model="limitPerAccount" :min="1" controls-position="right" style="width: 100%" />
          </div>
          <div>
            <label>已经频繁冷却（分钟）</label>
            <el-input-number v-model="coolMinutes" :min="1" controls-position="right" style="width: 100%" />
            <p class="tip muted">仅影响触发频繁的那个执行微信，其他执行微信继续跑。</p>
          </div>
          <div class="create-summary muted">
            本次将创建：{{ executableSelected.length }} 个群 ×
            {{ assignMode === 'all' ? selectedExecutors.length : new Set(plannedPairs.map((p) => p.instanceId)).size }}
            个微信 = <b>{{ plannedTaskCount }}</b> 条任务
          </div>
          <div class="toolbar-left">
            <el-button
              type="primary"
              :loading="creating"
              :disabled="!executableSelected.length || plannedTaskCount <= 0"
              @click="createScanTask()"
            >创建识别与进群任务 · {{ plannedTaskCount }}</el-button>
          </div>
        </div>
      </aside>
    </div>

    <el-dialog v-model="manualPickVisible" title="为该群选择执行微信" width="420px" append-to-body>
      <el-checkbox-group v-model="manualPickIds">
        <div v-for="inst in instances.filter((item) => item.status === 'ONLINE')" :key="inst.id" style="margin-bottom:8px">
          <el-checkbox :value="inst.id">{{ instanceLabel(inst) }}（{{ inst.alias || inst.accountWxid || 'wxid' }}）</el-checkbox>
        </div>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="manualPickVisible = false">取消</el-button>
        <el-button type="primary" @click="saveManualPick">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="batchAssignVisible" title="给已选群分配执行微信" width="460px" append-to-body>
      <p class="muted">当前选择：{{ batchAssignIds.length }} 个群</p>
      <div style="margin:12px 0">
        <label>分配方式</label>
        <el-radio-group v-model="batchAssignMode" style="display:flex;flex-direction:column;gap:6px;margin-top:6px">
          <el-radio value="add">添加到现有执行微信</el-radio>
          <el-radio value="replace">替换现有执行微信</el-radio>
        </el-radio-group>
      </div>
      <el-checkbox-group v-model="batchDialogExecutorIds">
        <div v-for="inst in instances.filter((item) => item.status === 'ONLINE')" :key="inst.id" style="margin-bottom:8px">
          <el-checkbox :value="inst.id">{{ instanceLabel(inst) }}（{{ inst.alias || inst.accountWxid || 'wxid' }}）</el-checkbox>
        </div>
      </el-checkbox-group>
      <template #footer>
        <el-button @click="batchAssignVisible = false">取消</el-button>
        <el-button type="primary" @click="confirmBatchAssign">确认分配</el-button>
      </template>
    </el-dialog>

    <div class="bottom-bar">
      <div class="toolbar-left">
        <el-button type="danger" plain :disabled="!selected.length" @click="removeSelected">批量删除</el-button>
        <el-button @click="refreshRecords">刷新</el-button>
      </div>
      <div class="muted">当前 Tab：{{ activeTab }}</div>
    </div>
  </div>
</template>

<style scoped>
.block {
  padding: 14px 16px;
  min-width: 0;
  overflow: hidden;
}

.top-split {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
  gap: var(--app-gap);
  min-width: 0;
}

.config-panel.panel-scroll {
  overflow: auto !important;
  max-height: min(78vh, 920px);
  align-self: start;
}

.mid-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(340px, 420px);
  gap: var(--app-gap);
  min-width: 0;
  min-height: 320px;
  align-items: start;
}

.section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.resource-stats,
.tiny-stats {
  font-size: 12px;
}

.info-hint {
  cursor: help;
  color: var(--app-text-secondary);
  font-size: 13px;
}

.source-label {
  color: #64748b;
  font-size: 12px;
}

.assign-mode {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.executor-list {
  max-height: 320px;
  overflow: auto;
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 6px;
  padding: 6px;
  display: grid;
  grid-template-columns: 1fr;
  gap: 6px;
}

@media (min-width: 1600px) {
  .executor-list {
    grid-template-columns: 1fr 1fr;
  }
}

.executor-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
}

.executor-row:hover {
  background: #f8fafc;
}

.executor-row.selected {
  background: #eef7f6;
}

.executor-row.offline {
  opacity: 0.65;
  cursor: not-allowed;
}

.executor-meta {
  min-width: 0;
  flex: 1;
}

.executor-name {
  font-size: 13px;
  font-weight: 600;
}

.tiny {
  font-size: 12px;
}

.badge-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
  flex-wrap: wrap;
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #94a3b8;
}

.dot.ok { background: #16a34a; }
.dot.off { background: #94a3b8; }

.tag-mini {
  font-size: 11px;
  padding: 0 6px;
  border-radius: 999px;
  background: #f1f5f9;
  color: #64748b;
}

.tag-mini.ok {
  background: #dcfce7;
  color: #15803d;
}

.tag-mini.off {
  background: #f1f5f9;
  color: #64748b;
}

.preview-box {
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 6px;
  padding: 10px 12px;
  background: #fafafa;
}

.preview-title {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.preview-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.preview-grid strong {
  display: block;
  font-size: 18px;
  margin-top: 2px;
}

.workload-list {
  margin-top: 8px;
  max-height: 160px;
  overflow: auto;
}

.workload-row {
  padding: 6px 0;
  border-bottom: 1px solid #eee;
  font-size: 12px;
}

.create-summary {
  font-size: 12px;
  line-height: 1.5;
}

.overview-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  min-width: 0;
}

@media (max-width: 1500px) {
  .top-split,
  .mid-split {
    grid-template-columns: minmax(0, 1fr);
  }
}

.tip {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
}

.thumb {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  background: #eef7f6;
  color: var(--app-primary-hover);
  display: grid;
  place-items: center;
  font-weight: 700;
}

.qr-result-cell {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  color: var(--app-primary-hover, #0f766e);
}

.qr-type-filter {
  flex-wrap: wrap;
  align-items: center;
}

.dedupe-ok {
  color: #16a34a;
  font-weight: 600;
}

.dedupe-dup {
  color: #dc2626;
  font-weight: 600;
}

.monitor-on-tip {
  color: #0f766e;
  font-weight: 600;
}

.config-panel label {
  display: block;
  margin-bottom: 6px;
  color: var(--app-text-secondary);
  font-size: 12px;
}

.form-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.history-collector { margin-bottom: var(--app-gap); }
.collector-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px 16px; }
.collector-grid label { display:block; margin-bottom:6px; color:var(--app-text-secondary); font-size:12px; }
.field-select-actions {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.field-select-actions .select-hint { margin-top: 0; }
@media (max-width:900px) { .collector-grid { grid-template-columns:minmax(0,1fr); } }

.range-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
