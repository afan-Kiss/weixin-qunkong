import { onBeforeUnmount, ref, type Ref } from 'vue'

/** 无搜索词时最多渲染条数（保证已选项始终可见） */
export const SELECT_OPTION_LIMIT_IDLE = 80
/** 有搜索词时最多渲染匹配条数 */
export const SELECT_OPTION_LIMIT_SEARCH = 120
/** 已选项在下拉里最多渲染条数；全选 150+ 时避免 DOM 爆炸（标签文案由页面 labelMap 兜底） */
export const SELECTED_OPTION_RENDER_CAP = 24

/**
 * 可搜索下拉：按输入过滤选项，并限制渲染数量，避免群列表过大时打开下拉卡顿。
 * @param options 全部选项（需含 label / value）
 * @param query 用户输入的搜索词
 * @param selectedValues 当前已选值（保证已选项始终在列表里，标签能显示名称）
 * @param limit 最多额外渲染条数（不含已选）
 * @returns 应渲染的选项子集
 */
export function filterSelectOptions<T extends { label: string; value: string }>(
  options: T[],
  query: string,
  selectedValues: string | string[] = [],
  limit = SELECT_OPTION_LIMIT_IDLE,
): T[] {
  const list = Array.isArray(options) ? options : []
  const q = String(query || '').trim().toLowerCase()
  const selected = new Set(
    (Array.isArray(selectedValues) ? selectedValues : [selectedValues])
      .map((item) => String(item || ''))
      .filter(Boolean),
  )
  const maxRest = Math.max(Number(limit) || SELECT_OPTION_LIMIT_IDLE, 1)
  let selectedItems: T[] = []
  for (const item of list) {
    if (selected.has(String(item.value))) selectedItems.push(item)
  }
  // 无搜索且已选很多时，下拉只保留少量已选项，防止全选上百群卡死
  if (!q && selectedItems.length > SELECTED_OPTION_RENDER_CAP) {
    selectedItems = selectedItems.slice(0, SELECTED_OPTION_RENDER_CAP)
  }
  const rest: T[] = []
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

/**
 * 下拉搜索词防抖：输入时延迟写入 query，减少每键一次全量重渲染。
 * @param delayMs 防抖毫秒
 * @returns query / setQuery / clearQuery
 */
export function useSelectSearchQuery(delayMs = 120): {
  query: Ref<string>
  setQuery: (value: string) => void
  clearQuery: () => void
} {
  const query = ref('')
  let timer: ReturnType<typeof setTimeout> | undefined

  /**
   * 更新搜索词（防抖）。
   * @param value 输入框内容
   */
  function setQuery(value: string) {
    const next = String(value || '')
    if (timer) clearTimeout(timer)
    if (!next.trim()) {
      query.value = ''
      return
    }
    timer = setTimeout(() => {
      query.value = next
      timer = undefined
    }, Math.max(0, delayMs))
  }

  /**
   * 清空搜索词（关闭下拉时调用）。
   */
  function clearQuery() {
    if (timer) clearTimeout(timer)
    timer = undefined
    query.value = ''
  }

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer)
  })

  return { query, setQuery, clearQuery }
}
