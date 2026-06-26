// WeFlow 群组列表只读 DTO（前后端共用）。
// 对应 GET /api/weflow/groups 响应元素，与服务端 ChatGroup 结构兼容（列表用不到 channelId/platform，故省略）。

/** 群与下游推送裁决的展示快照 */
export interface WeflowGroup {
    /** 群 ID（xxx@chatroom）= 会话 username */
    conversationId: string
    /** 群名（可空） */
    groupName: string | null
    /** 群头像（前端展示，当前多为空，留位） */
    avatarUrl: string | null
    /** 下游裁决：是否可推送 */
    pushAllowed: boolean
    /** 同步下游状态 */
    syncStatus: 'pending' | 'synced' | 'failed'
    /** 最近一次成功同步下游的时刻（秒级 Unix 时间戳） */
    syncedAt: number | null
    /** 最近一次同步失败原因 */
    lastError: string | null
    /** 首次发现该群的时刻（秒级 Unix 时间戳） */
    firstSeenAt: number
    /** 最近一次见到该群的时刻（秒级 Unix 时间戳） */
    lastSeenAt: number
}

/** POST /api/weflow/groups/sync 手动「立即同步群」结果 */
export type SyncGroupsResult =
    | { ok: true, total: number, allowed: number }
    | { ok: false, error: string }
