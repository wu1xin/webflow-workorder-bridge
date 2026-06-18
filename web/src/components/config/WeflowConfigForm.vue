<template>
  <div v-loading="store.loading" class="weflow_form">
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="auto"
      label-position="right"
      class="weflow_form__body"
    >
      <el-form-item label="主机地址" prop="host">
        <el-input v-model="form.host" placeholder="127.0.0.1" />
      </el-form-item>
      <el-form-item label="端口" prop="port">
        <el-input-number
          v-model="form.port"
          :min="limits.port.min"
          :max="limits.port.max"
          :step="1"
          :precision="0"
          controls-position="right"
        />
      </el-form-item>
      <el-form-item label="Access Token" prop="accessToken">
        <el-input
          v-model="form.accessToken"
          type="password"
          show-password
          autocomplete="off"
          :placeholder="tokenPlaceholder"
        />
      </el-form-item>
      <el-form-item label="连接超时（秒）" prop="connectTimeoutSec">
        <el-input-number
          v-model="form.connectTimeoutSec"
          :min="limits.connectTimeoutSec.min"
          :max="limits.connectTimeoutSec.max"
          :step="1"
          :precision="0"
          controls-position="right"
        />
      </el-form-item>

      <el-form-item label="读超时（秒）" prop="readTimeoutSec">
        <el-input-number
          v-model="form.readTimeoutSec"
          :min="limits.readTimeoutSec.min"
          :max="limits.readTimeoutSec.max"
          :step="5"
          :precision="0"
          controls-position="right"
        />
      </el-form-item>
      <el-form-item label="探活间隔（秒）" prop="healthIntervalSec">
        <el-input-number
          v-model="form.healthIntervalSec"
          :min="limits.healthIntervalSec.min"
          :max="limits.healthIntervalSec.max"
          :step="5"
          :precision="0"
          controls-position="right"
        />
      </el-form-item>
      <el-form-item label="起始退避（秒）" prop="reconnect.initialDelaySec">
        <el-input-number
          v-model="form.reconnect.initialDelaySec"
          :min="limits.reconnect.initialDelaySec.min"
          :max="limits.reconnect.initialDelaySec.max"
          :step="1"
          :precision="0"
          controls-position="right"
        />
      </el-form-item>
      <el-form-item label="退避上限（秒）" prop="reconnect.maxDelaySec">
        <el-input-number
          v-model="form.reconnect.maxDelaySec"
          :min="limits.reconnect.maxDelaySec.min"
          :max="limits.reconnect.maxDelaySec.max"
          :step="1"
          :precision="0"
          controls-position="right"
        />
      </el-form-item>

      <el-form-item label="退避倍数" prop="reconnect.factor">
        <el-input-number
          v-model="form.reconnect.factor"
          :min="limits.reconnect.factor.min"
          :max="limits.reconnect.factor.max"
          :step="0.5"
          :precision="1"
          controls-position="right"
        />
      </el-form-item>

      <el-form-item label="最大重连次数" prop="reconnect.maxRetries">
        <el-input-number
          v-model="form.reconnect.maxRetries"
          :min="limits.reconnect.maxRetries.min"
          :step="1"
          :precision="0"
          controls-position="right"
        />
        <div class="weflow_form__hint">0 = 无限重连。</div>
      </el-form-item>

      <el-form-item label="退避抖动" prop="reconnect.jitter">
        <el-switch v-model="form.reconnect.jitter" />
        <div class="weflow_form__hint">在退避值上叠加 ±20% 随机，避免固定节奏。</div>
      </el-form-item>

      <el-form-item label="退避节奏预览">
        <el-text type="info">{{ backoffPreview }}</el-text>
      </el-form-item>

      <el-divider content-position="left">固定接口路径（不可配）</el-divider>

      <el-form-item label="SSE 推送路径">
        <el-input :model-value="fixedPaths.ssePath" disabled />
      </el-form-item>
      <el-form-item label="health 路径">
        <el-input :model-value="fixedPaths.healthPath" disabled />
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="store.saving" @click="onSave">保存</el-button>
        <el-button :loading="testing" @click="onTest">测试连接</el-button>
        <el-button text @click="onReset">重置</el-button>
      </el-form-item>
    </el-form>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, useTemplateRef, watch } from 'vue'
import { ElMessage, type FormInstance, type FormRules } from 'element-plus'
import type { WeflowConfig, WeflowConfigUpdate, WeflowConnectTestResult } from '@wb/shared/types'
import { WEFLOW_FIXED_PATHS, WEFLOW_LIMITS } from '@wb/shared/constants'
import { useConfigStore } from '@/stores/config'
import { ApiError } from '@/api/http'
import { testWeflowConnect } from '@/api/config'

const store = useConfigStore()
const limits = WEFLOW_LIMITS
const fixedPaths = WEFLOW_FIXED_PATHS

