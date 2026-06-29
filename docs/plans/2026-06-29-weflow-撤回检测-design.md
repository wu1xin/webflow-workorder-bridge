# WeFlow 消息撤回检测设计

> 日期：2026-06-29　范围：检测「已转发消息被对方撤回」，并入队一条 `message.revoke` 事件交下游处理。
> 本设计**取代**[2026-06-27 实时入库设计](2026-06-27-weflow-sse-实时入库-design.md) §2 中「撤回暂不实现」的非目标。

## 1. 背景与现状

一条消息经 SSE 触发 → REST 回查 → 入 `queue`（见上一篇实时入库设计）。但对方撤回后，同一 `serverId` 的那行在 `/api/v1/messages` 里被**原地改写**：`localType` 翻成 `10000`、`content` 变成 `<sysmsg type="revokemsg">`、`senderUsername` 变 `null`，而 `localId/serverId/createTime/sortSeq` 全不变。原文就此消失，桥接侧却已把原消息入队、（将来）转发给下游。

现状两个硬障碍，导致撤回完全发现不了：

1. **SSE 不推撤回（实测）**：文档 [http-api.md](../../docs/http-api.md) §2 虽列了 `message.revoke` 事件，但实测对方撤回时 SSE 流里**并不出现**该事件（需逐群主动配置且覆盖不可靠）。只能靠轮询 `/api/v1/messages` 对账才能察觉。
2. **去重挡住回查**：[ingestOne](../../server/src/sync/syncService.ts) 以 `serverId` 为去重键。撤回行 `serverId` 不变，重新回查时会被当成重复直接 skip——撤回态永远进不来。

## 2. 目标与非目标

**目标**：在对方可撤回的时限内，对账发现「已入队消息被撤回」，并入队一条 `eventType='message.revoke'`、`externalId=被撤消息 serverId`、`conversationId=talker` 的事件（`ingest_path='reconcile'`），保证每条撤回**只入队一次**。重启自愈，不依赖内存定时器。

**非目标**：
- **不回收/不改写原 `message.new` 队列行**。撤回是独立事件，下游 forwarder 接入后自行决定如何处理（撤回未发的 / 补发撤回通知）。本设计只负责「可靠地产出撤回事件」。
- **不解析撤回文案里的操作人**。`<revokemsg><content>"X" 撤回了一条消息</content>` 的展示文案随原始 blob 入队即可，不在桥接侧结构化。
- **不监听 SSE `message.revoke`**：实测不可靠，不投入。

## 3. 撤回模型

### 3.1 双撤回窗口（按消息类型）

| 类型 | 可撤回时限 |
| --- | --- |
| 普通消息（文字/语音/图片/短视频/链接/表情） | **2 分钟** |
| 文件消息（PDF/Word/Excel/压缩包等文档） | **3 小时** |

窗口差两个量级，决定了「内存延迟定时器」不可行（3h 内进程大概率重启，待办全丢），必须把复查的截止时间**持久化**，靠周期对账扫描覆盖。

### 3.2 `localType` 是打包整数

实测文件消息 `localType = 25769803825 = 0x6_00000031 = (6 << 32) | 49`：低 32 位 `49` 是 appmsg 基础类型，高 32 位 `6` 是 appmsg XML 内的 `<type>6</type>`（文件）。普通消息未打包：文字 `1`、图片 `3`、语音 `34`、短视频 `43`、表情 `47`、系统 `10000`。

```
low = localType % 2**32              // 基础类型
sub = Math.floor(localType / 2**32)  // appmsg 子类型（非 appmsg 为 0）
```

数值 `< 2^53`，普通 `Number` 运算安全。系统消息恒为未打包小整数 `10000`，不会与文件大整数相撞。

## 4. 核心检测 + 绕开去重陷阱

> 实现收敛说明：把「撤回发射」收敛到对账扫描这一处（见 §5），`ingestOne` 只负责**跳过撤回行**。
> 这样撤回事件天然只对「我们看守过（即活着时入过库）的消息」产出，零历史孤儿撤回，也不必给 dedup 加 `has` 查询。

**撤回行识别**（纯函数 `isRevokeRow`，落在 [revoke.ts](../../server/src/sync/revoke.ts)）：

```
isRevoke = (localType === 10000) && /<sysmsg[^>]*type=["']revokemsg/.test(rawContent ?? content)
```

命中即知：该行 `serverId` 对应的消息被撤回（原地改写，`serverId` 即被撤消息 id）。

