<template>
    <ElCard
        v-loading="weflowForm.saving"
        class="weflow-config"
    >
        <template #header>
            <div class="weflow-config-header">
                <span>上游（WeFlow）</span>
                <el-tag :type="weflowStatus.type">
                    {{ weflowStatus.text }}
                </el-tag>
            </div>
        </template>
        <ElForm
            :ref="r => (weflowForm.formRef = r as FormInstance)"
            :model="weflowForm.model"
            :rules="weflowForm.rules"
            label-width="auto"
        >
            <ElFormItem
                label="主机地址"
                prop="host"
            >
                <ElInput
                    v-model="weflowForm.model.host"
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
                    v-model="weflowForm.model.port"
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
                    v-model="weflowForm.model.accessToken"
                    :placeholder="tokenPlaceholder"
                    style="width: 250px;"
                    clearable
                />
            </ElFormItem>
            <ElFormItem
                label="连接超时"
                prop="connectTimeoutSec"
            >
                <ElInputNumber
                    v-model="weflowForm.model.connectTimeoutSec"
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
                label="读超时"
                prop="readTimeoutSec"
            >
                <ElInputNumber
                    v-model="weflowForm.model.readTimeoutSec"
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
                label="首消息窗口"
                prop="firstMessageTimeoutSec"
            >
                <ElInputNumber
                    v-model="weflowForm.model.firstMessageTimeoutSec"
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
                label="探活间隔"
                prop="healthIntervalSec"
            >
                <ElInputNumber
                    v-model="weflowForm.model.healthIntervalSec"
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
                label="重连间隔"
                prop="reconnectIntervalSec"
            >
                <ElInputNumber
                    v-model="weflowForm.model.reconnectIntervalSec"
                    :min="limits.reconnectIntervalSec.min"
                    :max="limits.reconnectIntervalSec.max"
                    :step="1"
                    :precision="0"
                >
                    <template #suffix>
                        <span>秒</span>
                    </template>
                </ElInputNumber>
            </ElFormItem>
            <ElFormItem
                label="重连日志周期"
                prop="reconnectLogIntervalSec"
            >
                <ElInputNumber
                    v-model="weflowForm.model.reconnectLogIntervalSec"
                    :min="limits.reconnectLogIntervalSec.min"
                    :max="limits.reconnectLogIntervalSec.max"
                    :step="5"
                    :precision="0"
                >
                    <template #suffix>
                        <span>秒</span>
                    </template>
                </ElInputNumber>
            </ElFormItem>
        </ElForm>
        <template #footer>
            <ElButton
                type="primary"
                :loading="weflowForm.saving"
                @click="onClickSave"
            >
                保存
            </ElButton>
        </template>
    </ElCard>
</template>

<script setup lang="ts">
import { ApiError } from '@/api/http'
import { computed, ref, watch } from 'vue'
import { useConfigStore } from '@/stores/config'
import { WEFLOW_LIMITS } from '@wb/shared/constants'
import { WeflowConnectStatus } from '@wb/shared/constants/config'
import { type WeflowConfig, type WeflowConfigUpdate } from '@wb/shared/types'
import { ElCard, ElForm, ElFormItem, ElButton, ElInputNumber, ElInput, ElMessage, type FormInstance, type FormRules } from 'element-plus'

const WorkerStatusMap: Record<WeflowConnectStatus, { type: string, text: string }> = {
    [WeflowConnectStatus.ok]: { type: 'success', text: '连接正常' },
    [WeflowConnectStatus.weflow_not_ready]: { type: 'error', text: 'WeFlow 未就绪（未启动 / 未开 API 服务 / 端口错）' },
    [WeflowConnectStatus.token_invalid]: { type: 'error', text: 'Token 鉴权失败（Token 错或过期）' },
    [WeflowConnectStatus.connected_no_push]: { type: 'warning', text: '已连接但无推送（多半未开「主动推送」）' },
    [WeflowConnectStatus.error]: { type: 'error', text: '连接测试失败' },
    [WeflowConnectStatus.noConfig]: { type: 'info', text: '未配置' },
} as const

const store = useConfigStore()
const limits = WEFLOW_LIMITS

