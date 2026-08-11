const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('app startup shows UI before restoring WeChat sessions', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const readyBlock = source.slice(source.indexOf('app.whenReady()'), source.indexOf("app.on('window-all-closed'"))

  assert.ok(readyBlock.includes('createWindow()'))
  assert.ok(readyBlock.includes('showMainWindow()'))
  assert.ok(readyBlock.includes('restoreInstancesThenResumeQueuedTasks()') || readyBlock.includes('restoreInstances()'))
  // 先显示界面，再恢复实例，避免卡在网络/微信探测导致“有进程无窗口”
  const restorePos = Math.min(
    ...['restoreInstancesThenResumeQueuedTasks()', 'restoreInstances()']
      .map((token) => readyBlock.indexOf(token))
      .filter((i) => i >= 0),
  )
  assert.ok(readyBlock.indexOf('createWindow()') < restorePos)
  assert.ok(readyBlock.includes('resumeQueuedTasks') || readyBlock.includes('restoreInstancesThenResumeQueuedTasks'))
  assert.equal(readyBlock.includes('enqueueWechatInstanceStart()'), false)
  assert.doesNotMatch(source, /autoStart/)
  assert.match(source, /disableHardwareAcceleration/)
  assert.match(source, /fitWindowBounds/)
  assert.match(source, /function createSplashWindow\(\)/)
  assert.match(source, /正在启动，请稍候/)
  assert.ok(readyBlock.indexOf('createSplashWindow()') < readyBlock.indexOf('initStorage('))
  assert.match(source, /ready-to-show[\s\S]*closeSplashWindow\(\)/)
})

test('application uses an operating system single-instance lock', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(source, /app\.requestSingleInstanceLock\(\)/)
  assert.match(source, /if \(!hasSingleInstanceLock\) \{\s*app\.quit\(\)/)
  assert.match(source, /app\.on\('second-instance'/)
  assert.match(source, /showMainWindow\(\)/)
})
