# 下游 work-order-system 对接（forwarder 核心闭环）设计

> 日期：2026-07-03
> 分支：`rewrite/v2`
> 背景：上游 WeFlow 侧已基本对接完成（SSE 接入 + 三级连接闸门 + 全量/补偿/撤回对账落库到 `queue`(pending) + 群白名单闸门）。本设计定义**下游对接的核心转发闭环**：消费 `queue` 里的 pending 消息，发往下游 `receiveMessage`，按 `code==1` 判定成功，含重试/退避/熔断/死信与断点推进。
>
> 配套文档：
> - 需求与架构：[2026-06-17-weflow-bridge-v2-需求与架构设计.md](2026-06-17-weflow-bridge-v2-需求与架构设计.md)（§3 模块、§9 FR、§11 错误码）
> - 下游契约：[docs/weflow-对接接口规格说明书（work-order-system侧）.md](../weflow-对接接口规格说明书（work-order-system侧）.md)（§2.4 ACK、§2.6 错误码、§4.3 receiveMessage、§4.1 ping）
> - 多上游 schema：[2026-06-23-multi-upstream-schema-design.md](2026-06-23-multi-upstream-schema-design.md)
> - 群同步（前置，白名单闸门）：[2026-06-25-群聊表与下游群同步-impl.md](2026-06-25-群聊表与下游群同步-impl.md)
>
> **代码风格强约束（CLAUDE.md）**：无分号、单引号；异步优先 Promise 链，仅当封装函数内多异步操作有顺序依赖时才用 async/await（HTTP `fetch→json` 属顺序依赖，可用 async/await）。每个任务完成 `npm run lint` 必须通过。

---

## 1. 范围

