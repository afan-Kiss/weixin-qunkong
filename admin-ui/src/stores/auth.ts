import { reactive } from 'vue'

export interface SoftwareAccount { id: string; username: string }

export const authState = reactive<{ ready: boolean; account: SoftwareAccount | null }>({ ready: false, account: null })
let initializing: Promise<SoftwareAccount | null> | null = null

export function ensureSession(force = false) {
  if (!force && authState.ready) return Promise.resolve(authState.account)
  if (initializing) return initializing
  initializing = (window.wxControl?.authSession?.() ?? Promise.resolve(null))
    .then((account) => { authState.account = account; authState.ready = true; return account })
    .catch(() => { authState.account = null; authState.ready = true; return null })
    .finally(() => { initializing = null })
  return initializing
}

/**
 * 登录软件账号。
 * @param username 用户名
 * @param password 密码
 * @returns 登录成功后的账号信息
 * @throws 桥接未就绪或服务端返回失败时抛出可读错误
 */
export async function login(username: string, password: string) {
  const bridge = window.wxControl
  if (!bridge?.authLogin) throw new Error('客户端桥接未就绪，请完全退出后重新打开软件（不要用浏览器打开页面）')
  const result = await bridge.authLogin(username, password)
  if (!result.ok || !result.account) throw new Error(result.error || '登录失败，请稍后重试')
  const account = result.account
  authState.account = account; authState.ready = true
  return account
}

/**
 * 注册并登录软件账号。
 * @param username 用户名
 * @param password 密码
 * @returns 注册成功后的账号信息
 * @throws 桥接未就绪或服务端返回失败时抛出可读错误
 */
export async function register(username: string, password: string) {
  const bridge = window.wxControl
  if (!bridge?.authRegister) throw new Error('客户端桥接未就绪，请完全退出后重新打开软件（不要用浏览器打开页面）')
  const result = await bridge.authRegister(username, password)
  if (!result.ok || !result.account) throw new Error(result.error || '注册失败，请稍后重试')
  const account = result.account
  authState.account = account; authState.ready = true
  return account
}

export async function logout() {
  await window.wxControl?.authLogout?.()
  authState.account = null; authState.ready = true
}
