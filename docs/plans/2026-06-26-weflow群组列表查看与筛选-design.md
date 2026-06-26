# WeFlow 群组列表查看与筛选 设计文档

> 编写日期：2026-06-26
> 关联：`docs/plans/2026-06-25-群聊表与下游群同步-design.md`（`chat_group` 表与群同步）、`docs/plans/2026-06-17-weflow-bridge-v2-需求与架构设计.md`

## 1. 背景与目标

`chat_group` 表与 `GroupSyncService` 已落地：群聊会话被收集入库，下游裁定 `push_allowed`。但这些数据**没有任何 HTTP 接口暴露给前端**，`web/src/pages/weflow/GroupsPage.vue` 仍是 `el-empty` 占位。

本期打通前后端，实现 **WeFlow 群组列表的查看 + 简单筛选**：

1. 后端新增只读列表接口与一个手动「立即同步群」接口。
2. 前端用 `el-table` 渲染列表，支持**群名搜索**与**放行状态**两个维度的筛选（客户端过滤）。
3. 提供「立即同步群」按钮，手动触发一次群同步并刷新列表。

### 1.1 范围与决策

| 决策点 | 结论 |
|--------|------|
| 筛选维度 | 群名搜索（包含匹配）+ 放行状态（全部/已放行/未放行）。**不**做同步状态筛选 |
| 筛选位置 | **全部放前端**：列表全量返回，客户端 `computed` 过滤。群数量小，后端不加 query 参数（YAGNI） |
| 页面操作 | 含「立即同步群」按钮，手动触发群同步；其余只读 |
| `push_allowed` | 下游裁决，前端**只读展示**，不可改 |
| channel 范围 | 单实例 `WEFLOW_CHANNEL_ID`，无 channel 选择器 |
| 同步等待 | `POST .../sync` **await 同步完成**后返回汇总，前端再重拉列表 |

## 2. 后端

### 2.1 路由 —— 新增 `server/src/routes/groups.ts`

仿 `routes/sync.ts` 风格，`index.ts` 中 `registerGroupRoutes(app, ctx)` 注册。

```
GET  /api/weflow/groups        →  WeflowGroup[]   （ctx.db.chatGroup.listAll(WEFLOW_CHANNEL_ID)）
POST /api/weflow/groups/sync   →  手动「立即同步群」 → ctx.sync.syncGroupsNow()
```

- `GET`：直接返回 `listAll`（已按 `last_seen_at DESC` 排序）的全量。响应标注 `WeflowGroup[]`，与 `ChatGroup` 结构兼容。
- `POST .../sync`：调用 `ctx.sync.syncGroupsNow()`，**await 完成**：
  - `{ ok: true, total, allowed }` → 200。
  - `{ ok: false, error }` → 503（上游不可达 / 未配下游群同步）。

### 2.2 `SyncService.syncGroupsNow()`

复用 `runFullSync` 中 `listSessions → syncGroups` 那一段，新增独立方法：

```
syncGroupsNow(): Promise<{ ok: true, total: number, allowed: number } | { ok: false, error: string }>
```

- 未注入 `groupSync`（缺省下游）→ `{ ok: false, error: '未配置下游群同步' }`。
- `groupSyncing` 自旋锁在跑 → `{ ok: false, error: '群同步进行中' }`（防连点重复触发）。
- 流程：`cfg()` → `createClient(cfg)` → `await listSessions()` → `await groupSync.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, sessions)` → 读 `db.chatGroup.listAll` 算 `total` 与 `allowed`（`pushAllowed===true` 计数）→ 返回。
- `listSessions()` 抛错（上游不可达）→ catch 后 `{ ok: false, error }`，**不**抛到上层。
- `finally` 释放 `groupSyncing`。

**关键约束**：
- **不改** `GroupSyncService.syncAll` 的吞错语义与返回类型 —— 现有自动同步路径（`onConnected`/`triggerManual`）和既有测试零影响。下游失败仍由 `syncAll` 内部 `markSyncFailed`，前端重拉列表时从各行 `syncStatus=failed`/`lastError` 看到结果。
- **不**与消息同步的 `progress.running` 互斥：群同步幂等、轻量，与全量/补偿可并行；仅用 `groupSyncing` 防自身重入。

## 3. 共享类型 —— `@wb/shared/types`

在 `shared/src/types/` 新增 `weflow-group.ts`（或并入合适文件），导出只读 DTO，barrel `types/index.ts` re-export：

