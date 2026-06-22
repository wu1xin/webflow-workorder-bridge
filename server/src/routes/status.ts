// 状态接口：GET /api/status —— 状态快照（需求文档 §6）。
// 当前仅 WeFlow 上游连接状态为真实值；转发/断点/积压/死信等字段待对应模块落地，暂为占位。
import type { FastifyInstance } from 'fastify'
import type { WeflowConnectionStatus } from '../weflow/types.js'
import type { AppContext } from './context.js'

interface StatusSnapshot {
    /** WeFlow 上游连接实时状态（FR-CONN-06） */
    weflow: WeflowConnectionStatus
    /** 转发总开关（占位） */
    forwarding: boolean
    /** 最后成功转发断点（占位） */
    breakpointTimestamp: number | null
    /** 队列积压（占位） */
    queueBacklog: number
    /** 死信数（占位） */
    dlqCount: number
    /** 运行时长（秒） */
    uptimeSec: number
}

export function registerStatusRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get('/api/status', async (): Promise<StatusSnapshot> => ({
        weflow: ctx.manager.getStatus(),
        forwarding: false,
        breakpointTimestamp: null,
        queueBacklog: ctx.db.queue.countByStatus('pending'),
        dlqCount: ctx.db.queue.countByStatus('dead'),
        uptimeSec: Math.floor(process.uptime()),
    }))
}
