// WeFlow 消息接口（数据源 queue 表）：
//   - GET /api/weflow/messages      服务端分页 + 四维过滤（会话/状态/含媒体/采集路径）
//   - GET /api/weflow/messages/:id  单条详情（含 raw_json，供弹窗排障）
import type { FastifyInstance } from 'fastify'
import type { WeflowMessagePage, WeflowMessageStatus, WeflowIngestPath } from '@wb/shared/types'
import type { QueueListFilter } from '../db/queue.js'
import { WEFLOW_CHANNEL_ID } from '../weflow/adapter.js'
import type { AppContext } from './context.js'

const STATUSES: readonly WeflowMessageStatus[] = ['pending', 'sending', 'done', 'dead']
const INGEST_PATHS: readonly WeflowIngestPath[] = ['sse', 'catchup']
const PAGE_SIZE_MAX = 100
const PAGE_SIZE_DEFAULT = 20

interface ListQuery {
    conversationId?: string
    status?: string
    hasMedia?: string
    ingestPath?: string
    page?: string
    pageSize?: string
}

/** 解析正整数；非法返回 null */
function parsePositiveInt(raw: string | undefined): number | null {
    if (raw === undefined) return null
    const n = Number(raw)
    return Number.isInteger(n) && n > 0 ? n : null
}

export function registerMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get<{ Querystring: ListQuery }>('/api/weflow/messages', async (req, reply): Promise<WeflowMessagePage> => {
        const q = req.query

        const page = q.page === undefined ? 1 : parsePositiveInt(q.page)
        if (page === null) return reply.code(400).send({ error: 'page 须为正整数' })

        const pageSize = q.pageSize === undefined ? PAGE_SIZE_DEFAULT : parsePositiveInt(q.pageSize)
        if (pageSize === null || pageSize > PAGE_SIZE_MAX) {
            return reply.code(400).send({ error: `pageSize 须为 1~${PAGE_SIZE_MAX} 的整数` })
        }

        if (q.status !== undefined && !STATUSES.includes(q.status as WeflowMessageStatus)) {
            return reply.code(400).send({ error: `status 取值须为 ${STATUSES.join('|')}` })
        }
        if (q.ingestPath !== undefined && !INGEST_PATHS.includes(q.ingestPath as WeflowIngestPath)) {
            return reply.code(400).send({ error: `ingestPath 取值须为 ${INGEST_PATHS.join('|')}` })
        }
        if (q.hasMedia !== undefined && q.hasMedia !== '0' && q.hasMedia !== '1') {
            return reply.code(400).send({ error: 'hasMedia 取值须为 0 或 1' })
        }

        const filter: QueueListFilter = {
            conversationId: q.conversationId,
            status: q.status as WeflowMessageStatus | undefined,
            hasMedia: q.hasMedia === undefined ? undefined : (Number(q.hasMedia) as 0 | 1),
            ingestPath: q.ingestPath as WeflowIngestPath | undefined,
        }
        const { items, total } = ctx.db.queue.list(WEFLOW_CHANNEL_ID, filter, pageSize, (page - 1) * pageSize)
        return { items, total, page, pageSize }
    })

    app.get<{ Params: { id: string } }>('/api/weflow/messages/:id', async (req, reply) => {
        const id = parsePositiveInt(req.params.id)
        if (id === null) return reply.code(400).send({ error: 'id 须为正整数' })
        const message = ctx.db.queue.getById(WEFLOW_CHANNEL_ID, id)
        if (!message) return reply.code(404).send({ error: '消息不存在' })
        return message
    })
}
