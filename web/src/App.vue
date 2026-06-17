<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const activeMenu = computed(() => route.path)

const menus = [
  { path: '/', label: '总览/状态' },
  { path: '/config', label: '配置' },
  { path: '/test', label: '测试与诊断' },
  { path: '/logs', label: '日志/审计' },
  { path: '/dlq', label: '死信队列' },
]
</script>

<template>
  <el-container class="app">
    <el-aside width="220px" class="aside">
      <div class="brand">WeFlow 桥接</div>
      <el-menu :default-active="activeMenu" router>
        <el-menu-item v-for="m in menus" :key="m.path" :index="m.path">
          {{ m.label }}
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="header">WeFlow → work-order-system 消息转发桥接服务</el-header>
      <el-main>
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<style scoped>
.app {
  height: 100vh;
}
.aside {
  background: #1f2d3d;
}
.brand {
  color: #fff;
  font-weight: 600;
  padding: 18px 20px;
  font-size: 16px;
}
.aside :deep(.el-menu) {
  border-right: none;
}
.header {
  display: flex;
  align-items: center;
  font-weight: 600;
  border-bottom: 1px solid #e4e7ed;
}
</style>
