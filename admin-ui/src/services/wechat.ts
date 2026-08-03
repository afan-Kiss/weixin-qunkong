import { userErrorMessage } from '../utils/error'

export interface WechatInstance {
  id: string
  apiPort: number
  tcpPort: number
  pid?: number
  accountWxid?: string
  nickname?: string
  avatar?: string
  status: 'STOPPED' | 'RESTORING' | 'STARTING' | 'WAITING_LOGIN' | 'ONLINE' | 'ERROR'
  managed?: boolean
}

export interface ApiResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  sourceId?: number
  contractStatus?: string
  raw?: unknown
}

const instances = new Map<string, WechatInstance>()
let nextId = 1

function pickPorts() {
  const used = new Set([...instances.values()].flatMap((item) => [item.apiPort, item.tcpPort]))
  let apiPort = 19088
  while (used.has(apiPort)) apiPort += 2
  let tcpPort = 61108
  while (used.has(tcpPort) || tcpPort === apiPort) tcpPort += 2
  return { apiPort, tcpPort }
}

export async function listInstances(): Promise<WechatInstance[]> {
  if (window.wxControl?.listInstances) return window.wxControl.listInstances()
  return [...instances.values()]
}

export async function startInstance(): Promise<ApiResult<WechatInstance>> {
  if (window.wxControl?.startInstance) return window.wxControl.startInstance()
  const ports = pickPorts()
  const instance: WechatInstance = { id: `instance-${nextId++}`, ...ports, status: 'STARTING' }
  instances.set(instance.id, instance)
  return { ok: true, data: instance }
}

export async function stopInstance(id: string, closeWechat = true): Promise<ApiResult<{ closedWechat: boolean }>> {
  if (window.wxControl?.stopInstance) return window.wxControl.stopInstance(id, closeWechat)
  instances.delete(id)
  return { ok: true, data: { closedWechat: false } }
}

export async function callWechat<T>(instance: WechatInstance, path: string, body?: unknown, sourceId?: number, timeoutMs = 30000): Promise<ApiResult<T>> {
  if (window.wxControl?.callApi) return window.wxControl.callApi(instance.id, path, body, sourceId, timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${instance.apiPort}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })
    const raw = await response.json()
    return { ok: response.ok, data: raw as T, raw, sourceId, contractStatus: 'RESPONSE_VERIFY' }
  } catch (error) {
    return { ok: false, error: userErrorMessage(error, '微信操作失败'), sourceId, contractStatus: 'RESPONSE_VERIFY' }
  }
}
