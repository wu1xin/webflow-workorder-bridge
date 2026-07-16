// SQLite 连接：开库（WAL + 外键）、跑迁移，封装 meta / channelState / dedup / queue / chatGroup / audit 六个数据访问对象。
// 库文件 %LOCALAPPDATA%\weflow-bridge\bridge.db（见需求文档 §4.2）。
import BetterSqlite3 from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { appDataDir } from '../config/paths.js'
import { migrate } from './schema.js'
import { MetaStore } from './meta.js'
import { ChannelStateStore } from './channelState.js'
import { DedupStore } from './dedup.js'
import { QueueStore } from './queue.js'
import { ChatGroupStore } from './chatGroup.js'
import { AuditStore } from './audit.js'

/** bridge.db 路径 */
export function dbFilePath(): string {
    return join(appDataDir(), 'bridge.db')
}

/** 数据库句柄聚合：对外只暴露三个 store，调用方不直接碰 SQL */
export class Db {
    readonly raw: BetterSqlite3.Database
    readonly meta: MetaStore
    readonly channelState: ChannelStateStore
    readonly dedup: DedupStore
    readonly queue: QueueStore
    readonly chatGroup: ChatGroupStore
    readonly audit: AuditStore

    /**
     * 清空重拉：删某群对应的 dedup 痕迹。dedup 无会话维度，靠 `queue.external_id == dedup_key`
     * 反查（含撤回的 `revoke:` 变体）。见 2026-07-15-群消息清空重拉同步-design.md §2/§3.3。
     */
    private readonly resetConvDedupStmt: BetterSqlite3.Statement

    private constructor(raw: BetterSqlite3.Database) {
        this.raw = raw
        this.meta = new MetaStore(raw)
        this.channelState = new ChannelStateStore(raw)
        this.dedup = new DedupStore(raw)
        this.queue = new QueueStore(raw)
        this.chatGroup = new ChatGroupStore(raw)
        this.audit = new AuditStore(raw)
        this.resetConvDedupStmt = raw.prepare(`
            DELETE FROM dedup WHERE channel_id = @ch AND dedup_key IN (
              SELECT external_id            FROM queue WHERE channel_id = @ch AND conversation_id = @conv AND external_id IS NOT NULL
              UNION
              SELECT 'revoke:' || external_id FROM queue WHERE channel_id = @ch AND conversation_id = @conv AND external_id IS NOT NULL
            )
        `)
    }

    /**
     * 单群清空重拉：一个事务内**先删 dedup 后删 queue**（dedup 靠 queue.external_id 反查，
     * 删了 queue 就丢反查依据，顺序不能反）。返回各表删除行数。
     */
    resetConversation(channelId: string, conversationId: string): { queue: number, dedup: number } {
        return this.raw.transaction(() => {
            const dedup = this.resetConvDedupStmt.run({ ch: channelId, conv: conversationId }).changes
            const queue = this.queue.deleteByConversation(channelId, conversationId)
            return { queue, dedup }
        })()
    }

    /**
     * 全量清空重拉：一个事务内清空本 channel 的 queue + dedup，并把同步水位/断点归零
     * （保留 install_time）。返回 queue/dedup 删除行数。
     */
    resetChannel(channelId: string): { queue: number, dedup: number } {
        return this.raw.transaction(() => {
            const dedup = this.dedup.deleteByChannel(channelId)
            const queue = this.queue.deleteByChannel(channelId)
            this.channelState.resetWatermark(channelId)
            return { queue, dedup }
        })()
    }

    /** 打开（或新建）库：建目录 → WAL/外键 → 迁移建表 */
    static open(file: string = dbFilePath()): Db {
        mkdirSync(appDataDir(), { recursive: true })
        const raw = new BetterSqlite3(file)
        raw.pragma('journal_mode = WAL')
        raw.pragma('foreign_keys = ON')
        migrate(raw)
        return new Db(raw)
    }

    /** 打开内存库（测试用）：跳过建目录与 WAL，仅开外键 + 迁移 */
    static openMemory(): Db {
        const raw = new BetterSqlite3(':memory:')
        raw.pragma('foreign_keys = ON')
        migrate(raw)
        return new Db(raw)
    }

    close(): void {
        this.raw.close()
    }
}
