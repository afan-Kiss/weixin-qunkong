const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('app startup shows UI before restoring WeChat sessions', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const readyBlock = source.slice(source.indexOf('app.whenReady()'), source.indexOf("app.on('window-all-closed'"))

  assert.ok(readyBlock.includes('createWindow()'))
  assert.ok(readyBlock.includes('showMainWindow()'))
  assert.ok(readyBlock.includes('restoreInstances()'))
  // 先显示界面，再恢复实例，避免卡在网络/微信探测导致“有进程无窗口”
  assert.ok(readyBlock.indexOf('createWindow()') < readyBlock.indexOf('restoreInstances()'))
  assert.equal(readyBlock.includes('enqueueWechatInstanceStart()'), false)
  assert.doesNotMatch(source, /autoStart/)
  assert.match(source, /disableHardwareAcceleration/)
  assert.match(source, /fitWindowBounds/)
})

test('application uses an operating system single-instance lock', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(source, /app\.requestSingleInstanceLock\(\)/)
  assert.match(source, /if \(!hasSingleInstanceLock\) \{\s*app\.quit\(\)/)
  assert.match(source, /app\.on\('second-instance'/)
  assert.match(source, /showMainWindow\(\)/)
})
