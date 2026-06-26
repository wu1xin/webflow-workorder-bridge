// WeFlow 消息接口封装（服务端分页 + 过滤）
import { httpGet } from './http'
import { type WeflowMessagePage, type WeflowMessageDetail, type WeflowMessageStatus, type WeflowIngestPath } from '@wb/shared/types'

/** 列表查询参数：page/pageSize 必填，其余为可选过滤 */
export interface MessageQuery {
    conversationId?: string
    status?: WeflowMessageStatus
    hasMedia?: 0 | 1
    ingestPath?: WeflowIngestPath
    page: number
    pageSize: number
}

/** 分页拉消息：空过滤项不拼进 query */
export function fetchMessages(q: MessageQuery): Promise<WeflowMessagePage> {
    const params = new URLSearchParams()
    params.set('page', String(q.page))
    params.set('pageSize', String(q.pageSize))
    if (q.conversationId) params.set('conversationId', q.conversationId)
    if (q.status) params.set('status', q.status)
    if (q.hasMedia !== undefined) params.set('hasMedia', String(q.hasMedia))
    if (q.ingestPath) params.set('ingestPath', q.ingestPath)
    return httpGet<WeflowMessagePage>(`/weflow/messages?${params.toString()}`)
}

/** 单条详情（含 raw_json） */
export function fetchMessageDetail(id: number): Promise<WeflowMessageDetail> {
    return httpGet<WeflowMessageDetail>(`/weflow/messages/${id}`)
}
