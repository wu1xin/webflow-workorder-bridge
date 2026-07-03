import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { AuditStore } from './audit.js'

const CH = 'weflow:default'

describe('AuditStore', () => {
    let db: BetterSqlite3.Database
    let store: AuditStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new AuditStore(db) })
    afterEach(() => db.close())

    it('record 落一行，stats 聚合成功/失败', () => {
        store.record({ channelId: CH, platform: 'weflow', eventType: 'message.new', externalId: 's1', conversationId: 'g', msgTimestamp: 100, isMedia: 0, fileId: null, code: 1, duplicate: 0, receivedAt: 101, latencyMs: 30, attempts: 0, ingestPath: 'catchup' }, 101)
        store.record({ channelId: CH, platform: 'weflow', eventType: 'message.new', externalId: 's2', conversationId: 'g', msgTimestamp: 100, isMedia: 0, fileId: null, code: 1002, duplicate: 0, receivedAt: 102, latencyMs: 40, attempts: 1, ingestPath: 'catchup' }, 102)
        expect(store.stats(CH)).toEqual({ totalSuccess: 1, totalFail: 1 })
    })

    it('空表 stats 返回 {0,0}', () => {
        expect(store.stats(CH)).toEqual({ totalSuccess: 0, totalFail: 0 })
    })

    it('stats 按 channel 隔离', () => {
        store.record({ channelId: CH, platform: 'weflow', eventType: 'message.new', externalId: 's1', conversationId: 'g', msgTimestamp: 100, isMedia: 0, fileId: null, code: 1, duplicate: 0, receivedAt: 101, latencyMs: 30, attempts: 0, ingestPath: 'catchup' }, 101)
        expect(store.stats('weflow:other')).toEqual({ totalSuccess: 0, totalFail: 0 })
    })
})
