<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { userErrorMessage } from '../utils/error'
import { promptGoToTaskCenter } from '../utils/taskFlow'
import { Search } from '@element-plus/icons-vue'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import { statusLabel } from '../utils/status'
import { groups, instances, loadMembers, loading, members, refreshDirectory, refreshInstances, type MemberRow } from '../stores/wechatData'
import { resolveFriendCredentials } from '../services/wechat'
import { filterSelectOptions, SELECT_OPTION_LIMIT_SEARCH, useSelectSearchQuery } from '../utils/searchableSelect'

const router = useRouter()

interface JoinRow {
  id: number
  instanceId: string
  roomId: string
  wxid: string
  nickname: string
  avatar: string
  inviter: string
  source: string
  joinAt: string
}

interface FriendStatus {
  status: string
  error: string
  taskStatus: string
  updatedAt: string
}

interface TaskRow {
  id: string
  name: string
  type: string
  status: string
  total: number
  success: number
  failed: number
  skipped: number
  created_at?: string
  updated_at?: string
}

interface TaskItemRow {
  id: string
  task_id: string
  instance_id: string
  target_key: string
  status: string
  error?: string
}

const selectedInstances = ref<string[]>([])
const selectedGroups = ref<string[]>([])
const instanceSearch = useSelectSearchQuery(120)
const groupSearch = useSelectSearchQuery(120)
const activeGroupId = ref('')
const keyword = ref('')
const startFrom = ref(1)
const maxCount = ref(100)
const excludeText = ref('')
const onlyLatestJoins = ref(true)
const sinceHours = ref(72)
const selectedMembers = ref<MemberRow[]>([])
const joinRows = ref<JoinRow[]>([])
const friendStatuses = ref<Record<string, FriendStatus>>({})
const activeTaskId = ref('')
const activeTask = ref<TaskRow | null>(null)
const activeTaskItems = ref<TaskItemRow[]>([])
const taskStartedAt = ref<number | null>(null)
const collectingLatest = ref(false)
const creating = ref(false)

const groupInstanceOptions = computed(() => instances.value.map((item) => ({ label: item.nickname || (item.status === 'ONLINE' ? '正在读取昵称' : '待登录微信'), value: item.id })))

/**
 * 多开场景下按 roomId 汇总去重群列表，优先选用在线微信。
 */
const mergedGroups = computed(() => {
  // 未勾选微信时不展示全部群（空选 ≠ 全选）
  if (!selectedInstances.value.length) return []
  const filtered = groups.value.filter((item) => selectedInstances.value.includes(item.sourceInstanceId))
  const map = new Map<string, { id: string; roomId: string; name: string; members: number; avatar: string; sourceInstanceId: string; sourceInstanceIds: string[] }>()
  for (const item of filtered) {
    const existing = map.get(item.roomId)
    if (!existing) {
      map.set(item.roomId, {
        id: item.roomId,
        roomId: item.roomId,
        name: item.name,
        members: item.members,
        avatar: item.avatar || '',
        sourceInstanceId: item.sourceInstanceId,
        sourceInstanceIds: [item.sourceInstanceId],
      })
      continue
    }
    if (!existing.sourceInstanceIds.includes(item.sourceInstanceId)) existing.sourceInstanceIds.push(item.sourceInstanceId)
    if (item.members > existing.members) existing.members = item.members
    if (item.name && item.name !== item.roomId) existing.name = item.name
    if (item.avatar) existing.avatar = item.avatar
    const online = instances.value.find((instance) => existing.sourceInstanceIds.includes(instance.id) && instance.status === 'ONLINE')
    existing.sourceInstanceId = online?.id || existing.sourceInstanceIds[0]
  }
  return [...map.values()]
})

