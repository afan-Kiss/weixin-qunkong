<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Plus } from '@element-plus/icons-vue'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import StatCard from '../components/cards/StatCard.vue'
import VirtualTargetTable from '../components/app/VirtualTargetTable.vue'
import { userErrorMessage } from '../utils/error'
import { promptGoToTaskCenter } from '../utils/taskFlow'
import { filterSelectOptions, SELECT_OPTION_LIMIT_SEARCH, useSelectSearchQuery } from '../utils/searchableSelect'
import {
  isOfficialAccountWxid,
  nicknameExactExcluded,
  remarkMatchesExclude,
  splitExcludeRules,
  wxidExactExcluded,
} from '../utils/broadcastTargets'
import { friends, groups, instances, refreshDirectory, refreshInstances, type ContactRow, type GroupRow } from '../stores/wechatData'

const router = useRouter()

const activeTab = ref('好友群发')
const broadcastTabs = ['好友群发', '群聊群发']
const selectedInstanceIds = ref<string[]>([])
const keyword = ref('')
const excludeWxid = ref('')
const excludeNick = ref('')
const excludeRemark = ref('')
const messageText = ref('')
const imagePath = ref('')
const imagePreview = ref('')
const pastingImage = ref(false)
const sendMode = ref('now')
const scheduledAt = ref<Date | null>(null)
const skipSame = ref(true)
const autoRetry = ref(true)
const retryTimes = ref(2)
const retryMinutes = ref(5)

type TargetRow = {
  rowKey: string
  nickname: string
  wxid: string
  remark: string
  status: string
  tag: string
  sourceInstanceId: string
  accountLabel: string
}

const selectedTargets = ref<TargetRow[]>([])
const selectedKeyList = computed(() => selectedTargets.value.map((item) => item.rowKey))
const tasks = ref<Array<Record<string, unknown>>>([])
const lastCreatedTaskId = ref('')
const creating = ref(false)
const instanceSearch = useSelectSearchQuery()

const targetColumns = computed(() => {
  if (activeTab.value === '好友群发') {
    return [
      { key: 'accountLabel', label: '发送微信', minWidth: 150, flex: 1.2 },
      { key: 'nickname', label: '昵称', minWidth: 120, flex: 1 },
      { key: 'remark', label: '备注', minWidth: 120, flex: 1 },
      { key: 'wxid', label: '微信号', minWidth: 150, flex: 1.2 },
      { key: 'status', label: '状态', width: 90, minWidth: 90 },
    ]
  }
  return [
    { key: 'accountLabel', label: '发送微信', minWidth: 150, flex: 1.2 },
    { key: 'nickname', label: '昵称', minWidth: 120, flex: 1 },
    { key: 'wxid', label: '群ID', minWidth: 160, flex: 1.2 },
    { key: 'status', label: '状态', width: 90, minWidth: 90 },
    { key: 'tag', label: '标签', minWidth: 100, flex: 0.8 },
  ]
})

function accountLabelOf(instanceId: string) {
  const account = instances.value.find((item) => item.id === instanceId)
  if (!account) return '未知微信'
  const idText = account.alias || account.accountWxid || ''
  const name = account.nickname || (account.status === 'ONLINE' ? '正在读取昵称' : '待登录微信')
  const base = idText ? `${name}（${idText}）` : name
  return account.status === 'ONLINE' ? base : `${base} · 离线`
}

const instanceOptions = computed(() => {
  const list = instances.value.map((item) => ({
    label: accountLabelOf(item.id),
    value: item.id,
    online: item.status === 'ONLINE',
  }))
  return [...list].sort((a, b) => Number(b.online) - Number(a.online))
})

const visibleInstanceOptions = computed(() => filterSelectOptions(
  instanceOptions.value,
  instanceSearch.query.value,
  selectedInstanceIds.value,
  instanceSearch.query.value.trim() ? SELECT_OPTION_LIMIT_SEARCH : 80,
))

function selectAllInstances() {
  selectedInstanceIds.value = instanceOptions.value.map((item) => item.value)
}

