// 配置 store：加载/保存服务端配置；后端不可达时回退默认值，保证表单仍可编辑。
import { ref } from 'vue'
import { defineStore } from 'pinia'
import { fetchConfig, updateWeflowConfig } from '@/api/config'
import { WeflowConnectStatus } from '@wb/shared/constants/config'
import { type AppConfig, type WeflowConfig, type WeflowConfigUpdate, } from '@wb/shared/types'

export const useConfigStore = defineStore(
    'config',
    () => {
        /** 应用整体配置 */
        const config = ref<AppConfig>({
            weflow: undefined,
        })
        /** WeFlow 连接状态 */
        const weflowStatus = ref<WeflowConnectStatus>(WeflowConnectStatus.noConfig)
        /** 加载状态 */
        const loading = ref(false)
        /** 是否已加载 */
        const loaded = ref(false)
        /** 加载失败信息（后端未实现/不可达时非空，此时已回退默认值） */
        const loadError = ref<string>()

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

        return {
            config,
            weflowStatus,
            loading,
            loaded,
            loadError,
            load,
            saveWeflow
        }
    }
)
