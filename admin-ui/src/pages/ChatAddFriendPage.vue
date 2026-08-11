<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import { userErrorMessage } from '../utils/error'
import { promptGoToTaskCenter } from '../utils/taskFlow'
import { groups, instances, refreshDirectory, refreshInstances } from '../stores/wechatData'
import { filterSelectOptions, SELECT_OPTION_LIMIT_SEARCH, useSelectSearchQuery } from '../utils/searchableSelect'

const router = useRouter()

interface ChatAddRule {
  enabled: boolean
  instanceId: string
  accountWxid?: string
  roomIds: string[]
  keywords: string[]
  excludeText: string
  updatedAt: string
}

interface CandidateRow {
  id: number
  instanceId: string
  roomId: string
  senderWxid: string
  nickname: string
  messagePreview: string
  matchedKeyword: string
  status: string
  createdAt: string
  sourceRoomId: string
  sourceRoomName: string
  sourceInstancePort: number
  accountWxid: string
  senderV3: string
  receivedAt: string
}

interface FriendStatus {
  status: string
  error: string
  taskStatus: string
  updatedAt: string
}

const enabled = ref(false)
const selectedInstanceId = ref('')
const selectedGroupKeys = ref<string[]>([])
const groupSearch = useSelectSearchQuery(120)
const groupSelectOpen = ref(false)
const keywordsText = ref('')
const excludeText = ref('')
const candidates = ref<CandidateRow[]>([])
const selectedIds = ref<number[]>([])
const friendStatuses = ref<Record<string, FriendStatus>>({})
const saving = ref(false)
const creating = ref(false)
const tableRef = ref<{ clearSelection: () => void, toggleRowSelection: (row: unknown, selected?: boolean) => void } | null>(null)
/** 程序化恢复勾选时忽略 selection-change，避免新消息刷新把勾选冲掉 */
let restoringSelection = false
/** 防止并发 refresh 用旧结果覆盖新勾选 */
let candidatesRefreshSeq = 0
let candidateRefreshTimer: ReturnType<typeof setTimeout> | undefined
let lastFriendStatusKey = ''
let stopCandidateListener: (() => void) | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined
let applyRuleTimer: ReturnType<typeof setTimeout> | undefined
let activeRule: ChatAddRule | undefined


const instanceOptions = computed(() => instances.value.map((item) => ({
  label: `${item.nickname || item.accountWxid || item.id}${item.status === 'ONLINE' ? '' : '（未在线）'}`,
  value: item.id,
})))

/** 必须先选微信，才列出该微信下的群；未选时不给「全部群」可全选 */
const groupOptions = computed(() => {
  if (!selectedInstanceId.value) return []
  return groups.value
    .filter((item) => item.sourceInstanceId === selectedInstanceId.value)
    .map((item) => ({
      label: `${item.name}（${item.roomId}）`,
      value: item.id,
      roomId: item.roomId,
      sourceInstanceId: item.sourceInstanceId,
    }))
})

/** 可搜索下拉可见选项（限制渲染量，避免卡顿） */
const visibleGroupOptions = computed(() => filterSelectOptions(
  groupOptions.value,
  groupSearch.query.value,
  selectedGroupKeys.value,
  groupSearch.query.value.trim() ? SELECT_OPTION_LIMIT_SEARCH : undefined,
))

/**
 * 一键全选当前微信下可选群聊（未选微信时禁止，避免误选全部）。
 */
function selectAllListeningGroups() {
  if (!selectedInstanceId.value) return
  selectedGroupKeys.value = groupOptions.value.map((item) => item.value)
}

/**
 * 清空已选监听群聊。
 */
function clearListeningGroups() {
  selectedGroupKeys.value = []
}

const pendingCount = computed(() => candidates.value.filter((item) => item.status === 'PENDING').length)

/** 将后台 UTC ISO 时间转换为电脑本地时间：YYYY-MM-DD HH:mm:ss。 */
function formatLocalDateTime(value: string) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) return '-'
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const tableRows = computed(() => candidates.value.map((row) => ({
  ...row,
  groupName: groups.value.find((group) => group.roomId === row.roomId && group.sourceInstanceId === row.instanceId)?.name || row.roomId,
  keywordLabel: row.matchedKeyword || '全量发言',
  addStatus: resolveAddStatus(row.senderWxid, row.status),
  displayTime: formatLocalDateTime(row.createdAt),
})))

