<template>
    <ElCard v-loading="loading">
        <template #header>
            <div class="messages-header">
                <span>WeFlow / 消息</span>
                <div class="messages-toolbar">
                    <ElSelect
                        v-model="conversationId"
                        class="messages-filter messages-filter-conv"
                        placeholder="会话/群"
                        clearable
                        filterable
                        @change="resetAndLoad"
                    >
                        <ElOption
                            v-for="g in groupOptions"
                            :key="g.value"
                            :label="g.label"
                            :value="g.value"
                        />
                    </ElSelect>
                    <ElSelect
                        v-model="status"
                        class="messages-filter"
                        placeholder="状态"
                        clearable
                        @change="resetAndLoad"
                    >
                        <ElOption
                            v-for="s in STATUS_OPTIONS"
                            :key="s.value"
                            :label="s.label"
                            :value="s.value"
                        />
                    </ElSelect>
                    <ElSelect
                        v-model="hasMedia"
                        class="messages-filter"
                        placeholder="媒体"
                        clearable
                        @change="resetAndLoad"
                    >
                        <ElOption
                            label="含媒体"
                            value="1"
                        />
                        <ElOption
                            label="纯文本"
                            value="0"
                        />
                    </ElSelect>
                    <ElSelect
                        v-model="ingestPath"
                        class="messages-filter"
                        placeholder="采集路径"
                        clearable
                        @change="resetAndLoad"
                    >
                        <ElOption
                            label="sse 实时"
                            value="sse"
                        />
                        <ElOption
                            label="catchup 补偿"
                            value="catchup"
                        />
                    </ElSelect>
                    <ElButton
                        :disabled="loading"
                        @click="load"
                    >
                        刷新
                    </ElButton>
                </div>
            </div>
        </template>

        <ElTable
            :data="messages"
            empty-text="暂无消息"
            style="width: 100%;"
        >
            <ElTableColumn
                label="会话"
                min-width="160"
                show-overflow-tooltip
            >
                <template #default="{ row }">
                    {{ groupName(row.conversationId) }}
                </template>
            </ElTableColumn>
            <ElTableColumn
                prop="senderId"
                label="发送者"
                min-width="120"
                show-overflow-tooltip
            />
            <ElTableColumn
                prop="eventType"
                label="类型"
                width="130"
            />
            <ElTableColumn
                label="消息时间"
                width="180"
            >
                <template #default="{ row }">
                    {{ fmtTime(row.msgTimestamp) }}
                </template>
            </ElTableColumn>
            <ElTableColumn
                label="媒体"
                width="90"
            >
                <template #default="{ row }">
                    <ElTag :type="row.hasMedia ? 'warning' : 'info'">
                        {{ row.hasMedia ? '媒体' : '文本' }}
                    </ElTag>
                </template>
            </ElTableColumn>
            <ElTableColumn
                label="状态"
                width="100"
            >
                <template #default="{ row }">
                    <ElTag :type="statusTagType(row.status)">{{ row.status }}</ElTag>
                </template>
            </ElTableColumn>
            <ElTableColumn
                prop="ingestPath"
                label="采集"
                width="100"
            />
            <ElTableColumn
                prop="attempts"
                label="重试"
                width="70"
            />
            <ElTableColumn
                label="操作"
                width="90"
                fixed="right"
            >
                <template #default="{ row }">
                    <ElButton
                        link
                        type="primary"
                        @click="onClickDetail(row.id)"
                    >
                        详情
                    </ElButton>
                </template>
            </ElTableColumn>
        </ElTable>

        <div class="messages-pager">
            <ElPagination
                :current-page="page"
                :page-size="pageSize"
                :page-sizes="[10, 20, 50, 100]"
                :total="total"
                layout="total, sizes, prev, pager, next"
                @current-change="onPageChange"
                @size-change="onSizeChange"
            />
        </div>
    </ElCard>

    <ElDialog
        v-model="detailVisible"
        title="消息详情"
        width="680px"
    >
        <div v-loading="detailLoading">
            <template v-if="detail">
                <p class="messages-detail-meta">
                    #{{ detail.id }} · {{ groupName(detail.conversationId) }} · {{ detail.status }} ·
                    {{ fmtTime(detail.msgTimestamp) }}
                </p>
                <p class="messages-detail-label">原始包 raw_json</p>
                <pre class="messages-detail-pre">{{ prettyRaw }}</pre>
                <template v-if="detail.mediaJson">
                    <p class="messages-detail-label">媒体 media_json</p>
                    <pre class="messages-detail-pre">{{ detail.mediaJson }}</pre>
                </template>
            </template>
        </div>
    </ElDialog>
</template>

