<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import PageHeader from '../components/app/PageHeader.vue'
import StatusTag from '../components/app/StatusTag.vue'
import { userErrorMessage } from '../utils/error'
import type { WechatInstance } from '../services/wechat'
const settingsMenus = ['任务与频率', '连接设置', '文件位置']
const logLevelChips = [{ label: '全部', value: '全部' }, { label: '普通', value: 'INFO' }, { label: '提醒', value: 'WARNING' }, { label: '错误', value: 'ERROR' }]
const settingsForm = { intervalMin: 20, intervalMax: 40, httpPort: 19088, friendDailyLimit: 50, tcpPort: 61108, qrDir: '', weixinExe: '' }

const activeMenu = ref('任务与频率')
const activeLogLevel = ref('全部')
const form = reactive({ ...settingsForm })
const weixinVersion = ref('')
const detectingWeixin = ref(false)
const logKeyword = ref('')
const logs = ref<Array<Record<string, unknown>>>([])
const logInstances = ref<WechatInstance[]>([])
const selectedInstance = ref('all')
const timeRange = ref('1h')
const logLevelLabels: Record<string, string> = { INFO: '普通', WARNING: '提醒', ERROR: '错误' }
const apiOperationLabels: Record<string, string> = {
  '/api/send_text_msg': '发送文字消息', '/api/send_image_msg': '发送图片消息', '/api/add_friend': '添加好友',
  '/api/get_contact_list2': '读取好友列表', '/api/get_chatroom_list': '读取群聊列表', '/api/batch_getroom_cache': '读取群聊资料',
  '/api/get_room_members': '读取群成员', '/api/get_group_member_contact': '读取群成员资料', '/api/save_chatroom_to_contact': '保存群聊到通讯录',
  '/api/check_login': '检测微信登录状态', '/api/get_profile_cache': '读取微信资料', '/api/qrscan': '识别二维码',
}
function detailsOf(item: Record<string, unknown>) { try { return typeof item.detailsJson === 'string' ? JSON.parse(item.detailsJson) as Record<string, unknown> : {} } catch { return {} } }
function instanceName(id: unknown) { if (!id) return '本机'; const instance = logInstances.value.find((item) => item.id === String(id)); return instance?.nickname || instance?.accountWxid || '已解除的微信' }
const systemLogs = computed(() => logs.value.map((stored) => ({ ...detailsOf(stored), ...stored })).filter((item) => {
  if (activeLogLevel.value !== '全部' && item.level !== activeLogLevel.value) return false
  if (selectedInstance.value !== 'all' && item.instanceId !== selectedInstance.value) return false
  const cutoff = timeRange.value === '1h' ? Date.now() - 3600000 : timeRange.value === '24h' ? Date.now() - 86400000 : 0
  return !cutoff || new Date(String(item.time)).getTime() >= cutoff
}).map((item) => {
  const operation = String(item.operation || apiOperationLabels[String(item.path)] || item.module || '软件运行')
  const generic = ['微信 API 调用完成', '微信 API 调用失败'].includes(String(item.message))
  return { ...item, levelLabel: logLevelLabels[String(item.level)] || '普通', instance: instanceName(item.instanceId), module: operation, content: generic ? `${operation}${String(item.message).endsWith('失败') ? '失败' : '完成'}` : item.message, cost: item.durationMs ? `${item.durationMs} 毫秒` : '-' }
}).filter((item) => !logKeyword.value || `${item.content} ${item.instance} ${item.module}`.toLowerCase().includes(logKeyword.value.toLowerCase())))
function showLogDetails(row: Record<string, unknown>) { ElMessageBox.alert(`时间：${row.time || '-'}\n级别：${row.levelLabel || '-'}\n功能：${row.module || '-'}\n内容：${row.content || '-'}`, '记录详情') }
let unsubscribe: (() => void) | undefined
/**
 * 加载设置；展示自动识别到的微信路径与版本。
 */
