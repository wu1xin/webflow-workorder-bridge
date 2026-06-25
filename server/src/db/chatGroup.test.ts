import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { ChatGroupStore } from './chatGroup.js'

const CH = 'weflow:default'
const PF = 'weflow'

describe('ChatGroupStore', () => {
    let db: BetterSqlite3.Database
    let store: ChatGroupStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new ChatGroupStore(db) })
    afterEach(() => db.close())

    it('新发现的群默认不放行、pending', () => {
        store.upsertSeen(CH, PF, 'g1@chatroom', { groupName: '群一' }, 100)
        expect(store.isPushAllowed(CH, 'g1@chatroom')).toBe(false)
        expect(store.listAllowed(CH)).toEqual([])
    })

    it('查无此群时 isPushAllowed 为 false', () => {
        expect(store.isPushAllowed(CH, 'nope@chatroom')).toBe(false)
    })

    it('upsertSeen 二次只更名称/last_seen，不覆盖裁决', () => {
        store.upsertSeen(CH, PF, 'g1@chatroom', { groupName: '旧名' }, 100)
        store.markSynced(CH, ['g1@chatroom'], ['g1@chatroom'], 200)
        store.upsertSeen(CH, PF, 'g1@chatroom', { groupName: '新名' }, 300)
        expect(store.isPushAllowed(CH, 'g1@chatroom')).toBe(true)
        const all = store.listAll(CH)
        expect(all[0].groupName).toBe('新名')
        expect(all[0].lastSeenAt).toBe(300)
    })

    it('markSynced 白名单语义：发了但不在 allowed 的群置 0', () => {
        store.upsertSeen(CH, PF, 'a@chatroom', {}, 1)
        store.upsertSeen(CH, PF, 'b@chatroom', {}, 1)
        store.markSynced(CH, ['a@chatroom', 'b@chatroom'], ['a@chatroom'], 2)
        expect(store.isPushAllowed(CH, 'a@chatroom')).toBe(true)
        expect(store.isPushAllowed(CH, 'b@chatroom')).toBe(false)
        expect(store.listAllowed(CH)).toEqual(['a@chatroom'])
    })

    it('markSyncFailed 记错误但不动裁决', () => {
        store.upsertSeen(CH, PF, 'a@chatroom', {}, 1)
        store.markSynced(CH, ['a@chatroom'], ['a@chatroom'], 2)
        store.markSyncFailed(CH, ['a@chatroom'], 'boom', 3)
        expect(store.isPushAllowed(CH, 'a@chatroom')).toBe(true)
        expect(store.listAll(CH)[0].syncStatus).toBe('failed')
        expect(store.listAll(CH)[0].lastError).toBe('boom')
    })

    it('不同 channel 相互隔离', () => {
        store.upsertSeen('weflow:a', PF, 'g@chatroom', {}, 1)
        store.markSynced('weflow:a', ['g@chatroom'], ['g@chatroom'], 1)
        expect(store.isPushAllowed('weflow:b', 'g@chatroom')).toBe(false)
    })
})
