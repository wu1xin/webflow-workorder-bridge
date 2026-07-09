import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db } from '../db/database.js'
import { Forwarder } from './forwarder.js'
import type { DownstreamClient, ReceiveAck, ReceiveEnvelope } from './client.js'
import type { EnqueueInput } from '../db/queue.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never
const CFG = { baseUrl: 'https://dn', siteKey: 'k', aesKey: 'sixteen-byte-key' }

function enqueue(db: Db, over: Partial<EnqueueInput> = {}, now = 1000) {
    db.queue.enqueue({
        channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: 'message.new',
        externalId: 's1', conversationId: 'g@chatroom', senderId: null, senderName: null, senderAvatar: null,
        msgTimestamp: 100, hasMedia: 0, rawJson: '{"rawid":"s1"}', mediaJson: null,
        ingestPath: 'catchup', revocableUntil: null, ...over,
    }, now)
}

function makeForwarder(db: Db, receive: (env: ReceiveEnvelope) => Promise<ReceiveAck>, alert = { send() {} }) {
    const client: DownstreamClient = { syncGroups: () => Promise.resolve({ allowed: [] }), receiveMessage: receive, ping: () => Promise.resolve({ ok: true }) }
    const store = { getDownstream: () => CFG } as never
    return new Forwarder({ db, store, log: noopLog, alert, createClient: () => client, now: () => 2000 })
}

