<script setup lang="ts">
import { ArrowRight } from '@element-plus/icons-vue'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import StatCard from '../components/cards/StatCard.vue'
import SimpleTrendChart from '../components/charts/SimpleTrendChart.vue'
import { groups, instances, members, refreshDirectory, refreshInstances } from '../stores/wechatData'
import { statusLabel } from '../utils/status'
const router = useRouter()
const rawTasks = ref<Array<Record<string, unknown>>>([])
const rawLogs = ref<Array<Record<string, unknown>>>([])
const dashboardInstances = computed(() => instances.value.map((item) => ({ ...item, nickname: item.nickname || (item.status === 'ONLINE' ? '正在读取昵称' : '待登录微信'), port: item.tcpPort, loginStatus: statusLabel(item.status), queueStatus: rawTasks.value.some((task) => task.status === 'RUNNING') ? '有任务执行' : '空闲' })))
const dashboardPendingTasks = computed(() => rawTasks.value.filter((item) => ['WAITING_CONFIRMATION', 'QUEUED', 'RUNNING', 'PAUSED', 'COOLING_DOWN', 'BLOCKED_API_UNVERIFIED'].includes(String(item.status))).map((item) => { const total = Number(item.total || 0); const done = Number(item.success || 0) + Number(item.failed || 0) + Number(item.skipped || 0); const config = item.config && typeof item.config === 'object' ? item.config as Record<string, unknown> : {}; const intervalMs = Number(config.intervalMs); return { ...item, targets: total, progress: total ? Math.round(done / total * 100) : 0, interval: Number.isFinite(intervalMs) && intervalMs >= 0 ? `${Math.floor(intervalMs)} ms` : '-', nextRun: '-' } }))
const dashboardRisks = computed(() => rawTasks.value.filter((item) => item.status === 'COOLING_DOWN').map((item) => ({ id: String(item.id), title: '频繁暂停', level: '高', desc: String(item.name), time: String(item.updated_at || '') })))
const dashboardLogs = computed(() => rawLogs.value.slice(0, 8).map((item, index) => ({ id: index, time: String(item.time || ''), level: statusLabel(item.level || 'INFO'), content: String(item.message || '') })))
const dashboardStats = computed(() => [{ key: 'online', title: '在线微信', value: String(instances.value.filter((item) => item.status === 'ONLINE').length), sub: `微信总数 ${instances.value.length}`, icon: 'Monitor', tone: 'primary' as const }, { key: 'groups', title: '群聊总数', value: String(groups.value.length), sub: `当前采集成员 ${members.value.length} 人`, icon: 'UserFilled', tone: 'info' as const }, { key: 'tasks', title: '待处理任务', value: String(dashboardPendingTasks.value.length), sub: '等待确认、排队或暂停', icon: 'List', tone: 'warning' as const }, { key: 'risk', title: '频繁预警', value: String(dashboardRisks.value.length), sub: '仅统计有明确证据的任务', icon: 'Warning', tone: 'danger' as const }])
const dashboardTrendPoints = computed(() => { const today = new Date().toDateString(); const hours = Array(24).fill(0) as number[]; for (const item of rawLogs.value) { const date = new Date(String(item.time)); if (!Number.isNaN(date.getTime()) && date.toDateString() === today) hours[date.getHours()]++ } return hours.some(Boolean) ? hours : [] })
const dashboardSideStats = computed(() => [{ title: '今日日志数', value: String(rawLogs.value.filter((item) => new Date(String(item.time)).toDateString() === new Date().toDateString()).length) }, { title: '已完成任务', value: String(rawTasks.value.filter((item) => item.status === 'COMPLETED').length) }])
async function load() { await refreshInstances(); if (instances.value.length) await refreshDirectory(); rawTasks.value = (await window.wxControl?.listTasks() ?? []) as Array<Record<string, unknown>>; rawLogs.value = (await window.wxControl?.listLogs(5000) ?? []) as Array<Record<string, unknown>> }
onMounted(load)
</script>

