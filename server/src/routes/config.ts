// 配置接口：GET /api/config（读，掩码）、PUT /api/config（校验 + 保存 + 触发热重连）。
import type { FastifyInstance } from 'fastify'
import type { AppConfig, AppConfigUpdate } from '@wb/shared/types'
import { ConfigValidationError } from '../config/store.js'
import type { AppContext } from './context.js'

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext){

    // 读配置：敏感字段已掩码（accessToken 形如 wf_****cdef）
    app.get(
        '/api/config',
        async (): Promise<AppConfig> => {
            return ctx.store.getMasked()
        },
    )

    // 保存配置：校验 → 加密落盘 → 触发热重连（连接结果经 GET /api/status 观察）
    app.put<{ Body: AppConfigUpdate }>('/api/config', async (req, reply) => {
        const body = req.body
        if (!body || typeof body !== 'object' || typeof body.weflow !== 'object') {
            return reply.code(400).send({ error: '请求体格式错误：缺少 weflow' })
        }
        try {
            ctx.store.saveWeflow(body.weflow)
        } catch (e) {
            if (e instanceof ConfigValidationError) {
                return reply.code(400).send({ error: e.message, fields: e.fields })
            }
            req.log.error({ err: e }, '[config] 保存失败')
            return reply.code(500).send({ error: '配置保存失败' })
        }
        // 配置已落盘，触发热重连（异步，不阻塞响应）
        ctx.manager.applyConfig()
        return ctx.store.getMasked()
    })
}
