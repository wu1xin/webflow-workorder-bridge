<template>
    <ElCard
        v-loading="weflowForm.saving"
        class="weflow-config"
    >
        <template #header>
            <div class="weflow-config-header">
                <span>上游（WeFlow）</span>
                <div class="weflow-config-status">
                    <el-tag :type="connectionTag.type">
                        {{ connectionTag.text }}
                    </el-tag>
                    <span
                        v-if="lastConnectedText"
                        class="weflow-config-status-time"
                    >
                        {{ lastConnectedText }}
                    </span>
                </div>
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
                    :min="0"
                    :precision="0"
                    :controls="false"
                    :align="'left'"
                    style="width: 100px;"
                />
            </ElFormItem>
            <ElFormItem
                label="Access Token"
                prop="accessToken"
            >
                <ElInput
                    v-model="weflowForm.model.accessToken"
                    placeholder="请输入 weflow Access Token"
                    clearable
                />
            </ElFormItem>
            <ElFormItem
                label="连接超时"
                prop="connectTimeoutSec"
            >
                <ElInputNumber
                    v-model="weflowForm.model.connectTimeoutSec"
                    :min="0"
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
                    :min="0"
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
                    :min="0"
                    :step="1"
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
                    :min="0"
                    :step="1"
                    :precision="0"
                    @change="revalidateLogInterval"
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
                    :min="0"
                    :step="1"
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
import { WeflowConnectionState } from '@wb/shared/constants/config'
import { type WeflowConfig, type WeflowConfigUpdate } from '@wb/shared/types'
import { ElCard, ElForm, ElFormItem, ElButton, ElInputNumber, ElInput, ElMessage, type FormInstance, type FormItemRule, type FormRules } from 'element-plus'

type TagType = 'primary' | 'success' | 'info' | 'warning' | 'danger'

/** 运行期连接状态 → 标签颜色/文案（数据源为 store.connectionStatus，经 SSE 实时驱动） */
const STATE_TAG_MAP: Record<WeflowConnectionState, { type: TagType, text: string }> = {
    [WeflowConnectionState.unconfigured]: { type: 'info', text: '未配置' },
    [WeflowConnectionState.connecting]: { type: 'primary', text: '连接中…' },
    [WeflowConnectionState.connected]: { type: 'success', text: '已连接 · 接收中' },
    [WeflowConnectionState.weflowNotReady]: { type: 'warning', text: 'WeFlow 未就绪' },
    [WeflowConnectionState.reconnecting]: { type: 'warning', text: '自动重连中' },
    [WeflowConnectionState.disconnected]: { type: 'danger', text: '连接失败' },
} as const

const store = useConfigStore()
const limits = WEFLOW_LIMITS

/** 数值字段统一校验：必填 + 落在 WEFLOW_LIMITS 区间内 */
function numberRules(label: string, limit: { min: number, max: number }): FormItemRule[] {
    return [{
        required: true,
        type: 'number',
        message: `请输入${label}`,
        trigger: 'blur',
    }, {
        type: 'number',
        min: limit.min,
        max: limit.max,
        message: `${label}取值范围 ${limit.min} ~ ${limit.max}`,
        trigger: 'blur',
    }]
}

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
        reconnectIntervalSec: 0,
        reconnectLogIntervalSec: 0,
    } as WeflowConfig,
    rules: {
        host: [{
            required: true,
            message: '请输入主机地址',
            trigger: 'blur',
        }],
        accessToken: [{
            required: true,
            message: '请输入 Access Token',
            trigger: 'blur',
        }],
        port: numberRules('端口', limits.port),
        connectTimeoutSec: numberRules('连接超时', limits.connectTimeoutSec),
        readTimeoutSec: numberRules('读超时', limits.readTimeoutSec),
        firstMessageTimeoutSec: numberRules('首消息窗口', limits.firstMessageTimeoutSec),
        reconnectIntervalSec: numberRules('重连间隔', limits.reconnectIntervalSec),
        reconnectLogIntervalSec: [
            ...numberRules('重连日志周期', limits.reconnectLogIntervalSec),
            {
                // 跨字段：日志周期须大于重连间隔（与后端 validateWeflowUpdate 一致）
                validator: (_rule, value, callback) => {
                    if (typeof value === 'number' && value <= weflowForm.value.model.reconnectIntervalSec) {
                        callback(new Error('重连日志周期须大于重连间隔'))
                        return
                    }
                    callback()
                },
                trigger: 'blur',
            },
        ],
    } as FormRules<WeflowConfig>,
    saving: false,
})

/** 连接状态标签：颜色固定映射，reconnecting 时追加本段重连次数 */
const connectionTag = computed(() => {
    const status = store.connectionStatus
    const base = STATE_TAG_MAP[status.state]
    const text = status.state === 'reconnecting' && status.reconnect
        ? `${base.text} · 第 ${status.reconnect.attempts} 次`
        : base.text
    return { type: base.type, text }
})

/** 已连接态下展示最近一次成功连接时刻 */
const lastConnectedText = computed(() => {
    const { state, lastConnectedAt } = store.connectionStatus
    if (state !== 'connected' || !lastConnectedAt) return ''
    return `最近连接 ${new Date(lastConnectedAt * 1000).toLocaleTimeString('zh-CN', { hour12: false })}`
})

/** 监听 store 快照变化，重置表单 */
watch(
    () => store.config.weflow, 
    (newWeflowConfig) => {
        if (newWeflowConfig) {
            weflowForm.value.model.host = newWeflowConfig.host
            weflowForm.value.model.port = newWeflowConfig.port
            weflowForm.value.model.accessToken = newWeflowConfig.accessToken
            weflowForm.value.model.connectTimeoutSec = newWeflowConfig.connectTimeoutSec
            weflowForm.value.model.readTimeoutSec = newWeflowConfig.readTimeoutSec
            weflowForm.value.model.firstMessageTimeoutSec = newWeflowConfig.firstMessageTimeoutSec
            weflowForm.value.model.reconnectIntervalSec = newWeflowConfig.reconnectIntervalSec
            weflowForm.value.model.reconnectLogIntervalSec = newWeflowConfig.reconnectLogIntervalSec
        }
    },
    { immediate: true }, 
)

/** 把表单组装成更新负载：token 直接整体写回（明文） */
function buildUpdate(): WeflowConfigUpdate {
    return {
        host: weflowForm.value.model.host.trim(),
        port: weflowForm.value.model.port,
        accessToken: weflowForm.value.model.accessToken.trim(),
        connectTimeoutSec: weflowForm.value.model.connectTimeoutSec,
        readTimeoutSec: weflowForm.value.model.readTimeoutSec,
        firstMessageTimeoutSec: weflowForm.value.model.firstMessageTimeoutSec,
        reconnectIntervalSec: weflowForm.value.model.reconnectIntervalSec,
        reconnectLogIntervalSec: weflowForm.value.model.reconnectLogIntervalSec,
    }
}

/** 重连间隔变动后联动重校验「重连日志周期」（其取值依赖重连间隔） */
function revalidateLogInterval() {
    weflowForm.value.formRef?.validateField('reconnectLogIntervalSec').catch(() => {})
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
    .weflow-config-status {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 2px;
    }
    .weflow-config-status-time {
        font-size: 12px;
        color: var(--el-text-color-secondary);
    }
}
</style>