<template>
  <div class="app-page">
    <PageHeader title="总览" subtitle="查看微信运行状态、群聊规模、待执行任务与风险提醒。" />

    <div class="stats-grid-4">
      <StatCard
        v-for="item in dashboardStats"
        :key="item.key"
        :title="item.title"
        :value="item.value"
        :sub="item.sub"
        :icon="item.icon"
        :tone="item.tone"
      />
    </div>

    <div class="row-2">
      <section class="app-card block">
        <h3 class="section-title">微信运行状态</h3>
        <div class="table-wrap">
          <el-table :data="dashboardInstances" stripe height="260" style="width: 100%">
            <el-table-column prop="nickname" label="账号昵称" min-width="140" show-overflow-tooltip />
            <el-table-column label="微信号" min-width="180" show-overflow-tooltip>
              <template #default="{ row }">{{ row.alias || row.accountWxid || '-' }}</template>
            </el-table-column>
            <el-table-column label="登录状态" width="100">
              <template #default="{ row }"><StatusTag :text="row.loginStatus" /></template>
            </el-table-column>
            <el-table-column prop="queueStatus" label="队列状态" min-width="120" show-overflow-tooltip />
            <el-table-column label="操作" width="140" fixed="right">
              <template #default>
                <el-button link type="primary" @click="router.push('/instances')">管理微信</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <section class="app-card block risk-card">
        <h3 class="section-title">风控提醒</h3>
        <div class="risk-list">
          <button v-for="item in dashboardRisks" :key="item.id" class="risk-item" @click="router.push('/tasks')">
            <div class="risk-item__main">
              <div class="risk-item__title">
                <span class="ellip">{{ item.title }}</span>
                <StatusTag :text="`风险${item.level}`" />
              </div>
              <div class="risk-item__desc ellip">{{ item.desc }}</div>
              <div class="risk-item__time muted">{{ item.time }}</div>
            </div>
            <el-icon><ArrowRight /></el-icon>
          </button>
        </div>
      </section>
    </div>

    <div class="row-2">
      <section class="app-card block">
        <h3 class="section-title">待处理任务</h3>
        <div class="table-wrap">
          <el-table :data="dashboardPendingTasks" stripe height="260" style="width: 100%">
            <el-table-column prop="type" label="任务类型" width="100" />
            <el-table-column prop="name" label="任务名称" min-width="180" show-overflow-tooltip />
            <el-table-column prop="targets" label="目标数" width="90" />
            <el-table-column label="进度" width="140">
              <template #default="{ row }">
                <el-progress :percentage="row.progress" :stroke-width="8" />
              </template>
            </el-table-column>
            <el-table-column prop="interval" label="间隔" width="110" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }"><StatusTag :text="row.status" /></template>
            </el-table-column>
            <el-table-column prop="nextRun" label="下次执行" min-width="150" show-overflow-tooltip />
          </el-table>
        </div>
      </section>

      <section class="app-card block">
        <h3 class="section-title">最近日志</h3>
        <div class="log-list">
          <div v-for="item in dashboardLogs" :key="item.id" class="log-item">
            <div class="log-item__meta">
              <span class="muted">{{ item.time }}</span>
              <StatusTag :text="item.level" />
            </div>
            <div class="log-item__content">{{ item.content }}</div>
          </div>
        </div>
      </section>
    </div>

    <div class="row-trend">
      <section class="app-card block">
        <h3 class="section-title">今日活跃趋势</h3>
        <SimpleTrendChart :points="dashboardTrendPoints" />
      </section>
      <div class="side-stats">
        <StatCard
          v-for="item in dashboardSideStats"
          :key="item.title"
          :title="item.title"
          :value="item.value"
          icon="DataLine"
          tone="primary"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.row-2 {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  gap: var(--app-gap);
  min-width: 0;
}

.row-trend {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(240px, 280px);
  gap: var(--app-gap);
  min-width: 0;
}

.block {
  padding: 16px;
  min-width: 0;
  overflow: hidden;
}

@media (max-width: 1500px) {
  .row-2,
  .row-trend {
    grid-template-columns: minmax(0, 1fr);
  }
}

.risk-list,
.log-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 260px;
  overflow: auto;
}

.risk-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  text-align: left;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--app-border);
  background: #fbfbfc;
  cursor: pointer;
}

.risk-item:hover {
  border-color: #d5d9e0;
  background: #fff;
}

.risk-item__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}

.risk-item__desc,
.risk-item__time {
  font-size: 12px;
}

.log-item {
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: #fbfbfc;
}

.log-item__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.log-item__content {
  font-size: 13px;
  word-break: break-all;
}

.side-stats {
  display: flex;
  flex-direction: column;
  gap: var(--app-gap);
}
</style>
