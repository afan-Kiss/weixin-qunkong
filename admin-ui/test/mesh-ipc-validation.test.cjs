'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { safeClientId } = require('../electron/mesh-remote-bridge.cjs')

test('safeClientId rejects empty, oversized, and unsafe ids', () => {
  assert.equal(safeClientId(''), '')
  assert.equal(safeClientId(null), '')
  assert.equal(safeClientId('a'.repeat(129)), '')
  assert.equal(safeClientId('../etc/passwd'), '')
  assert.equal(safeClientId('client id'), '')
  assert.equal(safeClientId('good-client_1'), 'good-client_1')
  assert.equal(safeClientId('ab:cd@ef'), 'ab:cd@ef')
})

test('preload remote API surface does not expose raw ipcRenderer', () => {
  const fs = require('fs')
  const path = require('path')
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
  assert.match(preload, /remoteGetStatus/)
  assert.match(preload, /remoteOpenDesktop/)
  assert.match(preload, /contextBridge\.exposeInMainWorld/)
  assert.doesNotMatch(preload, /exposeInMainWorld\(['"]ipcRenderer['"]/)
  assert.doesNotMatch(preload, /MESH_LOGIN_KEY|loginTokenKey|adminPassword/)
  // Renderer never receives embedUrl helpers
  assert.doesNotMatch(preload, /embedUrl|openExternal.*mesh/i)
})

test('main mesh handlers only take clientId (no nodeId IPC)', () => {
  const fs = require('fs')
  const path = require('path')
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /mesh:open-desktop/)
  assert.match(main, /mesh:open-files/)
  assert.doesNotMatch(main, /mesh:open-desktop[^\n]*nodeId/)
  assert.doesNotMatch(main, /webSecurity:\s*false/)
  assert.doesNotMatch(main, /nodeIntegration:\s*true/)
})
