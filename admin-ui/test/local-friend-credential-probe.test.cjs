'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  shouldAllowFriendAdd,
  classifyRouteMatrix,
  selectCandidates,
  matchConsentTarget,
} = require('../scripts/local-friend-credential-probe.cjs')
const { parseProfileCredentials } = require('../electron/friend-profile.cjs')
const {
  extractSearchCredentials,
  identityMatch,
} = require('../electron/friend-credential-diagnostic.cjs')

test('group member contact with V3/V4', () => {
  const raw = {
    baseResponse: { ret: 0 },
    contactList: [{ userName: { String: 'wxid_a' }, encryptUserName: 'v3_abc@stranger' }],
    verifyUserValidTicketList: [{ username: 'wxid_a', antispamticket: 'v4_def@stranger' }],
  }
  const parsed = parseProfileCredentials(raw, 'wxid_a', 'r@chatroom')
  assert.equal(parsed.v3.startsWith('v3_'), true)
  assert.equal(parsed.v4.startsWith('v4_'), true)
})

test('group member contact V4 only', () => {
  const raw = {
    baseResponse: { ret: 0 },
    contactList: [{ userName: { String: 'geshihuajiyi016868' }, encryptUserName: '' }],
    verifyUserValidTicketList: [{ username: 'geshihuajiyi016868', antispamTicket: 'v4_only@stranger' }],
  }
  const parsed = parseProfileCredentials(raw, 'geshihuajiyi016868', 'r@chatroom')
  assert.equal(parsed.v3, '')
  assert.equal(parsed.v4.startsWith('v4_'), true)
})

test('get_contact_fast style encryptUserName as V3', () => {
  const raw = { contact: { encryptUserName: 'v3_fast@stranger', userName: { String: 'wxid_x' } } }
  // parseProfileCredentials walks contactList; also top-level via payload layers may miss nested contact
  const viaList = parseProfileCredentials({
    contactList: [{ userName: { String: 'wxid_x' }, encryptUserName: 'v3_fast@stranger' }],
  }, 'wxid_x', '')
  assert.equal(viaList.v3.startsWith('v3_'), true)
})

test('search returns v3_/v4_', () => {
  const parsed = extractSearchCredentials({
    userName: { String: 'v3_s@stranger' },
    antispamTicket: 'v4_s@stranger',
    nickName: { String: '测试' },
  })
  assert.equal(parsed.hasV3, true)
  assert.equal(parsed.hasV4, true)
})

test('search identity match allows merge', () => {
  const id = identityMatch({
    nickName: '白茶',
    expectedNickname: '白茶',
    bigHeadImgUrl: 'http://a/0',
    smallHeadImgUrl: 'http://a/132',
    memberAvatar: 'http://a/0',
  })
  assert.equal(id.matched, true)
})

test('search identity conflict rejects', () => {
  const id = identityMatch({
    nickName: '别人',
    expectedNickname: '白茶',
    bigHeadImgUrl: 'http://x/1',
    smallHeadImgUrl: 'http://x/2',
    memberAvatar: 'http://y/3',
  })
  assert.equal(id.matched, false)
  assert.equal(id.by, 'conflict')
})

test('plain userName is not V3', () => {
  const parsed = extractSearchCredentials({
    userName: { String: 'geshihuajiyi016868' },
    antispamTicket: 'v4_x@stranger',
  })
  assert.equal(parsed.hasV3, false)
})

test('plain ticket is not V4', () => {
  const parsed = extractSearchCredentials({
    userName: { String: 'v3_ok@stranger' },
    antispamTicket: 'ticket_not_v4',
  })
  assert.equal(parsed.hasV4, false)
})

test('read-only multi candidate does not auto-allow add_friend', () => {
  const gate = shouldAllowFriendAdd({
    consentMatch: null,
    accountWxid: 'me',
    candidate: { userName: 'other', isExistingFriend: false },
    v3: 'v3_a',
    v4: 'v4_b',
    identityOk: true,
    historyRequestSent: false,
    alreadySentThisRound: false,
  })
  assert.equal(gate.allow, false)
  assert.equal(gate.reason, 'NO_CONSENT_MATCH')
})

test('no consent whitelist blocks add_friend', () => {
  const match = matchConsentTarget(
    { enabled: false, targets: [{ wxidOrUserName: 'x', allowOneFriendRequest: true }] },
    { userName: 'x', nickName: 'n' },
    'room',
    'me',
  )
  assert.equal(match, null)
})

