// WeFlow 群组接口封装
import { httpGet, httpPost } from './http'
import { type WeflowGroup, type SyncGroupsResult } from '@wb/shared/types'

/** reset 接口成功响应（accepted 恒 true；防并发时后端返回 409 → 前端走 ApiError） */
interface ResetResult {
    accepted: boolean
}

/** 群列表（只读，全量；筛选在前端做） */
export function fetchGroups(): Promise<WeflowGroup[]> {
    return httpGet<WeflowGroup[]>('/weflow/groups')
}

/** 手动「立即同步群」：拉会话 → 群同步 → 回报总数/放行数 */
export function syncGroupsNow(): Promise<SyncGroupsResult> {
    return httpPost<SyncGroupsResult>('/weflow/groups/sync')
}

/** 单群清空重拉（开发/测试）：清该群 queue+dedup → 从 0 定向重拉 */
export function resetGroup(conversationId: string): Promise<ResetResult> {
    return httpPost<ResetResult>(`/weflow/groups/${encodeURIComponent(conversationId)}/reset`)
}

/** 全部清空重拉（开发/测试）：清空 queue+dedup+水位 → 全量重灌 */
export function resetAllGroups(): Promise<ResetResult> {
    return httpPost<ResetResult>('/weflow/groups/reset-all')
}
