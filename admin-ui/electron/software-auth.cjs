const { safeStorage } = require('electron')
const { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } = require('fs')
const path = require('path')
const { getServiceBase } = require('./secure-config.cjs')

const DEFAULT_AUTH_BASE = getServiceBase()
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
  const http = require('http')
  const https = require('https')
  const { insecureTlsForService } = require('./service-tls.cjs')
  const target = `${DEFAULT_AUTH_BASE}${endpoint}`
  const u = new URL(target)
  const lib = u.protocol === 'https:' ? https : http
  const method = String(options.method || 'GET').toUpperCase()
  const body = options.body != null ? String(options.body) : ''
  let response
  try {
    response = await new Promise((resolve, reject) => {
      const req = lib.request(target, {
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
        timeout: 12000,
        ...insecureTlsForService(u.hostname),
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let data = {}
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { data = {} }
          resolve({ ok: (res.statusCode || 0) < 400, status: res.statusCode || 0, data })
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
      if (body) req.write(body)
      req.end()
    })
  } catch { throw new Error('暂时无法连接账号服务，请检查网络后重试') }
  const data = response.data || {}
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
  const http = require('http')
  const https = require('https')
  const { insecureTlsForService } = require('./service-tls.cjs')
  let response
  try {
    const target = `${DEFAULT_AUTH_BASE}/api/software-auth/session`
    const u = new URL(target)
    const lib = u.protocol === 'https:' ? https : http
    response = await new Promise((resolve, reject) => {
      const req = lib.request(target, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        timeout: 4000,
        ...insecureTlsForService(u.hostname),
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          let data = {}
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { data = {} }
          resolve({ ok: (res.statusCode || 0) < 400, status: res.statusCode || 0, data })
        })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('timeout')); reject(new Error('timeout')) })
      req.end()
    })
  } catch {
    // 网络抖动保留本地登录态，避免误登出
    return null
  }
  const data = response.data || {}
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
