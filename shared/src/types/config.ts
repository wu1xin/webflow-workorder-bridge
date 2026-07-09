// 应用配置类型（前后端共用）。首版仅落地 WeFlow 上游分组，其余分组后续补充。
// 字段含义与约束见 docs/config/weflow-配置说明.md

/** WeFlow（上游）接入配置 */
export interface WeflowConfig {
    /** WeFlow API 主机，默认 127.0.0.1 */
    host: string
    /** WeFlow API/SSE 共用端口，默认 5031 */
    port: number
    /** WeFlow Access Token（内部工具，全链路明文存取，不加密、不掩码） */
    accessToken: string
    /** 连接超时（秒），默认 10 */
    connectTimeoutSec: number
    /** 读超时 / 探活窗口（秒）：接收窗口内无数据即判为疑似掉线，触发最终判断，默认 60 */
    readTimeoutSec: number
    /**
   * SSE 连上后等待「首个连接成功消息」的窗口（秒）。
   * 超时未收到则判为「SSE 连接成功但无消息」（connected_no_push），默认 3。
   */
    firstMessageTimeoutSec: number
    /**
   * 断线后自动重连循环每轮间隔（秒，固定不退避、不限次，直到连回），默认 1。
   * 循环每轮重跑「三级连接判定闸门」(health → SSE → 首消息)，见
   * docs/weflow-链路连接逻辑（仅上游）.md §4。
   */
    reconnectIntervalSec: number
    /** 重连测试日志的汇总周期（秒）：每段记录该时间内的测试次数与过程，默认 30 */
    reconnectLogIntervalSec: number
    /**
   * 文件类媒体的本地根目录（微信 `xwechat_files\<登录wxid>\msg\file`）。
   * 文件消息二进制从此目录按 `YYYY-MM\<文件名>` 定位；未配置则文件类媒体降级为纯文本占位。
   */
    fileBaseDir?: string
}

/**
 * WeFlow 配置更新负载（`PUT /api/config`）。
 * token 不再掩码，前端直接回填明文并整体写回，故与 {@link WeflowConfig} 同构。
 */
export type WeflowConfigUpdate = WeflowConfig

/** forwarder 重试调参（全可选，缺省用后端默认；仅暴露实际生效的三项） */
export interface DownstreamForwarderConfig {
    maxAttempts?: number
    backoffBaseMs?: number
    backoffCapMs?: number
    /** 媒体链路灰度总闸：是否消费 has_media=1 的媒体消息（缺省 false，下游 file 通了再置 true） */
    mediaEnabled?: boolean
    /** 媒体等落盘墙钟上限（秒，缺省 300）：超时仍拿不到文件则降级发纯文本占位 */
    mediaWaitCapSec?: number
}

/** 下游 work-order-system 接入配置（出站调用用；密钥线下交付，明文落盘） */
export interface DownstreamConfig {
    /** 下游 base URL，如 https://example.com */
    baseUrl: string
    /** 分配给本代理的站点 key（task_white_token 明文里的 key） */
    siteKey: string
    /** AES 密钥串（实际取前 16 字节做 AES-128-ECB） */
    aesKey: string
    /** forwarder 重试调参（可选，缺省用后端默认） */
    forwarder?: DownstreamForwarderConfig
}

/** 下游配置更新负载（PUT /api/config/downstream）：与 DownstreamConfig 同构 */
export type DownstreamConfigUpdate = DownstreamConfig

/** 应用整体配置（分组聚合，首版仅 weflow）。读取走 GET /api/config；保存按模块拆分（如 PUT /api/config/weflow） */
export interface AppConfig {
    weflow?: WeflowConfig
    downstream?: DownstreamConfig
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
