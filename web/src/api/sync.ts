// WeFlow 同步接口封装
import { httpPost } from './http'

/** 同步触发结果：仅 2xx（accepted=true）会 resolve；已有同步在跑时后端返回 409，走 catch */
export interface SyncTriggerResult {
    accepted: boolean
    status: { running: boolean, mode: string, enqueued: number }
}

/** 强制全量重拉：无视水位，从头拉所有放行群的全部历史（后台异步执行，需稍后刷新查看） */
export function forceFullResync(): Promise<SyncTriggerResult> {
    return httpPost<SyncTriggerResult>('/sync/full')
}
