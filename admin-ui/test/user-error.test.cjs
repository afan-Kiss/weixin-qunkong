const test = require('node:test')
const assert = require('node:assert/strict')
const { toUserErrorMessage } = require('../electron/user-error.cjs')

test('common system errors are translated into useful Chinese messages', () => {
  const cases = [
    ['fetch failed', '无法连接微信控制接口'],
    ['connect ECONNREFUSED 127.0.0.1:19088', '无法连接微信控制接口'],
    ['The operation was aborted due to timeout', '请求超时'],
    ['listen EADDRINUSE: address already in use', '端口已被其他程序占用'],
    ['spawn EACCES', '权限不足'],
    ['ENOENT: no such file or directory', '所需文件或程序不存在'],
  ]
  for (const [input, expected] of cases) assert.match(toUserErrorMessage(new Error(input)), new RegExp(expected))
})

test('unknown English errors are hidden from user-facing messages', () => {
  const message = toUserErrorMessage(new Error('Unexpected low-level failure XYZ'))
  assert.equal(message, '操作失败，请到“设置与日志”查看详细原因')
  assert.doesNotMatch(message, /Unexpected|failure|XYZ/)
})
