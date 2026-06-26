// WeFlow 群组接口封装
import { httpGet, httpPost } from './http'
import { type WeflowGroup, type SyncGroupsResult } from '@wb/shared/types'

/** 群列表（只读，全量；筛选在前端做） */
export function fetchGroups(): Promise<WeflowGroup[]> {
    return httpGet<WeflowGroup[]>('/weflow/groups')
}

/** 手动「立即同步群」：拉会话 → 群同步 → 回报总数/放行数 */
export function syncGroupsNow(): Promise<SyncGroupsResult> {
    return httpPost<SyncGroupsResult>('/weflow/groups/sync')
}
