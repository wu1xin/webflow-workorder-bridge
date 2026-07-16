import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Db } from '../db/database.js'
import { SyncService, parseRealtimeTrigger, parseSseEnvelope } from './syncService.js'
import { GroupSyncService } from './groupSyncService.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'
import type { WeflowSession, MessagesPage, MembersResult } from '../weflow/restClient.js'

/** 构造一条 SSE 事件（默认 message.new） */
function sseEvent(sessionId: string, ts: number, event = 'message.new') {
    return { event, data: JSON.stringify({ event, sessionId, rawid: `r${ts}`, content: 'hi', timestamp: ts }) }
}

function stubClient(sessions: WeflowSession[], pages: Record<string, MessagesPage>, members: Record<string, MembersResult> = {}) {
    return {
        listSessions: () => Promise.resolve(sessions),
        fetchMessagesPage: (talker: string) => Promise.resolve(pages[talker] ?? { messages: [], hasMore: false }),
        fetchMembers: (talker: string) => Promise.resolve(members[talker] ?? { groupName: null, groupAvatar: null, members: new Map() }),
    }
}

// 群同步桩：默认 no-op（测试自己预置 chat_group 放行）
const noopGroupSync = { syncAll: () => Promise.resolve([] as string[]) }

function deps(db: Db, client: ReturnType<typeof stubClient>, groupSync: { syncAll: () => Promise<string[]> } = noopGroupSync) {
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

    it('补全发送人名字/头像入 queue 列，并 upsert 群头像', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient(
            [{ username: 'proj@chatroom', type: 2 }],
            { 'proj@chatroom': { messages: [{ serverId: 's1', createTime: 100, senderUsername: 'wxid_a', content: 'a' }], hasMore: false } },
            { 'proj@chatroom': {
                groupName: '项目群', groupAvatar: 'https://av/g.png',
                members: new Map([['wxid_a', { name: '无心', avatar: 'https://av/a.png' }]]),
            } },
        )
        await new SyncService(deps(db, client)).runFullSync()

        const row = db.raw.prepare('SELECT sender_name, sender_avatar FROM queue').get() as { sender_name: string, sender_avatar: string }
        expect(row.sender_name).toBe('无心')
        expect(row.sender_avatar).toBe('https://av/a.png')
        expect(db.chatGroup.listAll(WEFLOW_CHANNEL_ID)[0].avatarUrl).toBe('https://av/g.png')
    })

    it('fetchMembers 失败不阻断落库，sender 降级为 null', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = {
            listSessions: () => Promise.resolve([{ username: 'proj@chatroom', type: 2 }]),
            fetchMessagesPage: () => Promise.resolve({ messages: [{ serverId: 's1', createTime: 100, senderUsername: 'wxid_a' }], hasMore: false }),
            fetchMembers: () => Promise.reject(new Error('chatlab boom')),
        }
        await new SyncService(deps(db, client as never)).runFullSync()

        expect(db.queue.countByStatus('pending')).toBe(1)
        const row = db.raw.prepare('SELECT sender_name FROM queue').get() as { sender_name: string | null }
        expect(row.sender_name).toBeNull()
    })

    it('新入队时触发 onEnqueued 回调（供 forwarder kick）', async () => {
        allowGroup(db, 'proj@chatroom')
        let kicks = 0
        const client = stubClient(
            [{ username: 'proj@chatroom', type: 2 }],
            { 'proj@chatroom': { messages: [{ serverId: 's1', createTime: 100, content: 'a' }], hasMore: false } },
        )
        const d = deps(db, client)
        const svc = new SyncService({ ...d, onEnqueued: () => { kicks++ } })
        await svc.runFullSync()
        expect(kicks).toBeGreaterThanOrEqual(1)
    })
})

