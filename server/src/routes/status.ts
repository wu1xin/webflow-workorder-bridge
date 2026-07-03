// 状态接口：GET /api/status —— 状态快照（需求文档 §6）。
// WeFlow 上游连接、转发开关/熔断、断点、队列积压/死信、审计成功失败计数、运行时长均为实时值。
import type { FastifyInstance } from 'fastify'
import type { WeflowConnectionStatus } from '../weflow/types.js'
import { WEFLOW_CHANNEL_ID } from '../weflow/adapter.js'
import type { AppContext } from './context.js'

interface StatusSnapshot {
    /** WeFlow 上游连接实时状态（FR-CONN-06） */
    weflow: WeflowConnectionStatus
    /** 转发总开关 */
    forwarding: boolean
    /** 下游熔断状态（closed/open/half-open） */
    circuitState: string
    /** 最后成功转发断点 */
    breakpointTimestamp: number | null
    /** 队列积压（pending） */
    queueBacklog: number
    /** 死信数（dead） */
    dlqCount: number
    /** 累计成功转发数 */
    totalSuccess: number
    /** 累计失败转发数 */
    totalFail: number
    /** 运行时长（秒） */
    uptimeSec: number
}

export function registerStatusRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get('/api/status', async (): Promise<StatusSnapshot> => {
        const stats = ctx.db.audit.stats(WEFLOW_CHANNEL_ID)
        return {
            weflow: ctx.manager.getStatus(),
            forwarding: ctx.forwarder.isEnabled(),
            circuitState: ctx.forwarder.circuitState(),
            breakpointTimestamp: ctx.db.channelState.get(WEFLOW_CHANNEL_ID)?.breakpointTimestamp ?? null,
            queueBacklog: ctx.db.queue.countByStatus('pending'),
            dlqCount: ctx.db.queue.countByStatus('dead'),
            totalSuccess: stats.totalSuccess,
            totalFail: stats.totalFail,
            uptimeSec: Math.floor(process.uptime()),
        }
    })
}
