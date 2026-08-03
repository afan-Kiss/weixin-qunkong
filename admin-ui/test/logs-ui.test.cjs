const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('logs use Chinese levels, concrete operation names, and WeChat nicknames', () => {
  const root = path.join(__dirname, '..')
  const page = readFileSync(path.join(root, 'src', 'pages', 'SettingsLogsPage.vue'), 'utf8')
  const main = readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8')

  assert.match(page, /INFO: '普通', WARNING: '提醒', ERROR: '错误'/)
  assert.match(page, /instance\?\.nickname \|\| instance\?\.accountWxid/)
  assert.match(page, /apiOperationLabels\[String\(item\.path\)\]/)
  assert.match(page, /v-model="selectedInstance"/)
  assert.match(page, /v-model="timeRange"/)
  assert.match(main, /'\/api\/send_text_msg': '发送文字消息'/)
  assert.match(main, /'\/api\/send_image_msg': '发送图片消息'/)
  assert.match(main, /`\$\{operation\}完成`/)
})
