<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ points: number[] }>()

const path = computed(() => {
  const pts = props.points
  if (!pts.length) return ''
  const w = 560
  const h = 180
  const max = Math.max(...pts)
  const min = Math.min(...pts)
  const span = max - min || 1
  return pts
    .map((v, i) => {
      const x = (i / (pts.length - 1)) * w
      const y = h - ((v - min) / span) * (h - 20) - 10
      return `${i === 0 ? 'M' : 'L'}${x},${y}`
    })
    .join(' ')
})
</script>

<template>
  <div class="trend-chart">
    <svg v-if="points.length" viewBox="0 0 560 180" preserveAspectRatio="none" class="trend-chart__svg">
      <defs>
        <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="rgba(20,184,166,0.28)" />
          <stop offset="100%" stop-color="rgba(20,184,166,0.02)" />
        </linearGradient>
      </defs>
      <path :d="`${path} L560,180 L0,180 Z`" fill="url(#trendFill)" />
      <path :d="path" fill="none" stroke="#14B8A6" stroke-width="2.5" />
    </svg>
    <div v-else class="trend-chart__empty muted">今天暂无可聚合的活动记录</div>
    <div v-if="points.length" class="trend-chart__hint muted">今天每小时本机活动记录</div>
  </div>
</template>

<style scoped>
.trend-chart {
  width: 100%;
  min-height: 220px;
}

.trend-chart__svg {
  width: 100%;
  height: 180px;
  display: block;
  background: linear-gradient(180deg, #fbfbfc 0%, #f7f8fa 100%);
  border: 1px solid var(--app-border);
  border-radius: 8px;
}

.trend-chart__hint {
  margin-top: 8px;
  font-size: 12px;
}
.trend-chart__empty { height: 180px; display: grid; place-items: center; border: 1px dashed var(--app-border); border-radius: 8px; }
</style>
