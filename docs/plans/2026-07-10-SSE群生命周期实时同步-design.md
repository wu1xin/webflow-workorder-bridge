# SSE 群生命周期实时同步 设计文档

> 编写日期：2026-07-10
> 关联：
> - `docs/plans/2026-06-25-群聊表与下游群同步-design.md`（群聊表 + 下游 `syncGroups` 契约、§7 预留 SSE 增量）
> - `docs/weflow-群组放行同步接口对接文档.md`（下游放行同步契约、§6.1 调用时机）
> - `server/src/sync/syncService.ts`（实时入库 `ingestRealtime` / 落库核 `ingestOne` / 改名旁路 `onGroupRenamed`）
> - `server/src/sync/systemMessage.ts`（REST 系统消息 localType 解析）

## 1. 背景与目标

WeFlow SSE 保活期间会推来 `message.new` 事件。其中两类事件意味着**群聊集合或群名发生变化**，需要重新向下游 `syncGroups` 报备、由下游重新裁决放行：

- **新入群**：账号被拉进一个新群（示例 content：`"无心"邀请你加入了群聊`）。
- **群改名**：群名被修改（示例 content：`你修改群名为"gp18267-06"`）。

**现状缺口**（见 §2）：现有实时链路 `ingestRealtime` 在 `isPushAllowed` 闸门处，对**非放行群**（含全部未知新群）一律丢弃、连 REST 都不回查。因此：

- 新入群在下次「连接成功 / 手动全量同步」前，**实时完全发现不了**。
- 非放行群改名同样被闸门挡下，**无法实时触发重裁**。

**本期目标**：在 SSE 保活期间实时识别上述两类事件，触发**单群增量** `syncGroups`，让下游即时重新裁决；不改动放行群的既有链路。

### 1.1 范围与决策

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 新入群检测 | **未知群启发式**：SSE 群会话不在 `chat_group` 表 → 判为新群 | 不依赖中文文案；天然覆盖离线期间入的群、任何首次见到的群；措辞变化不影响 |
| 同步范围 | **单群增量** `syncAll([session])` | 与设计 §7、现有改名链路一致；轻、只惊动下游一次 |
| 改名检测 | **SSE 信封 content 匹配**（仅「已知非放行群」）+ 保留现有 REST 路径（放行群） | 非放行群拉不到 REST（无 localType 可用），content 是唯一信号；放行群保留 localType 安全兜底、二者互斥不双发 |
| 事件范围 | 本期只做**新入群 + 改名**；结构保持可扩展 | YAGNI；被移出/解散需另定下游「撤销放行」口径，留后期 |
| 收口位置 | 全部落在 `ingestRealtime` 的**同步前缀**、放行闸门**之前** | 复用现有 SSE 入口；同步建行天然防抖 |

## 2. 现状与缺口

### 2.1 现有实时链路（`ingestRealtime`，syncService.ts）

```
SSE message.new
  → parseRealtimeTrigger → { talker, ts }
  → isPushAllowed(talker)?  ── 否 → return（非放行群：连 REST 都不发）  ← 缺口
                            └ 是 → scheduleRealtimePull → pullRealtime → REST → ingestOne
```

### 2.2 现有改名检测

改名系统消息本身是一条 `localType=10000` 的消息，检测绑在 `ingestOne` 的**新入队副作用** `dispatchSystemEvent` 上，前置条件为：**该群已放行** 且 **消息首次入库**（dedup）。改名消息经「SSE 触发 → REST 回查」拉回，用 REST 返回里带 `localType` 的那条安全判定（`localType===10000` 闸门保证普通正文含「修改群名为」不误判）。

**局限**：整条链路要求群**已放行**。放行群改名实时可用且安全；非放行群改名被 `ingestRealtime` 闸门丢弃，只能等下次全量同步纠正。

## 3. 设计

### 3.1 控制流（`ingestRealtime` 改造）

