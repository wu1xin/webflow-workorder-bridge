// 应用配置类型（前后端共用）。首版仅落地 WeFlow 上游分组，其余分组后续补充。
// 字段含义与约束见 docs/config/weflow-配置说明.md

/** WeFlow 断线重连退避（指数退避 + 上限封顶） */
export interface WeflowReconnectConfig {
  /** 重连起始退避（秒），默认 1 */
  initialDelaySec: number
  /** 重连退避上限（秒），默认 30；到顶后维持该间隔 */
  maxDelaySec: number
  /** 退避倍数，默认 2 */
  factor: number
  /** 最大连续重连次数，默认 0 = 无限 */
  maxRetries: number
  /** 退避抖动（±20%），默认 true */
  jitter: boolean
}

/** WeFlow（上游）接入配置 */
export interface WeflowConfig {
  /** WeFlow API 主机，默认 127.0.0.1 */
  host: string
  /** WeFlow API/SSE 共用端口，默认 5031 */
  port: number
  /**
   * 🔒 WeFlow Access Token（敏感）。
   * - 落盘 AES-256-GCM 加密；明文仅存在于后端内存。
   * - `GET /api/config` 返回掩码串（如 `wf_****cdef`），不回传明文。
   */
  accessToken: string
  /** 连接超时（秒），默认 10 */
  connectTimeoutSec: number
  /** 读超时 / 探活窗口（秒），默认 60 */
  readTimeoutSec: number
  /** health 周期探活间隔（秒），默认 30 */
  healthIntervalSec: number
  /** 断线重连退避 */
  reconnect: WeflowReconnectConfig
}

/**
 * WeFlow 配置更新负载（`PUT /api/config`）。
 * 敏感字段 `accessToken` 可置 `null` 或省略，表示「保持不变」——
 * 避免把前端读到的掩码串当作新 Token 写回（见配置说明 §6 掩码字段保存陷阱）。
 */
export type WeflowConfigUpdate = Omit<WeflowConfig, 'accessToken'> & {
  accessToken?: string | null
}

/** 应用整体配置（分组聚合，首版仅 weflow） */
export interface AppConfig {
  weflow: WeflowConfig
}

/** 应用整体配置更新负载 */
export interface AppConfigUpdate {
  weflow: WeflowConfigUpdate
}

/** WeFlow 连接测试诊断结论 */
export type WeflowConnectDiagnosis =
  /** health + SSE + 首条事件均正常 */
  | 'ok'
  /** health 不通：WeFlow 未启动 / 未开 API 服务 / 端口错 */
  | 'weflow_not_ready'
  /** health 通但 SSE 鉴权被拒：Token 错或过期 */
  | 'token_invalid'
  /** SSE 连上但久无数据：多半未开「主动推送」 */
  | 'connected_no_push'
  /** 其它错误 */
  | 'error'

/** WeFlow 连接测试结果（`POST /api/test/weflow-connect`） */
export interface WeflowConnectTestResult {
  /** health 端点是否可达且返回 ok */
  healthOk: boolean
  /** SSE 是否握手成功 */
  sseConnected: boolean
  /** 试连窗口内是否收到首条事件 */
  firstEventReceived: boolean
  /** 综合诊断结论，用于前端区分提示文案 */
  diagnosis: WeflowConnectDiagnosis
  /** 人类可读信息 */
  message?: string
  /** 探测耗时（毫秒） */
  elapsedMs?: number
}
