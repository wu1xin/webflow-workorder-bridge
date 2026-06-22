// 实时流接口：GET /api/stream/status —— 经 SSE 把 WeFlow 连接状态实时下推前端（FR-CONN-06 / 需求文档 §6 实时）。
// 前端用 EventSource('/api/stream/status') 订阅；每条 data 为一份 WeflowConnectionStatus JSON。
import type { FastifyInstance } from 'fastify'
import type { WeflowConnectionStatus } from '../weflow/types.js'
import type { AppContext } from './context.js'

/** 心跳注释间隔（毫秒）：穿过代理保持长连接存活，避免被中间层判空闲断开 */
const HEARTBEAT_MS = 25_000

export function registerStreamRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get('/api/stream/status', (req, reply) => {
        // 接管响应，手动写 SSE 帧（Fastify 不再代发）
        reply.hijack()
        const raw = reply.raw
        raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            // 关闭 Nginx 等代理的响应缓冲，确保即时下推
            'X-Accel-Buffering': 'no',
        })

        const send = (status: WeflowConnectionStatus): void => {
            raw.write(`data: ${JSON.stringify(status)}\n\n`)
        }

        // 先推一份当前快照，前端立即有初值
        send(ctx.manager.getStatus())

        const unsubscribe = ctx.manager.onStatusChange(send)
        const heartbeat = setInterval(() => raw.write(': ping\n\n'), HEARTBEAT_MS)

        const cleanup = (): void => {
            clearInterval(heartbeat)
            unsubscribe()
        }
        req.raw.on('close', cleanup)
        req.raw.on('error', cleanup)
    })
}
