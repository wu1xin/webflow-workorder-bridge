// 下游转发 worker：消费 queue 的 pending 文本消息 → receiveMessage → 按 code==1 判定 →
// done+推进投递断点 / 退避重试 / 死信。kick 唤醒 + 兜底 tick，单 worker 串行、排空即休眠。
// 媒体消息(has_media=1)一期不取（留 pending，二期媒体链路补发）。
import type { ConfigStore } from '../config/store.js'
import type { DownstreamConfig } from '@wb/shared/types'
import type { Db } from '../db/database.js'
import type { Logger } from '../weflow/logger.js'
import type { AlertChannel } from '../weflow/hooks.js'
import type { ClaimedMessage } from '../db/queue.js'
import { HttpDownstreamClient, type DownstreamClient, type ReceiveAck } from './client.js'
import { decideOutcome, isDownstreamUnavailable, type RetryPolicy, type SendResult } from './forwardPolicy.js'
import { CircuitBreaker } from './circuitBreaker.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'

const DEFAULTS = {
    maxAttempts: 3,
    authMaxAttempts: 2,
    backoffBaseMs: 2000,
    backoffCapMs: 60000,
    circuitThreshold: 5,
    circuitCooldownSec: 30,
}
const TICK_SEC = 10

export interface ForwarderDeps {
    db: Db
    store: ConfigStore
    log: Logger
    alert: AlertChannel
    createClient?: (cfg: DownstreamConfig) => DownstreamClient
    now?: () => number
}

export class Forwarder {
    private readonly db: Db
    private readonly store: ConfigStore
    private readonly log: Logger
    private readonly alert: AlertChannel
    private readonly createClient: (cfg: DownstreamConfig) => DownstreamClient
    private readonly clock: () => number

    // 默认启用：drainOnce/kick 可直接工作；暂停走 setEnabled(false)。start() 只负责 resetStuck 自愈 + 兜底 tick。
    private enabled = true
    private draining = false
    private tickTimer: NodeJS.Timeout | null = null
    private readonly circuit: CircuitBreaker
    private warnedNoConfig = false

    constructor(deps: ForwarderDeps) {
        this.db = deps.db
        this.store = deps.store
        this.log = deps.log
        this.alert = deps.alert
        this.createClient = deps.createClient ?? (cfg => new HttpDownstreamClient(cfg, this.log))
        this.clock = deps.now ?? (() => Math.floor(Date.now() / 1000))
        this.circuit = new CircuitBreaker(DEFAULTS.circuitThreshold, DEFAULTS.circuitCooldownSec, this.clock)
    }

    start(): void {
        this.db.queue.resetStuck(WEFLOW_CHANNEL_ID, this.clock())
        this.enabled = true
        if (!this.tickTimer) {
            this.tickTimer = setInterval(() => this.kick(), TICK_SEC * 1000)
            this.tickTimer.unref?.()
        }
        this.kick()
    }

    stop(): void {
        this.enabled = false
        if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    }

    setEnabled(on: boolean): void {
        if (on && !this.enabled) this.start()
        // 暂停仅置标志、故意不清 tick 定时器（unref 的定时器空转、kick 在 disabled 时 no-op），故再启用即时生效
        else if (!on && this.enabled) this.enabled = false
    }

    isEnabled(): boolean { return this.enabled }
    circuitState(): string { return this.circuit.state() }

    kick(): void {
        if (this.draining || !this.enabled) return
        void this.drainOnce()
    }

    async drainOnce(): Promise<void> {
        if (this.draining) return
        this.draining = true
        try {
            const cfg = this.store.getDownstream()
            if (!cfg) {
                if (!this.warnedNoConfig) { this.log.warn('[forward] 未配置下游，转发空转'); this.warnedNoConfig = true }
                return
            }
            this.warnedNoConfig = false
            const client = this.createClient(cfg)
            const policy = this.policyFrom(cfg)
            for (;;) {
                // 暂停开关：置 disabled 后循环首行退出，响应「暂停转发」
                if (!this.enabled) return
                // 后台 drain 可能与关库竞态（如停机 stop→close）：句柄已关则干净退出，不在闭库上取件
                if (!this.db.raw.open) return
                if (this.circuit.isOpen()) return
                const msg = this.db.queue.claimNext(WEFLOW_CHANNEL_ID, this.clock())
                if (!msg) return
                // 单条隔离：任一处理异常（DB 写/告警抛错等）不得逃逸成 unhandled rejection，也不能中断整批排空
                try {
                    await this.processOne(client, policy, msg)
                } catch (e) {
                    const err = e instanceof Error ? e.message : String(e)
                    this.log.error({ id: msg.id, err }, '[forward] 处理消息异常，退避重试')
                    // best-effort 把卡在 sending 的行退避重投；DB 不可用等则留给下次 start 的 resetStuck 兜底
                    try {
                        this.db.queue.markRetry(msg.id, { failCode: null, retryable: 1, lastError: `处理异常：${err}`, nextAttemptAt: this.clock() + 30 }, this.clock())
                    } catch { /* 忽略：DB 已关闭/不可用 */ }
                }
            }
        } finally {
            this.draining = false
        }
    }