const groupOptions = computed(() => mergedGroups.value.map((item) => {
  const names = item.sourceInstanceIds.map((id) => groupInstanceOptions.value.find((instance) => instance.value === id)?.label || '所属微信')
  return { label: `${item.name}（${[...new Set(names)].join(' / ')}）`, value: item.id }
}))
/** 顶部筛选下拉的可见选项（搜索 + 限量渲染） */
const visibleInstanceOptions = computed(() => filterSelectOptions(
  groupInstanceOptions.value,
  instanceSearch.query.value,
  selectedInstances.value,
  instanceSearch.query.value.trim() ? SELECT_OPTION_LIMIT_SEARCH : undefined,
))
const visibleFilterGroupOptions = computed(() => filterSelectOptions(
  groupOptions.value,
  groupSearch.query.value,
  selectedGroups.value,
  groupSearch.query.value.trim() ? SELECT_OPTION_LIMIT_SEARCH : undefined,
))
const groupList = computed(() => mergedGroups.value
  .filter((item) => !keyword.value || `${item.name} ${item.roomId}`.toLowerCase().includes(keyword.value.toLowerCase()))
  .map((item) => {
    const preferred = groupInstanceOptions.value.find((instance) => instance.value === item.sourceInstanceId)?.label || '所属微信'
    return {
      ...item,
      avatarText: item.name.slice(0, 1),
      count: item.members >= 0 ? `${item.members} 人` : '人数读取中',
      instanceCount: item.sourceInstanceIds.length,
      preferredInstanceName: preferred,
    }
  }))

/**
 * 按汇总键解析实际可操作的群（含所属微信）。
 * @param groupKey 群选择键（roomId）
 */
function resolveGroup(groupKey: string) {
  const merged = mergedGroups.value.find((item) => item.id === groupKey || item.roomId === groupKey)
  if (!merged) return groups.value.find((item) => item.id === groupKey)
  return groups.value.find((item) => item.roomId === merged.roomId && item.sourceInstanceId === merged.sourceInstanceId)
    || groups.value.find((item) => item.roomId === merged.roomId)
}

const joinKey = (instanceId: string, roomId: string, wxid: string) => `${instanceId}\u0000${roomId}\u0000${wxid}`
const joinMap = computed(() => {
  const map = new Map<string, JoinRow>()
  for (const row of joinRows.value) map.set(joinKey(row.instanceId, row.roomId, row.wxid), row)
  return map
})

/**
 * 判断任务项是否命中明确频繁证据（不以整个任务 COOLING_DOWN 误伤其他成员）。
 * @param error 任务项错误信息
 * @param status 任务项状态
 */
function hasFrequentMark(error?: string, status?: string) {
  if (status === 'FREQUENT') return true
  const text = `${error || ''} ${status || ''}`.toLowerCase()
  return text.includes('已经频繁') || text.includes('频繁') || text.includes('frequent') || text.includes('too many requests')
}

/**
 * 将任务项状态映射为成员“添加状态”文案。
 * @param status 任务项状态
 * @param error 任务项错误信息
 * @param taskStatus 所属任务状态（仅辅助；频繁必须以项级证据为准）
 */
function resolveAddStatus(status?: string, error?: string, _taskStatus?: string) {
  // 频繁必须以该项自身证据为准，避免任务冷却时把排队中的其他人误标为「已经频繁」
  if (hasFrequentMark(error, status)) return '已经频繁'
  if (status === 'SUBMITTED' || status === 'COMPLETED') return '已添加'
  if (status === 'SKIPPED') return '已过滤'
  if (status === 'FAILED' || status === 'PARTIAL_FAILED') return '失败'
  if (status === 'QUEUED' || status === 'RUNNING') return '待执行'
  return '未添加'
}

/**
 * 将最新入群记录转为可加好友的成员行（不依赖当前 members 缓存，避免多群采集被覆盖）。
 * @param row 入群记录
 */
function joinToMember(row: JoinRow): MemberRow {
  const live = members.value.find((item) => item.sourceInstanceId === row.instanceId && item.roomId === row.roomId && item.wxid === row.wxid)
  return {
    wxid: row.wxid,
    nickname: live?.nickname || row.nickname || row.wxid,
    avatar: live?.avatar || row.avatar || '',
    inviter: live?.inviter || row.inviter || '',
    flag: live?.flag || 0,
    roomId: row.roomId,
    sourceInstanceId: row.instanceId,
    raw: live?.raw || {},
  }
}