/** weflow 表单数据 */
const weflowForm = ref({
    formRef: undefined as FormInstance | undefined,
    model: {
        host: '',
        port: 0,
        accessToken: '',
        connectTimeoutSec: 0,
        readTimeoutSec: 0,
        firstMessageTimeoutSec: 0,
        healthIntervalSec: 0,
        reconnectIntervalSec: 0,
        reconnectLogIntervalSec: 0,
    } as WeflowConfig,
    rules: {
        host: [{
            required: true,
            message: '请输入主机地址',
            trigger: 'blur',
        }],
        port: [{
            required: true,
            type: 'number',
            message:
            '请输入端口',
            trigger: 'blur',
        }],
        accessToken: [{
            validator: (_rule: unknown, value: unknown, callback: (e?: Error) => void) => {
                if (!hasExistingToken.value && !String(value ?? '').trim()) {
                    callback(new Error('请输入 Access Token'))
                } else {
                    callback()
                }
            },
            trigger: 'blur',
        }],
    } as FormRules<WeflowConfig>,
    saving: false,
})

/** 计算 weflow 连接状态 */
const weflowStatus = computed(() => {
    return WorkerStatusMap[store.weflowStatus]
})

/** 是否已配置 Access Token */
const hasExistingToken = computed(() => {
    return Boolean(store.config.weflow?.accessToken)
})

/** 计算 token 输入框的占位符 */
const tokenPlaceholder = computed(() => {
    let _placeholder = '请输入 weflow Access Token'
    if (hasExistingToken.value) {
        _placeholder = '已配置，留空保持不变'
    }
    return _placeholder
})

/** 监听 store 快照变化，重置表单 */
watch(
    () => store.config.weflow, 
    (newWeflowConfig) => {
        if (newWeflowConfig) {
            weflowForm.value.model.host = newWeflowConfig.host
            weflowForm.value.model.port = newWeflowConfig.port
            weflowForm.value.model.accessToken = ''
            weflowForm.value.model.connectTimeoutSec = newWeflowConfig.connectTimeoutSec
            weflowForm.value.model.readTimeoutSec = newWeflowConfig.readTimeoutSec
            weflowForm.value.model.firstMessageTimeoutSec = newWeflowConfig.firstMessageTimeoutSec
            weflowForm.value.model.healthIntervalSec = newWeflowConfig.healthIntervalSec
            weflowForm.value.model.reconnectIntervalSec = newWeflowConfig.reconnectIntervalSec
            weflowForm.value.model.reconnectLogIntervalSec = newWeflowConfig.reconnectLogIntervalSec
        }
    },
    { immediate: true }, 
)

/** 把表单组装成更新负载：token 为空表示保持不变（置 null） */
function buildUpdate(): WeflowConfigUpdate {
    const token = weflowForm.value.model.accessToken.trim()
    return {
        host: weflowForm.value.model.host.trim(),
        port: weflowForm.value.model.port,
        accessToken: token ? token : undefined, // token 为空表示保持不变
        connectTimeoutSec: weflowForm.value.model.connectTimeoutSec,
        readTimeoutSec: weflowForm.value.model.readTimeoutSec,
        firstMessageTimeoutSec: weflowForm.value.model.firstMessageTimeoutSec,
        healthIntervalSec: weflowForm.value.model.healthIntervalSec,
        reconnectIntervalSec: weflowForm.value.model.reconnectIntervalSec,
        reconnectLogIntervalSec: weflowForm.value.model.reconnectLogIntervalSec,
    }
}

/** 点击保存按钮 */
function onClickSave() {
    weflowForm.value.formRef?.validate((valid) => {
        if (valid) {
            weflowForm.value.saving = true
            store.saveWeflow(buildUpdate()).then(() => {
                ElMessage.success('配置已保存')
                weflowForm.value.saving = false
            }).catch((e) => {
                ElMessage.error(e instanceof ApiError ? e.message : '保存失败')
                weflowForm.value.saving = false
            })
        }
    })
}
</script>

<style scoped lang="scss">
.weflow-config {
    &.el-card {
        :deep(>.el-card__footer) {
            display: flex;
            justify-content: flex-end;
        }
    }
    .weflow-config-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
}
</style>
