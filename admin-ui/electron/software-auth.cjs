const { safeStorage } = require('electron')
const { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } = require('fs')
const path = require('path')

const DEFAULT_AUTH_BASE = 'https://xiangyuzhubao.xyz/wxqk'
let token = ''
let file = ''

function initSoftwareAuth(userDataDir) {
  file = path.join(userDataDir, 'account-session.bin')
  if (!existsSync(file)) return
  try {
    const saved = readFileSync(file)
    token = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(saved) : ''
  } catch { token = '' }
}

function saveToken(value) {
  token = String(value || '')
  if (!file) return
  try {
    if (!token) { if (existsSync(file)) unlinkSync(file); return }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('当前系统无法安全保存登录状态，请重新登录')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, safeStorage.encryptString(token))
  } catch (error) { token = ''; throw error }
}

async function request(endpoint, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) }
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try { response = await fetch(`${DEFAULT_AUTH_BASE}${endpoint}`, { ...options, headers, signal: AbortSignal.timeout(12000) }) }
  catch { throw new Error('暂时无法连接账号服务，请检查网络后重试') }
  let data = {}
  try { data = await response.json() } catch {}
  if (!response.ok || data.ok === false) throw new Error(data.message || '账号服务暂时不可用')
  return data
}

async function login(username, password) {
  const data = await request('/api/software-auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
  saveToken(data.token)
  return data.account
}

async function register(username, password) {
  const data = await request('/api/software-auth/register', { method: 'POST', body: JSON.stringify({ username, password }) })
  saveToken(data.token)
  return data.account
}

async function session() {
  if (!token) return null
  let response
  try {
    // 启动路径调用：缩短超时，避免弱网把恢复实例拖到十几秒
    response = await fetch(`${DEFAULT_AUTH_BASE}/api/software-auth/session`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    })
  } catch {
    // 网络抖动保留本地登录态，避免误登出
    return null
  }
  let data = {}
  try { data = await response.json() } catch {}
  if (response.status === 401 || data.ok === false) {
    try { saveToken('') } catch {}
    return null
  }
  if (!response.ok) return null
  return data.account || null
}

async function logout() {
  try { if (token) await request('/api/software-auth/logout', { method: 'POST', body: '{}' }) } catch {}
  saveToken('')
}

module.exports = { initSoftwareAuth, login, register, session, logout, DEFAULT_AUTH_BASE }
