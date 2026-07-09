// queue 表访问：持久化转发队列（设计文档 §2）。
// 同步/实时去重后把归一化信封 + 原始 blob 以 pending 入队，等下游 forwarder 消费。
import type BetterSqlite3 from 'better-sqlite3'
import type {
    WeflowMessageSummary, WeflowMessageDetail, WeflowMessageStatus, WeflowIngestPath,
} from '@wb/shared/types'

/** 入队负载：最小归一化信封 + 原始 blob + 采集元数据 */
export interface EnqueueInput {
    /** 来源连接实例（weflow:default 等） */
    channelId: string
    /** 平台类型：weflow|telegram|feishu|dingtalk */
    platform: string
    /** 归一化事件类型 */
    eventType: string
    /** 上游原生消息 ID（展示/排障，未必全局唯一） */
    externalId: string | null
    /** 会话/群/chat ID */
    conversationId: string | null
    /** 发送者标识 */
    senderId: string | null
    /** 发送人昵称（chatlab members.accountName，可空） */
    senderName: string | null
    /** 发送人头像 URL（chatlab members.avatar，可空） */
    senderAvatar: string | null
    /** 消息秒级时间戳 */
    msgTimestamp: number | null
    /** 是否含媒体：1 是 | 0 否 */
    hasMedia: 0 | 1
    /** 上游原始整包 JSON（调用方已 JSON.stringify） */
    rawJson: string
    /** 归一化附件列表 JSON 数组；无附件为 null */
    mediaJson: string | null
    /** 采集路径：sse 实时 | catchup 补偿 | reconcile 撤回对账 */
    ingestPath: WeflowIngestPath
    /** 撤回看守截止（秒）：仍可能被撤回则非空，过期/系统消息/撤回事件本身为 null */
    revocableUntil: number | null
}

/** claimNext 返回：worker 发送所需的最小字段 */
export interface ClaimedMessage {
    id: number
    eventType: string
    rawJson: string
    msgTimestamp: number | null
    externalId: string | null
    conversationId: string | null
    senderId: string | null
    senderName: string | null
    senderAvatar: string | null
    /** 是否含媒体：1 是 | 0 否（forwarder 据此分叉媒体分支） */
    hasMedia: 0 | 1
    /** 入队时间（秒）：媒体「等落盘」墙钟上限以它为锚点 */
    createdAt: number
    attempts: number
}

/** 撤回对账扫描的一条看守行（revocable_until 仍 > now） */
export interface RevokeWatch {
    conversationId: string | null
    externalId: string | null
    msgTimestamp: number | null
}

/** 列表过滤条件（全部可选；缺省项不过滤） */
export interface QueueListFilter {
    conversationId?: string | null
    status?: WeflowMessageStatus | null
    hasMedia?: 0 | 1 | null
    ingestPath?: WeflowIngestPath | null
}

/** 列表行（不含 raw_json）的库内表示 */
interface SummaryRow {
    id: number
    conversation_id: string | null
    sender_id: string | null
    event_type: string
    msg_timestamp: number | null
    has_media: number
    status: WeflowMessageStatus
    ingest_path: WeflowIngestPath
    attempts: number
    last_error: string | null
    created_at: number
}

/** 列表共用的可选过滤 WHERE（占位 @x 为 null 时该条不生效） */
const FILTER_WHERE = `
    channel_id = @channelId
    AND (@conversationId IS NULL OR conversation_id = @conversationId)
    AND (@status         IS NULL OR status          = @status)
    AND (@hasMedia       IS NULL OR has_media        = @hasMedia)
    AND (@ingestPath     IS NULL OR ingest_path      = @ingestPath)`

const SUMMARY_COLS = `id, conversation_id, sender_id, event_type, msg_timestamp,
    has_media, status, ingest_path, attempts, last_error, created_at`

function toSummary(r: SummaryRow): WeflowMessageSummary {
    return {
        id: r.id,
        conversationId: r.conversation_id,
        senderId: r.sender_id,
        eventType: r.event_type,
        msgTimestamp: r.msg_timestamp,
        hasMedia: r.has_media === 1,
        status: r.status,
        ingestPath: r.ingest_path,
        attempts: r.attempts,
        lastError: r.last_error,
        createdAt: r.created_at,
    }
}

