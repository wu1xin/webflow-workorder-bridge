// 固定常量与校验边界（前后端共用，保证前端表单校验与后端校验一致）。
// 不设默认配置：配置「有就是有，没就是没」，缺失即未配置态，不向用户伪造任何值。

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

/** WeFlow 数值字段校验边界（与配置说明 §6 一致） */
export const WEFLOW_LIMITS = {
    port: { min: 1, max: 65535 },
    connectTimeoutSec: { min: 1, max: 120 },
    readTimeoutSec: { min: 60, max: 600 },
    firstMessageTimeoutSec: { min: 10, max: 30 },
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

/**
 * WeFlow 上游运行期连接状态机（FR-CONN-06 / 配置说明 §9.3）。
 * 与一次性试连结论 WeflowConnectDiagnosis 区分：这里是常驻连接管理器的实时状态，
 * 经 GET /api/status 快照与 GET /api/stream/status SSE 下推前端。
 * 正常流转：disconnected → connecting → connected；
 * 连上但 health 不通 / 久无数据 → weflowNotReady；断线后进入 reconnecting 固定间隔重连循环。
 */
export const WeflowConnectionState = {
    /** 未配置：缺少 host/port/token 等必填项，连接管理器不启动（初始态） */
    unconfigured: 'unconfigured',
    /** 已断开：初次连接失败且属鉴权/网络等非「WeFlow 未就绪」类原因，仅供前端读取、不进入重连 */
    disconnected: 'disconnected',
    /** 连接中：正在执行三级连接判定（health → SSE → 首消息）；疑似掉线重试 health 做最终判断时亦回到此态 */
    connecting: 'connecting',
    /** 已连接：三级判定通过，SSE 数据正常流转 */
    connected: 'connected',
    /** WeFlow 未就绪：已连上但 health 不通（weflow_not_ready）或久无数据 / 未开主动推送（connected_no_push） */
    weflowNotReady: 'weflowNotReady',
    /** 重连中：断线后进入固定间隔重连循环（携带 ReconnectProgress 进度） */
    reconnecting: 'reconnecting',
} as const

/** WeFlow 上游运行期连接状态机 */
export type WeflowConnectionState = typeof WeflowConnectionState[keyof typeof WeflowConnectionState]