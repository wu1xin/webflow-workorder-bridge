// WeFlow 上游适配器：把 WeflowMessage 归一化成 bridge 信封（设计文档 §4）。
import type { WeflowMessage } from './restClient.js'
import type { MediaDescriptor, NormalizedMessage, UpstreamAdapter } from '../upstream/types.js'

/** 平台类型常量 */
export const WEFLOW_PLATFORM = 'weflow'
/** 单实例阶段固定的连接实例 ID（多 channel 配置是后续功能） */
export const WEFLOW_CHANNEL_ID = 'weflow:default'

/** WeflowAdapter 的原始输入：会话 ID + 单条消息 */
export interface WeflowRawInput {
    talker: string
    message: WeflowMessage
}

export class WeflowAdapter implements UpstreamAdapter<WeflowRawInput> {
    readonly platform = WEFLOW_PLATFORM

    normalize(raw: WeflowRawInput): NormalizedMessage {
        const { talker, message } = raw
        // rawid 取 serverId（微信服务端消息 id，≈ SSE rawid），缺则回退 localId（链路文档 §11 待实测对齐）
        const externalId = String(message.serverId ?? message.localId ?? '').trim() || null
        return {
            dedupKey: externalId ?? '',
            eventType: 'message.new',
            externalId,
            conversationId: talker || null,
            senderId: message.senderUsername ?? null,
            msgTimestamp: typeof message.createTime === 'number' ? message.createTime : null,
            media: this.extractMedia(externalId, message),
            rawJson: JSON.stringify(message),
        }
    }

    /** 从 WeflowMessage 的媒体字段抽出归一化附件（当前每条消息至多一个媒体） */
    private extractMedia(externalId: string | null, message: WeflowMessage): MediaDescriptor[] {
        if (!message.mediaType && !message.mediaFileName && !message.mediaUrl) return []
        const fileName = message.mediaFileName ?? null
        return [{
            mediaKey: `${externalId ?? 'unknown'}:${fileName ?? 'media'}`,
            fileName,
            mime: null,
            size: null,
            sourceRef: message.mediaUrl ?? message.mediaLocalPath ?? null,
        }]
    }
}