**绕开去重陷阱**：现有 ingestOne 是「`serverId` 命中 dedup → skip」。撤回行 `serverId` 与原消息相同，若放任会有两种坏结果：要么被当重复 skip（撤回信息丢失），要么在从未见过该 serverId 时（全量拉到历史撤回）被**当普通 message.new 入队**。改造为：

- **`ingestOne` 先认撤回行 → 直接 skip**（撤回 sysmsg 不是新消息，不入队、不计数）。撤回事件的产出不在这里，交给对账扫描。
- 非撤回行 → 维持现有 normalize → dedup(`serverId`) → enqueue，并补一步「算 `revocable_until`」（见 §5.1）。

**撤回事件的唯一发射点 = 对账扫描的 `emitRevoke`**：对一条**看守中**的 serverId 探到其已翻撤回态时，用**独立去重键** `revoke:<serverId>` 走 `markIfNew`——首次才入队 `message.revoke`（externalId=serverId、conversationId=talker、ingest_path=`reconcile`、rawJson=该撤回行原文），随后无论入队与否都 `clearRevokeWatch` 清看守停止再探。该键与原消息的 `<serverId>` 键互不干扰，多轮扫描天然幂等。

## 5. 覆盖机制：`revocable_until` + 周期对账扫描

### 5.1 记账（入队时）

给「新入队的普通用户消息」算撤回截止并落库（queue 新增可空列 `revocable_until`）：

```
window = isFile ? 3h : 2min
revocable_until = msg_timestamp + window + grace      // grace ≈ 30s，防时钟偏移/落库延迟
若 revocable_until <= now（全量/补偿拉到的老历史）→ 存 null（不进扫描）
```

文件判定（§3.2 + 解析 rawContent 双保险）：

```
isFile = (low === 49 && sub === 6) && /<appattach>[\s\S]*?<fileext>/.test(rawContent)
```

链接 appmsg（`<type>5</type>`）等一律归 2min 桶。判不准时落 2min——宁可漏极少数迟到文件撤回，也不把每条都盯 3h。系统消息、撤回事件本身存 `null`，不参与扫描。

### 5.2 扫描（周期 ~30s 一轮 `reconcileRevokes()`）

1. `listOpenRevokeWatches`：`WHERE channel_id=? AND revocable_until > now` → 只取「还有消息在撤回窗口内」的看守行，按 talker 分组；无看守则**零 REST** 直接返回。空闲群零成本。
2. 对每个 talker 复查（单 talker 失败仅记日志、不影响其它）。复查用**两种查询形态**（两窗口量级差太大），只对「看守中的 serverId」判撤回态：
   - **近窗粗拉**：`fetchMessagesPage(talker, start = now-(2min+grace))` 拉最近一小段——把所有普通消息的撤回一网打尽，页很小。
   - **文件定向探针**：对仍在 3h 窗口、且 createTime 已早于近窗的看守，逐条 `fetchMessagesPage(talker, start≈end≈该消息 createTime)` 精确探一行（`end` 参数），看 `serverId` 是否翻成撤回态。文件少 → 探针少，避免「为一条文件每轮重拉 3h」。
3. 命中撤回 → `emitRevoke`（§4）入队 `message.revoke` + 清看守。窗口过期未撤的，靠 `> now` 自然滑出，无需主动清理。

扫描间隔 `RECONCILE_INTERVAL_SEC=30s`，远小于普通消息 2min 窗口，过点后还能扫到几轮兜底；检测延迟上界 ≈ 间隔。`startReconcileLoop/stopReconcileLoop` 由顶层 [index.ts](../../server/src/index.ts) 装配（`listen` 后启动）。

### 5.3 重启自愈

截止时间在库里。重启后第一轮扫描即捞起所有 `revocable_until > now` 的消息继续盯，无内存状态依赖。

### 5.4 与补偿/全量同步的关系

全量/补偿拉到的撤回行被 `ingestOne` 统一 skip（不入队、不产撤回事件），因此**不会**为历史撤回产生孤儿事件。撤回检测完全由 `revocable_until` 看守 + 周期扫描兜底——看守持久化在库，重启/重连后照样接着扫，无需依赖「群里恰好又有人说话」或「恰好断线重连」。

## 6. 改动清单