describe('SyncService.triggerFullSync（强制全量重拉）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('无视水位从头拉全部历史入队，accepted=true 且立即置忙', async () => {
        allowGroup(db, 'proj@chatroom')
        // 预置一个高水位：全量重拉应无视它、仍从 0 拉（否则 100/200 会被跳过）
        db.channelState.advanceWatermark(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, 500, 'r500', 1)
        const client = stubClient(
            [{ username: 'proj@chatroom', type: 2 }],
            { 'proj@chatroom': { messages: [
                { serverId: 's1', createTime: 100, content: 'a' },
                { serverId: 's2', createTime: 200, content: 'b' },
            ], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        const res = svc.triggerFullSync()
        expect(res.accepted).toBe(true)
        expect(res.status.running).toBe(true)
        expect(res.status.mode).toBe('full')

        await vi.waitFor(() => expect(svc.getStatus().running).toBe(false))
        expect(db.queue.countByStatus('pending')).toBe(2)
    })

    it('已有同步在跑：第二次 accepted=false', async () => {
        allowGroup(db, 'proj@chatroom')
        let release = () => {}
        const gate = new Promise<void>((r) => { release = r })
        const client = {
            listSessions: () => gate.then(() => [{ username: 'proj@chatroom', type: 2 }] as WeflowSession[]),
            fetchMessagesPage: () => Promise.resolve({ messages: [], hasMore: false }),
        }
        const svc = new SyncService(deps(db, client as never))
        expect(svc.triggerFullSync().accepted).toBe(true)
        expect(svc.triggerFullSync().accepted).toBe(false)
        release()
        await vi.waitFor(() => expect(svc.getStatus().running).toBe(false))
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
                return Promise.resolve([] as string[])
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

describe('parseSseEnvelope（SSE 信封富解析）', () => {
    it('合法 message.new → 全字段', () => {
        const data = JSON.stringify({
            event: 'message.new', sessionId: 'g@chatroom', sessionType: 'group',
            avatarUrl: 'https://wx/g.png', groupName: 'g@chatroom', content: '你修改群名为“X”', timestamp: 123,
        })
        expect(parseSseEnvelope(data)).toEqual({
            talker: 'g@chatroom', ts: 123, sessionType: 'group', content: '你修改群名为“X”', avatarUrl: 'https://wx/g.png',
        })
    })

    it('缺 sessionType/content/avatarUrl → 缺省 ""/""/null', () => {
        expect(parseSseEnvelope(JSON.stringify({ event: 'message.new', sessionId: 'g@chatroom', timestamp: 1 })))
            .toEqual({ talker: 'g@chatroom', ts: 1, sessionType: '', content: '', avatarUrl: null })
    })

    it('非 message.new / 坏 JSON / 缺 sessionId|timestamp → null', () => {
        expect(parseSseEnvelope(JSON.stringify({ event: 'message.revoke', sessionId: 'g@chatroom', timestamp: 1 }))).toBeNull()
        expect(parseSseEnvelope('{nope')).toBeNull()
        expect(parseSseEnvelope(JSON.stringify({ event: 'message.new', timestamp: 1 }))).toBeNull()
        expect(parseSseEnvelope(JSON.stringify({ event: 'message.new', sessionId: 'g@chatroom' }))).toBeNull()
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

describe('SyncService 系统消息分发（群改名 localType 10000）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    /** 收集 syncAll 调用的群快照，便于断言回推内容 */
    function spyGroupSync() {
        const calls: Array<{ conv: string, name?: string }> = []
        return {
            calls,
            syncAll: (_ch: string, _pf: string, sessions: WeflowSession[]) => {
                for (const s of sessions) calls.push({ conv: s.username, name: s.displayName })
                return Promise.resolve([] as string[])
            },
        }
    }

    it('放行群收到改名系统消息：以新名回推下游单群', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient([], { 'proj@chatroom': { messages: [
            { serverId: 's-rename', createTime: 300, localType: 10000, content: '你修改群名为“新群名-18266”' },
        ], hasMore: false } })
        const gs = spyGroupSync()
        const svc = new SyncService({ ...deps(db, client), groupSync: gs as never })
        await svc.ingestRealtime(sseEvent('proj@chatroom', 300))

        expect(gs.calls).toEqual([{ conv: 'proj@chatroom', name: '新群名-18266' }])
    })

    it('普通消息不触发回推', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient([], { 'proj@chatroom': { messages: [
            { serverId: 's1', createTime: 300, content: '一条普通消息' },
        ], hasMore: false } })
        const gs = spyGroupSync()
        const svc = new SyncService({ ...deps(db, client), groupSync: gs as never })
        await svc.ingestRealtime(sseEvent('proj@chatroom', 300))

        expect(gs.calls).toEqual([])
    })

    it('重复改名消息只回推一次（绑在新入队上去重）', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient([], { 'proj@chatroom': { messages: [
            { serverId: 's-rename', createTime: 300, localType: 10000, content: '你修改群名为“N”' },
        ], hasMore: false } })
        const gs = spyGroupSync()
        const svc = new SyncService({ ...deps(db, client), groupSync: gs as never })
        await svc.ingestRealtime(sseEvent('proj@chatroom', 300))
        await svc.ingestRealtime(sseEvent('proj@chatroom', 300)) // 同一条 serverId

        expect(gs.calls).toHaveLength(1)
    })

    it('无 groupSync：改名只更新本地群名', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient([], { 'proj@chatroom': { messages: [
            { serverId: 's-rename', createTime: 300, localType: 10000, content: '你修改群名为“仅本地名”' },
        ], hasMore: false } })
        const svc = new SyncService({ ...deps(db, client), groupSync: undefined })
        await svc.ingestRealtime(sseEvent('proj@chatroom', 300))

        expect(db.chatGroup.listAll(WEFLOW_CHANNEL_ID)[0].groupName).toBe('仅本地名')
    })
})

describe('SyncService 群生命周期旁路（新入群 / 非放行群改名，放行闸门之前）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    /** 构造一条群 SSE 事件（可带 sessionType/content/avatarUrl） */
    function groupSse(sessionId: string, opts: { content?: string, sessionType?: string, avatarUrl?: string | null, ts?: number } = {}) {
        const { content = 'hi', sessionType = 'group', avatarUrl = null, ts = 100 } = opts
        return { event: 'message.new', data: JSON.stringify({ event: 'message.new', sessionId, sessionType, avatarUrl, content, timestamp: ts }) }
    }

    /** 收集 syncAll 调用的完整会话，便于断言回推内容（noop：不改库） */
    function spyGroupSync() {
        const calls: WeflowSession[] = []
        return {
            calls,
            syncAll: (_ch: string, _pf: string, sessions: WeflowSession[]) => { calls.push(...sessions); return Promise.resolve([] as string[]) },
        }
    }

    /** 计数 fetchMessagesPage 的 client（断言未放行群不回查） */
    function countingClient() {
        const state = { pulls: 0 }
        return {
            state,
            client: {
                listSessions: () => Promise.resolve([] as WeflowSession[]),
                fetchMessagesPage: () => { state.pulls += 1; return Promise.resolve({ messages: [], hasMore: false }) },
            },
        }
    }

    it('新入群：未知群触发单群 syncAll（displayName=null, type=2）并建行，不回查 REST', async () => {
        const gs = spyGroupSync()
        const { state, client } = countingClient()
        const svc = new SyncService({ ...deps(db, client as never), groupSync: gs as never })

        await svc.ingestRealtime(groupSse('new@chatroom', { avatarUrl: 'https://wx/g.png' }))

        expect(gs.calls).toEqual([{ username: 'new@chatroom', type: 2 }]) // 名字未知（省略 displayName）→ 真实 syncAll 内 ?? null
        expect(db.chatGroup.exists(WEFLOW_CHANNEL_ID, 'new@chatroom')).toBe(true)
        expect(db.chatGroup.listAll(WEFLOW_CHANNEL_ID)[0].avatarUrl).toBe('https://wx/g.png') // 可信头像落库，喂给真实 syncAll
        expect(state.pulls).toBe(0) // 未放行 → 不回查正文
    })

    it('入群突发：同群多条 SSE 只触发一次 syncAll（建行即已知，天然防抖）', async () => {
        const gs = spyGroupSync()
        const { client } = countingClient()
        const svc = new SyncService({ ...deps(db, client as never), groupSync: gs as never })

        await svc.ingestRealtime(groupSse('new@chatroom', { ts: 100 }))
        await svc.ingestRealtime(groupSse('new@chatroom', { ts: 101 }))
        await svc.ingestRealtime(groupSse('new@chatroom', { ts: 102 }))

        expect(gs.calls).toHaveLength(1)
    })

    it('未知单聊：isGroupSession 守卫拦截，不登记、不 syncAll', async () => {
        const gs = spyGroupSync()
        const { client } = countingClient()
        const svc = new SyncService({ ...deps(db, client as never), groupSync: gs as never })

        await svc.ingestRealtime(groupSse('wxid_bob', { sessionType: 'single' }))

        expect(gs.calls).toEqual([])
        expect(db.chatGroup.exists(WEFLOW_CHANNEL_ID, 'wxid_bob')).toBe(false)
    })

    it('未配 groupSync：新群仅 upsertSeen 建行（默认不放行）、不抛', async () => {
        const { client } = countingClient()
        const svc = new SyncService({ ...deps(db, client as never), groupSync: undefined })

        await svc.ingestRealtime(groupSse('new@chatroom', { avatarUrl: 'https://wx/g.png' }))

        expect(db.chatGroup.exists(WEFLOW_CHANNEL_ID, 'new@chatroom')).toBe(true)
        expect(db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, 'new@chatroom')).toBe(false)
    })

    it('已知非放行群改名：SSE 信封 content 匹配 → 以新名回推单群', async () => {
        db.chatGroup.upsertSeen(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, 'known@chatroom', { groupName: '旧名' }, 1) // 已知、未放行
        const gs = spyGroupSync()
        const { client } = countingClient()
        const svc = new SyncService({ ...deps(db, client as never), groupSync: gs as never })

        await svc.ingestRealtime(groupSse('known@chatroom', { content: '你修改群名为“新名-18267”' }))

        expect(gs.calls).toEqual([{ username: 'known@chatroom', displayName: '新名-18267', type: 2 }])
    })

    it('已知非放行群普通消息：不触发 syncAll', async () => {
        db.chatGroup.upsertSeen(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, 'known@chatroom', {}, 1)
        const gs = spyGroupSync()
        const { client } = countingClient()
        const svc = new SyncService({ ...deps(db, client as never), groupSync: gs as never })

        await svc.ingestRealtime(groupSse('known@chatroom', { content: '一条普通消息' }))

        expect(gs.calls).toEqual([])
    })

    it('放行群改名：信封路径不触发（交由 REST localType 路径），转而回查 REST', async () => {
        allowGroup(db, 'proj@chatroom')
        const gs = spyGroupSync()
        const { state, client } = countingClient()
        const svc = new SyncService({ ...deps(db, client as never), groupSync: gs as never })

        await svc.ingestRealtime(groupSse('proj@chatroom', { content: '你修改群名为“不该走信封”' }))

        expect(gs.calls).toEqual([]) // 信封改名分支只管非放行群
        expect(state.pulls).toBeGreaterThanOrEqual(1) // 放行群照常回查
    })
})

describe('SyncService 放行边沿自动回灌（backfillNewlyAllowed）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    const gsLog = { info() {}, warn() {}, error() {}, debug() {} } as never

    it('backfillNewlyAllowed：起点=该群 queue 最大 msg_timestamp（无记录则 0）', async () => {
        allowGroup(db, 'proj@chatroom')
        db.queue.enqueue({
            channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: 'message.new',
            externalId: 's-old', conversationId: 'proj@chatroom', senderId: null, senderName: null, senderAvatar: null,
            msgTimestamp: 250, hasMedia: 0, rawJson: '{}', mediaJson: null, ingestPath: 'sse', revocableUntil: null,
        }, 1)
        let seenStart = -1
        const client = {
            listSessions: () => Promise.resolve([] as WeflowSession[]),
            fetchMessagesPage: (_t: string, start: number) => { seenStart = start; return Promise.resolve({ messages: [], hasMore: false }) },
            fetchMembers: () => Promise.resolve({ groupName: null, groupAvatar: null, members: new Map() }),
        }
        const svc = new SyncService(deps(db, client as never))
        await svc['backfillNewlyAllowed'](['proj@chatroom'])
        expect(seenStart).toBe(250)

        await svc['backfillNewlyAllowed'](['fresh@chatroom'])
        expect(seenStart).toBe(0)
    })

    it('空列表：no-op、不发 REST', async () => {
        let calls = 0
        const client = {
            listSessions: () => Promise.resolve([] as WeflowSession[]),
            fetchMessagesPage: () => { calls += 1; return Promise.resolve({ messages: [], hasMore: false }) },
            fetchMembers: () => Promise.resolve({ groupName: null, groupAvatar: null, members: new Map() }),
        }
        const svc = new SyncService(deps(db, client as never))
        await svc['backfillNewlyAllowed']([])
        expect(calls).toBe(0)
    })

    it('端到端：新入群下游放行 → backfill 从 0 全量回灌该群历史（ingest_path=sse）', async () => {
        const client = stubClient([], { 'proj@chatroom': { messages: [
            { serverId: 's1', createTime: 100, content: 'a' },
            { serverId: 's2', createTime: 200, content: 'b' },
        ], hasMore: false } })
        const groupSync = new GroupSyncService({
            db, downstream: { syncGroups: () => Promise.resolve({ allowed: ['proj@chatroom'] }) } as never,
            log: gsLog, alert: { send() {} }, now: () => 1,
        })
        const svc = new SyncService({ ...deps(db, client), groupSync })

        await svc.ingestRealtime(groupSse('proj@chatroom', {}))

        expect(db.queue.countByStatus('pending')).toBe(2)
        const { items } = db.queue.list(WEFLOW_CHANNEL_ID, {}, 10, 0)
        expect(items.every(i => i.ingestPath === 'sse')).toBe(true)
    })

    it('补偿路径：新放行群在全局水位之下的历史也被回灌（不被主循环顶高水位吞掉）', async () => {
        const now = Math.floor(Date.now() / 1000)
        db.channelState.advanceWatermark(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, now - 100, '', 1) // 全局水位
        const all = { 'proj@chatroom': [
            { serverId: 's-a', createTime: now - 300, content: 'a' }, // 水位下
            { serverId: 's-b', createTime: now - 200, content: 'b' }, // 水位下
            { serverId: 's-c', createTime: now - 50, content: 'c' },  // 水位上
        ] }
        const client = {
            listSessions: () => Promise.resolve([{ username: 'proj@chatroom', type: 2, lastTimestamp: now - 50 }] as WeflowSession[]),
            fetchMessagesPage: (talker: string, start: number) => Promise.resolve({
                messages: (all[talker as keyof typeof all] ?? []).filter(m => m.createTime >= start), hasMore: false,
            }),
            fetchMembers: () => Promise.resolve({ groupName: null, groupAvatar: null, members: new Map() }),
        }
        const groupSync = new GroupSyncService({
            db, downstream: { syncGroups: () => Promise.resolve({ allowed: ['proj@chatroom'] }) } as never,
            log: gsLog, alert: { send() {} }, now: () => 1,
        })
        const svc = new SyncService({ ...deps(db, client as never), groupSync })

        await svc.runCompensation()

        expect(db.queue.countByStatus('pending')).toBe(3) // 水位下的 a/b + 水位上的 c 全部回灌
    })

    it('端到端横跳：不放行期消息被闸门丢弃，改回放行经 SSE 改名触发 backfill 从水位补回空档，二次横跳不重', async () => {
        const now = Math.floor(Date.now() / 1000)
        let available: Array<{ serverId: string, createTime: number, content?: string }> = []
        const client = {
            listSessions: () => Promise.resolve([] as WeflowSession[]),
            fetchMessagesPage: (_t: string, start: number) => Promise.resolve({
                messages: available.filter(m => m.createTime >= start), hasMore: false,
            }),
            fetchMembers: () => Promise.resolve({ groupName: null, groupAvatar: null, members: new Map() }),
        }
        let allowNow = true
        const groupSync = new GroupSyncService({
            db, downstream: { syncGroups: () => Promise.resolve({ allowed: allowNow ? ['g@chatroom'] : [] }) } as never,
            log: gsLog, alert: { send() {} }, now: () => 1,
        })
        const svc = new SyncService({ ...deps(db, client as never), groupSync })

        // 群已知且放行；放行期 s1 经 SSE 回查入队（水位=now-500）
        db.chatGroup.upsertSeen(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, 'g@chatroom', {}, 1)
        db.chatGroup.markSynced(WEFLOW_CHANNEL_ID, ['g@chatroom'], ['g@chatroom'], 1)
        available = [{ serverId: 's1', createTime: now - 500, content: 'm1' }]
        await svc.ingestRealtime(sseEvent('g@chatroom', now - 500))
        expect(db.queue.countByStatus('pending')).toBe(1)

        // 群名变化致下游改判不放行（这里直接翻转裁决模拟「放行群改名→不放行」的结果；
        // 该 REST localType 改名链本身已由「系统消息分发」describe 覆盖，本用例聚焦 drop+backfill）
        allowNow = false
        db.chatGroup.markSynced(WEFLOW_CHANNEL_ID, ['g@chatroom'], [], 2)
        expect(db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, 'g@chatroom')).toBe(false)

        // 不放行期：s2/s3 到达 → 闸门 drop（不回查、不入队）
        available.push(
            { serverId: 's2', createTime: now - 400, content: 'gap1' },
            { serverId: 's3', createTime: now - 300, content: 'gap2' },
        )
        await svc.ingestRealtime(sseEvent('g@chatroom', now - 400))
        await svc.ingestRealtime(sseEvent('g@chatroom', now - 300))
        expect(db.queue.countByStatus('pending')).toBe(1)

        // 群名改回 → 下游改判放行 → SSE 改名分支（已知非放行群 content 匹配）→ onGroupRenamed → 0→1 → backfill 从水位(now-500)补
        allowNow = true
        await svc.ingestRealtime(groupSse('g@chatroom', { content: '你修改群名为“原名-001”', ts: now - 250 }))
        expect(db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, 'g@chatroom')).toBe(true)
        expect(db.queue.countByStatus('pending')).toBe(3) // s1(dup 不重) + 补回 s2,s3

        // 二次横跳：再不放行 → 期间 s4 drop → 再放行只补 s4，s1/s2/s3 dedup 不重
        allowNow = false
        db.chatGroup.markSynced(WEFLOW_CHANNEL_ID, ['g@chatroom'], [], 3)
        available.push({ serverId: 's4', createTime: now - 100, content: 'gap3' })
        await svc.ingestRealtime(sseEvent('g@chatroom', now - 100))
        expect(db.queue.countByStatus('pending')).toBe(3)
        allowNow = true
        await svc.ingestRealtime(groupSse('g@chatroom', { content: '你修改群名为“原名-002”', ts: now - 50 }))
        expect(db.queue.countByStatus('pending')).toBe(4)
    })

    function groupSse(sessionId: string, opts: { content?: string, sessionType?: string, avatarUrl?: string | null, ts?: number } = {}) {
        const { content = 'hi', sessionType = 'group', avatarUrl = null, ts = 100 } = opts
        return { event: 'message.new', data: JSON.stringify({ event: 'message.new', sessionId, sessionType, avatarUrl, content, timestamp: ts }) }
    }
})

