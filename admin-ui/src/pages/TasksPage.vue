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
const taskTypeChips = ['全部', '群成员', '二维码', '好友群发', '群聊群发']
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
  return {
    id: String(row.id), name: String(row.name), type: taskTypeLabel(row.type), typeCode: String(row.type), status: statusLabel(row.status), statusCode: String(row.status), total, success, failed, skipped,
    progress: total ? Math.round(done / total * 100) : 0, accounts: String(row.accountSummary || '微信资料读取中'), targets: `${total} 项`,
    interval: '全局设置', createdAt: row.created_at ? new Date(String(row.created_at)).toLocaleString() : '-', remark: '',
  }
}
function typeMatches(row: TaskView) {
  if (activeType.value === '全部') return true
  if (activeType.value === '二维码') return row.typeCode === 'QR_SCAN'
  if (activeType.value === '好友群发') return row.typeCode.includes('TO_FRIEND')
  if (activeType.value === '群聊群发') return row.typeCode.includes('TO_GROUP')
  return row.typeCode.includes('MEMBER') || row.typeCode === 'ADD_FRIEND'
}
const tasks = computed<TaskView[]>(() => rawTasks.value.map(normalizeTask).filter(typeMatches))
const current = computed(() => tasks.value.find((t) => t.id === selectedId.value) || tasks.value[0])
const taskStatusCards = computed(() => [{ title: '待确认', value: String(rawTasks.value.filter((t) => t.status === 'WAITING_CONFIRMATION').length), tone: 'warning' as const }, { title: '执行中', value: String(rawTasks.value.filter((t) => t.status === 'RUNNING').length), tone: 'info' as const }, { title: '已暂停', value: String(rawTasks.value.filter((t) => ['PAUSED', 'COOLING_DOWN'].includes(String(t.status))).length), tone: 'warning' as const }, { title: '已完成', value: String(rawTasks.value.filter((t) => t.status === 'COMPLETED').length), tone: 'success' as const }, { title: '失败/受阻', value: String(rawTasks.value.filter((t) => ['FAILED', 'PARTIAL_FAILED', 'BLOCKED_API_UNVERIFIED'].includes(String(t.status))).length), tone: 'danger' as const }])
const taskAccounts = computed(() => {
  const ids = [...new Set(taskItems.value.map((item) => String(item.instance_id || '')).filter(Boolean))]
  return ids.map((id) => {
    const instance = taskInstances.value.find((item) => item.id === id)
    return { id, nickname: instance?.nickname || '微信昵称读取中', wxid: instance?.accountWxid || '微信号读取中' }
  })
})
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
  if (typeCode.includes('TO_GROUP') || typeCode.includes('TO_FRIEND')) return '确认后将向任务中的好友或群聊逐条发送消息。'
  return '确认后将开始执行该任务。'
}

async function confirmTask(id: string) {
  const row = rawTasks.value.find((item) => String(item.id) === id)
  const typeCode = String(row?.type || '')
  try {
    await ElMessageBox.confirm(confirmCopy(typeCode), '确认执行', { type: 'warning' })
    await window.wxControl?.confirmTask(id)
    ElMessage.success('任务已开始排队执行')
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
    <PageHeader title="任务中心" subtitle="所有加好友、进群、群发任务都在这里确认后才会执行；待确认请优先处理。" />

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
                <el-button link @click.stop="viewTask(row.id)">查看</el-button>
                <el-button v-if="!['COMPLETED','CANCELLED'].includes(row.statusCode)" link type="danger" @click.stop="cancelTask(row.id)">取消</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <div v-if="current" ref="detailRef">
      <DetailPanel title="任务详情">
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
          <el-table :data="taskItems" stripe height="220" size="small" empty-text="暂无明细">
            <el-table-column prop="target_key" label="目标" min-width="140" show-overflow-tooltip />
            <el-table-column label="状态" width="100">
              <template #default="{ row }"><StatusTag :text="statusLabel(row.status)" /></template>
            </el-table-column>
            <el-table-column prop="error" label="说明" min-width="160" show-overflow-tooltip />
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
</style>
