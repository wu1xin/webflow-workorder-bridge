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
    private readonly insertStmt: BetterSqlite3.Statement
    private readonly countStmt: BetterSqlite3.Statement
    private readonly listStmt: BetterSqlite3.Statement
    private readonly listCountStmt: BetterSqlite3.Statement
    private readonly getByIdStmt: BetterSqlite3.Statement
    private readonly listWatchesStmt: BetterSqlite3.Statement
    private readonly clearWatchStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.insertStmt = db.prepare(`
            INSERT INTO queue(
              channel_id, platform, event_type, external_id, conversation_id, sender_id,
              msg_timestamp, has_media, raw_json, media_json, ingest_path, revocable_until,
              status, attempts, created_at, updated_at
            ) VALUES (
              @channelId, @platform, @eventType, @externalId, @conversationId, @senderId,
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
}
