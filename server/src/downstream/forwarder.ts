// 下游转发 worker：消费 queue 的 pending 消息 → (媒体先 uploadMedia) → receiveMessage → 按 code==1 判定 →
// done+推进投递断点 / 退避重试 / 死信。kick 唤醒 + 兜底 tick，单 worker 串行、排空即休眠。
// 媒体分支(has_media=1)：灰度开关 mediaEnabled 开启后才取；按类型定位本地文件、上传换 file_id，
// 拿不到字节(视频/等落盘超时/1002)则降级发纯文本占位。见 docs/plans/2026-07-09-下游媒体上传对接-design.md。
import { readFile } from 'node:fs/promises'
import type { ConfigStore } from '../config/store.js'
import type { DownstreamConfig } from '@wb/shared/types'
import type { Db } from '../db/database.js'
import type { Logger } from '../weflow/logger.js'
import type { AlertChannel } from '../weflow/hooks.js'
import type { ClaimedMessage } from '../db/queue.js'
import type { WeflowMessage } from '../weflow/restClient.js'
import { HttpDownstreamClient, type DownstreamClient, type ReceiveAck, type FileRef } from './client.js'
import { decideOutcome, isDownstreamUnavailable, type RetryPolicy, type SendResult } from './forwardPolicy.js'
import { CircuitBreaker } from './circuitBreaker.js'
import { resolveMediaSource } from './mediaSource.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'