新逻辑插在 `isPushAllowed` 闸门**之前**，且落在函数**同步前缀**内（`onSseEvent` → `void ingestRealtime`，其体在返回 Promise 前同步执行）——这是防抖的前提。

```ts
ingestRealtime(evt):
  env = parseSseEnvelope(evt.data)          // 富解析：talker/ts/sessionType/content/avatarUrl
  if (!env) return Promise.resolve()         // 非 message.new / 不可解析

  // ── 群生命周期旁路（放行闸门之前，仅群会话）──
  if (isGroupSession(env)) {
    if (!this.db.chatGroup.exists(WEFLOW_CHANNEL_ID, env.talker)) {
      this.onNewGroup(env.talker, env.avatarUrl, nowSec())        // ① 新入群
    } else if (!this.db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, env.talker)) {
      const newName = matchGroupRename(env.content)               // ② 已知非放行群改名
      if (newName) this.onGroupRenamed(env.talker, newName, nowSec())
    }
  }

  // ── 原有实时回查（不变）──
  if (!this.db.chatGroup.isPushAllowed(WEFLOW_CHANNEL_ID, env.talker)) return Promise.resolve()
  return this.scheduleRealtimePull(env.talker, env.ts)
```

**三条关键点：**

1. **`isGroupSession` 守卫必不可少**：单聊 SSE 也走 `ingestRealtime`，无守卫会把未知单聊误登记成群。判据：`sessionType === 'group' || talker.endsWith('@chatroom')`。
2. **改名分支只管「已知非放行群」**（`else if !isPushAllowed`）：放行群改名仍由 REST 路径处理，content 匹配的误报面只落在非放行群，放行群零回归；同一改名不会被 SSE 与 REST 双发。
3. **新入群走未知群启发式**：不看 content 文案；`onNewGroup` 内 `upsertSeen` 同步建行，同群突发的后续 SSE 立即 `exists()=true`，天然单次触发。

### 3.2 新增/改动的函数

**① `parseSseEnvelope`（syncService.ts，替代式重构）**：富解析一次，`parseRealtimeTrigger` 收窄为委托，现有测试不动。

```ts
interface SseEnvelope { talker: string, ts: number, sessionType: string, content: string, avatarUrl: string | null }

function parseSseEnvelope(data: string): SseEnvelope | null {
  // JSON.parse 容错；event !== 'message.new' / 缺 sessionId|timestamp → null（同现有宽松口径）
  // sessionType/content 缺省 ''；avatarUrl 缺省 null
}

export function parseRealtimeTrigger(data: string): RealtimeTrigger | null {
  const env = parseSseEnvelope(data)
  return env ? { talker: env.talker, ts: env.ts } : null
}

const isGroupSession = (env: SseEnvelope): boolean =>
  env.sessionType === 'group' || env.talker.endsWith('@chatroom')
```

**② `matchGroupRename`（systemMessage.ts，抽公共）**：把私有 `GROUP_RENAME_RE` 抽成导出纯函数，REST 路径的 `parseSystemEvent` 与 SSE 路径共用同一正则（单一事实源）。

```ts
export function matchGroupRename(content: string): string | null  // 命中返回 trim 后新名，否则 null
```

**③ `chatGroup.exists`（chatGroup.ts，新增查询）**：复用现成 `isAllowedStmt.get`（行不存在返回 undefined 即未知群），零新 SQL。

```ts
exists(channelId: string, conversationId: string): boolean  // = isAllowedStmt.get(...) !== undefined
```

**④ `onNewGroup`（syncService.ts，新增私有）**：先建行（同步、含可信头像 → 满足防抖 + 前端可见），配了下游再单群裁决。

```ts
private onNewGroup(talker: string, avatarUrl: string | null, now: number): void {
  this.db.chatGroup.upsertSeen(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, talker, { avatarUrl }, now)  // 建行
  if (this.groupSync) {
    const session: WeflowSession = { username: talker, displayName: null, type: 2 }  // 名字不可信 → null，靠 chatlab 回补
    void this.groupSync.syncAll(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, [session])       // 同步前缀再 upsert，头像被 COALESCE 保留
  }
}
```

