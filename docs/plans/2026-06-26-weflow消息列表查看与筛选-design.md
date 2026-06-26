# WeFlow 消息列表查看与筛选 设计文档

> 编写日期：2026-06-26
> 关联：`docs/plans/2026-06-26-weflow群组列表查看与筛选-design.md`（同型只读列表，群组侧）、`docs/plans/2026-06-23-multi-upstream-schema-design.md`（queue 表 schema）

## 1. 背景与目标

同步服务已把归一化消息以 `pending` 入 `queue` 表，但没有任何接口把消息暴露给前端，`web/src/pages/weflow/MessagesPage.vue` 仍是 `el-empty` 占位。

本期打通前后端，实现 **WeFlow 消息列表的查看 + 简单筛选**：

1. 后端新增**服务端分页 + 过滤**的列表接口，及单条详情接口。
2. 前端 `el-table` + `el-pagination` 渲染，支持四维筛选（会话/群、状态、是否含媒体、采集路径）。
3. 行内「详情」弹窗查看原始包 `raw_json`。

### 1.1 范围与决策

| 决策点 | 结论 |
|--------|------|
| 数据源 | `queue` 表（归一化入队的转发消息） |
| 筛选维度 | 会话/群（conversationId）、状态（status）、是否含媒体（has_media）、采集路径（ingest_path） |
| 分页/规模 | **服务端分页 + 服务端过滤**：queue 随同步增长，不全量下发前端（与群组侧「小表全量+前端筛」不同） |
| 列表负载 | 列表行**不含 `raw_json`**（大 blob 不批量下发）；单独详情接口才返回 |
| 详情 | 行内「详情」弹窗 pretty-print `raw_json` |
| 会话筛选源 | 前端会话下拉复用 `chat_group` 群列表（群名→conversationId） |
| channel 范围 | 单实例 `WEFLOW_CHANNEL_ID` |

## 2. 后端

### 2.1 `QueueStore` 新增方法 —— `server/src/db/queue.ts`

```
list(channelId, filter, limit, offset): { items: QueueMessageSummary[], total: number }
getById(channelId, id): QueueMessageDetail | null
```

- `filter = { conversationId?, status?, hasMedia?(0|1), ingestPath? }`，全部可选。
- **可选过滤惯用法**：单条预编译语句覆盖所有组合，避免动态拼 SQL。

```sql
SELECT id, conversation_id, sender_id, event_type, msg_timestamp, has_media,
       status, ingest_path, attempts, last_error, created_at
FROM queue
WHERE channel_id = @channelId
  AND (@conversationId IS NULL OR conversation_id = @conversationId)
  AND (@status         IS NULL OR status          = @status)
  AND (@hasMedia       IS NULL OR has_media        = @hasMedia)
  AND (@ingestPath     IS NULL OR ingest_path      = @ingestPath)
ORDER BY id DESC
LIMIT @limit OFFSET @offset
```

- 另一条同 WHERE 的 `COUNT(*)` 取 `total`。缺省过滤绑 `null`。
- `ORDER BY id DESC`：最新入队在前。
- `getById`：`SELECT *`（含 `raw_json/media_json`）按 `channel_id + id`；不存在返回 `null`。
- 行的 `has_media INTEGER` → 映射成 `hasMedia: boolean`。

### 2.2 路由 —— 新增 `server/src/routes/messages.ts`

`index.ts` 中 `registerMessageRoutes(app, ctx)` 注册。

```
GET /api/weflow/messages?conversationId=&status=&hasMedia=&ingestPath=&page=&pageSize=
       → { items: QueueMessageSummary[], total, page, pageSize }
GET /api/weflow/messages/:id
       → QueueMessageDetail（不存在 → 404）
```

- 参数校验：`page>=1`（默认 1）、`pageSize` 1~100（默认 20）、`status∈{pending,sending,done,dead}`、`ingestPath∈{sse,catchup}`、`hasMedia∈{0,1}`。非法 → 400。
- `offset = (page-1) * pageSize`；缺省过滤项不传则视为「不过滤」（null）。
- `:id` 非数字 → 400；查不到 → 404。

## 3. 共享类型 —— `@wb/shared/types`

新增 `shared/src/types/weflow-message.ts`，barrel re-export：

