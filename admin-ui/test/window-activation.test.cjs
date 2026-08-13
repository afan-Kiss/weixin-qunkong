const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const {
  SECOND_INSTANCE_FOCUS_COOLDOWN_MS,
  createSecondInstanceGate,
  shouldActivateOnSecondInstance,
} = require('../electron/window-activation.cjs')

test('second-instance gate accepts first focus then cools down', () => {
  const gate = createSecondInstanceGate(1500)
  assert.equal(gate.tryAccept(1000), true)
  assert.equal(gate.tryAccept(1001), false)
  assert.equal(gate.tryAccept(2499), false)
  assert.equal(gate.tryAccept(2500), true)
  assert.equal(gate.tryAccept(2501), false)
})

test('second-instance does not activate before app ready (cold start / portable delay)', () => {
  const gate = createSecondInstanceGate(1500)
  assert.equal(shouldActivateOnSecondInstance({ appReady: false, gate, now: 1 }), false)
  assert.equal(gate.tryAccept(1), true) // gate itself unused when not ready
  assert.equal(shouldActivateOnSecondInstance({ appReady: true, gate, now: 2 }), false) // still in cooldown from above
  gate.reset()
  assert.equal(shouldActivateOnSecondInstance({ appReady: true, gate, now: 10 }), true)
  assert.equal(shouldActivateOnSecondInstance({ appReady: true, gate, now: 11 }), false)
})

test('second-instance waits until first ready-to-show before activating', () => {
  const gate = createSecondInstanceGate(1500)
  assert.equal(shouldActivateOnSecondInstance({
    appReady: true,
    firstShowDone: false,
    gate,
    now: 100,
  }), false)
  assert.equal(gate.tryAccept(100), true) // not consumed while firstShowDone=false
  assert.equal(shouldActivateOnSecondInstance({
    appReady: true,
    firstShowDone: true,
    gate,
    now: 200,
  }), false) // cooldown from explicit tryAccept above
  gate.reset()
  assert.equal(shouldActivateOnSecondInstance({
    appReady: true,
    firstShowDone: true,
    gate,
    now: 300,
  }), true)
})

test('portable rapid double-clicks only activate once within cooldown', () => {
  const gate = createSecondInstanceGate(SECOND_INSTANCE_FOCUS_COOLDOWN_MS)
  const times = [100, 200, 350, 500, 900]
  const accepted = times.filter((t) => shouldActivateOnSecondInstance({ appReady: true, gate, now: t }))
  assert.deepEqual(accepted, [100])
})

test('main window activation policy: no alwaysOnTop, split show/activate, first focus only via ready-to-show', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const readyBlock = source.slice(source.indexOf('app.whenReady()'), source.indexOf("app.on('window-all-closed'"))

  assert.match(source, /function showMainWindow\(opts = \{\}\)/)
  assert.match(source, /function activateMainWindow\(\)/)
  assert.match(source, /showMainWindow\(\{ focus: true \}\)/)
  // Splash 可用 alwaysOnTop；主窗口仅在用户激活（二次启动/托盘）时短暂置顶再清除
  assert.match(source, /function createSplashWindow[\s\S]*?setAlwaysOnTop\(true/)
  assert.match(source, /function showMainWindow[\s\S]*?setAlwaysOnTop\(true\)[\s\S]*?setAlwaysOnTop\(false\)/)
  assert.doesNotMatch(source, /ready-to-show[\s\S]{0,400}?setAlwaysOnTop/)
  assert.match(source, /\[WINDOW\] second-instance/)
  assert.match(source, /shouldActivateOnSecondInstance/)
  assert.match(source, /mainWindowFirstShowDone/)
  assert.match(source, /SECOND_INSTANCE_FOCUS_COOLDOWN_MS|createSecondInstanceGate/)

  // 启动路径：createWindow 后延迟 createTray；不再二次 showMainWindow 抢焦点
  assert.ok(readyBlock.includes('createWindow()'))
  assert.ok(readyBlock.includes('createTray()'))
  assert.ok(readyBlock.indexOf('createWindow()') < readyBlock.indexOf('createTray()'))
  assert.equal(/\bshowMainWindow\s*\(/.test(readyBlock), false)
  assert.equal(/\bactivateMainWindow\s*\(/.test(readyBlock.replace(/if \(process\.platform === 'darwin'\)[\s\S]*?activateMainWindow\(\)/, '')), false)

  // ready-to-show 是唯一首次 focus；兜底 timeout 只 show
  assert.match(source, /ready-to-show[\s\S]*?win\.show\(\)\s*\n\s*win\.focus\(\)/)
  const fallback = source.slice(source.indexOf('防止 ready-to-show'), source.indexOf('function showMainWindow'))
  assert.match(fallback, /win\.show\(\)/)
  assert.doesNotMatch(fallback, /win\.focus\(\)/)

  // 托盘用户操作可 activate
  assert.match(source, /label: '显示主界面',\s*click: \(\) => activateMainWindow\(\)/)
  assert.match(source, /tray\.on\('double-click',\s*\(\) => activateMainWindow\(\)\)/)

  // activate 仅 darwin
  assert.match(source, /if \(process\.platform === 'darwin'\)\s*\{\s*app\.on\('activate'/)
  assert.doesNotMatch(readyBlock, /app\.on\('activate',\s*\(\)\s*=>\s*\{\s*showMainWindow/)

  // 后台策略/公告不得用 parent 主窗口对话框抢前台
  assert.match(source, /function notifyWithoutFocus/)
  assert.match(source, /new Notification/)
  assert.doesNotMatch(source, /dialog\.showMessageBox\(mainWindow,\s*\{\s*type:\s*'warning',\s*title:\s*'软件已暂停'/)
  assert.doesNotMatch(source, /onAnnouncement:[\s\S]*?dialog\.showMessageBox\(mainWindow/)
})

test('silent client mesh bridge has no embed BrowserWindow', () => {
  const bridge = readFileSync(path.join(__dirname, '..', 'electron', 'mesh-remote-bridge.cjs'), 'utf8')
  assert.doesNotMatch(bridge, /BrowserWindow/)
  assert.doesNotMatch(bridge, /openEmbedWindow|openDesktopSession|openFilesSession/)
  assert.match(bridge, /ensureLocalMeshAgent|ensureMeshReady/)
  assert.match(bridge, /ensureLocalMeshAgent/)
})
