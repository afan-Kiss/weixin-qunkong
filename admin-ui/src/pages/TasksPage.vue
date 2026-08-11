<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import StatCard from '../components/cards/StatCard.vue'
import DetailPanel from '../components/panels/DetailPanel.vue'
import { statusLabel, taskTypeLabel } from '../utils/status'
import type { WechatInstance } from '../services/wechat'
interface TaskView {
  id: string; name: string; type: string; typeCode: string; status: string; statusCode: string; total: number; success: number; failed: number; skipped: number; progress: number; accounts: string; targets: string; interval: string; createdAt: string; remark: string
}

const activeType = ref('全部')
const rawTasks = ref<Array<Record<string, unknown>>>([])
const taskTypeChips = ['全部', '群成员', '二维码', '好友群发', '群聊群发', '被踢群']
const selectedId = ref('')
const detailRef = ref<HTMLElement | null>(null)
const taskItems = ref<Array<Record<string, unknown>>>([])
const taskInstances = ref<WechatInstance[]>([])
function normalizeTask(row: Record<string, unknown>): TaskView {
  const total = Number(row.total || 0)
  const success = Number(row.success || 0)
  const failed = Number(row.failed || 0)
  const skipped = Number(row.skipped || 0)
  const done = success + failed + skipped
  const config = row.config && typeof row.config === 'object' ? row.config as Record<string, unknown> : {}
  const intervalMs = Number(config.intervalMs)
  return {
    id: String(row.id), name: String(row.name), type: taskTypeLabel(row.type), typeCode: String(row.type), status: statusLabel(row.status), statusCode: String(row.status), total, success, failed, skipped,
    progress: total ? Math.round(done / total * 100) : 0, accounts: String(row.accountSummary || '微信资料读取中'), targets: `${total} 项`,
    interval: Number.isFinite(intervalMs) && intervalMs >= 0 ? `${Math.floor(intervalMs)} ms` : '-', createdAt: row.created_at ? new Date(String(row.created_at)).toLocaleString() : '-', remark: '',
  }
}
function typeMatches(row: TaskView) {
  if (activeType.value === '全部') return true
  if (activeType.value === '二维码') return row.typeCode === 'QR_SCAN'
  if (activeType.value === '好友群发') return row.typeCode.includes('TO_FRIEND')
  if (activeType.value === '群聊群发') return row.typeCode.includes('TO_GROUP')
  if (activeType.value === '被踢群') return row.typeCode === 'KICKED_GROUP_CLEANUP'
  return row.typeCode.includes('MEMBER') || row.typeCode === 'ADD_FRIEND'
}
const tasks = computed<TaskView[]>(() => rawTasks.value.map(normalizeTask).filter(typeMatches))
const current = computed(() => tasks.value.find((t) => t.id === selectedId.value) || tasks.value[0])
const taskStatusCards = computed(() => [{ title: '待确认', value: String(rawTasks.value.filter((t) => t.status === 'WAITING_CONFIRMATION').length), tone: 'warning' as const }, { title: '执行中', value: String(rawTasks.value.filter((t) => t.status === 'RUNNING').length), tone: 'info' as const }, { title: '已暂停', value: String(rawTasks.value.filter((t) => ['PAUSED', 'COOLING_DOWN'].includes(String(t.status))).length), tone: 'warning' as const }, { title: '已完成', value: String(rawTasks.value.filter((t) => t.status === 'COMPLETED').length), tone: 'success' as const }, { title: '失败/受阻', value: String(rawTasks.value.filter((t) => ['FAILED', 'PARTIAL_FAILED', 'BLOCKED_API_UNVERIFIED'].includes(String(t.status))).length), tone: 'danger' as const }])
const taskAccounts = computed(() => {
  const ids = [...new Set(taskItems.value.map((item) => String(item.instance_id || '')).filter(Boolean))]
  return ids.map((id) => {
    const instance = taskInstances.value.find((item) => item.id === id)
    const wechatId = instance?.alias || instance?.accountWxid || ''
    return { id, nickname: instance?.nickname || '微信昵称读取中', wxid: wechatId || '微信号读取中' }
  })
})

