// 测试与诊断接口：POST /api/test/weflow-connect（保存前/后试连，FR-TEST-03）。
// 用待保存（或当前）配置跑一次三级闸门（不保留连接），返回 health/SSE/首事件结果与诊断结论。
import type { FastifyInstance } from 'fastify'
import type { WeflowConfig, WeflowConfigUpdate, WeflowConnectTestResult } from '@wb/shared/types'
import { runConnectionGate } from '../weflow/gate.js'
import { validateWeflowUpdate } from '../config/validate.js'
import type { AppContext } from './context.js'

/** 把待测更新负载与现状合成完整配置：accessToken 缺省时沿用已存 Token */
function resolveConfigForTest(ctx: AppContext, update: WeflowConfigUpdate): WeflowConfig {
    const current = ctx.store.get().weflow
    const token = update.accessToken
    return {
        host: update.host.trim(),
        port: update.port,
        accessToken: token === null || token === undefined ? current.accessToken : token.trim(),
        connectTimeoutSec: update.connectTimeoutSec,
        readTimeoutSec: update.readTimeoutSec,
        firstMessageTimeoutSec: update.firstMessageTimeoutSec,
        healthIntervalSec: update.healthIntervalSec,
        reconnect: { ...update.reconnect },
    }
}

export function registerTestRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.post<{ Body: { weflow?: WeflowConfigUpdate } }>(
        '/api/test/weflow-connect',
        async (req, reply) => {
            const update = req.body?.weflow
            if (!update || typeof update !== 'object') {
                return reply.code(400).send({ error: '请求体格式错误：缺少 weflow' })
            }
            const validation = validateWeflowUpdate(update, { hasExistingToken: ctx.store.hasToken() })
            if (!validation.ok) {
                return reply.code(400).send({ error: '配置校验失败', fields: validation.errors })
            }

            const cfg = resolveConfigForTest(ctx, update)
            const result = await runConnectionGate(cfg, { keepAlive: false })
            return {
                healthOk: result.healthOk,
                sseConnected: result.sseConnected,
                firstEventReceived: result.firstEventReceived,
                diagnosis: result.diagnosis,
                message: result.message,
                elapsedMs: result.elapsedMs,
            }
        },
    )
}
