import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db } from '../db/database.js'
import { SyncService, parseRealtimeTrigger } from './syncService.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'
import type { WeflowSession, MessagesPage } from '../weflow/restClient.js'

/** 构造一条 SSE 事件（默认 message.new） */
function sseEvent(sessionId: string, ts: number, event = 'message.new') {
    return { event, data: JSON.stringify({ event, sessionId, rawid: `r${ts}`, content: 'hi', timestamp: ts }) }
}

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

    it('未配置下游：所有群仍入库（默认不放行、不入队）', async () => {
        const client = stubClient([
            { username: 'g1@chatroom', type: 2 },
            { username: 'g2@chatroom', type: 2 },
            { username: 'wxid_alice', type: 1 },
        ], {})
        const svc = new SyncService({ ...deps(db, client), groupSync: undefined })
        await svc.runFullSync()

        const all = db.chatGroup.listAll(WEFLOW_CHANNEL_ID)
        expect(all.map(g => g.conversationId).sort()).toEqual(['g1@chatroom', 'g2@chatroom'])
        expect(all.every(g => !g.pushAllowed)).toBe(true)
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

    it('未配置 groupSync：仍拉会话把群入库（不放行），ok:true', async () => {
        const client = stubClient([
            { username: 'g1@chatroom', type: 2 },
            { username: 'g2@chatroom', type: 2 },
            { username: 'wxid_alice', type: 1 },
        ], {})
        const svc = new SyncService({ ...deps(db, client), groupSync: undefined })
        const res = await svc.syncGroupsNow()
        expect(res).toEqual({ ok: true, total: 2, allowed: 0 })
        expect(db.chatGroup.listAll(WEFLOW_CHANNEL_ID).every(g => !g.pushAllowed)).toBe(true)
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

describe('parseRealtimeTrigger（SSE message.new 触发参数解析）', () => {
    it('合法 message.new → {talker, ts}', () => {
        expect(parseRealtimeTrigger(JSON.stringify({ event: 'message.new', sessionId: 'g@chatroom', timestamp: 123 })))
            .toEqual({ talker: 'g@chatroom', ts: 123 })
    })
    it('message.revoke / 其它事件 → null', () => {
        expect(parseRealtimeTrigger(JSON.stringify({ event: 'message.revoke', sessionId: 'g@chatroom', timestamp: 1 }))).toBeNull()
    })
    it('坏 JSON → null', () => {
        expect(parseRealtimeTrigger('{nope')).toBeNull()
    })
    it('缺 sessionId 或 timestamp → null', () => {
        expect(parseRealtimeTrigger(JSON.stringify({ event: 'message.new', timestamp: 1 }))).toBeNull()
        expect(parseRealtimeTrigger(JSON.stringify({ event: 'message.new', sessionId: 'g@chatroom' }))).toBeNull()
    })
})

describe('SyncService 实时入库（SSE message.new 触发 REST 回查）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('放行群 message.new：回查 REST 并以 ingest_path=sse 入队', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient([], {
            'proj@chatroom': { messages: [
                { serverId: 's1', createTime: 100, content: 'a' },
                { serverId: 's2', createTime: 200, content: 'b' },
            ], hasMore: false },
        })
        const svc = new SyncService(deps(db, client))
        await svc.ingestRealtime(sseEvent('proj@chatroom', 200))

        expect(db.queue.countByStatus('pending')).toBe(2)
        const { items } = db.queue.list(WEFLOW_CHANNEL_ID, {}, 10, 0)
        expect(items.every(i => i.ingestPath === 'sse')).toBe(true)
    })

    it('非放行群：不发 REST、不入队', async () => {
        let calls = 0
        const client = {
            listSessions: () => Promise.resolve([] as WeflowSession[]),
            fetchMessagesPage: () => { calls += 1; return Promise.resolve({ messages: [{ serverId: 's1', createTime: 1 }], hasMore: false }) },
        }
        const svc = new SyncService(deps(db, client as never))
        await svc.ingestRealtime(sseEvent('blocked@chatroom', 1))
        expect(calls).toBe(0)
        expect(db.queue.countByStatus('pending')).toBe(0)
    })

    it('非 message.new 或坏 JSON：忽略、不抛、不发 REST', async () => {
        allowGroup(db, 'proj@chatroom')
        let calls = 0
        const client = {
            listSessions: () => Promise.resolve([] as WeflowSession[]),
            fetchMessagesPage: () => { calls += 1; return Promise.resolve({ messages: [], hasMore: false }) },
        }
        const svc = new SyncService(deps(db, client as never))
        await svc.ingestRealtime(sseEvent('proj@chatroom', 1, 'message.revoke'))
        await svc.ingestRealtime({ event: 'message', data: 'not-json{' })
        expect(calls).toBe(0)
        expect(db.queue.countByStatus('pending')).toBe(0)
    })

    it('跨路径去重：补偿已入队的 rawid，实时回查不重复入队', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient(
            [{ username: 'proj@chatroom', type: 2 }],
            { 'proj@chatroom': { messages: [{ serverId: 's1', createTime: 100 }], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        await svc.runFullSync()
        expect(db.queue.countByStatus('pending')).toBe(1)

        await svc.ingestRealtime(sseEvent('proj@chatroom', 100))
        expect(db.queue.countByStatus('pending')).toBe(1)
    })

    it('实时入库不污染同步进度（running 与计数不变）', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient([], { 'proj@chatroom': { messages: [{ serverId: 's1', createTime: 100 }], hasMore: false } })
        const svc = new SyncService(deps(db, client))
        await svc.ingestRealtime(sseEvent('proj@chatroom', 100))
        expect(svc.getStatus().running).toBe(false)
        expect(svc.getStatus().enqueued).toBe(0)
    })

    it('每会话合并：在途时多条同群事件只触发一次额外回查', async () => {
        allowGroup(db, 'proj@chatroom')
        let calls = 0
        let release = () => {}
        const gate = new Promise<void>((r) => { release = r })
        let first = true
        const client = {
            listSessions: () => Promise.resolve([] as WeflowSession[]),
            fetchMessagesPage: () => {
                calls += 1
                if (first) { first = false; return gate.then(() => ({ messages: [], hasMore: false })) }
                return Promise.resolve({ messages: [], hasMore: false })
            },
        }
        const svc = new SyncService(deps(db, client as never))
        const p1 = svc.ingestRealtime(sseEvent('proj@chatroom', 100)) // 第一次拉取，卡在 gate
        void svc.ingestRealtime(sseEvent('proj@chatroom', 101))       // 在途 → 合并
        void svc.ingestRealtime(sseEvent('proj@chatroom', 102))       // 在途 → 合并
        release()
        await p1
        expect(calls).toBe(2) // 第一次 + 合并后的一次补拉，而非 3 次
    })
})
