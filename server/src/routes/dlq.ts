// 死信最小档：列 dead 行（复用 queue.list 的 status 过滤）+ 单条重投。
import type { FastifyInstance } from 'fastify'
import { WEFLOW_CHANNEL_ID } from '../weflow/adapter.js'
import type { AppContext } from './context.js'

export function registerDlqRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get<{ Querystring: { page?: string, pageSize?: string } }>('/api/dlq', async (req) => {
        const page = Math.max(1, Number(req.query.page ?? 1))
        const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)))
        const { items, total } = ctx.db.queue.list(WEFLOW_CHANNEL_ID, { status: 'dead' }, pageSize, (page - 1) * pageSize)
        return { items, total, page, pageSize }
    })

    app.post<{ Params: { id: string } }>('/api/dlq/:id/retry', async (req, reply) => {
        const id = Number(req.params.id)
        if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id 非法' })
        const ok = ctx.db.queue.retryDead(WEFLOW_CHANNEL_ID, id, Math.floor(Date.now() / 1000))
        if (!ok) return reply.code(404).send({ error: '死信不存在或已非 dead' })
        ctx.forwarder.kick()
        return { ok: true }
    })
}