> SSE 信封的 `groupName` 字段实测等于 sessionId（不可信），故新群名传 `null`，由下一轮消息同步的 chatlab `meta.groupName` 回补；`avatarUrl` 是真实 qlogo 地址（可信），先落库让 `syncAll` 首轮即带上。

**⑤ `onGroupRenamed`**：完全复用现有函数（syncService.ts），不改。

## 4. 边界 / 幂等 / 并发

| 情形 | 行为 |
|---|---|
| 入群突发（一次涌入多条 SSE） | `onNewGroup` 的 `upsertSeen` 在同步前缀建行 → 同群后续 SSE 立即 `exists()=true` → 单次触发，无并发重复 |
| 非放行群短时两次改名 | 两次 `syncAll`（覆盖式、末次为准），幂等无害，不加锁（YAGNI） |
| 放行群 vs 非放行群改名 | 放行走 REST（localType 安全）、非放行走 SSE，互斥不重叠，无双发 |
| 单聊 SSE | `isGroupSession` 守卫拦截，绝不误登记为群 |
| 未配 `groupSync` | `onNewGroup` 只 `upsertSeen` 建行（含头像、前端可见），不发下游、默认不放行；改名走现有无下游分支 |
| 新群首条 SSE 恰是改名 | 未知群分支优先（登记 + 重裁）；改名新名丢弃，chatlab 回补真名 |
| 新群放行前的历史突发消息 | 不回补（全局水位 + 会话级闸门的既有取舍，见 §7 未尽事项，不在本期） |
| 下游/DB 异常 | `syncAll` 内部自吞（`markSyncFailed` + 告警）；`void` 调用不影响连接与后续回查 |

## 5. 测试（vitest，内存库 + 注桩 client/downstream）

- `parseSseEnvelope`：字段提取；非 `message.new` / 不可解析 / 缺 `sessionId|timestamp` → null；`sessionType`/`content` 缺省、`avatarUrl` 缺省 null。
- `matchGroupRename`：全/半角引号、「群名 / 群聊名称」措辞命中；非改名 → null；空新名 → null。
- `chatGroup.exists`：`upsertSeen` 后 true、未见 false。
- 新入群：未知 `@chatroom` → 建行 + `syncAll` 恰一次（session 含 `type:2`）；同群第二条 SSE 不再触发（防抖）；未知**单聊**（`sessionType` 非 group 且非 `@chatroom`）→ 不登记、不 `syncAll`。
- 改名：已知非放行群 + 改名文案 → `onGroupRenamed`/`syncAll` 带新名；**放行群** + 改名文案 → 信封路径**不**触发，转而 `scheduleRealtimePull`。
- 未配 `groupSync`：新群仅 `upsertSeen`、不抛。
- （可选）新群 SSE 头像：下游请求 `avatarUrl` 带上信封头像。

## 6. 文档落地

- 本设计文档。
- 更新 `docs/weflow-群组放行同步接口对接文档.md` §6.1 调用时机表：
  - 新增一行「SSE 检测到新入群 → 单群」。
  - 改名一行补注「非放行群改名经 SSE 亦触发单群重裁」。
  - 让下游预期到 SSE 触发的单群 `syncGroups` 调用。

## 7. 未尽事项 / 留待后期

- **被移出群 / 群解散**：本期不做。需先与下游约定「撤销放行」口径——当前 `syncGroups` 是「仅影响本次上报群」的白名单覆盖式，撤销需单独把该群以 `allowed` 之外重发，或另约反向通知。
- **新放行群历史回灌**：沿用既有取舍（§7 群聊表设计），新群放行前的消息不自动补拉，走手动指定起点同步。
- **SSE content 改名误报**：仅落在非放行群、只污染显示名、下轮 chatlab 自愈、裁决按 sessionId 不受影响；如需彻底消除，后期可对非放行群改名也走一次定向 REST 回查取 localType 确认（成本更高，本期不做）。
