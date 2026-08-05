const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { resolveFriendProfileCredentials } = require('../electron/friend-credential-resolve.cjs')
const { evaluateFriendAddResult, isRetryableFriendCredentialFailure, buildAddFriendRequest } = require('../electron/protocol.cjs')

function mockFetch(map, { failProfileRounds = 0 } = {}) {
  const calls = []
  let profileHits = 0
  const fetchProfile = async (endpoint, body, sourceId, attempt) => {
    calls.push({ endpoint, body, sourceId, attempt })
    if (endpoint === '/api/update_single_profile') {
      profileHits += 1
      if (profileHits <= failProfileRounds) return { parsed: { v3: '', v4: '' } }
    }
    const entry = map[endpoint]
    if (!entry) return { parsed: { v3: '', v4: '' } }
    return { parsed: { v3: entry.v3 || '', v4: entry.v4 || '' } }
  }
  return { fetchProfile, calls }
}

test('group V4 only always calls update_single_profile', async () => {
  const { fetchProfile, calls } = mockFetch({
    '/api/get_group_member_contact': { v3: '', v4: 'v4_group@stranger' },
    '/api/get_contact': { v3: '', v4: '' },
    '/api/update_single_profile': { v3: 'v3_profile@stranger', v4: '' },
  })
  const result = await resolveFriendProfileCredentials({
    targetWxid: 'wxid_target',
    sourceRoomId: '123@chatroom',
    fetchProfile,
    delays: [0],
    profileRetries: 1,
  })
  assert.equal(result.ok, true)
  assert.equal(result.v3, 'v3_profile@stranger')
  assert.equal(result.v4, 'v4_group@stranger')
  assert.match(result.credentialSource, /UPDATE_SINGLE_PROFILE/)
  assert.ok(calls.some((c) => c.endpoint === '/api/update_single_profile'))
})

test('retries update_single_profile when first responses miss V3', async () => {
  const { fetchProfile, calls } = mockFetch({
    '/api/get_group_member_contact': { v3: '', v4: 'v4_group@stranger' },
    '/api/get_contact': { v3: '', v4: '' },
    '/api/update_single_profile': { v3: 'v3_late@stranger', v4: '' },
  }, { failProfileRounds: 2 })
  const result = await resolveFriendProfileCredentials({
    targetWxid: 'wxid_target',
    sourceRoomId: '123@chatroom',
    fetchProfile,
    delays: [0],
    profileRetries: 3,
  })
  assert.equal(result.ok, true)
  assert.equal(result.v3, 'v3_late@stranger')
  assert.equal(calls.filter((c) => c.endpoint === '/api/update_single_profile').length, 3)
})

test('skips update_single_profile when group already has V3+V4', async () => {
  const { fetchProfile, calls } = mockFetch({
    '/api/get_group_member_contact': { v3: 'v3_group@stranger', v4: 'v4_group@stranger' },
  })
  const result = await resolveFriendProfileCredentials({
    targetWxid: 'wxid_target',
    sourceRoomId: '123@chatroom',
    fetchProfile,
    delays: [0],
  })
  assert.equal(result.ok, true)
  assert.equal(result.credentialSource, 'GROUP_MEMBER_CONTACT')
  assert.equal(calls.filter((c) => c.endpoint === '/api/update_single_profile').length, 0)
})

test('Invalid argument is retryable; policy -24 is not', () => {
  const invalid = { baseResponse: { ret: -2, errMsg: { String: 'Invalid argument' } } }
  const verdict = evaluateFriendAddResult(true, invalid)
  assert.equal(verdict.accepted, false)
  assert.equal(isRetryableFriendCredentialFailure(true, invalid, verdict), true)

  const policy = { baseResponse: { ret: -24, errMsg: { String: '用户账号异常' } } }
  const policyVerdict = evaluateFriendAddResult(true, policy)
  assert.equal(isRetryableFriendCredentialFailure(true, policy, policyVerdict), false)
})

test('main always re-resolves credentials and retries credential failures', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(main, /执行前一律现取凭证/)
  assert.match(main, /ADD_FRIEND_RETRY/)
  assert.match(main, /isRetryableFriendCredentialFailure/)
  assert.match(main, /同源实例一律用当前在线端口/)
  assert.match(main, /凭证格式无效/)
  assert.doesNotMatch(main, /if \(!request\.v3 \|\| !request\.v4\)/)
  assert.doesNotMatch(main, /let v3 = \/\^v3_\/i\.test\(String\(request\.senderV3/)
})

test('group page creates PROFILE_PENDING without pre-caching v3/v4', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'GroupsMembersPage.vue'), 'utf8')
  const body = page.slice(page.indexOf('async function createAddFriendTask'), page.indexOf('async function collectLatestMembers'))
  assert.match(body, /status: 'PROFILE_PENDING'/)
  assert.match(body, /sourceInstancePort: instance\.apiPort/)
  assert.doesNotMatch(body, /resolveFriendCredentials/)
  assert.doesNotMatch(body, /\bv3,\s*v4\b/)
})

test('buildAddFriendRequest still emits group scene 14 body', () => {
  const body = buildAddFriendRequest({
    v3: 'v3_x', v4: 'v4_y', sourceRoomId: '1@chatroom', targetWxid: 'wxid_a',
  })
  assert.equal(body.scence, '14')
  assert.equal(body.scene, '14')
  assert.equal(body.chatRoomUserName, '1@chatroom')
})
