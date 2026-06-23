// WeFlow 上游运行期连接状态类型（前后端共用）。
// 与「连接测试诊断」(WeflowConnectDiagnosis) 区分：那是一次性试连的结论，
// 这里是常驻连接管理器的实时状态机，经 GET /api/status 快照与 GET /api/stream/status SSE 下推前端。
import type { WeflowConnectDiagnosis } from './config.js'

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

/** 连接状态快照，供 GET /api/status 与 GET /api/stream/status SSE 推送使用 */
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
