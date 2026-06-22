// 配置默认值、固定常量与校验边界（前后端共用，保证前端表单校验与后端校验一致）。
import type { WeflowConfig } from '../types/config.js'

/**
 * WeFlow 接口路径为内置常量，不作为配置项（见配置说明 §3「内置固定接口路径」）。
 * 仅 host/port 可配；路径不暴露给配置界面。
 */
export const WEFLOW_FIXED_PATHS = {
    /** SSE 主动推送端点 */
    ssePath: '/api/v1/push/messages',
    /** 免鉴权健康检查端点（WeFlow 亦提供等价的 /api/v1/health） */
    healthPath: '/health',
} as const

/** WeFlow 配置默认值 */
export const DEFAULT_WEFLOW_CONFIG: WeflowConfig = {
    host: '127.0.0.1',
    port: 5031,
    accessToken: '',
    connectTimeoutSec: 10,
    readTimeoutSec: 60,
    firstMessageTimeoutSec: 3,
    healthIntervalSec: 30,
    reconnectIntervalSec: 1,
    reconnectLogIntervalSec: 30,
}

/** WeFlow 数值字段校验边界（与配置说明 §6 一致） */
export const WEFLOW_LIMITS = {
    port: { min: 1, max: 65535 },
    connectTimeoutSec: { min: 1, max: 120 },
    readTimeoutSec: { min: 10, max: 600 },
    firstMessageTimeoutSec: { min: 1, max: 30 },
    healthIntervalSec: { min: 5, max: 600 },
    reconnectIntervalSec: { min: 1, max: 60 },
    reconnectLogIntervalSec: { min: 10, max: 300 },
} as const

/** WeFlow 连接测试诊断结论 */
export const WeflowConnectStatus = {
    /** health + SSE + 首条事件均正常 */
    ok: 'ok',
    /** health 不通：WeFlow 未启动 / 未开 API 服务 / 端口错 */
    weflow_not_ready: 'weflow_not_ready',
    /** health 通但 SSE 鉴权被拒：Token 错或过期 */
    token_invalid: 'token_invalid',
    /** SSE 连上但久无数据：多半未开「主动推送」 */
    connected_no_push: 'connected_no_push',
    /** 其它错误 */
    error: 'error',
    /** 未配置 */
    noConfig: 'noConfig',
} as const

/** WeFlow 连接测试诊断结论 */
export type WeflowConnectStatus = typeof WeflowConnectStatus[keyof typeof WeflowConnectStatus]