function clearSelectedInstances() {
  selectedInstanceIds.value = []
}

const broadcastFriends = computed<TargetRow[]>(() => {
  if (!selectedInstanceIds.value.length) return []
  const selected = new Set(selectedInstanceIds.value)
  // 两千好友时避免每行都 find 一遍账号标签
  const accountLabels = new Map<string, string>()
  for (const id of selectedInstanceIds.value) {
    accountLabels.set(id, accountLabelOf(id))
  }
  const owned: TargetRow[] = activeTab.value === '好友群发'
    ? friends.value
      .filter((item: ContactRow) => selected.has(item.sourceInstanceId)
        && !isOfficialAccountWxid(item.wxid)
        && !String(item.wxid || '').endsWith('@chatroom'))
      .map((item: ContactRow) => ({
        rowKey: `${item.sourceInstanceId}::${item.wxid}`,
        nickname: item.nickname || item.wxid,
        wxid: item.wxid,
        remark: item.remark || '',
        status: '可用',
        tag: item.remark || '',
        sourceInstanceId: item.sourceInstanceId,
        accountLabel: accountLabels.get(item.sourceInstanceId) || '未知微信',
      }))
    : groups.value
      .filter((item: GroupRow) => selected.has(item.sourceInstanceId) && String(item.roomId || '').endsWith('@chatroom'))
      .map((item: GroupRow) => ({
        rowKey: `${item.sourceInstanceId}::${item.roomId}`,
        nickname: item.name,
        wxid: item.roomId,
        remark: '',
        status: '可用',
        tag: item.saved ? '已保存' : '未保存',
        sourceInstanceId: item.sourceInstanceId,
        accountLabel: accountLabels.get(item.sourceInstanceId) || '未知微信',
      }))
  const terms = keyword.value.trim().toLowerCase()
  const excludedIds = new Set(splitExcludeRules(excludeWxid.value).map((item) => item.toLowerCase()))
  const excludedNames = new Set(splitExcludeRules(excludeNick.value).map((item) => item.toLowerCase()))
  const remarkRules = splitExcludeRules(excludeRemark.value)
  return owned.filter((item) => {
    if (terms && !`${item.nickname} ${item.wxid} ${item.remark} ${item.accountLabel}`.toLowerCase().includes(terms)) return false
    if (wxidExactExcluded(item.wxid, excludedIds)) return false
    if (nicknameExactExcluded(item.nickname, excludedNames)) return false
    if (activeTab.value === '好友群发' && remarkMatchesExclude(item.remark, remarkRules)) return false
    return true
  })
})

const broadcastStats = computed(() => [
  { title: '已选微信号', value: String(selectedInstanceIds.value.length) },
  { title: activeTab.value === '好友群发' ? '可选好友' : '可选群聊', value: String(broadcastFriends.value.length) },
  { title: '已勾选对象', value: String(selectedTargets.value.length) },
])

const currentTask = computed(() => {
  if (lastCreatedTaskId.value) {
    const matched = tasks.value.find((item) => String(item.id) === lastCreatedTaskId.value)
    if (matched) return matched
  }
  const typePrefix = activeTab.value === '群聊群发' ? 'TO_GROUP' : 'TO_FRIEND'
  return tasks.value.find((item) => String(item.type || '').includes(typePrefix)) || {}
})

const broadcastProgress = computed(() => {
  const task = currentTask.value
  const total = Number(task.total || 0)
  const done = Number(task.success || 0) + Number(task.failed || 0) + Number(task.skipped || 0)
  return {
    percent: total ? Math.round(done / total * 100) : 0,
    sent: String(task.success || 0),
    failed: String(task.failed || 0),
    skipped: String(task.skipped || 0),
    pending: String(Math.max(total - done, 0)),
    eta: task.status ? String(task.status) : '-',
  }
})