describe('SyncService 撤回检测（revocable_until 看守 + 对账扫描）', () => {
    const REVOKE_RAW = '<?xml version="1.0"?><sysmsg type="revokemsg"><revokemsg><content>"无心" 撤回了一条消息</content></revokemsg></sysmsg>'
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    /** 直接埋一条「看守中」的已入队消息（revocable_until > now），免去走实时入库的铺垫 */
    function enqueueWatch(conv: string, serverId: string, revocableUntil: number, msgTs: number) {
        db.queue.enqueue({
            channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: 'message.new',
            externalId: serverId, conversationId: conv, senderId: 'u', senderName: null, senderAvatar: null, msgTimestamp: msgTs,
            hasMedia: 0, rawJson: '{}', mediaJson: null, ingestPath: 'sse', revocableUntil,
        }, msgTs)
    }
    function revokeRow(serverId: string, createTime: number) {
        return { serverId, localType: 10000, createTime, content: REVOKE_RAW, rawContent: REVOKE_RAW }
    }
    function revokeEvents() {
        return db.queue.list(WEFLOW_CHANNEL_ID, {}, 50, 0).items.filter(i => i.eventType === 'message.revoke')
    }

    it('看守中的消息变成撤回态 → 入队 message.revoke(reconcile) 并清看守', async () => {
        const NOW = Math.floor(Date.now() / 1000)
        allowGroup(db, 'g@chatroom')
        enqueueWatch('g@chatroom', 's1', NOW + 150, NOW)
        const client = stubClient([], { 'g@chatroom': { messages: [revokeRow('s1', NOW)], hasMore: false } })
        const svc = new SyncService(deps(db, client))

        await svc.reconcileRevokes()

        const ev = revokeEvents()
        expect(ev).toHaveLength(1)
        expect(ev[0].conversationId).toBe('g@chatroom')
        expect(ev[0].ingestPath).toBe('reconcile')
        expect(db.queue.getById(WEFLOW_CHANNEL_ID, ev[0].id)?.rawJson).toContain('s1')
        // 看守已清，不再重复扫
        expect(db.queue.listOpenRevokeWatches(WEFLOW_CHANNEL_ID, NOW)).toEqual([])
    })

    it('撤回事件只入队一次（重复对账不重复入队）', async () => {
        const NOW = Math.floor(Date.now() / 1000)
        allowGroup(db, 'g@chatroom')
        enqueueWatch('g@chatroom', 's1', NOW + 150, NOW)
        const client = stubClient([], { 'g@chatroom': { messages: [revokeRow('s1', NOW)], hasMore: false } })
        const svc = new SyncService(deps(db, client))

        await svc.reconcileRevokes()
        await svc.reconcileRevokes()

        expect(revokeEvents()).toHaveLength(1)
    })

    it('看守中的消息未被撤回 → 不产出、看守保留', async () => {
        const NOW = Math.floor(Date.now() / 1000)
        allowGroup(db, 'g@chatroom')
        enqueueWatch('g@chatroom', 's1', NOW + 150, NOW)
        const client = stubClient([], { 'g@chatroom': { messages: [{ serverId: 's1', createTime: NOW, content: '1' }], hasMore: false } })
        const svc = new SyncService(deps(db, client))

        await svc.reconcileRevokes()

        expect(revokeEvents()).toHaveLength(0)
        expect(db.queue.listOpenRevokeWatches(WEFLOW_CHANNEL_ID, NOW).map(w => w.externalId)).toEqual(['s1'])
    })

    it('无任何看守 → 不发 REST', async () => {
        let calls = 0
        const client = {
            listSessions: () => Promise.resolve([] as WeflowSession[]),
            fetchMessagesPage: () => { calls += 1; return Promise.resolve({ messages: [], hasMore: false }) },
        }
        const svc = new SyncService(deps(db, client as never))
        await svc.reconcileRevokes()
        expect(calls).toBe(0)
    })

    it('文件消息（超出近窗、仍在 3h 窗口）→ 定向探针 start≈end 探到撤回', async () => {
        const NOW = Math.floor(Date.now() / 1000)
        allowGroup(db, 'g@chatroom')
        // 文件消息 createTime 在近窗(150s)之外，但仍在 3h 撤回窗口内
        enqueueWatch('g@chatroom', 'f1', NOW + 3 * 3600, NOW - 200)
        const client = {
            listSessions: () => Promise.resolve([] as WeflowSession[]),
            // 近窗粗拉（无 end）返回空；定向探针（带 end）返回撤回态
            fetchMessagesPage: (_t: string, _s: number, _o: number, _l?: number, end?: number) =>
                Promise.resolve(end !== undefined
                    ? { messages: [revokeRow('f1', NOW - 200)], hasMore: false }
                    : { messages: [], hasMore: false }),
        }
        const svc = new SyncService(deps(db, client as never))

        await svc.reconcileRevokes()

        const ev = revokeEvents()
        expect(ev).toHaveLength(1)
        expect(db.queue.getById(WEFLOW_CHANNEL_ID, ev[0].id)?.rawJson).toContain('f1')
    })

    it('历史撤回行（serverId 从未入库）→ 作为系统消息入队（message.new + 撤回文案），不建撤回看守', async () => {
        const NOW = Math.floor(Date.now() / 1000)
        allowGroup(db, 'g@chatroom')
        // 回查只返回一条「从未见过的 serverId 的撤回行」（模拟全量/重拉拉到历史撤回，原文 REST 已不返回）
        const client = stubClient([], { 'g@chatroom': { messages: [revokeRow('hist', NOW)], hasMore: false } })
        const svc = new SyncService(deps(db, client))

        await svc.ingestRealtime(sseEvent('g@chatroom', NOW))

        expect(db.queue.countByStatus('pending')).toBe(1)
        const item = db.queue.list(WEFLOW_CHANNEL_ID, {}, 20, 0).items[0]
        expect(item.eventType).toBe('message.new')
        expect(db.queue.getById(WEFLOW_CHANNEL_ID, item.id)?.rawJson).toContain('撤回了一条消息')
        // 系统消息不建看守（computeRevocableUntil 对 localType 10000 返回 null）
        expect(db.queue.listOpenRevokeWatches(WEFLOW_CHANNEL_ID, 0)).toEqual([])
    })

    it('原消息已入库（serverId 已在 dedup）→ 再拉到其撤回行不重复入队', async () => {
        const NOW = Math.floor(Date.now() / 1000)
        allowGroup(db, 'g@chatroom')
        const pages: Record<string, MessagesPage> = {
            'g@chatroom': { messages: [{ serverId: 's1', createTime: NOW, content: 'hello' }], hasMore: false },
        }
        const client = stubClient([], pages)
        const svc = new SyncService(deps(db, client))

        await svc.ingestRealtime(sseEvent('g@chatroom', NOW))
        expect(db.queue.countByStatus('pending')).toBe(1) // 原消息 message.new

        // 原消息被撤回：同 serverId 那行原地翻成撤回态
        pages['g@chatroom'] = { messages: [revokeRow('s1', NOW)], hasMore: false }
        await svc.ingestRealtime(sseEvent('g@chatroom', NOW + 1))

        expect(db.queue.countByStatus('pending')).toBe(1) // 撤回行撞 dedup(s1)，不重复入队
    })

    it('清空重拉：重拉到该群仅剩的撤回行时，作为系统消息补回入队', async () => {
        const NOW = Math.floor(Date.now() / 1000)
        allowGroup(db, 'g@chatroom')
        const client = stubClient([], { 'g@chatroom': { messages: [revokeRow('gone', NOW)], hasMore: false } })
        const svc = new SyncService(deps(db, client))

        const res = svc.resetGroup('g@chatroom')
        expect(res.accepted).toBe(true)

        await vi.waitFor(() => expect(db.queue.countByStatus('pending')).toBe(1))
        expect(db.queue.list(WEFLOW_CHANNEL_ID, {}, 20, 0).items[0].eventType).toBe('message.new')
    })
})