    private policyFrom(cfg: DownstreamConfig): RetryPolicy {
        const f = cfg.forwarder ?? {}
        return {
            maxAttempts: f.maxAttempts ?? DEFAULTS.maxAttempts,
            authMaxAttempts: DEFAULTS.authMaxAttempts,
            backoffBaseMs: f.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
            backoffCapMs: f.backoffCapMs ?? DEFAULTS.backoffCapMs,
        }
    }

    private async processOne(client: DownstreamClient, policy: RetryPolicy, msg: ClaimedMessage): Promise<void> {
        // 毒消息：rawJson 无法解析属确定性致命错误，直接死信、不烧重试（放在传输 try 之外）
        let data: unknown
        try {
            data = JSON.parse(msg.rawJson)
        } catch (e) {
            const now = this.clock()
            const reason = `rawJson 解析失败：${e instanceof Error ? e.message : String(e)}`
            this.db.queue.markDead(msg.id, { failCode: 1002, retryable: 0, lastError: reason }, now)
            this.writeAudit(msg, { code: 1002, duplicate: 0, receivedAt: null }, msg.attempts, 0, now)
            this.alert.send({ level: 'warn', type: 'dlq_new', title: '消息进死信', message: `id=${msg.id} ${reason}` })
            return
        }

        const startMs = Date.now()
        let result: SendResult
        let ack: ReceiveAck | null = null
        try {
            ack = await client.receiveMessage({
                event: msg.eventType,
                sessionId: msg.conversationId ?? '',
                sender: { username: msg.senderId, name: msg.senderName, avatar: msg.senderAvatar },
                data,
            })
            result = { type: 'ack', ack }
        } catch (e) {
            result = { type: 'transport', error: e instanceof Error ? e.message : String(e) }
        }

        const attemptsSoFar = msg.attempts
        const outcome = decideOutcome(result, attemptsSoFar, policy)
        const now = this.clock()
        const latencyMs = Date.now() - startMs

        if (outcome.kind === 'done') {
            this.circuit.recordSuccess()
        } else if (isDownstreamUnavailable(result)) {
            this.circuit.recordFailure()
            if (this.circuit.isOpen()) {
                this.alert.send({ level: 'error', type: 'downstream_circuit_open', title: '下游熔断打开', message: `连续失败达阈值，暂停转发 ${DEFAULTS.circuitCooldownSec}s` })
            }
        }

        if (outcome.kind === 'done') {
            this.db.raw.transaction(() => {
                this.db.queue.markDone(msg.id, now)
                if (msg.msgTimestamp !== null) {
                    this.db.channelState.advanceBreakpoint(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, msg.msgTimestamp, msg.externalId ?? '', now)
                }
            })()
            this.writeAudit(msg, { code: 1, duplicate: outcome.duplicate ? 1 : 0, receivedAt: ack?.receivedAt ?? null }, attemptsSoFar, latencyMs, now)
            return
        }
        if (outcome.kind === 'retry') {
            const jitter = Math.floor(Math.random() * 1000)
            this.db.queue.markRetry(msg.id, {
                failCode: outcome.failCode, retryable: 1, lastError: outcome.lastError,
                nextAttemptAt: now + Math.ceil((outcome.backoffMs + jitter) / 1000),
            }, now)
            this.log.warn({ id: msg.id, failCode: outcome.failCode, err: outcome.lastError }, '[forward] 转发失败，退避重试')
            return
        }
        // dead
        this.db.queue.markDead(msg.id, { failCode: outcome.failCode, retryable: 0, lastError: outcome.lastError }, now)
        this.writeAudit(msg, { code: outcome.failCode ?? 0, duplicate: 0, receivedAt: ack?.receivedAt ?? null }, attemptsSoFar, latencyMs, now)
        this.alert.send({ level: 'warn', type: 'dlq_new', title: '消息进死信', message: `id=${msg.id} ${outcome.lastError}` })
    }

    private writeAudit(
        msg: ClaimedMessage,
        r: { code: number, duplicate: 0 | 1, receivedAt: number | null },
        attempts: number, latencyMs: number, now: number,
    ): void {
        this.db.audit.record({
            channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: msg.eventType,
            externalId: msg.externalId, conversationId: msg.conversationId, msgTimestamp: msg.msgTimestamp,
            isMedia: 0, fileId: null,
            code: r.code, duplicate: r.duplicate, receivedAt: r.receivedAt,
            latencyMs, attempts, ingestPath: null,
        }, now)
    }
}
