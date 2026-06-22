<template>
    <div class="config_page">
        <WeflowConfig />
    </div>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useConfigStore } from '@/stores/config'
import WeflowConfig from '@/components/config/WeflowConfig.vue'

const store = useConfigStore()

onMounted(() => {
    store.load()
})
</script>

<style scoped lang="scss">
.config_page {
    display: flex;
    flex-wrap: wrap;
    > .el-card {
        flex: 1;
        max-width: 500px;
    }
}
</style>
