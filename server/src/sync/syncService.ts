// 同步服务：把 WeFlow 聊天记录拉取、去重后入转发队列 queue。
// 实现连接层的 SyncCoordinator —— 连上成功时按场景触发：
//   - 初次连接(initial) + 首装(无 installTime)        → 全量同步：拉全部历史（用户选定「字面全量」）。
//   - 初次连接(initial) + 重启(有 installTime)         → 补偿同步：从同步水位拉缺口（避免每次重启全量回灌）。
//   - 重连恢复(recovery)                               → 补偿同步：补断连缺口。
// 落库目标为 queue 表（status=pending），等下游 forwarder 接入后消费（见需求文档 §4/§5、链路文档 §2/§5）。
import type { ConfigStore } from '../config/store.js'
import type { WeflowConfig } from '@wb/shared/types'
import type { Db } from '../db/database.js'
import { WeflowRestClient, type WeflowMessage, type WeflowSession, type MessagesPage } from '../weflow/restClient.js'
import { WeflowAdapter, WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'
import type { AlertChannel, SyncCoordinator, SyncReason } from '../weflow/hooks.js'
import type { Logger } from '../weflow/logger.js'
import { idleProgress, type SyncProgress } from './types.js'

/** 补偿默认最大回溯窗口（秒）：默认 24h。超过则告警并截断起点（FR-SYNC-04 / FR-REL-08）。 */
const MAX_LOOKBACK_SEC = 24 * 60 * 60
/** 每页拉取条数 */
const PAGE_SIZE = 1_000

function nowSec(): number {
    return Math.floor(Date.now() / 1000)
}

/** 同步所需的 WeFlow 拉取能力（便于测试注入桩） */
export interface WeflowClientLike {
    listSessions(): Promise<WeflowSession[]>
    fetchMessagesPage(talker: string, start: number, offset: number, limit?: number): Promise<MessagesPage>
}

export interface SyncServiceDeps {
    store: ConfigStore
    db: Db
    log: Logger
    alert: AlertChannel
    /** client 工厂，默认 new WeflowRestClient(cfg)；测试可注入桩 */
    createClient?: (cfg: WeflowConfig) => WeflowClientLike
}

export class SyncService implements SyncCoordinator {
    private readonly store: ConfigStore
    private readonly db: Db
    private readonly log: Logger
    private readonly alert: AlertChannel
    private readonly adapter = new WeflowAdapter()
    private readonly createClient: (cfg: WeflowConfig) => WeflowClientLike

    private progress: SyncProgress = idleProgress()

    constructor(deps: SyncServiceDeps) {
        this.store = deps.store
        this.db = deps.db
        this.log = deps.log
        this.alert = deps.alert
        this.createClient = deps.createClient ?? ((cfg) => new WeflowRestClient(cfg))
    }

    /** 当前同步进度快照 */
    getStatus(): SyncProgress {
        return { ...this.progress }
    }

    /** 连接管理器回调：连上成功后按场景触发同步（异步，不阻塞连接流程） */
    onConnected(reason: SyncReason): void {
        if (this.progress.running) {
            this.log.warn('[sync] 已有同步在进行，跳过本次触发')
            return
        }
        const installed = this.db.channelState.getInstallTime(WEFLOW_CHANNEL_ID) !== null
        if (reason === 'initial' && !installed) {
            void this.runFullSync()
        } else {
            void this.runCompensation()
        }
    }

    /**
     * 手动触发同步（POST /api/sync）。
     * @param since 指定起点（秒级时间戳）；省略则按补偿水位。
     * @returns accepted=false 表示已有同步在跑（防并发）。
     */
    triggerManual(opts: { since?: number } = {}): { accepted: boolean, status: SyncProgress } {
        if (this.progress.running) {
            return { accepted: false, status: this.getStatus() }
        }
        void this.runCompensation(opts.since)
        return { accepted: true, status: this.getStatus() }
    }

    // ── 全量同步（首装） ─────────────────────────────────────────────
    async runFullSync(): Promise<void> {
        if (!this.begin('full', null)) return
        const cfg = this.cfg()
        const client = this.createClient(cfg)
        try {
            if (this.db.channelState.getInstallTime(WEFLOW_CHANNEL_ID) === null) {
                this.db.channelState.markInstalled(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, nowSec())
            }
            this.log.info('[sync] 开始全量同步（首装，拉取 WeFlow 全部历史）')
            const sessions = await client.listSessions()
            this.progress.sessionsTotal = sessions.length
            const watermark = { ts: 0, rawid: '' }
            for (const s of sessions) {
                await this.pullSession(client, s.username, 0, watermark)
                this.progress.sessionsDone += 1
            }
            this.advanceWatermark(watermark)
            this.finish()
            this.log.info({ enqueued: this.progress.enqueued, duplicates: this.progress.duplicates, sessions: sessions.length }, '[sync] 全量同步完成')
        } catch (e) {
            this.fail(e, '全量同步')
        }
    }

    // ── 补偿同步（重连/重启） ────────────────────────────────────────
    async runCompensation(sinceOverride?: number): Promise<void> {
        const cfg = this.cfg()
        let start = sinceOverride
            ?? this.db.channelState.get(WEFLOW_CHANNEL_ID)?.lastSyncTimestamp
            ?? this.db.channelState.getInstallTime(WEFLOW_CHANNEL_ID)
            ?? nowSec()

        // 回溯上限：离线过久则截断起点并告警，不静默拉全量（FR-SYNC-04）
        const earliest = nowSec() - MAX_LOOKBACK_SEC
        if (start < earliest) {
            this.alert.send({
                level: 'warn',
                type: 'catchup_overflow',
                title: '补偿超回溯上限',
                message: `缺口起点 ${start} 早于回溯窗口（${MAX_LOOKBACK_SEC}s），已截断至 ${earliest}，如需更早请手动指定时间点同步`,
            })
            start = earliest
        }

        if (!this.begin('compensation', start)) return
        const client = this.createClient(cfg)
        try {
            this.log.info({ since: start }, '[sync] 开始补偿同步（从水位拉缺口）')
            const sessions = await client.listSessions()
            // 只挑「起点之后有更新」的会话（FR-REL-03）；缺 lastTimestamp 的保守纳入
            const candidates = sessions.filter(s => s.lastTimestamp === undefined || s.lastTimestamp >= start)
            this.progress.sessionsTotal = candidates.length
            const watermark = { ts: start, rawid: '' }
            for (const s of candidates) {
                await this.pullSession(client, s.username, start, watermark)
                this.progress.sessionsDone += 1
            }
            this.advanceWatermark(watermark)
            this.finish()
            this.log.info({ enqueued: this.progress.enqueued, duplicates: this.progress.duplicates, since: start }, '[sync] 补偿同步完成')
        } catch (e) {
            this.fail(e, '补偿同步')
        }
    }

    /** 拉取单个会话的全部消息（分页），逐条去重入队 */
    private async pullSession(
        client: WeflowClientLike,
        talker: string,
        start: number,
        watermark: { ts: number, rawid: string },
    ): Promise<void> {
        let offset = 0
        for (;;) {
            const page = await client.fetchMessagesPage(talker, start, offset, PAGE_SIZE)
            if (page.messages.length === 0) break
            const now = nowSec()
            for (const msg of page.messages) {
                this.processMessage(talker, msg, now, watermark)
            }
            offset += page.messages.length
            if (!page.hasMore) break
        }
    }

    /** 单条消息：归一化 → 去重 → 入队，并推进本轮水位 */
    private processMessage(
        talker: string,
        msg: WeflowMessage,
        now: number,
        watermark: { ts: number, rawid: string },
    ): void {
        const n = this.adapter.normalize({ talker, message: msg })
        if (!n.dedupKey) return
        this.progress.messagesPulled += 1

        if (!this.db.dedup.markIfNew(WEFLOW_CHANNEL_ID, n.dedupKey, now)) {
            this.progress.duplicates += 1
            return
        }

        this.db.queue.enqueue({
            channelId: WEFLOW_CHANNEL_ID,
            platform: WEFLOW_PLATFORM,
            eventType: n.eventType,
            externalId: n.externalId,
            conversationId: n.conversationId,
            senderId: n.senderId,
            msgTimestamp: n.msgTimestamp,
            hasMedia: n.media.length > 0 ? 1 : 0,
            rawJson: n.rawJson,
            mediaJson: n.media.length > 0 ? JSON.stringify(n.media) : null,
            ingestPath: 'catchup',
        }, now)
        this.progress.enqueued += 1

        if (n.msgTimestamp !== null && n.msgTimestamp > watermark.ts) {
            watermark.ts = n.msgTimestamp
            watermark.rawid = n.dedupKey
        }
    }

    /** 入库水位推进：仅在更大时更新（独立于转发侧 breakpoint） */
    private advanceWatermark(watermark: { ts: number, rawid: string }): void {
        if (watermark.ts > 0) {
            this.db.channelState.advanceWatermark(
                WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, watermark.ts, watermark.rawid, nowSec(),
            )
        }
    }

    private cfg(): WeflowConfig {
        return this.store.get().weflow
    }

    /** 开始一轮同步：置忙 + 重置计数。返回 false 表示已有同步在跑。 */
    private begin(mode: 'full' | 'compensation', since: number | null): boolean {
        if (this.progress.running) return false
        this.progress = { ...idleProgress(), running: true, mode, since, startedAt: nowSec() }
        return true
    }

    private finish(): void {
        this.progress.running = false
        this.progress.finishedAt = nowSec()
    }

    private fail(e: unknown, scene: string): void {
        const message = e instanceof Error ? e.message : String(e)
        this.progress.running = false
        this.progress.finishedAt = nowSec()
        this.progress.lastError = message
        this.log.error({ err: message }, `[sync] ${scene}失败：${message}`)
        this.alert.send({
            level: 'error',
            type: 'sync_failed',
            title: `${scene}失败`,
            message,
        })
    }
}
