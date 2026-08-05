const test = require('node:test')
const assert = require('node:assert/strict')
const {
  extractSearchCredentials,
  identityMatch,
  credentialMeta,
  redactPreview,
  ALLOWED_ENDPOINTS,
} = require('../electron/friend-credential-diagnostic.cjs')
const { needsUpgrade, isManifestTargetedToClient } = require('../electron/client-updater.cjs')

test('search credentials extract v3_/v4_ only', () => {
  const raw = {
    baseResponse: { ret: 0, errMsg: { String: 'ok' } },
    userName: { String: 'v3_abc@stranger' },
    nickName: { String: '白茶' },
    antispamTicket: 'v4_def@stranger',
    bigHeadImgUrl: 'http://a/0',
    smallHeadImgUrl: 'http://a/132',
  }
  const parsed = extractSearchCredentials(raw)
  assert.equal(parsed.hasV3, true)
  assert.equal(parsed.hasV4, true)
  assert.equal(parsed.nickName, '白茶')
  assert.equal(parsed.v3.startsWith('v3_'), true)
})

test('plain wxid is not V3', () => {
  const parsed = extractSearchCredentials({
    userName: { String: 'geshihuajiyi016868' },
    antispamTicket: 'v4_x',
    nickName: { String: '白茶' },
  })
  assert.equal(parsed.hasV3, false)
  assert.equal(parsed.hasV4, true)
})

test('identity match by nickname', () => {
  const id = identityMatch({ nickName: '白茶', expectedNickname: '白茶', bigHeadImgUrl: '', smallHeadImgUrl: '', memberAvatar: '' })
  assert.equal(id.matched, true)
  assert.equal(id.by, 'nickName')
})

test('identity mismatch when nickname conflicts', () => {
  const id = identityMatch({
    nickName: '别人',
    expectedNickname: '白茶',
    bigHeadImgUrl: 'http://x/1',
    smallHeadImgUrl: 'http://x/2',
    memberAvatar: 'http://y/3',
  })
  assert.equal(id.matched, false)
})

test('credential meta never includes full secret', () => {
  const meta = credentialMeta('v3_0123456789abcdef@stranger')
  assert.equal(meta.present, true)
  assert.equal(meta.prefix, 'v3_012345678')
  assert.equal(meta.prefix.length, 12)
  assert.equal(meta.sha16.length, 16)
})

test('redactPreview masks v3/v4', () => {
  const text = redactPreview({ v3: 'v3_LONGSECRETVALUE', ticket: 'v4_ANOTHERSECRET' })
  assert.match(text, /v3_LONGSECRE/)
  assert.doesNotMatch(text, /LONGSECRETVALUE/)
})

test('allowlist contains search and group routes', () => {
  assert.ok(ALLOWED_ENDPOINTS.includes('/api/net_scene_search_contact'))
  assert.ok(ALLOWED_ENDPOINTS.includes('/api/get_group_member_contact'))
  assert.ok(ALLOWED_ENDPOINTS.includes('/api/get_group_memeber_info'))
})

test('targeted manifest only upgrades listed client', () => {
  const man = {
    version: '1.41',
    buildId: 'b1',
    releaseSequence: 40,
    minimumReleaseSequence: 0,
    targetClientIds: ['abc'],
  }
  assert.equal(isManifestTargetedToClient(man, 'abc'), true)
  assert.equal(isManifestTargetedToClient(man, 'zzz'), false)
  assert.equal(needsUpgrade(man, 30, 'old', '1.40.0', 'abc'), true)
  assert.equal(needsUpgrade(man, 30, 'old', '1.40.0', 'zzz'), false)
  assert.equal(needsUpgrade({ ...man, targetClientIds: [] }, 30, 'old', '1.40.0', 'zzz'), true)
})
