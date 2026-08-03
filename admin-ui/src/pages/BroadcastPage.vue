<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search, Plus } from '@element-plus/icons-vue'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import StatCard from '../components/cards/StatCard.vue'
import { userErrorMessage } from '../utils/error'
import { promptGoToTaskCenter } from '../utils/taskFlow'
import { friends, groups, instances, refreshDirectory, type ContactRow, type GroupRow } from '../stores/wechatData'

const router = useRouter()

const activeTab = ref('好友群发')
const broadcastTabs = ['好友群发', '群聊群发']
const keyword = ref('')
const excludeWxid = ref('')
const excludeNick = ref('')
const messageText = ref('')
const imagePath = ref('')
const imagePreview = ref('')
const pastingImage = ref(false)
const sendMode = ref('now')
const scheduledAt = ref<Date | null>(null)
const allocMode = ref('round')
const accountWeights = ref<Record<string, number>>({})
const skipSame = ref(true)
const autoRetry = ref(true)
const retryTimes = ref(2)
const retryMinutes = ref(5)
type TargetRow = { nickname: string; wxid: string; status: string; tag: string; sourceInstanceIds: string[] }
const selectedTargets = ref<TargetRow[]>([])
const tasks = ref<Array<Record<string, unknown>>>([])
const lastCreatedTaskId = ref('')
const creating = ref(false)
const broadcastFriends = computed<TargetRow[]>(() => {
  const owned = activeTab.value === '好友群发'
    ? friends.value.map((item: ContactRow) => ({ nickname: item.nickname || item.remark || item.wxid, wxid: item.wxid, status: '可用', tag: item.remark, sourceInstanceIds: [item.sourceInstanceId] }))
    : groups.value.map((item: GroupRow) => ({ nickname: item.name, wxid: item.roomId, status: '可用', tag: item.saved ? '已保存' : '未保存', sourceInstanceIds: [item.sourceInstanceId] }))
  const merged = new Map<string, TargetRow>()
  for (const item of owned) {
    const existing = merged.get(item.wxid)
    if (existing) existing.sourceInstanceIds = [...new Set([...existing.sourceInstanceIds, ...item.sourceInstanceIds])]
    else merged.set(item.wxid, item)
  }
  const source = [...merged.values()]
  const terms = keyword.value.trim().toLowerCase()
  // 与加好友排除规则一致：WXID / 昵称精确匹配且忽略大小写
  const excludedIds = new Set(excludeWxid.value.split(/\r?\n/).map((item) => item.trim().toLowerCase()).filter(Boolean))
  const excludedNames = new Set(excludeNick.value.split(/\r?\n/).map((item) => item.trim().toLowerCase()).filter(Boolean))
  return source.filter((item) => (!terms || `${item.nickname} ${item.wxid}`.toLowerCase().includes(terms))
    && !excludedIds.has(String(item.wxid || '').toLowerCase())
    && !excludedNames.has(String(item.nickname || '').toLowerCase()))
})
const broadcastStats = computed(() => [{ title: activeTab.value === '好友群发' ? '全部好友' : '全部群聊', value: String(broadcastFriends.value.length) }, { title: '已选择', value: String(selectedTargets.value.length) }, { title: '可用实例', value: String(instances.value.length) }])
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
const broadcastWarnings = computed(() => tasks.value.filter((item) => item.status === 'COOLING_DOWN').map((item) => ({ id: String(item.id), account: String(item.name), desc: '检测到明确频繁证据，任务已暂停', time: String(item.updated_at || '') })))
const broadcastContent = computed(() => ({ imageName: imagePath.value || '未选择图片' }))

watch(activeTab, () => { selectedTargets.value = [] })

async function refresh() { await refreshDirectory(); tasks.value = (await window.wxControl?.listTasks() ?? []) as Array<Record<string, unknown>> }
function preview() { if (!selectedTargets.value.length) return ElMessage.warning('请先勾选接收对象'); if (!messageText.value.trim() && !imagePath.value) return ElMessage.warning('请输入文字或选择图片'); ElMessageBox.alert(`接收对象：${selectedTargets.value.length} 个\n文字：${messageText.value.trim() || '不发送'}\n图片：${imagePath.value || '不发送'}`, '发送预览', { confirmButtonText: '关闭' }) }

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

