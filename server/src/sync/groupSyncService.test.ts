import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db } from '../db/database.js'
import { GroupSyncService, isWeflowGroup } from './groupSyncService.js'
import type { SyncGroupsRequest } from '../downstream/client.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never
const noopAlert = { send() {} }

describe('isWeflowGroup', () => {
    it('type===2 或 @chatroom 结尾判为群', () => {
        expect(isWeflowGroup({ username: 'g@chatroom' })).toBe(true)
        expect(isWeflowGroup({ username: 'x', type: 2 })).toBe(true)
        expect(isWeflowGroup({ username: 'wxid_alice', type: 1 })).toBe(false)
    })
})

describe('GroupSyncService.syncAll', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    function svc(syncGroups: (req: SyncGroupsRequest) => Promise<{ allowed: string[] }>) {
        return new GroupSyncService({ db, downstream: { syncGroups }, log: noopLog, alert: noopAlert, now: () => 1000 })
    }

    it('只发群、按下游 allowed 回写白名单', async () => {
        let sent: SyncGroupsRequest | null = null
        const service = svc((req) => { sent = req; return Promise.resolve({ allowed: ['g1@chatroom'] }) })
        await service.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, [
            { username: 'g1@chatroom', displayName: '群一', type: 2 },
            { username: 'g2@chatroom', displayName: '群二', type: 2 },
            { username: 'wxid_alice', type: 1 },
        ])
        expect(sent!.groups.map(g => g.sessionId)).toEqual(['g1@chatroom', 'g2@chatroom'])
        expect(db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, 'g1@chatroom')).toBe(true)
        expect(db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, 'g2@chatroom')).toBe(false)
    })

    it('无群时不调用下游', async () => {
        let called = false
        const service = svc(() => { called = true; return Promise.resolve({ allowed: [] }) })
        await service.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, [{ username: 'wxid_alice', type: 1 }])
        expect(called).toBe(false)
    })

    it('下游失败：标记 failed，已放行裁决保持原值', async () => {
        const ok = svc(() => Promise.resolve({ allowed: ['g1@chatroom'] }))
        await ok.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, [{ username: 'g1@chatroom', type: 2 }])
        const fail = svc(() => Promise.reject(new Error('boom')))
        await fail.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, [{ username: 'g1@chatroom', type: 2 }])
        expect(db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, 'g1@chatroom')).toBe(true)
        expect(db.chatGroup.listAll(WEFLOW_CHANNEL_ID)[0].syncStatus).toBe('failed')
    })
})
