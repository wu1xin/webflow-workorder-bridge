// 上游适配器抽象：把任意平台的原始消息翻成 bridge 的归一化信封（设计文档 §4）。
// 这是「未知结构」与「稳定 schema」之间的唯一翻译层。

/** 归一化媒体类型词汇表（跨平台稳定枚举；各平台适配器负责映射到此） */
export type MediaType = 'image' | 'voice' | 'video' | 'emoji' | 'file'

/** 归一化附件描述符（落 queue.media_json 的单个元素） */
export interface MediaDescriptor {
    /** 媒体幂等键，对应 media_cache 的 (channel_id, media_key) */
    mediaKey: string
    /** 归一化媒体类型（按上游语义判定，与文件是否已就绪无关） */
    mediaType: MediaType
    /** 原始文件名（可空：语音/贴纸等可能无名） */
    fileName: string | null
    /** MIME 类型 */
    mime: string | null
    /** 文件大小（字节） */
    size: number | null
    /** 从上游下载该附件所需的原始引用（平台特有，如 url/fileId/path） */
    sourceRef: string | null
}

/** 归一化消息信封 */
export interface NormalizedMessage {
    /** 本 channel 内唯一的幂等键（去重/媒体都靠它派生） */
    dedupKey: string
    /** 归一化事件类型，如 message.new */
    eventType: string
    /** 上游原生消息 ID（展示/排障，未必全局唯一） */
    externalId: string | null
    /** 会话/群/chat ID */
    conversationId: string | null
    /** 发送者标识 */
    senderId: string | null
    /** 消息秒级时间戳 */
    msgTimestamp: number | null
    /** 归一化附件列表（空数组表示无媒体） */
    media: MediaDescriptor[]
    /** 上游原始整包（通常 JSON.stringify(原始消息)） */
    rawJson: string
}

/** 上游适配器：每个平台实现一个 */
export interface UpstreamAdapter<TRaw = unknown> {
    readonly platform: string
    normalize(raw: TRaw): NormalizedMessage
}