const groupMembers = computed(() => {
  // 仅最新入群：以 joinRows 为主数据源，避免 loadMembers 覆盖后只剩最后一个群
  if (onlyLatestJoins.value) {
    return joinRows.value.map((row) => {
      const member = joinToMember(row)
      const friend = friendStatuses.value[row.wxid]
      return {
        ...member,
        joinTime: row.joinAt ? new Date(row.joinAt).toLocaleString() : '-',
        fromGroup: groups.value.find((group) => group.roomId === row.roomId && group.sourceInstanceId === row.instanceId)?.name || row.roomId,
        activity: row.source === 'callback' ? '进群回调' : '采集新增',
        addStatus: resolveAddStatus(friend?.status, friend?.error, friend?.taskStatus),
        isLatest: true,
        joinAtSort: row.joinAt || '',
      }
    }).sort((left, right) => String(right.joinAtSort).localeCompare(String(left.joinAtSort)))
  }
  return members.value.map((item) => {
    const join = joinMap.value.get(joinKey(item.sourceInstanceId, item.roomId, item.wxid))
    const friend = friendStatuses.value[item.wxid]
    return {
      ...item,
      joinTime: join?.joinAt ? new Date(join.joinAt).toLocaleString() : '-',
      fromGroup: groups.value.find((group) => group.roomId === item.roomId && group.sourceInstanceId === item.sourceInstanceId)?.name || item.roomId,
      activity: join ? (join.source === 'callback' ? '进群回调' : '采集新增') : '-',
      addStatus: resolveAddStatus(friend?.status, friend?.error, friend?.taskStatus),
      isLatest: Boolean(join),
      joinAtSort: join?.joinAt || '',
    }
  })
})

const selectedMemberCount = computed(() => selectedMembers.value.length)
const latestMemberCount = computed(() => joinRows.value.length)

const groupProgress = computed(() => {
  const task = activeTask.value
  if (!task) {
    return { status: '未运行', duration: '-', percent: 0, scanned: 0, pending: 0, added: 0, filtered: 0, frequent: 0, failed: 0, instance: '-' }
  }
  const items = activeTaskItems.value
  // 冷却中排队项仍属「待执行」，不能计入「已经频繁」，否则进度与计数会被放大
  const frequent = items.filter((item) => hasFrequentMark(item.error, item.status)).length
  const added = items.filter((item) => ['SUBMITTED', 'COMPLETED'].includes(item.status) && !hasFrequentMark(item.error, item.status)).length
  const filtered = items.filter((item) => item.status === 'SKIPPED').length
  const failed = items.filter((item) => item.status === 'FAILED').length
  const pending = items.filter((item) => ['QUEUED', 'RUNNING'].includes(item.status)).length
  const done = Math.min(items.length, added + filtered + failed + frequent)
  const total = Number(task.total || items.length || 0)
  const percent = total ? Math.min(100, Math.round(done / total * 100)) : 0
  const started = taskStartedAt.value || (task.created_at ? Date.parse(task.created_at) : Date.now())
  const durationMs = Math.max(Date.now() - started, 0)
  const minutes = Math.floor(durationMs / 60000)
  const seconds = Math.floor((durationMs % 60000) / 1000)
  const instanceIds = [...new Set(items.map((item) => item.instance_id).filter(Boolean))]
  const instanceLabel = instanceIds.map((id) => instances.value.find((item) => item.id === id)?.nickname || id).join('、') || '-'
  return {
    status: statusLabel(task.status),
    duration: `${minutes}分${seconds}秒`,
    percent,
    scanned: done,
    pending,
    added,
    filtered,
    frequent,
    failed,
    instance: instanceLabel,
  }
})

const groupRuleText = {
  once: '添加好友前会先检查成员资料；资料不完整时不会发送好友申请。同一微信号对同一成员默认只加一次。',
  tips: [
    '最新入群来源：进群回调实时记录，或“重新采集/采集最新成员”时与上次成员快照对比的新增成员。',
    '首次采集某群只会建立基线，不会把全员当成最新入群。',
    '出现操作频繁后任务会进入冷却，成员添加状态同步标记为「已经频繁」。',
    '所有批量操作必须先勾选目标；也可直接使用“添加最新入群成员”。',
  ],
}
const MEMBER_PROFILE_REQUEST_INTERVAL_MS = 200
const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

let stopEvent: (() => void) | undefined
let progressTimer: ReturnType<typeof setInterval> | undefined

/**
 * 刷新实例与通讯录目录。
 */
async function refresh() {
  await refreshInstances()
  // 不默认全选微信；仅清理已失效实例，保留用户当前勾选
  const valid = new Set(instances.value.map((item) => item.id))
  selectedInstances.value = selectedInstances.value.filter((id) => valid.has(id))
  await refreshDirectory(selectedInstances.value)
  selectedGroups.value ||= []
  await refreshJoinRows()
}

