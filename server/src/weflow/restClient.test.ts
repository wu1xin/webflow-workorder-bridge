import { describe, it, expect, vi, afterEach } from 'vitest'
import type { WeflowConfig } from '@wb/shared/types'
import { WeflowRestClient } from './restClient.js'

const CFG: WeflowConfig = {
    host: '127.0.0.1',
    port: 5031,
    accessToken: 'tok',
    connectTimeoutSec: 10,
    readTimeoutSec: 60,
    firstMessageTimeoutSec: 3,
    reconnectIntervalSec: 1,
    reconnectLogIntervalSec: 30,
}

/** 桩 fetch：记录请求 URL，恒返回空页 */
function stubFetch(): { urls: string[] } {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL) => {
        urls.push(String(url))
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ messages: [], hasMore: false }) } as Response)
    }))
    return { urls }
}

describe('WeflowRestClient.fetchMessagesPage — end 参数', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('传 end 时 URL 带 end（文件定向探针用 start≈end 精确探一行）', () => {
        const { urls } = stubFetch()
        return new WeflowRestClient(CFG).fetchMessagesPage('g@chatroom', 1782715200, 0, 50, 1782715260).then(() => {
            const u = new URL(urls[0])
            expect(u.searchParams.get('talker')).toBe('g@chatroom')
            expect(u.searchParams.get('start')).toBe('1782715200')
            expect(u.searchParams.get('end')).toBe('1782715260')
        })
    })

    it('不传 end 时 URL 不带 end', () => {
        const { urls } = stubFetch()
        return new WeflowRestClient(CFG).fetchMessagesPage('g@chatroom', 1782715200, 0).then(() => {
            const u = new URL(urls[0])
            expect(u.searchParams.has('end')).toBe(false)
        })
    })

    it('恒带 media 开关参数，否则上游不返回 media* 字段', () => {
        const { urls } = stubFetch()
        return new WeflowRestClient(CFG).fetchMessagesPage('g@chatroom', 0, 0).then(() => {
            const u = new URL(urls[0])
            expect(u.searchParams.get('media')).toBe('1')
            expect(u.searchParams.get('image')).toBe('1')
            expect(u.searchParams.get('voice')).toBe('1')
            expect(u.searchParams.get('video')).toBe('1')
            expect(u.searchParams.get('emoji')).toBe('1')
        })
    })
})

/** 桩 fetch：记录 URL、返回自定义 body */
function stubFetchBody(body: unknown): { urls: string[] } {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn((url: string | URL) => {
        urls.push(String(url))
        return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response)
    }))
    return { urls }
}

describe('WeflowRestClient.fetchMembers — chatlab members/meta', () => {
    afterEach(() => vi.unstubAllGlobals())

    const CHATLAB_BODY = {
        meta: { name: 'zhizhuIP服务对接群', groupId: 'g@chatroom', groupAvatar: 'https://av/group.png' },
        members: [
            { platformId: 'g@chatroom', accountName: 'g@chatroom', avatar: 'https://av/group.png' },
            { platformId: 'wxid_a', accountName: '无心', avatar: 'https://av/a.png' },
        ],
        messages: [{ sender: 'wxid_a', content: '精简的不用' }],
    }

    it('URL 带 chatlab=1 与 talker/start', () => {
        const { urls } = stubFetchBody(CHATLAB_BODY)
        return new WeflowRestClient(CFG).fetchMembers('g@chatroom', 1782715200, 0, 50).then(() => {
            const u = new URL(urls[0])
            expect(u.searchParams.get('chatlab')).toBe('1')
            expect(u.searchParams.get('talker')).toBe('g@chatroom')
            expect(u.searchParams.get('start')).toBe('1782715200')
        })
    })

    it('解析 members 成 wxid→{name,avatar} 映射 + meta 群名/群头像', () => {
        stubFetchBody(CHATLAB_BODY)
        return new WeflowRestClient(CFG).fetchMembers('g@chatroom', 0, 0).then((r) => {
            expect(r.groupName).toBe('zhizhuIP服务对接群')
            expect(r.groupAvatar).toBe('https://av/group.png')
            expect(r.members.get('wxid_a')).toEqual({ name: '无心', avatar: 'https://av/a.png' })
            expect(r.members.size).toBe(2)
        })
    })

    it('缺 meta/members 时降级为 null / 空映射', () => {
        stubFetchBody({})
        return new WeflowRestClient(CFG).fetchMembers('g@chatroom', 0, 0).then((r) => {
            expect(r.groupName).toBeNull()
            expect(r.groupAvatar).toBeNull()
            expect(r.members.size).toBe(0)
        })
    })
})
