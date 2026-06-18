// 配置相关接口封装（对应需求文档 §6）。
import type {
  AppConfig,
  AppConfigUpdate,
  WeflowConfigUpdate,
  WeflowConnectTestResult,
} from '@wb/shared/types'
import { httpGet, httpPost, httpPut } from './http'

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
