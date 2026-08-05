const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/** 与 src/utils/virtualTableWindow.ts 对齐 */
function calcVirtualWindow(input) {
  const rowHeight = Math.max(1, Number(input.rowHeight) || 1)
  const rowCount = Math.max(0, Math.floor(Number(input.rowCount) || 0))
  const viewportHeight = Math.max(0, Number(input.viewportHeight) || 0)
  const scrollTop = Math.max(0, Number(input.scrollTop) || 0)
  const overscan = Math.max(0, Math.floor(Number(input.overscan) || 0))
  const totalHeight = rowCount * rowHeight
  const maxScroll = Math.max(0, totalHeight - viewportHeight)
  const clampedScroll = Math.min(scrollTop, maxScroll)
  const startIndex = Math.max(0, Math.floor(clampedScroll / rowHeight) - overscan)
  const endIndex = Math.min(
    rowCount,
    Math.ceil((clampedScroll + viewportHeight) / rowHeight) + overscan,
  )
  return { scrollTop: clampedScroll, maxScroll, startIndex, endIndex, totalHeight }
}

function calcHeaderSelectionState(rowCount, selectedCount) {
  const allSelected = rowCount > 0 && selectedCount >= rowCount
  const someSelected = selectedCount > 0 && !allSelected
  return { allSelected, someSelected }
}

test('virtual window clamps scroll and only covers visible range plus overscan', () => {
  const win = calcVirtualWindow({
    scrollTop: 999999,
    viewportHeight: 360,
    rowHeight: 40,
    rowCount: 2000,
    overscan: 10,
  })
  assert.equal(win.totalHeight, 80000)
  assert.equal(win.scrollTop, win.maxScroll)
  assert.ok(win.endIndex - win.startIndex < 50)
  assert.equal(win.endIndex, 2000)
  assert.ok(win.startIndex > 1900)
})

test('virtual window at top starts from zero with overscan only downward', () => {
  const win = calcVirtualWindow({
    scrollTop: 0,
    viewportHeight: 360,
    rowHeight: 40,
    rowCount: 2000,
    overscan: 10,
  })
  assert.equal(win.startIndex, 0)
  assert.equal(win.endIndex, Math.ceil(360 / 40) + 10)
})

test('header selection distinguishes all / partial / none without scanning rows', () => {
  assert.deepEqual(calcHeaderSelectionState(2000, 0), { allSelected: false, someSelected: false })
  assert.deepEqual(calcHeaderSelectionState(2000, 3), { allSelected: false, someSelected: true })
  assert.deepEqual(calcHeaderSelectionState(2000, 2000), { allSelected: true, someSelected: false })
  assert.deepEqual(calcHeaderSelectionState(0, 0), { allSelected: false, someSelected: false })
})

test('virtual target table binds scroll in template so empty-to-data remount still works', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'app', 'VirtualTargetTable.vue'), 'utf8')
  assert.match(source, /@scroll\.passive="onScroll"/)
  assert.match(source, /calcVirtualWindow/)
  assert.match(source, /calcHeaderSelectionState/)
  assert.match(source, /syncScrollToDom/)
  assert.doesNotMatch(source, /addEventListener\('scroll'/)
  assert.doesNotMatch(source, /v-for=".* in rows"/)
  assert.match(source, /emit\('select-all'/)
  assert.match(source, /emit\('toggle-row'/)
})

test('broadcast select-all still copies full filtered list not only visible rows', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'src', 'pages', 'BroadcastPage.vue'), 'utf8')
  assert.match(page, /selectedTargets\.value = broadcastFriends\.value\.slice\(\)/)
  assert.match(page, /@select-all="selectAllFilteredTargets"/)
  assert.match(page, /watch\(broadcastFriends/)
})
