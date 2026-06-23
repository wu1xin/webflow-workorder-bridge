import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate, SCHEMA_VERSION } from './schema.js'

function columns(db: BetterSqlite3.Database, table: string): string[] {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name)
}
function exists(db: BetterSqlite3.Database, name: string): boolean {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined
}

describe('schema v2', () => {
    let db: BetterSqlite3.Database
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db) })
    afterEach(() => db.close())

    it('SCHEMA_VERSION 为 2 且写入 meta', () => {
        expect(SCHEMA_VERSION).toBe(2)
        const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string }
        expect(row.value).toBe('2')
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
})
