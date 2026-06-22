# WeFlow（上游）配置规格说明

> 配置分组系列之一。本文件只覆盖 **WeFlow 上游接入** 这一个配置分组（对应需求文档 [§10 配置项清单](../plans/2026-06-17-weflow-bridge-v2-需求与架构设计.md#L565) 的「WeFlow」行）。下游 / 媒体 / 补偿等其余分组另见同目录后续文档。

## 文档信息

| 项 | 内容 |
|----|------|
| 文档名称 | WeFlow 上游接入 配置规格说明（完整规格） |
| 版本 | v2.0（rewrite/v2，Node.js + Fastify + Vue） |
| 编写日期 | 2026-06-18 |
| 配置根路径 | `config.weflow.*` |
| 落盘位置 | `%LOCALAPPDATA%\weflow-bridge\config.json`（敏感字段 AES-256-GCM 加密） |
| 关联需求 | FR-CONN-01~09、FR-CFG-01~06、FR-SEC-01~03、FR-LOG-05 |
| 上游 API 参考 | [docs/http-api.md](../http-api.md) |

---

## 1. 适用范围与读者

本文件是**完整规格**：既用于指导前端配置页（Vue + Element Plus 分组表单）与后端配置模块（`infra/config`）落地，也可作为运维填写参考。每个字段给出：含义、键路径、类型、默认值、取值范围、校验规则、是否敏感、UI 控件建议、对应 FR、获取方式。

WeFlow 是与本桥接服务**同机同用户**运行的本地微信存档应用，仅监听 `127.0.0.1`，通过 SSE 主动推送新消息。本组配置决定「**如何连上 WeFlow、如何鉴权、断了怎么重连、怎么判定它是否健康**」。

---

## 2. 前置条件（WeFlow 端必须先完成）

配置本组之前，需在 **WeFlow 应用设置页** 完成以下操作，否则任何连接配置都无效：

1. **启用 `API 服务`** —— 默认监听 `127.0.0.1:5031`。启用后基础地址为 `http://127.0.0.1:5031`。
2. **启用 `主动推送`** —— 检测到新消息后才会通过 `GET /api/v1/push/messages` 向 SSE 订阅端推送。**只开 API 服务、不开主动推送 → SSE 能连上但永远收不到消息**（即本服务的 `weflowNotReady` / "已连无推送" 状态）。
3. **获取 Access Token** —— 在 WeFlow 设置页查看/复制 API Token，填入本组 `accessToken` 字段。
4. **完成数据库连接** —— WeFlow 需先连上微信数据库，`/api/v1/*` 才返回真实数据。

> **状态记忆**：WeFlow 会记住 API 服务/主动推送的开关与端口，重启后自动恢复，无需每次手动开。但若运维改过 WeFlow 端口，需同步本组 `port`。

---

## 3. 配置项总表（速查）

| 键路径 | 名称 | 类型 | 默认 | 必填 | 敏感🔒 | 对应 FR |
|--------|------|------|------|:----:|:-----:|---------|
| `weflow.host` | 主机地址 | string | `127.0.0.1` | 是 | | FR-CONN-02 |
| `weflow.port` | 端口 | integer | `5031` | 是 | | FR-CONN-02 |
| `weflow.accessToken` | Access Token | string | —（必填） | 是 | 🔒 | FR-CONN-02 |
| `weflow.connectTimeoutSec` | 连接超时(秒) | integer | `10` | 是 | | FR-CONN-08 |
| `weflow.readTimeoutSec` | 读超时/探活窗口(秒) | integer | `60` | 是 | | FR-CONN-05/08 |
| `weflow.firstMessageTimeoutSec` | 首消息窗口(秒) | integer | `3` | 是 | | FR-CONN-03/07 |
| `weflow.healthIntervalSec` | health 探活间隔(秒) | integer | `30` | 是 | | FR-CONN-03、healthMonitor |
| `weflow.reconnectIntervalSec` | 自动重连间隔(秒，固定不退避) | integer | `1` | 是 | | FR-CONN-04 |
| `weflow.reconnectLogIntervalSec` | 重连日志汇总周期(秒) | integer | `30` | 是 | | FR-CONN-04 |

> 重连策略已由「指数退避」改为「固定间隔循环」：每 `reconnectIntervalSec` 重跑一次三级连接判定（health → SSE → 首消息），无限重试直到连回；每 `reconnectLogIntervalSec` 汇总一条重连测试日志。详见 [链路连接逻辑](../weflow-链路连接逻辑（仅上游）.md) §4。

### 内置固定接口路径（不可配）

WeFlow 接口路径由 WeFlow 固定提供，本服务以**内置常量**保存，**不作为配置项**（无需也不应让用户改）：

| 常量 | 值 | 用途 |
|------|----|------|
| `SSE_PATH` | `/api/v1/push/messages` | SSE 主动推送端点（FR-CONN-01） |
| `HEALTH_PATH` | `/health` | 免鉴权健康检查（FR-CONN-03；WeFlow 亦提供等价的 `/api/v1/health`） |

> 仅 `host` / `port` 可配（端口可能被运维在 WeFlow 端改动）；路径不暴露给配置界面。

---

## 4. 字段详解

### 4.1 `weflow.host` —— 主机地址

- **含义**：WeFlow API 监听的主机。同机部署恒为本机回环地址。
- **类型 / 默认**：string / `127.0.0.1`
- **取值范围**：合法 IPv4 / `localhost` / 主机名。生产场景应保持 `127.0.0.1`（WeFlow 仅监听本机，见 [http-api §10](../http-api.md#L778)）。
- **校验**：非空；合法主机名或 IP。
- **UI 建议**：文本框；与 `port` 同行展示为 `host:port`。
- **获取**：固定 `127.0.0.1`，一般无需改。

### 4.2 `weflow.port` —— 端口

- **含义**：WeFlow API/SSE 共用端口。
- **类型 / 默认**：integer / `5031`
- **取值范围**：`1–65535`。
- **校验**：整数且在端口范围内。
- **UI 建议**：数字框。
- **获取**：WeFlow 设置页「API 服务」端口；若运维改过需同步。

### 4.3 `weflow.accessToken` —— Access Token 🔒

- **含义**：WeFlow `/api/v1/*` 鉴权令牌。本服务以 `?access_token=<Token>` 形式附加在 SSE 连接 URL（FR-CONN-02；SSE 长连接 WeFlow 官方亦推荐 query 方式）。
- **类型 / 默认**：string / 无（**必填**）。
- **取值范围**：WeFlow 生成的 Token 原文。
- **校验**：非空；前后空白自动 trim。
- **敏感**：🔒 **AES-256-GCM 加密落盘**；前端读出**掩码**（如 `wf_****cdef`）；日志中含它的 URL 必须脱敏（FR-CFG-03、FR-SEC-03、FR-LOG-05）。
- **UI 建议**：password 输入框 + 「显示/隐藏」+ 「测试连接」按钮；掩码态下不回填明文。
- **获取**：WeFlow 设置页 → API 服务 → API Token。

### 4.4 `weflow.connectTimeoutSec` —— 连接超时（秒）

- **含义**：建立 TCP/HTTP 连接（含 SSE 握手、health 请求）的超时。超时即视为连接失败，进入重连退避。
- **类型 / 默认**：integer / `10`
- **取值范围**：`1–120`。
- **校验**：正整数。
- **UI 建议**：数字框（步进 1）。

### 4.5 `weflow.readTimeoutSec` —— 读超时 / 探活窗口（秒）

- **含义**：SSE **已连接** 后的"假死"探活窗口。若窗口内**未收到任何字节/事件**（含心跳注释行），判定连接假死 → 主动断开并触发重连（FR-CONN-05）。区别于"连接超时"：这是连上之后的静默检测。
- **类型 / 默认**：integer / `60`
- **取值范围**：`10–600`。建议 ≥ WeFlow 推送/注释心跳间隔的 2 倍，避免误杀空闲连接。
- **校验**：正整数。
- **UI 建议**：数字框；旁注「窗口内无数据即重连」。

### 4.6 `weflow.firstMessageTimeoutSec` —— 首消息窗口（秒）

- **含义**：SSE 握手成功后，等待 WeFlow 推来「首个连接成功消息」的时限。这是三级连接判定的第 ③ 步：窗口内未收到则判为 **「SSE 连接成功但无消息」**（`connected_no_push` 诊断），不算连上。
- **类型 / 默认**：integer / `3`
- **取值范围**：`1–30`。
- **校验**：正整数。
- **UI 建议**：数字框；旁注「超时判为连接成功但无消息」。

### 4.7 `weflow.healthIntervalSec` —— health 探活间隔（秒）

- **含义**：health 端点探活间隔，用于区分两类故障：**WeFlow 未就绪**（health 不通）vs **已连无推送**（health 通但无首消息）。
- **类型 / 默认**：integer / `30`
- **取值范围**：`5–600`。
- **校验**：正整数。
- **UI 建议**：数字框。

> ⚠ **待对齐**：新连接逻辑（见 [链路连接逻辑](../weflow-链路连接逻辑（仅上游）.md) §3）规定 SSE 连上后**不再连续周期探活**，仅在疑似掉线（`readTimeoutSec` 窗口无数据）时才重试 health 做最终判断。该字段是否仍作周期任务、抑或仅作单次 health 探活的超时配置，待实现时确认。

### 4.8 `weflow.reconnectIntervalSec` / `weflow.reconnectLogIntervalSec` —— 自动重连循环（固定间隔，不退避）

SSE 断开（或运行中最终判断失败）后进入自动重连循环：反复重跑三级连接判定（health → SSE → 首消息），**固定间隔、不退避、不限次**，直到连回。两条恢复触发——用户前端「保存并重连」成功，或循环中某轮判定成功——成功后清除循环并做补偿同步（FR-CONN-04）。

| 字段 | 默认 | 范围 | 含义 |
|------|------|------|------|
| `reconnectIntervalSec` | `1` | `1–60` | 每轮重连判定之间的固定间隔（不退避） |
| `reconnectLogIntervalSec` | `30` | `10–300` | 重连测试日志的汇总周期：每段记录该时间内的测试次数与过程 |

- **校验**：均为正整数；`reconnectIntervalSec ≥ 1`、`reconnectLogIntervalSec ≥ 10`。
- **UI 建议**：两个数字框；`reconnectIntervalSec` 旁注「固定不退避，无限重试」，`reconnectLogIntervalSec` 旁注「每段汇总一条重连日志」。

> 与旧版差异：原「指数退避 + 上限封顶 + 最大次数 + 抖动」（`initialDelaySec` / `maxDelaySec` / `factor` / `maxRetries` / `jitter`）已废弃，改为固定间隔循环。

---

## 5. 配置数据结构

### 5.1 TypeScript 接口（`infra/config`）

```ts
export interface WeflowConfig {
  /** WeFlow API 主机，默认 127.0.0.1 */
  host: string
  /** WeFlow API/SSE 共用端口，默认 5031 */
  port: number
  /** 🔒 WeFlow Access Token（明文仅存在于内存，落盘加密） */
  accessToken: string
  /** 连接超时（秒），默认 10 */
  connectTimeoutSec: number
  /** 读超时/探活窗口（秒），默认 60 */
  readTimeoutSec: number
  /** 首消息窗口（秒）：SSE 连上后等待首个连接成功消息的时限，默认 3 */
  firstMessageTimeoutSec: number
  /** health 探活间隔（秒），默认 30 */
  healthIntervalSec: number
  /** 断线后自动重连循环每轮间隔（秒，固定不退避），默认 1 */
  reconnectIntervalSec: number
  /** 重连测试日志的汇总周期（秒），默认 30 */
  reconnectLogIntervalSec: number
}
```

> `scheme` / SSE 路径 / health 路径均不作为字段：本机 loopback **固定 `http`、无 TLS**（FR-CONN-08），接口路径为内置常量（见 §3「内置固定接口路径」）。基础地址按 `http://${host}:${port}` 拼接，SSE URL = `${base}/api/v1/push/messages?access_token=${token}`。

### 5.2 明文 JSON 示例（内存态 / 导出脱敏前）

```json
{
  "weflow": {
    "host": "127.0.0.1",
    "port": 5031,
    "accessToken": "wf_live_8f3c1a9d2b7e4506",
    "connectTimeoutSec": 10,
    "readTimeoutSec": 60,
    "firstMessageTimeoutSec": 3,
    "healthIntervalSec": 30,
    "reconnectIntervalSec": 1,
    "reconnectLogIntervalSec": 30
  }
}
```

### 5.3 落盘形态（`config.json`，敏感字段加密）

`accessToken` 不以明文落盘，替换为加密信封（AES-256-GCM，密钥取自机器绑定 keyfile）：

```json
{
  "weflow": {
    "host": "127.0.0.1",
    "port": 5031,
    "accessToken": {
      "enc": "aes-256-gcm",
      "iv": "9c0f…(base64)",
      "tag": "1ab3…(base64)",
      "data": "5d7e…(base64 密文)"
    },
    "...": "其余非敏感字段原样存储"
  }
}
```

> 加解密对调用方透明：`infra/config` 加载时解密为内存中的 `WeflowConfig.accessToken: string`；保存时把 `accessToken` 重新加密。导出（`POST /api/config/export`）则**整体脱敏/掩码**，不导出可解密密文（FR-CFG-05）。

---

## 6. 校验规则汇总（FR-CFG-02）

保存时（`PUT /api/config/weflow`）逐项校验，不合法返回明确字段级错误提示：

| 字段 | 规则 |
|------|------|
| `host` | 非空；合法 IP / 主机名 |
| `port` | 整数，`1–65535` |
| `accessToken` | 非空（trim 后）；掩码回显态下若未改动则沿用原值，不得被掩码串覆盖 |
| `connectTimeoutSec` | 整数，`1–120` |
| `readTimeoutSec` | 整数，`10–600` |
| `firstMessageTimeoutSec` | 整数，`1–30` |
| `healthIntervalSec` | 整数，`5–600` |
| `reconnectIntervalSec` | 整数，`1–60` |
| `reconnectLogIntervalSec` | 整数，`10–300` |

> **掩码字段保存陷阱**：前端读出 `accessToken` 为掩码串（如 `wf_****`）。保存时若用户未编辑该框，前端应回传特定哨兵（如 `null` / 原掩码 + 未脏标记），后端识别为"保持不变"，**严禁把掩码串当作新 Token 加密落盘**。

---

## 7. 敏感字段与加密存储（FR-CFG-03 / FR-SEC-01 / ADR-03）

- **唯一敏感字段**：`weflow.accessToken`。
- **加密算法**：AES-256-GCM。密钥来自首次运行生成的**机器绑定 keyfile**（`%LOCALAPPDATA%\weflow-bridge\key`，受限文件权限），无主密码 → 满足"开机无人值守自启"同时"不明文落盘"。
- **前端掩码**：`GET /api/config` 返回掩码值，绝不回传明文。
- **日志脱敏**：含 `access_token` 的 URL（尤其 SSE 连接 URL）在 pino 输出前 redact（FR-LOG-05、FR-SEC-03）。
- **导出脱敏**：`config/export` 不含可解密密文（FR-CFG-05）。

---

## 8. 变更生效与热重连（FR-CFG-04）

保存配置后，**连接相关字段变更应触发自动重连**，尽量热加载、无需重启进程：

| 字段 | 变更行为 |
|------|----------|
| `host` / `port` / `accessToken` / `connectTimeoutSec` / `readTimeoutSec` / `firstMessageTimeoutSec` | **断开并按新参数重连 SSE**（热重连） |
| `healthIntervalSec` | 重置 `healthMonitor` 周期任务（视「待对齐」结论而定，见 §4.7） |
| `reconnectIntervalSec` / `reconnectLogIntervalSec` | 下次断线重连即采用新间隔/日志周期（无需立即断连） |

> 配套接口：`POST /api/control/reconnect`（手动重连，FR-CONN-09）、`POST /api/test/weflow-connect`（保存前试连，见 §10）。

---

## 9. 连接行为说明（跨字段，便于实现对齐）

1. **鉴权传参**：SSE 长连接用 query `?access_token=`（FR-CONN-02）；其余 REST 调用（messages/sessions）可用 `Authorization: Bearer` 或 query，二选一即可（见 [http-api §鉴权](../http-api.md#L16)）。
2. **SSE 解帧**（FR-CONN-07）：识别 `event:` / `data:` 行，空行分隔事件，多行 `data` 拼接，忽略以 `:` 开头的注释行；取出 `data` 的 JSON 体交后续处理。
3. **连接状态机**（经 SSE 推前端，FR-CONN-06）：
   `disconnected → connecting → connected`；连上但 health 不通/久无数据 → `weflowNotReady`；断开 → `reconnecting`（携带固定重连间隔、本段已测试次数）。
4. **就绪区分**（FR-CONN-03）：连接前/失败时先打 health 端点——不通=「WeFlow 未启动/未就绪」；通但 SSE 无数据=「已连无推送」（多半是 WeFlow 未开"主动推送"，见 §2）。两者提示文案应不同（FR 易用性）。
5. **读超时探活**（FR-CONN-05）：见 §4.5。
6. **自动重连循环**（FR-CONN-04）：见 §4.8。
7. **无 TLS**：本机回环不加密、不出网（FR-SEC-02）。

---

## 10. 测试与诊断（FR-TEST-03）

配置保存前/后可用以下接口验证本组配置正确性：

| 接口 | 作用 |
|------|------|
| `POST /api/test/weflow-connect` | 用当前/待保存配置打 health 端点 + 试连 SSE，返回 health 结果、SSE 是否握手成功、是否收到首条事件，便于区分「未就绪 / Token 错 / 已连无推送」 |
| `POST /api/control/reconnect` | 手动触发一次重连，验证热重连 |
| 一键诊断 `POST /api/diagnose` | 体检报告中包含 WeFlow `/health` 与 SSE 段 |

**典型失败与定位**（对接 §12 非功能-易用性）：

| 现象 | 可能原因 | 处置 |
|------|----------|------|
| health 不通 | WeFlow 未启动 / 未开 API 服务 / 端口错 | 检查 §2 前置、`host:port` |
| health 通、SSE 401/拒绝 | `accessToken` 错或过期 | 重新从 WeFlow 设置页取 Token |
| SSE 连上但长期无事件 | WeFlow 未开「主动推送」/ 无新消息 | 开启主动推送；用 WeFlow 收一条消息验证 |
| 频繁断连重连 | `readTimeoutSec` 过小 / 网络/进程抖动 | 调大读超时；查 WeFlow 日志 |

---

## 11. 与其他分组的边界

- 本组只负责**接上 WeFlow 并收到原始事件**。事件去重（`event+rawid`）、媒体取回与两步上传、信封转发、补偿拉取等属于其它分组与模块（`core/dedup`、`core/mediaProcessor`、`core/forwarder`、`core/compensation`），其配置另见对应文档。
- 媒体取回虽然也访问 WeFlow（`/api/v1/messages?media=1`、读 `mediaLocalPath`），但其参数（取回超时/重试、占位符判定等）归入「媒体」配置组，不在本文件。

---

*本规格沿用需求文档 v2.0 与 [docs/http-api.md](../http-api.md)；落地前请确认 WeFlow 端已开启 API 服务 + 主动推送，并取得有效 Access Token。*
