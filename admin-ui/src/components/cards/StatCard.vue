<script setup lang="ts">
import { computed } from 'vue'
import * as Icons from '@element-plus/icons-vue'

const props = withDefaults(
  defineProps<{
    title: string
    value: string
    sub?: string
    icon?: string
    tone?: 'primary' | 'info' | 'warning' | 'danger' | 'success'
  }>(),
  { tone: 'primary', sub: '', icon: 'DataAnalysis' },
)

const iconComp = computed(() => (Icons as Record<string, unknown>)[props.icon] || Icons.DataAnalysis)
</script>

<template>
  <div class="stat-card app-card" :data-tone="tone">
    <div class="stat-card__icon">
      <el-icon :size="20"><component :is="iconComp" /></el-icon>
    </div>
    <div class="stat-card__body">
      <div class="stat-card__title">{{ title }}</div>
      <div class="stat-card__value ellip" :title="value">{{ value }}</div>
      <div v-if="sub" class="stat-card__sub ellip" :title="sub">{{ sub }}</div>
    </div>
  </div>
</template>

<style scoped>
.stat-card {
  display: flex;
  gap: 14px;
  align-items: flex-start;
  padding: 16px 18px;
  min-height: 108px;
  min-width: 0;
  overflow: hidden;
}

.stat-card__icon {
  width: 40px;
  height: 40px;
  border-radius: 10px;
  display: grid;
  place-items: center;
  flex-shrink: 0;
  background: rgba(20, 184, 166, 0.12);
  color: var(--app-primary);
}

.stat-card[data-tone='info'] .stat-card__icon {
  background: rgba(59, 130, 246, 0.12);
  color: var(--app-info);
}
.stat-card[data-tone='warning'] .stat-card__icon {
  background: rgba(245, 158, 11, 0.14);
  color: var(--app-warning);
}
.stat-card[data-tone='danger'] .stat-card__icon {
  background: rgba(239, 68, 68, 0.12);
  color: var(--app-danger);
}
.stat-card[data-tone='success'] .stat-card__icon {
  background: rgba(34, 197, 94, 0.12);
  color: var(--app-success);
}

.stat-card__body {
  min-width: 0;
  flex: 1;
}

.stat-card__title {
  color: var(--app-text-secondary);
  font-size: 13px;
}

.stat-card__value {
  margin-top: 6px;
  font-size: 24px;
  font-weight: 700;
  color: var(--app-text);
  line-height: 1.2;
}

.stat-card__sub {
  margin-top: 8px;
  font-size: 12px;
  color: var(--app-text-secondary);
}
</style>