const canPauseCurrent = computed(() => ['RUNNING', 'QUEUED', 'COOLING_DOWN'].includes(String(currentTask.value.status || '')))
const canResumeCurrent = computed(() => ['PAUSED', 'COOLING_DOWN'].includes(String(currentTask.value.status || '')))
const broadcastWarnings = computed(() => tasks.value.filter((item) => item.status === 'COOLING_DOWN').map((item) => ({ id: String(item.id), account: String(item.name), desc: '检测到明确频繁证据，任务已暂停', time: String(item.updated_at || '') })))
const broadcastContent = computed(() => ({ imageName: imagePath.value || '未选择图片' }))

function formatAccountSummary(targets: TargetRow[]) {
  const counts = new Map<string, number>()
  for (const target of targets) {
    const label = target.accountLabel || accountLabelOf(target.sourceInstanceId)
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  return [...counts.entries()].map(([label, count]) => `${label} → ${count} 个对象`).join('\n')
}

/** 全选当前过滤列表（虚表只渲染可见行，但勾选集合覆盖全部行） */
function selectAllFilteredTargets(selected: boolean) {
  if (!selected) {
    selectedTargets.value = []
    return
  }
  selectedTargets.value = broadcastFriends.value.slice()
}

function toggleTargetRow(rowKey: string, selected: boolean) {
  if (selected) {
    if (selectedTargets.value.some((item) => item.rowKey === rowKey)) return
    const row = broadcastFriends.value.find((item) => item.rowKey === rowKey)
    if (row) selectedTargets.value = [...selectedTargets.value, row]
    return
  }
  selectedTargets.value = selectedTargets.value.filter((item) => item.rowKey !== rowKey)
}

/** 创建前再按当前排除规则筛一遍，防止勾选状态与列表过滤短暂不同步时误发 */
function resolveSendableTargets() {
  const allowedKeys = new Set(broadcastFriends.value.map((item) => item.rowKey))
  const remarkRules = splitExcludeRules(excludeRemark.value)
  const excludedIds = new Set(splitExcludeRules(excludeWxid.value).map((item) => item.toLowerCase()))
  const excludedNames = new Set(splitExcludeRules(excludeNick.value).map((item) => item.toLowerCase()))
  const isGroup = activeTab.value === '群聊群发'
  return selectedTargets.value.filter((target) => {
    if (!allowedKeys.has(target.rowKey)) return false
    if (!isGroup && isOfficialAccountWxid(target.wxid)) return false
    if (wxidExactExcluded(target.wxid, excludedIds)) return false
    if (nicknameExactExcluded(target.nickname, excludedNames)) return false
    if (!isGroup && remarkMatchesExclude(target.remark, remarkRules)) return false
    return true
  })
}

watch(activeTab, () => { selectedTargets.value = [] })
watch(selectedInstanceIds, () => {
  const allowed = new Set(selectedInstanceIds.value)
  selectedTargets.value = selectedTargets.value.filter((item) => allowed.has(item.sourceInstanceId))
})
watch(broadcastFriends, (rows) => {
  const allowed = new Set(rows.map((item) => item.rowKey))
  selectedTargets.value = selectedTargets.value.filter((item) => allowed.has(item.rowKey))
})

async function refresh() {
  await refreshInstances()
  const valid = new Set(instances.value.map((item) => item.id))
  selectedInstanceIds.value = selectedInstanceIds.value.filter((id) => valid.has(id))
  await refreshDirectory(selectedInstanceIds.value.length ? selectedInstanceIds.value : undefined)
  tasks.value = (await window.wxControl?.listTasks() ?? []) as Array<Record<string, unknown>>
}

function preview() {
  if (!selectedInstanceIds.value.length) return ElMessage.warning('请先勾选要用的发送微信号')
  const targets = resolveSendableTargets()
  if (!targets.length) return ElMessage.warning('请先勾选接收对象')
  if (!messageText.value.trim() && !imagePath.value) return ElMessage.warning('请输入文字或选择图片')
  ElMessageBox.alert(
    `发送微信号与对象：\n${formatAccountSummary(targets)}\n\n文字：${messageText.value.trim() || '不发送'}\n图片：${imagePath.value || '不发送'}`,
    '发送预览',
    { confirmButtonText: '关闭' },
  )
}

/**
 * 暂停当前页跟踪的群发任务。
 */
async function pauseCurrentBroadcast() {
  const id = String(currentTask.value.id || lastCreatedTaskId.value || '')
  if (!id) return ElMessage.warning('当前没有可暂停的群发任务，请到任务中心操作')
  await window.wxControl?.pauseTask?.(id)
  ElMessage.success('任务已暂停')
  await refresh()
}

/**
 * 继续当前页已暂停/冷却中的群发任务。
 */
async function resumeCurrentBroadcast() {
  const id = String(currentTask.value.id || lastCreatedTaskId.value || '')
  if (!id) return ElMessage.warning('当前没有可继续的群发任务，请到任务中心操作')
  try {
    await window.wxControl?.resumeTask?.(id)
    ElMessage.success('任务已继续执行')
    await refresh()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '继续任务失败')
  }
}

