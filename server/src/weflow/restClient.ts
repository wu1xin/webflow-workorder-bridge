// WeFlow REST 客户端：拉会话列表与会话消息，供同步/补偿用（见 docs/http-api.md §3、§4）。
// 鉴权用 Authorization: Bearer（REST 推荐方式）；SSE 才用 query access_token。
import type { WeflowConfig } from '@wb/shared/types'
import { baseUrl } from './types.js'

/** REST 数据拉取超时（毫秒）：本机回环、单页有限，给足下载时间 */
const REST_TIMEOUT_MS = 60_000

/** 会话（/api/v1/sessions 单项，宽松取用） */
export interface WeflowSession {
    username: string
    displayName?: string
    type?: number
    lastTimestamp?: number
    unreadCount?: number
}

/** 消息（/api/v1/messages 单项，宽松取用，仅列同步需要的字段） */
export interface WeflowMessage {
    localId?: number
    serverId?: string
    localType?: number
    createTime?: number
    isSend?: number
    senderUsername?: string
    content?: string
    rawContent?: string
    parsedContent?: string
    mediaType?: string
    mediaFileName?: string
    mediaUrl?: string
    mediaLocalPath?: string
}

/** 一页消息结果 */
export interface MessagesPage {
    messages: WeflowMessage[]
    hasMore: boolean
}

export class WeflowRestClient {
    private readonly cfg: WeflowConfig

    constructor(cfg: WeflowConfig) {
        this.cfg = cfg
    }

    private authHeaders(): Record<string, string> {
        return { Authorization: `Bearer ${this.cfg.accessToken}` }
    }

    private async getJson(path: string, params: Record<string, string | number>): Promise<unknown> {
        const url = new URL(`${baseUrl(this.cfg)}${path}`)
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, String(v))
        }
        const res = await fetch(url, {
            method: 'GET',
            headers: this.authHeaders(),
            signal: AbortSignal.timeout(REST_TIMEOUT_MS),
        })
        if (!res.ok) {
            await res.text().catch(() => '')
            throw new Error(`WeFlow ${path} 返回 HTTP ${res.status}`)
        }
        return res.json()
    }

    /**
     * 列出会话。WeFlow /sessions 无 offset 分页，用大 limit 一次取全。
     */
    async listSessions(limit = 10_000): Promise<WeflowSession[]> {
        const data = await this.getJson('/api/v1/sessions', { limit }) as { sessions?: WeflowSession[] }
        return Array.isArray(data.sessions) ? data.sessions : []
    }

    /**
     * 拉取某会话一页消息。
     * @param talker 会话 ID
     * @param start  开始时间（秒级时间戳；0 表示不限，从最早）
     * @param offset 分页偏移
     * @param limit  每页条数
     */
    async fetchMessagesPage(talker: string, start: number, offset: number, limit = 1_000): Promise<MessagesPage> {
        const params: Record<string, string | number> = { talker, offset, limit }
        if (start > 0) params.start = start
        const data = await this.getJson('/api/v1/messages', params) as {
            messages?: WeflowMessage[]
            hasMore?: boolean
        }
        return {
            messages: Array.isArray(data.messages) ? data.messages : [],
            hasMore: Boolean(data.hasMore),
        }
    }
}
