// WeFlow 群组接口：
//   - GET  /api/weflow/groups        群列表（只读，全量；筛选由前端做）
//   - POST /api/weflow/groups/sync   手动「立即同步群」：拉会话 → 群同步 → 回报总数/放行数
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
}