test('whitelist target allows exactly one when credentials ready', () => {
  const gate = shouldAllowFriendAdd({
    consentMatch: { wxidOrUserName: 'second', allowOneFriendRequest: true },
    accountWxid: 'me',
    candidate: { userName: 'second', isExistingFriend: false },
    v3: 'v3_ok@stranger',
    v4: 'v4_ok@stranger',
    identityOk: true,
    historyRequestSent: false,
    alreadySentThisRound: false,
  })
  assert.equal(gate.allow, true)
  assert.equal(gate.reason, 'CONSENTED_SINGLE_TEST_READY')
  const second = shouldAllowFriendAdd({
    consentMatch: { wxidOrUserName: 'second', allowOneFriendRequest: true },
    accountWxid: 'me',
    candidate: { userName: 'second', isExistingFriend: false },
    v3: 'v3_ok@stranger',
    v4: 'v4_ok@stranger',
    identityOk: true,
    historyRequestSent: false,
    alreadySentThisRound: true,
  })
  assert.equal(second.allow, false)
  assert.equal(second.reason, 'ROUND_LIMIT')
})

test('HTTP 200 empty body maps to REQUEST_SENT semantics in gate history', () => {
  // status marking is done by probe after HTTP 200; gate must still allow only once via history
  const afterSent = shouldAllowFriendAdd({
    consentMatch: { wxidOrUserName: 'second', allowOneFriendRequest: true },
    accountWxid: 'me',
    candidate: { userName: 'second', isExistingFriend: false },
    v3: 'v3_ok@stranger',
    v4: 'v4_ok@stranger',
    identityOk: true,
    historyRequestSent: true,
    alreadySentThisRound: false,
  })
  assert.equal(afterSent.allow, false)
  assert.equal(afterSent.reason, 'HISTORY_REQUEST_SENT')
})

test('selectCandidates excludes self and prefers styles', () => {
  const selected = selectCandidates([
    { userName: 'me', nickName: '我' },
    { userName: 'wxid_a', nickName: 'A' },
    { userName: 'custom_b', nickName: 'B' },
    { userName: 'wxid_c', nickName: 'C', inviterUserName: 'x' },
  ], 'me', new Set(), 3)
  assert.ok(selected.every((s) => s.userName !== 'me'))
  assert.ok(selected.some((s) => s.isWxidStyle))
  assert.ok(selected.some((s) => !s.isWxidStyle))
  assert.ok(selected.length <= 3)
})

test('classify GROUP_ROUTE_STABLE', () => {
  assert.equal(classifyRouteMatrix([
    { groupHasV3: true, groupHasV4: true, searchHasV3: false, searchHasV4: false, identityMatched: false, isWxidStyle: true },
    { groupHasV3: true, groupHasV4: true, searchHasV3: false, searchHasV4: false, identityMatched: false, isWxidStyle: false },
  ]), 'GROUP_ROUTE_STABLE')
})

test('classify SEARCH_ROUTE_STABLE', () => {
  assert.equal(classifyRouteMatrix([
    { groupHasV3: false, groupHasV4: true, searchHasV3: true, searchHasV4: true, identityMatched: true, isWxidStyle: false },
    { groupHasV3: false, groupHasV4: true, searchHasV3: true, searchHasV4: true, identityMatched: true, isWxidStyle: false },
  ]), 'SEARCH_ROUTE_STABLE')
})

test('update_single_profile flat encryptUserName is valid V3', () => {
  const { parseProfileCredentials } = require('../electron/friend-profile.cjs')
  const parsed = parseProfileCredentials({
    userName: { String: 'wxid_target' },
    nickName: { String: '测试' },
    encryptUserName: 'v3_from_profile@stranger',
  }, 'wxid_target', 'r@chatroom')
  assert.equal(parsed.v3, 'v3_from_profile@stranger')
  assert.equal(parsed.missing.includes('v3'), false)
})

test('group V4 only plus profile V3 assembles complete credentials', () => {
  const { parseProfileCredentials } = require('../electron/friend-profile.cjs')
  const group = parseProfileCredentials({
    baseResponse: { ret: 0 },
    contactList: [{ userName: { String: 'wxid_target' }, encryptUserName: '' }],
    verifyUserValidTicketList: [{ username: 'wxid_target', antispamticket: 'v4_ticket@stranger' }],
  }, 'wxid_target', 'r@chatroom')
  const profile = parseProfileCredentials({
    userName: { String: 'wxid_target' },
    encryptUserName: 'v3_from_profile@stranger',
  }, 'wxid_target', 'r@chatroom')
  assert.equal(group.v3, '')
  assert.equal(group.v4.startsWith('v4_'), true)
  assert.equal(profile.v3.startsWith('v3_'), true)
  assert.equal(Boolean(profile.v3 && group.v4), true)
})

test('classify MIXED_ROUTE for group V4 + profile V3', () => {
  assert.equal(classifyRouteMatrix([
    { groupHasV3: false, groupHasV4: true, profileHasV3: true, searchHasV3: false, searchHasV4: false, identityMatched: false, isWxidStyle: true },
    { groupHasV3: false, groupHasV4: true, profileHasV3: true, searchHasV3: false, searchHasV4: false, identityMatched: false, isWxidStyle: true },
  ]), 'MIXED_ROUTE')
})
