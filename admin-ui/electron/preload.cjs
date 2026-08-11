const { contextBridge, ipcRenderer } = require('electron')

/**
 * 渲染进程 → 主进程参数净化（须内联：Electron 沙箱 preload 不能 require 本地模块）。
 * @param {unknown} value
 * @returns {unknown}
 */
function plainIpcValue(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'function' || typeof item === 'symbol') return undefined
      if (item instanceof Error) return { name: item.name, message: item.message }
      return item
    }))
  } catch {
    return null
  }
}

contextBridge.exposeInMainWorld('wxControl', {
  authSession: () => ipcRenderer.invoke('auth:session'),
  authLogin: (username, password) => ipcRenderer.invoke('auth:login', username, password),
  authRegister: (username, password) => ipcRenderer.invoke('auth:register', username, password),
  authLogout: () => ipcRenderer.invoke('auth:logout'),
  systemMetrics: () => ipcRenderer.invoke('system:metrics'),
  listInstances: () => ipcRenderer.invoke('wechat:list-instances'),
  startInstance: () => ipcRenderer.invoke('wechat:start-instance'),
  stopInstance: (id, closeWechat) => ipcRenderer.invoke('wechat:stop-instance', id, closeWechat),
  callApi: (id, path, body, sourceId, timeout) => ipcRenderer.invoke('wechat:call-api', id, path, plainIpcValue(body ?? {}), sourceId, timeout),
  listEvents: (id) => ipcRenderer.invoke('wechat:list-events', id),
  listMemberJoins: (filters) => ipcRenderer.invoke('members:list-joins', plainIpcValue(filters || {})),
  listFriendAddStatuses: (targetKeys) => ipcRenderer.invoke('members:friend-statuses', plainIpcValue(targetKeys || [])),
  getChatAddRule: () => ipcRenderer.invoke('chatAdd:getRule'),
  saveChatAddRule: (rule) => ipcRenderer.invoke('chatAdd:saveRule', plainIpcValue(rule || {})),
  listChatAddCandidates: (filters) => ipcRenderer.invoke('chatAdd:listCandidates', plainIpcValue(filters || {})),
  clearChatAddCandidates: (filters) => ipcRenderer.invoke('chatAdd:clearCandidates', plainIpcValue(filters || {})),
  markChatAddCandidatesTasked: (ids) => ipcRenderer.invoke('chatAdd:markTasked', plainIpcValue(ids || [])),
  onChatAddCandidate: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('chat-add:candidate', handler); return () => ipcRenderer.removeListener('chat-add:candidate', handler) },
  onEvent: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('wechat:event', handler); return () => ipcRenderer.removeListener('wechat:event', handler) },
  onLog: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('wechat:log', handler); return () => ipcRenderer.removeListener('wechat:log', handler) },
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  taskItems: (id) => ipcRenderer.invoke('tasks:items', id),
  createTask: (payload) => ipcRenderer.invoke('tasks:create', plainIpcValue(payload)),
  confirmTask: (payload) => ipcRenderer.invoke('tasks:confirm', plainIpcValue(payload)),
  pauseTask: (id) => ipcRenderer.invoke('tasks:pause', id),
  resumeTask: (id) => ipcRenderer.invoke('tasks:resume', id),
  cancelTask: (id) => ipcRenderer.invoke('tasks:cancel', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (value) => ipcRenderer.invoke('settings:save', plainIpcValue(value)),
  cleanupKickedGroups: (payload) => ipcRenderer.invoke('kicked-groups:cleanup', plainIpcValue(payload || {})),
  listLogs: (limit) => ipcRenderer.invoke('logs:list', limit),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  reportError: (message, details) => ipcRenderer.invoke('app:report-error', String(message || ''), plainIpcValue(details || {})),
  syncDirectory: (payload) => ipcRenderer.invoke('directory:sync', plainIpcValue(payload)),
  listBlockedChatrooms: () => ipcRenderer.invoke('directory:list-blocked'),
  listBlockedRoomIds: (instanceIds) => ipcRenderer.invoke('directory:blocked-room-ids', plainIpcValue(instanceIds || [])),
  onBlockedDirectoryChanged: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('directory:blocked-changed', handler)
    return () => ipcRenderer.removeListener('directory:blocked-changed', handler)
  },
  listQrItems: () => ipcRenderer.invoke('qr:list'),
  importQrFiles: () => ipcRenderer.invoke('qr:import-files'),
  importQrLinks: (text) => ipcRenderer.invoke('qr:import-links', text),
  collectQrHistory: (payload) => ipcRenderer.invoke('qr:collect-history', plainIpcValue(payload)),
  previewQrInvites: (payload) => ipcRenderer.invoke('qr:preview-invites', plainIpcValue(payload)),
  onQrCollectProgress: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('qr:collect-progress', handler)
    return () => ipcRenderer.removeListener('qr:collect-progress', handler)
  },
  qrMonitorStatus: () => ipcRenderer.invoke('qr:monitor-status'),
  startQrMonitor: (payload) => ipcRenderer.invoke('qr:monitor-start', plainIpcValue(payload)),
  stopQrMonitor: () => ipcRenderer.invoke('qr:monitor-stop'),
  syncQrMonitorRooms: () => ipcRenderer.invoke('qr:monitor-sync'),
  onQrMonitorResult: (listener) => { const handler = (_event, payload) => listener(payload); ipcRenderer.on('qr:monitor-result', handler); return () => ipcRenderer.removeListener('qr:monitor-result', handler) },
  onQrMonitorRoomsChanged: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('qr:monitor-rooms-changed', handler)
    return () => ipcRenderer.removeListener('qr:monitor-rooms-changed', handler)
  },
  deleteQrItems: (ids) => ipcRenderer.invoke('qr:delete', plainIpcValue(ids)),
  updateQrItemType: (payload) => ipcRenderer.invoke('qr:update-type', plainIpcValue(payload)),
  selectImage: () => ipcRenderer.invoke('files:select-image'),
  pasteImage: () => ipcRenderer.invoke('files:paste-image'),
  selectDirectory: (defaultPath) => ipcRenderer.invoke('files:select-directory', defaultPath),
  revealInFolder: (targetPath) => ipcRenderer.invoke('files:reveal-in-folder', targetPath),
  selectWeixinExecutable: (defaultPath) => ipcRenderer.invoke('files:select-weixin', defaultPath),
  detectWeixinInstall: () => ipcRenderer.invoke('weixin:detect'),
  checkClientUpdate: () => ipcRenderer.invoke('update:check'),
  applyClientUpdate: () => ipcRenderer.invoke('update:apply'),
  markStartupUpdateDone: () => ipcRenderer.invoke('update:mark-done'),
  onUpdateStartupCheck: (listener) => {
    const handler = () => listener()
    ipcRenderer.on('update:startup-check', handler)
    return () => ipcRenderer.removeListener('update:startup-check', handler)
  },
  onUpdateProgress: (listener) => {
    const handler = (_event, payload) => listener(payload)
    ipcRenderer.on('update:progress', handler)
    return () => ipcRenderer.removeListener('update:progress', handler)
  },
})