describe('SyncService.resetGroup（单群清空重拉）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('非忙：清空该群 queue+dedup 并从 0 定向重拉（dedup 已清 → 真重新入队），保留 push_allowed', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient(
            [{ username: 'proj@chatroom', type: 2 }],
            { 'proj@chatroom': { messages: [
                { serverId: 's1', createTime: 100, content: 'a' },
                { serverId: 's2', createTime: 200, content: 'b' },
            ], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        await svc.runFullSync()
        expect(db.queue.countByStatus('pending')).toBe(2)

        // 复用现成单群回拉链，起点必须为 0
        const spy = vi.spyOn(svc as never, 'scheduleRealtimePull')
        const res = svc.resetGroup('proj@chatroom')

        expect(res.accepted).toBe(true)
        expect(spy).toHaveBeenCalledWith('proj@chatroom', 0)
        // 删除是同步的、重拉是异步的：返回后该群 queue 已清空
        expect(db.queue.list(WEFLOW_CHANNEL_ID, { conversationId: 'proj@chatroom' }, 20, 0).total).toBe(0)

        // 重拉完成后真重新入队（dedup 已清，未被挡）
        await vi.waitFor(() => expect(db.queue.countByStatus('pending')).toBe(2))
        // 保留放行裁决
        expect(db.chatGroup.listAllowed(WEFLOW_CHANNEL_ID)).toContain('proj@chatroom')
    })

    it('已有同步在跑：accepted=false 且不删数据', async () => {
        allowGroup(db, 'proj@chatroom')
        // 预置该群一条 queue + dedup，随后应保持不变
        db.queue.enqueue({
            channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: 'message.new',
            externalId: 'srv-1', conversationId: 'proj@chatroom', senderId: null, senderName: null, senderAvatar: null,
            msgTimestamp: 100, hasMedia: 0, rawJson: '{}', mediaJson: null, ingestPath: 'catchup', revocableUntil: null,
        }, 1)
        db.dedup.markIfNew(WEFLOW_CHANNEL_ID, 'srv-1', 1)

        let release = () => {}
        const gate = new Promise<void>((r) => { release = r })
        const client = {
            listSessions: () => gate.then(() => [{ username: 'proj@chatroom', type: 2 }] as WeflowSession[]),
            fetchMessagesPage: () => Promise.resolve({ messages: [], hasMore: false }),
        }
        const svc = new SyncService(deps(db, client as never))
        expect(svc.triggerFullSync().accepted).toBe(true)

        expect(svc.resetGroup('proj@chatroom').accepted).toBe(false)
        expect(db.queue.list(WEFLOW_CHANNEL_ID, { conversationId: 'proj@chatroom' }, 20, 0).total).toBe(1)
        expect(db.dedup.markIfNew(WEFLOW_CHANNEL_ID, 'srv-1', 2)).toBe(false) // dedup 未被清

        release()
        await vi.waitFor(() => expect(svc.getStatus().running).toBe(false))
    })
})

