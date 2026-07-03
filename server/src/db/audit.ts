// audit 表访问：每条消息终态（done/dead）写一行，供状态统计与前端日志。表结构见 schema.ts。
import type BetterSqlite3 from 'better-sqlite3'

export interface AuditInput {
    channelId: string
    platform: string
    eventType: string
    externalId: string | null
    conversationId: string | null
    msgTimestamp: number | null
    isMedia: 0 | 1
    fileId: string | null
    code: number | null
    duplicate: 0 | 1 | null
    receivedAt: number | null
    latencyMs: number | null
    attempts: number
    ingestPath: string | null
}

export class AuditStore {
    private readonly insertStmt: BetterSqlite3.Statement
    private readonly statsStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.insertStmt = db.prepare(`
            INSERT INTO audit(channel_id, platform, event_type, external_id, conversation_id, msg_timestamp,
              is_media, file_id, code, duplicate, received_at, latency_ms, attempts, ingest_path, created_at)
            VALUES (@channelId, @platform, @eventType, @externalId, @conversationId, @msgTimestamp,
              @isMedia, @fileId, @code, @duplicate, @receivedAt, @latencyMs, @attempts, @ingestPath, @now)
        `)
        this.statsStmt = db.prepare(`
            SELECT
              SUM(CASE WHEN code = 1 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN code IS NOT NULL AND code <> 1 THEN 1 ELSE 0 END) AS fail
            FROM audit WHERE channel_id = ?
        `)
    }

    /** 写一行终态审计 */
    record(input: AuditInput, now: number): void {
        this.insertStmt.run({ ...input, now })
    }

    /** 累计成功/失败数（状态快照用） */
    stats(channelId: string): { totalSuccess: number, totalFail: number } {
        const r = this.statsStmt.get(channelId) as { ok: number | null, fail: number | null }
        return { totalSuccess: r.ok ?? 0, totalFail: r.fail ?? 0 }
    }
}