```ts
export type WeflowMessageStatus = 'pending' | 'sending' | 'done' | 'dead'
export type WeflowIngestPath = 'sse' | 'catchup'

/** 列表行（不含 rawJson） */
export interface WeflowMessageSummary {
    id: number
    conversationId: string | null
    senderId: string | null
    eventType: string
    msgTimestamp: number | null
    hasMedia: boolean
    status: WeflowMessageStatus
    ingestPath: WeflowIngestPath
    attempts: number
    lastError: string | null
    createdAt: number
}

/** 详情（含原始包） */
export interface WeflowMessageDetail extends WeflowMessageSummary {
    rawJson: string
    mediaJson: string | null
}

/** 分页响应 */
export interface WeflowMessagePage {
    items: WeflowMessageSummary[]
    total: number
    page: number
    pageSize: number
}
```

> 改完 shared 需 `npm -w shared run build` 更新 `dist`。

## 4. 前端

### 4.1 API —— 新增 `web/src/api/messages.ts`

```ts
interface MessageQuery {
    conversationId?: string
    status?: WeflowMessageStatus
    hasMedia?: 0 | 1
    ingestPath?: WeflowIngestPath
    page: number
    pageSize: number
}
fetchMessages(q: MessageQuery): Promise<WeflowMessagePage>   // 拼 query string，空值不带
fetchMessageDetail(id: number): Promise<WeflowMessageDetail>
```

### 4.2 页面 —— 改写 `web/src/pages/weflow/MessagesPage.vue`

`<script setup lang="ts">` + Composition API。

**工具栏**：
- 会话/群 `el-select`（复用 `fetchGroups()` 填充，选项 = 群名→conversationId，含「全部」）
- 状态 `el-select`（全部 / pending / sending / done / dead）
- 含媒体 `el-select`（全部 / 含媒体 / 纯文本）
- 采集路径 `el-select`（全部 / sse / catchup）
- 刷新 `el-button`

**`el-table` 列**：会话（显示群名，查不到回退 conversationId）、发送者、类型、消息时间（`toLocaleString`）、媒体（`el-tag`）、状态（`el-tag`：pending warning / sending primary / done success / dead danger）、采集路径、重试次数、操作（「详情」按钮）。

**`el-pagination`**：`layout="total, sizes, prev, pager, next"`，`total` 来自后端；翻页 / 改页大小 → 重新 `fetchMessages`。

**服务端筛选**：任一筛选 `watch` 变更 → 重置 `page=1` → 重新请求（非前端 computed）。

**详情弹窗** `el-dialog`：点「详情」→ `fetchMessageDetail(id)` → `<pre>` 显示 `JSON.stringify(JSON.parse(rawJson), null, 2)`（解析失败原样显示）；附 `mediaJson` 展示。

**群名映射**：`fetchGroups()` 结果建 `Map<conversationId, groupName>`，供表格与下拉共用；`onMounted` 先拉群再拉消息。

**异步风格**：遵守 CLAUDE.md，优先 Promise 链 `.then().catch().finally()`。

## 5. 测试

**后端（vitest 内存库）**——扩展 `server/src/db/queue.test.ts`：
- `list` 分页：seed N 条 → `items` 按 `id DESC`、`total` 正确、`limit/offset` 切片对。
- `list` 过滤：`status`（测试里 `UPDATE` 制造非 pending）、`conversationId`、`hasMedia`、`ingestPath` 各自收窄；多条件交集。
- `list` 无过滤：返回当页全部。
- `getById`：命中返回含 `rawJson` 完整行；不存在 / 跨 channel → `null`。

路由层与前端：无单测基建，**不新建/不新引入**；靠 vue-tsc + 构建 + curl 冒烟 + 手验。

## 6. 验收（verification-before-completion）

1. 根 `npm run lint` 零报错。
2. `npm -w shared run build`、server `npm run build`、`npm -w web run build` + `npm -w web run type-check` 全过。
3. server `npm test`（vitest）全绿，含新增 queue 用例。
4. curl 冒烟：`GET /api/weflow/messages` 空库 → `{items:[],total:0,...}`；非法参数 → 400；`GET /messages/:id` 不存在 → 404。
5. 手验（需真实消息）：翻页、四维筛选、详情弹窗。

## 7. 实现顺序

1. shared 类型 `WeflowMessage*` + build。
2. `QueueStore.list/getById` + 测试（TDD 先红后绿）。
3. `routes/messages.ts` + `index.ts` 注册。
4. `web/src/api/messages.ts`。
5. `MessagesPage.vue`。
6. lint / build / test / curl 冒烟 / 手验。

## 8. 未尽事项

- 时间范围 / 关键字筛选：本期不做（用户只要四维），需要再加。
- 媒体预览：详情仅展示 `mediaJson` 文本，不做媒体渲染（forwarder/媒体处理未接入）。
- 排序切换：固定 `id DESC`，本期不开放列排序。