/**
 * 拉取指定群的成员列表。
 * @param groupKey 群列表主键（instanceId + roomId）
 */
async function refreshMembers(groupKey = activeGroupId.value || selectedGroups.value[0]) {
  const group = resolveGroup(groupKey)
  if (!group) {
    ElMessage.warning('请先在左侧点击或勾选一个群聊')
    return
  }
  try {
    await loadMembers(group.sourceInstanceId, group.roomId)
    await refreshJoinRows()
    await refreshFriendStatuses()
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '获取群成员失败'))
  }
}

/**
 * 刷新最新入群成员记录。
 */
async function refreshJoinRows() {
  // 未勾选微信时不回退成「全部微信」；空选 = 无数据
  if (!selectedInstances.value.length) {
    joinRows.value = []
    return
  }
  const instanceIds = selectedInstances.value
  const roomIds = selectedGroups.value.length
    ? selectedGroups.value.map((id) => resolveGroup(id)?.roomId || id).filter(Boolean)
    : activeGroupId.value
      ? [resolveGroup(activeGroupId.value)?.roomId || activeGroupId.value].filter(Boolean)
      : []
  joinRows.value = await window.wxControl?.listMemberJoins?.({
    instanceIds,
    roomIds: roomIds.length ? roomIds : undefined,
    sinceHours: Math.max(Number(sinceHours.value) || 0, 0) || undefined,
    limit: 5000,
  }) ?? []
}

/**
 * 刷新成员加好友状态（当前群成员 + 最新入群记录一并查询）。
 */
async function refreshFriendStatuses() {
  const keys = [...new Set([
    ...members.value.map((item) => item.wxid),
    ...joinRows.value.map((item) => item.wxid),
  ].filter(Boolean))]
  friendStatuses.value = keys.length ? await window.wxControl?.listFriendAddStatuses?.(keys) ?? {} : {}
}

/**
 * 刷新当前加好友任务进度。
 */
async function refreshTaskProgress() {
  if (!activeTaskId.value) {
    activeTask.value = null
    activeTaskItems.value = []
    return
  }
  const tasks = await window.wxControl?.listTasks() ?? []
  activeTask.value = (tasks as TaskRow[]).find((item) => item.id === activeTaskId.value) || null
  activeTaskItems.value = activeTaskId.value
    ? (await window.wxControl?.taskItems(activeTaskId.value) ?? []) as TaskItemRow[]
    : []
  await refreshFriendStatuses()
}

function selectGroup(groupKey: string) {
  activeGroupId.value = groupKey
  void refreshMembers(groupKey)
}
function toggleGroup(groupKey: string, checked: boolean) {
  selectedGroups.value = checked ? [...new Set([...selectedGroups.value, groupKey])] : selectedGroups.value.filter((item) => item !== groupKey)
}
function selectAllGroups() { selectedGroups.value = [...new Set([...selectedGroups.value, ...groupList.value.map((item) => item.id)])] }
function clearSelectedGroups() { selectedGroups.value = [] }
/** 顶部「选择微信」下拉一键全选 */
function selectAllFilterInstances() { selectedInstances.value = groupInstanceOptions.value.map((item) => item.value) }
/** 顶部「选择微信」下拉全不选 */
function clearFilterInstances() { selectedInstances.value = [] }
/** 顶部「选择群聊」下拉一键全选（当前筛选范围内全部群） */
function selectAllFilterGroups() { selectedGroups.value = groupOptions.value.map((item) => item.value) }
/** 顶部「选择群聊」下拉全不选 */
function clearFilterGroups() { selectedGroups.value = [] }

/**
 * 从资料响应中提取加好友所需的 v3/v4 凭证。
 * @param value 接口原始响应
 * @param key v3 或 v4
 */
/**
 * 按筛选规则生成候选成员列表。
 * @param source 勾选成员或最新入群成员
 */
function filterCandidates(source: MemberRow[]) {
  const excluded = excludeText.value.split(/[\r\n,，]+/).map((item) => item.trim().toLowerCase()).filter(Boolean)
  return source
    .filter((member) => !excluded.some((rule) => member.wxid.toLowerCase() === rule || member.nickname.trim().toLowerCase() === rule))
    .slice(Math.max(startFrom.value - 1, 0), Math.max(startFrom.value - 1, 0) + Math.max(maxCount.value, 0))
}

