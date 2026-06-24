// 配置接口：GET /api/config（读全量，掩码）。保存按模块拆分，各模块独立接口：
// WeFlow → PUT /api/config/weflow（校验 + 保存 + 触发热重连）。
import type { FastifyInstance } from 'fastify'
import type { AppConfig, WeflowConfig, WeflowConfigUpdate } from '@wb/shared/types'
import { ConfigValidationError } from '../config/store.js'
import type { AppContext } from './context.js'

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext){

    // 读配置：内部工具，直接回明文（含 accessToken）
    app.get(
        '/api/config',
        async (): Promise<AppConfig> => {
            return ctx.store.get()
        },
    )

    // 保存 WeFlow 配置：校验 → 明文落盘 → 触发热重连（连接结果经 GET /api/status 观察）。
    // 请求体即 WeflowConfigUpdate（不再外套 weflow），返回保存后的 WeFlow 配置。
    app.put<{ Body: WeflowConfigUpdate }>('/api/config/weflow', async (req, reply): Promise<WeflowConfig | void> => {
        const body = req.body
        if (!body || typeof body !== 'object') {
            return reply.code(400).send({ error: '请求体格式错误：缺少 WeFlow 配置' })
        }
        let saved: AppConfig
        try {
            saved = ctx.store.saveWeflow(body)
        } catch (e) {
            if (e instanceof ConfigValidationError) {
                return reply.code(400).send({ error: e.message, fields: e.fields })
            }
            req.log.error({ err: e }, '[config] WeFlow 配置保存失败')
            return reply.code(500).send({ error: 'WeFlow 配置保存失败' })
        }
        // 配置已落盘，触发热重连（异步，不阻塞响应）
        ctx.manager.applyConfig()
        return saved.weflow
    })
}