**本期（核心闭环）**：queue worker + `receiveMessage` + ACK(`code==1`) 判定 + 重试/退避/**熔断** + 死信（最小档）+ 断点推进（投递标记）+ 下游配置面（简单档）+ `ping` 测连 + 审计/告警/状态快照。

**下期（紧接着，不在本设计落地）**：媒体两步式上传（`uploadMedia` + 从 WeFlow 取回/回查补齐 + `media_cache` 幂等 + 信封带 `file`）、心跳 `heartbeat`、死信批量重投/导出/独立 UI。

---

## 2. 现状与缺口

| 维度 | 现状 | 缺口（本期补） |
|------|------|----------------|
| 上游接入 | SSE + 三级闸门 + 重连 ✅ | — |
| 落库 | `SyncService` 全量/补偿/撤回对账 → `queue`(pending) ✅ | — |
| 群闸门 | `GroupSyncService` + `client.syncGroups` 白名单回写 ✅ | — |
| 下游客户端 | 只有 `syncGroups` | **加 `receiveMessage`、`ping`** |
| 转发消费 | 无，pending 只堆积 | **新增 forwarder（queue worker）** |
| ACK/重试/死信 | 无 | **本期实现** |
| 断点 | 补偿用 `last_sync_timestamp`（入库水位） | **加投递水位 `breakpoint_timestamp`** |
| 配置 | `downstream` 手改 config.json | **简单档：校验 + PUT + 前端分组 + ping 按钮** |
| 审计/告警/状态 | 部分就位 | **补 forwarder 结果审计 + dlq/熔断告警 + 状态字段** |

---

## 3. 关键决策摘要

| # | 决策 | 理由 |
|---|------|------|
| D1 | **核心闭环优先**：媒体两步上传、心跳留下期 | 文本转发是打通下游的关键路径；媒体因「导出就绪时延/回查」另有复杂度，拆开更稳 |
| D2 | **配置简单档**：后端 config.json + 校验 + PUT，前端复用配置页加「下游」分组 + ping 按钮，不做重表单 | 内部工具优先简单；密钥线下交付、明文落盘、不掩码 |
| D3 | **媒体消息留 pending、worker 跳过（`has_media=0`）** | 不阻塞文本、不丢消息；媒体靠持久队列 + 下期补发 |
| D4 | **worker = 入队踢一脚 + 兜底 tick，单 worker 串行** | 实时且不空转，天然保序（对齐 FR-FWD-10 默认），复杂度可控 |
| D5 | **补偿起点保持 `last_sync_timestamp`；`breakpoint_timestamp` 仅作投递标记** | 补偿只补「从没入库」的缺口=入库水位；「入库未转发」由持久队列兜住。媒体跳过让 breakpoint 有空洞、长期滞后，不适合当补偿起点（**修正旧意图**） |
| D6 | **熔断本期纳入**（轻量版） | 下游不可用时避免刷屏重试与打爆下游 |
| D7 | **`1001` 有限重试（2 次）后死信 + 告警** | token 每请求实时生成、`time` 过期能自愈；真配错则几次后死信，不无脑刷 |
| D8 | **死信最小档**：`GET /api/dlq` + `POST /api/dlq/:id/retry` | 够运维恢复；批量/导出/UI 延后 |

---

## 4. 架构与 worker 执行模型

**模块落位**：新增 [server/src/downstream/forwarder.ts](../../server/src/downstream/forwarder.ts)，与 [client.ts](../../server/src/downstream/client.ts) 同目录。forwarder **独立于 SSE 连接**——只要配了下游且转发总开关为开，就持续消费 `queue` 的 pending 文本消息，即便上游断连也照发（清积压），因为队列是持久的。

**协作方**：
- `QueueStore`（[queue.ts](../../server/src/db/queue.ts)）——取件 + 状态机推进（需新增方法，见 §5）；
- `HttpDownstreamClient`——新增 `receiveMessage()`、`ping()`（见 §8）；
- `ChannelStateStore`——`code==1` 时推进 `breakpoint_timestamp`（见 §7）；
- `AuditStore`（新增）、`AlertChannel`（复用 [hooks.ts](../../server/src/weflow/hooks.ts)）。

**执行模型（选型）**：

| 方案 | 说明 | 取舍 |
|---|---|---|
| A 纯定时轮询 | `setInterval` 每 N 秒扫 pending | 简单，但空转 + 延迟高 |
| **B 入队踢一脚 + 安全兜底 tick（选定）** | 入队/重连/配置变更时 `kick()` 唤醒；worker 排空后休眠；另有低频 tick 复查到期重试项与熔断半开 | 实时 + 不空转 |
| C 并发多 worker + 按会话保序 | 分区并发 | 内部工具量级过度设计 |

**单 worker 串行**：取件 `WHERE channel_id=? AND status='pending' AND has_media=0 AND (next_attempt_at IS NULL OR next_attempt_at<=now) ORDER BY id LIMIT 1`，逐条 await ACK 再取下条 → 天然保序。

**崩溃恢复**：启动时 `resetStuck` 把残留 `sending` 行重置回 `pending`（下游幂等，重发命中 `duplicate=true` 即成功）。

**转发总开关**：运行期经 `POST /api/control/forwarding`（启/停）切换 worker；停时 worker 休眠、不取件。

---

## 5. worker 状态机与数据流

**队列生命周期**：`pending → sending → done | dead`。

```
kick()/兜底 tick → 循环：
  claimNext()  ── 取一条 pending 且 has_media=0 且到期的行，原子置 sending
                  （单进程用事务 SELECT→UPDATE 即可）
   ├─ 无 → 休眠，等下次 kick/tick
   └─ 有 → 组信封 {event: event_type, data: JSON.parse(raw_json)}（一期不带 file）
            → client.receiveMessage(envelope)
               ├─ code==1（含 data.duplicate==true）
               │     → markDone + 推进 breakpoint（同事务）+ 写 audit → 立刻取下条（排空）
               ├─ code!=1 且可重试
               │     → markRetry：attempts+1、next_attempt_at=now+退避、回 pending
               │       （attempts≥maxAttempts → markDead + 告警 dlq_new）
               ├─ code!=1 不可重试
               │     → markDead + 告警 dlq_new
               └─ 传输层错误（超时/非200/JSON解析失败）
                     → 视为可重试，同 markRetry（并计熔断连续失败）
```

**要点**：
- **单条失败不停摆**：markRetry/markDead 后继续取下一条 pending；只有熔断打开才整体暂停。
- **媒体跳过的顺序影响**：`has_media=0` 过滤让 worker 跨过媒体行，`breakpoint` 因此可能越过仍 pending 的媒体（接受，见 D3/D5）。
- **撤回事件**：`event_type='message.revoke'` 也是 `has_media=0`，走同一 worker，信封 `{event:'message.revoke', data}`，下游按 `event+rawid` 处理。
- **done 清理**：定时清理 done 行属独立维护任务，本期留最小实现或延后。

**`QueueStore` 需新增方法**（现有只有入队/查询）：
- `claimNext(channelId, now)` → 取件并置 sending（事务原子），返回含 `raw_json`/`event_type`/`msg_timestamp`/`external_id` 的行或 null；
- `markDone(id)` → status='done'；
- `markRetry(id, {failCode, retryable, lastError, nextAttemptAt})` → attempts+1、回 pending；
- `markDead(id, {failCode, retryable, lastError})` → status='dead'；
- `resetStuck(channelId)` → sending 全部回 pending（启动调用）；
- `retryDead(channelId, id)` → dead 回 pending、清 attempts/next_attempt_at（死信最小档用）。

---

## 6. ACK 判定、错误码映射、退避、熔断

**ACK 判定（铁律，契约 §2.4）**：成功 = `HTTP 200 且 body.code===1`。**绝不用 HTTP 状态码判成败**；非 200 / 网络错 / JSON 解析失败一律归**传输层瞬时错误 → 可重试退避**。

**错误码 → 动作**（照搬契约 §2.6 / 设计文档 §11）：

| code | 含义 | 动作 |
|---|---|---|
| `1` | 成功（含 `duplicate=true`） | markDone + 推进断点 |
| `0` | 通用失败 | 退避重试 |
| `1001` | 鉴权失败 | **有限重试（2 次）**，仍失败 → dead + 告警「查 siteKey/aesKey/时钟」 |
| `1002` | 报文解析/缺参/危险类型 | 立即 dead，勿重发 |
| `1003` | 媒体引用无效 | dead（一期无媒体，理论不现） |
| `1004` | 媒体上传失败 | 退避重试（一期无媒体，理论不现） |
| `1005` | 服务端内部错误 | 退避重试 |
| 其它非 1 | 未识别 | 当 `code=0`，缺省可重试 |

**决策优先级**：先认响应 `data.retryable`（下游显式给出以它为准）；没给则查上表。

**退避**：指数 + 上限 + 抖动，`next_attempt_at = now + min(base·2^(attempts-1), cap) + jitter`（默认 base=2s、cap=60s、maxAttempts=3）。可重试耗尽 → dead；不可重试 → 立即 dead（不耗重试次数）。`1001` 单独计有限重试 2 次。

**熔断（轻量版）**：仅针对**下游不可用类**失败（传输错误 + `0/1004/1005`）计连续失败数；≥阈值（默认 5）→ 打开熔断，worker 暂停冷却期（默认 30s）+ 告警 `downstream_circuit_open`；冷却后半开试一条，成功则关闭复位，失败则延长冷却。**内容类错误（`1001/1002/1003`）不触发熔断**（逐条死信的事）。

---

## 7. 断点推进与补偿协同

**两个水位，各司其职**：

| 水位 | 存放 | 谁推进 | 含义 | 用途 |
|---|---|---|---|---|
| `last_sync_timestamp` / `last_sync_rawid` | `channel_state`（已有） | SyncService 入队时 | 入库高水位 | **补偿拉取起点（不变）** |
| `breakpoint_timestamp` / `breakpoint_rawid` | `channel_state`（**schema v4 新增列**） | forwarder `code==1` 时 | 投递高水位 | 下期心跳字段、可观测、积压告警 |

**决策论证（D5，修正旧意图）**：补偿要补的是「SSE 断连期间没接住、从没入库」的消息，其正确起点是**入库高水位** `last_sync_timestamp`；「入库但没转发」的缺口由**持久队列**兜住（重启后 pending 仍在，worker 继续发），不需补偿管。若改用 breakpoint 当补偿起点：媒体跳过让 breakpoint 有空洞、长期滞后 → 每次大范围回拉、靠 dedup+下游幂等空跑去重，浪费且脆弱。故：

- 补偿起点**保持** `last_sync_timestamp`（SyncService 现状不动，24h 回溯上限 + 超限告警照旧）；
- `breakpoint_timestamp` **仅作投递标记**：forwarder 每次 markDone 时**单调前进**（仅当新 `msg_timestamp` 更大才更新；同秒用 `rawid` 兜底），与 markDone 同事务落库。

---

## 8. 下游客户端扩展 + 配置面（简单档）

**客户端扩展**（[client.ts](../../server/src/downstream/client.ts)，复用现成 `buildTaskWhiteToken`）：

- `receiveMessage(envelope)` → POST `/extra_server/weflow/receiveMessage?task_white_token=...`，JSON body `{event, data}`（一期不带 `file`）。**与 `syncGroups` 关键差异：`code!=1` 时不抛错**，把解析后的 `{code, msg, retryable, messageId, duplicate, receivedAt}` **原样返回**给 forwarder 判定。只有**传输层错误**（非 200 / 网络 / JSON 解析失败）才抛（forwarder 当瞬时可重试）。错误信息只带端点路径、不含 token 完整 URL（沿用 syncGroups 脱敏模式）。
- `ping()` → GET/POST `/extra_server/weflow/ping?...`，返回 `{ok, serverTime?, version?, message?}`。

类型（示意）：
```ts
export interface ReceiveEnvelope { event: string; data: unknown; file?: never } // file 下期
export interface ReceiveAck {
  code: number
  msg?: string
  retryable?: boolean
  messageId?: number | string
  duplicate?: boolean
  receivedAt?: number
}
```

**配置类型扩展**（[shared/src/types/config.ts](../../shared/src/types/config.ts)）——`DownstreamConfig` 加可选 `forwarder` 子组（全带默认）：`requestTimeoutMs`(30000)、`maxAttempts`(3)、`backoffBaseMs`(2000)、`backoffCapMs`(60000)、`circuitThreshold`(5)、`circuitCooldownMs`(30000)。转发总开关走运行期控制、不入 config。

**后端配置面**：
- [store.ts](../../server/src/config/store.ts) 加 `saveDownstream(cfg)`：持久化 + 触发**热重配**（重建 `HttpDownstreamClient`、`GroupSyncService`、通知 forwarder 换参）；
- [validate.ts](../../server/src/config/validate.ts) 加下游校验：`baseUrl` 合法 URL（建议 https，契约 §6 强制）、`siteKey`/`aesKey` 非空、`aesKey` ASCII 长度 ≥16、forwarder 数值区间；
- 路由：`PUT /api/config/downstream`（对齐 `PUT /api/config/weflow`）、`POST /api/test/downstream-ping`（走 `client.ping()`）、`POST /api/control/forwarding`（启/停转发）。

**前端（复用现有配置页）**：加「下游 work-order-system」分组——`baseUrl`/`siteKey`/`aesKey` 明文不掩码、forwarder 参数折叠进「高级」、一个**测试连接**按钮（打 downstream-ping 显示 code/server_time/version）、一个**转发开关** toggle。

---

## 9. 审计、告警、状态快照、死信

**审计**：forwarder 每条消息**终态**（done/dead）写一行 `audit`——`code`/`duplicate`/`received_at`/`latency_ms`/`attempts`/`event_type`/`conversation_id`，一期 `is_media=0`、`file_id=null`。
> ⚠️ 依赖：`db/` 下**尚无 `AuditStore`**（audit 表在多上游 schema DDL 里，但无访问层）——实现时先核对 [schema.ts](../../server/src/db/schema.ts) 是否已建 audit 表，未建则补 DDL，并新增 [db/audit.ts](../../server/src/db/audit.ts)。

**告警**（复用 `AlertChannel`/`LogAlertChannel`）：`dlq_new`（消息进死信）、`downstream_circuit_open`（熔断打开），带同类去抖冷却。

**状态快照**（扩 `/api/status`）：`queueBacklog`(pending)、`dlqCount`(dead，`countByStatus` 已有)、`forwardingEnabled`、`circuitState`、`breakpointTimestamp`、`lastForwardAt`、累计 `totalSuccess/totalFail`（audit 聚合）。

**死信（最小档，D8）**：`GET /api/dlq`（列 dead 行，复用已有 `dlq` 视图）+ `POST /api/dlq/:id/retry`（`QueueStore.retryDead`：dead→pending、清 attempts/next_attempt_at）。批量重投/导出/删除/独立 UI 延后。

---

## 10. 测试策略（TDD / vitest）

沿用群同步那期「先写失败测试 → 实现 → 过 → lint → 提交」节奏。

- **forwarder**（注桩 client + 内存 Db）：`code==1`→done+断点前进+audit；`duplicate=true`→视为成功不重发；`0/1005`→退避重试（attempts+1、next_attempt_at 设置、回 pending）；`1002`→立即 dead；`1001`→2 次后 dead+告警；传输错误→重试；耗尽 maxAttempts→dead；`has_media=1`→不取件；启动 `resetStuck`：sending→pending；熔断：连续失败→暂停→半开恢复；断点单调（不回退、同秒 rawid 兜底）；串行保序。
- **QueueStore 新方法**：claimNext 原子性、markRetry/Dead/Done、retryDead、resetStuck。
- **client**：receiveMessage 在 `code!=1` **返回不抛**、传输错误抛、URL 带 token、body 为 `{event,data}`；ping。
- **config**：downstream 校验（URL/aesKey 长度/数值区间）、saveDownstream 保留其它组、热重配。

---

## 11. schema 变更

- `SCHEMA_VERSION` 升 **v4**。
- `channel_state` 增列 `breakpoint_timestamp INTEGER`、`breakpoint_rawid TEXT`（纯新增、`ADD COLUMN` 增量迁移，不破坏 v3 数据，仿 v2→v3）。
- 核对 audit 表是否已随多上游 schema 落地；未落地则本期补建 + 索引。

---

## 12. 依赖与待核对项

- **AuditStore/audit 表**：实现时核对现状（§9 ⚠️）。
- **`ping` 端点**：下游 `Weflow` 控制器 `ping` action 需就绪（契约 §8.2 待下游实现）；未就绪则测连返回明确「下游未实现 ping」。
- **错误码细化**：下游按契约 §2.6 落地 `1001~1005` + `data.retryable`（契约 §8.1 待下游）；未落地时下游对鉴权失败统一返回 `code=0`，本期按「未识别非 1 → code=0 → 可重试」兜底，不误判。
- **Base URL / siteKey / aesKey**：线下交付后写入 config.json / 前端保存。

## 13. 后续（下期）

- 媒体两步式上传：`uploadMedia` + 从 WeFlow 取回（读 `mediaLocalPath` / 回查补齐 `sourceRef`）+ `media_cache` 幂等 + 信封带 `file` + 媒体消息取消 worker 的 `has_media=0` 过滤。
- 心跳 `heartbeat`：周期上报 `breakpointTimestamp`/`queueBacklog`/`dlqCount`/`sseStatus` 等（FR-HB）。
- 死信管理增强：批量重投/导出/删除 + 独立 UI。

---

## 14. 验收标准

1. 配下游（baseUrl/siteKey/aesKey）后，配置页「测试连接」打通下游 `ping`（或明确报「下游未实现」）。
2. 文本消息以信封 `{event,data}` 发 `receiveMessage`，`code==1` 判定成功、markDone、推进 `breakpoint_timestamp`、写 audit。
3. `duplicate=true` 视为成功不重发。
4. `code=0/1005`/传输错误退避重试；`1002` 立即死信；`1001` 2 次后死信 + 告警。
5. 连续下游不可用达阈值 → 熔断打开 + 告警 + worker 暂停；恢复后半开自愈。
6. `has_media=1` 消息不被取件、留 pending（不阻塞文本、不丢）。
7. 崩溃重启后残留 sending 回 pending，续投不丢（下游幂等去重）。
8. 补偿起点仍为 `last_sync_timestamp`（不受 forwarder 影响）。
9. 死信可 `GET /api/dlq` 查看、`POST /api/dlq/:id/retry` 重投。
10. 转发总开关可运行期启/停；状态快照含积压/死信/断点/累计成败。
11. 全量测试 + `npm run lint` + `npm run build` 通过。

---

## 15. 落地记录与实施偏差（2026-07-03）

本期已落地并通过验收（后端 180 单测、lint、完整 build 全绿）。落地时相较本文档 §8/§9 的**有意收敛**，记录如下（本文档 §8/§9 属规划面，以此节为准）：

- **配置面只暴露 3 个 forwarder 调参**：`maxAttempts`/`backoffBaseMs`/`backoffCapMs`（forwarder 每轮 drain 从 `store.getDownstream()` 实读、即时生效）。§8 曾列的 `requestTimeoutMs`/`circuitThreshold`/`circuitCooldownMs` **本期不可配**，用固定默认（请求超时 30s；熔断阈值 5、冷却 30s）——避免上「不生效的空配置」（熔断器在 forwarder 构造时一次性建好，阈值配置化需重启才生效，故本期不放）。
- **状态快照未含 `lastForwardAt`**（§9 提及）：验收 §14.10 不要求，留待需要时补。
- **告警去抖/冷却未实现**（§9 提及）：`LogAlertChannel` 首版逐条记日志；`downstream_circuit_open` 因 drain 在熔断态直接 return 天然每次 open 只报一次、`dlq_new` 与死信数成正比，无刷屏风险。真正的同类去抖随「真实告警渠道」一期再做。
- **`saveDownstream` 未热重建 `GroupSyncService`**：forwarder 侧配置热生效（每轮读 store），但群同步客户端在启动时构造一次；若启动时未配下游、运行期才配，群同步需重启进程才启用（forwarder 不受影响）。属群同步既有范畴，见 §13。
- **`breakpoint_rawid` 已落库但推进只用 `ts > current`**（同秒 rawid 兜底未启用）：断点本期仅作投递标记/可观测（D5），无 correctness 影响；同秒精定位留待下期心跳消费时再启用。

**可选后续小项**（非阻塞）：`validateDownstreamUpdate` 增 `backoffCapMs >= backoffBaseMs` 交叉校验；如需运行期调熔断阈值/超时，再把这几项接入配置并让 forwarder 惰性重建熔断器。
