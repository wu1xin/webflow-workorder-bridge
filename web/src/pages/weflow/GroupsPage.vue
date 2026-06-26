<template>
    <ElCard v-loading="loading">
        <template #header>
            <div class="groups-header">
                <span>WeFlow / 群组</span>
                <div class="groups-toolbar">
                    <ElInput
                        v-model="keyword"
                        class="groups-search"
                        placeholder="搜索群名"
                        clearable
                    />
                    <ElSelect
                        v-model="allowedFilter"
                        class="groups-filter"
                    >
                        <ElOption
                            label="全部放行状态"
                            value="all"
                        />
                        <ElOption
                            label="已放行"
                            value="allowed"
                        />
                        <ElOption
                            label="未放行"
                            value="blocked"
                        />
                    </ElSelect>
                    <ElButton
                        type="primary"
                        :loading="syncing"
                        @click="onClickSync"
                    >
                        立即同步群
                    </ElButton>
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
            :data="filtered"
            empty-text="暂无群组"
            style="width: 100%;"
        >
            <ElTableColumn
                label="群名"
                min-width="180"
            >
                <template #default="{ row }">
                    {{ row.groupName ?? row.conversationId }}
                </template>
            </ElTableColumn>
            <ElTableColumn
                prop="conversationId"
                label="群 ID"
                min-width="200"
                show-overflow-tooltip
            />
            <ElTableColumn
                label="放行"
                width="100"
            >
                <template #default="{ row }">
                    <ElTag :type="row.pushAllowed ? 'success' : 'info'">
                        {{ row.pushAllowed ? '已放行' : '未放行' }}
                    </ElTag>
                </template>
            </ElTableColumn>
            <ElTableColumn
                label="同步状态"
                width="120"
            >
                <template #default="{ row }">
                    <ElTooltip
                        v-if="row.syncStatus === 'failed' && row.lastError"
                        :content="row.lastError"
                        placement="top"
                    >
                        <ElTag type="danger">{{ syncText(row.syncStatus) }}</ElTag>
                    </ElTooltip>
                    <ElTag
                        v-else
                        :type="syncTagType(row.syncStatus)"
                    >
                        {{ syncText(row.syncStatus) }}
                    </ElTag>
                </template>
            </ElTableColumn>
            <ElTableColumn
                label="最近可见"
                width="180"
            >
                <template #default="{ row }">
                    {{ fmtTime(row.lastSeenAt) }}
                </template>
            </ElTableColumn>
            <ElTableColumn
                label="最近同步"
                width="180"
            >
                <template #default="{ row }">
                    {{ fmtTime(row.syncedAt) }}
                </template>
            </ElTableColumn>
        </ElTable>
    </ElCard>
</template>

<script setup lang="ts">
import { ApiError } from '@/api/http'
import { ref, computed, onMounted } from 'vue'
import { fetchGroups, syncGroupsNow } from '@/api/groups'
import { type WeflowGroup } from '@wb/shared/types'
import { ElCard, ElTable, ElTableColumn, ElInput, ElSelect, ElOption, ElButton, ElTag, ElTooltip, ElMessage } from 'element-plus'

type AllowedFilter = 'all' | 'allowed' | 'blocked'
type SyncStatus = WeflowGroup['syncStatus']
type TagType = 'success' | 'info' | 'warning' | 'danger'

const groups = ref<WeflowGroup[]>([])
const loading = ref(false)
const syncing = ref(false)
const keyword = ref('')
const allowedFilter = ref<AllowedFilter>('all')

/** 群名 + 放行状态的客户端筛选（数据量小，全量取回后本地过滤） */
const filtered = computed(() => {
    const kw = keyword.value.trim().toLowerCase()
    return groups.value.filter((g) => {
        const name = (g.groupName ?? g.conversationId).toLowerCase()
        if (kw && !name.includes(kw)) return false
        if (allowedFilter.value === 'allowed' && !g.pushAllowed) return false
        if (allowedFilter.value === 'blocked' && g.pushAllowed) return false
        return true
    })
})

const SYNC_LABEL: Record<SyncStatus, string> = { pending: '待同步', synced: '已同步', failed: '失败' }
const SYNC_TAG: Record<SyncStatus, TagType> = { pending: 'warning', synced: 'success', failed: 'danger' }
const syncText = (s: SyncStatus): string => SYNC_LABEL[s]
const syncTagType = (s: SyncStatus): TagType => SYNC_TAG[s]

/** 秒级时间戳 → 本地时间；空显「—」 */
function fmtTime(sec: number | null): string {
    if (!sec) return '—'
    return new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false })
}

/** 拉取群列表 */
function load(): void {
    loading.value = true
    fetchGroups()
        .then((list) => { groups.value = list })
        .catch((e) => ElMessage.error(e instanceof ApiError ? e.message : '加载群列表失败'))
        .finally(() => { loading.value = false })
}

/** 立即同步群：成功后重拉列表刷新各行状态（非 2xx 走 catch） */
function onClickSync(): void {
    syncing.value = true
    syncGroupsNow()
        .then((res) => {
            if (res.ok) ElMessage.success(`已同步 ${res.total} 个群，放行 ${res.allowed} 个`)
            return load()
        })
        .catch((e) => ElMessage.error(e instanceof ApiError ? e.message : '同步失败'))
        .finally(() => { syncing.value = false })
}

onMounted(load)
</script>

<style scoped lang="scss">
.groups-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
}
.groups-toolbar {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}
.groups-search {
    width: 180px;
}
.groups-filter {
    width: 150px;
}
</style>
