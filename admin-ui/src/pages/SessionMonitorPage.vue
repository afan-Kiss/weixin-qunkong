<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import PageHeader from '../components/app/PageHeader.vue'
import { instances, refreshInstances } from '../stores/wechatData'

const instanceId = ref('')
const rows = ref<Array<{ time: string; data: unknown }>>([])
const keyword = ref('')
const loading = ref(false)
const filteredRows = computed(() => rows.value.filter((row) => !keyword.value || JSON.stringify(row.data).toLowerCase().includes(keyword.value.toLowerCase())))
let unsubscribe: (() => void) | undefined
async function load() { loading.value = true; await refreshInstances(); instanceId.value ||= instances.value[0]?.id ?? ''; rows.value = instanceId.value ? await window.wxControl?.listEvents(instanceId.value) ?? [] : []; loading.value = false }
onMounted(() => { load(); unsubscribe = window.wxControl?.onEvent((payload) => { if (!instanceId.value || payload.instanceId === instanceId.value) rows.value.unshift({ time: new Date().toISOString(), data: payload.event }) }) })
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <div class="app-page">
    <PageHeader title="会话监控" subtitle="查看每个微信收到的最新消息和通知。" />
    <div class="toolbar-row app-card tool">
      <div class="toolbar-left">
        <el-select v-model="instanceId" placeholder="选择微信" style="width:280px" @change="load"><el-option v-for="item in instances" :key="item.id" :label="item.nickname || item.accountWxid || '待登录微信'" :value="item.id" /></el-select>
        <el-input v-model="keyword" clearable placeholder="搜索事件内容" style="width:280px" />
        <el-button type="primary" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>
    <section class="app-card block">
      <el-table :data="filteredRows" stripe height="560" v-loading="loading">
        <el-table-column prop="time" label="接收时间" width="190" show-overflow-tooltip />
        <el-table-column label="所属微信" min-width="180" show-overflow-tooltip><template #default>{{ instances.find((item) => item.id === instanceId)?.nickname || '待登录微信' }}</template></el-table-column>
        <el-table-column label="消息内容" min-width="420" show-overflow-tooltip><template #default="{ row }">{{ JSON.stringify(row.data) }}</template></el-table-column>
      </el-table>
    </section>
  </div>
</template>

<style scoped>.tool,.block{padding:14px 16px;min-width:0;overflow:hidden}</style>
