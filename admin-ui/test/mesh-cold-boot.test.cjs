'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('installMeshAgent prefers official -fullinstall before PowerShell New-Service', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'mesh-agent-manager.cjs'), 'utf8')
  const fnStart = source.indexOf('async function installMeshAgent')
  const fnEnd = source.indexOf('async function startMeshAgent', fnStart)
  const body = source.slice(fnStart, fnEnd)
  const fullPos = body.indexOf("['-fullinstall']")
  const psPos = body.indexOf('installBrandedWindowsService')
  assert.ok(fullPos > 0, 'must call -fullinstall')
  assert.ok(psPos > 0, 'must keep PowerShell fallback')
  assert.ok(fullPos < psPos, 'official fullinstall must run before PowerShell New-Service fallback')
  assert.match(body, /installPath/)
})

test('mesh-remote-bridge emits MESH-BOOT structured logs', () => {
  const bridge = readFileSync(path.join(__dirname, '..', 'electron', 'mesh-remote-bridge.cjs'), 'utf8')
  assert.match(bridge, /\[MESH-BOOT\]/)
  assert.match(bridge, /service_running/)
  assert.match(bridge, /inflightPrepare/)
})