const DEFAULT_FRIEND_VERIFY_CONTENT = '你好，我是群里的朋友'

/**
 * 创建加好友任务（需求 7 与普通加群成员共用执行链路，频繁状态由任务引擎写入）。
 * @param sourceMembers 待添加成员
 * @param taskName 任务名称
 */
async function createAddFriendTask(sourceMembers = selectedMembers.value, taskName = `群成员加好友 ${new Date().toLocaleString()}`) {
  if (!sourceMembers.length) return ElMessage.warning('请先勾选群成员，或先采集最新入群成员')
  const candidates = filterCandidates(sourceMembers)
  if (!candidates.length) return ElMessage.warning('按起始位置、最大人数和排除规则筛选后没有可处理的成员')
  let prompt: { value: string }
  try {
    prompt = await ElMessageBox.prompt('添加好友验证内容', '创建加好友任务', { inputPlaceholder: `可不填，默认：${DEFAULT_FRIEND_VERIFY_CONTENT}` })
    await ElMessageBox.confirm(`筛选后将检查 ${candidates.length} 名成员的好友资料，只有资料完整的成员会进入任务。`, '确认检查成员资料', { type: 'warning' })
  } catch {
    return
  }
  creating.value = true
  const items: Array<Record<string, unknown>> = []
  let skippedSelf = 0
  let unavailable = 0
  let profileRequestCount = 0
  try {
    for (const member of candidates) {
      const instance = instances.value.find((item) => item.id === member.sourceInstanceId)
      if (!instance) { unavailable += 1; continue }
      if (instance.accountWxid && member.wxid === instance.accountWxid) { skippedSelf += 1; continue }
      if (profileRequestCount > 0) await wait(MEMBER_PROFILE_REQUEST_INTERVAL_MS)
      profileRequestCount += 1
      const credentials = await resolveFriendCredentials(instance, member.wxid, member.roomId)
      const { v3, v4 } = credentials
      if (!v3 || !v4) {
        unavailable += 1
        void window.wxControl?.reportError?.('群成员加好友资料仍不完整', {
          module: '群成员加好友', operation: '解析加好友凭证', instanceId: instance.id,
          accountWxid: instance.accountWxid, targetWxid: member.wxid, roomId: member.roomId, missing: credentials.missing.join(','), attempts: credentials.attempts.join('、'),
          ...(credentials.diagnostics.at(-1) || {}),
        })
        continue
      }
      items.push({ instanceId: instance.id, targetKey: member.wxid, request: { v3, v4, scence: '3', friendFlg: '0', verifyContent: String(prompt.value || '').trim() || DEFAULT_FRIEND_VERIFY_CONTENT } })
    }
    if (!items.length) {
      const reasons = [skippedSelf ? `已排除本人 ${skippedSelf} 人` : '', unavailable ? `暂时无法取得资料 ${unavailable} 人` : ''].filter(Boolean).join('，')
      return ElMessage.warning(`没有可创建任务的成员${reasons ? `：${reasons}` : ''}`)
    }
    const created = await window.wxControl?.createTask({ name: taskName, type: 'ADD_FRIEND', config: { coolMinutes: 30 }, items }) as Record<string, unknown> | undefined
    const deduplicated = Number(created?.deduplicated || 0)
    const skipped = [skippedSelf ? `排除本人 ${skippedSelf} 人` : '', unavailable ? `资料暂不可用 ${unavailable} 人` : ''].filter(Boolean).join('，')
    const duplicateText = deduplicated ? `，已跳过 ${deduplicated} 名曾处理成员` : ''
    activeTaskId.value = String(created?.id || '')
    taskStartedAt.value = Date.now()
    await refreshTaskProgress()
    const total = Number(created?.total || items.length) || items.length
    await promptGoToTaskCenter(router, `已创建 ${total} 项加好友任务${duplicateText}${skipped ? `，${skipped}` : ''}`)
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '创建加好友任务失败'))
  } finally {
    creating.value = false
  }
}

/**
 * 采集勾选群的成员，识别相对上次快照的最新入群成员。
 */