describe('Forwarder.drainOnce', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('code=1 → done + 推进投递断点 + 写审计', async () => {
        enqueue(db)
        await makeForwarder(db, () => Promise.resolve({ code: 1, receivedAt: 2001 })).drainOnce()
        expect(db.queue.countByStatus('done')).toBe(1)
        expect(db.channelState.get(WEFLOW_CHANNEL_ID)?.breakpointTimestamp).toBe(100)
        expect(db.audit.stats(WEFLOW_CHANNEL_ID)).toEqual({ totalSuccess: 1, totalFail: 0 })
    })

    it('把 conversationId 作为顶层 sessionId 透传给下游', async () => {
        enqueue(db, { conversationId: 'room123@chatroom' })
        let captured: ReceiveEnvelope | null = null
        await makeForwarder(db, (env) => { captured = env; return Promise.resolve({ code: 1 }) }).drainOnce()
        expect(captured!.sessionId).toBe('room123@chatroom')
        expect(captured!.event).toBe('message.new')
    })

    it('信封带顶层 sender（username/name/avatar），data 不被改动', async () => {
        enqueue(db, { senderId: 'wxid_a', senderName: '无心', senderAvatar: 'https://av/a.png', rawJson: '{"serverId":"s1","senderUsername":"wxid_a"}' })
        let captured: ReceiveEnvelope | null = null
        await makeForwarder(db, (env) => { captured = env; return Promise.resolve({ code: 1 }) }).drainOnce()
        expect(captured!.sender).toEqual({ username: 'wxid_a', name: '无心', avatar: 'https://av/a.png' })
        expect(captured!.data).toEqual({ serverId: 's1', senderUsername: 'wxid_a' })
    })

    it('未解析到身份时 sender.name/avatar 为 null', async () => {
        enqueue(db, { senderId: 'wxid_x' })
        let captured: ReceiveEnvelope | null = null
        await makeForwarder(db, (env) => { captured = env; return Promise.resolve({ code: 1 }) }).drainOnce()
        expect(captured!.sender).toEqual({ username: 'wxid_x', name: null, avatar: null })
    })

    it('duplicate=true 视为成功（done、不再发）', async () => {
        enqueue(db)
        let calls = 0
        await makeForwarder(db, () => { calls++; return Promise.resolve({ code: 1, duplicate: true }) }).drainOnce()
        expect(calls).toBe(1)
        expect(db.queue.countByStatus('done')).toBe(1)
    })

    it('code=1002 → dead + 审计计失败', async () => {
        enqueue(db)
        await makeForwarder(db, () => Promise.resolve({ code: 1002, retryable: false })).drainOnce()
        expect(db.queue.countByStatus('dead')).toBe(1)
        expect(db.audit.stats(WEFLOW_CHANNEL_ID)).toEqual({ totalSuccess: 0, totalFail: 1 })
    })

    it('传输层错误反复失败仍 retry、永不进死信（attempts 累加、留 pending、不写审计）', async () => {
        enqueue(db)
        const fw = makeForwarder(db, () => Promise.reject(new Error('boom')))
        const id = db.queue.list(WEFLOW_CHANNEL_ID, { status: 'pending' }, 10, 0).items[0].id
        // 连投 4 次（远超 maxAttempts=3），每次清退避让其可再取；旧逻辑此时早已 dead
        for (let i = 0; i < 4; i++) {
            await fw.drainOnce()
            db.raw.prepare('UPDATE queue SET next_attempt_at = NULL WHERE id = ?').run(id)
        }
        expect(db.queue.countByStatus('dead')).toBe(0)
        expect(db.queue.countByStatus('pending')).toBe(1)
        expect(db.queue.getById(WEFLOW_CHANNEL_ID, id)?.attempts).toBe(4)
        // 未进终态（done/dead），故不写审计
        expect(db.audit.stats(WEFLOW_CHANNEL_ID)).toEqual({ totalSuccess: 0, totalFail: 0 })
    })

    it('code=0 可重试 → 回 pending 且 attempts+1', async () => {
        enqueue(db)
        await makeForwarder(db, () => Promise.resolve({ code: 0 })).drainOnce()
        expect(db.queue.countByStatus('pending')).toBe(1)
        expect(db.queue.getById(WEFLOW_CHANNEL_ID, 1)?.attempts).toBe(1)
    })

    it('媒体消息(has_media=1)不取件，留 pending', async () => {
        enqueue(db, { hasMedia: 1 })
        let calls = 0
        await makeForwarder(db, () => { calls++; return Promise.resolve({ code: 1 }) }).drainOnce()
        expect(calls).toBe(0)
        expect(db.queue.countByStatus('pending')).toBe(1)
    })

    it('多条按 id 串行排空，断点取最大', async () => {
        enqueue(db, { externalId: 'a', msgTimestamp: 100 })
        enqueue(db, { externalId: 'b', msgTimestamp: 200 })
        await makeForwarder(db, () => Promise.resolve({ code: 1 })).drainOnce()
        expect(db.queue.countByStatus('done')).toBe(2)
        expect(db.channelState.get(WEFLOW_CHANNEL_ID)?.breakpointTimestamp).toBe(200)
    })

    it('熔断：连续下游不可用达阈值后打开、暂停取件并告警', async () => {
        for (let i = 0; i < 6; i++) enqueue(db, { externalId: `e${i}` })
        const alerts: string[] = []
        const fw = makeForwarder(db, () => Promise.resolve({ code: 1005 }), { send: (a: { type: string }) => { alerts.push(a.type) } })
        await fw.drainOnce()
        expect(alerts).toContain('downstream_circuit_open')
        expect(fw.circuitState()).toBe('open')
    })

    it('未配置下游 → 空转不报错', async () => {
        enqueue(db)
        const client: DownstreamClient = { syncGroups: () => Promise.resolve({ allowed: [] }), receiveMessage: () => Promise.reject(new Error('should not call')), ping: () => Promise.resolve({ ok: true }) }
        const fw = new Forwarder({ db, store: { getDownstream: () => undefined } as never, log: noopLog, alert: { send() {} }, createClient: () => client, now: () => 2000 })
        await fw.drainOnce()
        expect(db.queue.countByStatus('pending')).toBe(1)
    })

    it('内容错误(1002)不触发熔断', async () => {
        for (let i = 0; i < 6; i++) enqueue(db, { externalId: `e${i}` })
        const alerts: string[] = []
        const fw = makeForwarder(db, () => Promise.resolve({ code: 1002, retryable: false }), { send: (a: { type: string }) => { alerts.push(a.type) } })
        await fw.drainOnce()
        expect(db.queue.countByStatus('dead')).toBe(6) // 全部死信、但不熔断
        expect(alerts).not.toContain('downstream_circuit_open')
        expect(fw.circuitState()).toBe('closed')
    })

    it('死信触发 dlq_new 告警', async () => {
        enqueue(db)
        const alerts: string[] = []
        await makeForwarder(db, () => Promise.resolve({ code: 1002, retryable: false }), { send: (a: { type: string }) => { alerts.push(a.type) } }).drainOnce()
        expect(alerts).toContain('dlq_new')
    })

    it('毒消息(rawJson 不可解析) → 立即死信、不烧重试', async () => {
        enqueue(db, { rawJson: '{bad json' })
        let calls = 0
        await makeForwarder(db, () => { calls++; return Promise.resolve({ code: 1 }) }).drainOnce()
        expect(calls).toBe(0) // 没发下游
        expect(db.queue.countByStatus('dead')).toBe(1)
        expect(db.queue.getById(WEFLOW_CHANNEL_ID, 1)?.attempts).toBe(1) // 一次即死，未烧满重试
        expect(db.audit.stats(WEFLOW_CHANNEL_ID)).toEqual({ totalSuccess: 0, totalFail: 1 })
    })

    it('setEnabled(false) 后循环停止取件', async () => {
        enqueue(db, { externalId: 'a' }); enqueue(db, { externalId: 'b' })
        const fw = makeForwarder(db, () => Promise.resolve({ code: 1 }))
        fw.setEnabled(false)
        await fw.drainOnce()
        expect(db.queue.countByStatus('pending')).toBe(2) // enabled=false，循环首行 return，不取件
    })
})

describe('Forwarder.start', () => {
    it('start 时 resetStuck 把残留 sending 回 pending', async () => {
        const db = Db.openMemory()
        enqueue(db)
        db.queue.claimNext(WEFLOW_CHANNEL_ID, 2000) // 造 sending
        const fw = makeForwarder(db, () => Promise.resolve({ code: 1 }))
        fw.start()
        await fw.drainOnce()
        expect(db.queue.countByStatus('done')).toBe(1)
        fw.stop()
        db.close()
    })
})
