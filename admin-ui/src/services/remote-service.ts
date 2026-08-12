/**
 * Remote maintenance service (MeshCentral).
 * Vue only triggers IPC; embed URLs with login tokens stay in Electron main.
 */

export interface RemoteStatus {
  ok: boolean
  code?: string
  message?: string
  clientId?: string
  status?: string
  bound?: boolean
  meshNodeId?: string
  meshAgentStatus?: string
  meshLastSeen?: string
  version?: string
  localAgent?: {
    installed?: boolean
    running?: boolean
    status?: string
    version?: string
  }
  raw?: Record<string, unknown>
}

export interface RemoteService {
  getStatus(clientId: string): Promise<RemoteStatus>
  openDesktop(clientId: string): Promise<void>
  openFiles(clientId: string): Promise<void>
  closeSession(): Promise<void>
}

type RemoteIpc = {
  remoteGetStatus?: (clientId: string) => Promise<RemoteStatus>
  remoteOpenDesktop?: (clientId: string) => Promise<{ ok?: boolean; message?: string; code?: string }>
  remoteOpenFiles?: (clientId: string) => Promise<{ ok?: boolean; message?: string; code?: string }>
  remoteCloseSession?: () => Promise<{ ok?: boolean; message?: string }>
}

function ipc(): RemoteIpc {
  return (window.wxControl || {}) as RemoteIpc
}

function normalizeStatus(clientId: string, value: unknown): RemoteStatus {
  const row = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const mapping = (row.mapping && typeof row.mapping === 'object' ? row.mapping : {}) as Record<string, unknown>
  return {
    ok: Boolean(row.ok ?? true),
    code: String(row.code || ''),
    message: String(row.message || ''),
    clientId: String(row.clientId || clientId),
    status: String(row.status || mapping.mesh_agent_status || (row.bound ? 'bound' : 'unknown')),
    bound: Boolean(row.bound ?? mapping.mesh_node_id),
    meshNodeId: String(row.meshNodeId || mapping.mesh_node_id || ''),
    meshAgentStatus: String(row.meshAgentStatus || mapping.mesh_agent_status || ''),
    meshLastSeen: String(row.meshLastSeen || mapping.mesh_last_seen || ''),
    version: String(row.version || ''),
    localAgent: (row.localAgent && typeof row.localAgent === 'object'
      ? row.localAgent
      : undefined) as RemoteStatus['localAgent'],
    raw: row,
  }
}

export const remoteService: RemoteService = {
  async getStatus(clientId: string): Promise<RemoteStatus> {
    const id = String(clientId || '').trim()
    if (!id) {
      return { ok: false, code: 'BAD_REQUEST', message: 'clientId 必填', clientId: '' }
    }
    const fn = ipc().remoteGetStatus
    if (!fn) {
      return {
        ok: false,
        code: 'IPC_UNAVAILABLE',
        message: '远程维护 IPC 未接线（见 MESH_WIRING.md）',
        clientId: id,
      }
    }
    try {
      return normalizeStatus(id, await fn(id))
    } catch (err) {
      return {
        ok: false,
        code: 'IPC_ERROR',
        message: err instanceof Error ? err.message : String(err),
        clientId: id,
      }
    }
  },

  async openDesktop(clientId: string): Promise<void> {
    const id = String(clientId || '').trim()
    if (!id) throw new Error('clientId 必填')
    const fn = ipc().remoteOpenDesktop
    if (!fn) throw new Error('远程桌面 IPC 未接线（见 MESH_WIRING.md）')
    const result = await fn(id)
    if (result && result.ok === false) {
      throw new Error(String(result.message || result.code || '打开远程桌面失败'))
    }
  },

  async openFiles(clientId: string): Promise<void> {
    const id = String(clientId || '').trim()
    if (!id) throw new Error('clientId 必填')
    const fn = ipc().remoteOpenFiles
    if (!fn) throw new Error('文件管理 IPC 未接线（见 MESH_WIRING.md）')
    const result = await fn(id)
    if (result && result.ok === false) {
      throw new Error(String(result.message || result.code || '打开文件管理失败'))
    }
  },

  async closeSession(): Promise<void> {
    const fn = ipc().remoteCloseSession
    if (!fn) return
    await fn()
  },
}

export default remoteService