async function collectLatestMembers() {
  const targets = selectedGroups.value.length
    ? selectedGroups.value
    : activeGroupId.value
      ? [activeGroupId.value]
      : []
  if (!targets.length) return ElMessage.warning('请先勾选要采集的群聊')
  collectingLatest.value = true
  onlyLatestJoins.value = true
  let success = 0
  let failed = 0
  try {
    for (const groupKey of targets) {
      const group = resolveGroup(groupKey)
      if (!group) { failed += 1; continue }
      try {
        await loadMembers(group.sourceInstanceId, group.roomId)
        success += 1
      } catch {
        failed += 1
      }
    }
    await refreshJoinRows()
    await refreshFriendStatuses()
    selectedMembers.value = []
    ElMessage.success(`采集完成：成功 ${success} 个群，失败 ${failed} 个，识别最新入群 ${joinRows.value.length} 人。请勾选后再创建加好友任务。`)
  } finally {
    collectingLatest.value = false
  }
}

/**
 * 将已勾选的最新入群成员创建加好友任务（无勾选不执行）。
 */
async function addLatestMembers() {
  if (!selectedMemberCount.value) return ElMessage.warning('请先勾选要添加的最新入群成员')
  const source = selectedMembers.value.filter((item) => joinMap.value.has(joinKey(item.sourceInstanceId, item.roomId, item.wxid)) || onlyLatestJoins.value)
  const candidates = source.length ? source : selectedMembers.value
  if (!candidates.length) return ElMessage.warning('请先勾选要添加的成员')
  await createAddFriendTask(candidates, `最新入群加好友 ${new Date().toLocaleString()}`)
}

/**
 * 暂停当前页面跟踪的加好友任务。
 */
async function pauseActiveTask() {
  if (!activeTaskId.value) return ElMessage.warning('当前没有可暂停的加好友任务')
  await window.wxControl?.pauseTask(activeTaskId.value)
  await refreshTaskProgress()
  ElMessage.success('任务已暂停')
}

watch(() => selectedGroups.value[0], (roomId) => {
  if (roomId && !activeGroupId.value) {
    activeGroupId.value = roomId
    void refreshMembers(roomId)
  }
})
watch(selectedInstances, () => {
  const valid = new Set(mergedGroups.value.map((item) => item.id))
  selectedGroups.value = selectedGroups.value.filter((id) => valid.has(id))
  if (activeGroupId.value && !valid.has(activeGroupId.value)) activeGroupId.value = selectedGroups.value[0] || ''
})
watch([selectedInstances, selectedGroups, sinceHours], () => { void refreshJoinRows() })
watch(onlyLatestJoins, () => { selectedMembers.value = [] })

onMounted(async () => {
  await refresh()
  stopEvent = window.wxControl?.onEvent((payload) => {
    const event = payload.event as Record<string, unknown> | undefined
    const desc = String(event?.event_desc ?? event?.eventDesc ?? '')
    const data = event?.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : null
    const roomId = String(data?.roomid || data?.roomId || data?.room_id || '')
    if (/进群|入群|加入群|新成员|邀请进群/.test(desc) || (roomId.endsWith('@chatroom') && (data?.memberlist || data?.memberList))) {
      void refreshJoinRows().then(() => refreshFriendStatuses())
    }
  })
  progressTimer = setInterval(() => { void refreshTaskProgress() }, 3000)
})
onBeforeUnmount(() => {
  stopEvent?.()
  if (progressTimer) clearInterval(progressTimer)
})
</script>

