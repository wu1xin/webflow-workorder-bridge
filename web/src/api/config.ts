// 配置相关接口封装
import { httpGet, httpPost, httpPut } from './http'
import { type AppConfig, type DownstreamConfig, type DownstreamConfigUpdate, type WeflowConfig, type WeflowConfigUpdate, type WeflowConnectTestResult } from '@wb/shared/types'

/** 读配置（内部工具，含明文 accessToken） */
export function fetchConfig(): Promise<AppConfig> {
    return httpGet<AppConfig>('/config')
}

/** 保存 WeFlow 配置（校验 + 触发热重连），返回保存后的 WeFlow 配置 */
export function updateWeflowConfig(body: WeflowConfigUpdate): Promise<WeflowConfig> {
    return httpPut<WeflowConfig>('/config/weflow', body)
}

/** WeFlow 连接测试：health + SSE 试连（FR-TEST-03） */
export function testWeflowConnect(weflow: WeflowConfigUpdate): Promise<WeflowConnectTestResult> {
    return httpPost<WeflowConnectTestResult>('/test/weflow-connect', { weflow })
}

/** 保存下游配置（校验 + 触发 forwarder kick），返回保存后的下游配置 */
export function updateDownstreamConfig(body: DownstreamConfigUpdate): Promise<DownstreamConfig> {
    return httpPut<DownstreamConfig>('/config/downstream', body)
}

/** 下游连通性测试（ping 当前已保存配置） */
export function testDownstreamPing(): Promise<{ ok: boolean, serverTime?: number, version?: string, message?: string }> {
    return httpPost<{ ok: boolean, serverTime?: number, version?: string, message?: string }>('/test/downstream-ping', {})
}

/** 转发总开关 */
export function setForwarding(enabled: boolean): Promise<{ forwarding: boolean }> {
    return httpPost<{ forwarding: boolean }>('/control/forwarding', { enabled })
}

/** 拉取运行状态（本组件仅用其中的 forwarding 初始化开关） */
export function fetchForwardingState(): Promise<{ forwarding: boolean }> {
    return httpGet<{ forwarding: boolean }>('/status')
}
