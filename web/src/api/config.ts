// 配置相关接口封装
import { httpGet, httpPost, httpPut } from './http'
import { type AppConfig, type AppConfigUpdate, type WeflowConfigUpdate, type WeflowConnectTestResult } from '@wb/shared/types'

/** 读配置（敏感字段已掩码） */
export function fetchConfig(): Promise<AppConfig> {
    return httpGet<AppConfig>('/config')
}

/** 保存配置（校验 + 触发热重连） */
export function updateConfig(body: AppConfigUpdate): Promise<AppConfig> {
    return httpPut<AppConfig>('/config', body)
}

/** WeFlow 连接测试：health + SSE 试连（FR-TEST-03） */
export function testWeflowConnect(weflow: WeflowConfigUpdate): Promise<WeflowConnectTestResult> {
    return httpPost<WeflowConnectTestResult>('/test/weflow-connect', { weflow })
}
