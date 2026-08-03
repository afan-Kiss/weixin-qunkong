<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ text: string }>()

const type = computed(() => {
  const t = props.text
  if (['在线', '已登录', '已完成', '已添加', '已入群', '保存成功', '成功', '正常', '风险低', '已保存'].includes(t)) {
    return 'success'
  }
  if (['执行中', '同步中', '保存中', '信息', '恢复中', '仅归档'].includes(t)) return 'info'
  if (['待执行', '待登录', '启动中', '未登录', '未添加', '待识别', '未保存', '已暂停', '警告', '风险中'].includes(t)) {
    return 'warning'
  }
  if (
    ['已经频繁', '频繁暂停', '频繁中止', '异常', '风险高', '保存失败', '识别失败', '错误', '离线', '已停止', '已过滤', '无效'].includes(t)
  ) {
    return 'danger'
  }
  return 'info'
})
</script>

<template>
  <el-tag :type="type" effect="light" round size="small" class="status-tag">{{ text }}</el-tag>
</template>

<style scoped>
.status-tag {
  border: none;
  max-width: 100%;
}
</style>
