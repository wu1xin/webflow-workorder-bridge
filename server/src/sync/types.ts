// 同步进度类型，供 GET /api/sync/status 返回与前端展示。
export type SyncMode = 'idle' | 'full' | 'compensation'

export interface SyncProgress {
    /** 是否正在同步（防并发置忙） */
    running: boolean
    /** 本次/最近一次同步模式 */
    mode: SyncMode
    /** 开始时刻（秒级 Unix 时间戳） */
    startedAt: number | null
    /** 结束时刻（秒级 Unix 时间戳；运行中为 null） */
    finishedAt: number | null
    /** 会话总数 / 已处理数（全量时有意义） */
    sessionsTotal: number
    sessionsDone: number
    /** 已拉取消息数 */
    messagesPulled: number
    /** 去重后实际入队数 */
    enqueued: number
    /** 重复跳过数 */
    duplicates: number
    /** 补偿起点（秒级时间戳；全量为 null） */
    since: number | null
    /** 最近一次错误信息（成功为 null） */
    lastError: string | null
}

/** 初始空闲进度 */
export function idleProgress(): SyncProgress {
    return {
        running: false,
        mode: 'idle',
        startedAt: null,
        finishedAt: null,
        sessionsTotal: 0,
        sessionsDone: 0,
        messagesPulled: 0,
        enqueued: 0,
        duplicates: 0,
        since: null,
        lastError: null,
    }
}
