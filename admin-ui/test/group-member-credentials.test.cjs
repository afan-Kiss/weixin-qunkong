const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadParser() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'wechat.ts'), 'utf8')
  const start = source.indexOf('type AnyRecord')
  const end = source.indexOf('export async function resolveFriendCredentials', start)
  assert.ok(start >= 0 && end > start)
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sandbox = { exports: {}, module: { exports: {} } }
  sandbox.exports = sandbox.module.exports
  vm.runInNewContext(compiled, sandbox)
  return sandbox.module.exports.resolveGroupMemberAddCredentials
}

const parse = loadParser()
const v3 = 'v3_abcdef@stranger'
const v4 = 'v4_abcdef@stranger'

function response(ticket = { username: 'wxid_target', antispamticket: v4 }) {
  return {
    baseResponse: { ret: 0 }, contactCount: 2,
    contactList: [
      { userName: { String: 'wxid_other' }, encryptUserName: 'v3_wrong@stranger' },
      { userName: { String: 'wxid_target' }, friendUserName: 'wxid_target', encryptUserName: v3,
        newChatroomData: { chatRoomUserName: { String: '123@chatroom' } } },
    ],
    verifyUserValidTicketList: ticket,
  }
}

test('extracts HAR group-member V3/V4 and matches the selected wxid', () => {
  const result = parse(response(), 'wxid_target', 'fallback@chatroom')
  assert.equal(result.v3, v3)
  assert.equal(result.v4, v4)
  assert.equal(result.roomId, '123@chatroom')
  assert.equal(result.baseRet, 0)
  assert.deepEqual(Array.from(result.missing), [])
})

test('supports ticket arrays, data wrappers and antispamTicket casing', () => {
  const wrapped = { data: response([{ username: { String: 'wxid_target' }, antispamTicket: v4 }]) }
  const result = parse(wrapped, 'wxid_target', '123@chatroom')
  assert.equal(result.v3, v3)
  assert.equal(result.v4, v4)
  assert.equal(result.matchedTicket, true)
})

test('rejects incomplete or invalid-prefix credentials', () => {
  const noV4 = response({ username: 'wxid_target' })
  assert.deepEqual(Array.from(parse(noV4, 'wxid_target', '123@chatroom').missing), ['v4'])
  const noV3 = response()
  noV3.contactList[1].encryptUserName = 'wxid_target'
  assert.deepEqual(Array.from(parse(noV3, 'wxid_target', '123@chatroom').missing), ['v3'])
})

test('diagnostic sync keeps the required redacted credential fields', () => {
  const storage = fs.readFileSync(path.join(__dirname, '..', 'electron', 'storage.cjs'), 'utf8')
  for (const field of ['accountWxid', 'targetWxid', 'roomId', 'baseRet', 'matchedContact', 'matchedTicket', 'v3Prefix', 'v3Length', 'v4Prefix', 'v4Length', 'parserVersion']) {
    assert.match(storage, new RegExp(`${field}:`))
  }
})

test('main-process parser handles nested JSON strings and numeric string baseRet', () => {
  const { parseProfileCredentials, rawStructure } = require('../electron/friend-profile.cjs')
  const raw = { response: { data: JSON.stringify({ data: response([{ username: 'wxid_target', antispamticket: v4 }]) }) } }
  raw.response.data = JSON.stringify({ data: { ...response([{ username: 'wxid_target', antispamticket: v4 }]), baseResponse: { ret: '0' } } })
  const result = parseProfileCredentials(raw, 'wxid_target', '123@chatroom')
  assert.equal(result.v3, v3)
  assert.equal(result.v4, v4)
  assert.equal(result.baseRet, 0)
  const structure = rawStructure(raw)
  assert.equal(structure.rawType, 'object')
  assert.ok(structure.bodyLength > 0)
  assert.doesNotMatch(structure.rawPreview, /v3_abcdef@stranger|v4_abcdef@stranger/)
})

test('candidate source and PROFILE_PENDING fields remain wired end to end', () => {
  const storage = fs.readFileSync(path.join(__dirname, '..', 'electron', 'storage.cjs'), 'utf8')
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ChatAddFriendPage.vue'), 'utf8')
  for (const field of ['source_room_id', 'source_room_name', 'source_instance_port', 'account_wxid', 'sender_v3', 'received_at']) assert.match(storage, new RegExp(field))
  assert.match(storage, /UNIQUE\(instance_id, sender_wxid, source_room_id\)/)
  assert.match(page, /status: 'PROFILE_PENDING'/)
})
