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

test('cold boot starts local Mesh prepare without softwareAuth.session', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const readyBlock = source.slice(source.indexOf('app.whenReady()'), source.indexOf("app.on('window-all-closed'"))

  assert.match(source, /function startLocalMeshPrepareOnStartup/)
  assert.match(source, /function getOrCreateLocalDeviceIdentity/)
  assert.match(source, /function resolveLocalClientId/)
  assert.match(source, /loadOrCreate/)
  assert.match(source, /\[MESH-BOOT\]/)

  // Mesh prepare must run on cold boot — not gated by account session
  assert.ok(readyBlock.includes("startLocalMeshPrepareOnStartup('cold_boot')"))
  assert.ok(readyBlock.indexOf('createWindow()') < readyBlock.indexOf("startLocalMeshPrepareOnStartup('cold_boot')"))

  // session success must not be the only Mesh trigger; Mesh must not nest inside account.then install path
  const sessionThen = readyBlock.indexOf('softwareAuth.session()')
  assert.ok(sessionThen > 0)
  const sessionSlice = readyBlock.slice(sessionThen, sessionThen + 800)
  assert.doesNotMatch(sessionSlice, /ensureMeshReady/)
  assert.match(sessionSlice, /startRemoteAgent/)

  // login/register re-ensure via shared helper (single-flight)
  assert.match(source, /startLocalMeshPrepareOnStartup\('auth:login'\)/)
  assert.match(source, /startLocalMeshPrepareOnStartup\('auth:register'\)/)
})

test('application uses an operating system single-instance lock', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(source, /PORTABLE_EXECUTABLE_DIR/)
  assert.match(source, /app\.setPath\('userData'/)
  const pinPos = source.indexOf('pinPortableUserData')
  const lockPos = source.indexOf('app.requestSingleInstanceLock()')
  assert.ok(pinPos >= 0 && lockPos > pinPos, 'portable userData must be pinned before single-instance lock')
  assert.match(source, /app\.requestSingleInstanceLock\(\)/)
  assert.match(source, /if \(!hasSingleInstanceLock\) \{\s*try \{ app\.quit\(\)/)
  assert.match(source, /process\.exit\(0\)/)
  assert.equal((source.match(/app\.requestSingleInstanceLock\(\)/g) || []).length, 1)
  assert.match(source, /app\.on\('second-instance'/)
  assert.match(source, /activateMainWindow\(\)/)
  assert.match(source, /pendingSecondInstanceFocus/)
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
