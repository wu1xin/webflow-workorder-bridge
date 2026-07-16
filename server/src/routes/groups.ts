// WeFlow 群组接口：
//   - GET  /api/weflow/groups                 群列表（只读，全量；筛选由前端做）
//   - POST /api/weflow/groups/sync            手动「立即同步群」：拉会话 → 群同步 → 回报总数/放行数
//   - POST /api/weflow/groups/reset-all       全部清空重拉（开发/测试）：清空 queue+dedup+水位 → 全量重灌
//   - POST /api/weflow/groups/:id/reset       单群清空重拉（开发/测试）：清该群 queue+dedup → 从 0 定向重拉
import type { FastifyInstance } from 'fastify'
import type { WeflowGroup } from '@wb/shared/types'
import { WEFLOW_CHANNEL_ID } from '../weflow/adapter.js'
import type { AppContext } from './context.js'

export function registerGroupRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get('/api/weflow/groups', async (): Promise<WeflowGroup[]> => {
        return ctx.db.chatGroup.listAll(WEFLOW_CHANNEL_ID)
    })

    app.post('/api/weflow/groups/sync', async (_req, reply) => {
        const result = await ctx.sync.syncGroupsNow()
        if (!result.ok) {
            // 未配下游 / 上游不可达 / 正在同步 —— 同步未完成，返回 503
            return reply.code(503).send(result)
        }
        return result
    })

    // 全部清空重拉（与 /:id/reset 段数不同、不冲突；Fastify 静态路由本就优先于参数路由）
    app.post('/api/weflow/groups/reset-all', async (_req, reply) => {
        const { accepted, status } = ctx.sync.resetAllAndFullSync()
        if (!accepted) {
            // 已有同步在进行：防并发，返回 409 + 当前进度
            return reply.code(409).send({ error: '已有同步在进行中', status })
        }
        return { accepted, status }
    })

    app.post<{ Params: { id: string } }>('/api/weflow/groups/:id/reset', async (req, reply) => {
        const { accepted, status } = ctx.sync.resetGroup(req.params.id)
        if (!accepted) {
            // 已有同步在进行：防并发，返回 409 + 当前进度
            return reply.code(409).send({ error: '已有同步在进行中', status })
        }
        return { accepted, status }
    })
}