```ts
/** 群组列表只读 DTO（GET /api/weflow/groups） */
export interface WeflowGroup {
    conversationId: string
    groupName: string | null
    avatarUrl: string | null
    pushAllowed: boolean
    syncStatus: 'pending' | 'synced' | 'failed'
    syncedAt: number | null
    lastError: string | null
    firstSeenAt: number
    lastSeenAt: number
}
```

- 后端 `ChatGroup`（含 `channelId/platform`）结构兼容 `WeflowGroup`（列表用不到这两列，可省）。
- 改完 shared 需 `npm -w shared run build` 更新 `dist`，前端才解析得到（根 `predev`/`dev:shared` 会构建）。

## 4. 前端

### 4.1 API —— 新增 `web/src/api/groups.ts`

仿 `api/config.ts`：

```ts
export function fetchGroups(): Promise<WeflowGroup[]>            // httpGet('/weflow/groups')
export function syncGroupsNow(): Promise<SyncGroupsResult>       // httpPost('/weflow/groups/sync')
```

`SyncGroupsResult = { ok: boolean; total?: number; allowed?: number; error?: string }`。

### 4.2 页面 —— 改写 `web/src/pages/weflow/GroupsPage.vue`

`<script setup lang="ts">` + Composition API（遵守 `vue-best-practices`）。

**工具栏**（一行）：
- 群名搜索 `el-input`（`clearable`，placeholder「搜索群名」）
- 放行状态 `el-select`：全部 / 已放行 / 未放行
- 「立即同步群」`el-button`（`type=primary`，`:loading=syncing`）
- 「刷新」`el-button`

**`el-table` 列**：

| 列 | 来源 / 渲染 |
|----|------|
| 群名 | `groupName ?? conversationId` |
| 群 ID | `conversationId` |
| 放行 | `el-tag`：已放行(success) / 未放行(info) |
| 同步状态 | `el-tag`：synced(success)/pending(warning)/failed(danger)；failed 挂 `el-tooltip` 显示 `lastError` |
| 最近可见 | `lastSeenAt` 秒级时间戳 → `toLocaleString` |
| 最近同步 | `syncedAt`（空显「—」） |

**筛选**（客户端 `computed`）：群名 `includes`（trim + 忽略大小写）与放行状态精确匹配的交集；空结果用 `el-table` `empty-text`。

**交互**：
- `onMounted` 拉列表；`loading` 态盖表格；`ApiError` 用 `ElMessage.error`。
- 「立即同步群」：`syncing=true` → `syncGroupsNow()` → 成功 `ElMessage.success('已同步 N 个群，放行 M 个')` 并 `fetchGroups()` 重拉；失败 `ElMessage.error(error)`；`finally` 复位 `syncing`。

> 异步风格遵守 CLAUDE.md：优先 Promise 链 `.then().catch().finally()`；仅当多步顺序依赖时用 `async/await`。

## 5. 测试

**后端（vitest，内存库 / 注桩）**：在 `server/src/sync/syncService.test.ts` 补 `syncGroupsNow`：
- 注桩 `createClient.listSessions` + 注入 `groupSync` → 返回 `{ ok:true, total, allowed }` 且计数正确。
- 未配 `groupSync` → `{ ok:false }`。
- `listSessions` 抛错 → `{ ok:false, error }`，不抛到上层。
- `groupSyncing` 自旋锁：并发第二次调用被拒。

路由层（若有现成路由测试基建则补）：`GET /api/weflow/groups` 返回 `listAll`、`POST .../sync` 透传结果。

**前端**：`web/` 无单测框架，**不新引入**；靠 `npm run lint` + 构建 + 手动验收。

## 6. 验收（verification-before-completion）

1. 根 `npm run lint` 零报错（无分号 / 单引号 / Promise 链）。
2. `npm -w shared run build` + server `npm test`（vitest）全绿、server `npm run build` 通过。
3. 手动：起服务 → 访问 `/weflow/groups` → 列表可见、搜群名、切放行筛选、点「立即同步群」看 toast 与列表刷新。

## 7. 实现顺序

1. shared 类型 `WeflowGroup` + build。
2. `SyncService.syncGroupsNow()` + 测试（TDD 先红后绿）。
3. `routes/groups.ts` + `index.ts` 注册。
4. `web/src/api/groups.ts`。
5. `GroupsPage.vue` 页面 + 筛选 + 按钮。
6. lint / build / test / 手动验收。

## 8. 未尽事项

- 头像列：`avatarUrl` 当前 `upsertSeen` 未写入（恒 null），本期表里留位、前端暂不渲染头像，待上游补充会话头像后再加。
- 分页：群数量小，本期不做分页；若将来群数膨胀再加服务端分页。
- 同步状态筛选：本期未纳入（用户只要群名+放行两维），有需要再加。
