// 转发决策纯函数：给定一次发送结果 + 已尝试次数 + 策略 → 该消息该走 done/retry/dead。
// 不含副作用、不读时钟（退避不含抖动，抖动由 forwarder 叠加），便于穷举测试。
import type { ReceiveAck } from './client.js'

/** 一次发送的结果：拿到业务 ACK，或传输层错误 */
export type SendResult =
  | { type: 'ack', ack: ReceiveAck }
  | { type: 'transport', error: string }

export interface RetryPolicy {
    /** 通用可重试码的最大尝试次数 */
    maxAttempts: number
    /** 鉴权失败(1001)的有限重试次数 */
    authMaxAttempts: number
    backoffBaseMs: number
    backoffCapMs: number
}

export type ForwardOutcome =
  | { kind: 'done', duplicate: boolean }
  | { kind: 'retry', failCode: number | null, lastError: string, backoffMs: number }
  | { kind: 'dead', failCode: number | null, lastError: string }

/** 指数退避（不含抖动）：min(base * 2^(nextAttempt-1), cap) */
function backoffMs(nextAttempt: number, p: RetryPolicy): number {
    return Math.min(p.backoffBaseMs * 2 ** (nextAttempt - 1), p.backoffCapMs)
}

/** 该失败是否属「下游不可用」，用于熔断计数（内容类错误不计） */
export function isDownstreamUnavailable(result: SendResult): boolean {
    if (result.type === 'transport') return true
    const c = result.ack.code
    if (c === 1 || c === 1001 || c === 1002 || c === 1003) return false
    return true
}

export function decideOutcome(result: SendResult, attemptsSoFar: number, p: RetryPolicy): ForwardOutcome {
    const next = attemptsSoFar + 1
    const retryOrDead = (cap: number, failCode: number | null, reason: string): ForwardOutcome =>
        next >= cap
            ? { kind: 'dead', failCode, lastError: reason }
            : { kind: 'retry', failCode, lastError: reason, backoffMs: backoffMs(next, p) }

    if (result.type === 'transport') return retryOrDead(p.maxAttempts, null, `传输错误：${result.error}`)

    const { code, retryable, msg } = result.ack
    const reason = `code=${code}${msg ? ` msg=${msg}` : ''}`
    if (code === 1) return { kind: 'done', duplicate: result.ack.duplicate === true }
    if (code === 1001) return retryOrDead(p.authMaxAttempts, 1001, `鉴权失败(${reason})，查 siteKey/aesKey/时钟`)
    if (code === 1002 || code === 1003) return { kind: 'dead', failCode: code, lastError: reason }
    if (retryable === false) return { kind: 'dead', failCode: code, lastError: reason }
    // retryable 未给 或 显式 true：0/1004/1005/未识别码按 maxAttempts 退避重试
    return retryOrDead(p.maxAttempts, code, reason)
}
