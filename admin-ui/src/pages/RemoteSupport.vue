<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import PageHeader from '../components/app/PageHeader.vue'
import { remoteService, type RemoteStatus } from '../services/remote-service'
import { userErrorMessage } from '../utils/error'

const clientId = ref('')
const status = ref<RemoteStatus | null>(null)
const loading = ref(false)
const acting = ref('')
const sessionOpen = ref(false)

const CODE_LABELS: Record<string, string> = {
  OK: '就绪',
  MESH_DISABLED: '远程服务未启用',
  MESH_UNREACHABLE: '远程服务不可用',
  MESH_UNHEALTHY: '远程服务异常',
  MESH_UNBOUND: '未绑定节点',
  MESH_NO_MATCH: '未找到匹配节点',
  MESH_SESSION_ERROR: '会话创建失败',
  AGENT_MISSING: 'Agent 未安装',
  AGENT_STOPPED: 'Agent 已停止',
  AGENT_STARTING: 'Agent 启动中',
  AGENT_BROKEN: 'Agent 异常',
  FORBIDDEN: '权限不足',
  UNAUTHORIZED: '未登录或登录失效',
  BAD_REQUEST: '参数无效',
  IPC_UNAVAILABLE: 'IPC 未接线',
  IPC_ERROR: 'IPC 错误',
}

const statusLabel = computed(() => {
  const row = status.value
  if (!row) return '未知'
  const code = String(row.code || '')
  if (CODE_LABELS[code]) return CODE_LABELS[code]
  const agent = String(row.meshAgentStatus || row.localAgent?.status || '')
  if (agent === 'missing') return 'Agent 未安装'
  if (agent === 'running' && row.bound) return '在线'
  if (agent === 'running') return 'Agent 在线（未绑定）'
  if (agent === 'stopped' || agent === 'installed_no_service') return 'Agent 已停止'
  if (agent === 'broken' || agent === 'error') return 'Agent 异常'
  if (agent === 'pending') return 'Agent 启动中'
  if (row.bound === false) return '未绑定'
  if (row.ok) return '就绪'
  return row.message || '异常'
})

const statusType = computed(() => {
  const label = statusLabel.value
  if (label === '就绪' || label === '在线') return 'success'
  if (
    label.includes('未启用')
    || label.includes('未绑定')
    || label.includes('未知')
    || label.includes('未安装')
  ) return 'info'
  if (label.includes('停止') || label.includes('启动中')) return 'warning'
  return 'danger'
})

const canOpenRemote = computed(() => {
  const row = status.value
  if (!row) return false
  if (['FORBIDDEN', 'UNAUTHORIZED', 'MESH_DISABLED', 'MESH_UNREACHABLE', 'BAD_REQUEST'].includes(String(row.code || ''))) {
    return false
  }
  return Boolean(row.bound && row.meshNodeId)
})

async function refreshStatus() {
  const id = clientId.value.trim()
  if (!id) {
    status.value = null
    return
  }
  loading.value = true
  try {
    status.value = await remoteService.getStatus(id)
  } catch (err) {
    ElMessage.error(userErrorMessage(err, '读取远程状态失败'))
  } finally {
    loading.value = false
  }
}

function explainOpenError(err: unknown, fallback: string) {
  const msg = userErrorMessage(err, fallback)
  const code = status.value?.code || ''
  if (code === 'MESH_UNBOUND') return '设备尚未绑定 Mesh 节点，请确认 Agent 已上线后点击刷新，或由运维执行 auto-bind'
  if (code === 'AGENT_MISSING') return '本机尚未配置 MeshAgent（缺少 meshagent.exe / .msh），开发环境请先 npm run fetch:mesh-agent'
  if (code === 'MESH_UNREACHABLE' || code === 'MESH_DISABLED') return '远程服务不可用（MeshCentral 未启用或不可达），微信群控其它功能不受影响'
  if (code === 'FORBIDDEN') return '权限不足：不能操作其他用户的设备'
  return msg
}

async function openDesktop() {
  const id = clientId.value.trim()
  if (!id) {
    ElMessage.warning('请填写 clientId')
    return
  }
  acting.value = 'desktop'
  try {
    await remoteService.openDesktop(id)
    sessionOpen.value = true
    ElMessage.success('已打开远程桌面（主进程嵌入窗口，令牌不进入本页）')
  } catch (err) {
    ElMessage.error(explainOpenError(err, '打开远程桌面失败'))
  } finally {
    acting.value = ''
  }
}