async function createBroadcast() {
  if (!selectedInstanceIds.value.length) return ElMessage.warning('请先勾选要用的发送微信号')
  const targets = resolveSendableTargets()
  if (!targets.length) return ElMessage.warning('请先勾选接收对象（已按排除规则过滤）')
  selectedTargets.value = targets
  const hasText = Boolean(messageText.value.trim())
  const hasImage = Boolean(imagePath.value)
  if (!hasText && !hasImage) return ElMessage.warning('请输入文字或选择图片')
  if (hasImage && !String(imagePath.value || '').trim()) return ElMessage.warning('请重新选择图片')
  if (sendMode.value === 'schedule' && (!scheduledAt.value || scheduledAt.value.getTime() <= Date.now())) return ElMessage.warning('请选择未来的发送时间')
  const isGroup = activeTab.value === '群聊群发'
  const mismatched = targets.filter((target) => isGroup !== String(target.wxid || '').endsWith('@chatroom'))
  if (mismatched.length) return ElMessage.warning(isGroup ? '勾选对象里混入了好友，请切换到「好友群发」或重新勾选群聊' : '勾选对象里混入了群聊，请切换到「群聊群发」或重新勾选好友')
  const selectedSet = new Set(selectedInstanceIds.value)
  const outside = targets.filter((target) => !selectedSet.has(target.sourceInstanceId))
  if (outside.length) return ElMessage.warning('有接收对象不属于已勾选的发送微信号，请刷新后重选')
  const onlineIds = new Set(instances.value.filter((item) => item.status === 'ONLINE').map((item) => item.id))
  if (![...selectedSet].some((id) => onlineIds.has(id))) return ElMessage.warning('已勾选的发送微信号当前都不在线')
  const offlineTargets = targets.filter((target) => !onlineIds.has(target.sourceInstanceId))
  if (offlineTargets.length) return ElMessage.warning(`${offlineTargets.length} 个接收对象所属的微信当前不在线，请刷新后重试`)
  try {
    await ElMessageBox.confirm(
      `确认创建 ${targets.length} 个目标的群发任务？\n\n${formatAccountSummary(targets)}\n\n创建后仍需在任务中心确认执行。`,
      '确认群发任务',
      { type: 'warning' },
    )
  } catch { return }
  const type = hasText && hasImage
    ? (isGroup ? 'SEND_MIXED_TO_GROUP' : 'SEND_MIXED_TO_FRIEND')
    : hasText
      ? (isGroup ? 'SEND_TEXT_TO_GROUP' : 'SEND_TEXT_TO_FRIEND')
      : (isGroup ? 'SEND_IMAGE_TO_GROUP' : 'SEND_IMAGE_TO_FRIEND')
  creating.value = true
  try {
    // 每行对象由其所属微信发送；混发则同号拆成文字+图片两条；全部写成纯 JSON，避免 IPC 克隆失败
    const text = messageText.value.trim()
    const image = String(imagePath.value || '')
    const selectedIds = selectedInstanceIds.value.map(String)
    const items = targets.flatMap((target) => [
      ...(hasText ? [{ instanceId: String(target.sourceInstanceId), targetKey: String(target.wxid), actionType: 'SEND_TEXT', request: { wxid: String(target.wxid), msg: text, nickname: String(target.nickname || '') } }] : []),
      ...(hasImage ? [{ instanceId: String(target.sourceInstanceId), targetKey: String(target.wxid), actionType: 'SEND_IMAGE', request: { wxid: String(target.wxid), filepath: image, nickname: String(target.nickname || '') } }] : []),
    ])
    const created = await window.wxControl?.createTask({
      name: `${activeTab.value} ${new Date().toLocaleString()}`,
      type,
      config: {
        autoRetry: Boolean(autoRetry.value),
        retryTimes: Number(retryTimes.value) || 1,
        retryMinutes: Number(retryMinutes.value) || 1,
        skipSame: Boolean(skipSame.value),
        scheduledAt: sendMode.value === 'schedule' ? scheduledAt.value?.toISOString() || null : null,
        selectedInstanceIds: selectedIds,
      },
      items,
    }) as Record<string, unknown> | undefined
    lastCreatedTaskId.value = String(created?.id || '')
    await refresh()
    await promptGoToTaskCenter(router, `已创建 ${targets.length} 个目标的群发任务`)
  } catch (error) {
    void window.wxControl?.reportError?.('创建群发任务失败', {
      reason: String(error instanceof Error ? error.message : error || '').slice(0, 500),
      targetCount: targets.length,
      type,
    })
    ElMessage.error(userErrorMessage(error, '创建群发任务失败'))
  } finally {
    creating.value = false
  }
}