| 文件 | 改动 |
| --- | --- |
| [db/schema.ts](../../server/src/db/schema.ts) | queue 加可空列 `revocable_until INTEGER`；加部分索引 `WHERE revocable_until IS NOT NULL` 供扫描查询 |
| [db/queue.ts](../../server/src/db/queue.ts) | `EnqueueInput` 增 `revocableUntil: number \| null`；insert 写入；新增 `listOpenRevokeWatches(channelId, now)`（返回待盯消息的 talker/serverId/msgTimestamp/是否文件）与 `clearRevokeWatch(channelId, serverId)` |
| [db/dedup.ts](../../server/src/db/dedup.ts) | **不改**：撤回事件复用 `markIfNew`，键 `revoke:<serverId>` |
| [weflow/restClient.ts](../../server/src/weflow/restClient.ts) | `fetchMessagesPage` 加可选 `end` 参数（文件定向探针用）；`WeflowMessage.localType` 已是 `number`，容纳打包大整数无需改 |
| [sync/revoke.ts](../../server/src/sync/revoke.ts) | **新模块**（纯函数，便于单测）：`isRevokeRow`、`isFileMessage`、`computeRevocableUntil`、`NEAR_REVOKE_WINDOW_SEC`。撤回识别独立于 `systemMessage.ts`（后者仍专注群改名等系统事件解析） |
| [sync/syncService.ts](../../server/src/sync/syncService.ts) | `ingestOne` 改造（先 skip 撤回行；非撤回行算 `revocableUntil` 落库）；新增 `reconcileRevokes()`/`reconcileTalker`/`emitRevoke` 对账扫描 + `startReconcileLoop`/`stopReconcileLoop`；`WeflowClientLike.fetchMessagesPage` 加 `end?` 参数 |
| [index.ts](../../server/src/index.ts) | `listen` 后 `sync.startReconcileLoop()` 启动周期扫描 |
| [@wb/shared 类型](../../shared/src/types/weflow-message.ts) | `WeflowIngestPath` 增 `'reconcile'`；`EnqueueInput.ingestPath` 随之放宽 |

## 7. 边界与权衡

- **grace 与扫描间隔**：撤回可能在截止点附近才出现在 v1/messages，故 `revocable_until` 多留 grace，且扫描间隔（~60s）远小于 2min 窗口，确保过点后至少还扫到 1~2 轮。检测延迟上界 ≈ 扫描间隔，秒级延迟对「撤回」语义完全够用。
- **文件误判**：判不准只影响「是否盯满 3h」，不影响普通消息（2min 必覆盖）。可后续按真实文件样本补全 `isFileMessage` 规则。
- **扫描成本**：仅扫「窗口内有消息」的活跃群；普通群一般只在最近 2min 被盯，文件用定向探针。busy 群里挂着老文件 watch 时，定向探针避免了重拉大窗口。
- **撤回行也是放行群才入队**：检测发生在已放行群的回查/扫描里；非放行群连 REST 都不发，不会产出撤回事件。
- **媒体撤回**：图片/视频等富媒体撤回与普通消息同走 2min 桶，检测逻辑一致（只认 `serverId` 翻 10000），不涉及媒体本身。

## 8. 测试点（已落地，全绿）

[revoke.test.ts](../../server/src/sync/revoke.test.ts) 纯函数 + [syncService.test.ts](../../server/src/sync/syncService.test.ts) 注入式桩（`createClient` 注 REST 桩 + 内存 db）+ [schema.test.ts](../../server/src/db/schema.test.ts)/[queue.test.ts](../../server/src/db/queue.test.ts)/[restClient.test.ts](../../server/src/weflow/restClient.test.ts)：

1. **纯函数**：`isRevokeRow`（10000+revokemsg → true；普通/文件大整数 → false；群改名 → false）；`isFileMessage`（PDF 打包 localType+`<fileext>` → true；图片 3/表情 47/文字 1/链接 type5 → false）；`computeRevocableUntil`（文件 +3h、普通 +2min、已过期/系统消息/缺 createTime → null）。
2. **schema/queue**：v3→v4 升级补 `revocable_until` 且保留数据；`enqueue` 落库；`listOpenRevokeWatches` 只返回 `> now` 且 channel 隔离；`clearRevokeWatch` 置 null。
3. **`reconcileRevokes` 行为**：看守中消息变撤回态 → 入队 `message.revoke(reconcile)` + 清看守；重复对账只入队一次；未撤回则不产出、看守保留；无看守零 REST。
4. **文件定向探针**：文件消息超出近窗仍在 3h 内 → 带 `end` 的探针精确探到撤回。
5. **ingestOne 跳过撤回行**：回查到从未见过 serverId 的撤回 sysmsg → 不被当普通消息入队（零孤儿）。
6. **restClient**：`fetchMessagesPage` 传 `end` 时 URL 带 `end`，不传则不带。
