const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const vm = require('node:vm')

function loadBroadcastTargets() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'broadcastTargets.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const sandbox = { exports: {}, module: { exports: {} } }
  sandbox.exports = sandbox.module.exports
  vm.runInNewContext(compiled, sandbox)
  return sandbox.module.exports
}

const {
  isOfficialAccountWxid,
  splitExcludeRules,
  remarkMatchesExclude,
  nicknameExactExcluded,
  wxidExactExcluded,
} = loadBroadcastTargets()

test('official accounts with gh_ prefix are detected', () => {
  assert.equal(isOfficialAccountWxid('gh_0ee8b6b76004'), true)
  assert.equal(isOfficialAccountWxid('GH_1b046cb12620'), true)
  assert.equal(isOfficialAccountWxid('wxid_byblpno5ifjk21'), false)
  assert.equal(isOfficialAccountWxid('q197271614'), false)
})

test('remark contains exclude rules case-insensitively', () => {
  assert.equal(remarkMatchesExclude('客户-勿扰', ['勿扰']), true)
  assert.equal(remarkMatchesExclude('VIP客户', ['勿扰']), false)
  assert.equal(remarkMatchesExclude('ABC备注', ['abc']), true)
  assert.equal(remarkMatchesExclude('', ['勿扰']), false)
})

test('wxid and nickname exact exclude ignore case', () => {
  assert.equal(wxidExactExcluded('wxid_A', ['wxid_a']), true)
  assert.equal(nicknameExactExcluded('小明', ['小明']), true)
  assert.equal(nicknameExactExcluded('小明同学', ['小明']), false)
})

test('splitExcludeRules supports newlines and commas', () => {
  const rules = splitExcludeRules('a\nb,c')
  assert.equal(rules.length, 3)
  assert.equal(rules[0], 'a')
  assert.equal(rules[1], 'b')
  assert.equal(rules[2], 'c')
  assert.equal(splitExcludeRules('x，y').join('|'), 'x|y')
})

test('broadcast page wires remark exclude UI and official-account filter', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'BroadcastPage.vue'), 'utf8')
  assert.match(page, /excludeRemark/)
  assert.match(page, /排除备注（包含即排除）/)
  assert.match(page, /isOfficialAccountWxid/)
  assert.match(page, /remarkMatchesExclude/)
  assert.match(page, /label: '备注'/)
  assert.doesNotMatch(page, /nickname: item\.nickname \|\| item\.remark \|\| item\.wxid/)
})