export class QueueStore {
    private readonly db: BetterSqlite3.Database
    private readonly insertStmt: BetterSqlite3.Statement
    private readonly countStmt: BetterSqlite3.Statement
    private readonly listStmt: BetterSqlite3.Statement
    private readonly listCountStmt: BetterSqlite3.Statement
    private readonly getByIdStmt: BetterSqlite3.Statement
    private readonly listWatchesStmt: BetterSqlite3.Statement
    private readonly clearWatchStmt: BetterSqlite3.Statement
    private readonly pickStmt: BetterSqlite3.Statement
    private readonly pickAnyStmt: BetterSqlite3.Statement
    private readonly toSendingStmt: BetterSqlite3.Statement
    private readonly doneStmt: BetterSqlite3.Statement
    private readonly retryStmt: BetterSqlite3.Statement
    private readonly mediaWaitStmt: BetterSqlite3.Statement
    private readonly deadStmt: BetterSqlite3.Statement
    private readonly resetStuckStmt: BetterSqlite3.Statement
    private readonly retryDeadStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.db = db
        this.insertStmt = db.prepare(`
            INSERT INTO queue(
              channel_id, platform, event_type, external_id, conversation_id, sender_id,
              sender_name, sender_avatar,
              msg_timestamp, has_media, raw_json, media_json, ingest_path, revocable_until,
              status, attempts, created_at, updated_at
            ) VALUES (
              @channelId, @platform, @eventType, @externalId, @conversationId, @senderId,
              @senderName, @senderAvatar,
              @msgTimestamp, @hasMedia, @rawJson, @mediaJson, @ingestPath, @revocableUntil,
              'pending', 0, @now, @now
            )
        `)
        this.countStmt = db.prepare('SELECT COUNT(*) AS c FROM queue WHERE status = ?')
        // 可选过滤 + 分页：最新入队在前
        this.listStmt = db.prepare(`
            SELECT ${SUMMARY_COLS} FROM queue
            WHERE ${FILTER_WHERE}
            ORDER BY id DESC
            LIMIT @limit OFFSET @offset
        `)
        this.listCountStmt = db.prepare(`SELECT COUNT(*) AS c FROM queue WHERE ${FILTER_WHERE}`)
        this.getByIdStmt = db.prepare('SELECT * FROM queue WHERE channel_id = ? AND id = ?')
        // 撤回对账：只取仍在撤回窗口内的看守行（部分索引 idx_queue_revoke 支撑）
        this.listWatchesStmt = db.prepare(`
            SELECT conversation_id, external_id, msg_timestamp FROM queue
            WHERE channel_id = ? AND revocable_until > ?
            ORDER BY id
        `)
        this.clearWatchStmt = db.prepare(
            'UPDATE queue SET revocable_until = NULL WHERE channel_id = ? AND external_id = ?',
        )
        // 取件列：文本(pickStmt, has_media=0) 与 全量(pickAnyStmt, 含媒体) 仅差媒体过滤，其余一致
        const pickCols = `id, event_type, raw_json, msg_timestamp, external_id, conversation_id,
              sender_id, sender_name, sender_avatar, has_media, created_at, attempts`
        this.pickStmt = db.prepare(`
            SELECT ${pickCols} FROM queue
            WHERE channel_id = @channelId AND status = 'pending' AND has_media = 0
              AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
            ORDER BY id LIMIT 1
        `)
        // 灰度开媒体后用：文本 + 媒体一并取，按 id 串行
        this.pickAnyStmt = db.prepare(`
            SELECT ${pickCols} FROM queue
            WHERE channel_id = @channelId AND status = 'pending'
              AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
            ORDER BY id LIMIT 1
        `)
        this.toSendingStmt = db.prepare('UPDATE queue SET status = \'sending\', updated_at = @now WHERE id = @id')
        this.doneStmt = db.prepare(
            'UPDATE queue SET status = \'done\', fail_code = NULL, retryable = NULL, last_error = NULL, next_attempt_at = NULL, updated_at = @now WHERE id = @id AND status = \'sending\'',
        )
        this.retryStmt = db.prepare(`
            UPDATE queue SET status = 'pending', attempts = attempts + 1,
              next_attempt_at = @nextAttemptAt, fail_code = @failCode, retryable = @retryable,
              last_error = @lastError, updated_at = @now
            WHERE id = @id AND status = 'sending'
        `)
        this.deadStmt = db.prepare(`
            UPDATE queue SET status = 'dead', attempts = attempts + 1,
              fail_code = @failCode, retryable = @retryable, last_error = @lastError, updated_at = @now
            WHERE id = @id AND status = 'sending'
        `)
        // 媒体等落盘：回 pending、置 next_attempt_at，但**不累加 attempts**（等落盘不占重试预算，与下游失败区分）
        this.mediaWaitStmt = db.prepare(`
            UPDATE queue SET status = 'pending', next_attempt_at = @nextAttemptAt,
              last_error = @lastError, updated_at = @now
            WHERE id = @id AND status = 'sending'
        `)
        this.resetStuckStmt = db.prepare(
            'UPDATE queue SET status = \'pending\', updated_at = @now WHERE channel_id = @channelId AND status = \'sending\'',
        )
        this.retryDeadStmt = db.prepare(`
            UPDATE queue SET status = 'pending', attempts = 0, next_attempt_at = NULL,
              fail_code = NULL, retryable = NULL, last_error = NULL, updated_at = @now
            WHERE channel_id = @channelId AND id = @id AND status = 'dead'
        `)
    }

    /** 入队一条 pending 消息 */
    enqueue(input: EnqueueInput, now: number): void {
        this.insertStmt.run({ ...input, now })
    }

    /** 列出某 channel 仍在撤回窗口内（revocable_until > now）的看守行，供对账扫描定位待复查消息 */
    listOpenRevokeWatches(channelId: string, now: number): RevokeWatch[] {
        const rows = this.listWatchesStmt.all(channelId, now) as Array<{
            conversation_id: string | null
            external_id: string | null
            msg_timestamp: number | null
        }>
        return rows.map(r => ({
            conversationId: r.conversation_id,
            externalId: r.external_id,
            msgTimestamp: r.msg_timestamp,
        }))
    }

    /** 撤回检出后清掉该 serverId 的看守（revocable_until 置 NULL），停止后续重复探测 */
    clearRevokeWatch(channelId: string, externalId: string): void {
        this.clearWatchStmt.run(channelId, externalId)
    }

    /** 某状态的队列条数（默认 pending），用于状态快照展示积压 */
    countByStatus(status: string = 'pending'): number {
        return (this.countStmt.get(status) as { c: number }).c
    }

    /** 分页 + 可选过滤列出消息（不含 raw_json），返回当页与总数 */
    list(
        channelId: string,
        filter: QueueListFilter,
        limit: number,
        offset: number,
    ): { items: WeflowMessageSummary[], total: number } {
        const where = {
            channelId,
            conversationId: filter.conversationId ?? null,
            status: filter.status ?? null,
            hasMedia: filter.hasMedia ?? null,
            ingestPath: filter.ingestPath ?? null,
        }
        const total = (this.listCountStmt.get(where) as { c: number }).c
        const rows = this.listStmt.all({ ...where, limit, offset }) as SummaryRow[]
        return { items: rows.map(toSummary), total }
    }

    /** 单条详情（含 raw_json/media_json）；不存在或跨 channel 返回 null */
    getById(channelId: string, id: number): WeflowMessageDetail | null {
        const r = this.getByIdStmt.get(channelId, id) as (SummaryRow & {
            raw_json: string
            media_json: string | null
        }) | undefined
        if (!r) return null
        return { ...toSummary(r), rawJson: r.raw_json, mediaJson: r.media_json }
    }

    /**
     * 取下一条待投（pending、已到期），原子置 sending；无则 null。
     * includeMedia=false（默认）只取文本（has_media=0），媒体留 pending；true 时文本+媒体一并取，按 id 串行。
     */
    claimNext(channelId: string, now: number, includeMedia = false): ClaimedMessage | null {
        const stmt = includeMedia ? this.pickAnyStmt : this.pickStmt
        return this.db.transaction(() => {
            const row = stmt.get({ channelId, now }) as {
                id: number, event_type: string, raw_json: string, msg_timestamp: number | null,
                external_id: string | null, conversation_id: string | null,
                sender_id: string | null, sender_name: string | null, sender_avatar: string | null,
                has_media: number, created_at: number, attempts: number
            } | undefined
            if (!row) return null
            this.toSendingStmt.run({ id: row.id, now })
            return {
                id: row.id, eventType: row.event_type, rawJson: row.raw_json, msgTimestamp: row.msg_timestamp,
                externalId: row.external_id, conversationId: row.conversation_id,
                senderId: row.sender_id, senderName: row.sender_name, senderAvatar: row.sender_avatar,
                hasMedia: (row.has_media === 1 ? 1 : 0) as 0 | 1,
                createdAt: row.created_at,
                attempts: row.attempts,
            }
        })()
    }

    /** 转发成功：置 done */
    markDone(id: number, now: number): void {
        this.doneStmt.run({ id, now })
    }

    /** 可重试失败：attempts+1、设退避时间、回 pending */
    markRetry(id: number, info: { failCode: number | null, retryable: 0 | 1, lastError: string, nextAttemptAt: number }, now: number): void {
        this.retryStmt.run({ id, now, ...info })
    }

    /** 终止失败：attempts+1、置 dead */
    markDead(id: number, info: { failCode: number | null, retryable: 0 | 1, lastError: string }, now: number): void {
        this.deadStmt.run({ id, now, ...info })
    }

    /** 媒体等落盘：回 pending、置下次探测时间，但 attempts 不变（不占重试预算） */
    markMediaWait(id: number, nextAttemptAt: number, now: number, lastError = '等待媒体落盘'): void {
        this.mediaWaitStmt.run({ id, nextAttemptAt, lastError, now })
    }

    /** 启动自愈：把残留 sending（崩溃遗留）全部回 pending */
    resetStuck(channelId: string, now: number): void {
        this.resetStuckStmt.run({ channelId, now })
    }

    /** 死信重投：dead → pending 并清计数/错误；非 dead 不动，返回是否命中 */
    retryDead(channelId: string, id: number, now: number): boolean {
        return this.retryDeadStmt.run({ channelId, id, now }).changes > 0
    }
}