/** 任务明细目标列：优先群名/微信名，不展示 roomId / wxid / 哈希 /「二维码目标」 */
function taskItemTargetLabel(row: Record<string, unknown>) {
  const isJunkLabel = (value: string) => !value
    || value === '二维码目标'
    || value === '群聊'
    || /未知群名/.test(value)
    || /^二维码/.test(value)
    || /@chatroom$/i.test(value)
    || /^wxid_/i.test(value)
  const label = String(row.targetLabel || row.target_label || '').trim()
  if (label && !isJunkLabel(label)) {
    return label.replace(/[（(]\s*\d+\s*人\s*[）)]\s*$/, '').replace(/[（(]\s*人数未知\s*[）)].*$/, '').trim() || label
  }
  const request = parseItemRequest(row)
  let response: Record<string, unknown> = {}
  try {
    response = typeof row.response_json === 'string' ? JSON.parse(row.response_json) as Record<string, unknown> : (row.response_json as Record<string, unknown>) || {}
  } catch { /* ignore */ }
  const preview = (response.preview && typeof response.preview === 'object')
    ? response.preview as Record<string, unknown>
    : {}
  const roomName = String(request.roomName || response.roomName || preview.roomName || '').trim()
  if (roomName && !isJunkLabel(roomName)) return roomName
  const fromLabel = String(request.label || response.label || preview.label || '').trim()
  if (fromLabel && !isJunkLabel(fromLabel)) {
    return fromLabel.replace(/[（(]\s*\d+\s*人\s*[）)]\s*$/, '').replace(/[（(]\s*人数未知\s*[）)].*$/, '').trim() || fromLabel
  }
  const nick = String(request.nickname || '').trim()
  if (nick && !/^wxid_/i.test(nick)) return nick
  const err = String(row.error || '').trim()
  const joined = err.match(/已进群[：:]\s*([^（(\n]+)/)
  if (joined?.[1] && !/未知群名|二维码/.test(joined[1])) return joined[1].trim()
  const key = String(row.target_key || '').trim()
  const bareKey = key.includes('::') ? key.slice(key.indexOf('::') + 2) : key
  if (bareKey.endsWith('@chatroom') || key.endsWith('@chatroom')) return '未命名群聊'
  if (String(row.action_type || '') === 'QR_SCAN') return '群邀请（未解析到群名）'
  if (/^wxid_/i.test(bareKey) || /^[0-9A-Fa-f]{32,}$/.test(bareKey)) return '微信好友'
  return bareKey || key || '-'
}

function parseItemRequest(row: Record<string, unknown>) {
  try {
    return typeof row.request_json === 'string'
      ? JSON.parse(row.request_json) as Record<string, unknown>
      : (row.request_json as Record<string, unknown>) || {}
  } catch {
    return {}
  }
}

function taskItemExecutorLabel(row: Record<string, unknown>) {
  const id = String(row.instance_id || '')
  const instance = taskInstances.value.find((item) => item.id === id)
  return instance?.nickname || instance?.alias || instance?.accountWxid || (id ? id.slice(0, 8) : '-')
}

function taskItemSourceLabel(row: Record<string, unknown>) {
  const request = parseItemRequest(row)
  const source = String(request.sourceLabel || request.source || '').trim()
  if (!source) return '-'
  return source.split('·')[0]?.trim() || source
}

/**
 * 双击任务明细：在资源管理器中定位该条对应的二维码图片。
 * @param row 明细行
 */
async function revealTaskItemQrImage(row: Record<string, unknown>) {
  const request = parseItemRequest(row)
  let target = String(request.path || request.localPath || '').trim()
  if (!target) {
    const key = String(request.qrSha || request.qrItemId || '').trim()
      || (() => {
        const raw = String(row.target_key || '').trim()
        return raw.includes('::') ? raw.slice(raw.indexOf('::') + 2) : raw
      })()
    if (key) {
      try {
        const items = (await window.wxControl?.listQrItems?.() ?? []) as Array<Record<string, unknown>>
        const hit = items.find((item) => String(item.sha256 || '') === key || String(item.id || '') === key)
        target = String(hit?.localPath || hit?.path || '').trim()
      } catch { /* ignore */ }
    }
  }
  if (!target || target === '-') {
    ElMessage.info('该明细没有关联的本地二维码图片（纯链接导入项可能无图片文件）')
    return
  }
  try {
    const result = await window.wxControl?.revealInFolder?.(target)
    if (!result?.ok) ElMessage.warning(result?.message || '无法在资源管理器中定位该图片')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '定位图片失败')
  }
}
let timer: ReturnType<typeof setInterval> | undefined
let refreshing = false
async function refresh() {
  if (refreshing) return
  refreshing = true
  try {
    const [taskRows, instanceRows] = await Promise.all([window.wxControl?.listTasks() ?? [], window.wxControl?.listInstances() ?? []])
    rawTasks.value = taskRows as Array<Record<string, unknown>>
    taskInstances.value = instanceRows
    selectedId.value ||= tasks.value[0]?.id ?? ''
    taskItems.value = selectedId.value ? (await window.wxControl?.taskItems(selectedId.value) ?? []) as Array<Record<string, unknown>> : []
  } finally { refreshing = false }
}
async function viewTask(id: string) {
  selectedId.value = id
  taskItems.value = (await window.wxControl?.taskItems(id) ?? []) as Array<Record<string, unknown>>
  await nextTick()
  detailRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
/**
 * 按任务类型生成确认文案，避免加好友/进群被说成「发送」。
 * @param typeCode 任务类型
 */
function confirmCopy(typeCode: string) {
  if (typeCode === 'ADD_FRIEND') return '确认后将按间隔逐个提交加好友申请。'
  if (typeCode === 'QR_SCAN') return '确认后将按间隔识别二维码并提交进群申请（个人码按任务配置跳过）。'
  if (typeCode === 'KICKED_GROUP_CLEANUP') return '确认后将按间隔逐个清理被踢群：取消通讯录、退出并清除会话，并永久屏蔽。任务明细与日志会显示每个群的成功或失败。'
  if (typeCode.includes('TO_GROUP') || typeCode.includes('TO_FRIEND')) return '确认后将向任务中的好友或群聊逐条发送消息。'
  return '确认后将开始执行该任务。'
}

async function confirmTask(id: string) {
  const row = rawTasks.value.find((item) => String(item.id) === id)
  const typeCode = String(row?.type || '')
  const config = row?.config && typeof row.config === 'object' ? row.config as Record<string, unknown> : {}
  const previousMs = Number(config.intervalMs)
  const defaultMs = Number.isFinite(previousMs) && previousMs >= 0 ? String(Math.floor(previousMs)) : '1000'
  try {
    await ElMessageBox.confirm(confirmCopy(typeCode), '确认执行', { type: 'warning' })
    const { value } = await ElMessageBox.prompt('请填写本任务的执行间隔（毫秒）。两项之间等待该时长，填 0 表示不等待。', '设置执行间隔', {
      inputValue: defaultMs,
      inputPlaceholder: '例如 1000',
      confirmButtonText: '开始执行',
      cancelButtonText: '取消',
      inputPattern: /^\d+$/,
      inputErrorMessage: '请输入非负整数（单位：毫秒）',
    })
    const intervalMs = Number(value)
    if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error('执行间隔无效')
    await window.wxControl?.confirmTask({ id, intervalMs })
    ElMessage.success(`任务已开始排队执行（间隔 ${intervalMs} ms）`)
    await refresh()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '确认执行失败')
  }
}
async function pauseTask(id: string) {
  try {
    await window.wxControl?.pauseTask(id)
    ElMessage.success('任务已暂停')
    await refresh()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '暂停失败')
  }
}
async function resumeTask(id: string) {
  try {
    await window.wxControl?.resumeTask(id)
    ElMessage.success('任务已继续执行')
    await refresh()
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '继续任务失败')
  }
}
async function cancelTask(id: string) {
  try {
    await ElMessageBox.confirm('取消后不会自动恢复；未开始的加好友目标可重新创建。', '取消任务', { type: 'warning' })
    await window.wxControl?.cancelTask(id)
    await refresh()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '取消失败')
  }
}
onMounted(() => { refresh(); timer = setInterval(refresh, 3000) }); onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="app-page">
    <PageHeader title="任务中心" subtitle="所有加好友、进群、群发、清理被踢群任务都在这里确认后才会执行；待确认请优先处理。" />

    <div class="stats-grid-5">
      <StatCard
        v-for="item in taskStatusCards"
        :key="item.title"
        :title="item.title"
        :value="item.value"
        icon="List"
        :tone="item.tone"
      />
    </div>

    <div class="toolbar-row">
      <div class="chip-row">
        <button
          v-for="item in taskTypeChips"
          :key="item"
          class="chip"
          :class="{ 'is-active': activeType === item }"
          @click="activeType = item"
        >
          {{ item }}
        </button>
      </div>
      <div class="toolbar-right">
        <el-button @click="refresh">刷新</el-button>
      </div>
    </div>

    <div class="split-2-wide page-split">
      <section class="app-card block">
        <div class="table-wrap">
          <el-table
            :data="tasks"
            stripe
            height="460"
            highlight-current-row
            style="width: 100%"
            @row-click="(row: TaskView) => viewTask(row.id)"
          >
            <el-table-column prop="name" label="任务名称" min-width="210" show-overflow-tooltip />
            <el-table-column prop="type" label="任务类型" width="120" show-overflow-tooltip />
            <el-table-column prop="accounts" label="操作账号" min-width="230" show-overflow-tooltip />
            <el-table-column prop="targets" label="目标" width="80" />
            <el-table-column prop="interval" label="间隔" width="100" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }"><StatusTag :text="row.status" /></template>
            </el-table-column>
            <el-table-column label="操作" width="160" fixed="right">
              <template #default="{ row }">
                <el-button v-if="row.statusCode === 'WAITING_CONFIRMATION'" link type="primary" @click.stop="confirmTask(row.id)">确认执行</el-button>
                <el-button v-if="['RUNNING','QUEUED'].includes(row.statusCode)" link @click.stop="pauseTask(row.id)">暂停</el-button>
                <el-button v-if="['PAUSED','COOLING_DOWN'].includes(row.statusCode)" link type="primary" @click.stop="resumeTask(row.id)">继续</el-button>
                <el-button link @click.stop="viewTask(row.id)">查看</el-button>
                <el-button v-if="!['COMPLETED','CANCELLED'].includes(row.statusCode)" link type="danger" @click.stop="cancelTask(row.id)">取消</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <div v-if="current" ref="detailRef">
      <DetailPanel title="任务详情">
        <div class="detail-actions">
          <el-button
            v-if="current.statusCode === 'WAITING_CONFIRMATION'"
            type="primary"
            @click="confirmTask(current.id)"
          >确认并开始</el-button>
          <el-button
            v-if="['RUNNING', 'QUEUED'].includes(current.statusCode)"
            @click="pauseTask(current.id)"
          >暂停任务</el-button>
          <el-button
            v-if="['PAUSED', 'COOLING_DOWN'].includes(current.statusCode)"
            type="primary"
            @click="resumeTask(current.id)"
          >继续任务</el-button>
          <el-button
            v-if="!['COMPLETED', 'CANCELLED'].includes(current.statusCode)"
            type="danger"
            plain
            @click="cancelTask(current.id)"
          >取消任务</el-button>
        </div>
        <div class="field-grid">
          <div class="field-item"><div class="label">任务名称</div><div class="value">{{ current.name }}</div></div>
          <div class="field-item"><div class="label">任务状态</div><div class="value"><StatusTag :text="current.status" /></div></div>
          <div class="field-item"><div class="label">任务进度</div><div class="value">{{ current.progress }}%（{{ current.success + current.failed + current.skipped }}/{{ current.total }}）</div></div>
          <div class="field-item"><div class="label">成功</div><div class="value result-success">{{ current.success }}</div></div>
          <div class="field-item"><div class="label">失败</div><div class="value result-failed">{{ current.failed }}</div></div>
        </div>
        <h4 class="account-title">执行任务的微信</h4>
        <div v-if="taskAccounts.length" class="task-accounts">
          <div v-for="account in taskAccounts" :key="account.id" class="task-account">
            <el-avatar :size="36">{{ account.nickname.slice(0, 1) }}</el-avatar>
            <div><div class="account-name">{{ account.nickname }}</div><div class="muted">微信号：{{ account.wxid }}</div></div>
          </div>
        </div>
        <div v-else class="muted account-empty">暂未找到执行任务的微信</div>
        <h4 class="account-title">任务明细</h4>
        <div class="table-wrap">
          <el-table
            :data="taskItems"
            stripe
            height="220"
            size="small"
            empty-text="暂无明细"
            row-class-name="task-item-row"
            @row-dblclick="(row: Record<string, unknown>) => revealTaskItemQrImage(row)"
          >
            <el-table-column label="执行微信" width="120" show-overflow-tooltip>
              <template #default="{ row }">{{ taskItemExecutorLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="目标" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ taskItemTargetLabel(row) }}</template>
            </el-table-column>
            <el-table-column label="来源微信" width="120" show-overflow-tooltip>
              <template #default="{ row }">
                <span class="source-muted">{{ taskItemSourceLabel(row) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="状态" width="120">
              <template #default="{ row }"><StatusTag :text="statusLabel(row.status)" /></template>
            </el-table-column>
            <el-table-column prop="error" label="说明（含微信拒绝理由）" min-width="220" show-overflow-tooltip />
          </el-table>
        </div>
      </DetailPanel>
      </div>
    </div>
  </div>
</template>

<style scoped>
.block {
  padding: 14px 16px;
  min-width: 0;
  overflow: hidden;
}

.page-split {
  min-height: 420px;
}

.detail-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.source-muted {
  color: #64748b;
  font-size: 12px;
}

.account-title {
  margin: 14px 0 8px;
  font-size: 13px;
}
.task-accounts { display: grid; gap: 8px; }
.task-account {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px;
  background: #f7f8fa;
  border-radius: 6px;
}
.account-name { font-weight: 600; margin-bottom: 3px; }
.account-empty { padding: 12px 0; }
.result-success { color: #16a34a; font-weight: 700; }
.result-failed { color: #dc2626; font-weight: 700; }
:deep(.task-item-row) { cursor: pointer; }
</style>
