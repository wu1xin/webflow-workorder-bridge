// WeFlow 消息列表 DTO（前后端共用）。
// 数据源 queue 表（归一化入队的转发消息）；列表行不含 rawJson（大 blob 不批量下发），详情才返回。

/** 转发队列状态机 */
export type WeflowMessageStatus = 'pending' | 'sending' | 'done' | 'dead'
/** 采集路径：sse 实时 | catchup 补偿 */
export type WeflowIngestPath = 'sse' | 'catchup'

/** 列表行（不含 rawJson） */
export interface WeflowMessageSummary {
    id: number
    /** 会话/群 ID */
    conversationId: string | null
    /** 发送者标识 */
    senderId: string | null
    /** 归一化事件类型 */
    eventType: string
    /** 消息秒级时间戳 */
    msgTimestamp: number | null
    /** 是否含媒体 */
    hasMedia: boolean
    status: WeflowMessageStatus
    ingestPath: WeflowIngestPath
    /** 已重试次数 */
    attempts: number
    /** 最近一次错误信息 */
    lastError: string | null
    /** 入队时间（秒级 Unix 时间戳） */
    createdAt: number
}

/** 详情（含原始包，供弹窗排障） */
export interface WeflowMessageDetail extends WeflowMessageSummary {
    /** 上游原始整包 JSON */
    rawJson: string
    /** 归一化附件列表 JSON 数组；无附件为 null */
    mediaJson: string | null
}

/** 分页响应 */
export interface WeflowMessagePage {
    items: WeflowMessageSummary[]
    total: number
    page: number
    pageSize: number
}
