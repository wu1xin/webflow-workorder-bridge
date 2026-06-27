# WeFlow SSE 实时入库设计

> 日期：2026-06-27　范围：补齐设计文档 §「实时流」——把 WeFlow SSE 推来的新消息实时落库到 queue。

## 1. 背景与现状

当前 [sseClient.ts](../../server/src/weflow/sseClient.ts) 只做 SSE 协议层（建链、解帧、读超时探活），解出的 `event` 事件除被 gate 的 `waitForFirstMessage` 一次性用于「首消息判定」外，**无人消费**：

- [connectionManager.onConnected()](../../server/src/weflow/connectionManager.ts) 仅监听 `close`/`timeout`/`error`，**未监听 `event`**；
- 实际落库只有「REST 拉取同步」一条线（[SyncService](../../server/src/sync/syncService.ts) 的全量/补偿），且**只在连上的瞬间触发一次**。

后果：连接保持期间 WeFlow 新推的消息被静默丢弃，要等下次断线重连的补偿同步才补回；长期不断线则不入库。设计文档规划的「实时流」(`SSE事件 → 解帧 → dedup → 入 queue`) 尚未实现。

## 2. 目标与非目标

**目标**：连接保持期间，SSE 推来的 `message.new` 实时落库到 `queue`（`ingest_path='sse'`），与补偿流共用去重表与落库逻辑。

**非目标**：
- **撤回 `message.revoke` 暂不实现**。实测 WeFlow 端需对群逐个主动配置才能监听撤回，新建群无法实时配置、覆盖不可靠（见记忆 `weflow-sse-revoke-constraint`）。
- **媒体两步上传**不在本次范围。SSE 负载不含媒体详情（`content` 仅 `"[图片]"` 占位），且现有 REST 客户端尚未带 `media=1`；媒体统一留待媒体模块落地，实时流与补偿流此刻保持一致（不强拉媒体导出）。

## 3. 核心架构：SSE 当触发器，回查 REST

SSE 负载字段（`sessionId/rawid/content/timestamp/sessionType/sourceName/groupName`）与 REST `messages` 的 `WeflowMessage`（`serverId/createTime/senderUsername/…`）**形状不同**，现有 [adapter.normalize()](../../server/src/weflow/adapter.ts) 只吃 REST 形状。因此采用：

**SSE 只提供「哪个群、什么时候、有新消息」三个信号，真正内容仍由 REST 拉、走与补偿流同一条落库逻辑。**

```
client.on('event', evt)
  → JSON.parse(evt.data)            宽松解析，失败/缺字段 → debug 跳过（FR-RECV-04）
  → evt.event !== 'message.new' ?   → 忽略（撤回等暂不实现，仅 debug 日志）
  → 取 sessionId(=talker) / timestamp
  → 非放行群 isPushAllowed ?         → skip（连 REST 都不发）
  → 定向回查 fetchMessagesPage(talker, start=timestamp) 分页
  → 复用落库核 ingestOne：normalize → dedup(rawid) → queue.enqueue(ingest_path='sse')
```

**为何 new 走回查而非直接解析 SSE 入库**：回查 REST 才能拿到 `senderUsername` 等完整字段，并与补偿流共用同一条 `ingestOne`，避免两套归一化/落库逻辑漂移。代价仅为每事件一次本机 loopback REST 往返。

## 4. 并发、隔离与水位

- **进度隔离**：实时入库**不触碰** `SyncService.progress` 的 `running` 锁（那是全量/补偿进度条用）。全量/补偿在跑时实时可并行——better-sqlite3 写同步、dedup 兜底，重叠拉取只会被去重，不会重复入队。
- **每会话合并**（防 REST 风暴）：活跃群短时连发多条 `message.new` 不应各起一次完整分页回查。维护 `Map<talker, { running, pendingStart }>`：
  - 无在途 → 立即拉（`start=ts`）；
  - 已有在途 → 仅 `pendingStart = min(pendingStart, ts)`，不另起；
  - 一轮拉完后若 `pendingStart` 有值 → 再补拉一次。
  - 每 talker 最多「1 在途 + 1 排队」，不同 talker 天然并行。`start` 偏早只是多拉几条被去重，绝不漏。
- **不推进补偿水位**：实时入库**不**调 `advanceWatermark`。更简单也更稳——万一某条 SSE 漏投，水位没被它带过，下次重连补偿仍会从旧水位较宽回拉、靠 dedup 补回；代价仅是重连多拉一段（被去重，且有 24h 回溯上限兜底）。水位仍由每次(重)连触发的补偿/全量推进。
- **回查失败**：仅 `log.error`，不发告警（避免活跃群刷屏）。
- **首消息不丢**：gate 第③步的 `waitForFirstMessage` 会「吃掉」首条 event，但连上即触发的全量/补偿同步会把该消息一并回拉，实时流从第 2 条起接管——无缺口。

## 5. 改动清单

| 文件 | 改动 |
| --- | --- |
| [hooks.ts](../../server/src/weflow/hooks.ts) | `SyncCoordinator` 增 `onSseEvent(evt: SseEvent): void`；日志桩补 debug 实现 |
| [connectionManager.ts](../../server/src/weflow/connectionManager.ts) | `onConnected()` 加 `client.on('event', evt => this.sync.onSseEvent(evt))`；清理依赖现有 `teardown()` |
| [syncService.ts](../../server/src/sync/syncService.ts) | 抽 `ingestOne(talker,msg,now,ingestPath)` 共享落库核；`processMessage` 改为包装它（补偿/全量行为不变）；新增 `onSseEvent` + 每会话合并调度 + `pullRealtime`；导出纯函数 `parseRealtimeTrigger` 便于单测 |
| [adapter.ts](../../server/src/weflow/adapter.ts) | **不动**（REST 回查语义即 `message.new`，`dedupKey`=rawid 维持） |

## 6. 测试点

复用 [syncService.test.ts](../../server/src/sync/syncService.test.ts) 的注入式桩（`createClient` 注 REST 桩 + 内存 db）：

1. **纯函数 `parseRealtimeTrigger`**：合法 `message.new` → `{talker, ts}`；`message.revoke`/其它 → `null`；坏 JSON → `null`；缺 `sessionId`/`timestamp` → `null`。
2. **`onSseEvent` 行为**：放行群 `message.new` → 一次 `fetchMessagesPage` → 入队且 `ingest_path='sse'`；非放行群 → 零 REST、零入队；非 `message.new`/坏 JSON → 忽略不抛；跨路径去重（同 rawid 已被补偿入队 → 实时命中 dedup 不重复入队）。
3. **进度隔离**：实时入库后 `getStatus().running` 仍 `false`。
4. **每会话合并**（轻量，可选）：可控延迟 REST 桩，talker 在途时再来同 talker 事件 → 总拉取 2 次而非 N。