async function createBroadcast() {
  if (!selectedTargets.value.length) return ElMessage.warning('请先勾选接收对象')
  const hasText = Boolean(messageText.value.trim())
  const hasImage = Boolean(imagePath.value)
  if (!hasText && !hasImage) return ElMessage.warning('请输入文字或选择图片')
  if (sendMode.value === 'schedule' && (!scheduledAt.value || scheduledAt.value.getTime() <= Date.now())) return ElMessage.warning('请选择未来的发送时间')
  const isGroup = activeTab.value === '群聊群发'
  const mismatched = selectedTargets.value.filter((target) => isGroup !== String(target.wxid || '').endsWith('@chatroom'))
  if (mismatched.length) return ElMessage.warning(isGroup ? '勾选对象里混入了好友，请切换到「好友群发」或重新勾选群聊' : '勾选对象里混入了群聊，请切换到「群聊群发」或重新勾选好友')
  try {
    await ElMessageBox.confirm(`确认创建包含 ${selectedTargets.value.length} 个目标的任务？创建后仍需在任务中心确认执行。`, '确认群发任务', { type: 'warning' })
  } catch { return }
  const type = hasText && hasImage ? (isGroup ? 'SEND_MIXED_TO_GROUP' : 'SEND_MIXED_TO_FRIEND') : hasText ? (isGroup ? 'SEND_TEXT_TO_GROUP' : 'SEND_TEXT_TO_FRIEND') : (isGroup ? 'SEND_IMAGE_TO_GROUP' : 'SEND_IMAGE_TO_FRIEND')
  const available = instances.value.filter((item) => item.status === 'ONLINE')
  if (!available.length) return ElMessage.warning('没有已登录的微信')
  const unavailable = selectedTargets.value.filter((target) => !available.some((item) => target.sourceInstanceIds.includes(item.id)))
  if (unavailable.length) return ElMessage.warning(`${unavailable.length} 个接收对象所属的微信当前不在线，请刷新后重试`)
  creating.value = true
  try {
    const items = selectedTargets.value.flatMap((target, index) => {
      const eligible = available.filter((item) => target.sourceInstanceIds.includes(item.id))
      const allocationPool = eligible.flatMap((item) => Array.from({ length: allocMode.value === 'weight' ? Math.max(1, Math.round(accountWeights.value[item.id] || 1)) : 1 }, () => item))
      const assigned = allocationPool[index % allocationPool.length]
      return [
        ...(hasText ? [{ instanceId: assigned.id, targetKey: target.wxid, actionType: 'SEND_TEXT', request: { wxid: target.wxid, msg: messageText.value.trim() } }] : []),
        ...(hasImage ? [{ instanceId: assigned.id, targetKey: target.wxid, actionType: 'SEND_IMAGE', request: { wxid: target.wxid, filepath: imagePath.value } }] : []),
      ]
    })
    const created = await window.wxControl?.createTask({ name: `${activeTab.value} ${new Date().toLocaleString()}`, type, config: { autoRetry: autoRetry.value, retryTimes: retryTimes.value, retryMinutes: retryMinutes.value, skipSame: skipSame.value, scheduledAt: sendMode.value === 'schedule' ? scheduledAt.value?.toISOString() : null, allocMode: allocMode.value, accountWeights: accountWeights.value }, items }) as Record<string, unknown> | undefined
    lastCreatedTaskId.value = String(created?.id || '')
    await refresh()
    await promptGoToTaskCenter(router, `已创建 ${selectedTargets.value.length} 个目标的群发任务`)
  } catch (error) {
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
onMounted(() => { refresh(); document.addEventListener('paste', onPaste) })
onBeforeUnmount(() => document.removeEventListener('paste', onPaste))
</script>

<template>
  <div class="app-page">
    <PageHeader title="消息群发" subtitle="勾选接收对象后创建任务；创建后需到任务中心确认才会真正发送。" />

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
            placeholder="搜索微信号或昵称"
            :prefix-icon="Search"
            clearable
          />
          <el-button @click="refresh">刷新</el-button>
        </div>

        <div class="exclude-grid">
          <div>
            <label>排除微信号</label>
            <el-input v-model="excludeWxid" type="textarea" :rows="3" />
          </div>
          <div>
            <label>排除昵称</label>
            <el-input v-model="excludeNick" type="textarea" :rows="3" />
          </div>
        </div>

        <div class="table-wrap" style="margin-top: 12px">
          <el-table :data="broadcastFriends" stripe height="280" style="width: 100%" @selection-change="selectedTargets = $event">
            <el-table-column type="selection" width="48" />
            <el-table-column prop="nickname" label="昵称" min-width="120" show-overflow-tooltip />
            <el-table-column prop="wxid" label="微信号" min-width="150" show-overflow-tooltip />
            <el-table-column label="状态" width="90">
              <template #default="{ row }"><StatusTag :text="row.status" /></template>
            </el-table-column>
            <el-table-column prop="tag" label="标签" min-width="120" show-overflow-tooltip />
          </el-table>
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
          <label>按账号分配</label>
          <el-radio-group v-model="allocMode">
            <el-radio value="round">轮询分配</el-radio>
            <el-radio value="weight">按权重分配</el-radio>
          </el-radio-group>
          <div v-if="allocMode === 'weight'" class="checks" style="margin-top: 8px">
            <div v-for="account in instances.filter(item => item.status === 'ONLINE')" :key="account.id" class="retry-row">
              <span>{{ account.nickname || account.accountWxid || '未命名微信' }}</span>
              <el-input-number v-model="accountWeights[account.id]" :min="1" :max="100" controls-position="right" />
            </div>
          </div>
        </div>

        <div class="form-block">
          <label>高级选项</label>
          <div class="checks">
            <el-checkbox v-model="skipSame">跳过已接收过相同内容的好友</el-checkbox>
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

.exclude-grid label,
.form-block label {
  display: block;
  margin-bottom: 6px;
  color: var(--app-text-secondary);
  font-size: 12px;
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

.range-row,
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
