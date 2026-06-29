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
        revocableUntil: null,
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

describe('QueueStore.list / getById', () => {
    const CH = 'weflow:default'
    let db: BetterSqlite3.Database
    let store: QueueStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new QueueStore(db) })
    afterEach(() => db.close())

    function setStatus(id: number, status: string): void {
        db.prepare('UPDATE queue SET status = ? WHERE id = ?').run(status, id)
    }

    it('分页：按 id DESC 返回当页 + 总数', () => {
        store.enqueue(sample({ externalId: 'srv-1' }), 1)
        store.enqueue(sample({ externalId: 'srv-2' }), 2)
        store.enqueue(sample({ externalId: 'srv-3' }), 3)

        const page1 = store.list(CH, {}, 2, 0)
        expect(page1.total).toBe(3)
        expect(page1.items.map(m => m.id)).toEqual([3, 2])

        const page2 = store.list(CH, {}, 2, 2)
        expect(page2.total).toBe(3)
        expect(page2.items.map(m => m.id)).toEqual([1])
    })

    it('过滤 status', () => {
        store.enqueue(sample(), 1)
        store.enqueue(sample({ externalId: 'srv-2' }), 2)
        setStatus(1, 'done')
        const res = store.list(CH, { status: 'done' }, 20, 0)
        expect(res.total).toBe(1)
        expect(res.items[0].id).toBe(1)
        expect(res.items[0].status).toBe('done')
    })

    it('过滤 conversationId', () => {
        store.enqueue(sample({ conversationId: 'a@chatroom' }), 1)
        store.enqueue(sample({ conversationId: 'b@chatroom' }), 2)
        const res = store.list(CH, { conversationId: 'a@chatroom' }, 20, 0)
        expect(res.items.map(m => m.conversationId)).toEqual(['a@chatroom'])
    })

    it('过滤 hasMedia（映射为 boolean）', () => {
        store.enqueue(sample({ hasMedia: 0 }), 1)
        store.enqueue(sample({ hasMedia: 1, externalId: 'srv-2' }), 2)
        const res = store.list(CH, { hasMedia: 1 }, 20, 0)
        expect(res.total).toBe(1)
        expect(res.items[0].hasMedia).toBe(true)
    })

    it('过滤 ingestPath', () => {
        store.enqueue(sample({ ingestPath: 'sse' }), 1)
        store.enqueue(sample({ ingestPath: 'catchup', externalId: 'srv-2' }), 2)
        const res = store.list(CH, { ingestPath: 'sse' }, 20, 0)
        expect(res.items.map(m => m.ingestPath)).toEqual(['sse'])
    })

    it('多条件交集', () => {
        store.enqueue(sample({ conversationId: 'a@chatroom', hasMedia: 1 }), 1)
        store.enqueue(sample({ conversationId: 'a@chatroom', hasMedia: 0, externalId: 'srv-2' }), 2)
        store.enqueue(sample({ conversationId: 'b@chatroom', hasMedia: 1, externalId: 'srv-3' }), 3)
        const res = store.list(CH, { conversationId: 'a@chatroom', hasMedia: 1 }, 20, 0)
        expect(res.items.map(m => m.id)).toEqual([1])
    })

    it('无过滤返回当页全部', () => {
        store.enqueue(sample(), 1)
        store.enqueue(sample({ externalId: 'srv-2' }), 2)
        expect(store.list(CH, {}, 20, 0).items).toHaveLength(2)
    })

    it('getById：命中返回含 rawJson 完整行', () => {
        store.enqueue(sample({ rawJson: '{"k":"v"}', mediaJson: '[{"x":1}]', hasMedia: 1 }), 1)
        const m = store.getById(CH, 1)
        expect(m?.id).toBe(1)
        expect(m?.rawJson).toBe('{"k":"v"}')
        expect(m?.mediaJson).toBe('[{"x":1}]')
        expect(m?.hasMedia).toBe(true)
    })

    it('getById：不存在 / 跨 channel → null', () => {
        store.enqueue(sample(), 1)
        expect(store.getById(CH, 999)).toBeNull()
        expect(store.getById('weflow:other', 1)).toBeNull()
    })
})

describe('QueueStore — 撤回看守 revocable_until', () => {
    const CH = 'weflow:default'
    let db: BetterSqlite3.Database
    let store: QueueStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new QueueStore(db) })
    afterEach(() => db.close())

    it('enqueue 写入 revocable_until（非空与 null 都正确落库）', () => {
        store.enqueue(sample({ externalId: 'srv-1', revocableUntil: 1700000150 }), 1700000000)
        store.enqueue(sample({ externalId: 'srv-2', revocableUntil: null }), 1700000000)
        const rows = db.prepare('SELECT external_id, revocable_until FROM queue ORDER BY id').all() as Array<{ external_id: string, revocable_until: number | null }>
        expect(rows).toEqual([
            { external_id: 'srv-1', revocable_until: 1700000150 },
            { external_id: 'srv-2', revocable_until: null },
        ])
    })

    it('listOpenRevokeWatches 只返回 revocable_until > now 的看守行（过期/NULL 不返回）', () => {
        store.enqueue(sample({ externalId: 'open', conversationId: 'g@chatroom', msgTimestamp: 100, revocableUntil: 1000 }), 1)
        store.enqueue(sample({ externalId: 'expired', msgTimestamp: 50, revocableUntil: 500 }), 1)
        store.enqueue(sample({ externalId: 'none', msgTimestamp: 60, revocableUntil: null }), 1)

        const open = store.listOpenRevokeWatches(CH, 600)

        expect(open).toEqual([{ conversationId: 'g@chatroom', externalId: 'open', msgTimestamp: 100 }])
    })

    it('listOpenRevokeWatches 隔离 channel', () => {
        store.enqueue(sample({ externalId: 'a', revocableUntil: 1000 }), 1)
        store.enqueue(sample({ channelId: 'weflow:other', externalId: 'b', revocableUntil: 1000 }), 1)
        expect(store.listOpenRevokeWatches(CH, 1).map(w => w.externalId)).toEqual(['a'])
    })

    it('clearRevokeWatch 把指定 serverId 的看守置 NULL（撤回检出后停止再探）', () => {
        store.enqueue(sample({ externalId: 'srv-1', revocableUntil: 1000 }), 1)
        store.clearRevokeWatch(CH, 'srv-1')
        expect(store.listOpenRevokeWatches(CH, 1)).toEqual([])
    })
})
