// queue 表访问：持久化转发队列（见需求文档 §4.3）。
// 同步/补偿去重后把消息以 pending 入队，等下游 forwarder 接入后消费。
import type BetterSqlite3 from 'better-sqlite3'

/** 入队负载 */
export interface EnqueueInput {
    event: string
    rawid: string
    /** 消息秒级时间戳 */
    msgTimestamp: number | null
    /** WeFlow 原始 data 整包（直通），调用方已 JSON.stringify */
    dataJson: string
    /** 来源：实时 sse / 拉取补偿 catchup */
    source: 'sse' | 'catchup'
}

export class QueueStore {
    private readonly insertStmt: BetterSqlite3.Statement
    private readonly countStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.insertStmt = db.prepare(`
            INSERT INTO queue(event, rawid, msg_timestamp, data_json, source, status, created_at, updated_at)
            VALUES (@event, @rawid, @msgTimestamp, @dataJson, @source, 'pending', @now, @now)
        `)
        this.countStmt = db.prepare('SELECT COUNT(*) AS c FROM queue WHERE status = ?')
    }

    /** 入队一条 pending 消息 */
    enqueue(input: EnqueueInput, now: number): void {
        this.insertStmt.run({
            event: input.event,
            rawid: input.rawid,
            msgTimestamp: input.msgTimestamp,
            dataJson: input.dataJson,
            source: input.source,
            now,
        })
    }

    /** 某状态的队列条数（默认 pending），用于状态快照展示积压 */
    countByStatus(status: string = 'pending'): number {
        const row = this.countStmt.get(status) as { c: number }
        return row.c
    }
}
