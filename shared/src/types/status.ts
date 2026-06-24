// WeFlow 上游运行期连接状态相关类型（前后端共用）。
// 状态机枚举 WeflowConnectionState 已下沉至 constants/config.ts（与运行期常量值同处），此处仅引用其类型。
import type { WeflowConnectDiagnosis } from './config.js'
import type { WeflowConnectionState } from '../constants/config.js'

// 重新导出，保持 `@wb/shared/types` 既有导入面不变（消费方多以 type 形式引用）。
export type { WeflowConnectionState }

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
