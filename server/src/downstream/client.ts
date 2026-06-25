// 下游 work-order-system 出站客户端（首个）。鉴权复用 task_white_token（AES-128-ECB/PKCS7/base64）。
// 成功判定按对接规格 §2.4：HTTP 200 且 body.code === 1。详见 docs/weflow-对接接口规格说明书（work-order-system侧）.md。
import { createCipheriv } from 'node:crypto'
import type { DownstreamConfig } from '@wb/shared/types'
import type { Logger } from '../weflow/logger.js'

/** 出站请求超时（毫秒） */
const TIMEOUT_MS = 30_000

/** syncGroups 端点路径（不含 query；错误信息只带它，避免泄露含 task_white_token 的完整 URL） */
const SYNC_GROUPS_PATH = '/extra_server/weflow/syncGroups'

/** syncGroups 请求体（群快照，全量或单群增量同结构） */
export interface SyncGroupsRequest {
    agentId: string
    platform: string
    groups: Array<{
        sessionId: string
        groupName?: string | null
        avatarUrl?: string | null
        lastMessageAt?: number | null
    }>
}

/** 下游客户端抽象（便于注桩测试） */
export interface DownstreamClient {
    syncGroups(req: SyncGroupsRequest): Promise<{ allowed: string[] }>
}

/**
 * 构造 task_white_token：base64( AES-128-ECB-PKCS7( utf8('{"key":..,"time":..}') ) )。
 * 字段顺序固定 key 在前、time 在后、无多余空格（规格 §7.2）。密钥取约定串前 16 字节。
 */
export function buildTaskWhiteToken(siteKey: string, aesKey: string, nowSec: number): string {
    const payload = `{"key":"${siteKey}","time":${nowSec}}`
    const key = Buffer.from(aesKey, 'ascii').subarray(0, 16)
    if (key.length < 16) {
        throw new Error('下游 aesKey 长度不足 16 字节，无法生成 task_white_token')
    }
    const cipher = createCipheriv('aes-128-ecb', key, null) // setAutoPadding 默认 true = PKCS7
    return Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]).toString('base64')
}

interface DownstreamDeps {
    fetchImpl?: typeof fetch
    now?: () => number
}

interface AckBody {
    code?: number
    msg?: string
    data?: { allowed?: string[] }
}

export class HttpDownstreamClient implements DownstreamClient {
    private readonly cfg: DownstreamConfig
    private readonly log?: Logger
    private readonly fetchImpl: typeof fetch
    private readonly now: () => number

    constructor(cfg: DownstreamConfig, log?: Logger, deps: DownstreamDeps = {}) {
        this.cfg = cfg
        this.log = log
        this.fetchImpl = deps.fetchImpl ?? fetch
        this.now = deps.now ?? (() => Math.floor(Date.now() / 1000))
    }

    // fetch→json 属顺序依赖，按 CLAUDE.md 可用 async/await（与 restClient.getJson 一致）
    async syncGroups(req: SyncGroupsRequest): Promise<{ allowed: string[] }> {
        const token = buildTaskWhiteToken(this.cfg.siteKey, this.cfg.aesKey, this.now())
        const url = `${this.cfg.baseUrl}${SYNC_GROUPS_PATH}?task_white_token=${encodeURIComponent(token)}`
        const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(req),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        // 先判传输层：中间链路可能返回 502/404/HTML，res.json() 会抛无意义 SyntaxError。
        // 错误信息只带端点路径（不含 query）+ 状态码 + body 片段，绝不暴露含 task_white_token 的完整 URL。
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const snippet = text.slice(0, 500)
            this.log?.error(
                { path: SYNC_GROUPS_PATH, status: res.status, body: snippet },
                `[downstream] syncGroups 返回 HTTP ${res.status}`,
            )
            throw new Error(`下游 ${SYNC_GROUPS_PATH} 返回 HTTP ${res.status}${snippet ? `：${snippet}` : ''}`)
        }
        const body = await res.json() as AckBody
        if (body.code !== 1) {
            throw new Error(`下游 syncGroups 失败：code=${body.code ?? 'none'} msg=${body.msg ?? ''}`)
        }
        const allowed = Array.isArray(body.data?.allowed) ? body.data.allowed : []
        this.log?.debug({ sent: req.groups.length, allowed: allowed.length }, '[downstream] syncGroups 完成')
        return { allowed }
    }
}
