// WeFlow 上游连接相关的内部类型与小工具。
import { WEFLOW_FIXED_PATHS } from '@wb/shared/constants'
import type { WeflowConfig, WeflowConnectDiagnosis } from '@wb/shared/types'

/**
 * 对前端暴露的连接状态机（FR-CONN-06 / 配置说明 §9.3）。
 * disconnected → connecting → connected；连上但 health 不通/久无数据 → weflowNotReady；
 * 断开进入 reconnecting（携带固定重连间隔与本段已测试次数）。
 */
export type WeflowConnectionState =
  | 'unconfigured'
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'weflowNotReady'
  | 'reconnecting'

/** 自动重连循环的实时进度（reconnecting 态下非空） */
export interface ReconnectProgress {
    /** 固定重连间隔（秒，不退避） */
    intervalSec: number
    /** 本段重连已累计的判定轮数 */
    attempts: number
    /** 本段重连开始时刻（秒级 Unix 时间戳） */
    since: number
}

/** 连接状态快照，供 GET /api/status 与（未来）SSE 推送使用 */
export interface WeflowConnectionStatus {
    state: WeflowConnectionState
    /** 最近一次失败的诊断结论（成功或从未失败时为 null） */
    diagnosis: WeflowConnectDiagnosis | null
    /** 最近一次成功连接时刻（秒级 Unix 时间戳） */
    lastConnectedAt: number | null
    /** 人类可读的最近状态/错误信息 */
    message: string | null
    /** 自动重连进度（仅 reconnecting 态非空） */
    reconnect: ReconnectProgress | null
}

/** WeFlow 基础地址 `http://host:port`（本机回环固定 http，无 TLS） */
export function baseUrl(cfg: WeflowConfig): string {
    return `http://${cfg.host}:${cfg.port}`
}

/** health 探活地址（免鉴权） */
export function healthUrl(cfg: WeflowConfig): string {
    return `${baseUrl(cfg)}${WEFLOW_FIXED_PATHS.healthPath}`
}

/** SSE 推送地址（带 access_token query；调用方注意日志脱敏） */
export function sseUrl(cfg: WeflowConfig): string {
    const u = new URL(`${baseUrl(cfg)}${WEFLOW_FIXED_PATHS.ssePath}`)
    if (cfg.accessToken) u.searchParams.set('access_token', cfg.accessToken)
    return u.toString()
}

/** 把 URL 中的 access_token 脱敏，用于日志输出（FR-CONN-08 / FR-LOG-05） */
export function redactToken(url: string): string {
    return url.replace(/(access_token=)[^&]*/i, '$1***')
}
