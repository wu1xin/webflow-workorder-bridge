import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db } from './database.js'
import type { EnqueueInput } from './queue.js'

const CH = 'weflow:default'
const OTHER = 'weflow:other'

/** 入队一条消息（externalId 即该消息的 dedup_key） */
function enq(db: Db, over: Partial<EnqueueInput>): void {
    const base: EnqueueInput = {
        channelId: CH, platform: 'weflow', eventType: 'message.new',
        externalId: 's1', conversationId: 'a@chatroom', senderId: null, senderName: null, senderAvatar: null,
        msgTimestamp: 100, hasMedia: 0, rawJson: '{"a":1}', mediaJson: null,
        ingestPath: 'catchup', revocableUntil: null,
    }
    db.queue.enqueue({ ...base, ...over }, 1)
}

describe('Db.resetConversation（清空重拉 · 单群）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('删该群 queue + 对应 dedup（含 revoke: 变体），其他群与无 queue 痕迹的键不受影响', () => {
        // 群 A：两条消息 s1/s2，s1 另有撤回看守（dedup 里有 revoke:s1）
        enq(db, { conversationId: 'a@chatroom', externalId: 's1' })
        enq(db, { conversationId: 'a@chatroom', externalId: 's2' })
        db.dedup.markIfNew(CH, 's1', 1)
        db.dedup.markIfNew(CH, 's2', 1)
        db.dedup.markIfNew(CH, 'revoke:s1', 1)
        // 群 B：一条消息 s3
        enq(db, { conversationId: 'b@chatroom', externalId: 's3' })
        db.dedup.markIfNew(CH, 's3', 1)
        // 一个没有对应 queue 行的孤儿 dedup 键（不应被误删）
        db.dedup.markIfNew(CH, 'orphan', 1)

        const res = db.resetConversation(CH, 'a@chatroom')

        expect(res).toEqual({ queue: 2, dedup: 3 })
        // 群 A 的 queue 清空、群 B 保留
        expect(db.queue.list(CH, { conversationId: 'a@chatroom' }, 20, 0).total).toBe(0)
        expect(db.queue.list(CH, { conversationId: 'b@chatroom' }, 20, 0).total).toBe(1)
        // 群 A 的 dedup 键（含 revoke:）已清 → 可再次首见
        expect(db.dedup.markIfNew(CH, 's1', 2)).toBe(true)
        expect(db.dedup.markIfNew(CH, 's2', 2)).toBe(true)
        expect(db.dedup.markIfNew(CH, 'revoke:s1', 2)).toBe(true)
        // 群 B 与孤儿键不受影响 → 仍是重复
        expect(db.dedup.markIfNew(CH, 's3', 2)).toBe(false)
        expect(db.dedup.markIfNew(CH, 'orphan', 2)).toBe(false)
    })

    it('按 channel 隔离：另一 channel 同名群与同 external_id 的 dedup 不受影响', () => {
        enq(db, { channelId: CH, conversationId: 'a@chatroom', externalId: 's1' })
        db.dedup.markIfNew(CH, 's1', 1)
        enq(db, { channelId: OTHER, conversationId: 'a@chatroom', externalId: 's1' })
        db.dedup.markIfNew(OTHER, 's1', 1)

        db.resetConversation(CH, 'a@chatroom')

        expect(db.queue.list(OTHER, { conversationId: 'a@chatroom' }, 20, 0).total).toBe(1)
        expect(db.dedup.markIfNew(OTHER, 's1', 2)).toBe(false) // 另一 channel 的 dedup 仍在
    })
})

describe('Db.resetChannel（清空重拉 · 全量）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('清空本 channel 全部 queue+dedup + 水位/断点归零，保留 install_time，隔离其他 channel', () => {
        enq(db, { conversationId: 'a@chatroom', externalId: 's1' })
        enq(db, { conversationId: 'b@chatroom', externalId: 's2' })
        db.dedup.markIfNew(CH, 's1', 1)
        db.dedup.markIfNew(CH, 's2', 1)
        db.channelState.markInstalled(CH, 'weflow', 1000)
        db.channelState.advanceWatermark(CH, 'weflow', 500, 'w', 2)
        db.channelState.advanceBreakpoint(CH, 'weflow', 300, 'b', 3)
        // 其他 channel
        enq(db, { channelId: OTHER, conversationId: 'c@chatroom', externalId: 's3' })
        db.dedup.markIfNew(OTHER, 's3', 1)

        const res = db.resetChannel(CH)

        expect(res).toEqual({ queue: 2, dedup: 2 })
        expect(db.queue.list(CH, {}, 20, 0).total).toBe(0)
        expect(db.dedup.markIfNew(CH, 's1', 2)).toBe(true) // dedup 已清
        const s = db.channelState.get(CH)
        expect(s?.lastSyncTimestamp).toBeNull()
        expect(s?.breakpointTimestamp).toBeNull()
        expect(s?.installTime).toBe(1000) // 保留
        // 其他 channel 不受影响
        expect(db.queue.list(OTHER, {}, 20, 0).total).toBe(1)
        expect(db.dedup.markIfNew(OTHER, 's3', 2)).toBe(false)
    })
})
