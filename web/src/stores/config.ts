// 配置 store：加载/保存服务端配置；后端不可达时回退默认值，保证表单仍可编辑。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WeflowConfig, WeflowConfigUpdate } from '@wb/shared/types'
import { DEFAULT_WEFLOW_CONFIG } from '@wb/shared/constants'
import { fetchConfig, updateConfig } from '@/api/config'

/** 深拷贝 WeFlow 配置，避免 store 与表单/默认值共享引用 */
function cloneWeflow(c: WeflowConfig): WeflowConfig {
  return { ...c, reconnect: { ...c.reconnect } }
}

export const useConfigStore = defineStore('config', () => {
  /** 服务端配置快照（accessToken 为掩码串或空） */
  const weflow = ref<WeflowConfig>(cloneWeflow(DEFAULT_WEFLOW_CONFIG))
  /** 服务端是否已配置 Token（掩码非空即视为已配置） */
  const hasExistingToken = ref(false)
  const loading = ref(false)
  const saving = ref(false)
  const loaded = ref(false)
  /** 加载失败信息（后端未实现/不可达时非空，此时已回退默认值） */
  const loadError = ref<string | null>(null)

  async function load(): Promise<void> {
    loading.value = true
    loadError.value = null
    try {
      const cfg = await fetchConfig()
      weflow.value = cloneWeflow(cfg.weflow)
      hasExistingToken.value = Boolean(cfg.weflow.accessToken)
      loaded.value = true
    } catch (e) {
      loadError.value = e instanceof Error ? e.message : String(e)
      // 回退默认值，表单仍可本地编辑/校验/测试
      weflow.value = cloneWeflow(DEFAULT_WEFLOW_CONFIG)
      hasExistingToken.value = false
    } finally {
      loading.value = false
    }
  }

  /** 保存 WeFlow 配置；成功后用服务端返回刷新快照 */
  async function saveWeflow(update: WeflowConfigUpdate): Promise<void> {
    saving.value = true
    try {
      const cfg = await updateConfig({ weflow: update })
      weflow.value = cloneWeflow(cfg.weflow)
      hasExistingToken.value = Boolean(cfg.weflow.accessToken)
      loaded.value = true
    } finally {
      saving.value = false
    }
  }

  return { weflow, hasExistingToken, loading, saving, loaded, loadError, load, saveWeflow }
})