async function openFiles() {
  const id = clientId.value.trim()
  if (!id) {
    ElMessage.warning('请填写 clientId')
    return
  }
  acting.value = 'files'
  try {
    await remoteService.openFiles(id)
    sessionOpen.value = true
    ElMessage.success('已打开文件管理（主进程嵌入窗口）')
  } catch (err) {
    ElMessage.error(explainOpenError(err, '打开文件管理失败'))
  } finally {
    acting.value = ''
  }
}

async function closeSession() {
  acting.value = 'close'
  try {
    await remoteService.closeSession()
    sessionOpen.value = false
    ElMessage.success('已关闭远程会话并清理临时凭据')
  } catch (err) {
    ElMessage.error(userErrorMessage(err, '关闭会话失败'))
  } finally {
    acting.value = ''
  }
}

onMounted(async () => {
  const q = new URLSearchParams(location.hash.split('?')[1] || '')
  const fromQuery = String(q.get('clientId') || '').trim()
  if (fromQuery) {
    clientId.value = fromQuery
  } else {
    try {
      const agent = await (window.wxControl as { remoteAgentStatus?: () => Promise<{ clientId?: string }> })?.remoteAgentStatus?.()
      if (agent?.clientId) clientId.value = String(agent.clientId)
    } catch { /* ignore */ }
  }
  if (clientId.value.trim()) void refreshStatus()
})
</script>

<template>
  <div class="app-page">
    <PageHeader
      title="远程维护"
      subtitle="通过自建 MeshCentral Relay 进行远程桌面与文件管理。不提供终端。登录令牌仅存在于 Electron 主进程。"
    />

    <div class="toolbar-row app-card tool">
      <div class="toolbar-left">
        <span class="client-label">客户端</span>
        <el-input
          v-model="clientId"
          clearable
          placeholder="设备 clientId"
          style="width: 320px"
          @keyup.enter="refreshStatus"
        />
        <el-button type="primary" :loading="loading" @click="refreshStatus">刷新状态</el-button>
        <el-tag :type="statusType" effect="light">{{ statusLabel }}</el-tag>
      </div>
      <div class="toolbar-right">
        <el-button :loading="acting === 'desktop'" type="primary" :disabled="!canOpenRemote && !!status" @click="openDesktop">远程桌面</el-button>
        <el-button :loading="acting === 'files'" :disabled="!canOpenRemote && !!status" @click="openFiles">文件管理</el-button>
        <el-button :loading="acting === 'close'" text :disabled="!sessionOpen" @click="closeSession">关闭会话</el-button>
      </div>
    </div>

    <section class="app-card block">
      <h3 class="block__title">设备状态</h3>
      <el-descriptions :column="2" border>
        <el-descriptions-item label="clientId">{{ status?.clientId || clientId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="绑定">{{ status?.bound ? '是' : '否' }}</el-descriptions-item>
        <el-descriptions-item label="Mesh 节点">{{ status?.meshNodeId || '-' }}</el-descriptions-item>
        <el-descriptions-item label="Agent">{{ status?.meshAgentStatus || status?.localAgent?.status || status?.status || '-' }}</el-descriptions-item>
        <el-descriptions-item label="最近在线">{{ status?.meshLastSeen || '-' }}</el-descriptions-item>
        <el-descriptions-item label="说明">{{ status?.message || status?.code || '-' }}</el-descriptions-item>
      </el-descriptions>
      <div class="view-panel" :class="{ 'view-panel--active': sessionOpen }">
        <p class="view-panel__title">Remote View</p>
        <p class="hint">
          远程画面在主进程受控 BrowserWindow 中打开（viewmode=11 桌面 / viewmode=13 文件，hide=63）。
          本页故意不嵌入带 login token 的 iframe，避免令牌进入 Vue / localStorage。
          关闭会话会销毁临时 partition 与 Cookie。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tool,
.block {
  padding: 14px 16px;
  min-width: 0;
  overflow: hidden;
}
.toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.client-label {
  font-size: 13px;
  color: var(--app-text-secondary);
}
.block__title {
  margin: 0 0 12px;
  font-size: 15px;
  font-weight: 600;
}
.hint {
  margin: 0;
  color: var(--app-text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.view-panel {
  margin-top: 14px;
  padding: 18px 16px;
  border: 1px dashed var(--el-border-color);
  border-radius: 8px;
  background: var(--el-fill-color-blank);
  min-height: 120px;
}
.view-panel--active {
  border-style: solid;
  border-color: var(--el-color-primary-light-5);
}
.view-panel__title {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
}
</style>
