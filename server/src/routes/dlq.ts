// 死信最小档：列 dead 行（复用 queue.list 的 status 过滤）+ 单条重投。
// 分页/ID 校验复用 pagination.ts 的 parsePositiveInt，非法即 400（与 messages.ts 口径一致）。
import type { FastifyInstance } from 'fastify'
import { WEFLOW_CHANNEL_ID } from '../weflow/adapter.js'
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, parsePositiveInt } from './pagination.js'
import type { AppContext } from './context.js'

export function registerDlqRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get<{ Querystring: { page?: string, pageSize?: string } }>('/api/dlq', async (req, reply) => {
        const page = req.query.page === undefined ? 1 : parsePositiveInt(req.query.page)
        if (page === null) return reply.code(400).send({ error: 'page 须为正整数' })

        const pageSize = req.query.pageSize === undefined ? PAGE_SIZE_DEFAULT : parsePositiveInt(req.query.pageSize)
        if (pageSize === null || pageSize > PAGE_SIZE_MAX) {
            return reply.code(400).send({ error: `pageSize 须为 1~${PAGE_SIZE_MAX} 的整数` })
        }

        const { items, total } = ctx.db.queue.list(WEFLOW_CHANNEL_ID, { status: 'dead' }, pageSize, (page - 1) * pageSize)
        return { items, total, page, pageSize }
    })

    app.post<{ Params: { id: string } }>('/api/dlq/:id/retry', async (req, reply) => {
        const id = parsePositiveInt(req.params.id)
        if (id === null) return reply.code(400).send({ error: 'id 须为正整数' })
        const ok = ctx.db.queue.retryDead(WEFLOW_CHANNEL_ID, id, Math.floor(Date.now() / 1000))
        if (!ok) return reply.code(404).send({ error: '死信不存在或已非 dead' })
        ctx.forwarder.kick()
        return { ok: true }
    })
}
