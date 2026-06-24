import vue from '@vitejs/plugin-vue'
import VueDevTools from 'vite-plugin-vue-devtools'
import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

// 开发期：前端 5170 ，后端 8787；/api 与 /healthz 代理到后端。
// 生产期：`npm run build` 产物在 web/dist，由后端 Fastify 同端口托管。
export default defineConfig({
    plugins: [vue(), VueDevTools()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        port: 5170,
        proxy: {
            '/api': 'http://localhost:8787',
            '/healthz': 'http://localhost:8787',
        },
    },
})
