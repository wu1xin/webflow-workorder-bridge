// 三级闸门第 ① 步：health 探活（免鉴权）。见 链路连接逻辑 §0。
import type { WeflowConfig } from '@wb/shared/types'
import { healthUrl } from './types.js'

/** health 探活结果 */
export interface HealthProbeResult {
    ok: boolean
    /** 失败原因（ok 时为 null） */
    message: string | null
}

/**
 * 探活 `GET /health`，connectTimeoutSec 内未完成判为失败。
 * WeFlow health 返回 `{status:"ok"}`；这里以 HTTP 2xx 为准，宽松解析 body。
 */
export async function probeHealth(cfg: WeflowConfig): Promise<HealthProbeResult> {
    const url = healthUrl(cfg)
    try {
        const res = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(cfg.connectTimeoutSec * 1000),
        })
        if (!res.ok) {
            // 读掉 body 释放连接
            await res.text().catch(() => '')
            return { ok: false, message: `health 返回 HTTP ${res.status}` }
        }
        await res.text().catch(() => '')
        return { ok: true, message: null }
    } catch (e) {
        const reason = e instanceof Error && e.name === 'TimeoutError'
            ? `health 探活超时（${cfg.connectTimeoutSec}s）`
            : e instanceof Error ? e.message : String(e)
        return { ok: false, message: reason }
    }
}
