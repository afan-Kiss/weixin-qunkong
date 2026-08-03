const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('group row viewing and checkbox selection use independent actions', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'GroupsMembersPage.vue'), 'utf8')
  const selectGroupBody = source.slice(source.indexOf('function selectGroup'), source.indexOf('function toggleGroup'))

  assert.doesNotMatch(selectGroupBody, /selectedGroups\.value/)
  assert.match(source, /<el-checkbox[^>]+@click\.stop[^>]+@change="toggleGroup/)
  assert.match(source, /function selectAllGroups/)
  assert.match(source, /function clearSelectedGroups/)
})

test('friend task resolves credentials through the group member profile endpoint', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'GroupsMembersPage.vue'), 'utf8')

  assert.match(source, /resolveFriendCredentials/)
  assert.match(source, /MEMBER_PROFILE_REQUEST_INTERVAL_MS = 200/)
  assert.match(source, /profileRequestCount > 0[^\n]+await wait\(MEMBER_PROFILE_REQUEST_INTERVAL_MS\)/)
  assert.match(source, /if \(!v3 \|\| !v4\)/)
})

test('chat speaker friend task also fills either missing credential from contact profile', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ChatAddFriendPage.vue'), 'utf8')
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  assert.match(source, /status: 'PROFILE_PENDING'/)
  assert.match(source, /sourceInstancePort: row\.sourceInstancePort \|\| instance\.apiPort/)
  assert.match(main, /resolvePendingFriendProfile/)
  assert.match(main, /\/api\/get_group_member_contact/)
  assert.match(main, /\/api\/get_contact/)
})