/**
 * 从资料响应中提取加好友所需的 v3/v4 凭证。
 * @param value 接口原始响应
 * @param key v3 或 v4
 * @returns 凭证字符串，找不到则空串
 */
/**
 * 判断是否包含频繁证据。
 * @param error 错误文案
 * @param status 任务项状态
 */
function hasFrequentMark(error?: string, status?: string) {
  if (status === 'FREQUENT') return true
  const text = `${error || ''} ${status || ''}`.toLowerCase()
  return text.includes('已经频繁') || text.includes('频繁') || text.includes('frequent') || text.includes('too many requests')
}

function friendStatusKey(instanceId: string, targetWxid: string) {
  return `${instanceId}\u0000${targetWxid}`
}

/**
 * 映射候选的添加状态展示文案。
 * @param senderWxid 发送者
 * @param candidateStatus 候选状态
 */
function resolveAddStatus(senderWxid: string, candidateStatus: string) {
  const instanceId = String(activeRule?.instanceId || '')
  const friend = instanceId ? friendStatuses.value[friendStatusKey(instanceId, senderWxid)] : undefined
  const reason = String(friend?.error || '').trim()
  // 仅看该项状态/错误，任务整体 COOLING_DOWN 不误伤已提交或其他候选人
  if (friend && hasFrequentMark(friend.error, friend.status)) return reason ? `已经频繁：${reason}` : '已经频繁'
  if (friend?.status === 'REQUEST_SENT' || friend?.status === 'SUBMITTED' || friend?.status === 'COMPLETED') {
    return reason || '申请已提交'
  }
  if (friend?.status === 'RESOLUTION_FAILED') return reason ? `资料失败：${reason}` : '资料解析失败'
  if (friend?.status === 'FAILED' || friend?.status === 'PARTIAL_FAILED') return reason ? `失败：${reason}` : '失败'
  if (friend?.status === 'SKIPPED') return reason ? `已过滤：${reason}` : '已过滤'
  if (candidateStatus === 'TASKED') return '已入任务'
  if (candidateStatus === 'PENDING') return '待创建'
  return candidateStatus || '-'
}

/**
 * 等待指定毫秒。
 * @param ms 毫秒
 */

/** 加载规则回填期间不因微信变更清空已选群 */
let loadingRule = false
/** 最近一次从后端加载/保存的群 roomId，用于目录重载后恢复勾选 */
let rememberedRoomIds: string[] = []
let draftPersistTimer: ReturnType<typeof setTimeout> | undefined

/**
 * 按已保存的 roomId 回填群勾选；目录只匹配到一部分时，其余用 ownershipKey 占位，禁止截断落库。
 */
function applyRoomSelectionFromIds(roomIds: string[], instanceId: string) {
  const saved = [...new Set((roomIds || []).map(String).filter(Boolean))]
  rememberedRoomIds = saved
  if (!saved.length) {
    selectedGroupKeys.value = []
    return
  }
  const savedSet = new Set(saved)
  const matchedByRoom = new Map(
    groups.value
      .filter((group) => (!instanceId || group.sourceInstanceId === instanceId) && savedSet.has(group.roomId))
      .map((group) => [group.roomId, group.id]),
  )
  selectedGroupKeys.value = saved.map((roomId) => {
    const hit = matchedByRoom.get(roomId)
    if (hit) return hit
    return instanceId ? `${instanceId}\u0000${roomId}` : roomId
  })
}

/**
 * 启动/切换微信号后强制重拉群列表（已登记被踢群会被目录排除）。
 * @param instanceId 微信实例
 * @param options.restoreRoomIds 重载后按这些 roomId 恢复勾选；默认用当前/记忆中的选择
 */
async function reloadGroupsForInstance(instanceId: string, options: { restoreRoomIds?: string[] } = {}) {
  const id = String(instanceId || '').trim()
  if (!id) return
  const restoreIds = options.restoreRoomIds !== undefined
    ? options.restoreRoomIds
    : (rememberedRoomIds.length
      ? rememberedRoomIds
      : selectedGroupKeys.value.map(roomIdFromSelectKey).filter(Boolean))
  try {
    await refreshDirectory([id], { force: true })
    applyRoomSelectionFromIds(restoreIds, id)
  } catch (error) {
    ElMessage.warning(userErrorMessage(error, '重载群聊列表失败'))
  }
}

