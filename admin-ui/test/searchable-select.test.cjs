const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/**
 * 与 src/utils/searchableSelect.ts 中 filterSelectOptions 行为对齐的纯 JS 实现，供单测使用。
 * @param {Array<{ label: string, value: string }>} options
 * @param {string} query
 * @param {string|string[]} [selectedValues]
 * @param {number} [limit]
 */
function filterSelectOptions(options, query, selectedValues = [], limit = 80) {
  const list = Array.isArray(options) ? options : []
  const q = String(query || '').trim().toLowerCase()
  const selected = new Set(
    (Array.isArray(selectedValues) ? selectedValues : [selectedValues])
      .map((item) => String(item || ''))
      .filter(Boolean),
  )
  const maxRest = Math.max(Number(limit) || 80, 1)
  const selectedItems = []
  for (const item of list) {
    if (selected.has(String(item.value))) selectedItems.push(item)
  }
  const rest = []
  for (const item of list) {
    if (rest.length >= maxRest) break
    const key = String(item.value)
    if (selected.has(key)) continue
    if (!q) {
      rest.push(item)
      continue
    }
    const label = String(item.label || '').toLowerCase()
    const value = String(item.value || '').toLowerCase()
    if (label.includes(q) || value.includes(q)) rest.push(item)
  }
  return [...selectedItems, ...rest]
}

test('filterSelectOptions limits idle render and keeps selected', () => {
  const options = Array.from({ length: 300 }, (_, index) => ({ label: `群${index}`, value: `g-${index}` }))
  const selected = ['g-250', 'g-10']
  const visible = filterSelectOptions(options, '', selected, 80)
  assert.ok(visible.length <= 80 + selected.length)
  assert.ok(visible.some((item) => item.value === 'g-250'))
  assert.ok(visible.some((item) => item.value === 'g-10'))
})

test('filterSelectOptions matches label or value case-insensitively', () => {
  const options = [
    { label: '客户A群', value: '111@chatroom' },
    { label: '测试群', value: '222@chatroom' },
    { label: '其他', value: '333@chatroom' },
  ]
  assert.deepEqual(filterSelectOptions(options, '测试', []).map((item) => item.value), ['222@chatroom'])
  assert.deepEqual(filterSelectOptions(options, '111@', []).map((item) => item.value), ['111@chatroom'])
})

test('pages wire debounced searchable selects', () => {
  const root = path.join(__dirname, '..')
  const util = fs.readFileSync(path.join(root, 'src', 'utils', 'searchableSelect.ts'), 'utf8')
  const chat = fs.readFileSync(path.join(root, 'src', 'pages', 'ChatAddFriendPage.vue'), 'utf8')
  const groups = fs.readFileSync(path.join(root, 'src', 'pages', 'GroupsMembersPage.vue'), 'utf8')
  const qr = fs.readFileSync(path.join(root, 'src', 'pages', 'QrTasksPage.vue'), 'utf8')
  const layout = fs.readFileSync(path.join(root, 'src', 'layout', 'MainLayout.vue'), 'utf8')
  assert.match(util, /useSelectSearchQuery/)
  assert.match(util, /SELECT_OPTION_LIMIT_IDLE = 80/)
  assert.match(util, /SELECT_OPTION_LIMIT_SEARCH = 120/)
  assert.match(chat, /useSelectSearchQuery/)
  assert.match(chat, /groupSelectOpen/)
  assert.match(chat, /输入群名\/群ID搜索/)
  assert.match(groups, /groupSearch\.setQuery/)
  assert.match(qr, /groupSearch\.setQuery/)
  assert.match(layout, /setInterval\(refreshMetrics, 5000\)/)
})
