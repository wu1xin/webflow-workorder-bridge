// 配置 store：加载/保存服务端配置；后端不可达时回退默认值，保证表单仍可编辑。
// 另维护一条 SSE 长连接（GET /api/stream/status），实时同步 WeFlow 上游连接状态。
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { BASE } from '@/api/http'
import { fetchConfig, updateWeflowConfig } from '@/api/config'
import { type AppConfig, type WeflowConfigUpdate, type WeflowConnectionStatus } from '@wb/shared/types'

/** 连接状态初值：后端首帧到达前先停在「未配置」 */
function initialConnectionStatus(): WeflowConnectionStatus {
    return { state: 'unconfigured', diagnosis: null, lastConnectedAt: null, message: null, reconnect: null }
}

export const useConfigStore = defineStore(
    'config',
    () => {
        /** 应用整体配置 */
        const config = ref<AppConfig>({
            weflow: undefined,
        })
        /** WeFlow 上游连接实时状态（由 SSE 推送驱动） */
        const connectionStatus = ref<WeflowConnectionStatus>(initialConnectionStatus())
        /** 加载状态 */
        const loading = ref(false)
        /** 是否已加载 */
        const loaded = ref(false)
        /** 加载失败信息（后端未实现/不可达时非空，此时已回退默认值） */
        const loadError = ref<string>()

        /** 状态推送长连接（非响应式，仅作句柄管理） */
        let statusStream: EventSource | null = null

        function load() {
            loading.value = true
            loadError.value = undefined
            return new Promise<void>((resolve, reject) => {
                fetchConfig().then((cfg) => {
                    config.value = cfg
                    loaded.value = true
                    loading.value = false
                    resolve()
                }).catch((e: Error) => {
                    loadError.value = e.message
                    loading.value = false
                    reject(e)
                })
            })
        }

        /** 保存 WeFlow 配置；成功后用服务端返回的掩码配置刷新快照（错误向上抛给调用方处理） */
        function saveWeflow(update: WeflowConfigUpdate){
            return new Promise<void>((resolve, reject) => {
                updateWeflowConfig(update).then((cfg) => {
                    config.value.weflow = JSON.parse(JSON.stringify(cfg))
                    resolve()
                }).catch((e) => {
                    reject(e)
                })
            })
        }

        /**
         * 订阅连接状态实时流（幂等）。EventSource 断线会自行重连，
         * 后端重连后重推一份完整快照，无需前端额外补偿。
         */
        function connectStatusStream() {
            if (statusStream) return
            const es = new EventSource(`${BASE}/stream/status`)
            es.onmessage = (e) => {
                try {
                    connectionStatus.value = JSON.parse(e.data) as WeflowConnectionStatus
                } catch {
                    // 单条帧解析失败忽略，等下一帧；不影响已有状态
                }
            }
            statusStream = es
        }

        /** 关闭状态实时流 */
        function disconnectStatusStream() {
            statusStream?.close()
            statusStream = null
        }

        return {
            config,
            connectionStatus,
            loading,
            loaded,
            loadError,
            load,
            saveWeflow,
            connectStatusStream,
            disconnectStatusStream,
        }
    }
)
