import type { ApiResult, WechatInstance } from '../services/wechat'

declare global {
  interface Window {
    wxControl?: {
      authSession: () => Promise<{ id: string; username: string } | null>
      authLogin: (username: string, password: string) => Promise<{ ok: boolean; account?: { id: string; username: string }; error?: string }>
      authRegister: (username: string, password: string) => Promise<{ ok: boolean; account?: { id: string; username: string }; error?: string }>
      authLogout: () => Promise<boolean>
      systemMetrics: () => Promise<{ uptimeSeconds: number; cpuPercent: number; memoryBytes: number; diskBytes: number; processCount: number; measuredAt: string }>
      listInstances: () => Promise<WechatInstance[]>
      startInstance: () => Promise<ApiResult<WechatInstance>>
      stopInstance: (id: string, closeWechat?: boolean) => Promise<ApiResult<{ closedWechat: boolean }>>
      callApi: <T = unknown>(id: string, path: string, body?: unknown, sourceId?: number, timeoutMs?: number) => Promise<ApiResult<T>>
      listEvents: (id: string) => Promise<Array<{ time: string; data: unknown }>>
      listMemberJoins: (filters?: { instanceIds?: string[]; roomIds?: string[]; limit?: number; sinceHours?: number }) => Promise<Array<{ id: number; instanceId: string; roomId: string; wxid: string; nickname: string; avatar: string; inviter: string; source: string; joinAt: string }>>
      listFriendAddStatuses: (targetKeys: Array<string | { instanceId: string; targetKey: string }>) => Promise<Record<string, { status: string; error: string; taskStatus: string; updatedAt: string }>>
      getChatAddRule: () => Promise<{ enabled: boolean; instanceId: string; accountWxid?: string; roomIds: string[]; keywords: string[]; excludeText: string; updatedAt: string }>
      saveChatAddRule: (rule: unknown) => Promise<{ enabled: boolean; instanceId: string; accountWxid?: string; roomIds: string[]; keywords: string[]; excludeText: string; updatedAt: string }>
      listChatAddCandidates: (filters?: { status?: string; instanceId?: string; roomIds?: string[]; since?: string; limit?: number }) => Promise<Array<{ id: number; instanceId: string; roomId: string; senderWxid: string; nickname: string; messagePreview: string; matchedKeyword: string; status: string; createdAt: string }>>
      clearChatAddCandidates: (filters?: { status?: string }) => Promise<number>
      markChatAddCandidatesTasked: (ids: number[]) => Promise<number>
      onChatAddCandidate: (listener: (payload: { instanceId: string; candidateId?: number; hit?: unknown }) => void) => () => void
      onEvent: (listener: (payload: { instanceId: string; event: unknown }) => void) => () => void
      onLog: (listener: (payload: unknown) => void) => () => void
      listTasks: () => Promise<unknown[]>
      taskItems: (id: string) => Promise<unknown[]>
      createTask: (payload: unknown) => Promise<unknown>
      confirmTask: (payload: string | { id: string; intervalMs: number }) => Promise<boolean>
      pauseTask: (id: string) => Promise<boolean>
      resumeTask: (id: string) => Promise<boolean>
      cancelTask: (id: string) => Promise<boolean>
      getSettings: () => Promise<Record<string, unknown>>
      saveSettings: (value: unknown) => Promise<Record<string, unknown>>
      listLogs: (limit?: number) => Promise<unknown[]>
      clearLogs: () => Promise<boolean>
      reportError: (message: string, details?: Record<string, unknown>) => Promise<boolean>
      syncDirectory: (payload: unknown) => Promise<boolean>
      listBlockedChatrooms: () => Promise<Array<{ accountWxid: string; roomId: string; roomName: string; reason: string; evidence: string; sourceInstanceId: string; createdAt: string; updatedAt: string }>>
      listBlockedRoomIds: (instanceIds: string[]) => Promise<Record<string, string[]>>
      onBlockedDirectoryChanged: (listener: (payload: { instanceId: string; roomId: string; roomName?: string; action?: 'exclude' | 'restore' }) => void) => () => void
      listQrItems: () => Promise<unknown[]>
      importQrFiles: () => Promise<unknown[]>
      importQrLinks: (text: string) => Promise<unknown[]>
      collectQrHistory: (payload: { rooms: Array<{ instanceId: string; roomId: string; name: string }>; outputDir: string; folder: string; maxImages?: number }) => Promise<{ groups: number; checked: number; saved: number; duplicates: number; expired: number; nonQr: number; unavailable: number; skippedGroups?: number; records?: unknown[] }>
      previewQrInvites: (payload: { instanceId: string; urls: string[] }) => Promise<Array<{ url: string; qrType?: string; roomId: string; roomName: string; memberCount: number; fullUrl: string; expired: boolean; label: string; error?: string; notice?: string }>>
      onQrCollectProgress: (listener: (payload: { phase?: string; roomName?: string; roomIndex?: number; roomTotal?: number; checked?: number; total?: number; saved?: number }) => void) => () => void
      qrMonitorStatus: () => Promise<{ enabled: boolean; watchAll?: boolean; rooms: Array<{ instanceId: string; roomId: string; name: string }>; outputDir: string; folder: string; watchedCount?: number; queueStats?: Array<{ instanceId: string; active: number; pending: number }> }>
      startQrMonitor: (payload: { rooms: Array<{ instanceId: string; roomId: string; name: string }>; outputDir: string; folder: string; watchAll?: boolean }) => Promise<{ enabled: boolean; watchAll?: boolean; watchedCount?: number }>
      stopQrMonitor: () => Promise<{ enabled: boolean }>
      syncQrMonitorRooms: () => Promise<{ enabled: boolean; watchAll?: boolean; rooms: Array<{ instanceId: string; roomId: string; name: string }>; watchedCount?: number }>
      onQrMonitorResult: (listener: (payload: { roomName: string; detected: number; saved: number; duplicates: number; expired?: number }) => void) => () => void
      onQrMonitorRoomsChanged: (listener: (payload: { enabled: boolean; watchAll?: boolean; watchedCount: number; rooms: Array<{ instanceId: string; roomId: string; name: string }>; added?: Array<{ instanceId: string; roomId: string; name: string }>; reason?: string }) => void) => () => void
      deleteQrItems: (ids: string[]) => Promise<unknown[]>
      updateQrItemType: (payload: { id: string; qrType: string }) => Promise<{ ok: boolean; items: unknown[] }>
      selectImage: () => Promise<string>
      pasteImage: () => Promise<{ ok: boolean; path?: string; dataUrl?: string; error?: string }>
      selectDirectory: (defaultPath?: string) => Promise<string>
      revealInFolder: (targetPath: string) => Promise<{ ok: boolean; message?: string }>
      selectWeixinExecutable: (defaultPath?: string) => Promise<string>
      detectWeixinInstall: () => Promise<{ exePath: string; version: string; source: string; candidates: Array<{ exePath: string; version: string; source: string }> }>
      cleanupKickedGroups: (payload?: { instanceId?: string }) => Promise<{
        ok: boolean
        queued?: boolean
        taskId?: string
        instanceId?: string
        online?: number
        rebound?: number
        pending?: number
        historyDiscovered?: number
        cleaned?: number
        skippedActive?: number
        message?: string
      }>
      checkClientUpdate: () => Promise<{
        ok: boolean
        needUpdate: boolean
        deferred?: boolean
        canApply?: boolean
        latestVersion?: string
        latestBuildId?: string
        fileName?: string
        fileSize?: number
        message?: string
        code?: string
      }>
      applyClientUpdate: () => Promise<{ ok: boolean; message?: string; deferred?: boolean }>
      markStartupUpdateDone: () => Promise<boolean>
      onUpdateStartupCheck: (listener: () => void) => () => void
      onUpdateProgress: (listener: (payload: {
        phase?: string
        downloaded?: number
        total?: number
        percent?: number
        message?: string
      }) => void) => () => void
    }
  }
}
export {}
