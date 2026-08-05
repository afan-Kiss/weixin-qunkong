const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('remote management stays active in main process but has no visible route, menu, or preload API', () => {
  const root = path.join(__dirname, '..')
  const main = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preload = readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const router = readFileSync(path.join(root, 'src', 'router', 'index.ts'), 'utf8')
  const layout = readFileSync(path.join(root, 'src', 'layout', 'MainLayout.vue'), 'utf8')

  assert.match(main, /startRemoteAgent\(/)
  assert.match(main, /remote:start/)
  assert.doesNotMatch(preload, /remoteStart|remoteStop|openRemoteConsole|remoteStatus/)
  assert.doesNotMatch(router, /remote-desktop|RemoteDesktop/)
  assert.doesNotMatch(layout, /远程桌面|后台地址|云端后台/)
})
