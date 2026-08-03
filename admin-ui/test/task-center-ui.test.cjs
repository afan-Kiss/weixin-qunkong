const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

test('task details open visibly and show only useful task and WeChat information', () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'pages', 'TasksPage.vue'), 'utf8')

  assert.match(source, /async function viewTask/)
  assert.match(source, /taskItems\(id\)/)
  assert.match(source, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/)
  assert.match(source, /任务状态/)
  assert.match(source, /任务进度/)
  assert.match(source, /执行任务的微信/)
  assert.match(source, /微信号：/)
  assert.match(source, /label="操作账号"/)
  assert.doesNotMatch(source, /prop="plan"|label="进度"|<el-progress/)
  assert.doesNotMatch(source, /本地队列|按任务选择的微信/)
  assert.doesNotMatch(source, /执行策略|验证方式|重试规则|排除规则/)
})

test('task runner does not wait after its final item', () => {
  const source = readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
  const runTask = source.slice(source.indexOf('async function runTask'), source.indexOf('function createLocalTask'))

  assert.match(runTask, /itemIndex < taskItems\.length - 1/)
})
