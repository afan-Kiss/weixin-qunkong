/** 计算虚表可见窗口，避免把全量行挂到 DOM。 */
export function calcVirtualWindow(input: {
  scrollTop: number
  viewportHeight: number
  rowHeight: number
  rowCount: number
  overscan?: number
}) {
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

  return {
    scrollTop: clampedScroll,
    maxScroll,
    startIndex,
    endIndex,
    totalHeight,
  }
}

/** 在「勾选 key 始终是当前 rows 子集」前提下判断表头勾选态。 */
export function calcHeaderSelectionState(rowCount: number, selectedCount: number) {
  const allSelected = rowCount > 0 && selectedCount >= rowCount
  const someSelected = selectedCount > 0 && !allSelected
  return { allSelected, someSelected }
}
