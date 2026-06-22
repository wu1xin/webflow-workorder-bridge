// 同步接口（需求文档 §6 同步）：
//   - GET  /api/sync/status  同步进度快照
//   - POST /api/sync         手动触发同步（可选指定起点时间戳 since），防并发
import type { FastifyInstance } from 'fastify'
import type { SyncProgress } from '../sync/types.js'
import type { AppContext } from './context.js'

export function registerSyncRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get('/api/sync/status', async (): Promise<SyncProgress> => {
        return ctx.sync.getStatus()
    })

    app.post<{ Body: { since?: number } }>('/api/sync', async (req, reply) => {
        const since = req.body?.since
        if (since !== undefined && (typeof since !== 'number' || !Number.isFinite(since) || since < 0)) {
            return reply.code(400).send({ error: 'since 须为非负秒级时间戳' })
        }
        const { accepted, status } = ctx.sync.triggerManual({ since })
        if (!accepted) {
            // 已有同步在进行：防并发，返回 409 + 当前进度
            return reply.code(409).send({ error: '已有同步在进行中', status })
        }
        return { accepted, status }
    })
}
