const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8')

test('desktop requires a software account and removes the global refresh button', () => {
  const router = read('src/router/index.ts')
  const layout = read('src/layout/MainLayout.vue')
  assert.match(router, /path: '\/login'/)
  assert.match(router, /path: '\/register'/)
  assert.match(router, /beforeEach/)
  assert.doesNotMatch(layout, /router\.go\(0\)|>刷新<|\bRefresh\b/)
  assert.match(layout, /authState\.account\?\.username/)
  assert.match(layout, /退出登录/)
})

test('account credentials stay in Electron main process', () => {
  const preload = read('electron/preload.cjs')
  const auth = read('electron/software-auth.cjs')
  assert.match(auth, /safeStorage\.encryptString/)
  assert.doesNotMatch(preload, /token\s*:/)
  assert.match(preload, /auth:login/)
})
