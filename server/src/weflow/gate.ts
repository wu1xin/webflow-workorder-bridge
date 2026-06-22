// 三级连接判定闸门（全程复用）：health → SSE 握手 → 首消息（≤ firstMessageTimeoutSec）。
// 见 docs/weflow-链路连接逻辑（仅上游）.md §0。初次连接、运行期最终判断、自动重连循环都复用本闸门。
import type { WeflowConfig, WeflowConnectDiagnosis } from '@wb/shared/types'
import { probeHealth } from './health.js'
import { SseClient, SseOpenError } from './sseClient.js'

/** 闸门判定结果 */
export interface GateResult {
    /** 三级是否全过 */
    ok: boolean
    healthOk: boolean
    sseConnected: boolean
    firstEventReceived: boolean
    /** 诊断结论，供前端区分提示文案 */
    diagnosis: WeflowConnectDiagnosis
    /** 内部失败标识（链路文档 §0 表）：health 失败 / SSE 连接失败 / SSE 连接成功但无消息；成功为 null */
    failureLabel: string | null
    /** 人类可读信息 */
    message: string
    /** 判定耗时（毫秒） */
    elapsedMs: number
    /**
     * 成功且 keepAlive=true 时，返回存活的 SSE 连接交给连接管理器继续接收；
     * 其余情况（失败 / 仅测试）为 null，连接已在闸门内关闭。
     */
    client: SseClient | null
}

export interface RunGateOptions {
    /** 成功后是否保留 SSE 连接（初次连接/重连=true；试连测试=false） */
    keepAlive: boolean
}

/**
 * 执行一轮三级连接判定。
 * 闸门只负责「判定 + 产出结果」；是否记日志/告警/重连由调用场景决定（见链路文档 §2/§3/§4）。
 */
export async function runConnectionGate(cfg: WeflowConfig, opts: RunGateOptions): Promise<GateResult> {
    const start = performance.now()
    const elapsed = (): number => Math.round(performance.now() - start)

    // ① health 探活
    const health = await probeHealth(cfg)
    if (!health.ok) {
        return {
            ok: false,
            healthOk: false,
            sseConnected: false,
            firstEventReceived: false,
            diagnosis: 'weflow_not_ready',
            failureLabel: 'health 失败',
            message: health.message ?? 'WeFlow health 失败',
            elapsedMs: elapsed(),
            client: null,
        }
    }

    // ② SSE 握手
    const client = new SseClient(cfg)
    try {
        await client.open()
    } catch (e) {
        const status = e instanceof SseOpenError ? e.status : undefined
        const diagnosis: WeflowConnectDiagnosis = status === 401 || status === 403 ? 'token_invalid' : 'error'
        return {
            ok: false,
            healthOk: true,
            sseConnected: false,
            firstEventReceived: false,
            diagnosis,
            failureLabel: 'SSE 连接失败',
            message: e instanceof Error ? e.message : String(e),
            elapsedMs: elapsed(),
            client: null,
        }
    }

    // ③ 首消息窗口
    const got = await client.waitForFirstMessage(cfg.firstMessageTimeoutSec * 1000)
    if (!got) {
        client.close()
        return {
            ok: false,
            healthOk: true,
            sseConnected: true,
            firstEventReceived: false,
            diagnosis: 'connected_no_push',
            failureLabel: 'SSE 连接成功但无消息',
            message: `SSE 连接成功但 ${cfg.firstMessageTimeoutSec}s 内无首消息`,
            elapsedMs: elapsed(),
            client: null,
        }
    }

    // 三级全过
    if (!opts.keepAlive) client.close()
    return {
        ok: true,
        healthOk: true,
        sseConnected: true,
        firstEventReceived: true,
        diagnosis: 'ok',
        failureLabel: null,
        message: '连接正常',
        elapsedMs: elapsed(),
        client: opts.keepAlive ? client : null,
    }
}