<script setup lang="ts">
import { ApiError } from '@/api/http'
import { ref, computed, onMounted } from 'vue'
import { fetchGroups } from '@/api/groups'
import { fetchMessages, fetchMessageDetail, type MessageQuery } from '@/api/messages'
import { type WeflowMessageSummary, type WeflowMessageDetail, type WeflowMessageStatus, type WeflowIngestPath } from '@wb/shared/types'
import { ElCard, ElTable, ElTableColumn, ElSelect, ElOption, ElButton, ElTag, ElPagination, ElDialog, ElMessage } from 'element-plus'

type TagType = 'success' | 'info' | 'warning' | 'danger' | 'primary'

const STATUS_OPTIONS: { value: WeflowMessageStatus, label: string }[] = [
    { value: 'pending', label: 'pending' },
    { value: 'sending', label: 'sending' },
    { value: 'done', label: 'done' },
    { value: 'dead', label: 'dead' },
]
const STATUS_TAG: Record<WeflowMessageStatus, TagType> = {
    pending: 'warning', sending: 'primary', done: 'success', dead: 'danger',
}

const messages = ref<WeflowMessageSummary[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(20)
const loading = ref(false)

// 筛选项（空串 = 不过滤）
const conversationId = ref('')
const status = ref<WeflowMessageStatus | ''>('')
const hasMedia = ref<'' | '0' | '1'>('')
const ingestPath = ref<WeflowIngestPath | ''>('')

// 会话下拉 / 群名映射（复用群列表）
const groupMap = ref(new Map<string, string>())
const groupOptions = ref<{ value: string, label: string }[]>([])

// 详情弹窗
const detailVisible = ref(false)
const detailLoading = ref(false)
const detail = ref<WeflowMessageDetail | null>(null)

const statusTagType = (s: WeflowMessageStatus): TagType => STATUS_TAG[s]

/** conversationId → 群名（查不到回退 ID，空显「—」） */
function groupName(convId: string | null): string {
    if (!convId) return '—'
    return groupMap.value.get(convId) ?? convId
}

/** 秒级时间戳 → 本地时间；空显「—」 */
function fmtTime(sec: number | null): string {
    if (!sec) return '—'
    return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false })
}

/** raw_json 美化（解析失败原样显示） */
const prettyRaw = computed(() => {
    if (!detail.value) return ''
    try {
        return JSON.stringify(JSON.parse(detail.value.rawJson), null, 2)
    } catch {
        return detail.value.rawJson
    }
})

/** 拉群列表填充会话下拉 + 群名映射 */
function loadGroups(): void {
    fetchGroups()
        .then((list) => {
            groupMap.value = new Map(list.map(g => [g.conversationId, g.groupName ?? g.conversationId]))
            groupOptions.value = list.map(g => ({ value: g.conversationId, label: g.groupName ?? g.conversationId }))
        })
        .catch(() => { /* 群列表仅用于展示增强，失败不打断消息列表 */ })
}

/** 按当前筛选 + 分页拉消息 */
function load(): void {
    loading.value = true
    const q: MessageQuery = { page: page.value, pageSize: pageSize.value }
    if (conversationId.value) q.conversationId = conversationId.value
    if (status.value) q.status = status.value
    if (hasMedia.value !== '') q.hasMedia = Number(hasMedia.value) as 0 | 1
    if (ingestPath.value) q.ingestPath = ingestPath.value
    fetchMessages(q)
        .then((res) => {
            messages.value = res.items
            total.value = res.total
        })
        .catch((e) => ElMessage.error(e instanceof ApiError ? e.message : '加载消息失败'))
        .finally(() => { loading.value = false })
}

/** 筛选变更：回到第 1 页重拉（服务端筛选） */
function resetAndLoad(): void {
    page.value = 1
    load()
}

function onPageChange(p: number): void {
    page.value = p
    load()
}

function onSizeChange(s: number): void {
    pageSize.value = s
    page.value = 1
    load()
}

/** 打开详情弹窗并拉单条 */
function onClickDetail(id: number): void {
    detail.value = null
    detailVisible.value = true
    detailLoading.value = true
    fetchMessageDetail(id)
        .then((d) => { detail.value = d })
        .catch((e) => ElMessage.error(e instanceof ApiError ? e.message : '加载详情失败'))
        .finally(() => { detailLoading.value = false })
}

onMounted(() => {
    loadGroups()
    load()
})
</script>

<style scoped lang="scss">
.messages-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}
.messages-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.messages-filter {
    width: 130px;
}
.messages-filter-conv {
    width: 200px;
}
.messages-pager {
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
}
.messages-detail-meta {
    color: var(--el-text-color-secondary);
    font-size: 13px;
    margin: 0 0 12px;
}
.messages-detail-label {
    font-weight: 600;
    margin: 8px 0 4px;
}
.messages-detail-pre {
    max-height: 320px;
    overflow: auto;
    padding: 12px;
    margin: 0;
    background: var(--el-fill-color-light);
    border-radius: 4px;
    font-size: 12px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-all;
}
</style>
