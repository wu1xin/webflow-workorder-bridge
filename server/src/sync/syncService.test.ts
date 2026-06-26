import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db } from '../db/database.js'
import { SyncService } from './syncService.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'
import type { WeflowSession, MessagesPage } from '../weflow/restClient.js'

function stubClient(sessions: WeflowSession[], pages: Record<string, MessagesPage>) {
    return {
        listSessions: () => Promise.resolve(sessions),
        fetchMessagesPage: (talker: string) => Promise.resolve(pages[talker] ?? { messages: [], hasMore: false }),
    }
}

// 群同步桩：默认 no-op（测试自己预置 chat_group 放行）
const noopGroupSync = { syncAll: () => Promise.resolve() }

function deps(db: Db, client: ReturnType<typeof stubClient>, groupSync: { syncAll: () => Promise<void> } = noopGroupSync) {
    const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never
    return {
        store: { get: () => ({ weflow: { host: 'h', port: 1, accessToken: 't' } }), getWeflow: () => ({ host: 'h', port: 1, accessToken: 't' }) } as never,
        db,
        log: noopLog,
        alert: { send() {} },
        createClient: () => client as never,
        groupSync: groupSync as never,
    }
}

/** 预置一个已放行的群 */
function allowGroup(db: Db, conv: string) {
    db.chatGroup.upsertSeen(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, conv, {}, 1)
    db.chatGroup.markSynced(WEFLOW_CHANNEL_ID, [conv], [conv], 1)
}

describe('SyncService 全量同步（仅群聊 + 仅放行群）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('放行群：去重入队 + 推进水位 + 记首装', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient(
            [{ username: 'proj@chatroom', type: 2 }],
            { 'proj@chatroom': { messages: [
                { serverId: 's1', createTime: 100, content: 'a' },
                { serverId: 's2', createTime: 200, content: 'b' },
                { serverId: 's1', createTime: 100, content: 'a' },
            ], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        await svc.runFullSync()

        expect(db.queue.countByStatus('pending')).toBe(2)
        expect(db.channelState.get(WEFLOW_CHANNEL_ID)?.lastSyncTimestamp).toBe(200)
        expect(db.channelState.getInstallTime(WEFLOW_CHANNEL_ID)).not.toBeNull()
        expect(svc.getStatus().enqueued).toBe(2)
        expect(svc.getStatus().duplicates).toBe(1)
    })

    it('单聊会话不入队', async () => {
        const client = stubClient(
            [{ username: 'wxid_alice', type: 1 }],
            { wxid_alice: { messages: [{ serverId: 's1', createTime: 100 }], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        await svc.runFullSync()
        expect(db.queue.countByStatus('pending')).toBe(0)
    })

    it('未放行的群不入队', async () => {
        const client = stubClient(
            [{ username: 'blocked@chatroom', type: 2 }],
            { 'blocked@chatroom': { messages: [{ serverId: 's1', createTime: 100 }], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        await svc.runFullSync()
        expect(db.queue.countByStatus('pending')).toBe(0)
    })
})

describe('SyncService.syncGroupsNow（手动立即同步群）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('拉会话→同步→返回群总数与放行数', async () => {
        const client = stubClient([
            { username: 'g1@chatroom', type: 2 },
            { username: 'g2@chatroom', type: 2 },
            { username: 'wxid_alice', type: 1 },
        ], {})
        // 群同步桩：模拟下游只放行 g1
        const groupSync = {
            syncAll: (channelId: string, _platform: string, sessions: WeflowSession[]) => {
                const groups = sessions.filter(s => s.username.endsWith('@chatroom'))
                for (const g of groups) db.chatGroup.upsertSeen(channelId, WEFLOW_PLATFORM, g.username, {}, 1)
                db.chatGroup.markSynced(channelId, groups.map(g => g.username), ['g1@chatroom'], 1)
                return Promise.resolve()
            },
        }
        const svc = new SyncService({ ...deps(db, client), groupSync: groupSync as never })
        const res = await svc.syncGroupsNow()
        expect(res).toEqual({ ok: true, total: 2, allowed: 1 })
    })

    it('未配置 groupSync → ok:false', async () => {
        const svc = new SyncService({ ...deps(db, stubClient([], {})), groupSync: undefined })
        const res = await svc.syncGroupsNow()
        expect(res.ok).toBe(false)
    })

    it('拉会话失败 → ok:false 且不抛出', async () => {
        const client = {
            listSessions: () => Promise.reject(new Error('unreachable')),
            fetchMessagesPage: () => Promise.resolve({ messages: [], hasMore: false }),
        }
        const svc = new SyncService(deps(db, client as never))
        const res = await svc.syncGroupsNow()
        expect(res).toEqual({ ok: false, error: 'unreachable' })
    })

    it('并发重入：第二次被拒', async () => {
        let release = () => {}
        const gate = new Promise<void>((r) => { release = r })
        const client = {
            listSessions: () => gate.then(() => [] as WeflowSession[]),
            fetchMessagesPage: () => Promise.resolve({ messages: [], hasMore: false }),
        }
        const svc = new SyncService(deps(db, client as never))
        const p1 = svc.syncGroupsNow()
        const r2 = await svc.syncGroupsNow()
        expect(r2.ok).toBe(false)
        release()
        const r1 = await p1
        expect(r1.ok).toBe(true)
    })
})
