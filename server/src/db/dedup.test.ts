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
})
