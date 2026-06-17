<script setup lang="ts">
import { ref } from 'vue'

// 脚手架冒烟测试：调后端 /api/status 占位接口，验证前后端联通。非业务逻辑。
const status = ref('')
const loading = ref(false)

async function checkBackend() {
  loading.value = true
  try {
    const res = await fetch('/api/status')
    status.value = JSON.stringify(await res.json(), null, 2)
  } catch (e) {
    status.value = '请求失败：' + (e as Error).message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <el-card>
    <template #header>总览 / 状态（脚手架占位）</template>
    <p>对应需求文档 §7 总览页、FR-MON-02 实时面板、FR-WEB-04 主动同步。功能待实现。</p>
    <el-button type="primary" :loading="loading" @click="checkBackend">
      检查后端连通（GET /api/status）
    </el-button>
    <pre v-if="status" class="status">{{ status }}</pre>
  </el-card>
</template>

<style scoped>
.status {
  background: #f5f7fa;
  padding: 12px;
  border-radius: 6px;
  margin-top: 12px;
  white-space: pre-wrap;
}
</style>
