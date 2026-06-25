// 下游 work-order-system 出站客户端（首个）。鉴权复用 task_white_token（AES-128-ECB/PKCS7/base64）。
// 成功判定按对接规格 §2.4：HTTP 200 且 body.code === 1。详见 docs/weflow-对接接口规格说明书（work-order-system侧）.md。
import { createCipheriv } from 'node:crypto'
import type { DownstreamConfig } from '@wb/shared/types'
import type { Logger } from '../weflow/logger.js'

/** 出站请求超时（毫秒） */
const TIMEOUT_MS = 30_000

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
        const url = `${this.cfg.baseUrl}/extra_server/weflow/syncGroups?task_white_token=${encodeURIComponent(token)}`
        const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(req),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        const body = await res.json() as AckBody
        if (body.code !== 1) {
            throw new Error(`下游 syncGroups 失败：code=${body.code ?? 'none'} msg=${body.msg ?? ''}`)
        }
        const allowed = Array.isArray(body.data?.allowed) ? body.data.allowed : []
        this.log?.debug({ sent: req.groups.length, allowed: allowed.length }, '[downstream] syncGroups 完成')
        return { allowed }
    }
}