/**
 * 把当前表单草稿写入后台（未开启监听也保存选中的微信/群/关键词），避免跳去任务中心再回来丢失。
 * 注意：暂停监听时不把 activeRule 换成空 roomIds，否则候选列表会被定时刷新冲掉。
 */
function queuePersistDraft() {
  if (loadingRule) return
  if (draftPersistTimer) clearTimeout(draftPersistTimer)
  draftPersistTimer = setTimeout(() => { void persistDraft() }, 350)
}

async function persistDraft() {
  if (loadingRule) return
  try {
    const previous = await window.wxControl?.getChatAddRule?.() as ChatAddRule | undefined
    const payload = buildRulePayload(previous?.roomIds || rememberedRoomIds, previous)
    rememberedRoomIds = [...(payload.roomIds || [])]
    const saved = await window.wxControl?.saveChatAddRule?.(payload) as ChatAddRule | undefined
    // 仅在仍有监听范围时同步 activeRule；空群草稿不得抹掉候选查询范围
    if (saved?.enabled || (saved?.roomIds || []).length) {
      activeRule = saved
    } else if (previous?.roomIds?.length && !(payload.roomIds || []).length) {
      activeRule = {
        ...saved!,
        instanceId: previous.instanceId || saved?.instanceId || '',
        roomIds: previous.roomIds,
        accountWxid: previous.accountWxid || saved?.accountWxid,
      }
    } else {
      activeRule = saved
    }
  } catch {
    /* 草稿落库失败不弹错，避免打断操作 */
  }
}

// 用户切换/重选微信时清空群选并重载该号群列表；加载规则回填时跳过
watch(selectedInstanceId, (next, prev) => {
  if (loadingRule || prev === next) return
  selectedGroupKeys.value = []
  rememberedRoomIds = []
  if (enabled.value) {
    enabled.value = false
    activeRule = undefined
    void window.wxControl?.saveChatAddRule?.(buildRulePayload()).then((rule) => {
      activeRule = rule as ChatAddRule | undefined
      void refreshCandidates()
    })
    ElMessage.info('已停止旧微信的监听，请选择群聊后重新开启')
  } else {
    queuePersistDraft()
  }
  if (next) void reloadGroupsForInstance(next, { restoreRoomIds: [] })
})

// 多开启动微信：当前选中号刚上线时重载群列表
watch(
  () => instances.value.find((item) => item.id === selectedInstanceId.value)?.status,
  (status, prev) => {
    if (!selectedInstanceId.value || loadingRule) return
    if (status === 'ONLINE' && prev !== 'ONLINE') {
      void reloadGroupsForInstance(selectedInstanceId.value, { restoreRoomIds: rememberedRoomIds })
    }
  },
)

// 修改群、关键词或排除项：始终防抖落库草稿；若正在监听则同步启停逻辑
watch([selectedGroupKeys, keywordsText, excludeText], () => {
  if (loadingRule) return
  if (applyRuleTimer) clearTimeout(applyRuleTimer)
  if (enabled.value && selectedInstanceId.value && !selectedGroupKeys.value.length) {
    enabled.value = false
    activeRule = undefined
    void window.wxControl?.saveChatAddRule?.(buildRulePayload()).then((rule) => {
      activeRule = rule as ChatAddRule | undefined
    })
    ElMessage.info('未选择监听群，已停止监听')
    return
  }
  if (enabled.value && selectedInstanceId.value) {
    applyRuleTimer = setTimeout(() => { void saveRule(true, true) }, 400)
    return
  }
  rememberedRoomIds = selectedGroupKeys.value.map(roomIdFromSelectKey).filter(Boolean)
  queuePersistDraft()
}, { deep: true })

/**
 * 从勾选的群主键解析真实 roomId（兼容 ownershipKey / 直接群 ID）。
 * @param key 下拉 value
 */
function roomIdFromSelectKey(key: string) {
  const value = String(key || '')
  if (value.endsWith('@chatroom')) return value
  const parts = value.split('\u0000')
  const tail = parts[parts.length - 1] || ''
  return tail.endsWith('@chatroom') ? tail : ''
}

/**
 * 将页面表单组装为可保存规则。
 * 通讯录未就绪时，绝不把已勾选群写成空 roomIds（否则监听会静默丢光）。
 * accountWxid 空值不覆盖已存账号，避免探测未完成时抹掉改绑锚点。
 */
