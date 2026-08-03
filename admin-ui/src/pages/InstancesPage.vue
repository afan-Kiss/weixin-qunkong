<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import { Search } from '@element-plus/icons-vue'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import DetailPanel from '../components/panels/DetailPanel.vue'
import { listInstances, startInstance, stopInstance, type WechatInstance } from '../services/wechat'
import { groups, refreshDirectory } from '../stores/wechatData'
import { statusLabel } from '../utils/status'
import { userErrorMessage } from '../utils/error'

const instanceFilters = ['全部', '在线', '待登录', '启动中', '异常', '已停止']
const instances = ref<WechatInstance[]>([])
const router = useRouter()
const instanceRooms = computed(() => groups.value.map((item) => ({ name: item.name, roomId: item.roomId, saved: item.saved ? '已保存' : '未保存', members: item.members, lastMsgTime: '-', source: item.sourceInstanceId })))
const selectedRows = ref<WechatInstance[]>([])
const busy = ref(false)

const activeFilter = ref('全部')
const selectedId = ref('')
const keyword = ref('')

function instanceDisplayName(item: WechatInstance) {
  if (item.nickname) return item.nickname
  if (item.status === 'ONLINE') return '正在读取昵称'
  if (item.status === 'STOPPED') return '已停止微信'
  return '待登录微信'
}

const filteredInstances = computed(() => instances.value.filter((item) => (activeFilter.value === '全部' || statusLabel(item.status) === activeFilter.value) && (!keyword.value || `${item.nickname ?? ''} ${item.accountWxid ?? ''} ${item.id}`.toLowerCase().includes(keyword.value.toLowerCase()))))
const current = computed(() => instances.value.find((i) => i.id === selectedId.value) || instances.value[0])
let timer: ReturnType<typeof setInterval> | undefined
let polling = false

function onRowClick(row: WechatInstance) {
  selectedId.value = row.id
}

