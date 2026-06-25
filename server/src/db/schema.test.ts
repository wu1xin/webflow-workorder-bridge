import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate, SCHEMA_VERSION } from './schema.js'

function columns(db: BetterSqlite3.Database, table: string): string[] {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name)
}
function exists(db: BetterSqlite3.Database, name: string): boolean {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined
}

describe('schema v3', () => {
    let db: BetterSqlite3.Database
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db) })
    afterEach(() => db.close())

    it('SCHEMA_VERSION 为 3 且写入 meta', () => {
        expect(SCHEMA_VERSION).toBe(3)
        const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string }
        expect(row.value).toBe('3')
    })

    it('queue 含归一化信封列，且不再有旧 source 列', () => {
        const cols = columns(db, 'queue')
        expect(cols).toEqual(expect.arrayContaining([
            'channel_id', 'platform', 'event_type', 'external_id', 'conversation_id',
            'sender_id', 'msg_timestamp', 'has_media', 'raw_json', 'media_json', 'ingest_path',
        ]))
        expect(cols).not.toContain('source')
        expect(cols).not.toContain('data_json')
        expect(cols).not.toContain('file_json')
    })

    it('dedup 主键为 channel_id + dedup_key', () => {
        const cols = columns(db, 'dedup')
        expect(cols).toEqual(expect.arrayContaining(['channel_id', 'dedup_key', 'first_seen_at']))
        expect(cols).not.toContain('event')
        expect(cols).not.toContain('rawid')
    })

    it('channel_state / media_cache / audit / dlq 都建好', () => {
        expect(exists(db, 'channel_state')).toBe(true)
        expect(columns(db, 'media_cache')).toEqual(expect.arrayContaining(['channel_id', 'media_key', 'media_file_name']))
        expect(columns(db, 'audit')).toEqual(expect.arrayContaining(['channel_id', 'platform', 'event_type', 'ingest_path']))
        expect(exists(db, 'dlq')).toBe(true)
    })

    it('迁移幂等：重复 migrate 不报错', () => {
        expect(() => { migrate(db); migrate(db) }).not.toThrow()
    })

    it('chat_group 表建好，含裁决与同步列', () => {
        const cols = columns(db, 'chat_group')
        expect(cols).toEqual(expect.arrayContaining([
            'channel_id', 'platform', 'conversation_id', 'group_name', 'avatar_url',
            'push_allowed', 'sync_status', 'synced_at', 'last_error',
            'first_seen_at', 'last_seen_at', 'updated_at',
        ]))
    })

    it('v2→v3 增量升级：补建 chat_group 且保留既有数据', () => {
        // 用迁移好的 v3 库模拟「老 v2 库」：删掉新表 + 回退版本号 + 塞一条 queue
        db.exec('DROP TABLE chat_group')
        db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('2', 'schemaVersion')
        db.prepare(`INSERT INTO queue(channel_id, platform, raw_json, ingest_path, status, attempts, created_at, updated_at)
                    VALUES ('weflow:default','weflow','{}','catchup','pending',0,1,1)`).run()

        migrate(db)

        expect(exists(db, 'chat_group')).toBe(true)
        expect(db.prepare('SELECT COUNT(*) c FROM queue').get()).toEqual({ c: 1 })
        const ver = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string }
        expect(ver.value).toBe('3')
    })

    it('v1→v3 升级路径：DROP 旧表并清理旧水位键', () => {
        const v1 = new BetterSqlite3(':memory:')
        v1.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
        v1.exec('CREATE TABLE queue (id INTEGER PRIMARY KEY, source TEXT, data_json TEXT)')
        v1.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schemaVersion', '1')
        v1.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('installTime', '111')
        v1.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('lastSyncTimestamp', '222')
        v1.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('lastSyncRawid', 'r1')

        migrate(v1)

        const qcols = columns(v1, 'queue')
        expect(qcols).toContain('ingest_path')
        expect(qcols).not.toContain('source')
        const keys = (v1.prepare('SELECT key FROM meta').all() as Array<{ key: string }>).map(r => r.key)
        expect(keys).not.toContain('installTime')
        expect(keys).not.toContain('lastSyncTimestamp')
        expect(keys).not.toContain('lastSyncRawid')
        const ver = v1.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string }
        expect(ver.value).toBe('3')
        v1.close()
    })
})