async function selectImage() { imagePath.value = await window.wxControl?.selectImage() ?? ''; imagePreview.value = '' }
function clearImage() { imagePath.value = ''; imagePreview.value = '' }
async function pasteImage() {
  if (pastingImage.value) return
  pastingImage.value = true
  try {
    const result = await window.wxControl?.pasteImage()
    if (!result?.ok || !result.path) return ElMessage.warning(result?.error || '剪贴板里没有可粘贴的图片')
    imagePath.value = result.path
    imagePreview.value = result.dataUrl || ''
    ElMessage.success('图片已粘贴')
  } finally { pastingImage.value = false }
}
function onPaste(event: ClipboardEvent) {
  const hasImage = [...(event.clipboardData?.items ?? [])].some((item) => item.type.startsWith('image/'))
  if (!hasImage) return
  event.preventDefault()
  void pasteImage()
}

onMounted(() => { void refresh(); document.addEventListener('paste', onPaste) })
onBeforeUnmount(() => document.removeEventListener('paste', onPaste))
</script>

<template>
  <div class="app-page">
    <PageHeader title="消息群发" subtitle="先勾选发送微信号，再勾选该号下的好友/群；创建后需到任务中心确认才会真正发送。" />

    <div class="chip-row">
      <button
        v-for="tab in broadcastTabs"
        :key="tab"
        class="chip"
        :class="{ 'is-active': activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ tab }}
      </button>
    </div>

    <div class="main-split">
      <section class="app-card block left-panel">
        <h3 class="section-title">接收对象选择区</h3>
        <div class="form-block">
          <div class="field-label-row">
            <label>发送微信号</label>
            <span class="field-select-actions">
              <el-button link type="primary" :disabled="!instanceOptions.length" @click.stop="selectAllInstances">全选</el-button>
              <el-button link type="info" :disabled="!selectedInstanceIds.length" @click.stop="clearSelectedInstances">全不选</el-button>
            </span>
          </div>
          <el-select
            v-model="selectedInstanceIds"
            multiple
            filterable
            collapse-tags
            collapse-tags-tooltip
            placeholder="先勾选要用哪个微信发；不选则不展示对象"
            style="width: 100%"
            :filter-method="instanceSearch.setQuery"
            @visible-change="(open: boolean) => { if (!open) instanceSearch.clearQuery() }"
          >
            <el-option v-for="o in visibleInstanceOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <p class="muted" style="margin-top: 6px">同一好友/群若在多个微信里，会显示多行；勾哪行就用哪个号发。</p>
        </div>

        <div class="mini-stats">
          <StatCard
            v-for="item in broadcastStats"
            :key="item.title"
            :title="item.title"
            :value="item.value"
            icon="User"
            tone="info"
          />
        </div>

        <div class="toolbar-row" style="margin: 12px 0">
          <el-input
            v-model="keyword"
            style="width: 260px"
            placeholder="搜索昵称、微信号或发送微信"
            :prefix-icon="Search"
            clearable
          />
          <el-button @click="refresh">刷新</el-button>
          <el-button :disabled="!broadcastFriends.length" @click="selectAllFilteredTargets(true)">全选当前列表</el-button>
          <el-button :disabled="!selectedTargets.length" @click="selectAllFilteredTargets(false)">清空勾选</el-button>
        </div>

        <div class="exclude-grid" :class="{ 'is-friend': activeTab === '好友群发' }">
          <div>
            <label>排除微信号</label>
            <el-input v-model="excludeWxid" type="textarea" :rows="3" placeholder="每行一个，精确匹配" />
          </div>
          <div>
            <label>排除昵称</label>
            <el-input v-model="excludeNick" type="textarea" :rows="3" placeholder="每行一个，精确匹配" />
          </div>
          <div v-if="activeTab === '好友群发'">
            <label>排除备注（包含即排除）</label>
            <el-input v-model="excludeRemark" type="textarea" :rows="3" placeholder="备注包含指定内容则不发，每行一条" />
          </div>
        </div>

        <div class="table-wrap" style="margin-top: 12px">
          <el-empty v-if="!selectedInstanceIds.length" description="请先勾选发送微信号" :image-size="72" />
          <VirtualTargetTable
            v-else
            :rows="broadcastFriends"
            :columns="targetColumns"
            :selected-keys="selectedKeyList"
            :height="360"
            :row-height="40"
            empty-text="当前过滤条件下没有可发送对象"
            @select-all="selectAllFilteredTargets"
            @toggle-row="toggleTargetRow"
          >
            <template #cell-status="{ value }">
              <StatusTag :text="value || '可用'" />
            </template>
          </VirtualTargetTable>
        </div>
      </section>

      <section class="app-card block right-panel panel-scroll">
        <h3 class="section-title">消息内容区</h3>

        <div class="form-block">
          <label>文字内容（选填）</label>
          <el-input v-model="messageText" type="textarea" :rows="5" />
          <div class="toolbar-row" style="margin-top: 8px">
            <div class="toolbar-left">
              <el-button size="small" @click="messageText += '🙂'">插入表情</el-button>
              <el-button size="small" @click="messageText = ''">清空</el-button>
            </div>
            <span class="muted">字数 {{ messageText.length }}</span>
          </div>
        </div>

        <div class="form-block">
          <label>图片（选填，可与文字一起发送）</label>
          <div class="upload-box" tabindex="0">
            <img v-if="imagePreview" class="image-preview" :src="imagePreview" alt="已粘贴图片" />
            <div v-else class="preview">{{ broadcastContent.imageName }}</div>
            <el-button :icon="Plus" @click="selectImage">选择图片</el-button>
            <el-button :loading="pastingImage" @click="pasteImage">粘贴图片</el-button>
            <el-button :disabled="!imagePath" @click="clearImage">清空图片</el-button>
          </div>
        </div>

        <div class="form-block">
          <label>发送模式</label>
          <el-radio-group v-model="sendMode">
            <el-radio value="now">确认后立即执行</el-radio>
            <el-radio value="schedule">定时执行</el-radio>
          </el-radio-group>
          <p class="muted" style="margin-top: 6px">创建任务后仍需在任务中心点「确认执行」。</p>
          <el-date-picker v-if="sendMode === 'schedule'" v-model="scheduledAt" type="datetime" placeholder="选择发送日期和时间" style="width: 100%; margin-top: 8px" />
        </div>

        <div class="form-block">
          <label>间隔设置</label>
          <div class="muted">使用系统设置中的全局随机间隔</div>
        </div>

        <div class="form-block">
          <label>高级选项</label>
          <div class="checks">
            <el-checkbox v-model="skipSame">跳过已接收过相同内容的对象</el-checkbox>
            <div class="retry-row">
              <el-checkbox v-model="autoRetry">发送失败自动重试</el-checkbox>
              <el-input-number v-model="retryTimes" :min="1" controls-position="right" />
              <span class="muted">次 /</span>
              <el-input-number v-model="retryMinutes" :min="1" controls-position="right" />
              <span class="muted">分钟</span>
            </div>
          </div>
        </div>

        <div class="toolbar-left">
          <el-button @click="preview">预览</el-button>
          <el-button type="primary" :loading="creating" @click="createBroadcast">创建任务</el-button>
          <el-button :disabled="!canPauseCurrent" @click="pauseCurrentBroadcast">暂停</el-button>
          <el-button type="primary" plain :disabled="!canResumeCurrent" @click="resumeCurrentBroadcast">继续</el-button>
        </div>
      </section>
    </div>

    <div class="bottom-split">
      <section class="app-card block">
        <h3 class="section-title">发送进度</h3>
        <el-progress :percentage="broadcastProgress.percent" :stroke-width="12" />
        <div class="progress-meta">
          <span>已发送 {{ broadcastProgress.sent }}</span>
          <span>发送失败 {{ broadcastProgress.failed }}</span>
          <span>已跳过 {{ broadcastProgress.skipped }}</span>
          <span>待发送 {{ broadcastProgress.pending }}</span>
          <span>预计剩余时间 {{ broadcastProgress.eta }}</span>
        </div>
      </section>

      <section class="app-card block warn-panel">
        <h3 class="section-title">频率预警</h3>
        <div class="warn-list">
          <div v-for="item in broadcastWarnings" :key="item.id" class="warn-item">
            <div class="ellip"><b>{{ item.account }}</b></div>
            <div class="muted ellip">{{ item.desc }}</div>
            <div class="muted">{{ item.time }}</div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.block {
  padding: 14px 16px;
  min-width: 0;
  overflow: hidden;
}

