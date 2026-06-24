import { createRouter, createWebHistory } from 'vue-router'

// 5 个主页面（脚手架占位，对应需求文档 §7）。组件按需懒加载。
const router = createRouter({
    history: createWebHistory(),
    routes: [
        { path: '/', name: 'dashboard', redirect: '/config' },
        // { path: '/', name: 'dashboard', component: () => import('@/pages/DashboardPage.vue'), meta: { title: '总览/状态' } },
        { path: '/config', name: 'config', component: () => import('@/pages/ConfigPage.vue'), meta: { title: '配置' } },
        { path: '/test', name: 'test', component: () => import('@/pages/TestPage.vue'), meta: { title: '测试与诊断' } },
        { path: '/logs', name: 'logs', component: () => import('@/pages/LogsPage.vue'), meta: { title: '日志/审计' } },
        { path: '/dlq', name: 'dlq', component: () => import('@/pages/DlqPage.vue'), meta: { title: '死信队列' } },
    ],
})

export default router
