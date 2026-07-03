// 控制接口：POST /api/control/reconnect（手动重连，FR-CONN-09 / 配置说明 §8）。
import type { FastifyInstance } from 'fastify'
import type { WeflowConnectionStatus } from '../weflow/types.js'
import type { AppContext } from './context.js'

export function registerControlRoutes(app: FastifyInstance, ctx: AppContext): void {
    // 手动触发一次重连（异步执行），立即返回当前状态快照
    app.post('/api/control/reconnect', async (): Promise<{ status: WeflowConnectionStatus }> => {
        ctx.manager.manualReconnect()
        return { status: ctx.manager.getStatus() }
    })

    // 转发总开关：校验 enabled 为布尔后再置位（避免空/错体误关转发），返回生效后的转发状态
    app.post<{ Body: { enabled: boolean } }>('/api/control/forwarding', async (req, reply) => {
        if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: '缺少 enabled（布尔）' })
        ctx.forwarder.setEnabled(req.body.enabled)
        return { forwarding: ctx.forwarder.isEnabled() }
    })
}
