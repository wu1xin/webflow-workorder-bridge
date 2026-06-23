// channel_state 表访问：每个连接实例的同步状态（首装时刻 + 同步水位）。
// 取代旧 meta 里的全局 installTime/lastSyncTimestamp/lastSyncRawid（设计文档 §2、§4）。
import type BetterSqlite3 from 'better-sqlite3'

export interface ChannelState {
    channelId: string
    platform: string
    installTime: number | null
    lastSyncTimestamp: number | null
    lastSyncRawid: string | null
}

interface Row {
    channel_id: string
    platform: string
    install_time: number | null
    last_sync_timestamp: number | null
    last_sync_rawid: string | null
}

export class ChannelStateStore {
    private readonly getStmt: BetterSqlite3.Statement
    private readonly installStmt: BetterSqlite3.Statement
    private readonly watermarkStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.getStmt = db.prepare(
            'SELECT channel_id, platform, install_time, last_sync_timestamp, last_sync_rawid FROM channel_state WHERE channel_id = ?',
        )
        // 写 install_time：行不存在则插入；已存在且非空则保留原值（COALESCE 不覆盖）
        this.installStmt = db.prepare(`
            INSERT INTO channel_state(channel_id, platform, install_time, updated_at)
            VALUES (@channelId, @platform, @now, @now)
            ON CONFLICT(channel_id) DO UPDATE SET
              install_time = COALESCE(install_time, @now),
              updated_at   = @now
        `)
        this.watermarkStmt = db.prepare(`
            INSERT INTO channel_state(channel_id, platform, last_sync_timestamp, last_sync_rawid, updated_at)
            VALUES (@channelId, @platform, @ts, @rawid, @now)
            ON CONFLICT(channel_id) DO UPDATE SET
              last_sync_timestamp = @ts,
              last_sync_rawid     = @rawid,
              updated_at          = @now
        `)
    }

    /** 取整行状态（不存在返回 null） */
    get(channelId: string): ChannelState | null {
        const row = this.getStmt.get(channelId) as Row | undefined
        if (!row) return null
        return {
            channelId: row.channel_id,
            platform: row.platform,
            installTime: row.install_time,
            lastSyncTimestamp: row.last_sync_timestamp,
            lastSyncRawid: row.last_sync_rawid,
        }
    }

    /** 首装时刻（不存在返回 null），用于首装/重启分流 */
    getInstallTime(channelId: string): number | null {
        return this.get(channelId)?.installTime ?? null
    }

    /** 标记首装时刻：幂等，已有则保留原值 */
    markInstalled(channelId: string, platform: string, now: number): void {
        this.installStmt.run({ channelId, platform, now })
    }

    /** 推进水位：仅当 ts 大于当前水位时写入 */
    advanceWatermark(channelId: string, platform: string, ts: number, rawid: string, now: number): void {
        const current = this.get(channelId)?.lastSyncTimestamp ?? 0
        if (ts > current) {
            this.watermarkStmt.run({ channelId, platform, ts, rawid, now })
        }
    }
}