/** 本地编辑副本（accessToken 始终从空开始，不预填掩码串） */
const form = reactive<WeflowConfig>({
  host: '',
  port: 5031,
  accessToken: '',
  connectTimeoutSec: 10,
  readTimeoutSec: 60,
  healthIntervalSec: 30,
  reconnect: { initialDelaySec: 1, maxDelaySec: 30, factor: 2, maxRetries: 0, jitter: true },
})

/** 用 store 快照重置表单（token 输入清空，仅靠 placeholder 提示已配置） */
function resetFromStore(): void {
  const c = store.weflow
  form.host = c.host
  form.port = c.port
  form.accessToken = ''
  form.connectTimeoutSec = c.connectTimeoutSec
  form.readTimeoutSec = c.readTimeoutSec
  form.healthIntervalSec = c.healthIntervalSec
  form.reconnect.initialDelaySec = c.reconnect.initialDelaySec
  form.reconnect.maxDelaySec = c.reconnect.maxDelaySec
  form.reconnect.factor = c.reconnect.factor
  form.reconnect.maxRetries = c.reconnect.maxRetries
  form.reconnect.jitter = c.reconnect.jitter
}

// store 快照变化（加载完成 / 保存后整体替换）时同步到表单
watch(() => store.weflow, resetFromStore, { immediate: true })

const tokenPlaceholder = computed(() =>
  store.hasExistingToken
    ? `已配置（${store.weflow.accessToken}），留空则不修改`
    : '请输入 WeFlow Access Token',
)

const backoffPreview = computed(() => {
  const { initialDelaySec, maxDelaySec, factor } = form.reconnect
  const seq: number[] = []
  let d = initialDelaySec
  for (let i = 0; i < 6; i++) {
    seq.push(Math.min(maxDelaySec, Math.round(d)))
    d *= factor
  }
  return `${seq.join('s → ')}s …（成功后归零；0 次=无限重连）`
})

const formRef = useTemplateRef<FormInstance>('formRef')

const rules: FormRules = {
  host: [{ required: true, message: '请输入主机地址', trigger: 'blur' }],
  port: [{ required: true, type: 'number', message: '请输入端口', trigger: 'blur' }],
  accessToken: [
    {
      validator: (_rule: unknown, value: unknown, callback: (e?: Error) => void) => {
        if (!store.hasExistingToken && !String(value ?? '').trim()) {
          callback(new Error('请输入 Access Token'))
        } else {
          callback()
        }
      },
      trigger: 'blur',
    },
  ],
  'reconnect.maxDelaySec': [
    {
      validator: (_rule: unknown, value: unknown, callback: (e?: Error) => void) => {
        if (Number(value) < form.reconnect.initialDelaySec) {
          callback(new Error('退避上限需 ≥ 起始退避'))
        } else {
          callback()
        }
      },
      trigger: 'change',
    },
  ],
}

/** 把表单组装成更新负载：token 为空表示保持不变（置 null） */
function buildUpdate(): WeflowConfigUpdate {
  const token = form.accessToken.trim()
  return {
    host: form.host.trim(),
    port: form.port,
    connectTimeoutSec: form.connectTimeoutSec,
    readTimeoutSec: form.readTimeoutSec,
    healthIntervalSec: form.healthIntervalSec,
    reconnect: { ...form.reconnect },
    accessToken: token ? token : null,
  }
}

async function onSave(): Promise<void> {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid) return
  try {
    await store.saveWeflow(buildUpdate())
    form.accessToken = ''
    ElMessage.success('配置已保存')
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败')
  }
}

const testing = ref(false)
const testResult = ref<WeflowConnectTestResult | null>(null)

const testAlert = computed(() => {
  const r = testResult.value
  if (!r) return null
  const map = {
    ok: { type: 'success', title: '连接正常' },
    weflow_not_ready: { type: 'error', title: 'WeFlow 未就绪（未启动 / 未开 API 服务 / 端口错）' },
    token_invalid: { type: 'error', title: 'Token 鉴权失败（Token 错或过期）' },
    connected_no_push: { type: 'warning', title: '已连接但无推送（多半未开「主动推送」）' },
    error: { type: 'error', title: '连接测试失败' },
  } as const
  return map[r.diagnosis]
})

async function onTest(): Promise<void> {
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await testWeflowConnect(buildUpdate())
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '测试连接失败')
  } finally {
    testing.value = false
  }
}

function onReset(): void {
  resetFromStore()
  formRef.value?.clearValidate()
}
</script>

<style scoped lang="scss">
.weflow_form {
  max-width: 720px;

  &__load_error {
    margin-bottom: 16px;
  }

  &__hint {
    width: 100%;
    margin-top: 4px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    line-height: 1.5;
  }

  &__test_result {
    margin-top: 16px;
  }
}
</style>