describe('SyncService.resetAllAndFullSync（全部清空重拉）', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('非忙：清空整 channel 后全量重灌（dedup 已清 → 原样重新入队）', async () => {
        allowGroup(db, 'proj@chatroom')
        const client = stubClient(
            [{ username: 'proj@chatroom', type: 2 }],
            { 'proj@chatroom': { messages: [
                { serverId: 's1', createTime: 100, content: 'a' },
                { serverId: 's2', createTime: 200, content: 'b' },
            ], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        await svc.runFullSync()
        expect(db.queue.countByStatus('pending')).toBe(2)

        const res = svc.resetAllAndFullSync()
        expect(res.accepted).toBe(true)
        expect(res.status.running).toBe(true)
        expect(res.status.mode).toBe('full')

        await vi.waitFor(() => expect(svc.getStatus().running).toBe(false))
        // 若 dedup 未清，重灌会被去重挡成 0；这里应仍为 2 → 证明清空生效（原 2 行已删、重新入队 2 行）
        expect(db.queue.countByStatus('pending')).toBe(2)
    })

    it('已有同步在跑：accepted=false 且不清数据', async () => {
        allowGroup(db, 'proj@chatroom')
        db.queue.enqueue({
            channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: 'message.new',
            externalId: 'srv-1', conversationId: 'proj@chatroom', senderId: null, senderName: null, senderAvatar: null,
            msgTimestamp: 100, hasMedia: 0, rawJson: '{}', mediaJson: null, ingestPath: 'catchup', revocableUntil: null,
        }, 1)

        let release = () => {}
        const gate = new Promise<void>((r) => { release = r })
        const client = {
            listSessions: () => gate.then(() => [] as WeflowSession[]),
            fetchMessagesPage: () => Promise.resolve({ messages: [], hasMore: false }),
        }
        const svc = new SyncService(deps(db, client as never))
        expect(svc.triggerFullSync().accepted).toBe(true)

        expect(svc.resetAllAndFullSync().accepted).toBe(false)
        expect(db.queue.countByStatus('pending')).toBe(1) // 未清

        release()
        await vi.waitFor(() => expect(svc.getStatus().running).toBe(false))
    })
})
