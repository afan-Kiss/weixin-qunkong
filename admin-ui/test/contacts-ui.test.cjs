const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('contacts display WeChat nicknames and expose save progress near the log', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'ContactsPage.vue'), 'utf8')

  assert.match(source, /instance\?\.nickname \|\| instance\?\.accountWxid/)
  assert.match(source, /prop="sourceInstanceName" label="所属微信"/)
  assert.match(source, /current\.sourceInstanceName/)
  assert.match(source, /saveStatus\.visible/)
  assert.match(source, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/)
  assert.match(source, /ref="saveTimelineRef"/)
})

test('unnamed groups use member nicknames and append their member count', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'stores', 'wechatData.ts'), 'utf8')

  assert.match(source, /findArray\(fallback, \['chatRoomMember', 'members', 'memberList'\]\)/)
  assert.match(source, /names\.slice\(0, 2\)\.join\('、'\)/)
  assert.match(source, /`\$\{shown\}\.\.\.\(\$\{count\}\)`/)
  assert.match(source, /`群聊（\$\{count\}人）`/)
})