const DEFAULTS = {
    maxAttempts: 3,
    authMaxAttempts: 2,
    backoffBaseMs: 2000,
    backoffCapMs: 60000,
    circuitThreshold: 5,
    circuitCooldownSec: 30,
    mediaWaitCapSec: 300,
}
const TICK_SEC = 10
/** 媒体等落盘的轮询间隔（秒）：markMediaWait 后多久再探一次文件是否落盘 */
const MEDIA_POLL_SEC = 15
/** 单媒体大小上限（字节，50MB，与下游对齐）：超限直接降级，不白跑 upload */
const MEDIA_MAX_SIZE = 50 * 1024 * 1024

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
    // 媒体链路配置诊断日志的去重签名（配置变化才记，避免每 tick 刷屏）
    private lastMediaCfgLog = ''

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
            // 灰度总闸：mediaEnabled 开启后 claimNext 才取媒体行（否则媒体留 pending，行为同一期）
            const mediaEnabled = cfg.forwarder?.mediaEnabled ?? false
            const mediaWaitCapSec = cfg.forwarder?.mediaWaitCapSec ?? DEFAULTS.mediaWaitCapSec
            const fileBaseDir = this.store.getWeflow()?.fileBaseDir ?? null
            // 诊断：媒体链路当前配置 + 积压。配置变化才记一行（含重启后首帧），避免每 10s tick 刷屏
            const cfgSig = `${mediaEnabled}|${mediaWaitCapSec}|${fileBaseDir}`
            if (cfgSig !== this.lastMediaCfgLog) {
                this.lastMediaCfgLog = cfgSig
                const pendingMedia = (this.db.raw
                    .prepare('SELECT COUNT(*) c FROM queue WHERE channel_id = ? AND status = \'pending\' AND has_media = 1')
                    .get(WEFLOW_CHANNEL_ID) as { c: number }).c
                this.log.info({ mediaEnabled, mediaWaitCapSec, fileBaseDir, pendingMedia }, '[forward][media] 媒体链路配置')
                if (!mediaEnabled && pendingMedia > 0) {
                    this.log.warn({ pendingMedia }, '[forward][media] mediaEnabled=false：媒体消息不取件、恒留 pending（改配置后需重启服务生效）')
                }
            }
            for (;;) {
                // 暂停开关：置 disabled 后循环首行退出，响应「暂停转发」
                if (!this.enabled) return
                // 后台 drain 可能与关库竞态（如停机 stop→close）：句柄已关则干净退出，不在闭库上取件
                if (!this.db.raw.open) return
                if (this.circuit.isOpen()) return
                const msg = this.db.queue.claimNext(WEFLOW_CHANNEL_ID, this.clock(), mediaEnabled)
                if (!msg) return
                // 单条隔离：任一处理异常（DB 写/告警抛错等）不得逃逸成 unhandled rejection，也不能中断整批排空
                try {
                    await this.processOne(client, policy, msg, mediaWaitCapSec)
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

    private async processOne(client: DownstreamClient, policy: RetryPolicy, msg: ClaimedMessage, mediaWaitCapSec: number): Promise<void> {
        const startMs = Date.now()
        // 毒消息：rawJson 无法解析属确定性致命错误，直接死信、不烧重试（放在传输 try 之外）
        let data: unknown
        try {
            data = JSON.parse(msg.rawJson)
        } catch (e) {
            const now = this.clock()
            const reason = `rawJson 解析失败：${e instanceof Error ? e.message : String(e)}`
            this.db.queue.markDead(msg.id, { failCode: 1002, retryable: 0, lastError: reason }, now)
            this.writeAudit(msg, { code: 1002, duplicate: 0, receivedAt: null, fileId: null }, msg.attempts, 0, now)
            this.alert.send({ level: 'warn', type: 'dlq_new', title: '消息进死信', message: `id=${msg.id} ${reason}` })
            return
        }

        // 媒体分支：先把媒体上传换成 fileRef（或降级/等落盘）。fileRef 为 undefined 表示降级发纯文本占位。
        let fileRef: FileRef | undefined
        if (msg.hasMedia === 1) {
            this.log.info({ id: msg.id, externalId: msg.externalId, conversationId: msg.conversationId }, '[forward][media] 取到媒体消息，进入媒体分支')
            const prep = await this.prepareMedia(client, msg, data, mediaWaitCapSec)
            if (prep.kind === 'wait') {
                const nextAttemptAt = this.clock() + MEDIA_POLL_SEC
                this.log.info({ id: msg.id, nextAttemptAt, pollSec: MEDIA_POLL_SEC }, '[forward][media] 等落盘，markMediaWait 后稍后重探')
                this.db.queue.markMediaWait(msg.id, nextAttemptAt, this.clock())
                return
            }
            if (prep.kind === 'send') {
                this.log.info({ id: msg.id, fileId: prep.fileRef?.file_id ?? null, downgrade: !prep.fileRef }, '[forward][media] 媒体就绪，转 receiveMessage（无 fileId 即降级占位）')
            }
            // 上传失败（传输错 / 1001 / 1004 / 1005）：走与 receiveMessage 同一套 outcome（熔断/退避/死信/审计）
            if (prep.kind === 'result') {
                this.applyResult(policy, msg, prep.result, null, startMs, undefined)
                return
            }
            fileRef = prep.fileRef
        }

        let result: SendResult
        let ack: ReceiveAck | null = null
        try {
            ack = await client.receiveMessage({
                event: msg.eventType,
                sessionId: msg.conversationId ?? '',
                sender: { username: msg.senderId, name: msg.senderName, avatar: msg.senderAvatar },
                data,
                file: fileRef,
            })
            result = { type: 'ack', ack }
        } catch (e) {
            result = { type: 'transport', error: e instanceof Error ? e.message : String(e) }
        }
        this.applyResult(policy, msg, result, ack, startMs, fileRef)
    }

    /**
     * 媒体前置：定位本地文件 → uploadMedia 换 file_id。
     * - unsupported(视频/无源) / 等落盘超时 / 超大 / upload 1002 → 降级（返回 send 无 fileRef，附 media_downgrade 告警）
     * - 未落盘且未超墙钟上限 → wait（由调用方 markMediaWait）
     * - upload 传输错 / 1001 / 1004 / 1005 → result（交统一 outcome 熔断/重试/死信）
     */
    private async prepareMedia(
        client: DownstreamClient, msg: ClaimedMessage, data: unknown, mediaWaitCapSec: number,
    ): Promise<{ kind: 'send', fileRef?: FileRef } | { kind: 'wait' } | { kind: 'result', result: SendResult }> {
        const fileBaseDir = this.store.getWeflow()?.fileBaseDir
        const src = resolveMediaSource(data as WeflowMessage, { fileBaseDir })
        this.log.info({
            id: msg.id, status: src.status,
            mediaType: 'mediaType' in src ? src.mediaType : null,
            absPath: 'absPath' in src ? src.absPath : null,
            fileBaseDir: fileBaseDir ?? null,
        }, '[forward][media] 媒体源解析结果')

        if (src.status === 'unsupported') {
            this.downgrade(msg, '不支持的媒体（视频/无可取字节）')
            return { kind: 'send' }
        }
        if (src.status === 'waiting') {
            const waited = this.clock() - msg.createdAt
            if (waited > mediaWaitCapSec) {
                this.downgrade(msg, `等待媒体落盘超时（${waited}s）`)
                return { kind: 'send' }
            }
            return { kind: 'wait' }
        }

        // ready：读字节 → 大小预检 → 上传
        let bytes: Buffer
        try {
            bytes = await readFile(src.absPath)
        } catch (e) {
            // 读盘瞬时失败（文件刚被移动/占用）：当作还没就绪，稍后再探
            this.log.warn({ id: msg.id, err: e instanceof Error ? e.message : String(e) }, '[forward] 媒体读盘失败，等待重试')
            return { kind: 'wait' }
        }
        if (bytes.byteLength > MEDIA_MAX_SIZE) {
            this.downgrade(msg, `媒体超过 ${MEDIA_MAX_SIZE} 字节上限`)
            return { kind: 'send' }
        }
        let uack
        try {
            this.log.info({ id: msg.id, fileName: src.fileName, mediaType: src.mediaType, bytes: bytes.byteLength, rawid: msg.externalId ?? '' }, '[forward][media] 开始 uploadMedia')
            uack = await client.uploadMedia({ bytes, fileName: src.fileName, rawid: msg.externalId ?? '', mediaType: src.mediaType })
        } catch (e) {
            this.log.warn({ id: msg.id, err: e instanceof Error ? e.message : String(e) }, '[forward][media] uploadMedia 传输失败，退避重试')
            return { kind: 'result', result: { type: 'transport', error: e instanceof Error ? e.message : String(e) } }
        }
        this.log.info({ id: msg.id, code: uack.code, fileId: uack.fileId ?? null, duplicate: uack.duplicate ?? false, msg: uack.msg ?? null }, '[forward][media] uploadMedia 返回')
        if (uack.code === 1 && uack.fileId) return { kind: 'send', fileRef: { file_id: uack.fileId, url: uack.url } }
        // 媒体本身不合法(1002)、或 code=1 却没 file_id（异常）：降级，下游至少收到占位消息
        if (uack.code === 1002 || uack.code === 1) {
            this.downgrade(msg, `媒体上传被拒（code=${uack.code}${uack.msg ? ` ${uack.msg}` : ''}）`)
            return { kind: 'send' }
        }
        // 1001/1004/1005/未识别：交统一 outcome 决策
        return { kind: 'result', result: { type: 'ack', ack: { code: uack.code, msg: uack.msg, retryable: uack.retryable } } }
    }

    /** 降级：记 warn 告警（下游随后收到不带 file 的纯文本占位消息） */
    private downgrade(msg: ClaimedMessage, reason: string): void {
        this.log.warn({ id: msg.id, reason }, '[forward] 媒体降级发纯文本占位')
        this.alert.send({ level: 'warn', type: 'media_downgrade', title: '媒体降级', message: `id=${msg.id} ${reason}` })
    }

    /** 一次发送结果的统一收尾：熔断计数 + outcome 决策 + done/retry/dead + 审计。文本与媒体共用 */
    private applyResult(
        policy: RetryPolicy, msg: ClaimedMessage, result: SendResult, ack: ReceiveAck | null,
        startMs: number, fileRef: FileRef | undefined,
    ): void {
        const attemptsSoFar = msg.attempts
        const outcome = decideOutcome(result, attemptsSoFar, policy)
        const now = this.clock()
        const latencyMs = Date.now() - startMs
        const fileId = fileRef?.file_id ?? null

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
            this.writeAudit(msg, { code: 1, duplicate: outcome.duplicate ? 1 : 0, receivedAt: ack?.receivedAt ?? null, fileId }, attemptsSoFar, latencyMs, now)
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
        this.writeAudit(msg, { code: outcome.failCode ?? 0, duplicate: 0, receivedAt: ack?.receivedAt ?? null, fileId }, attemptsSoFar, latencyMs, now)
        this.alert.send({ level: 'warn', type: 'dlq_new', title: '消息进死信', message: `id=${msg.id} ${outcome.lastError}` })
    }

    private writeAudit(
        msg: ClaimedMessage,
        r: { code: number, duplicate: 0 | 1, receivedAt: number | null, fileId: string | null },
        attempts: number, latencyMs: number, now: number,
    ): void {
        this.db.audit.record({
            channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: msg.eventType,
            externalId: msg.externalId, conversationId: msg.conversationId, msgTimestamp: msg.msgTimestamp,
            isMedia: msg.hasMedia, fileId: r.fileId,
            code: r.code, duplicate: r.duplicate, receivedAt: r.receivedAt,
            latencyMs, attempts, ingestPath: null,
        }, now)
    }
}
