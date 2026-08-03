<script setup lang="ts">
defineProps<{
  title: string
}>()
</script>

<template>
  <aside class="detail-panel app-card">
    <div class="detail-panel__head">
      <h3 class="ellip" :title="title">{{ title }}</h3>
      <div class="detail-panel__actions">
        <slot name="actions" />
      </div>
    </div>
    <div class="detail-panel__body panel-scroll">
      <slot />
    </div>
  </aside>
</template>

<style scoped>
.detail-panel {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  min-height: 0;
  max-height: 100%;
  overflow: hidden;
}

.detail-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--app-border);
  flex-shrink: 0;
}

.detail-panel__head h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 650;
  min-width: 0;
}

.detail-panel__actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.detail-panel__body {
  padding: 16px;
  flex: 1;
  min-height: 0;
}
</style>
