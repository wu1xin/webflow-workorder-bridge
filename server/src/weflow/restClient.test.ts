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
