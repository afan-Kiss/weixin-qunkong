<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { userErrorMessage } from '../utils/error'
import { Search } from '@element-plus/icons-vue'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import StatCard from '../components/cards/StatCard.vue'
import DetailPanel from '../components/panels/DetailPanel.vue'
import { callWechat } from '../services/wechat'
import { friends, groups, instances, loading, refreshDirectory, savedGroups, type GroupRow } from '../stores/wechatData'

const activeTab = ref('未保存群')
const contactsTabs = ['好友', '已保存群', '未保存群', '全部群']
const keyword = ref('')
const selectedId = ref('')
const selection = ref<GroupRow[]>([])
const saving = ref(false)
const saveTimelineRef = ref<HTMLElement | null>(null)
const saveStatus = ref({ visible: false, text: '', tone: 'running' as 'running' | 'success' | 'warning' })
function instanceName(id: string) { const instance = instances.value.find((item) => item.id === id); return instance?.nickname || instance?.accountWxid || '待登录微信' }
const rows = computed(() => {
  const source = activeTab.value === '好友' ? friends.value.map((item) => ({ id: `${item.sourceInstanceId}\u0000${item.wxid}`, roomId: item.wxid, name: item.nickname || item.remark || item.wxid, members: 0, sourceInstanceId: item.sourceInstanceId, saved: true, owner: '', avatar: item.avatar, raw: {} })) : activeTab.value === '已保存群' ? groups.value.filter((item) => item.saved) : activeTab.value === '未保存群' ? groups.value.filter((item) => !item.saved) : groups.value
  const term = keyword.value.trim().toLowerCase()
  return source.map((item) => ({ ...item, sourceInstanceName: instanceName(item.sourceInstanceId) })).filter((item) => !term || `${item.name} ${item.roomId} ${item.sourceInstanceName}`.toLowerCase().includes(term))
})
const current = computed(() => rows.value.find((g) => g.id === selectedId.value) || rows.value[0])
const contactsStats = computed(() => [
  { title: '好友总数', value: String(friends.value.length) }, { title: '群聊总数', value: String(groups.value.length) }, { title: '未保存群', value: String(groups.value.filter((item) => !item.saved).length) }, { title: '已保存群', value: String(savedGroups.value.length) },
])
const contactSaveTimeline = ref<Array<{ id: string; roomId: string; sourceInstanceId: string; time: string; status: string; content: string }>>([])

async function refresh() { try { await refreshDirectory(); selectedId.value ||= rows.value[0]?.id ?? '' } catch (error) { ElMessage.error(userErrorMessage(error, '刷新通讯录失败')) } }
async function saveSelected() {
  if (!selection.value.length) return ElMessage.warning('请先勾选需要保存的群')
  const targets = [...selection.value]
  saving.value = true
  saveStatus.value = { visible: true, text: `准备保存 ${targets.length} 个群聊`, tone: 'running' }
  try {
    for (const [index, group] of targets.entries()) {
      const instance = instances.value.find((item) => item.id === group.sourceInstanceId)
      const timelineItem = { id: `${Date.now()}-${group.id}`, roomId: group.roomId, sourceInstanceId: group.sourceInstanceId, time: new Date().toLocaleString(), status: '正在保存', content: group.name }
      contactSaveTimeline.value.unshift(timelineItem)
      saveStatus.value = { visible: true, text: `正在保存 ${index + 1}/${targets.length}：${group.name}`, tone: 'running' }
      await nextTick()
      saveTimelineRef.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (!instance) { timelineItem.status = '保存失败'; timelineItem.content = `${group.name}：找不到所属微信`; continue }
      const result = await callWechat(instance, '/api/save_chatroom_to_contact', { roomId: group.roomId }, 438557556)
      timelineItem.status = result.ok ? '等待确认' : '保存失败'
      timelineItem.content = result.ok ? group.name : `${group.name}：${userErrorMessage(result.error, '保存群聊失败')}`
    }
    await refreshDirectory()
    const unresolved = targets.filter((item) => !groups.value.find((group) => group.roomId === item.roomId && group.sourceInstanceId === item.sourceInstanceId)?.saved)
    for (const item of contactSaveTimeline.value) if (targets.some((group) => group.roomId === item.roomId && group.sourceInstanceId === item.sourceInstanceId) && item.status === '等待确认') item.status = unresolved.some((group) => group.roomId === item.roomId && group.sourceInstanceId === item.sourceInstanceId) ? '等待确认' : '保存成功'
    saveStatus.value = unresolved.length ? { visible: true, text: `${targets.length - unresolved.length} 个已保存，${unresolved.length} 个等待确认`, tone: 'warning' } : { visible: true, text: `${targets.length} 个群聊保存成功`, tone: 'success' }
  } catch (error) {
    const message = userErrorMessage(error, '保存群聊时出现问题，请稍后重试')
    saveStatus.value = { visible: true, text: message, tone: 'warning' }
    ElMessage.error(message)
  } finally {
    saving.value = false
    setTimeout(() => { saveStatus.value.visible = false }, 2500)
  }
}
watch(activeTab, () => {
  selection.value = []
  selectedId.value = ''
})

onMounted(refresh)
</script>

