// meta 表访问：全局单例 k-v 状态（见需求文档 §4.3）。
import type BetterSqlite3 from 'better-sqlite3'

/** 同步模块使用的 meta 键 */
export const META_KEYS = {
    schemaVersion: 'schemaVersion',
    /** 首次初始化时刻（秒）：用于「启动态三态分流」判定首装 */
    installTime: 'installTime',
    /**
     * 同步水位：已成功入队的最大消息时间戳（秒）。补偿同步以此为起点拉缺口。
     * 注：这是「同步拉取侧」水位，独立于转发侧 breakpointTimestamp（后者由 forwarder 在 code==1 后推进）。
     * 待 forwarder 落地后，补偿起点应改读 breakpointTimestamp（见需求文档 §5 关键不变量）。
     */
    lastSyncTimestamp: 'lastSyncTimestamp',
    /** 同步水位对应的 rawid（同一秒多条时精确定位） */
    lastSyncRawid: 'lastSyncRawid',
} as const

export class MetaStore {
    private readonly getStmt: BetterSqlite3.Statement
    private readonly setStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.getStmt = db.prepare('SELECT value FROM meta WHERE key = ?')
        this.setStmt = db.prepare(
            'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        )
    }

    /** 取字符串值（不存在返回 null） */
    get(key: string): string | null {
        const row = this.getStmt.get(key) as { value: string } | undefined
        return row ? row.value : null
    }

    /** 取数值（不存在或非数返回 null） */
    getNumber(key: string): number | null {
        const v = this.get(key)
        if (v === null) return null
        const n = Number(v)
        return Number.isFinite(n) ? n : null
    }

    /** 写入（字符串或数值统一转字符串存） */
    set(key: string, value: string | number): void {
        this.setStmt.run(key, String(value))
    }
}