async function refresh() { instances.value = await listInstances(); selectedId.value ||= instances.value[0]?.id ?? '' }
async function refreshDirectoryQuietly(instanceIds: string[]) { try { await refreshDirectory(instanceIds) } catch { /* The store already records the concrete failure. */ } }
async function addInstance() {
  busy.value = true
  try {
    const result = await startInstance()
    if (!result.ok || !result.data) return ElMessage.error(userErrorMessage(result.error, '打开微信失败'))
    ElMessage.success('微信已启动，请在微信窗口完成登录')
    await refresh()
    selectedId.value = result.data.id
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '打开微信失败'))
  } finally {
    busy.value = false
  }
}
async function stopOne(item: WechatInstance) { const result = await stopInstance(item.id, item.managed !== false); result.ok ? ElMessage.success(result.data?.closedWechat ? '微信已关闭' : '已停止管理这个微信') : ElMessage.error(userErrorMessage(result.error, '关闭微信失败')); await refresh() }
async function stopSelected() { for (const item of selectedRows.value) await stopInstance(item.id); await refresh() }
async function tickLogin() {
  if (polling) return
  polling = true
  try {
    const previousOnline = new Set(instances.value.filter((item) => item.status === 'ONLINE').map((item) => item.id))
    instances.value = await listInstances()
    const newlyOnline = instances.value.filter((item) => item.status === 'ONLINE' && !previousOnline.has(item.id)).map((item) => item.id)
    if (newlyOnline.length) { ElMessage.success('登录成功'); await refreshDirectoryQuietly(newlyOnline) }
  } finally { polling = false }
}
onMounted(async () => { await refresh(); const online = instances.value.filter((item) => item.status === 'ONLINE').map((item) => item.id); if (online.length) void refreshDirectoryQuietly(online); timer = setInterval(tickLogin, 2000) })
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <div class="app-page">
    <PageHeader title="微信管理" subtitle="管理多个微信，查看运行状态与登录信息。" />

    <div class="toolbar-row app-card tool-card">
      <div class="toolbar-left">
        <el-button type="primary" :loading="busy" @click="addInstance">新增微信</el-button>
        <el-button :disabled="!selectedRows.length" @click="stopSelected">批量停止</el-button>
        <el-button @click="refresh">刷新状态</el-button>
      </div>
      <div class="toolbar-right">
        <el-input
          v-model="keyword"
          style="width: 240px"
          placeholder="搜索昵称、备注或微信号"
          :prefix-icon="Search"
          clearable
        />
      </div>
    </div>

    <div class="chip-row">
      <button
        v-for="item in instanceFilters"
        :key="item"
        class="chip"
        :class="{ 'is-active': activeFilter === item }"
        @click="activeFilter = item"
      >
        {{ item }}
      </button>
    </div>

    <div class="split-2-wide page-split">
      <section class="app-card block">
        <div class="table-wrap">
          <el-table
            :data="filteredInstances"
            stripe
            height="360"
            highlight-current-row
            style="width: 100%"
            @row-click="onRowClick"
            @selection-change="selectedRows = $event"
          >
            <el-table-column type="selection" width="48" />
            <el-table-column label="微信昵称" min-width="180" show-overflow-tooltip><template #default="{ row }"><span>{{ instanceDisplayName(row) }}</span></template></el-table-column>
            <el-table-column label="登录状态" width="100">
              <template #default="{ row }"><StatusTag :text="statusLabel(row.status)" /></template>
            </el-table-column>
            <el-table-column label="任务队列" width="100"><template #default>0</template></el-table-column>
            <el-table-column label="风险状态" width="100">
              <template #default><StatusTag text="正常" /></template>
            </el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="{ row }">
                <el-button link type="danger" @click.stop="stopOne(row)">{{ row.managed === false ? '解除' : '关闭' }}</el-button>
              </template>
            </el-table-column>
          </el-table>
        </div>
      </section>

      <DetailPanel v-if="current" :title="`${instanceDisplayName(current)}详情`">
        <div class="field-grid">
          <div class="field-item"><div class="label">微信账号</div><div class="value">{{ current.accountWxid || '登录后显示' }}</div></div>
          <div class="field-item"><div class="label">微信昵称</div><div class="value">{{ current.nickname || '登录后显示' }}</div></div>
          <div class="field-item"><div class="label">运行状态</div><div class="value">{{ statusLabel(current.status) }}</div></div>
        </div>

        <div v-if="current.status === 'WAITING_LOGIN'" class="login-panel muted">请在微信原生窗口中扫码登录，软件会自动识别登录状态。</div>

        <h4 class="sub-title">最近操作</h4>
        <ul class="plain-list">
          <li>软件会自动检查微信运行和登录状态。</li>
        </ul>

        <h4 class="sub-title">账号标签</h4>
        <div class="chip-row">
          <el-tag effect="plain">4.1.8.27</el-tag>
        </div>
      </DetailPanel>
    </div>

    <section class="app-card block">
      <h3 class="section-title">汇总群聊列表（去重）</h3>
      <div class="table-wrap">
        <el-table :data="instanceRooms" stripe height="240" style="width: 100%">
          <el-table-column prop="name" label="群聊名称" min-width="140" show-overflow-tooltip />
          <el-table-column prop="roomId" label="群聊标识" min-width="180" show-overflow-tooltip />
          <el-table-column label="是否保存到通讯录" width="140">
            <template #default="{ row }"><StatusTag :text="row.saved" /></template>
          </el-table-column>
          <el-table-column prop="members" label="成员数" width="90" />
          <el-table-column prop="lastMsgTime" label="最后一条消息时间" min-width="160" show-overflow-tooltip />
          <el-table-column prop="source" label="所属微信" min-width="120" show-overflow-tooltip />
          <el-table-column label="操作" width="160" fixed="right">
              <template #default>
                <el-button link type="primary" @click="router.push('/groups')">查看成员</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tool-card,
.block {
  padding: 14px 16px;
  min-width: 0;
  overflow: hidden;
}

.page-split {
  align-items: stretch;
  min-height: 360px;
}

.sub-title {
  margin: 18px 0 10px;
  font-size: 13px;
  font-weight: 650;
}

.plain-list {
  margin: 0;
  padding-left: 18px;
  color: var(--app-text-secondary);
  display: grid;
  gap: 6px;
}

.login-panel { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--app-border); display: grid; gap: 12px; }
</style>