async function load() {
  const [settings, rows, instances] = await Promise.all([
    window.wxControl?.getSettings(),
    window.wxControl?.listLogs(1000) ?? [],
    window.wxControl?.listInstances() ?? [],
  ])
  if (settings?.general && typeof settings.general === 'object') {
    const general = settings.general as Record<string, unknown>
    // 只回填表单字段，避免把 weixinVersion 等展示字段写进保存载荷
    form.intervalMin = Number(general.intervalMin) || form.intervalMin
    form.intervalMax = Number(general.intervalMax) || form.intervalMax
    form.httpPort = Number(general.httpPort) || form.httpPort
    form.tcpPort = Number(general.tcpPort) || form.tcpPort
    form.friendDailyLimit = Number(general.friendDailyLimit) || form.friendDailyLimit
    form.qrDir = typeof general.qrDir === 'string' ? general.qrDir : form.qrDir
    form.weixinExe = typeof general.weixinExe === 'string' ? general.weixinExe : form.weixinExe
    weixinVersion.value = String(general.weixinVersion || '')
  }
  logs.value = rows as Array<Record<string, unknown>>
  logInstances.value = instances
}

/**
 * 保存设置。
 */
async function save() {
  try {
    const saved = await window.wxControl?.saveSettings({ ...form }) as Record<string, unknown> | undefined
    if (saved) {
      Object.assign(form, saved)
      weixinVersion.value = String(saved.weixinVersion || '')
    }
    ElMessage.success(form.weixinExe ? '设置已保存并应用于后续打开的微信' : '设置已保存；微信路径未识别时，打开微信前请先「重新检测」或手动选择')
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '保存设置失败，请检查微信安装路径'))
  }
}

async function selectQrDirectory() { const selected = await window.wxControl?.selectDirectory(form.qrDir); if (selected) form.qrDir = selected }

/**
 * 手动选择微信程序（仅自动探测失败时使用）。
 */
async function selectWeixinExecutable() {
  try {
    const selected = await window.wxControl?.selectWeixinExecutable(form.weixinExe)
    if (selected) form.weixinExe = selected
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '选择微信程序失败'))
  }
}

/**
 * 重新自动探测本机微信路径。
 */