<template>
  <div class="app-page">
    <PageHeader
      title="群与成员"
      subtitle="勾选群 → 采集/勾选成员 → 创建任务 → 到任务中心确认。多开同群会显示将用哪个微信操作。"
    />

    <section class="app-card filter-card">
      <div class="filter-grid">
        <div class="filter-item">
          <div class="field-label-row">
            <span>选择微信（可搜索）</span>
            <span class="field-select-actions">
              <el-button class="field-select-all" link type="primary" :disabled="!groupInstanceOptions.length" @click.stop="selectAllFilterInstances">全选</el-button>
              <el-button link type="info" :disabled="!selectedInstances.length" @click.stop="clearFilterInstances">全不选</el-button>
            </span>
          </div>
          <el-select
            v-model="selectedInstances"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="输入昵称搜索；不选则不展示群"
            style="width: 100%"
            :filter-method="instanceSearch.setQuery"
            @visible-change="(open: boolean) => { if (!open) instanceSearch.clearQuery() }"
          >
            <el-option v-for="o in visibleInstanceOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
        </div>
        <div class="filter-item">
          <div class="field-label-row">
            <span>选择群聊（可搜索）</span>
            <span class="field-select-actions">
              <el-button class="field-select-all" link type="primary" :disabled="!groupOptions.length" @click.stop="selectAllFilterGroups">全选</el-button>
              <el-button link type="info" :disabled="!selectedGroups.length" @click.stop="clearFilterGroups">全不选</el-button>
            </span>
          </div>
          <el-select
            v-model="selectedGroups"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="请先选择微信，再搜索群名/群ID"
            style="width: 100%"
            :filter-method="groupSearch.setQuery"
            @visible-change="(open: boolean) => { if (!open) groupSearch.clearQuery() }"
          >
            <el-option v-for="o in visibleFilterGroupOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <span v-if="groupOptions.length > visibleFilterGroupOptions.length" class="muted select-hint">已显示部分群，继续输入可精确匹配全部 {{ groupOptions.length }} 个</span>
        </div>
        <div class="filter-item">
          <label>搜索群名称或群备注</label>
          <el-input v-model="keyword" :prefix-icon="Search" clearable />
        </div>
        <div class="filter-item">
          <label>从第几个开始</label>
          <el-input-number v-model="startFrom" :min="1" controls-position="right" style="width: 100%" />
        </div>
        <div class="filter-item">
          <label>最大采集人数</label>
          <el-input-number v-model="maxCount" :min="1" controls-position="right" style="width: 100%" />
        </div>
        <div class="filter-item">
          <label>最新入群时间窗（小时）</label>
          <el-input-number v-model="sinceHours" :min="1" :max="720" controls-position="right" style="width: 100%" />
        </div>
        <div class="filter-item">
          <label>仅显示最新入群</label>
          <el-switch v-model="onlyLatestJoins" active-text="开" inactive-text="关" />
        </div>
        <div class="filter-item">
          <label>随机间隔（秒）</label>
          <div class="muted">使用系统设置中的全局随机间隔</div>
        </div>
        <div class="filter-item filter-item--wide">
          <label>排除规则（WXID / 昵称）</label>
          <el-input v-model="excludeText" type="textarea" :rows="2" />
        </div>
      </div>
    </section>

    <div class="split-3 page-split">
      <section class="app-card block">
        <div class="group-list__header">
          <h3 class="section-title">群聊列表</h3>
          <div class="group-list__actions">
            <span class="muted">已选 {{ selectedGroups.length }} 个</span>
            <el-button link type="primary" :disabled="!groupList.length" @click="selectAllGroups">全选</el-button>
            <el-button link :disabled="!selectedGroups.length" @click="clearSelectedGroups">清空</el-button>
          </div>
        </div>
        <div class="group-list panel-scroll">
          <div v-for="g in groupList" :key="g.id" class="group-item" :class="{ 'is-active': activeGroupId === g.id }" role="button" tabindex="0" @click="selectGroup(g.id)" @keyup.enter="selectGroup(g.id)">
            <el-checkbox :model-value="selectedGroups.includes(g.id)" @click.stop @change="toggleGroup(g.id, Boolean($event))" />
            <el-avatar :size="36" :src="g.avatar || undefined">{{ g.avatarText }}</el-avatar>
            <div class="group-item__meta">
              <div class="ellip">{{ g.name }}</div>
              <div class="muted">{{ g.count }} · 用 {{ g.preferredInstanceName }}{{ g.instanceCount > 1 ? `（共 ${g.instanceCount} 个微信）` : '' }}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="app-card block">
        <div class="group-list__header">
          <h3 class="section-title">{{ onlyLatestJoins ? '最新入群成员' : '群成员列表' }}</h3>
          <span class="muted">最新 {{ latestMemberCount }} 人</span>
        </div>
        <div class="table-wrap">
          <el-table v-loading="loading || collectingLatest" :data="groupMembers" stripe height="420" style="width: 100%" @selection-change="selectedMembers = $event">
            <el-table-column type="selection" width="48" />
            <el-table-column label="头像" width="70">
              <template #default="{ row }">
                <el-avatar :size="28" :src="row.avatar || undefined">{{ (row.nickname || row.wxid).slice(0, 1) }}</el-avatar>
              </template>
            </el-table-column>
            <el-table-column prop="nickname" label="昵称" min-width="110" show-overflow-tooltip />
            <el-table-column prop="wxid" label="微信号" min-width="140" show-overflow-tooltip />
            <el-table-column prop="joinTime" label="入群时间" min-width="150" show-overflow-tooltip />
            <el-table-column prop="fromGroup" label="来源群聊" min-width="120" show-overflow-tooltip />
            <el-table-column prop="activity" label="来源" width="100" />
            <el-table-column label="添加状态" width="110">
              <template #default="{ row }"><StatusTag :text="row.addStatus" /></template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <aside class="app-card block side-panel panel-scroll">
        <h3 class="section-title">规则说明</h3>
        <div class="side-block">
          <h4>只加一次规则说明</h4>
          <p>{{ groupRuleText.once }}</p>
        </div>

        <div class="side-block">
          <h4>任务实时进度</h4>
          <div class="field-grid compact">
            <div class="field-item"><div class="label">当前状态</div><div class="value"><StatusTag :text="groupProgress.status" /></div></div>
            <div class="field-item"><div class="label">已运行时长</div><div class="value">{{ groupProgress.duration }}</div></div>
          </div>
          <el-progress :percentage="groupProgress.percent" :stroke-width="10" style="margin: 10px 0" />
          <div class="progress-grid">
            <div><span>已扫描</span><b>{{ groupProgress.scanned }}</b></div>
            <div><span>待添加</span><b>{{ groupProgress.pending }}</b></div>
            <div><span>已添加</span><b>{{ groupProgress.added }}</b></div>
            <div><span>已过滤</span><b>{{ groupProgress.filtered }}</b></div>
            <div><span>已经频繁</span><b>{{ groupProgress.frequent }}</b></div>
            <div><span>失败</span><b>{{ groupProgress.failed }}</b></div>
          </div>
          <div class="muted" style="margin-top: 8px">当前实例：{{ groupProgress.instance }}</div>
        </div>

        <div class="side-block">
          <h4>温馨提示</h4>
          <ul>
            <li v-for="(tip, idx) in groupRuleText.tips" :key="idx">{{ tip }}</li>
          </ul>
        </div>
      </aside>
    </div>

    <div class="bottom-bar">
      <div class="muted">
        已选择人数 <b>{{ selectedMemberCount }}</b>
        · 最新入群 <b>{{ latestMemberCount }}</b>
      </div>
      <div class="toolbar-right">
        <el-button :loading="collectingLatest" @click="collectLatestMembers">采集最新成员</el-button>
        <el-button v-if="onlyLatestJoins" type="primary" :loading="creating" :disabled="!selectedMemberCount" @click="addLatestMembers">添加最新入群成员</el-button>
        <el-button :loading="creating" :disabled="!selectedMemberCount" @click="createAddFriendTask()">创建加好友任务</el-button>
        <el-button :disabled="!activeTaskId" @click="pauseActiveTask">暂停</el-button>
        <el-button @click="refreshMembers()">重新采集</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filter-card,