<template>
  <div class="app-page">
    <PageHeader title="通讯录" subtitle="查看好友、群聊与未保存群，支持统一保存到通讯录。" />

    <div class="stats-grid-4">
      <StatCard
        v-for="item in contactsStats"
        :key="item.title"
        :title="item.title"
        :value="item.value"
        icon="Notebook"
        tone="primary"
      />
    </div>

    <div class="chip-row">
      <button
        v-for="tab in contactsTabs"
        :key="tab"
        class="chip"
        :class="{ 'is-active': activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ tab }}
      </button>
    </div>

    <div class="toolbar-row app-card tool-card">
      <div class="toolbar-left">
        <el-button type="primary" :loading="saving" :disabled="activeTab === '好友' || !selection.length" @click="saveSelected">保存到通讯录</el-button>
        <el-button :loading="loading" @click="refresh">刷新通讯录</el-button>
      </div>
      <div class="toolbar-right">
        <el-input
          v-model="keyword"
          style="width: 280px"
          placeholder="搜索群名或所属微信"
          :prefix-icon="Search"
          clearable
        />
      </div>
    </div>

    <div class="split-2-wide page-split">
      <section class="app-card block">
        <div class="table-wrap">
          <el-table
            :data="rows"
            stripe
            height="420"
            highlight-current-row
            style="width: 100%"
            @row-click="(row: GroupRow) => (selectedId = row.id)"
            @selection-change="selection = $event"
          >
            <el-table-column type="selection" width="48" />
            <el-table-column prop="name" label="群名" min-width="140" show-overflow-tooltip />
            <el-table-column prop="roomId" label="群聊标识" min-width="180" show-overflow-tooltip />
            <el-table-column prop="members" label="成员数" width="90" />
            <el-table-column prop="sourceInstanceName" label="所属微信" min-width="120" show-overflow-tooltip />
            <el-table-column label="保存状态" width="110">
              <template #default="{ row }"><StatusTag :text="row.saved ? '已保存' : '未保存'" /></template>
            </el-table-column>
            <el-table-column label="最后活跃" min-width="150"><template #default>-</template></el-table-column>
            <el-table-column prop="owner" label="群主/管理员" min-width="120" show-overflow-tooltip />
            <el-table-column label="备注" min-width="110"><template #default>-</template></el-table-column>
          </el-table>
        </div>
      </section>

      <DetailPanel v-if="current" title="群详情">
        <div class="detail-head">
          <div class="avatar">群</div>
          <div>
            <div class="name ellip">{{ current.name }}</div>
            <StatusTag :text="current.saved ? '已保存' : '未保存'" />
          </div>
        </div>
        <div class="field-grid" style="margin-top: 14px">
          <div class="field-item"><div class="label">群聊标识</div><div class="value">{{ current.roomId }}</div></div>
          <div class="field-item"><div class="label">所属微信</div><div class="value">{{ current.sourceInstanceName }}</div></div>
          <div class="field-item"><div class="label">保存状态</div><div class="value">{{ current.saved ? '已保存' : '未保存' }}</div></div>
          <div class="field-item"><div class="label">成员数</div><div class="value">{{ current.members }}</div></div>
          <div class="field-item"><div class="label">最后活跃</div><div class="value">-</div></div>
          <div class="field-item"><div class="label">群主/管理员</div><div class="value">{{ current.owner }}</div></div>
          <div class="field-item"><div class="label">备注</div><div class="value">-</div></div>
        </div>

        <div ref="saveTimelineRef"><h4 class="sub-title">保存记录</h4></div>
        <el-timeline>
          <el-timeline-item
            v-for="item in contactSaveTimeline"
            :key="item.id"
            :timestamp="item.time"
            :type="item.status === '保存成功' ? 'success' : item.status === '保存失败' ? 'danger' : 'primary'"
          >
            <div class="timeline-title">{{ item.status }}</div>
            <div class="muted">{{ item.content }}</div>
          </el-timeline-item>
        </el-timeline>
      </DetailPanel>
    </div>
    <transition name="save-toast">
      <div v-if="saveStatus.visible" class="save-toast" :class="`is-${saveStatus.tone}`">
        <span v-if="saveStatus.tone === 'running'" class="save-toast__spinner" />
        <span>{{ saveStatus.text }}</span>
      </div>
    </transition>
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
  min-height: 420px;
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  background: rgba(20, 184, 166, 0.14);
  color: var(--app-primary-hover);
  display: grid;
  place-items: center;
  font-weight: 700;
}

.name {
  font-weight: 650;
  margin-bottom: 6px;
  max-width: 240px;
}

.sub-title {
  margin: 18px 0 10px;
  font-size: 13px;
  font-weight: 650;
}

.timeline-title {
  font-weight: 600;
  margin-bottom: 4px;
}

.save-toast {
  position: fixed;
  left: 50%;
  top: 50%;
  z-index: 3000;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: min(460px, calc(100vw - 32px));
  padding: 14px 18px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow: 0 14px 38px rgba(15, 23, 42, 0.18);
  color: var(--app-text);
  font-weight: 600;
}

.save-toast.is-success { border-color: rgba(22, 163, 74, 0.35); }
.save-toast.is-warning { border-color: rgba(217, 119, 6, 0.35); }
.save-toast__spinner { width: 16px; height: 16px; border: 2px solid #cbd5e1; border-top-color: var(--app-primary); border-radius: 50%; animation: save-spin 0.8s linear infinite; flex: none; }
.save-toast-enter-active, .save-toast-leave-active { transition: opacity 0.18s ease; }
.save-toast-enter-from, .save-toast-leave-to { opacity: 0; }
@keyframes save-spin { to { transform: rotate(360deg); } }
</style>
