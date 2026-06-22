// dedup 表访问：event+rawid 幂等去重（见需求文档 §4.3、FR-RECV-03/FR-REL-04）。
// 实时 / 补偿 / 重投三路径共用同一张表。
import type BetterSqlite3 from 'better-sqlite3'

export class DedupStore {
    private readonly insertStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        // INSERT OR IGNORE：命中已存在的主键则忽略，changes===0 即重复
        this.insertStmt = db.prepare(
            'INSERT OR IGNORE INTO dedup(event, rawid, first_seen_at) VALUES (?, ?, ?)',
        )
    }

    /**
     * 标记一条事件。返回 true 表示首次出现（应处理/入队）；false 表示重复（跳过）。
     */
    markIfNew(event: string, rawid: string, seenAt: number): boolean {
        const info = this.insertStmt.run(event, rawid, seenAt)
        return info.changes > 0
    }
}