.main-split {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: var(--app-gap);
  min-width: 0;
}

.mini-stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  min-width: 0;
}

@media (max-width: 1500px) {
  .main-split,
  .bottom-split {
    grid-template-columns: minmax(0, 1fr);
  }
}

.exclude-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.exclude-grid.is-friend {
  grid-template-columns: 1fr 1fr 1fr;
}

@media (max-width: 1200px) {
  .exclude-grid.is-friend {
    grid-template-columns: 1fr;
  }
}

.exclude-grid label,
.form-block label {
  display: block;
  margin-bottom: 6px;
  color: var(--app-text-secondary);
  font-size: 12px;
}

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.field-label-row label {
  margin-bottom: 0;
}

.field-select-actions {
  display: inline-flex;
  gap: 4px;
}

.form-block {
  margin-bottom: 14px;
}

.upload-box {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.image-preview {
  width: 100%;
  height: 112px;
  object-fit: contain;
  background: #f6f8f9;
  border: 1px solid var(--app-border);
  border-radius: 6px;
}

.preview {
  width: 140px;
  height: 90px;
  border: 1px dashed var(--app-border);
  border-radius: 8px;
  display: grid;
  place-items: center;
  background: #f7f8fa;
  color: var(--app-text-secondary);
  font-size: 12px;
  padding: 8px;
  text-align: center;
  word-break: break-all;
}

.retry-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bottom-split {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(260px, 320px);
  gap: var(--app-gap);
  min-width: 0;
}

.progress-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 12px;
  color: var(--app-text-secondary);
  font-size: 13px;
}

.warn-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 140px;
  overflow: auto;
}

.warn-item {
  padding: 10px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: #fffaf3;
}
</style>
