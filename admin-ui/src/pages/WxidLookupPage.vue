<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { userErrorMessage } from '../utils/error'
import { useRoute } from 'vue-router'
import { callWechat, listInstances, type WechatInstance } from '../services/wechat'

const instances = ref<WechatInstance[]>([])
const instanceId = ref('')
const route = useRoute()
const kind = ref<'friends' | 'groups' | 'search' | 'member'>('friends')
const query = ref('')
const roomId = ref('')
const loading = ref(false)
const result = ref<unknown>(null)
const activeInstance = computed(() => instances.value.find((item) => item.id === instanceId.value))

onMounted(async () => { instances.value = await listInstances(); instanceId.value = instances.value[0]?.id ?? ''; if (typeof route.query.q === 'string') { kind.value = 'search'; query.value = route.query.q } })
async function search() {
  if (!activeInstance.value) return ElMessage.warning('请选择微信')
  if (['search', 'member'].includes(kind.value) && !query.value.trim()) return ElMessage.warning('请输入查询内容')
  if (kind.value === 'member' && !roomId.value.trim()) return ElMessage.warning('请输入群聊标识')
  loading.value = true
  const response = kind.value === 'friends'
    ? await callWechat(activeInstance.value, '/api/get_contact_list2', {}, 438557598)
    : kind.value === 'groups'
      ? await callWechat(activeInstance.value, '/api/get_chatroom_list', {}, 438557576)
      : kind.value === 'member'
        ? await callWechat(activeInstance.value, '/api/get_group_member_contact', { wxid: query.value.trim(), roomId: roomId.value.trim() }, 438557510)
        : await callWechat(activeInstance.value, '/api/net_scene_search_contact', { search: query.value.trim() }, 438557506)
  result.value = response.raw ?? response.data ?? userErrorMessage(response.error, '查询微信资料失败')
  loading.value = false
  if (!response.ok) ElMessage.error(userErrorMessage(response.error, '查询微信资料失败'))
}
</script>

<template>
  <div class="page-shell">
    <div class="page-heading"><div><h1>微信 ID 查询</h1><p>查询好友微信 ID、群聊标识和群成员资料。</p></div></div>
    <el-card shadow="never" class="lookup-panel">
      <el-form label-position="top" @submit.prevent="search">
        <div class="lookup-grid">
          <el-form-item label="微信"><el-select v-model="instanceId" placeholder="选择微信"><el-option v-for="item in instances" :key="item.id" :label="item.nickname || item.accountWxid || '待登录微信'" :value="item.id" /></el-select></el-form-item>
          <el-form-item label="查询类型"><el-select v-model="kind"><el-option label="全部好友微信 ID" value="friends" /><el-option label="全部群聊标识" value="groups" /><el-option label="微信号 / 手机号搜索" value="search" /><el-option label="指定群成员资料" value="member" /></el-select></el-form-item>
          <el-form-item v-if="kind === 'member'" label="群聊标识" class="query-field"><el-input v-model="roomId" clearable placeholder="输入群聊标识" /></el-form-item>
          <el-form-item v-if="kind === 'member' || kind === 'search'" :label="kind === 'member' ? '成员微信 ID' : '微信号 / 手机号'" class="query-field"><el-input v-model="query" clearable placeholder="输入查询内容" @keyup.enter="search" /></el-form-item>
          <el-form-item label="操作"><el-button type="primary" :loading="loading" :disabled="!activeInstance" @click="search">查询</el-button></el-form-item>
        </div>
      </el-form>
    </el-card>
    <el-card shadow="never" class="result-panel"><template #header><div class="panel-title">查询结果</div></template><el-empty v-if="!result" description="输入条件后查询" /><pre v-else>{{ JSON.stringify(result, null, 2) }}</pre></el-card>
  </div>
</template>

<style scoped>
.lookup-grid{display:grid;grid-template-columns:minmax(180px,1fr) minmax(260px,1.4fr) minmax(280px,2fr) auto;gap:16px;align-items:end}.lookup-grid :deep(.el-form-item){margin-bottom:0}.query-field{min-width:0}.result-panel{margin-top:16px}.result-panel pre{max-height:520px;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#f7f8fa;padding:16px;border-radius:6px}.panel-title{font-weight:600}@media(max-width:900px){.lookup-grid{grid-template-columns:1fr 1fr}.query-field{grid-column:1/-1}}
</style>
