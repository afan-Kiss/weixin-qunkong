<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { calcHeaderSelectionState, calcVirtualWindow } from '../../utils/virtualTableWindow'

export type VirtualColumn = {
  key: string
  label: string
  width?: number
  minWidth?: number
  flex?: number
}

const props = withDefaults(defineProps<{
  rows: Array<Record<string, unknown> & { rowKey: string }>
  columns: VirtualColumn[]
  selectedKeys: string[]
  height?: number
  rowHeight?: number
  emptyText?: string
}>(), {
  height: 360,
  rowHeight: 40,
  emptyText: '暂无数据',
})

const emit = defineEmits<{
  'update:selectedKeys': [keys: string[]]
  'select-all': [selected: boolean]
  'toggle-row': [rowKey: string, selected: boolean]
}>()

const bodyRef = ref<HTMLElement | null>(null)
const headerRef = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const overscan = 10

const selectedSet = computed(() => new Set(props.selectedKeys))

/**
 * 父层保证 selectedKeys ⊆ 当前 rows。
 * 先用长度短路，避免 2000+ 行每次点选都全表 every。
 */
const allSelected = computed(() => {
  const rowCount = props.rows.length
  const selectedCount = props.selectedKeys.length
  if (!calcHeaderSelectionState(rowCount, selectedCount).allSelected) return false
  return props.rows.every((row) => selectedSet.value.has(row.rowKey))
})
const someSelected = computed(() => props.selectedKeys.length > 0 && !allSelected.value)

const windowState = computed(() => calcVirtualWindow({
  scrollTop: scrollTop.value,
  viewportHeight: props.height,
  rowHeight: props.rowHeight,
  rowCount: props.rows.length,
  overscan,
}))

const totalHeight = computed(() => windowState.value.totalHeight)
const startIndex = computed(() => windowState.value.startIndex)
const endIndex = computed(() => windowState.value.endIndex)

const visibleRows = computed(() => {
  const start = startIndex.value
  const end = endIndex.value
  const slice = props.rows.slice(start, end)
  return slice.map((row, offset) => ({
    row,
    top: (start + offset) * props.rowHeight,
    index: start + offset,
  }))
})

function onScroll() {
  const el = bodyRef.value
  if (!el) return
  scrollTop.value = el.scrollTop
  if (headerRef.value) headerRef.value.scrollLeft = el.scrollLeft
}

function onHeaderCheck(checked: boolean | string | number) {
  emit('select-all', Boolean(checked))
}

function onRowCheck(rowKey: string, checked: boolean | string | number) {
  emit('toggle-row', rowKey, Boolean(checked))
}

function cellText(row: Record<string, unknown>, key: string) {
  const value = row[key]
  return value == null ? '' : String(value)
}

function columnStyle(col: VirtualColumn) {
  return {
    width: col.width ? `${col.width}px` : undefined,
    minWidth: `${col.minWidth || col.width || 100}px`,
    flex: col.flex ?? (col.width ? `0 0 ${col.width}px` : '1 1 auto'),
  }
}

async function syncScrollToDom() {
  await nextTick()
  const el = bodyRef.value
  if (!el) {
    scrollTop.value = 0
    if (headerRef.value) headerRef.value.scrollLeft = 0
    return
  }
  const maxScroll = Math.max(0, totalHeight.value - props.height)
  const next = Math.min(Math.max(0, scrollTop.value), maxScroll)
  if (el.scrollTop !== next) el.scrollTop = next
  scrollTop.value = next
  if (headerRef.value) headerRef.value.scrollLeft = el.scrollLeft
}

watch(() => [props.rows.length, props.rowHeight, props.height] as const, () => {
  // 过滤/空表切换后 body 可能重建；夹紧滚动并写回 DOM，避免空白窗
  void syncScrollToDom()
})
</script>

<template>
  <div class="virt-table" :style="{ '--virt-row-h': `${rowHeight}px` }">
    <div ref="headerRef" class="virt-header">
      <div class="virt-header-inner">
        <div class="virt-cell check">
          <el-checkbox
            :model-value="allSelected"
            :indeterminate="someSelected"
            :disabled="!rows.length"
            @change="onHeaderCheck"
          />
        </div>
        <div
          v-for="col in columns"
          :key="col.key"
          class="virt-cell"
          :style="columnStyle(col)"
        >
          {{ col.label }}
        </div>
      </div>
    </div>

    <div v-if="!rows.length" class="virt-empty">{{ emptyText }}</div>
    <div
      v-else
      ref="bodyRef"
      class="virt-body"
      :style="{ height: `${height}px` }"
      @scroll.passive="onScroll"
    >
      <div class="virt-spacer" :style="{ height: `${totalHeight}px` }">
        <div
          v-for="item in visibleRows"
          :key="item.row.rowKey"
          class="virt-row"
          :class="{ 'is-odd': item.index % 2 === 1, 'is-selected': selectedSet.has(item.row.rowKey) }"
          :style="{ transform: `translateY(${item.top}px)` }"
        >
          <div class="virt-cell check" @click.stop>
            <el-checkbox
              :model-value="selectedSet.has(item.row.rowKey)"
              @change="onRowCheck(item.row.rowKey, $event)"
            />
          </div>
          <div
            v-for="col in columns"
            :key="col.key"
            class="virt-cell"
            :title="cellText(item.row, col.key)"
            :style="columnStyle(col)"
          >
            <slot :name="`cell-${col.key}`" :row="item.row" :value="cellText(item.row, col.key)">
              {{ cellText(item.row, col.key) }}
            </slot>
          </div>
        </div>
      </div>
    </div>
    <div class="virt-footer muted">
      共 {{ rows.length }} 行 · 已勾选 {{ selectedKeys.length }} · 仅渲染可见区域防卡顿
    </div>
  </div>
</template>

<style scoped>
.virt-table {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  min-width: 0;
}

.virt-header {
  overflow: hidden;
  background: #f7f8fa;
  border-bottom: 1px solid var(--app-border);
}

.virt-header-inner,
.virt-row {
  display: flex;
  align-items: stretch;
  width: 100%;
  box-sizing: border-box;
}

.virt-header-inner {
  height: var(--virt-row-h);
  font-size: 12px;
  color: var(--app-text-secondary);
  font-weight: 600;
}

.virt-body {
  overflow: auto;
  position: relative;
}

.virt-spacer {
  position: relative;
  width: 100%;
}

.virt-row {
  position: absolute;
  left: 0;
  top: 0;
  height: var(--virt-row-h);
  overflow: hidden;
  border-bottom: 1px solid #eef0f2;
  will-change: transform;
}

.virt-row.is-odd {
  background: #fafbfc;
}

.virt-row.is-selected {
  background: #eef8f6;
}

.virt-cell {
  display: flex;
  align-items: center;
  padding: 0 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--app-text);
  box-sizing: border-box;
  min-width: 0;
}

.virt-cell.check {
  flex: 0 0 48px;
  width: 48px;
  min-width: 48px;
  justify-content: center;
  padding: 0;
}

.virt-empty {
  height: 160px;
  display: grid;
  place-items: center;
  color: var(--app-text-secondary);
  font-size: 13px;
}

.virt-footer {
  padding: 6px 10px;
  border-top: 1px solid var(--app-border);
  font-size: 12px;
  background: #fcfdfd;
}
</style>
