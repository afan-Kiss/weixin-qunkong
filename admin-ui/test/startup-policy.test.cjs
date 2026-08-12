const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, existsSync } = require('node:fs')
const path = require('node:path')

test('app startup shows UI before restoring WeChat sessions', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const readyBlock = source.slice(source.indexOf('app.whenReady()'), source.indexOf("app.on('window-all-closed'"))

  assert.ok(readyBlock.includes('createWindow()'))
  assert.ok(readyBlock.includes('createTray()'))
  // 首次 focus 仅由 ready-to-show 负责，whenReady 内不再调用 showMainWindow 抢焦点
  assert.equal(/\bshowMainWindow\s*\(/.test(readyBlock), false)
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
  assert.match(source, /function createSplashWindow\(/)
  assert.match(source, /function setSplashProgress\(/)
  assert.match(source, /function closeSplashWindow\(/)
  assert.match(source, /SPLASH_PROGRESS_BY_LABEL/)
  assert.ok(readyBlock.indexOf('createSplashWindow()') < readyBlock.indexOf('initStorage('))
  assert.match(source, /ready-to-show[\s\S]*closeSplashWindow\(\)[\s\S]*win\.show\(\)\s*\n\s*win\.focus\(\)/)
  assert.equal(existsSync(path.join(__dirname, '..', 'electron', 'splash.html')), true)
  const splashHtml = readFileSync(path.join(__dirname, '..', 'electron', 'splash.html'), 'utf8')
  assert.match(splashHtml, /id="spinner"/)
  assert.match(splashHtml, /getContext\('2d'\)|getContext\("2d"\)/)
  assert.match(splashHtml, /role="progressbar"/)
  assert.match(splashHtml, /window\.__setProgress/)
  assert.match(source, /show:\s*true/)
  assert.match(source, /setAlwaysOnTop\(true,\s*'screen-saver'\)/)
  assert.doesNotMatch(source, /setTimeout\(\s*\(\)\s*=>\s*\{?\s*closeSplashWindow/)
  // 非首屏任务延迟到 createWindow 之后
  assert.ok(readyBlock.indexOf('createWindow()') < readyBlock.indexOf('scrubLegacyCachesOnStartup('))
  assert.ok(readyBlock.indexOf('createWindow()') < readyBlock.indexOf('recoverInterruptedTasks()'))
  assert.ok(readyBlock.indexOf('createWindow()') < readyBlock.indexOf('loadApiContracts()'))
  assert.ok(readyBlock.indexOf('createWindow()') < readyBlock.indexOf('createTray()'))
  assert.match(source, /\[STARTUP\]/)
  assert.match(source, /function markStartup\(/)
})

test('application uses an operating system single-instance lock', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(source, /app\.requestSingleInstanceLock\(\)/)
  assert.match(source, /if \(!hasSingleInstanceLock\) \{\s*app\.quit\(\)/)
  assert.match(source, /app\.on\('second-instance'/)
  assert.match(source, /activateMainWindow\(\)/)
  assert.match(source, /shouldActivateOnSecondInstance/)
  assert.match(source, /\[WINDOW\] second-instance/)
})

test('portable package uses splashImage, useZip, and trimmed electronLanguages', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.equal(pkg.build?.portable?.useZip, true)
  assert.match(String(pkg.build?.portable?.splashImage || ''), /portable-splash\.bmp$/)
  assert.deepEqual(pkg.build?.electronLanguages, ['zh-CN', 'en-US'])
  assert.equal(existsSync(path.join(__dirname, '..', 'build', 'portable-splash.bmp')), true)
})
