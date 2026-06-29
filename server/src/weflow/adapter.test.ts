import { describe, it, expect } from 'vitest'
import { WeflowAdapter, WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from './adapter.js'
import type { WeflowMessage } from './restClient.js'

const adapter = new WeflowAdapter()

function msg(over: Partial<WeflowMessage> = {}): WeflowMessage {
    return { serverId: 'srv-1', createTime: 1700000000, senderUsername: 'bob', content: 'hi', ...over }
}

describe('WeflowAdapter', () => {
    it('常量符合预期', () => {
        expect(WEFLOW_PLATFORM).toBe('weflow')
        expect(WEFLOW_CHANNEL_ID).toBe('weflow:default')
        expect(adapter.platform).toBe('weflow')
    })

    it('归一化基本字段', () => {
        const n = adapter.normalize({ talker: 'alice', message: msg() })
        expect(n.dedupKey).toBe('srv-1')
        expect(n.externalId).toBe('srv-1')
        expect(n.conversationId).toBe('alice')
        expect(n.senderId).toBe('bob')
        expect(n.msgTimestamp).toBe(1700000000)
        expect(n.media).toEqual([])
        expect(JSON.parse(n.rawJson).serverId).toBe('srv-1')
    })

    it('serverId 缺失时回退 localId 作为 dedupKey', () => {
        const n = adapter.normalize({ talker: 'alice', message: msg({ serverId: undefined, localId: 42 }) })
        expect(n.dedupKey).toBe('42')
        expect(n.externalId).toBe('42')
    })

    it('含媒体时产出 media 描述符（按 localType 判定，mediaKey 取 serverId）', () => {
        const n = adapter.normalize({ talker: 'alice', message: msg({ localType: 3, mediaFileName: 'a.png', mediaUrl: 'http://x/a.png' }) })
        expect(n.media).toHaveLength(1)
        expect(n.media[0].mediaKey).toBe('srv-1')
        expect(n.media[0].mediaType).toBe('image')
        expect(n.media[0].fileName).toBe('a.png')
        expect(n.media[0].sourceRef).toBe('http://x/a.png')
    })

    it('媒体未就绪（media* 字段缺失）仍按 localType 判为媒体，sourceRef 为 null', () => {
        const n = adapter.normalize({ talker: 'alice', message: msg({ localType: 43 }) })
        expect(n.media).toHaveLength(1)
        expect(n.media[0].mediaType).toBe('video')
        expect(n.media[0].fileName).toBeNull()
        expect(n.media[0].sourceRef).toBeNull()
    })
})
