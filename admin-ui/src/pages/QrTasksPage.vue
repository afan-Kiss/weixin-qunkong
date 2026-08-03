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
const qrFormatTip = '每行一条链接；导入后勾选群链接可创建进群任务。个人码可按配置跳过；本地图片仍可识别后进群。'
const applyText = ref('')
const skipPersonal = ref(true)
const saveContact = ref(true)
const creating = ref(false)
const folder = ref('默认分组')
const outputDir = ref('')
const selectedGroupIds = ref<string[]>([])
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

const qrRecords = computed(() => rawRecords.value.map((row) => {
  const dedupe = dedupeDisplay(row)
  return {
    ...row,
    thumb: row.localPath ? '图' : '链',
    cacheTime: formatCacheTime(row.createdAt),
    source: row.source,
    result: row.decodedText || '-',
    type: statusLabel(row.qrType),
    dedupe: dedupe.text,
    dedupeClass: dedupe.className,
    path: row.localPath || '-',
    status: statusLabel(row.status),
  }
}))
const qrOverview = computed(() => [{ title: '全部', value: String(rawRecords.value.length) }, { title: '待识别', value: String(rawRecords.value.filter((item) => item.status === 'WAITING_SCAN').length) }, { title: '链接归档', value: String(rawRecords.value.filter((item) => item.status === 'REFERENCE_ONLY').length) }, { title: '可执行图片', value: String(rawRecords.value.filter((item) => item.localPath).length) }])
const historyGroupOptions = computed(() => groups.value.map((item) => ({ label: `${item.name}（${instances.value.find((instance) => instance.id === item.sourceInstanceId)?.nickname || '所属微信'}）`, value: item.id })))
/** 当前勾选的群名，便于确认实时监控目标。 */
const selectedGroupNames = computed(() => {
  const map = new Map(historyGroupOptions.value.map((item) => [item.value, item.label]))
  return selectedGroupIds.value.map((id) => map.get(id) || id)
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
  selectedGroupIds.value,
  groupSearch.query.value.trim() ? SELECT_OPTION_LIMIT_SEARCH : undefined,
))
/** 一键全选采集/监控群聊。 */
function selectAllHistoryGroups() {
  selectedGroupIds.value = historyGroupOptions.value.map((item) => item.value)
}
/** 清空已选群聊。 */
function clearHistoryGroups() {
  selectedGroupIds.value = []
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
 * 双击记录行：打开图片所在目录（资源管理器中定位文件）。
 * @param row 表格行
 */
async function openRecordFolder(row: Record<string, unknown>) {
  const target = String(row.localPath || row.path || '').trim()
  if (!target || target === '-') return ElMessage.info('该记录没有本地保存路径')
  const result = await window.wxControl?.revealInFolder?.(target)
  if (!result?.ok) ElMessage.warning(result?.message || '无法打开目录')
}
/**
 * 采集勾选群的历史图片二维码；按队列逐群下载，不限制群数量。
 */
async function collectHistory() {
  if (!selectedGroupIds.value.length) return ElMessage.warning('请至少选择一个群聊')
  if (!outputDir.value) return ElMessage.warning('请先选择二维码保存文件夹')
  const selectedRooms = groups.value
    .filter((item) => selectedGroupIds.value.includes(item.id))
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
function selectedRooms() {
  const byId = groups.value.filter((item) => selectedGroupIds.value.includes(item.id))
  const knownRoomIds = new Set(byId.map((item) => item.roomId))
  const orphanRooms = selectedGroupIds.value
    .filter((id) => String(id).endsWith('@chatroom') && !knownRoomIds.has(id))
    .map((roomId) => {
      const online = instances.value.find((item) => item.status === 'ONLINE')
      return {
        instanceId: online?.id || '',
        roomId,
        name: '群聊',
      }
    })
    .filter((item) => item.instanceId)
  return [
    ...byId.map((item) => ({ instanceId: item.sourceInstanceId, roomId: item.roomId, name: item.name })),
    ...orphanRooms,
  ]
}
/**
 * 用主进程监控 rooms 回填勾选（进群扩容后 UI 同步增长）。
 * @param rooms 监控群
 */
function applyMonitorRoomsToSelection(rooms: Array<{ roomId: string; instanceId?: string; name?: string }> = []) {
  const roomIds = new Set(rooms.map((room) => String(room.roomId || '')).filter((id) => id.endsWith('@chatroom')))
  if (!roomIds.size) return
  const matched = groups.value.filter((group) => roomIds.has(group.roomId)).map((group) => group.id)
  // 通讯录尚未刷新到的新群：用 roomId 暂存，刷新后仍能对上
  const orphans = [...roomIds].filter((roomId) => !groups.value.some((group) => group.roomId === roomId))
  selectedGroupIds.value = [...new Set([...matched, ...orphans])]
  monitorWatchedCount.value = Math.max(roomIds.size, selectedGroupIds.value.length)
}

async function startMonitor() {
  if (!selectedGroupIds.value.length) return ElMessage.warning('请至少选择一个需要监控的群聊')
  if (!outputDir.value) return ElMessage.warning('请先选择二维码保存文件夹')
  try {
    const rooms = selectedRooms()
    // 全选当前目录时默认开启「含新进群自动扩容」；也可手动勾选
    const watchAll = monitorWatchAll.value
      || (historyGroupOptions.value.length > 0 && selectedGroupIds.value.length >= historyGroupOptions.value.length)
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

/**
 * 创建识别/进群任务：进群前先解析并展示群名/人数，确认后再创建。
 * @param rows 勾选记录
 */
async function createScanTask(rows = selected.value) {
  if (!rows.length) return ElMessage.warning('请先勾选要执行的二维码记录')
  const executable = rows.filter((item) => isExecutableQr(item))
  if (!executable.length) return ElMessage.warning('勾选的记录无可执行项：请勾选本地图片或群二维码链接')
  const availableInstances = instances.value.filter((item) => item.status === 'ONLINE')
  if (!availableInstances.length) return ElMessage.warning('没有可用的微信，请先打开并登录微信')
  const capacity = availableInstances.length * limitPerAccount.value
  const accepted = executable.slice(0, capacity)
  const linkRows = accepted.filter((item) => String(item.decodedText || '').trim())
  const imageOnly = accepted.length - linkRows.length
  creating.value = true
  try {
    let previewBlock = ''
    if (linkRows.length) {
      ElMessage.info('正在解析群资料（群名/人数）…')
      const previews = await window.wxControl?.previewQrInvites?.({
        instanceId: availableInstances[0].id,
        urls: linkRows.map((item) => String(item.decodedText)),
      }) ?? []
      const escapeHtml = (value: string) => String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
      const lines = previews.map((item, index) => {
        const name = item.roomName || (item.error ? '解析失败' : '未知群名')
        const count = Number(item.memberCount) > 0 ? `${item.memberCount} 人` : '人数未知'
        const id = item.roomId ? `<br/>&nbsp;&nbsp;&nbsp;ID：${escapeHtml(item.roomId)}` : ''
        const warn = item.expired || item.error ? ` ⚠ ${escapeHtml(item.error || '邀请可能无效')}` : ''
        return `${index + 1}. <b>${escapeHtml(name)}</b>（${escapeHtml(count)}）${warn}${id}`
      })
      previewBlock = lines.length
        ? `将进群的目标：<br/>${lines.join('<br/>')}<br/><br/>`
        : '未能解析出群资料，仍可尝试提交（结果以微信实际为准）。<br/><br/>'
    }
    if (imageOnly > 0) {
      previewBlock += `另有 ${imageOnly} 张本地图片将在任务中识别后再进群。<br/><br/>`
    }
    await ElMessageBox.confirm(
      `${previewBlock}共 ${accepted.length} 条；个人码${skipPersonal.value ? '将跳过' : '也会处理'}；进群后${saveContact.value ? '会保存到通讯录' : '不会自动保存到通讯录'}。<br/>确认后到任务中心执行。`,
      '确认进群目标',
      {
        type: 'warning',
        confirmButtonText: '确认创建任务',
        cancelButtonText: '取消',
        dangerouslyUseHTMLString: true,
        customClass: 'qr-invite-confirm-box',
      },
    )
    await window.wxControl?.createTask({
      name: `二维码识别与进群 ${new Date().toLocaleString()}`,
      type: 'QR_SCAN',
      config: {
        applyText: applyText.value,
        skipPersonal: skipPersonal.value,
        saveContact: saveContact.value,
        folder: folder.value,
        limitPerAccount: limitPerAccount.value,
        coolMinutes: coolMinutes.value,
      },
      items: accepted.map((item, index) => {
        const instanceId = availableInstances[index % availableInstances.length].id
        const targetKey = String(item.sha256 || item.id)
        if (item.decodedText) return { instanceId, targetKey, request: { url: String(item.decodedText) } }
        return { instanceId, targetKey, request: { path: item.localPath } }
      }),
    })
    if (accepted.length < executable.length) ElMessage.warning(`受每账号上限影响，已跳过 ${executable.length - accepted.length} 条`)
    await promptGoToTaskCenter(router, `已创建 ${accepted.length} 条二维码进群任务`)
  } catch (error) {
    if (error === 'cancel' || (error && typeof error === 'object' && 'action' in error && (error as { action?: string }).action === 'cancel')) return
    ElMessage.error(userErrorMessage(error, '创建二维码任务失败'))
  } finally {
    creating.value = false
  }
}
async function removeSelected() { if (!selected.value.length) return; await ElMessageBox.confirm('仅删除本地数据库记录，不删除原图片。', '删除二维码记录', { type: 'warning' }); rawRecords.value = (await window.wxControl?.deleteQrItems(selected.value.map((item) => String(item.id))) ?? []) as Array<Record<string, unknown>> }
onMounted(initialize)
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
    <PageHeader title="二维码任务" subtitle="分三步：导入/采集 → 勾选记录 → 创建任务；创建后到任务中心确认执行。" />

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
              <span class="muted select-hint">已选 {{ selectedGroupIds.length }} / {{ historyGroupOptions.length }}</span>
              <el-button class="field-select-all" link type="primary" :disabled="!historyGroupOptions.length" @click.stop="selectAllHistoryGroups">全选</el-button>
              <el-button link type="info" :disabled="!selectedGroupIds.length" @click.stop="clearHistoryGroups">全不选</el-button>
            </span>
          </div>
          <el-select
            v-model="selectedGroupIds"
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
          <span v-if="selectedGroupIds.length" class="muted select-hint">
            {{ selectedGroupNames.slice(0, 2).join('、') }}<template v-if="selectedGroupIds.length > 2"> 等 {{ selectedGroupIds.length }} 个</template>
          </span>
          <span v-if="historyGroupOptions.length > visibleHistoryGroupOptions.length" class="muted select-hint">下拉仅渲染部分项防卡顿，继续输入可精确匹配全部 {{ historyGroupOptions.length }} 个</span>
        </div>
        <div><label>保存文件夹</label><el-input v-model="outputDir" readonly placeholder="请选择保存位置"><template #append><el-button @click="chooseOutputDir">选择</el-button></template></el-input></div>
        <div><label>分组名称</label><el-input v-model="folder" maxlength="40" placeholder="例如：客户群采集" /></div>
      </div>
      <div class="toolbar-left" style="margin-top:12px; flex-wrap: wrap; gap: 8px">
        <el-checkbox v-model="monitorWatchAll">监控全部群（含新进群自动扩容）</el-checkbox>
        <el-button type="primary" :loading="collecting" :disabled="!selectedGroupIds.length || !outputDir" @click="collectHistory">采集历史图片</el-button>
        <el-button v-if="!monitorEnabled" type="success" :disabled="!selectedGroupIds.length || !outputDir" @click="startMonitor">开启群消息监控</el-button>
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
        <h3 class="section-title">二维码记录表<span class="muted" style="margin-left:8px;font-weight:400">勾选后创建任务</span></h3>
        <div class="table-wrap">
          <el-table :data="qrRecords" stripe height="320" style="width: 100%" @selection-change="selected = $event" @row-dblclick="openRecordFolder">
            <el-table-column type="selection" width="48" />
            <el-table-column label="缩略图" width="80">
              <template #default="{ row }">
                <div class="thumb">{{ row.thumb }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="cacheTime" label="缓存时间" width="100" show-overflow-tooltip />
            <el-table-column prop="source" label="来源" min-width="110" show-overflow-tooltip />
            <el-table-column prop="result" label="识别结果" min-width="180" show-overflow-tooltip />
            <el-table-column prop="type" label="类型" width="100" />
            <el-table-column label="去重状态" min-width="110" show-overflow-tooltip>
              <template #default="{ row }">
                <span :class="row.dedupeClass">{{ row.dedupe }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="path" label="保存路径" min-width="160" show-overflow-tooltip />
            <el-table-column label="状态" width="110">
              <template #default="{ row }"><StatusTag :text="row.status" /></template>
            </el-table-column>
            <el-table-column label="操作" width="120" fixed="right">
              <template #default="{ row }">
                <el-button link type="primary" :disabled="!isExecutableQr(row)" @click="createScanTask([row])">{{ row.localPath ? '识别进群' : '进群' }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <aside class="app-card block config-panel panel-scroll">
        <h3 class="section-title">执行配置</h3>
        <div class="form-stack">
          <div>
            <label>进群申请文案</label>
            <el-input v-model="applyText" type="textarea" :rows="4" />
            <el-button style="margin-top: 8px" size="small" @click="applyText += '{昵称}'">插入变量</el-button>
          </div>
          <div>
            <label>随机间隔（秒）</label>
            <div class="muted">使用系统设置中的全局随机间隔</div>
          </div>
          <div class="switch-row">
            <span>遇到个人码自动跳过</span>
            <el-switch v-model="skipPersonal" />
          </div>
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
          </div>
          <div class="toolbar-left">
            <el-button type="primary" :loading="creating" :disabled="!selected.some((item) => isExecutableQr(item))" @click="createScanTask()">创建识别与进群任务</el-button>
          </div>
        </div>
      </aside>
    </div>

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

.mid-split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  gap: var(--app-gap);
  min-width: 0;
  min-height: 320px;
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
