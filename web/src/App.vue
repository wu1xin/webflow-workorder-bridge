<template>
    <el-container class="app">
        <el-aside
            width="220px"
            class="aside"
        >
            <div class="brand">
                <img
                    :src="logoUrl"
                    alt="WeFlow 桥接"
                    class="brand_logo"
                />
                <span class="brand_name">WeFlow 桥接</span>
            </div>
            <el-scrollbar class="aside_scroll">
                <el-menu
                    :default-active="activeMenu"
                    router
                >
                    <el-menu-item
                        v-for="m in menus"
                        :key="m.path"
                        :index="m.path"
                    >
                        {{ m.label }}
                    </el-menu-item>
                </el-menu>
            </el-scrollbar>
        </el-aside>
        <el-container>
            <el-main class="main">
                <el-scrollbar>
                    <div class="main_inner">
                        <router-view />
                    </div>
                </el-scrollbar>
            </el-main>
        </el-container>
    </el-container>
</template>

<script setup lang="ts">
import logoUrl from '@/assets/logo.png'
import { useRoute } from 'vue-router'
import { useConfigStore } from '@/stores/config'
import { computed, onBeforeUnmount, onMounted } from 'vue'

const route = useRoute()
const activeMenu = computed(() => route.path)

// 全局常驻订阅 WeFlow 连接状态实时流：根组件挂载即连，整个应用共享
const configStore = useConfigStore()
onMounted(() => configStore.connectStatusStream())
onBeforeUnmount(() => configStore.disconnectStatusStream())

const menus = [
    { path: '/', label: '总览/状态' },
    { path: '/config', label: '配置' },
    { path: '/test', label: '测试与诊断' },
    { path: '/logs', label: '日志/审计' },
    { path: '/dlq', label: '死信队列' },
]
</script>

<style scoped lang="scss">
.app {
    height: 100vh;
}

.aside {
    display: flex;
    flex-direction: column;
    box-shadow: 0px 0 5px rgba(0, 0, 0, 0.1);
    .el-menu {
        border-right: none;
    }
}

.aside_scroll {
    flex: 1;
    min-height: 0;
}

.main {
    // el-main 默认 overflow: auto + padding: 20px，
    // 这里关掉自身溢出（滚动交给内部 el-scrollbar），并清空 padding
    padding: 0;
    overflow: hidden;
    .el-scrollbar {
        height: 100%;
    }
}

.main_inner {
    // 原本 el-main 的内边距挪到滚动内容上，让滚动条贴边显示
    padding: 20px;
}

.brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 18px 20px;
    border-bottom: 1px solid #e4e7ed;
    .brand_logo {
        width: 28px;
        height: 28px;
        flex-shrink: 0;
    }
    .brand_name {
        white-space: nowrap;
        font-weight: 600;
        font-size: 16px;
    }
}

.header {
    display: flex;
    align-items: center;
    font-weight: 600;
    border-bottom: 1px solid #e4e7ed;
}
</style>
