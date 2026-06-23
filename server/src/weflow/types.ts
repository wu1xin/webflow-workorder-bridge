// WeFlow 上游连接相关的内部类型与小工具。
// 运行期连接状态类型已下沉到 @wb/shared/types（前后端共用），此处 re-export 保持原有 `./types.js` 引用不变。
import { WEFLOW_FIXED_PATHS } from '@wb/shared/constants'
import type { WeflowConfig } from '@wb/shared/types'

export type { WeflowConnectionState, ReconnectProgress, WeflowConnectionStatus } from '@wb/shared/types'

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
