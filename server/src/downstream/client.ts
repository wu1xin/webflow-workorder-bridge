// 下游 work-order-system 出站客户端（首个）。鉴权复用 task_white_token（AES-128-ECB/PKCS7/base64）。
// 成功判定按对接规格 §2.4：HTTP 200 且 body.code === 1。详见 docs/weflow-对接接口规格说明书（work-order-system侧）.md。
import { createCipheriv } from 'node:crypto'
import type { DownstreamConfig } from '@wb/shared/types'
import type { Logger } from '../weflow/logger.js'

/** 出站请求超时（毫秒） */
const TIMEOUT_MS = 30_000

/** syncGroups 端点路径（不含 query；错误信息只带它，避免泄露含 task_white_token 的完整 URL） */
const SYNC_GROUPS_PATH = '/extra_server/weflow/syncGroups'

/** receiveMessage 端点路径（同样只用于错误信息，避免泄露含 token 的完整 URL） */
const RECEIVE_MESSAGE_PATH = '/extra_server/weflow/receiveMessage'

/** ping 端点路径 */
const PING_PATH = '/extra_server/weflow/ping'

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

/** receiveMessage 信封（一期不带 file；file 下期媒体链路补） */
export interface ReceiveEnvelope {
    event: string
    /** 消息所属会话/群 ID（xxx@chatroom）；下游据此把消息归到对应群。data 仍为 WeFlow 原文，不含群标识 */
    sessionId: string
    /** 发送人身份（信封层补充元数据，非 data 内字段）；name/avatar 未解析到时为 null */
    sender?: { username: string | null, name: string | null, avatar: string | null }
    data: unknown
}

/** receiveMessage 解析后的 ACK（code!=1 不抛错，交 forwarder 决策） */
export interface ReceiveAck {
    code: number
    msg?: string
    retryable?: boolean
    messageId?: number | string
    duplicate?: boolean
    receivedAt?: number
}

/** ping 结果 */
export interface PingResult {
    ok: boolean
    serverTime?: number
    version?: string
    message?: string
}

/** 下游客户端抽象（便于注桩测试） */
export interface DownstreamClient {
    syncGroups(req: SyncGroupsRequest): Promise<{ allowed: string[] }>
    receiveMessage(env: ReceiveEnvelope): Promise<ReceiveAck>
    ping(): Promise<PingResult>
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
        // 请求发出前先记一条：便于排查挂起/超时时确认请求确实发出（不打 url，避免泄露 token）
        this.log?.debug(
            { path: SYNC_GROUPS_PATH, agentId: req.agentId, platform: req.platform, groups: req.groups.length },
            '[downstream] syncGroups 发起',
        )
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
            this.log?.error(
                { path: SYNC_GROUPS_PATH, code: body.code ?? null, msg: body.msg ?? '' },
                `[downstream] syncGroups 业务失败：code=${body.code ?? 'none'}`,
            )
            throw new Error(`下游 syncGroups 失败：code=${body.code ?? 'none'} msg=${body.msg ?? ''}`)
        }
        const allowed = Array.isArray(body.data?.allowed) ? body.data.allowed : []
        this.log?.debug({ sent: req.groups.length, allowed: allowed.length }, '[downstream] syncGroups 完成')
        return { allowed }
    }

    // 与 syncGroups 不同：仅传输层失败（非 2xx / 网络错 / JSON 解析失败）抛错，
    // 业务 code!=1 不抛，原样返回 ACK 交由 forwarder 决策重试/入死信。fetch→json 顺序依赖，用 async/await。
    async receiveMessage(env: ReceiveEnvelope): Promise<ReceiveAck> {
        const token = buildTaskWhiteToken(this.cfg.siteKey, this.cfg.aesKey, this.now())
        const url = `${this.cfg.baseUrl}${RECEIVE_MESSAGE_PATH}?task_white_token=${encodeURIComponent(token)}`
        // 请求发出前先记一条：便于排查挂起/超时时确认请求确实发出（不打 url，避免泄露 token）
        this.log?.debug(
            { path: RECEIVE_MESSAGE_PATH, event: env.event, sessionId: env.sessionId },
            '[downstream] receiveMessage 发起',
        )
        const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(env),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const snippet = text.slice(0, 500)
            this.log?.error(
                { path: RECEIVE_MESSAGE_PATH, status: res.status, body: snippet },
                `[downstream] receiveMessage 返回 HTTP ${res.status}`,
            )
            throw new Error(`下游 ${RECEIVE_MESSAGE_PATH} 返回 HTTP ${res.status}${snippet ? `：${snippet}` : ''}`)
        }
        const body = await res.json() as {
            code?: number
            msg?: string
            data?: { retryable?: boolean, message_id?: number | string, duplicate?: boolean, received_at?: number }
        }
        const ack: ReceiveAck = {
            code: body.code ?? 0,
            msg: body.msg,
            retryable: body.data?.retryable,
            messageId: body.data?.message_id,
            duplicate: body.data?.duplicate,
            receivedAt: body.data?.received_at,
        }
        // code!=1 不抛错（交 forwarder 决策），但仍是需关注信号，故 warn；正常完成打 debug
        const meta = {
            path: RECEIVE_MESSAGE_PATH,
            code: ack.code,
            duplicate: ack.duplicate ?? false,
            retryable: ack.retryable ?? false,
            messageId: ack.messageId ?? null,
        }
        if (ack.code === 1) {
            this.log?.debug(meta, '[downstream] receiveMessage 完成')
        } else {
            this.log?.warn(
                { ...meta, msg: ack.msg ?? '' },
                `[downstream] receiveMessage 业务未成功：code=${ack.code}`,
            )
        }
        return ack
    }

    // 连通性探针：任何传输层异常（网络错/超时/JSON 解析失败）都收敛为 { ok:false, message }，
    // 绝不抛出 —— 否则测连按钮会拿到无意义的 500 而非「主机不可达」诊断。fetch→json 顺序依赖，用 async/await。
    async ping(): Promise<PingResult> {
        const token = buildTaskWhiteToken(this.cfg.siteKey, this.cfg.aesKey, this.now())
        const url = `${this.cfg.baseUrl}${PING_PATH}?task_white_token=${encodeURIComponent(token)}`
        try {
            const res = await this.fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) })
            if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
            const body = await res.json() as { code?: number, msg?: string, data?: { server_time?: number, version?: string } }
            return { ok: body.code === 1, serverTime: body.data?.server_time, version: body.data?.version, message: body.msg }
        } catch (e) {
            return { ok: false, message: e instanceof Error ? e.message : String(e) }
        }
    }
}
