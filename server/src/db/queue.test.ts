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
        senderName: null,
        senderAvatar: null,
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

    it('入队写入 sender_name/sender_avatar，claimNext 带出 sender 身份', () => {
        store.enqueue(sample({ senderId: 'wxid_a', senderName: '无心', senderAvatar: 'https://av/a.png' }), 1700000001)
        const row = db.prepare('SELECT sender_name, sender_avatar FROM queue').get() as { sender_name: string, sender_avatar: string }
        expect(row.sender_name).toBe('无心')
        expect(row.sender_avatar).toBe('https://av/a.png')

        const claimed = store.claimNext('weflow:default', 1700000002)
        expect(claimed?.senderId).toBe('wxid_a')
        expect(claimed?.senderName).toBe('无心')
        expect(claimed?.senderAvatar).toBe('https://av/a.png')
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

describe('QueueStore worker 方法', () => {
    const CH = 'weflow:default'
    let db: BetterSqlite3.Database
    let store: QueueStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new QueueStore(db) })
    afterEach(() => db.close())

    function enq(over: Partial<EnqueueInput> = {}, now = 1000): void {
        store.enqueue({
            channelId: CH, platform: 'weflow', eventType: 'message.new',
            externalId: 's1', conversationId: 'g@chatroom', senderId: null, senderName: null, senderAvatar: null,
            msgTimestamp: 100, hasMedia: 0, rawJson: '{"a":1}', mediaJson: null,
            ingestPath: 'catchup', revocableUntil: null, ...over,
        }, now)
    }

    it('claimNext 取最早 pending 文本并置 sending；跳过媒体行', () => {
        enq({ externalId: 'm1', hasMedia: 1 })
        enq({ externalId: 't1', hasMedia: 0 })
        const c = store.claimNext(CH, 2000)
        expect(c?.externalId).toBe('t1')
        expect(store.countByStatus('sending')).toBe(1)
        expect(store.countByStatus('pending')).toBe(1)
    })

    it('claimNext 跳过未到期（next_attempt_at>now）的行', () => {
        enq({ externalId: 't1' })
        const c1 = store.claimNext(CH, 2000)!
        store.markRetry(c1.id, { failCode: 0, retryable: 1, lastError: 'x', nextAttemptAt: 9999 }, 2000)
        expect(store.claimNext(CH, 3000)).toBeNull()
        expect(store.claimNext(CH, 10000)?.externalId).toBe('t1')
    })

    it('markDone → done', () => {
        enq()
        const c = store.claimNext(CH, 2000)!
        store.markDone(c.id, 2000)
        expect(store.countByStatus('done')).toBe(1)
    })

    it('markRetry 持久化 fail_code/next_attempt_at；markDone 清残留错误字段', () => {
        enq()
        const c = store.claimNext(CH, 2000)!
        store.markRetry(c.id, { failCode: 1005, retryable: 1, lastError: 'boom', nextAttemptAt: 2005 }, 2000)
        let d = store.getById(CH, c.id)!
        expect(d.lastError).toBe('boom')
        const c2 = store.claimNext(CH, 3000)! // 到期再取
        store.markDone(c2.id, 3000)
        d = store.getById(CH, c2.id)!
        expect(d.status).toBe('done')
        expect(d.lastError).toBeNull()
    })

    it('markRetry 回 pending 且 attempts+1', () => {
        enq()
        const c = store.claimNext(CH, 2000)!
        store.markRetry(c.id, { failCode: 1005, retryable: 1, lastError: 'boom', nextAttemptAt: 2005 }, 2000)
        const d = store.getById(CH, c.id)!
        expect(d.status).toBe('pending')
        expect(d.attempts).toBe(1)
    })

    it('markDead → dead 且 attempts+1', () => {
        enq()
        const c = store.claimNext(CH, 2000)!
        store.markDead(c.id, { failCode: 1002, retryable: 0, lastError: 'bad' }, 2000)
        const d = store.getById(CH, c.id)!
        expect(d.status).toBe('dead')
        expect(d.attempts).toBe(1)
    })

    it('resetStuck 把残留 sending 全部回 pending', () => {
        enq({ externalId: 'a' })
        enq({ externalId: 'b' })
        store.claimNext(CH, 2000)
        store.claimNext(CH, 2000)
        expect(store.countByStatus('sending')).toBe(2)
        store.resetStuck(CH, 3000)
        expect(store.countByStatus('sending')).toBe(0)
        expect(store.countByStatus('pending')).toBe(2)
    })

    it('retryDead 仅对 dead 生效：回 pending、清计数/错误', () => {
        enq()
        const c = store.claimNext(CH, 2000)!
        store.markDead(c.id, { failCode: 1002, retryable: 0, lastError: 'bad' }, 2000)
        expect(store.retryDead(CH, c.id, 4000)).toBe(true)
        const d = store.getById(CH, c.id)!
        expect(d.status).toBe('pending')
        expect(d.attempts).toBe(0)
        expect(d.lastError).toBeNull()
        expect(store.retryDead(CH, c.id, 5000)).toBe(false)
    })
})
