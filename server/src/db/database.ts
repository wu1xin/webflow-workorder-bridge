// SQLite 连接：开库（WAL + 外键）、跑迁移，封装 meta / channelState / dedup / queue / chatGroup 五个数据访问对象。
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

    private constructor(raw: BetterSqlite3.Database) {
        this.raw = raw
        this.meta = new MetaStore(raw)
        this.channelState = new ChannelStateStore(raw)
        this.dedup = new DedupStore(raw)
        this.queue = new QueueStore(raw)
        this.chatGroup = new ChatGroupStore(raw)
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
