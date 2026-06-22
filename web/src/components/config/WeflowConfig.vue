<template>
    <ElCard
        v-loading="store.loading"
        header="上游（WeFlow）"
    >
        <div class="weflow_form">
            <ElForm
                ref="formRef"
                :model="form"
                :rules="rules"
                label-width="auto"
            >
                <ElFormItem
                    label="主机地址"
                    prop="host"
                >
                    <ElInput
                        v-model="form.host"
                        placeholder="127.0.0.1"
                        style="width: 150px;"
                        clearable
                    />
                </ElFormItem>
                <ElFormItem
                    label="端口"
                    prop="port"
                >
                    <ElInputNumber
                        v-model="form.port"
                        :min="limits.port.min"
                        :max="limits.port.max"
                        :step="1"
                        :precision="0"
                        :controls="false"
                        style="width: 100px;"
                    />
                </ElFormItem>
                <ElFormItem
                    label="Access Token"
                    prop="accessToken"
                >
                    <ElInput
                        v-model="form.accessToken"
                        placeholder="请输入 WeFlow Access Token"
                        style="width: 250px;"
                        clearable
                    />
                </ElFormItem>
                <ElFormItem
                    label="连接超时"
                    prop="connectTimeoutSec"
                >
                    <ElInputNumber
                        v-model="form.connectTimeoutSec"
                        :min="limits.connectTimeoutSec.min"
                        :max="limits.connectTimeoutSec.max"
                        :step="1"
                        :precision="0"
                    >
                        <template #suffix>
                            <span>秒</span>
                        </template>
                    </ElInputNumber>
                </ElFormItem>

                <ElFormItem
                    label="读超时（秒）"
                    prop="readTimeoutSec"
                >
                    <ElInputNumber
                        v-model="form.readTimeoutSec"
                        :min="limits.readTimeoutSec.min"
                        :max="limits.readTimeoutSec.max"
                        :step="5"
                        :precision="0"
                    >
                        <template #suffix>
                            <span>秒</span>
                        </template>
                    </ElInputNumber>
                </ElFormItem>
                <ElFormItem
                    label="首消息窗口（秒）"
                    prop="firstMessageTimeoutSec"
                >
                    <ElInputNumber
                        v-model="form.firstMessageTimeoutSec"
                        :min="limits.firstMessageTimeoutSec.min"
                        :max="limits.firstMessageTimeoutSec.max"
                        :step="1"
                        :precision="0"
                    >
                        <template #suffix>
                            <span>秒</span>
                        </template>
                    </ElInputNumber>
                </ElFormItem>
                <ElFormItem
                    label="探活间隔（秒）"
                    prop="healthIntervalSec"
                >
                    <ElInputNumber
                        v-model="form.healthIntervalSec"
                        :min="limits.healthIntervalSec.min"
                        :max="limits.healthIntervalSec.max"
                        :step="5"
                        :precision="0"
                    >
                        <template #suffix>
                            <span>秒</span>
                        </template>
                    </ElInputNumber>
                </ElFormItem>
                <ElFormItem
                    label="重连间隔（秒）"
                    prop="reconnect.intervalSec"
                >
                    <ElInputNumber
                        v-model="form.reconnect.intervalSec"
                        :min="limits.reconnect.intervalSec.min"
                        :max="limits.reconnect.intervalSec.max"
                        :step="1"
                        :precision="0"
                    >
                        <template #suffix>
                            <span>秒</span>
                        </template>
                    </ElInputNumber>
                </ElFormItem>
                <ElFormItem
                    label="重连日志周期（秒）"
                    prop="reconnect.logIntervalSec"
                >
                    <ElInputNumber
                        v-model="form.reconnect.logIntervalSec"
                        :min="limits.reconnect.logIntervalSec.min"
                        :max="limits.reconnect.logIntervalSec.max"
                        :step="5"
                        :precision="0"
                    >
                        <template #suffix>
                            <span>秒</span>
                        </template>
                    </ElInputNumber>
                </ElFormItem>
            </ElForm>
        </div>
        <template #footer>
            <ElButton
                type="primary"
                :loading="store.saving"
                @click="onSave"
            >
                保存
            </ElButton>
            <ElButton
                :loading="testing"
                @click="onTest"
            >
                测试连接
            </ElButton>
        </template>
    </ElCard>
</template>

<script setup lang="ts">
import { ApiError } from '@/api/http'
import { testWeflowConnect } from '@/api/config'
import { useConfigStore } from '@/stores/config'
import { WEFLOW_LIMITS } from '@wb/shared/constants'
import { computed, reactive, ref, useTemplateRef, watch } from 'vue'
import { type WeflowConfig, type WeflowConfigUpdate, type WeflowConnectTestResult } from '@wb/shared/types'
import { ElCard, ElForm, ElFormItem, ElButton, ElInputNumber, ElInput, ElMessage, type FormInstance, type FormRules } from 'element-plus'

const store = useConfigStore()
const limits = WEFLOW_LIMITS

/** 本地编辑副本（accessToken 始终从空开始，不预填掩码串） */
const form = reactive<WeflowConfig>({
    host: '',
    port: 5031,
    accessToken: '',
    connectTimeoutSec: 10,
    readTimeoutSec: 60,
    firstMessageTimeoutSec: 3,
    healthIntervalSec: 30,
    reconnect: { intervalSec: 1, logIntervalSec: 30 },
})

/** 用 store 快照重置表单（token 输入清空，仅靠 placeholder 提示已配置） */
function resetFromStore(): void {
    const c = store.weflow
    form.host = c.host
    form.port = c.port
    form.accessToken = ''
    form.connectTimeoutSec = c.connectTimeoutSec
    form.readTimeoutSec = c.readTimeoutSec
    form.firstMessageTimeoutSec = c.firstMessageTimeoutSec
    form.healthIntervalSec = c.healthIntervalSec
    form.reconnect.intervalSec = c.reconnect.intervalSec
    form.reconnect.logIntervalSec = c.reconnect.logIntervalSec
}

// store 快照变化（加载完成 / 保存后整体替换）时同步到表单
watch(() => store.weflow, resetFromStore, { immediate: true })

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
}

/** 把表单组装成更新负载：token 为空表示保持不变（置 null） */
function buildUpdate(): WeflowConfigUpdate {
    const token = form.accessToken.trim()
    return {
        host: form.host.trim(),
        port: form.port,
        connectTimeoutSec: form.connectTimeoutSec,
        readTimeoutSec: form.readTimeoutSec,
        firstMessageTimeoutSec: form.firstMessageTimeoutSec,
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
  width: 100%;
  &__load_error {
    margin-bottom: 16px;
  }
  &__test_result {
    margin-top: 16px;
  }
}
</style>
