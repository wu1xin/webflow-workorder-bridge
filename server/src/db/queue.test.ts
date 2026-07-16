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

    it('maxTimestampForConversation：取该会话最大 msg_timestamp，无记录返回 null', () => {
        store.enqueue(sample({ conversationId: 'g@chatroom', externalId: 's1', msgTimestamp: 100 }), 1)
        store.enqueue(sample({ conversationId: 'g@chatroom', externalId: 's2', msgTimestamp: 300 }), 2)
        store.enqueue(sample({ conversationId: 'other@chatroom', externalId: 's3', msgTimestamp: 999 }), 3)
        expect(store.maxTimestampForConversation('weflow:default', 'g@chatroom')).toBe(300)
        expect(store.maxTimestampForConversation('weflow:default', 'none@chatroom')).toBeNull()
    })

    it('maxTimestampForConversation：全 NULL msg_timestamp 返回 null，且按 channel 隔离', () => {
        store.enqueue(sample({ conversationId: 'nulls@chatroom', externalId: 'n1', msgTimestamp: null }), 1)
        store.enqueue(sample({ conversationId: 'nulls@chatroom', externalId: 'n2', msgTimestamp: null }), 2)
        expect(store.maxTimestampForConversation('weflow:default', 'nulls@chatroom')).toBeNull()

        store.enqueue(sample({ channelId: 'weflow:other', conversationId: 'g@chatroom', externalId: 'o1', msgTimestamp: 500 }), 3)
        expect(store.maxTimestampForConversation('weflow:default', 'g@chatroom')).toBeNull() // 另一 channel 的不算
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

    it('list：按消息发送时间倒序（非入队 id）——catchup 补的旧消息排在后', () => {
        store.enqueue(sample({ externalId: 'a', msgTimestamp: 200 }), 1)
        store.enqueue(sample({ externalId: 'b', msgTimestamp: 100 }), 2) // 后入队但发送更早
        store.enqueue(sample({ externalId: 'c', msgTimestamp: 300 }), 3)
        expect(store.list(CH, {}, 20, 0).items.map(m => m.msgTimestamp)).toEqual([300, 200, 100])
    })

    it('list：同一发送秒内按 sortSeq 倒序（毫秒序修正 id 兜底的错序）', () => {
        // 用户实测：两条 createTime 同为 1783665961，仅 sortSeq 区分先后。
        // 故意让入队 id 顺序与 sortSeq 相反：较晚(sortSeq …001)先入队，较早(…000)后入队——
        // 纯 id 兜底会得 ['入群','1']（错），按 sortSeq 应得 ['1','入群']。
        store.enqueue(sample({ externalId: 'later', msgTimestamp: 1783665961, rawJson: JSON.stringify({ content: '1', localType: 1, sortSeq: 1783665961001 }) }), 1)
        store.enqueue(sample({ externalId: 'earlier', msgTimestamp: 1783665961, rawJson: JSON.stringify({ content: '“无心”邀请你加入了群聊', localType: 10000, sortSeq: 1783665961000 }) }), 2)
        expect(store.list(CH, {}, 20, 0).items.map(m => m.text)).toEqual(['1', '“无心”邀请你加入了群聊'])
    })

    it('list：同一发送时间且无 sortSeq 时按 id 倒序兜底（稳定分页）', () => {
        store.enqueue(sample({ externalId: 'a', msgTimestamp: 100 }), 1)
        store.enqueue(sample({ externalId: 'b', msgTimestamp: 100 }), 2)
        expect(store.list(CH, {}, 20, 0).items.map(m => m.id)).toEqual([2, 1])
    })

    it('list：msg_timestamp 为 null 排最后', () => {
        store.enqueue(sample({ externalId: 'a', msgTimestamp: 100 }), 1)
        store.enqueue(sample({ externalId: 'b', msgTimestamp: null }), 2)
        store.enqueue(sample({ externalId: 'c', msgTimestamp: 200 }), 3)
        expect(store.list(CH, {}, 20, 0).items.map(m => m.msgTimestamp)).toEqual([200, 100, null])
    })

    it('list：从 raw_json 派生 text（原样取 content）+ 非系统', () => {
        store.enqueue(sample({ rawJson: JSON.stringify({ content: 'hi', localType: 1 }) }), 1)
        const m = store.list(CH, {}, 20, 0).items[0]
        expect(m.text).toBe('hi')
        expect(m.isSystem).toBe(false)
    })

    it('list：系统消息 localType 10000 → isSystem=true', () => {
        store.enqueue(sample({ rawJson: JSON.stringify({ content: '你修改群名为“X”', localType: 10000 }) }), 1)
        const m = store.list(CH, {}, 20, 0).items[0]
        expect(m.isSystem).toBe(true)
        expect(m.text).toBe('你修改群名为“X”')
    })

    it('list：缺 content / 非法 JSON → text=\'\'、isSystem=false（降级不抛）', () => {
        store.enqueue(sample({ rawJson: JSON.stringify({ localType: 3 }) }), 1)
        store.enqueue(sample({ externalId: 'srv-2', rawJson: 'not-json' }), 2)
        const items = store.list(CH, {}, 20, 0).items
        for (const m of items) {
            expect(m.text).toBe('')
            expect(m.isSystem).toBe(false)
        }
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

    it('claimNext(includeMedia=true) 也取媒体行，按 id 取最早', () => {
        enq({ externalId: 'm1', hasMedia: 1 })
        enq({ externalId: 't1', hasMedia: 0 })
        const c = store.claimNext(CH, 2000, true)
        expect(c?.externalId).toBe('m1')
        expect(c?.hasMedia).toBe(1)
    })

    it('claimNext 带出 hasMedia 标记', () => {
        enq({ externalId: 't1', hasMedia: 0 })
        expect(store.claimNext(CH, 2000)?.hasMedia).toBe(0)
    })

    it('markMediaWait：回 pending、置 next_attempt_at，但 attempts 不变（等落盘不吃重试预算）', () => {
        enq({ externalId: 'm1', hasMedia: 1 })
        const c = store.claimNext(CH, 2000, true)!
        store.markMediaWait(c.id, 2005, 2000)
        const d = store.getById(CH, c.id)!
        expect(d.status).toBe('pending')
        expect(d.attempts).toBe(0) // 关键：未累加
        // 未到期不取、到期再取
        expect(store.claimNext(CH, 2003, true)).toBeNull()
        expect(store.claimNext(CH, 2005, true)?.externalId).toBe('m1')
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

describe('QueueStore 清空重拉删除', () => {
    let db: BetterSqlite3.Database
    let store: QueueStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new QueueStore(db) })
    afterEach(() => db.close())

    it('deleteByConversation 只删指定群、跨会话隔离，返回删除行数', () => {
        store.enqueue(sample({ conversationId: 'a@chatroom', externalId: 's1' }), 1)
        store.enqueue(sample({ conversationId: 'a@chatroom', externalId: 's2' }), 2)
        store.enqueue(sample({ conversationId: 'b@chatroom', externalId: 's3' }), 3)

        expect(store.deleteByConversation('weflow:default', 'a@chatroom')).toBe(2)
        expect(store.list('weflow:default', {}, 20, 0).items.map(m => m.conversationId)).toEqual(['b@chatroom'])
    })

    it('deleteByConversation 按 channel 隔离，另一 channel 同名群不受影响', () => {
        store.enqueue(sample({ conversationId: 'a@chatroom', externalId: 's1' }), 1)
        store.enqueue(sample({ channelId: 'weflow:other', conversationId: 'a@chatroom', externalId: 's2' }), 2)

        expect(store.deleteByConversation('weflow:default', 'a@chatroom')).toBe(1)
        expect(store.list('weflow:other', { conversationId: 'a@chatroom' }, 20, 0).total).toBe(1)
    })

    it('deleteByConversation 无匹配返回 0', () => {
        store.enqueue(sample({ conversationId: 'a@chatroom' }), 1)
        expect(store.deleteByConversation('weflow:default', 'none@chatroom')).toBe(0)
    })

    it('deleteByChannel 清空本 channel 全部、隔离其他 channel，返回删除行数', () => {
        store.enqueue(sample({ conversationId: 'a@chatroom', externalId: 's1' }), 1)
        store.enqueue(sample({ conversationId: 'b@chatroom', externalId: 's2' }), 2)
        store.enqueue(sample({ channelId: 'weflow:other', conversationId: 'c@chatroom', externalId: 's3' }), 3)

        expect(store.deleteByChannel('weflow:default')).toBe(2)
        expect(store.list('weflow:default', {}, 20, 0).total).toBe(0)
        expect(store.list('weflow:other', {}, 20, 0).total).toBe(1)
    })
})