async function detectWeixinInstall() {
  detectingWeixin.value = true
  try {
    const result = await window.wxControl?.detectWeixinInstall?.()
    if (!result?.exePath) throw new Error('未能自动找到本机微信')
    form.weixinExe = result.exePath
    weixinVersion.value = result.version || ''
    await save()
    ElMessage.success(`已自动识别微信：${result.exePath}${result.version ? `（版本 ${result.version}）` : ''}`)
  } catch (error) {
    ElMessage.error(userErrorMessage(error, '未能自动找到微信，请手动选择 Weixin.exe'))
  } finally {
    detectingWeixin.value = false
  }
}
async function clear() { await ElMessageBox.confirm('确定清空本机日志记录？', '清空日志', { type: 'warning' }); await window.wxControl?.clearLogs(); logs.value = [] }
onMounted(() => { load(); unsubscribe = window.wxControl?.onLog((entry) => logs.value.unshift(entry as Record<string, unknown>)) }); onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div class="app-page">
    <PageHeader title="日志与设置" subtitle="统一配置软件运行、任务间隔和查看运行记录。" />

    <div class="settings-split">
      <aside class="app-card menu-card">
        <button
          v-for="item in settingsMenus"
          :key="item"
          class="menu-item"
          :class="{ 'is-active': activeMenu === item }"
          @click="activeMenu = item"
        >
          {{ item }}
        </button>
      </aside>

      <section class="app-card form-card">
        <h3 class="section-title">{{ activeMenu }}</h3>
        <div v-if="activeMenu === '任务与频率'" class="form-grid">
          <div class="form-item form-item--wide">
            <label>随机间隔范围（秒）</label>
            <div class="range-row">
              <el-input-number v-model="form.intervalMin" :min="1" controls-position="right" />
              <span>—</span>
              <el-input-number v-model="form.intervalMax" :min="1" controls-position="right" />
            </div>
          </div>
          <div class="form-item">
            <label>添加好友每日上限（个）</label>
            <el-input-number v-model="form.friendDailyLimit" :min="1" controls-position="right" style="width: 100%" />
          </div>
        </div>
        <div v-else-if="activeMenu === '连接设置'" class="form-grid">
          <div class="form-item">
            <label>微信功能连接起始端口</label>
            <el-input-number v-model="form.httpPort" :min="1024" :max="65535" controls-position="right" style="width: 100%" />
          </div>
          <div class="form-item">
            <label>微信消息接收起始端口</label>
            <el-input-number v-model="form.tcpPort" :min="1024" :max="65535" controls-position="right" style="width: 100%" />
          </div>
          <div class="form-note">端口设置只影响之后新增的微信，已经连接的微信不会中断。</div>
        </div>
        <div v-else class="form-grid">
          <div class="form-item form-item--wide">
            <label>微信安装路径（启动时自动探测）</label>
            <div class="range-row">
              <el-input v-model="form.weixinExe" placeholder="启动后自动识别；找不到时再手动选择 Weixin.exe" />
              <el-button :loading="detectingWeixin" type="primary" @click="detectWeixinInstall">重新检测</el-button>
              <el-button @click="selectWeixinExecutable">手动选择</el-button>
            </div>
            <div class="form-note">{{ weixinVersion ? `已识别版本：${weixinVersion}` : '尚未识别到版本；若路径为空请点“重新检测”，仍失败再“手动选择”。' }}</div>
          </div>
          <div class="form-item form-item--wide">
            <label>二维码默认文件夹</label>
            <div class="range-row">
              <el-input v-model="form.qrDir" placeholder="未设置时使用上次打开的位置" readonly />
              <el-button @click="selectQrDirectory">选择文件夹</el-button>
              <el-button :disabled="!form.qrDir" @click="form.qrDir = ''">恢复默认</el-button>
            </div>
          </div>
        </div>

        <div class="toolbar-right" style="margin-top: 16px; justify-content: flex-end">
          <el-button type="primary" @click="save">保存设置</el-button>
        </div>
      </section>
    </div>

    <section class="app-card log-card">
      <div class="toolbar-row">
        <div>
          <h3 class="section-title" style="margin-bottom: 10px">系统日志（实时）</h3>
          <div class="chip-row">
            <button
              v-for="item in logLevelChips"
              :key="item.value"
              class="chip"
              :class="{ 'is-active': activeLogLevel === item.value }"
              @click="activeLogLevel = item.value"
            >
              {{ item.label }}
            </button>
          </div>
        </div>
        <div class="toolbar-right">
          <el-input
            v-model="logKeyword"
            style="width: 260px"
            placeholder="搜索记录内容、微信或关键词"
            :prefix-icon="Search"
            clearable
          />
          <el-select v-model="selectedInstance" style="width: 140px">
            <el-option label="全部微信" value="all" />
            <el-option v-for="item in logInstances" :key="item.id" :label="item.nickname || item.accountWxid || '待登录微信'" :value="item.id" />
          </el-select>
          <el-select v-model="timeRange" style="width: 130px">
            <el-option label="最近 1 小时" value="1h" />
            <el-option label="最近 24 小时" value="24h" />
            <el-option label="全部时间" value="all" />
          </el-select>
          <el-button @click="clear">清空日志</el-button>
        </div>
      </div>

      <div class="table-wrap" style="margin-top: 12px">
        <el-table :data="systemLogs" stripe height="280" style="width: 100%">
          <el-table-column prop="time" label="时间" min-width="170" show-overflow-tooltip />
          <el-table-column label="级别" width="90">
            <template #default="{ row }"><StatusTag :text="row.levelLabel" /></template>
          </el-table-column>
          <el-table-column prop="instance" label="微信" min-width="120" show-overflow-tooltip />
          <el-table-column prop="module" label="功能" min-width="110" show-overflow-tooltip />
          <el-table-column prop="content" label="日志内容" min-width="220" show-overflow-tooltip />
          <el-table-column prop="cost" label="耗时" width="100" />
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" @click="showLogDetails(row)">查看</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-split {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: var(--app-gap);
  min-width: 0;
  min-height: 0;
}

@media (max-width: 1500px) {
  .settings-split {
    grid-template-columns: minmax(0, 1fr);
  }

  .form-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
}

.menu-card {
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.menu-item {
  height: 40px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-secondary);
  text-align: left;
  padding: 0 12px;
  cursor: pointer;
}

.menu-item:hover {
  background: rgba(31, 41, 55, 0.04);
  color: var(--app-text);
}

.menu-item.is-active {
  background: var(--app-sidebar-active);
  color: var(--app-primary-hover);
  font-weight: 650;
}

.form-card,
.log-card {
  padding: 16px;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px 16px;
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.form-item label {
  color: var(--app-text-secondary);
  font-size: 12px;
}

.form-item--wide {
  grid-column: span 2;
}

.form-note {
  grid-column: 1 / -1;
  color: var(--app-text-secondary);
  font-size: 12px;
}

.range-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sub-title {
  margin: 20px 0 12px;
  font-size: 14px;
  font-weight: 650;
}

.switch-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: #fbfbfc;
}
</style>
