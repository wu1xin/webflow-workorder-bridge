import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { QueueStore, type EnqueueInput } from './queue.js'

function sample(over: Partial<EnqueueInput> = {}): EnqueueInput {
    return {
        channelId: 'weflow:default',
        platform: 'weflow',
        eventType: 'message.new',
        externalId: 'srv-1',
        conversationId: 'alice',
        senderId: 'bob',
        msgTimestamp: 1700000000,
        hasMedia: 0,
        rawJson: '{"a":1}',
        mediaJson: null,
        ingestPath: 'catchup',
        ...over,
    }
}

describe('QueueStore', () => {
    let db: BetterSqlite3.Database
    let store: QueueStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new QueueStore(db) })
    afterEach(() => db.close())

    it('入队写入归一化信封字段，状态为 pending', () => {
        store.enqueue(sample(), 1700000001)
        const row = db.prepare('SELECT * FROM queue').get() as Record<string, unknown>
        expect(row.channel_id).toBe('weflow:default')
        expect(row.platform).toBe('weflow')
        expect(row.external_id).toBe('srv-1')
        expect(row.conversation_id).toBe('alice')
        expect(row.raw_json).toBe('{"a":1}')
        expect(row.ingest_path).toBe('catchup')
        expect(row.status).toBe('pending')
        expect(row.attempts).toBe(0)
    })

    it('含媒体时 has_media=1 且写入 media_json', () => {
        store.enqueue(sample({ hasMedia: 1, mediaJson: '[{"mediaKey":"srv-1:a.png"}]' }), 1700000001)
        const row = db.prepare('SELECT has_media, media_json FROM queue').get() as { has_media: number, media_json: string }
        expect(row.has_media).toBe(1)
        expect(row.media_json).toContain('a.png')
    })

    it('countByStatus 统计积压', () => {
        store.enqueue(sample(), 1)
        store.enqueue(sample({ externalId: 'srv-2' }), 2)
        expect(store.countByStatus('pending')).toBe(2)
        expect(store.countByStatus('dead')).toBe(0)
    })
})
