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
            json: () => Promise.resolve({ code: 1, msg: 'success', data: { allowed: ['g1@chatroom'] } }),
        })) as unknown as typeof fetch
        const res = await clientWith(fetchImpl).syncGroups({ agentId: 'weflow:default', platform: 'weflow', groups: [] })
        expect(res.allowed).toEqual(['g1@chatroom'])
    })

    it('code!==1 时抛错', async () => {
        const fetchImpl = (() => Promise.resolve({
            json: () => Promise.resolve({ code: 0, msg: '鉴权失败' }),
        })) as unknown as typeof fetch
        await expect(clientWith(fetchImpl).syncGroups({ agentId: 'a', platform: 'weflow', groups: [] }))
            .rejects.toThrow(/鉴权失败|code=0/)
    })

    it('请求 URL 带 task_white_token、body 为 JSON 信封', async () => {
        let captured: { url: string, body: string } | null = null
        const fetchImpl = ((url: string, init: { body: string }) => {
            captured = { url, body: init.body }
            return Promise.resolve({ json: () => Promise.resolve({ code: 1, data: { allowed: [] } }) })
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