function buildRulePayload(previousRoomIds: string[] = [], previousRule?: Partial<ChatAddRule> | null): Partial<ChatAddRule> {
  const selectedRooms = groups.value.filter((group) => selectedGroupKeys.value.includes(group.id)
    && (!selectedInstanceId.value || group.sourceInstanceId === selectedInstanceId.value))
  let roomIds = selectedRooms.map((group) => group.roomId)
  if (!roomIds.length && selectedGroupKeys.value.length) {
    roomIds = [...new Set(selectedGroupKeys.value.map(roomIdFromSelectKey).filter(Boolean))]
  }
  if (!roomIds.length && previousRoomIds.length && selectedGroupKeys.value.length) {
    roomIds = previousRoomIds
  }
  const keywords = keywordsText.value.split(/[\r\n,，]+/).map((item) => item.trim()).filter(Boolean)
  const liveWxid = instances.value.find((item) => item.id === selectedInstanceId.value)?.accountWxid || ''
  const accountWxid = String(liveWxid || previousRule?.accountWxid || '').trim()
  return {
    enabled: enabled.value,
    instanceId: selectedInstanceId.value,
    accountWxid,
    roomIds,
    keywords,
    excludeText: excludeText.value,
  }
}

/**
 * 从后端加载规则到表单。
 */
async function loadRule() {
  const rule = await window.wxControl?.getChatAddRule?.() as ChatAddRule | undefined
  if (!rule) return
  loadingRule = true
  try {
    enabled.value = Boolean(rule.enabled)
    selectedInstanceId.value = rule.instanceId || ''
    keywordsText.value = (rule.keywords || []).join('\n')
    excludeText.value = rule.excludeText || ''
    activeRule = rule
    // 仅回填规则里明确保存的群；空 roomIds = 不选中任何群（绝不默认全选）
    applyRoomSelectionFromIds(rule.roomIds || [], rule.instanceId || '')
  } finally {
    loadingRule = false
  }
}

/**
 * 刷新候选列表与好友添加状态。
 * 下拉展开时跳过，避免输入搜索时被定时刷新打断卡顿。
 * 刷新后会恢复仍有效的表格勾选（新消息入库不得清空用户已勾选项）。
 */
async function refreshCandidates() {
  if (groupSelectOpen.value) return
  const seq = ++candidatesRefreshSeq
  const keepIds = [...selectedIds.value]
  // 停止监听只阻止新增候选，不清空已有候选；只有“清空候选”按钮可以删除。
  const rule = activeRule
  if (!rule?.instanceId || !rule.roomIds.length) {
    if (seq !== candidatesRefreshSeq) return
    candidates.value = []
    friendStatuses.value = {}
    lastFriendStatusKey = ''
    await restoreCandidateSelection(keepIds)
    return
  }
  const nextRows = (await window.wxControl?.listChatAddCandidates?.({
    instanceId: rule.instanceId,
    roomIds: rule.roomIds,
    limit: 2000,
  }) ?? []) as CandidateRow[]
  if (seq !== candidatesRefreshSeq) return
  candidates.value = nextRows
  // 仅查待创建候选的状态；key 未变则跳过 IPC，降低 CPU/IPC
  const pendingKeys = nextRows
    .filter((item) => item.status === 'PENDING')
    .map((item) => ({ instanceId: rule.instanceId, targetKey: item.senderWxid }))
  const statusKey = pendingKeys
    .map((item) => `${item.instanceId}\u0000${item.targetKey}`)
    .sort()
    .join('\n')
  if (!pendingKeys.length) {
    friendStatuses.value = {}
    lastFriendStatusKey = ''
  } else if (statusKey !== lastFriendStatusKey) {
    friendStatuses.value = (await window.wxControl?.listFriendAddStatuses?.(pendingKeys) ?? {}) as Record<string, FriendStatus>
    if (seq !== candidatesRefreshSeq) return
    lastFriendStatusKey = statusKey
  }
  await restoreCandidateSelection(keepIds)
}

/** 新消息突发时合并刷新，避免每条消息全量拉候选+重绘表格 */
function scheduleRefreshCandidates(delayMs = 600) {
  if (candidateRefreshTimer) clearTimeout(candidateRefreshTimer)
  candidateRefreshTimer = setTimeout(() => {
    candidateRefreshTimer = undefined
    void refreshCandidates()
  }, delayMs)
}

/**
 * 表格勾选变化：同步到 selectedIds（程序化恢复期间忽略）。
 */
