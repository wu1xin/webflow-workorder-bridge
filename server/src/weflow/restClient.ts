// WeFlow REST 客户端：拉会话列表与会话消息，供同步/补偿用（见 docs/http-api.md §3、§4）。
// 鉴权用 Authorization: Bearer（REST 推荐方式）；SSE 才用 query access_token。
import type { WeflowConfig } from '@wb/shared/types'
import type { Logger } from './logger.js'
import { baseUrl, redactToken } from './types.js'

/** REST 数据拉取超时（毫秒）：本机回环、单页有限，给足下载时间 */
const REST_TIMEOUT_MS = 60_000

/**
 * 媒体开关参数：不带这些上游不返回 mediaType/mediaFileName/mediaUrl（实测）。
 * 注意 media* 字段是 WeFlow 缓存就绪后才有的最终一致结果，「是不是媒体」仍以 localType 判定（见 mediaType.ts）。
 * 文件类导出参数未知（详见 docs/plans/2026-06-29-媒体判断口径修正-design.md 待验证项），暂不带。
 */
const MEDIA_PARAMS: Record<string, number> = { media: 1, image: 1, voice: 1, video: 1, emoji: 1 }

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
    private readonly log?: Logger

    constructor(cfg: WeflowConfig, log?: Logger) {
        this.cfg = cfg
        this.log = log
    }

    private authHeaders(): Record<string, string> {
        return { Authorization: `Bearer ${this.cfg.accessToken}` }
    }

    private async getJson(path: string, params: Record<string, string | number>): Promise<unknown> {
        const url = new URL(`${baseUrl(this.cfg)}${path}`)
        for (const [k, v] of Object.entries(params)) {
            url.searchParams.set(k, String(v))
        }
        this.log?.debug({ path, params, url: redactToken(url.toString()) }, '[weflow:rest] 请求上游')
        const res = await fetch(url, {
            method: 'GET',
            headers: this.authHeaders(),
            signal: AbortSignal.timeout(REST_TIMEOUT_MS),
        })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            const snippet = body.slice(0, 1_000)
            this.log?.error(
                { path, params, status: res.status, url: redactToken(url.toString()), body: snippet },
                `[weflow:rest] 上游返回 HTTP ${res.status}`,
            )
            throw new Error(`WeFlow ${path} 返回 HTTP ${res.status}${snippet ? `：${snippet}` : ''}`)
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
     * @param end    结束时间（秒级时间戳；省略=不限上界）。撤回对账文件探针用 start≈end 精确探一行。
     */
    async fetchMessagesPage(talker: string, start: number, offset: number, limit = 1_000, end?: number): Promise<MessagesPage> {
        const params: Record<string, string | number> = { talker, offset, limit, ...MEDIA_PARAMS }
        if (start > 0) params.start = start
        if (end !== undefined && end > 0) params.end = end
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
