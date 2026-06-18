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
  healthIntervalSec: 30,
  reconnect: {
    initialDelaySec: 1,
    maxDelaySec: 30,
    factor: 2,
    maxRetries: 0,
    jitter: true,
  },
}

/** WeFlow 数值字段校验边界（与配置说明 §6 一致） */
export const WEFLOW_LIMITS = {
  port: { min: 1, max: 65535 },
  connectTimeoutSec: { min: 1, max: 120 },
  readTimeoutSec: { min: 10, max: 600 },
  healthIntervalSec: { min: 5, max: 600 },
  reconnect: {
    initialDelaySec: { min: 1, max: 60 },
    maxDelaySec: { min: 1, max: 3600 },
    factor: { min: 1, max: 10 },
    maxRetries: { min: 0, max: Number.MAX_SAFE_INTEGER },
  },
} as const


  host: '127.0.0.1',
  port: 5031,
  accessToken: '',
  firstConnectTimeoutSec: 10, // 第一次连接超时（秒），超时直接报错
  连接成功后

  连接断开，
  超过一定时间没有收到数据则判定为假死，
  
  
  