function onCandidateSelectionChange(rows: CandidateRow[]) {
  if (restoringSelection) return
  selectedIds.value = rows.map((item) => item.id)
}

/**
 * 按仍存在的候选 ID 恢复 el-table 勾选。
 */
async function restoreCandidateSelection(keepIds: number[]) {
  const alive = new Set(
    candidates.value
      .filter((row) => (row.status === 'PENDING' || row.status === 'TASKED') && keepIds.includes(row.id))
      .map((row) => row.id),
  )
  selectedIds.value = keepIds.filter((id) => alive.has(id))
  await nextTick()
  const table = tableRef.value
  if (!table) return
  restoringSelection = true
  try {
    table.clearSelection()
    for (const row of tableRows.value) {
      if (alive.has(row.id)) table.toggleRowSelection(row, true)
    }
  } finally {
    restoringSelection = false
  }
}

/**
 * 保存监听规则（启停）。
 * @param nextEnabled 是否启用监听
 */
async function saveRule(nextEnabled = enabled.value, automatic = false) {
  if (nextEnabled) {
    if (!selectedInstanceId.value) return ElMessage.warning('请先选择要监听的微信')
    if (!selectedGroupKeys.value.length) return ElMessage.warning('请至少选择一个群聊')
    const instance = instances.value.find((item) => item.id === selectedInstanceId.value)
    if (!instance || instance.status !== 'ONLINE') return ElMessage.warning('所选微信未在线，请先登录微信')
  }
  saving.value = true
  try {
    const previous = await window.wxControl?.getChatAddRule?.() as ChatAddRule | undefined
    enabled.value = nextEnabled
    const payload = buildRulePayload(previous?.roomIds || [], previous)
    if (nextEnabled && !(payload.roomIds || []).length) {
      return ElMessage.warning('未解析到监听群 ID，请刷新通讯录后重新勾选群聊再开启')
    }
    activeRule = await window.wxControl?.saveChatAddRule?.(payload) as ChatAddRule | undefined
    rememberedRoomIds = [...(activeRule?.roomIds || payload.roomIds || [])]
    // 停止后仍按原微信和群范围读取数据库中的候选，不因规则更新时间变化而消失。
    await refreshCandidates()
    if (!automatic) ElMessage.success(nextEnabled ? '已开启群聊发言监听' : '已保存并关闭监听')
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '保存监听规则失败'))
  } finally {
    saving.value = false
  }
}

/**
 * 清空候选列表。
 */
async function clearCandidates() {
  try {
    await ElMessageBox.confirm('确认清空全部发言加好友候选？', '清空候选', { type: 'warning' })
  } catch {
    return
  }
  await window.wxControl?.clearChatAddCandidates?.({})
  selectedIds.value = []
  await refreshCandidates()
  ElMessage.success('候选已清空')
}

const DEFAULT_FRIEND_VERIFY_CONTENT = '你好，我是群里的朋友'

/**
 * 创建加好友任务：取资料后入任务中心等待确认。
 * @param rows 候选行
 */
