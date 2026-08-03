const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { mkdtempSync, readFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('path')
const { createSerialExecutor, parseInjectorOutput, waitForInjectorClose } = require('../electron/instance-runtime.cjs')

test('injector output parser distinguishes success and failure', () => {
  const success = parseInjectorOutput([Buffer.concat([Buffer.from('PID: 1234\r\nDLL'), Buffer.from('D7A2C8EBB3C9B9A6', 'hex')])])
  assert.deepEqual({ pid: success.pid, failed: success.failed, succeeded: success.succeeded }, { pid: 1234, failed: false, succeeded: true })

  const failure = parseInjectorOutput([Buffer.concat([Buffer.from('PID: 5678\r\nDLL'), Buffer.from('D7A2C8EBCAA7B0DC', 'hex')])])
  assert.deepEqual({ pid: failure.pid, failed: failure.failed, succeeded: failure.succeeded }, { pid: 5678, failed: true, succeeded: false })
})

test('injector soft-succeeds when exit is 0 and PID exists even if success text is missing', () => {
  const soft = parseInjectorOutput([Buffer.from('PID: 4321\r\nMulti WeChat enabled successfully!\r\n')], { exitCode: 0 })
  assert.equal(soft.pid, 4321)
  assert.equal(soft.failed, false)
  assert.equal(soft.succeeded, true)

  const hardFail = parseInjectorOutput([
    Buffer.concat([Buffer.from('PID: 4321\r\nDLL'), Buffer.from('D7A2C8EBCAA7B0DC', 'hex')]),
  ], { exitCode: 0 })
  assert.equal(hardFail.failed, true)
  assert.equal(hardFail.succeeded, false)
})

test('waitForInjectorClose resolves after exit and stdio end', async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const pending = waitForInjectorClose(child)
  child.emit('exit', 0, null)
  child.stdout.emit('end')
  child.stderr.emit('end')
  assert.deepEqual(await pending, { code: 0, signal: null })
})

test('concurrent instance starts are serialized and reserve distinct resources', async () => {
  const enqueue = createSerialExecutor()
  const usedPorts = new Set()
  let active = 0
  let maximumActive = 0
  const start = () => enqueue(async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    let port = 19088
    while (usedPorts.has(port)) port += 2
    await new Promise((resolve) => setTimeout(resolve, 10))
    usedPorts.add(port)
    active -= 1
    return port
  })

  assert.deepEqual(await Promise.all([start(), start(), start()]), [19088, 19090, 19092])
  assert.equal(maximumActive, 1)
})

test('managed ownership survives storage reload reads', () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'wx-instance-storage-'))
  const storage = require('../electron/storage.cjs')
  try {
    storage.initStorage(dataRoot)
    storage.upsertInstance({ id: 'managed', apiPort: 19088, tcpPort: 61108, pid: 101, status: 'WAITING_LOGIN', managed: true })
    storage.upsertInstance({ id: 'external', apiPort: 19090, tcpPort: 61110, pid: 102, status: 'ONLINE', managed: false })
    assert.deepEqual(storage.listStoredInstances().map((item) => [item.id, item.managed]), [['managed', 1], ['external', 0]])
  } finally {
    storage.database().close()
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('closed WeChat processes are synchronized to stopped instead of error', () => {
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const page = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'InstancesPage.vue'), 'utf8')
  assert.match(main, /function markInstanceStopped/)
  assert.match(main, /await synchronizeInstanceProcesses\(\)/)
  assert.match(main, /if \(!executable\) \{ markInstanceStopped\(record\); continue \}/)
  assert.match(main, /waitForInjectorClose/)
  assert.match(main, /decodeInjectorChunks/)
  assert.match(page, /item\.status === 'STOPPED'\) return '已停止微信'/)
})
