<template>
  <el-card>
    <template #header>
      <div class="config_header">
        <span>上游（WeFlow）</span>
      </div>
    </template>
    <WeflowConfigForm />
  </el-card>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import WeflowConfigForm from '@/components/config/WeflowConfigForm.vue'
import { useConfigStore } from '@/stores/config'

const store = useConfigStore()

onMounted(() => {
  void store.load()
})
</script>

<style scoped lang="scss">
.config_header {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
}
</style>
