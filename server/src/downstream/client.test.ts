import { describe, it, expect } from 'vitest'
import { createDecipheriv } from 'node:crypto'
import { buildTaskWhiteToken, HttpDownstreamClient } from './client.js'

const CFG = { baseUrl: 'https://dn.example.com', siteKey: 'site-key-abc', aesKey: 'sixteen-byte-key' }

describe('buildTaskWhiteToken', () => {
    it('AES-128-ECB/PKCS7/base64 可解回原文（前16字节密钥）', () => {
        const token = buildTaskWhiteToken(CFG.siteKey, CFG.aesKey, 1750000000)
        const key = Buffer.from(CFG.aesKey, 'ascii').subarray(0, 16)
        const d = createDecipheriv('aes-128-ecb', key, null)
        const plain = Buffer.concat([d.update(Buffer.from(token, 'base64')), d.final()]).toString('utf8')
        expect(plain).toBe('{"key":"site-key-abc","time":1750000000}')
    })
})

describe('HttpDownstreamClient.syncGroups', () => {
    function clientWith(fetchImpl: typeof fetch) {
        return new HttpDownstreamClient(CFG, undefined, { fetchImpl, now: () => 1750000000 })
    }

    it('code===1 时解析 data.allowed', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ code: 1, msg: 'success', data: { allowed: ['g1@chatroom'] } }),
        })) as unknown as typeof fetch
        const res = await clientWith(fetchImpl).syncGroups({ agentId: 'weflow:default', platform: 'weflow', groups: [] })
        expect(res.allowed).toEqual(['g1@chatroom'])
    })

    it('code!==1 时抛错', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ code: 0, msg: '鉴权失败' }),
        })) as unknown as typeof fetch
        await expect(clientWith(fetchImpl).syncGroups({ agentId: 'a', platform: 'weflow', groups: [] }))
            .rejects.toThrow(/鉴权失败|code=0/)
    })

    it('res.ok===false 时抛错，含状态码、不含 task_white_token', async () => {
        expect.assertions(2)
        const fetchImpl = (() => Promise.resolve({
            ok: false,
            status: 502,
            text: () => Promise.resolve('<html>bad gateway</html>'),
        })) as unknown as typeof fetch
        try {
            await clientWith(fetchImpl).syncGroups({ agentId: 'a', platform: 'weflow', groups: [] })
        }
        catch (e) {
            expect((e as Error).message).toMatch(/502/)
            expect((e as Error).message).not.toContain('task_white_token')
        }
    })

    it('请求 URL 带 task_white_token、body 为 JSON 信封', async () => {
        let captured: { url: string, body: string } | null = null
        const fetchImpl = ((url: string, init: { body: string }) => {
            captured = { url, body: init.body }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 1, data: { allowed: [] } }) })
        }) as unknown as typeof fetch
        await clientWith(fetchImpl).syncGroups({
            agentId: 'weflow:default', platform: 'weflow',
            groups: [{ sessionId: 'g1@chatroom', groupName: '群一', lastMessageAt: 123 }],
        })
        expect(captured!.url).toContain('/extra_server/weflow/syncGroups?task_white_token=')
        const body = JSON.parse(captured!.body)
        expect(body.agentId).toBe('weflow:default')
        expect(body.groups[0].sessionId).toBe('g1@chatroom')
    })
})

describe('HttpDownstreamClient.receiveMessage', () => {
    function clientWith(fetchImpl: typeof fetch) {
        return new HttpDownstreamClient(CFG, undefined, { fetchImpl, now: () => 1750000000 })
    }

    it('code!==1 不抛错，原样返回 code/retryable 供 forwarder 决策', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ code: 1002, msg: '缺参', data: { retryable: false } }),
        })) as unknown as typeof fetch
        const ack = await clientWith(fetchImpl).receiveMessage({ event: 'message.new', data: { rawid: '1' } })
        expect(ack.code).toBe(1002)
        expect(ack.retryable).toBe(false)
    })

    it('code===1 解析 duplicate/message_id/received_at', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ code: 1, data: { message_id: 9, duplicate: true, received_at: 1750000001 } }),
        })) as unknown as typeof fetch
        const ack = await clientWith(fetchImpl).receiveMessage({ event: 'message.new', data: {} })
        expect(ack).toMatchObject({ code: 1, duplicate: true, messageId: 9, receivedAt: 1750000001 })
    })

    it('传输层错误（非200）抛异常，错误信息不含 token', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: false, status: 502, text: () => Promise.resolve('bad gateway'),
        })) as unknown as typeof fetch
        await expect(clientWith(fetchImpl).receiveMessage({ event: 'message.new', data: {} }))
            .rejects.toThrow(/502/)
    })

    it('URL 带 receiveMessage 端点与 task_white_token，body 为 {event,data} 信封', async () => {
        let captured: { url: string, body: string } | null = null
        const fetchImpl = ((url: string, init: { body: string }) => {
            captured = { url, body: init.body }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 1, data: {} }) })
        }) as unknown as typeof fetch
        await clientWith(fetchImpl).receiveMessage({ event: 'message.new', data: { rawid: '1' } })
        expect(captured!.url).toContain('/extra_server/weflow/receiveMessage?task_white_token=')
        const body = JSON.parse(captured!.body)
        expect(body.event).toBe('message.new')
        expect(body.data.rawid).toBe('1')
        expect(body.file).toBeUndefined()
    })
})

describe('HttpDownstreamClient.ping', () => {
    it('code===1 → ok=true 且带 server_time/version', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: true, json: () => Promise.resolve({ code: 1, data: { server_time: 1750000000, version: '1.0.0' } }),
        })) as unknown as typeof fetch
        const res = await new HttpDownstreamClient(CFG, undefined, { fetchImpl, now: () => 1750000000 }).ping()
        expect(res).toMatchObject({ ok: true, serverTime: 1750000000, version: '1.0.0' })
    })
})
