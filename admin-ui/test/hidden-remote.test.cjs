const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('remote UI is silent in client; MeshAgent remains in main', () => {
  const root = path.join(__dirname, '..')
  const main = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preload = readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const router = readFileSync(path.join(root, 'src', 'router', 'index.ts'), 'utf8')
  const layout = readFileSync(path.join(root, 'src', 'layout', 'MainLayout.vue'), 'utf8')

  // Silent: no remote menu / page / renderer IPC
  assert.doesNotMatch(layout, /远程维护|远程桌面|remote-support|Connection/)
  assert.match(router, /remote-support[\s\S]*redirect:\s*['"]\/dashboard['"]/)
  assert.doesNotMatch(preload, /remoteOpenDesktop|remoteOpenFiles|remoteGetStatus|mesh:open-desktop/)

  // Agent ensure stays in main (no WebRTC stack, no session BrowserWindow)
  assert.match(main, /ensureLocalMeshAgent|ensureMeshReady|mesh-remote-bridge/)
  assert.match(main, /mesh:agent-ensure/)
  assert.doesNotMatch(main, /mesh:open-desktop|mesh:open-files/)
  assert.doesNotMatch(main, /webrtc-desktop|win-input|desktopCapturer/)
})
