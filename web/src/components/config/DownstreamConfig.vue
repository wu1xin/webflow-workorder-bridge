<template>
    <ElCard
        v-loading="form.saving"
        class="downstream-config"
    >
        <template #header>
            <div class="downstream-config-header">
                <span>下游（work-order-system）</span>
                <ElSwitch
                    v-model="forwarding"
                    active-text="转发中"
                    inactive-text="已暂停"
                    @change="onToggleForwarding"
                />
            </div>
        </template>
        <ElForm
            :ref="r => (form.formRef = r as FormInstance)"
            :model="form.model"
            :rules="form.rules"
            label-width="auto"
        >
            <ElFormItem
                label="Base URL"
                prop="baseUrl"
            >
                <ElInput
                    v-model="form.model.baseUrl"
                    placeholder="https://example.com"
                    clearable
                />
            </ElFormItem>
            <ElFormItem
                label="站点 key"
                prop="siteKey"
            >
                <ElInput
                    v-model="form.model.siteKey"
                    placeholder="weflow-agent-…"
                    clearable
                />
            </ElFormItem>
            <ElFormItem
                label="AES 密钥"
                prop="aesKey"
            >
                <ElInput
                    v-model="form.model.aesKey"
                    placeholder="约定密钥串（取前 16 字节）"
                    clearable
                />
            </ElFormItem>
            <ElCollapse>
                <ElCollapseItem title="高级（转发调参，留空用默认）">
                    <ElFormItem label="最大重试次数">
                        <ElInputNumber
                            v-model="form.model.forwarder.maxAttempts"
                            :min="1"
                            :max="10"
                            :precision="0"
                            :controls="false"
                            :align="'left'"
                        />
                    </ElFormItem>
                    <ElFormItem label="退避基数(ms)">
                        <ElInputNumber
                            v-model="form.model.forwarder.backoffBaseMs"
                            :min="100"
                            :precision="0"
                            :controls="false"
                            :align="'left'"
                        />
                    </ElFormItem>
                    <ElFormItem label="退避上限(ms)">
                        <ElInputNumber
                            v-model="form.model.forwarder.backoffCapMs"
                            :min="1000"
                            :precision="0"
                            :controls="false"
                            :align="'left'"
                        />
                    </ElFormItem>
                </ElCollapseItem>
            </ElCollapse>
        </ElForm>
        <template #footer>
            <ElButton
                :loading="pinging"
                @click="onPing"
            >
                测试连接
            </ElButton>
            <ElButton
                type="primary"
                :loading="form.saving"
                @click="onSave"
            >
                保存
            </ElButton>
        </template>
    </ElCard>
</template>

<script setup lang="ts">
import { ApiError } from '@/api/http'
import { onMounted, ref, watch } from 'vue'
import { useConfigStore } from '@/stores/config'
import { testDownstreamPing, setForwarding, fetchForwardingState } from '@/api/config'
import { type DownstreamConfigUpdate } from '@wb/shared/types'
import { ElCard, ElForm, ElFormItem, ElButton, ElInput, ElInputNumber, ElSwitch, ElCollapse, ElCollapseItem, ElMessage, type FormInstance, type FormRules } from 'element-plus'

const store = useConfigStore()
const pinging = ref(false)
const forwarding = ref(false)

/** 下游表单模型：连接三件套明文回填 + forwarder 三项调参（可空，留空用后端默认） */
interface DownstreamModel {
    baseUrl: string
    siteKey: string
    aesKey: string
    forwarder: { maxAttempts?: number, backoffBaseMs?: number, backoffCapMs?: number }
}

/** 下游表单数据 */
const form = ref({
    formRef: undefined as FormInstance | undefined,
    model: { baseUrl: '', siteKey: '', aesKey: '', forwarder: {} } as DownstreamModel,
    rules: {
        baseUrl: [{ required: true, message: '请输入 Base URL', trigger: 'blur' }],
        siteKey: [{ required: true, message: '请输入站点 key', trigger: 'blur' }],
        aesKey: [{ required: true, message: '请输入 AES 密钥', trigger: 'blur' }],
    } as FormRules<DownstreamModel>,
    saving: false,
})

/** 监听 store 快照变化，重置表单 */
watch(
    () => store.config.downstream,
    (d) => {
        if (d) {
            form.value.model.baseUrl = d.baseUrl
            form.value.model.siteKey = d.siteKey
            form.value.model.aesKey = d.aesKey
            form.value.model.forwarder = { ...(d.forwarder ?? {}) }
        }
    },
    { immediate: true },
)

onMounted(() => {
    fetchForwardingState().then((s) => {
        forwarding.value = s.forwarding
    }).catch(() => {
        // 状态拉取失败不阻塞表单
    })
})

/** 组装更新负载：forwarder 里 undefined 字段过滤掉（留空用后端默认） */
function buildUpdate(): DownstreamConfigUpdate {
    const f = form.value.model.forwarder
    const forwarder: Record<string, number> = {}
    for (const [k, v] of Object.entries(f)) {
        if (typeof v === 'number') forwarder[k] = v
    }
    return {
        baseUrl: form.value.model.baseUrl.trim(),
        siteKey: form.value.model.siteKey.trim(),
        aesKey: form.value.model.aesKey.trim(),
        forwarder: Object.keys(forwarder).length ? forwarder : undefined,
    }
}

/** 点击保存按钮 */
function onSave() {
    form.value.formRef?.validate((valid) => {
        if (!valid) return
        form.value.saving = true
        store.saveDownstream(buildUpdate()).then(() => {
            ElMessage.success('下游配置已保存')
        }).catch((e) => {
            ElMessage.error(e instanceof ApiError ? e.message : '保存失败')
        }).finally(() => {
            form.value.saving = false
        })
    })
}

/** 点击测试连接：ping 当前已保存的下游配置 */
function onPing() {
    pinging.value = true
    testDownstreamPing().then((r) => {
        if (r.ok) ElMessage.success(`下游可达${r.version ? `（v${r.version}）` : ''}`)
        else ElMessage.warning(`下游未通过：${r.message ?? 'code!=1'}`)
    }).catch((e) => {
        ElMessage.error(e instanceof ApiError ? e.message : '测连失败')
    }).finally(() => {
        pinging.value = false
    })
}

/** 切换转发总开关：失败回滚开关态（ElSwitch change 回调类型为 string|number|boolean，此处开关值恒为布尔） */
function onToggleForwarding(val: string | number | boolean) {
    const enabled = val === true
    setForwarding(enabled).then((r) => {
        forwarding.value = r.forwarding
        ElMessage.success(r.forwarding ? '已开启转发' : '已暂停转发')
    }).catch((e) => {
        forwarding.value = !enabled
        ElMessage.error(e instanceof ApiError ? e.message : '切换失败')
    })
}
</script>

<style scoped lang="scss">
.downstream-config {
    &.el-card {
        :deep(> .el-card__footer) {
            display: flex;
            justify-content: flex-end;
            gap: 8px;
        }
    }
    .downstream-config-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
}
</style>
