// queue 表访问：持久化转发队列（设计文档 §2）。
// 同步/实时去重后把归一化信封 + 原始 blob 以 pending 入队，等下游 forwarder 消费。
import type BetterSqlite3 from 'better-sqlite3'

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
    /** 采集路径：sse 实时 | catchup 补偿 */
    ingestPath: 'sse' | 'catchup'
}

export class QueueStore {
    private readonly insertStmt: BetterSqlite3.Statement
    private readonly countStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.insertStmt = db.prepare(`
            INSERT INTO queue(
              channel_id, platform, event_type, external_id, conversation_id, sender_id,
              msg_timestamp, has_media, raw_json, media_json, ingest_path,
              status, attempts, created_at, updated_at
            ) VALUES (
              @channelId, @platform, @eventType, @externalId, @conversationId, @senderId,
              @msgTimestamp, @hasMedia, @rawJson, @mediaJson, @ingestPath,
              'pending', 0, @now, @now
            )
        `)
        this.countStmt = db.prepare('SELECT COUNT(*) AS c FROM queue WHERE status = ?')
    }

    /** 入队一条 pending 消息 */
    enqueue(input: EnqueueInput, now: number): void {
        this.insertStmt.run({ ...input, now })
    }

    /** 某状态的队列条数（默认 pending），用于状态快照展示积压 */
    countByStatus(status: string = 'pending'): number {
        return (this.countStmt.get(status) as { c: number }).c
    }
}
