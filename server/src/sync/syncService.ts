// 同步服务：把 WeFlow 聊天记录拉取、去重后入转发队列 queue。
// 实现连接层的 SyncCoordinator —— 连上成功时按场景触发：
//   - 初次连接(initial) + 首装(无 installTime)        → 全量同步：拉全部历史（用户选定「字面全量」）。
//   - 初次连接(initial) + 重启(有 installTime)         → 补偿同步：从同步水位拉缺口（避免每次重启全量回灌）。
//   - 重连恢复(recovery)                               → 补偿同步：补断连缺口。
// 落库目标为 queue 表（status=pending），等下游 forwarder 接入后消费（见需求文档 §4/§5、链路文档 §2/§5）。
import type { ConfigStore } from '../config/store.js'
import type { WeflowConfig, SyncGroupsResult } from '@wb/shared/types'
import type { Db } from '../db/database.js'
import { WeflowRestClient, type WeflowMessage, type WeflowSession, type MessagesPage } from '../weflow/restClient.js'
import { WeflowAdapter, WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'
import type { AlertChannel, SyncCoordinator, SyncReason } from '../weflow/hooks.js'
import type { Logger } from '../weflow/logger.js'
import type { SseEvent } from '../weflow/sseClient.js'
import type { NormalizedMessage } from '../upstream/types.js'
import type { RevokeWatch } from '../db/queue.js'
import { idleProgress, type SyncProgress } from './types.js'
import { GroupSyncService, isWeflowGroup, upsertSeenGroups } from './groupSyncService.js'
import { parseSystemEvent, type SystemEvent } from './systemMessage.js'
import { isRevokeRow, computeRevocableUntil, NEAR_REVOKE_WINDOW_SEC } from './revoke.js'

/** 补偿默认最大回溯窗口（秒）：默认 24h。超过则告警并截断起点（FR-SYNC-04 / FR-REL-08）。 */
const MAX_LOOKBACK_SEC = 24 * 60 * 60
/** 每页拉取条数 */
const PAGE_SIZE = 1_000
/** 撤回对账扫描间隔（秒）：远小于普通消息 2min 撤回窗口，保证窗口内能扫到几轮 */
const RECONCILE_INTERVAL_SEC = 30

function nowSec(): number {
    return Math.floor(Date.now() / 1000)
}

/** 实时回查触发参数：SSE 只提供「哪个群、什么时候」，内容仍由 REST 拉 */
export interface RealtimeTrigger {
    /** 会话 ID（= REST talker） */
    talker: string
    /** 消息秒级时间戳，作为回查的 start */
    ts: number
}

/**
 * 从 SSE 负载解出实时回查触发参数。宽松解析（FR-RECV-04）：
 * 非 message.new / JSON 不可解析 / 缺 sessionId 或 timestamp 一律返回 null（调用方据此跳过）。
 * 撤回 message.revoke 暂不实现（WeFlow 端需逐群配置才可监听，覆盖不可靠）。
 */
export function parseRealtimeTrigger(data: string): RealtimeTrigger | null {
    let obj: unknown
    try {
        obj = JSON.parse(data)
    } catch {
        return null
    }
    if (typeof obj !== 'object' || obj === null) return null
    const o = obj as Record<string, unknown>
    if (o.event !== 'message.new') return null
    const talker = typeof o.sessionId === 'string' ? o.sessionId : null
    const ts = typeof o.timestamp === 'number' ? o.timestamp : null
    if (!talker || ts === null) return null
    return { talker, ts }
}

/** 同步所需的 WeFlow 拉取能力（便于测试注入桩） */
export interface WeflowClientLike {
    listSessions(): Promise<WeflowSession[]>
    fetchMessagesPage(talker: string, start: number, offset: number, limit?: number, end?: number): Promise<MessagesPage>
}

export interface SyncServiceDeps {
    store: ConfigStore
    db: Db
    log: Logger
    alert: AlertChannel
    /** client 工厂，默认 new WeflowRestClient(cfg)；测试可注入桩 */
    createClient?: (cfg: WeflowConfig) => WeflowClientLike
    /** 群同步服务；缺省则不做群同步（所有群默认不放行，不入队） */
    groupSync?: GroupSyncService
}

export class SyncService implements SyncCoordinator {
    private readonly store: ConfigStore
    private readonly db: Db
    private readonly log: Logger
    private readonly alert: AlertChannel
    private readonly adapter = new WeflowAdapter()
    private readonly createClient: (cfg: WeflowConfig) => WeflowClientLike
    private readonly groupSync?: GroupSyncService

    private progress: SyncProgress = idleProgress()
    /** 手动「立即同步群」自旋锁：防连点重入（与消息同步不互斥） */
    private groupSyncing = false
    /** 实时回查：每会话在途的拉取循环（talker → 循环 Promise），用于合并同群突发事件 */
    private readonly realtimeLoops = new Map<string, Promise<void>>()
    /** 实时回查：每会话「下一轮待拉起点」（talker → start 秒），多条同群事件取 min 合并 */
    private readonly realtimeNext = new Map<string, number>()
    /** 撤回对账周期扫描定时器（startReconcileLoop 启、stopReconcileLoop 停） */
    private reconcileTimer: NodeJS.Timeout | null = null

    constructor(deps: SyncServiceDeps) {
        this.store = deps.store
        this.db = deps.db
        this.log = deps.log
        this.alert = deps.alert
        this.createClient = deps.createClient ?? ((cfg) => new WeflowRestClient(cfg, this.log))
        this.groupSync = deps.groupSync
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

    /**
     * 手动「立即同步群」（POST /api/weflow/groups/sync）：拉会话 → 群同步/入库 → 回报群总数/放行数。
     * 复用 runFullSync 的 listSessions→syncGroups 段；与消息同步不互斥（群同步幂等、轻量），
     * 仅用 groupSyncing 防自身重入。下游失败由 syncAll 内部吞掉并标 failed，调用方重拉列表看各行状态。
     * 未配置下游时仍拉会话把所有群入库（不发下游、默认不放行），allowed 恒为 0。
     */
    syncGroupsNow(): Promise<SyncGroupsResult> {
        if (this.groupSyncing) return Promise.resolve({ ok: false, error: '群同步进行中' })
        const groupSync = this.groupSync
        this.groupSyncing = true
        return this.createClient(this.cfg()).listSessions()
            .then((sessions) => {
                if (groupSync) return groupSync.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, sessions)
                upsertSeenGroups(this.db, WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, sessions, nowSec())
            })
            .then((): SyncGroupsResult => {
                const all = this.db.chatGroup.listAll(WEFLOW_CHANNEL_ID)
                return { ok: true, total: all.length, allowed: all.filter(g => g.pushAllowed).length }
            })
            .catch((e: unknown): SyncGroupsResult => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
            .finally(() => { this.groupSyncing = false })
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
            await this.syncGroups(sessions)
            const groups = this.allowedGroupSessions(sessions)
            this.progress.sessionsTotal = groups.length
            const watermark = { ts: 0, rawid: '' }
            for (const s of groups) {
                await this.pullSession(client, s.username, 0, watermark)
                this.progress.sessionsDone += 1
            }
            this.advanceWatermark(watermark)
            this.finish()
            this.log.info({ enqueued: this.progress.enqueued, duplicates: this.progress.duplicates, sessions: groups.length }, '[sync] 全量同步完成')
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
            this.log.info({ sessions: sessions.length }, '[sync] 列会话完成')
            await this.syncGroups(sessions)
            // 只挑「放行群 ∩ 起点之后有更新」的会话（FR-REL-03）；缺 lastTimestamp 的保守纳入
            const candidates = this.allowedGroupSessions(sessions)
                .filter(s => s.lastTimestamp === undefined || s.lastTimestamp >= start)
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

    /** 列会话后同步群到下游；未配置 groupSync 时仍把所有群入库（默认不放行、本轮不入队） */
    private async syncGroups(sessions: WeflowSession[]): Promise<void> {
        if (!this.groupSync) {
            upsertSeenGroups(this.db, WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, sessions, nowSec())
            this.log.warn('[sync] 未配置下游群同步，所有群已入库但默认不放行、本轮不入队')
            return
        }
        await this.groupSync.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, sessions)
    }

    /** 会话中筛出「是群且已被下游放行」的，作为消息拉取范围 */
    private allowedGroupSessions(sessions: WeflowSession[]): WeflowSession[] {
        const allowed = new Set(this.db.chatGroup.listAllowed(WEFLOW_CHANNEL_ID))
        return sessions.filter(s => isWeflowGroup(s) && allowed.has(s.username))
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
            this.log.debug({ talker, start, offset, limit: PAGE_SIZE }, '[sync] 拉取会话分页')
            let page: MessagesPage
            try {
                page = await client.fetchMessagesPage(talker, start, offset, PAGE_SIZE)
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e)
                this.log.error(
                    { talker, start, offset, limit: PAGE_SIZE, err: message },
                    `[sync] 拉取会话分页失败：talker=${talker} offset=${offset}`,
                )
                throw e
            }
            if (page.messages.length === 0) break
            const now = nowSec()
            for (const msg of page.messages) {
                this.processMessage(talker, msg, now, watermark)
            }
            offset += page.messages.length
            if (!page.hasMore) break
        }
    }

    /** 大同步单条消息：复用落库核 ingestOne，再更新进度计数与本轮水位 */
    private processMessage(
        talker: string,
        msg: WeflowMessage,
        now: number,
        watermark: { ts: number, rawid: string },
    ): void {
        const { status, normalized: n } = this.ingestOne(talker, msg, now, 'catchup')
        if (status === 'skipped') return
        this.progress.messagesPulled += 1
        if (status === 'duplicate') {
            this.progress.duplicates += 1
            return
        }
        this.progress.enqueued += 1
        if (n.msgTimestamp !== null && n.msgTimestamp > watermark.ts) {
            watermark.ts = n.msgTimestamp
            watermark.rawid = n.dedupKey
        }
    }

    /**
     * 落库核（实时/补偿共用）：归一化 → 放行校验 → 去重 → 入队。
     * 不碰进度计数与水位（由调用方按场景处理）。
     * @returns enqueued 新入队 | duplicate 命中去重 | skipped 无幂等键或非放行群
     */
    private ingestOne(
        talker: string,
        msg: WeflowMessage,
        now: number,
        ingestPath: 'sse' | 'catchup' | 'reconcile',
    ): { status: 'enqueued' | 'duplicate' | 'skipped', normalized: NormalizedMessage } {
        const n = this.adapter.normalize({ talker, message: msg })
        // 撤回行（原地改写、serverId 同原消息）不是新消息：不当普通消息入队。
        // 撤回事件的产出由 reconcileRevokes 按 revocable_until 看守驱动（绕开本函数的 serverId 去重）。
        if (isRevokeRow(msg)) return { status: 'skipped', normalized: n }
        if (!n.dedupKey) return { status: 'skipped', normalized: n }
        // 仅群聊转发闸门：未放行群（或无 conversationId）一律不入队（与会话级过滤双保险）
        if (n.conversationId === null || !this.db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, n.conversationId)) {
            return { status: 'skipped', normalized: n }
        }
        if (!this.db.dedup.markIfNew(WEFLOW_CHANNEL_ID, n.dedupKey, now)) {
            return { status: 'duplicate', normalized: n }
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
            ingestPath,
            // 仍可能被撤回（普通 2min / 文件 3h，含 grace）则留看守截止，供对账扫描复查；过期/系统消息为 null
            revocableUntil: computeRevocableUntil(msg, now),
        }, now)
        // 旁路副作用：系统消息（localType 10000）尝试性解析，识别出已知事件则处理（不影响上面的入队/转发）。
        // 绑在「新入队」上 → 重复拉取的同一条消息被 dedup 挡住、副作用也只触发一次。
        this.dispatchSystemEvent(talker, msg, now)
        return { status: 'enqueued', normalized: n }
    }

    /** 系统消息旁路分发：解析为已知事件后按类型处理；非系统消息/无法识别一律跳过。扩展加新事件在此加 case。 */
    private dispatchSystemEvent(talker: string, msg: WeflowMessage, now: number): void {
        const event: SystemEvent | null = parseSystemEvent(msg)
        if (!event) return
        switch (event.kind) {
            case 'group_renamed':
                this.onGroupRenamed(talker, event.newName, now)
                break
        }
    }

    /**
     * 群改名：以新名回推下游单群（复用 groupSync.syncAll，其内部先覆盖本地名再发下游、按白名单重新裁决）。
     * fire-and-forget：错误由 syncAll 内部自吞（标 failed、不误关裁决、告警），不影响落库。
     * 未配置下游时仅更新本地群名（前端列表可见）。
     */
    private onGroupRenamed(conversationId: string, newName: string, now: number): void {
        this.log.info({ conversationId, newName }, '[sync] 检测到群改名')
        if (this.groupSync) {
            const session: WeflowSession = { username: conversationId, displayName: newName, type: 2 }
            void this.groupSync.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, [session])
            return
        }
        this.db.chatGroup.upsertSeen(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, conversationId, { groupName: newName }, now)
    }

    // ── 实时入库（SSE 当触发器 → 回查 REST） ───────────────────────────
    /** 连接层回调：SSE 推来一条事件 → 实时回查入库（fire-and-forget，错误自吞不影响连接） */
    onSseEvent(evt: SseEvent): void {
        void this.ingestRealtime(evt)
    }

    /**
     * 实时入库核心（可 await，便于测试）：解析触发参数 → 放行校验 → 合并调度回查。
     * 仅处理放行群的 message.new；其余一律跳过（不发 REST）。
     */
    ingestRealtime(evt: SseEvent): Promise<void> {
        const trig = parseRealtimeTrigger(evt.data)
        if (!trig) {
            this.log.debug({ event: evt.event }, '[sync] 忽略非 message.new 或不可解析的 SSE 事件')
            return Promise.resolve()
        }
        if (!this.db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, trig.talker)) {
            return Promise.resolve() // 非放行群：连 REST 都不发
        }
        return this.scheduleRealtimePull(trig.talker, trig.ts)
    }

    /**
     * 每会话合并调度：记下「下一轮起点」（同群多条取 min），确保每 talker 只有一个在途循环。
     * 返回该 talker 当前循环的 Promise（在途事件复用同一条，便于整体 await）。
     */
    private scheduleRealtimePull(talker: string, start: number): Promise<void> {
        const prev = this.realtimeNext.get(talker)
        this.realtimeNext.set(talker, prev === undefined ? start : Math.min(prev, start))
        const loop = this.realtimeLoops.get(talker)
        if (loop) return loop
        const next = this.drainRealtimeLoop(talker)
        this.realtimeLoops.set(talker, next)
        return next
    }

    /** 排空某 talker 的待拉起点：拉完一轮后若期间又有新事件则再拉一轮，直到无待拉退出。 */
    private async drainRealtimeLoop(talker: string): Promise<void> {
        for (;;) {
            const start = this.realtimeNext.get(talker)
            if (start === undefined) {
                this.realtimeLoops.delete(talker) // 与上面的判空同步执行，其间无 await，调度无竞态
                return
            }
            this.realtimeNext.delete(talker)
            try {
                await this.pullRealtime(this.createClient(this.cfg()), talker, start)
            } catch (e) {
                this.log.error(
                    { talker, start, err: e instanceof Error ? e.message : String(e) },
                    `[sync] 实时回查失败：talker=${talker} start=${start}`,
                )
            }
        }
    }

    /** 定向回查某会话自 start 起的消息（分页），逐条去重入队（ingest_path=sse），不碰进度/水位 */
    private async pullRealtime(client: WeflowClientLike, talker: string, start: number): Promise<void> {
        let offset = 0
        for (;;) {
            const page = await client.fetchMessagesPage(talker, start, offset, PAGE_SIZE)
            if (page.messages.length === 0) break
            const now = nowSec()
            for (const msg of page.messages) {
                this.ingestOne(talker, msg, now, 'sse')
            }
            offset += page.messages.length
            if (!page.hasMore) break
        }
    }

    // ── 撤回检测（revocable_until 看守 + 周期对账扫描） ──────────────────
    /** 启动撤回对账周期扫描（顶层装配后调用）。重复调用幂等。 */
    startReconcileLoop(intervalSec: number = RECONCILE_INTERVAL_SEC): void {
        if (this.reconcileTimer) return
        this.reconcileTimer = setInterval(() => {
            this.reconcileRevokes().catch((e: unknown) => {
                this.log.error({ err: e instanceof Error ? e.message : String(e) }, '[sync] 撤回对账轮次异常')
            })
        }, intervalSec * 1000)
        this.reconcileTimer.unref?.()
    }

    /** 停止撤回对账周期扫描 */
    stopReconcileLoop(): void {
        if (this.reconcileTimer) {
            clearInterval(this.reconcileTimer)
            this.reconcileTimer = null
        }
    }

    /**
     * 撤回对账扫描（可 await，便于测试）：对仍在撤回窗口内（revocable_until > now）的看守消息复查，
     * 发现 serverId 已翻成撤回态 → 入队 message.revoke 并清看守。无看守则零 REST。
     */
    reconcileRevokes(): Promise<void> {
        const now = nowSec()
        const watches = this.db.queue.listOpenRevokeWatches(WEFLOW_CHANNEL_ID, now)
        if (watches.length === 0) return Promise.resolve()

        // 按 talker 分组（缺会话/serverId 的看守跳过）
        const byTalker = new Map<string, RevokeWatch[]>()
        for (const w of watches) {
            if (!w.conversationId || !w.externalId) continue
            const arr = byTalker.get(w.conversationId)
            if (arr) arr.push(w)
            else byTalker.set(w.conversationId, [w])
        }

        const client = this.createClient(this.cfg())
        return this.reconcileAll(client, byTalker, now)
    }

    /** 逐 talker 复查；单 talker 失败仅记日志，不影响其它（与实时回查一致的错误隔离） */
    private async reconcileAll(client: WeflowClientLike, byTalker: Map<string, RevokeWatch[]>, now: number): Promise<void> {
        for (const [talker, group] of byTalker) {
            try {
                await this.reconcileTalker(client, talker, group, now)
            } catch (e) {
                this.log.error(
                    { talker, err: e instanceof Error ? e.message : String(e) },
                    `[sync] 撤回对账失败：talker=${talker}`,
                )
            }
        }
    }

    /**
     * 复查单个会话的看守消息：
     *   - 近窗粗拉 [now-近窗, now]：覆盖普通消息（撤回窗 2min+grace 内）；
     *   - 文件等 createTime 早于近窗、仍在 3h 窗口的看守：start≈end 定向探一行。
     * 命中「看守中的 serverId 已是撤回态」→ 入队撤回事件。
     */
    private async reconcileTalker(client: WeflowClientLike, talker: string, watches: RevokeWatch[], now: number): Promise<void> {
        const watchedIds = new Set(watches.map(w => String(w.externalId)))
        const handled = new Set<string>()
        const scan = (msgs: WeflowMessage[]): void => {
            for (const m of msgs) {
                const sid = String(m.serverId ?? m.localId ?? '').trim()
                if (!sid || handled.has(sid) || !watchedIds.has(sid)) continue
                if (isRevokeRow(m)) {
                    this.emitRevoke(talker, m, now)
                    handled.add(sid)
                }
            }
        }

        // 近窗粗拉（单页足矣：窗口仅 2min+grace，量小）
        const near = await client.fetchMessagesPage(talker, now - NEAR_REVOKE_WINDOW_SEC, 0, PAGE_SIZE)
        scan(near.messages)

        // 仍未解决、且早于近窗的看守（文件 3h 窗口）→ 定向探针
        for (const w of watches) {
            const sid = String(w.externalId)
            if (handled.has(sid)) continue
            const ts = w.msgTimestamp
            if (ts === null || ts >= now - NEAR_REVOKE_WINDOW_SEC) continue
            const probe = await client.fetchMessagesPage(talker, ts - 1, 0, PAGE_SIZE, ts + 1)
            scan(probe.messages)
        }
    }

    /**
     * 入队一条撤回事件。独立去重键 `revoke:<serverId>` 绕开原消息的 serverId 键，确保只入队一次；
     * 无论入队与否都清掉该 serverId 的看守，停止后续重复探测。
     */
    private emitRevoke(talker: string, msg: WeflowMessage, now: number): void {
        const serverId = String(msg.serverId ?? msg.localId ?? '').trim()
        if (!serverId) return
        if (this.db.dedup.markIfNew(WEFLOW_CHANNEL_ID, `revoke:${serverId}`, now)) {
            this.db.queue.enqueue({
                channelId: WEFLOW_CHANNEL_ID,
                platform: WEFLOW_PLATFORM,
                eventType: 'message.revoke',
                externalId: serverId,
                conversationId: talker,
                senderId: null,
                msgTimestamp: typeof msg.createTime === 'number' ? msg.createTime : now,
                hasMedia: 0,
                rawJson: JSON.stringify(msg),
                mediaJson: null,
                ingestPath: 'reconcile',
                revocableUntil: null,
            }, now)
            this.log.info({ talker, serverId }, '[sync] 检测到消息撤回，已入队 message.revoke')
        }
        this.db.queue.clearRevokeWatch(WEFLOW_CHANNEL_ID, serverId)
    }

    /** 入库水位推进：仅在更大时更新（独立于转发侧 breakpoint） */
    private advanceWatermark(watermark: { ts: number, rawid: string }): void {
        if (watermark.ts > 0) {
            this.db.channelState.advanceWatermark(
                WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, watermark.ts, watermark.rawid, nowSec(),
            )
        }
    }

    /** 取当前连接参数；同步仅在已连接（即已配置）后触发，未配置属调用方时序错误 */
    private cfg(): WeflowConfig {
        const w = this.store.getWeflow()
        if (!w) throw new Error('[sync] 上游未配置，无法获取连接参数')
        return w
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
