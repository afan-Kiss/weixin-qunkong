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

test('friend task defers credentials to execution (PROFILE_PENDING)', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'GroupsMembersPage.vue'), 'utf8')
  const body = source.slice(source.indexOf('async function createAddFriendTask'), source.indexOf('async function collectLatestMembers'))

  assert.match(body, /status: 'PROFILE_PENDING'/)
  assert.match(body, /sourceInstanceId: member\.sourceInstanceId/)
  assert.doesNotMatch(body, /resolveFriendCredentials/)
})

test('chat speaker friend task resolves credentials at execution with profile supplement', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ChatAddFriendPage.vue'), 'utf8')
  const main = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const resolver = readFileSync(path.join(__dirname, '..', 'electron', 'friend-credential-resolve.cjs'), 'utf8')
  assert.match(source, /status: 'PROFILE_PENDING'/)
  assert.match(source, /sourceInstancePort: row\.sourceInstancePort \|\| instance\.apiPort/)
  assert.match(main, /resolvePendingFriendProfile/)
  assert.match(main, /resolveFriendProfileCredentials/)
  assert.match(resolver, /\/api\/get_group_member_contact/)
  assert.match(resolver, /\/api\/get_contact/)
  assert.match(resolver, /\/api\/update_single_profile/)
})
