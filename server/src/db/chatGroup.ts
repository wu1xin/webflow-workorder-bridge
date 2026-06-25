// chat_group 表访问：群聊登记 + 下游推送裁决（仅群聊转发的闸门数据源）。
// push_allowed 由下游裁定，本地默认 0；发现/见到群只更名称与 last_seen，不动裁决。
import type BetterSqlite3 from 'better-sqlite3'

export interface ChatGroup {
    channelId: string
    platform: string
    conversationId: string
    groupName: string | null
    avatarUrl: string | null
    pushAllowed: boolean
    syncStatus: 'pending' | 'synced' | 'failed'
    syncedAt: number | null
    lastError: string | null
    firstSeenAt: number
    lastSeenAt: number
}

/** upsertSeen 的可选元数据（缺省不覆盖既有值） */
export interface GroupSeen {
    groupName?: string | null
    avatarUrl?: string | null
}

interface Row {
    channel_id: string
    platform: string
    conversation_id: string
    group_name: string | null
    avatar_url: string | null
    push_allowed: number
    sync_status: 'pending' | 'synced' | 'failed'
    synced_at: number | null
    last_error: string | null
    first_seen_at: number
    last_seen_at: number
}

export class ChatGroupStore {
    private readonly db: BetterSqlite3.Database
    private readonly upsertStmt: BetterSqlite3.Statement
    private readonly isAllowedStmt: BetterSqlite3.Statement
    private readonly setAllowStmt: BetterSqlite3.Statement
    private readonly setFailedStmt: BetterSqlite3.Statement
    private readonly listStmt: BetterSqlite3.Statement
    private readonly listAllowedStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.db = db
        // 发现/见到：新行 push_allowed=0/sync_status=pending；冲突只更名称/头像/last_seen，保留裁决
        this.upsertStmt = db.prepare(`
            INSERT INTO chat_group(channel_id, platform, conversation_id, group_name, avatar_url,
              push_allowed, sync_status, first_seen_at, last_seen_at, updated_at)
            VALUES (@channelId, @platform, @conversationId, @groupName, @avatarUrl,
              0, 'pending', @now, @now, @now)
            ON CONFLICT(channel_id, conversation_id) DO UPDATE SET
              group_name   = COALESCE(@groupName, group_name),
              avatar_url   = COALESCE(@avatarUrl, avatar_url),
              last_seen_at = @now,
              updated_at   = @now
        `)
        this.isAllowedStmt = db.prepare(
            'SELECT push_allowed FROM chat_group WHERE channel_id = ? AND conversation_id = ?',
        )
        this.setAllowStmt = db.prepare(`
            UPDATE chat_group SET push_allowed = @allowed, sync_status = 'synced',
              synced_at = @now, last_error = NULL, updated_at = @now
            WHERE channel_id = @channelId AND conversation_id = @conversationId
        `)
        this.setFailedStmt = db.prepare(`
            UPDATE chat_group SET sync_status = 'failed', last_error = @error, updated_at = @now
            WHERE channel_id = @channelId AND conversation_id = @conversationId
        `)
        this.listStmt = db.prepare('SELECT * FROM chat_group WHERE channel_id = ? ORDER BY last_seen_at DESC')
        this.listAllowedStmt = db.prepare(
            'SELECT conversation_id FROM chat_group WHERE channel_id = ? AND push_allowed = 1 ORDER BY conversation_id',
        )
    }

    /** 发现/见到一个群：新建或刷新名称与 last_seen，保留下游裁决 */
    upsertSeen(channelId: string, platform: string, conversationId: string, seen: GroupSeen, now: number): void {
        this.upsertStmt.run({
            channelId, platform, conversationId,
            groupName: seen.groupName ?? null,
            avatarUrl: seen.avatarUrl ?? null,
            now,
        })
    }

    /** 闸门快查：该群是否被下游放行 */
    isPushAllowed(channelId: string, conversationId: string): boolean {
        const row = this.isAllowedStmt.get(channelId, conversationId) as { push_allowed: number } | undefined
        return row?.push_allowed === 1
    }

    /** 白名单回写：sentIds 中命中 allowedIds 置 1、其余置 0，均标记 synced（单事务） */
    markSynced(channelId: string, sentIds: string[], allowedIds: string[], now: number): void {
        const allow = new Set(allowedIds)
        this.db.transaction((ids: string[]) => {
            for (const id of ids) {
                this.setAllowStmt.run({ channelId, conversationId: id, allowed: allow.has(id) ? 1 : 0, now })
            }
        })(sentIds)
    }

    /** 同步失败：记 sync_status=failed/last_error，push_allowed 保持原值（保守不误开/误关） */
    markSyncFailed(channelId: string, sentIds: string[], error: string, now: number): void {
        this.db.transaction((ids: string[]) => {
            for (const id of ids) this.setFailedStmt.run({ channelId, conversationId: id, error, now })
        })(sentIds)
    }

    /** 被放行的群 conversation_id 列表（同步消息时的会话过滤源） */
    listAllowed(channelId: string): string[] {
        return (this.listAllowedStmt.all(channelId) as Array<{ conversation_id: string }>).map(r => r.conversation_id)
    }

    /** 全部群（前端展示/排障） */
    listAll(channelId: string): ChatGroup[] {
        return (this.listStmt.all(channelId) as Row[]).map(r => ({
            channelId: r.channel_id,
            platform: r.platform,
            conversationId: r.conversation_id,
            groupName: r.group_name,
            avatarUrl: r.avatar_url,
            pushAllowed: r.push_allowed === 1,
            syncStatus: r.sync_status,
            syncedAt: r.synced_at,
            lastError: r.last_error,
            firstSeenAt: r.first_seen_at,
            lastSeenAt: r.last_seen_at,
        }))
    }
}