async function createAddFriendTask(rows?: CandidateRow[]) {
  if (!rows?.length && !selectedIds.value.length) return ElMessage.warning('请先勾选要添加的发言候选')
  const source = (rows && rows.length ? rows : candidates.value.filter((item) => selectedIds.value.includes(item.id)))
    .filter((item) => item.status === 'PENDING' || item.status === 'TASKED')
  if (!source.length) return ElMessage.warning('勾选的候选中没有可创建项')
  let prompt: { value: string }
  try {
    prompt = await ElMessageBox.prompt('添加好友验证内容', '创建加好友任务', {
      inputPlaceholder: `可不填，默认：${DEFAULT_FRIEND_VERIFY_CONTENT}`,
    })
    await ElMessageBox.confirm(`将对 ${source.length} 名发言成员检查资料并创建任务，创建后请到任务中心确认执行。`, '确认创建', { type: 'warning' })
  } catch {
    return
  }
  creating.value = true
  const items: Array<Record<string, unknown>> = []
  const taskedIds: number[] = []
  let skippedSelf = 0
  let unavailable = 0
  try {
    for (const row of source) {
      const instance = instances.value.find((item) => item.id === row.instanceId)
      if (!instance) { unavailable += 1; continue }
      if (instance.accountWxid && row.senderWxid === instance.accountWxid) { skippedSelf += 1; continue }
      items.push({
        instanceId: instance.id,
        targetKey: row.senderWxid,
        status: 'PROFILE_PENDING',
        request: {
          targetWxid: row.senderWxid,
          nickname: row.nickname || '',
          sourceRoomId: row.sourceRoomId || row.roomId,
          sourceRoomName: row.sourceRoomName,
          sourceInstanceId: row.instanceId,
          sourceInstancePort: row.sourceInstancePort || instance.apiPort,
          accountWxid: row.accountWxid || instance.accountWxid,
          receivedAt: row.receivedAt || row.createdAt,
          // 不把消息内 senderV3 写入任务：会与新鲜 V4 拼配失败；执行端用 update_single_profile 现取 V3
          // 群聊来源：scene/scence 均用 14；执行端还会补齐 scene 双字段与群标识
          scence: '14', scene: '14', friendFlg: '0',
          verifyContent: String(prompt.value || '').trim() || DEFAULT_FRIEND_VERIFY_CONTENT,
        },
      })
      taskedIds.push(row.id)
    }
    if (!items.length) {
      const reasons = [skippedSelf ? `已排除本人 ${skippedSelf} 人` : '', unavailable ? `暂时无法取得资料 ${unavailable} 人` : ''].filter(Boolean).join('，')
      return ElMessage.warning(`没有可创建任务的成员${reasons ? `：${reasons}` : ''}`)
    }
    const created = await window.wxControl?.createTask?.({
      name: `群聊发言加好友 ${new Date().toLocaleString()}`,
      type: 'ADD_FRIEND',
      config: { coolMinutes: 30 },
      items,
    }) as Record<string, unknown> | undefined
    if (taskedIds.length) await window.wxControl?.markChatAddCandidatesTasked?.(taskedIds)
    await refreshCandidates()
    const skipped = [skippedSelf ? `排除本人 ${skippedSelf} 人` : '', unavailable ? `资料暂不可用 ${unavailable} 人` : ''].filter(Boolean).join('，')
    const total = Number(created?.total || items.length) || items.length
    if (draftPersistTimer) clearTimeout(draftPersistTimer)
    await persistDraft()
    await promptGoToTaskCenter(router, `已创建 ${total} 项加好友任务${skipped ? `，${skipped}` : ''}`)
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '创建加好友任务失败'))
  } finally {
    creating.value = false
  }
}

/**
 * 初始化页面：刷新通讯录、加载规则与候选。
 */
async function initialize() {
  await refreshInstances()
  await refreshDirectory(undefined, { force: true })
  await loadRule()
  // 目录强制刷新后再按已存 roomId 勾选，避免跳页返回时空选
  if (selectedInstanceId.value) {
    await reloadGroupsForInstance(selectedInstanceId.value, { restoreRoomIds: rememberedRoomIds })
  }
  await refreshCandidates()
  stopCandidateListener = window.wxControl?.onChatAddCandidate?.(() => { scheduleRefreshCandidates(600) })
  // 定时兜底：有事件监听时不必太密，降低空闲 CPU
  refreshTimer = setInterval(() => { void refreshCandidates() }, 20000)
}

onMounted(() => { void initialize() })
onBeforeUnmount(() => {
  stopCandidateListener?.()
  if (refreshTimer) clearInterval(refreshTimer)
  if (applyRuleTimer) clearTimeout(applyRuleTimer)
  if (draftPersistTimer) clearTimeout(draftPersistTimer)
  if (candidateRefreshTimer) clearTimeout(candidateRefreshTimer)
  // 离开页面前立刻落库，保证去任务中心再回来仍能还原
  void persistDraft()
})
</script>

