<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  Odometer,
  Monitor,
  UserFilled,
  Grid,
  ChatLineSquare,
  Notebook,
  List,
  Setting,
  Search,
  Fold,
  Expand,
  ChatDotRound,
  ChatLineRound,
  Connection,
} from '@element-plus/icons-vue'
import { refreshInstances, ensureBlockedDirectoryListener } from '../stores/wechatData'
import { authState, ensureSession, logout } from '../stores/auth'

const displayVersion = __APP_VERSION__

const collapsed = ref(false)
const route = useRoute()
const router = useRouter()
const searchText = ref('')
const metrics = ref({ uptimeSeconds: 0, cpuPercent: 0, memoryBytes: 0, diskBytes: 0, processCount: 0, measuredAt: '' })
function formatDuration(seconds: number) { const total = Math.max(Math.floor(seconds), 0); const days = Math.floor(total / 86400); const hours = Math.floor(total % 86400 / 3600); const minutes = Math.floor(total % 3600 / 60); if (days) return `${days}天${hours}小时`; if (hours) return `${hours}小时${minutes}分钟`; return `${minutes}分${total % 60}秒` }
function formatBytes(bytes: number) { if (!Number.isFinite(bytes) || bytes <= 0) return '正在统计'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); const value = bytes / 1024 ** index; return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}` }
const layoutSystemStatus = computed(() => ({ uptime: formatDuration(metrics.value.uptimeSeconds), cpu: `${metrics.value.cpuPercent.toFixed(1)}%`, memory: formatBytes(metrics.value.memoryBytes), disk: formatBytes(metrics.value.diskBytes) }))
let metricsTimer: ReturnType<typeof setInterval> | undefined
let authTimer: ReturnType<typeof setInterval> | undefined
async function refreshMetrics() { const value = await window.wxControl?.systemMetrics(); if (value) metrics.value = value }

const menus = [
  { path: '/dashboard', label: '总览', icon: Odometer },
  { path: '/instances', label: '微信管理', icon: Monitor },
  { path: '/groups', label: '群与成员', icon: UserFilled },
  { path: '/chat-add-friend', label: '群聊加好友', icon: ChatLineRound },
  { path: '/qr-tasks', label: '二维码任务', icon: Grid },
  { path: '/broadcast', label: '消息群发', icon: ChatLineSquare },
  { path: '/contacts', label: '通讯录', icon: Notebook },
  { path: '/wxids', label: '微信 ID 查询', icon: Search },
  { path: '/tasks', label: '任务中心', icon: List },
  { path: '/monitor', label: '会话监控', icon: ChatDotRound },
  { path: '/remote-support', label: '远程维护', icon: Connection },
  { path: '/settings', label: '日志与设置', icon: Setting },
]

const active = computed(() => route.path)

function go(path: string) {
  router.push(path)
}

function globalSearch() { if (!searchText.value.trim()) return; router.push({ path: '/wxids', query: { q: searchText.value.trim() } }) }
async function signOut() { await logout(); await router.replace('/login') }
async function validateAccount() { if (!await ensureSession(true)) await router.replace('/login') }
onMounted(() => {
  ensureBlockedDirectoryListener()
  refreshInstances()
  refreshMetrics()
  metricsTimer = setInterval(refreshMetrics, 5000)
  authTimer = setInterval(validateAccount, 60000)
})
onBeforeUnmount(() => { if (metricsTimer) clearInterval(metricsTimer); if (authTimer) clearInterval(authTimer) })
</script>

<template>
  <div class="shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand__logo">W</div>
        <div v-if="!collapsed" class="brand__text">
          <div class="brand__name">微信群控管理平台</div>
          <div class="brand__ver">v{{ displayVersion }}</div>
        </div>
      </div>

      <nav class="menu">
        <button
          v-for="item in menus"
          :key="item.path"
          class="menu__item"
          :class="{ 'is-active': active === item.path }"
          @click="go(item.path)"
        >
          <el-icon :size="18"><component :is="item.icon" /></el-icon>
          <span v-if="!collapsed">{{ item.label }}</span>
        </button>
      </nav>

      <div class="sidebar__footer">
        <div v-if="!collapsed" class="sys-status">
          <div class="sys-status__row"><span>软件运行时长</span><b>{{ layoutSystemStatus.uptime }}</b></div>
          <div class="sys-status__row"><span>CPU 占用</span><b>{{ layoutSystemStatus.cpu }}</b></div>
          <div class="sys-status__row"><span>内存占用</span><b>{{ layoutSystemStatus.memory }}</b></div>
          <div class="sys-status__row"><span>磁盘占用</span><b>{{ layoutSystemStatus.disk }}</b></div>
        </div>
        <el-button class="collapse-btn" text @click="collapsed = !collapsed">
          <el-icon><Fold v-if="!collapsed" /><Expand v-else /></el-icon>
          <span v-if="!collapsed">收起侧栏</span>
        </el-button>
      </div>
    </aside>

    <div class="main">
      <header class="topbar">
        <div class="topbar__left">
          <el-input
            v-model="searchText"
            class="topbar__search"
            placeholder="搜索微信 ID…"
            :prefix-icon="Search"
            clearable
            @keyup.enter="globalSearch"
          />
        </div>
        <div class="topbar__right">
          <el-dropdown trigger="click">
          <div class="admin" role="button" tabindex="0">
            <el-avatar :size="32" class="admin__avatar">管</el-avatar>
            <div class="admin__meta">
              <div class="admin__name ellip">{{ authState.account?.username || '当前账号' }}</div>
              <div class="admin__online">在线</div>
            </div>
          </div>
          <template #dropdown><el-dropdown-menu><el-dropdown-item @click="signOut">退出登录</el-dropdown-item></el-dropdown-menu></template>
          </el-dropdown>
        </div>
      </header>

      <main class="content">
        <router-view />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: grid;
  grid-template-columns: var(--app-sidebar-width) minmax(0, 1fr);
  width: 100%;
  height: 100%;
  min-width: var(--app-min-width);
  background: var(--app-bg);
  overflow-x: auto;
  overflow-y: hidden;
}

.shell.is-collapsed {
  grid-template-columns: var(--app-sidebar-collapsed) 1fr;
}

.sidebar {
  display: flex;
  flex-direction: column;
  background: var(--app-sidebar);
  border-right: 1px solid var(--app-border);
  min-height: 0;
  overflow: hidden;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  height: var(--app-topbar-height);
  padding: 0 16px;
  border-bottom: 1px solid var(--app-border);
}

.brand__logo {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: linear-gradient(135deg, #14b8a6, #0f9f90);
  color: #fff;
  display: grid;
  place-items: center;
  font-weight: 700;
  flex-shrink: 0;
}

.brand__name {
  font-size: 14px;
  font-weight: 700;
  color: var(--app-text);
  white-space: nowrap;
}

.brand__ver {
  font-size: 12px;
  color: var(--app-text-secondary);
}

.menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 10px;
  flex: 1;
  overflow: auto;
}

.menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--app-text-secondary);
  cursor: pointer;
  text-align: left;
  transition: 0.15s ease;
}

.menu__item:hover {
  background: rgba(31, 41, 55, 0.04);
  color: var(--app-text);
}

.menu__item.is-active {
  background: var(--app-sidebar-active);
  color: var(--app-primary-hover);
  font-weight: 650;
}

.sidebar__footer {
  padding: 12px;
  border-top: 1px solid var(--app-border);
}

.sys-status {
  display: grid;
  gap: 8px;
  margin-bottom: 10px;
  padding: 10px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.65);
  border: 1px solid var(--app-border);
}

.sys-status__row {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--app-text-secondary);
}

.sys-status__row b {
  color: var(--app-text);
  font-weight: 600;
}

.collapse-btn {
  width: 100%;
  justify-content: flex-start;
}

.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.topbar {
  height: var(--app-topbar-height);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 20px;
  background: #f8f9fb;
  border-bottom: 1px solid var(--app-border);
}

.topbar__left,
.topbar__right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.topbar__search {
  width: min(320px, 36vw);
  min-width: 180px;
}

.admin {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 8px;
  border-left: 1px solid var(--app-border);
}

.admin__avatar {
  background: rgba(20, 184, 166, 0.16);
  color: var(--app-primary-hover);
  font-weight: 700;
}

.admin__meta {
  min-width: 0;
}

.admin__name {
  font-size: 13px;
  font-weight: 600;
  max-width: 100px;
}

.admin__online {
  font-size: 12px;
  color: var(--app-success);
}

.admin__more {
  cursor: pointer;
  color: var(--app-text-secondary);
  padding: 4px;
}

.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
</style>
