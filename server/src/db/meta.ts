// meta 表访问：全局单例 k-v 状态（仅 schemaVersion 等全局键；按 channel 的水位见 channel_state）。
import type BetterSqlite3 from 'better-sqlite3'

/** 全局单例 meta 键（仅放真正全局、与具体 channel 无关的键） */
export const META_KEYS = {
    schemaVersion: 'schemaVersion',
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
