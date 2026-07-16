// dedup 表访问：(channel_id, dedup_key) 幂等去重（设计文档 §1、§2）。
// dedup_key 由各上游 adapter 产出，保证在本 channel 内唯一。实时/补偿/重投共用同一张表。
import type BetterSqlite3 from 'better-sqlite3'

export class DedupStore {
    private readonly insertStmt: BetterSqlite3.Statement
    private readonly deleteByChannelStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        // INSERT OR IGNORE：命中已存在主键则忽略，changes===0 即重复
        this.insertStmt = db.prepare(
            'INSERT OR IGNORE INTO dedup(channel_id, dedup_key, first_seen_at) VALUES (?, ?, ?)',
        )
        // 清空重拉：按 channel 清 dedup（见 2026-07-15-群消息清空重拉同步-design.md §3.2）
        this.deleteByChannelStmt = db.prepare('DELETE FROM dedup WHERE channel_id = ?')
    }

    /**
     * 标记一条事件。返回 true 表示首次出现（应处理/入队）；false 表示重复（跳过）。
     * @param channelId 来源连接实例
     * @param dedupKey  adapter 产出的幂等键（channel 内唯一）
     */
    markIfNew(channelId: string, dedupKey: string, seenAt: number): boolean {
        return this.insertStmt.run(channelId, dedupKey, seenAt).changes > 0
    }

    /** 清空重拉：删本 channel 的全部 dedup 痕迹，返回删除行数 */
    deleteByChannel(channelId: string): number {
        return this.deleteByChannelStmt.run(channelId).changes
    }
}