.block {
  padding: 14px 16px;
  min-width: 0;
  overflow: hidden;
}

.filter-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px 16px;
  min-width: 0;
}

@media (max-width: 1500px) {
  .filter-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.filter-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.filter-item label,
.filter-item .field-label-row {
  color: var(--app-text-secondary);
  font-size: 12px;
}

.filter-item--wide {
  grid-column: 1 / -1;
}

.page-split {
  min-height: 420px;
  align-items: stretch;
}

.group-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 420px;
}

.group-list__header,
.group-list__actions {
  display: flex;
  align-items: center;
}

.group-list__header {
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}

.group-list__header .section-title {
  margin: 0;
}

.group-list__actions {
  gap: 4px;
  white-space: nowrap;
}

.group-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  cursor: pointer;
  background: #fbfbfc;
}

.group-item.is-active {
  border-color: rgba(20, 184, 166, 0.45);
  background: rgba(20, 184, 166, 0.06);
}

.group-item__meta {
  min-width: 0;
}

.side-panel h4 {
  margin: 0 0 8px;
  font-size: 13px;
}

.side-block {
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--app-border);
}

.side-block:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.side-block p,
.side-block ul {
  margin: 0;
  color: var(--app-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.side-block ul {
  padding-left: 18px;
}

.progress-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.progress-grid div {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--app-text-secondary);
  background: #f7f8fa;
  border-radius: 6px;
  padding: 8px 10px;
}

.progress-grid b {
  color: var(--app-text);
}

.compact .field-item {
  grid-template-columns: 90px 1fr;
}
</style>
