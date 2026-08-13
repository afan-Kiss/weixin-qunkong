'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const {
  createSecondInstanceGate,
  shouldActivateOnSecondInstance,
} = require('../electron/window-activation.cjs')

const mainSrc = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')

test('single-instance lock runs before heavy module requires', () => {
  const lockPos = mainSrc.indexOf('app.requestSingleInstanceLock()')
  const storagePos = mainSrc.indexOf("require('./storage.cjs')")
  assert.ok(lockPos > 0)
  assert.ok(storagePos > lockPos, 'lock must precede storage init require')
  assert.match(mainSrc, /process\.exit\(0\)/)
})

test('second-instance queues focus when window not ready', () => {
  assert.match(mainSrc, /pendingSecondInstanceFocus = true/)
  assert.match(mainSrc, /pendingSecondInstanceFocus/)
  assert.match(mainSrc, /activateMainWindow\(\)/)
})

test('activateMainWindow raises then clears alwaysOnTop', () => {
  assert.match(mainSrc, /setAlwaysOnTop\(true\)/)
  assert.match(mainSrc, /setAlwaysOnTop\(false\)/)
  assert.match(mainSrc, /moveTop/)
})

test('second-instance gate still cools down after first accept', () => {
  const gate = createSecondInstanceGate(1000)
  assert.equal(shouldActivateOnSecondInstance({ appReady: true, firstShowDone: true, gate, now: 5000 }), true)
  assert.equal(shouldActivateOnSecondInstance({ appReady: true, firstShowDone: true, gate, now: 5500 }), false)
  assert.equal(shouldActivateOnSecondInstance({ appReady: true, firstShowDone: false, gate, now: 9000 }), false)
})
