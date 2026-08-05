const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { safeCloneForIpc } = require('../electron/ipc-safe.cjs')

test('safeCloneForIpc strips functions and stringifies bigint', () => {
  const cloned = safeCloneForIpc({
    ok: true,
    n: 1n,
    fn: () => 1,
    nested: { a: 'x', b: 2n },
  })
  assert.deepEqual(cloned, { ok: true, n: '1', nested: { a: 'x', b: '2' } })
})

test('safeCloneForIpc handles circular objects without throwing', () => {
  const row = { name: 'x' }
  row.self = row
  assert.equal(safeCloneForIpc(row, { fallback: true }).fallback, true)
})

test('main/preload/ui wire clone-safe ipc and select-all labels', () => {
  const root = path.join(__dirname, '..')
  const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8')
  const uiMain = fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8')
  const chat = fs.readFileSync(path.join(root, 'src', 'pages', 'ChatAddFriendPage.vue'), 'utf8')
  const groups = fs.readFileSync(path.join(root, 'src', 'pages', 'GroupsMembersPage.vue'), 'utf8')
  const qr = fs.readFileSync(path.join(root, 'src', 'pages', 'QrTasksPage.vue'), 'utf8')
  assert.match(main, /safeCloneForIpc\(raw/)
  // 沙箱 preload 不能 require 本地模块，plainIpcValue 必须内联
  assert.doesNotMatch(preload, /require\(['"]\.\/ipc-safe\.cjs['"]\)/)
  assert.match(preload, /function plainIpcValue/)
  assert.match(preload, /沙箱 preload 不能 require 本地模块/)
  assert.match(preload, /createTask: \(payload\) => ipcRenderer\.invoke\('tasks:create', plainIpcValue\(payload\)\)/)
  assert.match(main, /loadDirectoryOwnershipSet/)
  assert.match(main, /SqliteError 等不可 structured-clone/)
  assert.match(main, /throw new Error\(message\)/)
  assert.match(uiMain, /isIpcCloneError/)
  assert.match(uiMain, /4000/)
  assert.match(chat, /selectAllListeningGroups/)
  assert.match(chat, /field-label-row/)
  assert.match(groups, /selectAllFilterGroups/)
  assert.match(groups, /visibleFilterGroupOptions/)
  assert.match(qr, /selectAllHistoryGroups/)
  assert.match(qr, /field-select-all/)
})