<template>
  <div class="app-page">
    <PageHeader title="群聊加好友" subtitle="1.选微信与群并开启监听 → 2.勾选候选 → 3.创建任务 → 4.到任务中心确认执行。">
      <el-button @click="selectedInstanceId ? reloadGroupsForInstance(selectedInstanceId) : refreshDirectory(undefined, { force: true }); refreshCandidates()">刷新</el-button>
      <el-button :loading="saving" @click="saveRule()">保存规则</el-button>
      <el-button type="primary" :loading="saving" @click="saveRule(!enabled)">{{ enabled ? '停止监听' : '开启监听' }}</el-button>
    </PageHeader>

    <el-alert
      class="tip"
      type="info"
      :closable="false"
      title="关键词为空表示指定群内谁发言都记录；填写多个关键词时，消息包含任一关键词即命中。执行加好友仍需到任务中心确认。"
    />

    <div class="panel">
      <div class="grid">
        <div>
          <span>监听微信</span>
          <el-select v-model="selectedInstanceId" filterable clearable placeholder="选择在线微信" style="width: 100%">
            <el-option v-for="item in instanceOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
        </div>
        <!-- 不用 label 包裹：否则点击标题会激活第一个 button（全选），导致误全选并监听全部群 -->
        <div class="span-2">
          <div class="field-label-row">
            <span>监听群聊（可搜索）</span>
            <span class="field-select-actions">
              <span class="muted select-hint">已选 {{ selectedGroupKeys.length }} / {{ groupOptions.length }}</span>
              <el-button class="field-select-all" link type="primary" :disabled="!selectedInstanceId || !groupOptions.length" @click.stop="selectAllListeningGroups">全选</el-button>
              <el-button link type="info" :disabled="!selectedGroupKeys.length" @click.stop="clearListeningGroups">全不选</el-button>
            </span>
          </div>
          <el-select
            v-model="selectedGroupKeys"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            :placeholder="selectedInstanceId ? '输入群名/群ID搜索' : '请先选择监听微信'"
            style="width: 100%"
            :disabled="!selectedInstanceId"
            :filter-method="groupSearch.setQuery"
            @visible-change="(open: boolean) => { groupSelectOpen = open; if (!open) groupSearch.clearQuery() }"
          >
            <el-option v-for="item in visibleGroupOptions" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <span v-if="groupOptions.length > visibleGroupOptions.length" class="muted select-hint">已显示部分群，继续输入可精确匹配全部 {{ groupOptions.length }} 个</span>
        </div>
        <div>
          <span>关键词（多行，空=指定群内全量发言）</span>
          <el-input v-model="keywordsText" type="textarea" :rows="3" placeholder="例如：&#10;加我&#10;合作" />
        </div>
        <div>
          <span>排除 WXID / 昵称（多行）</span>
          <el-input v-model="excludeText" type="textarea" :rows="3" placeholder="精确匹配，不区分大小写" />
        </div>
      </div>
      <div class="status-line">
        <StatusTag :text="enabled ? '执行中' : '已暂停'" />
        <span>{{ enabled ? '监听中' : '未监听' }} · 待创建候选 {{ pendingCount }}</span>
      </div>
    </div>

    <div class="panel">
      <div class="toolbar">
        <strong>发言候选</strong>
        <div class="toolbar__actions">
          <el-button @click="clearCandidates">清空候选</el-button>
          <el-button type="primary" :loading="creating" @click="createAddFriendTask()">创建加好友任务</el-button>
        </div>
      </div>
      <el-table
        ref="tableRef"
        :data="tableRows"
        height="420"
        row-key="id"
        @selection-change="onCandidateSelectionChange"
      >
        <el-table-column type="selection" width="42" :reserve-selection="true" :selectable="(row: CandidateRow) => row.status === 'PENDING' || row.status === 'TASKED'" />
        <el-table-column prop="nickname" label="昵称" min-width="120" />
        <el-table-column prop="senderWxid" label="WXID" min-width="150" show-overflow-tooltip />
        <el-table-column prop="groupName" label="来自群" min-width="140" show-overflow-tooltip />
        <el-table-column prop="messagePreview" label="消息摘要" min-width="180" show-overflow-tooltip />
        <el-table-column prop="keywordLabel" label="命中" width="100" />
        <el-table-column prop="addStatus" label="添加状态" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span :class="{ 'is-frequent': String(row.addStatus || '').startsWith('已经频繁') }">{{ row.addStatus }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="displayTime" label="接收时间" min-width="170" />
      </el-table>
    </div>
  </div>
</template>

<style scoped>
.tip { margin-bottom: 14px; }
.panel {
  background: var(--app-panel, #fff);
  border: 1px solid var(--app-border, #e5e7eb);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 14px;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px 16px;
}
.grid > div { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--app-text-secondary, #667085); }
.grid .span-2 { grid-column: 1 / -1; }
.status-line { margin-top: 12px; display: flex; align-items: center; gap: 10px; font-size: 13px; }
.toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.toolbar__actions { display: flex; gap: 8px; }
.is-frequent { color: #b42318; font-weight: 600; }
@media (max-width: 960px) {
  .grid { grid-template-columns: 1fr; }
  .grid .span-2 { grid-column: auto; }
}
</style>
