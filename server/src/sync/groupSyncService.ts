// 群同步服务：过滤群聊会话 → upsert chat_group → 发下游 syncGroups → 按白名单回写 push_allowed。
// 连接成功时全量同步；SSE 入队通道接入后，遇未知群可用单元素数组调 syncAll 增量同步（design §7）。
import type { Db } from '../db/database.js'
import type { WeflowSession } from '../weflow/restClient.js'
import type { DownstreamClient, SyncGroupsRequest } from '../downstream/client.js'
import type { Logger } from '../weflow/logger.js'
import type { AlertChannel } from '../weflow/hooks.js'

/** 群判定：/sessions 的 type===2，或 username 以 @chatroom 结尾（http-api.md §4） */
export function isWeflowGroup(s: WeflowSession): boolean {
    return s.type === 2 || s.username.endsWith('@chatroom')
}

export interface GroupSyncDeps {
    db: Db
    downstream: DownstreamClient
    log: Logger
    alert: AlertChannel
    /** 注入时钟，便于测试 */
    now?: () => number
}

export class GroupSyncService {
    private readonly db: Db
    private readonly downstream: DownstreamClient
    private readonly log: Logger
    private readonly alert: AlertChannel
    private readonly clock: () => number

    constructor(deps: GroupSyncDeps) {
        this.db = deps.db
        this.downstream = deps.downstream
        this.log = deps.log
        this.alert = deps.alert
        this.clock = deps.now ?? (() => Math.floor(Date.now() / 1000))
    }

    /** 全量：过滤群 → upsert → 发下游 → 回写裁决（无群则不调用下游） */
    syncAll(channelId: string, platform: string, sessions: WeflowSession[]): Promise<void> {
        const groups = sessions.filter(isWeflowGroup)
        const now = this.clock()
        for (const g of groups) {
            this.db.chatGroup.upsertSeen(channelId, platform, g.username, { groupName: g.displayName ?? null }, now)
        }
        if (groups.length === 0) return Promise.resolve()

        const sentIds = groups.map(g => g.username)
        const req: SyncGroupsRequest = {
            agentId: channelId,
            platform,
            groups: groups.map(g => ({
                sessionId: g.username,
                groupName: g.displayName ?? null,
                lastMessageAt: g.lastTimestamp ?? null,
            })),
        }
        return this.downstream.syncGroups(req)
            .then(({ allowed }) => {
                this.db.chatGroup.markSynced(channelId, sentIds, allowed, this.clock())
                this.log.info({ sent: sentIds.length, allowed: allowed.length }, '[group-sync] 群同步完成')
            })
            .catch((e: unknown) => {
                const message = e instanceof Error ? e.message : String(e)
                this.db.chatGroup.markSyncFailed(channelId, sentIds, message, this.clock())
                this.log.error({ err: message }, '[group-sync] 群同步失败，本轮裁决保持原值')
                this.alert.send({ level: 'warn', type: 'group_sync_failed', title: '群同步下游失败', message })
            })
    }
}
