import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { DedupStore } from './dedup.js'

describe('DedupStore', () => {
    let db: BetterSqlite3.Database
    let store: DedupStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new DedupStore(db) })
    afterEach(() => db.close())

    it('首次出现返回 true，重复返回 false', () => {
        expect(store.markIfNew('weflow:default', 'k1', 1000)).toBe(true)
        expect(store.markIfNew('weflow:default', 'k1', 1001)).toBe(false)
    })

    it('不同 channel 的同名 key 互不冲突', () => {
        expect(store.markIfNew('weflow:default', 'k1', 1000)).toBe(true)
        expect(store.markIfNew('telegram:bot-a', 'k1', 1000)).toBe(true)
    })

    it('deleteByChannel 清空本 channel 全部 dedup、隔离其他 channel，返回删除行数', () => {
        store.markIfNew('weflow:default', 'k1', 1000)
        store.markIfNew('weflow:default', 'k2', 1000)
        store.markIfNew('telegram:bot-a', 'k1', 1000)

        expect(store.deleteByChannel('weflow:default')).toBe(2)
        // 清空后同 key 可再次首次出现
        expect(store.markIfNew('weflow:default', 'k1', 2000)).toBe(true)
        // 其他 channel 不受影响：仍是重复
        expect(store.markIfNew('telegram:bot-a', 'k1', 2000)).toBe(false)
    })
})
