// Access Token 掩码：GET /api/config 只回掩码串，绝不回明文（见 配置说明 §7）。
import type { AppConfig, WeflowConfig } from '@wb/shared/types'

/**
 * 掩码 Access Token：保留前 3、后 4 位，中间用 **** 代替（如 `wf_****cdef`）。
 * 过短的 Token 一律整体打码，避免泄露足够多明文。空串原样返回（表示未配置）。
 */
export function maskToken(token: string): string {
    if (!token) return ''
    if (token.length < 11) return '****'
    return `${token.slice(0, 3)}****${token.slice(-4)}`
}

/** 返回掩码后的 WeFlow 配置副本（accessToken 已打码） */
export function maskWeflowConfig(cfg: WeflowConfig): WeflowConfig {
    return {
        ...cfg,
        accessToken: maskToken(cfg.accessToken),
        reconnect: { ...cfg.reconnect },
    }
}

/** 返回掩码后的应用配置副本 */
export function maskAppConfig(cfg: AppConfig): AppConfig {
    return { weflow: maskWeflowConfig(cfg.weflow) }
}
