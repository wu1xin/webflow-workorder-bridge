/**
 * WeFlow → work-order-system 桥接服务 —— HTTP 入口（脚手架骨架）
 *
 * 本文件仅是可运行的最小框架：起一个 Fastify 服务、暴露健康检查与状态占位接口，
 * 生产环境托管 Vue 构建产物（web/dist）。真实业务逻辑（SSE 接入、转发、补偿、
 * 心跳、持久化等，见 docs/plans/2026-06-17-weflow-bridge-v2-需求与架构设计.md）
 * 尚未实现，后续按模块补齐。
 */
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))

const HOST = process.env.HOST ?? '0.0.0.0'
const PORT = Number(process.env.PORT ?? 8787)

const app = Fastify({ logger: true })

// 健康检查（脚手架占位，对应 FR-MON-04 本地 /healthz）
app.get('/healthz', async () => ({ status: 'ok' }))

// 状态快照（脚手架占位，对应需求文档 §6 GET /api/status；字段为占位值，真实状态后续实现）
app.get('/api/status', async () => ({
  sse: 'disconnected',
  weflowHealth: 'unknown',
  forwarding: false,
  breakpointTimestamp: null,
  queueBacklog: 0,
  dlqCount: 0,
  uptimeSec: Math.floor(process.uptime()),
}))

// 生产环境：托管 Vue 构建产物（web/dist）。开发期前端走 Vite dev server（见 web/vite.config.ts 的 /api 代理）。
const webDist = join(here, '../../web/dist')
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
  // SPA 回退：非 API 路由统一回 index.html，交给前端路由
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api') || req.url.startsWith('/healthz')) {
      reply.code(404).send({ error: 'Not Found' })
      return
    }
    reply.sendFile('index.html')
  })
}

try {
  await app.listen({ host: HOST, port: PORT })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
