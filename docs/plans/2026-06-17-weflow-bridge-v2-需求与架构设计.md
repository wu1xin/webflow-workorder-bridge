# WeFlow → work-order-system 消息转发桥接服务（Node.js + Vue）
# 需求规格与架构设计说明书（v2）

---

## 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | WeFlow 工单消息转发桥接服务 需求规格与架构设计（v2） |
| 版本 | v2.0（rewrite/v2：形态由 .NET 桌面托盘程序改为 Node.js 服务 + Vue 配置前端） |
| 编写日期 | 2026-06-17 |
| 上游 | WeFlow（本机微信存档应用，`127.0.0.1:5031` HTTP/SSE API） |
| 下游 | work-order-system（远端工单系统，ThinkPHP 5 / FastAdmin 体系） |
| 配套文档 | `docs/http-api.md`（WeFlow API）、`docs/weflow-对接接口规格说明书（work-order-system侧）.md`（下游契约 v0.1） |
| 前身文档 | 《weflow 工单消息转发代理 需求规格说明书 v1.3》（.NET 桌面托盘形态，已归档于 git 历史） |

### 与 v1.3（.NET 版）的形态差异

| 维度 | v1.3（.NET 托盘） | v2（本文档，Node.js + Vue） |
|------|------------------|----------------------------|
| 运行时 | .NET 8 自包含单文件 EXE | Node.js 20 LTS + TypeScript |
| 形态 | WPF/WinForms 托盘程序 | 后台常驻服务 + 内嵌 Web UI（Vue） |
| 配置/操作界面 | 托盘 + WPF 窗口 | 浏览器访问的 Vue 单页应用（内网可访问、无登录） |
| 凭据加密 | DPAPI | Node `crypto` AES-256-GCM + 机器绑定 keyfile |
| 自启 | 写 `HKCU\…\Run` | 同左（登录自启）；可选 Node SEA 打包单 exe |
| 持久化 | SQLite/LiteDB | better-sqlite3（SQLite） |
| 告警 | 托盘气泡 | **可插拔告警通道**（首版日志实现，留 webhook/企业微信/邮件口子） |

> **业务契约不变**：上下游接口、鉴权（`task_white_token`）、ACK 判定（`code==1`）、幂等键（`event+rawid`）、媒体两步式上传、信封 `{event,data,file}` 等**完全沿用** v1.3 与下游契约 v0.1，本次仅替换技术形态。

### ⚠️ 最重要的一处约定（务必牢记）

> **下游所有响应统一 HTTP 200，成败看 `body.code`。成功（肯定 ACK）= `HTTP 200 且 body.code == 1`。**
> 仅在收到 `code==1` 后才推进断点、消息出队。这与早期 SRS 草稿示例（`code==0`）相反，一律以 `code==1` 为准。

---

## 1. 引言

### 1.1 编写目的

WeFlow（本机微信消息源）与 work-order-system（远端工单系统）未直接打通；且 WeFlow 媒体/头像地址为 `127.0.0.1` 本机地址，远端不可达。本服务与 WeFlow 同机部署：通过本机 SSE 接收新消息事件，文本类**直通**、媒体类**两步式上传后引用**，以信封 `{event,data,file}` 调用下游 `receiveMessage`，以 `code==1` 判定成功；通过**拉取补偿**保证断连不丢，通过**心跳**让下游感知链路健康，通过 **Vue 配置前端**完成配置、测试、同步、日志查看。

### 1.2 术语与缩略语

| 术语 | 说明 |
|------|------|
| WeFlow | 上游本机微信存档应用，`127.0.0.1:5031` HTTP/SSE API |
| work-order-system / 下游 / WOS | 远端工单系统，服务方/被调用方 |
| 本服务 / 桥接 / Bridge | 与 WeFlow 同机同用户运行的 Node.js 转发服务 |
| rawid | WeFlow 消息原始 id（= 拉取接口 `serverId`），去重键 `event+rawid` |
| 拉取补偿 / Catch-up | 用 `/api/v1/messages?media=1`、`/sessions` 补回 SSE 断连缺口 |
| 信封 | 下游 `receiveMessage` 请求体结构 `{event, data, file}` |
| 两步式上传 | 媒体先 `uploadMedia` 拿 `file_id`+`url`，再在消息体 `file` 引用 |
| ACK | 下游业务确认；成功 = `HTTP 200 且 body.code==1` |
| task_white_token | 下游鉴权令牌（AES-128-ECB/PKCS7 + base64，URL 查询参数） |
| 心跳 | 桥接周期性向下游 `heartbeat` 上报链路健康 |
| 告警通道 | 可插拔的异常通知抽象（首版日志，留 webhook/企业微信/邮件口子） |
| DLQ | 死信队列 |

### 1.3 范围

**包含**：WeFlow 本机 SSE 接收；文本直通 / 媒体两步式上传后引用；信封转发并以 `code==1` 判定；`event+rawid` 幂等去重；拉取补偿；心跳上报；`task_white_token` 鉴权；冷启动/同步状态机；WeFlow 连接健康监测 + 告警通道；配置化、测试、重试、死信、日志、监控；Vue 配置/监控前端。

**不包含**：反向业务链路 / 反向控制 / WebSocket（下游 Q-F 已确认无需）；下游内部字段映射（对桥接透明，桥接只直通 `data`）；WeFlow 与下游自身开发；多上游/多 WeFlow 实例；多环境切换；真实告警渠道（首版仅留接口 + 日志实现）；跨平台（仅 Windows）。

---

## 2. 架构选型与总览

### 2.1 部署拓扑（已确认）

**本服务与 WeFlow 同一台 Windows、同一用户会话运行**。这是关键约束：

- WeFlow 媒体导出目录在用户配置目录下（如 `C:\Users\<user>\Documents\WeFlow\api-media`），同机同用户才有读权限 → 媒体可**直接读 `mediaLocalPath` 文件**。
- WeFlow API 仅监听 `127.0.0.1`，同机 loopback 可达。
- WeFlow 是桌面应用，仅在用户登录、WeFlow 运行时才推送消息。

```
WeFlow（127.0.0.1:5031）
   │ SSE 长连接（?access_token=）
   ▼
┌──────────────── Node.js 桥接服务（同机同用户，7×24 常驻）────────────────┐
│  核心中转引擎：SSE接入 → 去重 → 媒体两步上传 → 信封转发 → ACK(code==1)    │
│  可靠性：SQLite 持久化队列 / 去重表 / 死信 / 断点                         │
│  心跳上报 · WeFlow 断连监测 · 告警通道（首版日志，留口子）                 │
│  ─────────────────────────────────────────────────────────────────────  │
│  内嵌 Fastify：REST API + SSE 实时推送 + 同端口托管 Vue 构建产物          │
└──────────────────────────────────────────────────────────────────────────┘
   │ HTTPS 信封 POST（?task_white_token=）              ▲ 浏览器（内网可访问，无登录）
   ▼                                                     │
work-order-system（远端）                          Vue 3 配置/监控前端
```

### 2.2 运行形态决策（ADR-01）

**决策：随用户登录自启的常驻后台进程**（非 Windows 服务）。

- **背景**：部署在一台 7×24 常开、自动登录的专用机器，微信 + WeFlow + 本服务均长驻。
- **理由**：① WeFlow 仅在登录会话内工作，"免登录的 Windows 服务"换来的"无人登录也运行"在本场景无意义（那时上游本就不工作）；② 同会话同用户运行 → WeFlow 媒体目录铁定有读权限，不必赌服务账户 ACL；③ 免管理员、拷贝即用。配合机器自动登录，实际效果即 7×24。
- **缺口恢复**：停机/重启期间漏的消息靠拉取补偿在重新登录后补回，不丢。
- **备选（可选增强，非首版）**：用 `node-windows`/`nssm` 注册为 Windows 服务给需集中管控的 IT；但需评估服务账户对 WeFlow 媒体目录的读权限。

### 2.3 技术栈选型

| 层 | 选型 | 理由 |
|---|---|---|
| 后端运行时 | **Node.js 20 LTS + TypeScript** | 多模块、可靠性敏感，类型挡 bug |
| HTTP 框架 | **Fastify** | 轻快、内建 schema 校验、SSE 友好 |
| SSE 接入 WeFlow | **undici / fetch 流式自解析** | 需读超时探活、自定义退避，比 `eventsource` 包更可控 |
| 下游 HTTP 调用 | undici / fetch（multipart 用原生 `FormData` 或 `form-data`） | 减少依赖 |
| 持久化 | **better-sqlite3** | 单文件、同步 API、稳；承载队列/去重/死信/审计；Windows 预编译二进制免编译 |
| 凭据加密 | Node 内建 `crypto`（AES-256-GCM 落盘 + AES-128-ECB 生成 token） | 无原生依赖 |
| 日志 | **pino** + 滚动（pino-roll）+ redact 脱敏 | 结构化、快 |
| 前端 | **Vue 3 `<script setup>` + TypeScript + Vite + Pinia + Vue Router** | 与最佳实践一致 |
| 组件库 | **Element Plus** | 表单/表格/标签页齐全，配置后台首选 |
| 前后端实时 | 后端 **SSE 推**实时状态/日志到前端 | 单向够用，复用已有 SSE 能力 |
| 交付/自启 | Vite 构建产物 Fastify 同端口托管；登录自启（启动文件夹快捷方式 / `HKCU\…\Run`）；可选 Node SEA / pkg 单 exe | 单进程单端口，内网工具最省事 |

---

## 3. 后端模块设计

### 3.1 模块划分（TypeScript）

| 分层 | 模块 | 职责 |
|---|---|---|
| 接入 | `core/sseClient` | 连 WeFlow SSE、解帧（`event:`/`data:`/多行拼接/忽略注释）、读超时探活、退避重连、`/health` 探活 |
| 处理 | `core/dedup` | `event+rawid` 去重（SQLite 持久化，覆盖重启/补偿/重投） |
| | `core/mediaProcessor` | 媒体判定、取回（读 `mediaLocalPath`）、两步上传 `uploadMedia` |
| | `core/forwarder` | 组信封 `{event,data,file}`、`receiveMessage` 转发、ACK 判定（`code==1`）、重试/退避/熔断 |
| 可靠性 | `core/queue` | 持久化队列 + worker，出入队、断点推进 |
| | `core/dlq` | 死信留存/重投 |
| | `core/compensation` | 拉取补偿（`sessions` + `messages?start&media=1`） |
| 出站 | `core/heartbeat` | 周期心跳上报 |
| | `core/auth` | `task_white_token` 生成（AES-128-ECB+base64+URL编码，内置测试向量自校验） |
| 监测 | `core/healthMonitor` | WeFlow 连接健康监测 → 触发告警通道 |
| | `core/alert` | 告警通道抽象：现落地 `LogAlertChannel`，留 webhook/企业微信/邮件接口 |
| 基础 | `infra/db` | better-sqlite3 封装 + `schemaVersion` 迁移 |
| | `infra/config` | 配置加载/校验/加密存储 |
| | `infra/logger` | pino + 脱敏 |
| | `infra/paths` | 状态目录解析（`%LOCALAPPDATA%\weflow-bridge`） |
| 接口 | `api/*` | Fastify 路由（config/status/control/sync/test/dlq/audit/stream） |
| 前端 | `web/` | Vue 3 应用（独立工程，构建产物由后端托管） |

### 3.2 数据流

**实时流**：
```
SSE事件 → 解帧 → dedup（命中则跳过） → 持久化入 queue（pending）
   → worker取出 → 文本直通 / 媒体：取回本地 → uploadMedia 拿 file_id+url（mediaCache 幂等）
   → forwarder 组信封 → token → receiveMessage
   → code==1 ? ─是→ 推进断点 + 出队(done) + 写 audit
              └否→ 按 retryable 退避重试 / 入 dlq(dead)
```

**补偿流**：重连后 / 启动后 / 定时 / 前端手动同步触发 → 以断点 `start` 拉 `sessions` + `messages(media=1)` → 去重 → 入同一 queue 走 forwarder（与实时复用去重表 + 下游 `duplicate=true` 双保险）。

**监测流**：`healthMonitor` 周期探 WeFlow `/health` + 跟踪 SSE 连接状态 → 异常（断开/不通/重连失败超阈值）→ 记日志 + 调告警通道（首版仅日志，去抖限频）。

---

## 4. 数据模型与持久化

### 4.1 全局约定

- 对外字段统一**秒级 Unix 时间戳**（`INTEGER`），与 WeFlow/下游契约一致；仅内部"端到端耗时"用毫秒。
- **`rawid` 一律 `TEXT`，绝不用 number**：WeFlow rawid 是大整数字符串（如 `1234567890123456789`），超 JS 安全整数 `2^53`，当数字会精度丢失、去重错乱。
- JSON 字段用 `TEXT` 存，读出 `JSON.parse`。
- 开库即 `PRAGMA journal_mode=WAL` + `PRAGMA foreign_keys=ON`。

### 4.2 状态目录

`%LOCALAPPDATA%\weflow-bridge\`（免提权可写），含：

```
%LOCALAPPDATA%\weflow-bridge\
├── config.json     # 配置（敏感字段 AES-256-GCM 加密）
├── key             # 机器绑定加密密钥（限制文件权限，首次运行生成）
├── bridge.db       # SQLite（队列/去重/死信/审计/媒体缓存/meta）
├── media-tmp\      # 媒体临时目录（转存成功后清理，有总量上限）
└── logs\           # 滚动日志
```

二进制与状态分离：**升级只换程序、状态目录原地续用**。

### 4.3 表设计（DDL + 字段含义）

**1. `meta` —— 全局单例状态（k-v）**
```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
```
| key | 含义 |
|---|---|
| `schemaVersion` | 库结构版本，启动迁移判断 |
| `breakpointTimestamp` | 断点：最后成功转发（`code==1`）消息的秒级时间戳 = 补偿起点 |
| `breakpointRawid` | 断点对应 rawid（同一秒多条时精确定位） |
| `installTime` | 首次初始化时刻，冷启动"从现在开始"用 |
| `agentId` | 代理实例 UUID（心跳上报用），首次生成后固定 |
| `lastCatchupAt` / `lastHeartbeatAt` | 运行态时间戳（可选） |

**2. `dedup` —— 去重表（幂等键）**
```sql
CREATE TABLE IF NOT EXISTS dedup (
  event         TEXT    NOT NULL,
  rawid         TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (event, rawid)
);
CREATE INDEX IF NOT EXISTS idx_dedup_seen ON dedup(first_seen_at);
```
复合主键 `(event,rawid)` 即幂等键；判重用 `INSERT OR IGNORE`，`changes()===0` 表示重复 → 跳过。`first_seen_at` 配合保留期（默认 48h）定时清理。覆盖实时/补偿/重投三路径共用。

**3. `queue` —— 持久化转发队列（核心表）**
```sql
CREATE TABLE IF NOT EXISTS queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event           TEXT    NOT NULL,
  rawid           TEXT    NOT NULL,
  msg_timestamp   INTEGER,
  data_json       TEXT    NOT NULL,   -- WeFlow原始data整包（直通）
  file_json       TEXT,               -- 媒体上传结果；文本为NULL
  source          TEXT    NOT NULL,   -- 'sse' | 'catchup'
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending|sending|done|dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,            -- 退避：下次可投时间（秒）
  fail_code       INTEGER,
  retryable       INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_pick ON queue(status, next_attempt_at, id);
```
worker 取待投：`WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=:now) ORDER BY id LIMIT N`（`ORDER BY id` 保序串行）。整包落 `data_json` 保证崩溃续投不依赖内存。媒体先上传、`file_json` 落库再发消息，重试时不重传媒体。生命周期 `pending → sending → done/dead`。

**4. `dlq` —— 死信（视图，不单独建表）**
```sql
CREATE VIEW IF NOT EXISTS dlq AS
  SELECT id, event, rawid, data_json, file_json,
         fail_code, retryable, last_error AS reason, attempts, updated_at
  FROM queue WHERE status='dead';
```
死信本质是"投递终止的队列项"，同表避免数据搬运，**重投只需把 `status` 改回 `pending`**。

**5. `audit` —— 消息审计（前端日志/统计数据源）**
```sql
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT, event TEXT, rawid TEXT, msg_timestamp INTEGER,
  is_media      INTEGER, file_id TEXT,
  code          INTEGER, duplicate INTEGER, received_at INTEGER,
  latency_ms    INTEGER, attempts INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_key     ON audit(event, rawid);
```
每条消息最终结果写一行。统计（成功率/平均耗时/媒体成败）从 audit 聚合，不单独维护计数表（避免计数与明细不一致）。

**6. `media_cache` —— 媒体上传幂等**
```sql
CREATE TABLE IF NOT EXISTS media_cache (
  rawid           TEXT    NOT NULL,
  media_file_name TEXT    NOT NULL,
  file_id         TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  size            INTEGER, mime TEXT, uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (rawid, media_file_name)
);
```
主键对齐下游媒体幂等键 `rawid+mediaFileName`。上传前先查，命中直接复用 `file_id`/`url`，不重复上传（重试/补偿/续投省带宽）。

### 4.4 迁移与清理

- **启动迁移**：读 `meta.schemaVersion`，低于程序内置版本则按版本顺序跑迁移脚本；**迁移失败 → 告警 + 保留原库不覆盖**，绝不静默炸库。
- **定时清理**：`dedup`（保留期）、`audit`（保留期）、`queue` 中 `done`（归档后删），均设上限。

---

## 5. 冷启动与同步状态机

显式定义"每次启动从哪条消息开始转发"，杜绝两类事故：① 首装把全量微信历史灌入下游；② 重装/数据丢失后静默漏消息或重复建工单。

```
启动 → 检测本地状态
├─ 状态齐全（有断点 + 去重表）       → 正常重启/升级：续投未完成队列 + 从断点拉补偿（补停机缺口）
├─ 无任何本地状态（首装）            → 初始同步策略，默认"从现在开始"（断点 = 首启时刻）
│                                      可选：指定时间点 / 回溯 N 小时 /（高级，需二次确认）全量
└─ 有配置无断点/去重（重装/数据丢失） → 按冷启动处理，靠下游 event+rawid 幂等防重复工单
```

- **关键不变量**：断点**只在收到 `code==1` 后才推进**，保证停机缺口可被补偿完整补回。
- **严禁**断点缺省为 0/epoch 后触发补偿导致全量历史回灌。
- **停机超回溯上限**：离线时长超过补偿最大回溯窗口（默认 24h）时**必须告警**，允许人工放宽窗口或指定时间点手动补，不得静默丢弃。
- **运维操作**：提供"重置断点 / 清空去重 / 清空队列"，均二次确认。

---

## 6. Web API 接口面（Fastify，前缀 `/api`）

内网可访问、无登录鉴权；敏感字段读出时掩码。

| 分类 | 接口 | 说明 |
|---|---|---|
| 配置 | `GET /api/config` | 读配置（敏感字段掩码） |
| | `PUT /api/config/weflow` | 保存 WeFlow 配置（校验 + 触发热重连）；各模块独立保存接口 |
| | `POST /api/config/export`、`POST /api/config/import` | 导入导出（脱敏） |
| 状态 | `GET /api/status` | 状态快照：SSE态/WeFlow health/断点/积压/死信数/统计/运行时长 |
| 实时 | `GET /api/stream/status`、`GET /api/stream/logs` | **SSE 推**实时状态/日志 |
| 控制 | `POST /api/control/forwarding`（启/停）、`POST /api/control/reconnect` | 转发总开关、手动重连 |
| 同步 | `POST /api/sync`（立即 / 指定时间点）、`GET /api/sync/status` | 主动同步，返回进度，**防并发** |
| 测试 | `POST /api/test/weflow-connect` | WeFlow `/health` + SSE 试连 |
| | `POST /api/test/ping` | 下游 `ping`（验地址 + 鉴权） |
| | `POST /api/test/send` | 手编信封直发 `receiveMessage`，展示请求/响应/`code` |
| | `POST /api/test/receive` | 注入/回放一条事件走完整链路 |
| | `POST /api/test/media` | 对指定消息取回 + `uploadMedia`，验 url 远端可达 |
| | `POST /api/test/token` | token 测试向量自校验 |
| | `POST /api/test/heartbeat` | 心跳测试 |
| 诊断 | `POST /api/diagnose` | 一键体检报告 |
| 死信 | `GET /api/dlq`、`POST /api/dlq/:id/retry`、`POST /api/dlq/retry-all`、`DELETE /api/dlq/:id`、`GET /api/dlq/export` | 查看/重投/删除/导出 |
| 审计 | `GET /api/audit`、`GET /api/logs` | 多条件筛选/分页/导出 |
| 运维 | `POST /api/maintenance/reset-breakpoint`、`/clear-dedup`、`/clear-queue` | 二次确认 |

---

## 7. Vue 前端页面结构

Vue Router + Element Plus + Pinia，5 个主页面；Pinia store 订阅后端两条 SSE 流（状态、日志），响应式刷新，无需轮询。

1. **总览/状态**：SSE/WeFlow健康/断点/积压/死信数/成功率/运行时长仪表盘；**转发总开关、手动重连、主动同步**（立即 + 从指定时间点，带进度条 + 防并发置忙）。
2. **配置**：分组表单（WeFlow / 下游 / 媒体 / 补偿·去重 / 过滤 / 心跳 / 同步策略 / 告警通道 / 日志 / 高级），实时校验、敏感字段掩码、导入导出。
3. **测试与诊断**：接收/发送/连接 ping/补偿/媒体/token/心跳/一键诊断，内嵌**报文查看器**（可复制）。
4. **日志/审计**：审计表格多条件筛选 + **实时日志流**（订阅 `/api/stream/logs`），导出。
5. **死信**：列表 + 重投/批量重投/删除/导出。

---

## 8. 告警通道抽象

```ts
interface AlertChannel { send(alert: AlertEvent): Promise<void> }
type AlertEvent = {
  level: 'warn' | 'error';
  type: string;          // weflow_disconnected | reconnect_failed | dlq_new | catchup_overflow | downstream_circuit_open ...
  title: string;
  message: string;
  timestamp: number;     // 秒级
  context?: Record<string, unknown>;
};
```

- **首版落地**：`LogAlertChannel`（写结构化日志）。
- **留口子**（后续迭代）：`WebhookAlertChannel` / `WeComAlertChannel`（企业微信）/ `EmailAlertChannel`，配置里选通道即可接入。
- **触发条件**：WeFlow 连接断开/不通（`healthMonitor` 判定）、重连失败超阈值、死信新增、补偿超回溯上限、下游持续失败/熔断打开。
- **去抖/限频**：同类告警合并 + 冷却期，避免断连抖动刷爆（可配"断连持续 N 秒才告警"）。

---

## 9. 功能需求清单（FR）

> 编号 `FR-<模块>-<序号>`；优先级 P0/P1/P2。沿用 v1.3 编号体系并适配 Node/Web 形态。

### 9.1 长链接管理（WeFlow 本机 SSE 接入）

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-CONN-01 | P0 | GET 连接 `{base}/api/v1/push/messages`（默认 `127.0.0.1:5031`），`Accept: text/event-stream`，单连接保持接收 |
| FR-CONN-02 | P0 | 鉴权 `?access_token=<Token>`；Token 可配置、加密存储；host/port/SSE路径可配置 |
| FR-CONN-03 | P0 | 连接前/失败时查 `GET /health`（免鉴权），区分"WeFlow 未就绪"与"已连无推送" |
| FR-CONN-04 | P0 | 断线自动重连：指数退避，最大次数可配（0=无限） |
| FR-CONN-05 | P0 | 读超时探活：窗口内无数据即重连 |
| FR-CONN-06 | P0 | 实时连接状态（含 weflowNotReady）经 SSE 推前端 |
| FR-CONN-07 | P0 | SSE 解帧：识别 `event:`/`data:`、空行分隔、多行 `data` 拼接、忽略注释；取出 `data` JSON |
| FR-CONN-08 | P1 | 连接/读超时可配；本机连接无需 TLS；日志对 token 脱敏 |
| FR-CONN-09 | P2 | 手动断开/重连（前端按钮） |

### 9.2 消息接收与处理

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-RECV-01 | P0 | 解析 `data` JSON：`event`/`sessionId`/`sessionType`/`rawid`/`avatarUrl`/`sourceName`/`groupName`(群)/`content`/`timestamp`(秒)。**宽松解析**，容忍多/缺字段 |
| FR-RECV-02 | P0 | 上游不回 ACK（SSE 单向） |
| FR-RECV-03 | P0 | 按 `event+rawid` 去重（持久化去重表，覆盖重启/补偿/重投） |
| FR-RECV-04 | P0 | 基本校验：`data` 可解析、`rawid`/`timestamp` 存在；非法事件记录并跳过 |
| FR-RECV-05 | P0 | 媒体判定：按 `content` 占位符（可配置，默认 `[图片]`/`[视频]`/`[语音]`/`[动画表情]`）；可选"每条探测"模式 |
| FR-RECV-06 | P1 | 事件过滤：可配是否转发 `message.revoke`；按 `sessionType`/`sessionId` 白黑名单 |
| FR-RECV-07 | P1 | 维护"最后成功转发 `timestamp`/`rawid`"断点 |

> **直通即原样**：转发时 `data` 放 WeFlow 原始 JSON（不改字段），下游内部映射，对桥接透明。

### 9.3 下游鉴权（task_white_token）

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-AUTH-01 | P0 | 明文 JSON `{"key":"<siteKey>","time":<unix秒>}`（**字段顺序固定 key 在前、time 在后、无多余空格**） |
| FR-AUTH-02 | P0 | `base64( AES-128-ECB/PKCS7( utf8(明文) ) )`；**AES 密钥取约定密钥串前 16 字节（ASCII）** |
| FR-AUTH-03 | P0 | 作为 `?task_white_token=<值>` 附加每请求 URL；**base64 含 `+ / =`，必须 URL 编码** |
| FR-AUTH-04 | P0 | **每次请求实时生成**新 token（`time` 取当前秒），适配下游 time 时效校验 |
| FR-AUTH-05 | P0 | AES 密钥与 site key 加密存储；线下安全获取，不入日志/共享文档 |
| FR-AUTH-06 | P1 | 自测：用下游固定明文测试向量比对，应得完全一致 token（配套文档 §7.2） |

### 9.4 媒体处理（取回与两步式上传）

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-MEDIA-01 | P0 | 媒体消息调 `GET /api/v1/messages?talker={sessionId}&media=1`（时间窗 + rawid 匹配），取 `mediaType`/`mediaFileName`/`mediaLocalPath` |
| FR-MEDIA-02 | P0 | 本地取回：优先**直接读 `mediaLocalPath`**（同机同用户有权限）；备选 localhost `mediaUrl` |
| FR-MEDIA-03 | P0 | 导出时序：media=1 后媒体可能未即时就绪，支持取回重试/等待（可配超时/重试） |
| FR-MEDIA-04 | P0 | **第 1 步上传**：`POST {base}/extra_server/weflow/uploadMedia?task_white_token=...`，`multipart/form-data`，字段 `file`+`rawid`；返回 `{code:1,data:{file_id,url,size,mime,duplicate}}`，url 远端可达 |
| FR-MEDIA-05 | P0 | **第 2 步引用**：信封 `file` 子对象填 `{file_id,url,mediaType,mediaFileName,size}` |
| FR-MEDIA-06 | P0 | **事务性**：先上传媒体成功 → 再发消息引用；任一失败整条入重试/死信，不发"半条"；仅最终 `receiveMessage` 返 `code==1` 才算完成 |
| FR-MEDIA-07 | P0 | 媒体上传幂等：本地 `media_cache` 按 `rawid+mediaFileName` 复用 file_id，呼应下游 `duplicate=true` |
| FR-MEDIA-08 | P1 | 大小/类型：单文件上限可配（下游建议 50MB，最终值待确认）；超限处理可配；危险类型被下游拦截（`code=1002` 不可重试）入死信不重发 |
| FR-MEDIA-09 | P1 | 补偿路径复用同一上传/引用/去重逻辑 |
| FR-MEDIA-10 | P1 | 媒体临时文件转存成功后清理；目录与总量上限 |
| FR-MEDIA-11 | P2 | （待对齐）多媒体消息 `file` 改数组并多次上传；首版按单媒体对象 |

### 9.5 消息转发（receiveMessage）

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-FWD-01 | P0 | `POST {base}/extra_server/weflow/receiveMessage?task_white_token=...`，`application/json`，以 JSON 原文发送（下游 `php://input` 读，勿 form-urlencoded） |
| FR-FWD-02 | P0 | 信封 `{event,data,file}`：`event`=`message.new`/`message.revoke`；`data`=原样直通；`file`=仅媒体消息含 |
| FR-FWD-03 | P0 | 鉴权用 `task_white_token` |
| FR-FWD-04 | P0 | **ACK 成功判定：`HTTP 200 且 body.code==1`**，不得用 HTTP 状态码判定；默认按契约固定 |
| FR-FWD-05 | P0 | 仅 `code==1` 后才标记完成、推进断点、出队（含 `duplicate==true` 视为成功**不再重发**） |
| FR-FWD-06 | P0 | 失败/非 1 处理：按 `code` 与 `data.retryable` 决策；未识别非 1 码按 `code=0` 处理，缺省 retryable 按可重试 |
| FR-FWD-07 | P0 | 请求/等待 ACK 超时可配（同步 ACK） |
| FR-FWD-08 | P1 | 重试次数/间隔/退避可配；耗尽进死信 |
| FR-FWD-09 | P1 | 解析响应 `data`：记 `message_id`/`duplicate`/`received_at` 入审计 |
| FR-FWD-10 | P2 | 顺序/并发可配（默认保序串行） |

### 9.6 可靠性：拉取补偿 / 重试 / 队列 / 死信

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-REL-01 | P0 | 未拿到 `code==1` 的消息本地落库（SQLite），崩溃/重启不丢 |
| FR-REL-02 | P0 | 断点（`timestamp`/`rawid`）持久化 |
| FR-REL-03 | P0 | 拉取补偿：SSE 重连后 / 启动后 / 定时巡检触发——以断点时间戳为 `start`，`/sessions` 找有更新会话，再 `messages?talker=&start=&media=1`，去重后补发 |
| FR-REL-04 | P0 | 补偿与实时共用 `event+rawid` 去重表；叠加下游幂等（`duplicate=true`）双保险，不重复写工单 |
| FR-REL-05 | P0 | 死信留存：失败原因（含 `code`/`retryable`）、时间、`event+rawid`、原始 `data`、媒体状态 |
| FR-REL-06 | P1 | 死信处理：前端查看、手动/批量重投、导出、删除 |
| FR-REL-07 | P1 | 下游熔断：连续失败短暂停发 + 降频，恢复后半开自愈 |
| FR-REL-08 | P1 | 补偿上限（回溯窗口/条数）可配，超限告警 |
| FR-REL-09 | P2 | 至少一次语义 + 去重/下游幂等 |

### 9.7 冷启动与同步（见 §5）

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-SYNC-01 | P0 | 启动态识别：状态齐全/首装/重装三态分流 |
| FR-SYNC-02 | P0 | 初始同步策略（首装/无断点）：默认"从现在开始"；可选指定时间点/回溯N小时/(高级)全量；**严禁** epoch 触发全量回灌 |
| FR-SYNC-03 | P0 | 停机缺口由"从断点拉取补偿"补回；前提断点仅 `code==1` 后推进 |
| FR-SYNC-04 | P1 | 停机超回溯上限：**必须告警**，允许人工放宽/指定时间点补，不静默丢弃 |
| FR-SYNC-05 | P1 | 重装/数据丢失靠下游 `event+rawid` 幂等防重复工单（前提：下游去重表保留期覆盖回灌窗口，Q-S5） |
| FR-SYNC-06 | P1 | 首启向导/手动设置同步起点；运行期可手动"从指定时间点同步"（即前端主动同步） |
| FR-SYNC-07 | P1 | 本地状态生命周期 + 二进制/状态分离：状态统一存 `%LOCALAPPDATA%\weflow-bridge`；升级保留全部状态；可选保留/清除 |
| FR-SYNC-08 | P2 | 重置功能：重置断点/清空去重/清空队列（均二次确认） |
| FR-SYNC-09 | P0 | 本地存储带 `schemaVersion`，启动平滑迁移；迁移失败告警保留原数据不覆盖 |

### 9.8 配置管理

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-CFG-01 | P0 | Vue 配置界面覆盖 §10 全部项；支持本地配置文件 |
| FR-CFG-02 | P0 | 配置校验（URL/必填/数值/AES 密钥长度），不合法明确提示 |
| FR-CFG-03 | P0 | 凭据加密存储（WeFlow Token、AES 密钥、site key）：AES-256-GCM + 机器绑定 keyfile，前端掩码 |
| FR-CFG-04 | P1 | 链接相关变更触发自动重连；尽量热加载 |
| FR-CFG-05 | P1 | 配置导入/导出，敏感字段脱敏 |
| FR-CFG-06 | P2 | 配置变更记录 |

### 9.9 运行形态与开机自启

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-BOOT-01 | P0 | 单进程承载全部核心 + Web，随用户登录自启，与 WeFlow 同机同用户 |
| FR-BOOT-02 | P0 | "开机自启动"开关（写启动文件夹快捷方式 / `HKCU\…\Run`，仅当前用户权限） |
| FR-BOOT-03 | P0 | 启动后自动建链并开始转发与心跳 |
| FR-BOOT-04 | P1 | 看门狗/自恢复；崩溃由自启项重新拉起 |
| FR-BOOT-05 | P2 | 防多实例（单实例锁） |
| FR-BOOT-06 | P2 | 可选 Windows 服务形态（node-windows/nssm），需评估媒体目录读权限 |

### 9.10 测试与诊断

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-TEST-01 | P0 | 测试接收：注入/回放一条事件走完整链路（含媒体判定） |
| FR-TEST-02 | P0 | 测试发送：手编信封直发 `receiveMessage`，展示请求/响应/`code`/`msg`/`data` |
| FR-TEST-03 | P0 | 连接测试：WeFlow `/health`+SSE 试连；下游 `ping`；心跳测试 |
| FR-TEST-04 | P0 | 补偿测试：指定时间窗触发补偿，展示拉取/去重/补发数 |
| FR-TEST-05 | P0 | 媒体测试：对指定消息取回 + `uploadMedia`，展示 `file_id`/`url`/大小，并**验证 url 远端可访问** |
| FR-TEST-06 | P1 | 鉴权自测：测试向量校验 token 生成 |
| FR-TEST-07 | P1 | 报文查看器：SSE 事件、uploadMedia/receiveMessage 请求/响应、心跳，可复制 |
| FR-TEST-08 | P1 | 演练模式（Dry-run）：完成接收/媒体取回/处理与日志，不真正发下游 |
| FR-TEST-09 | P2 | 一键诊断：WeFlow /health、SSE、token、ping、媒体上传、补偿，输出体检报告 |

### 9.11 日志与审计

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-LOG-01 | P0 | 分级日志（Debug/Info/Warn/Error）可配 |
| FR-LOG-02 | P0 | 日志滚动、保留天数可配 |
| FR-LOG-03 | P0 | 消息审计：来源(SSE/补偿)、`event+rawid`、`timestamp`、是否媒体及 `file_id`、`code`/`duplicate`/`received_at`、耗时、重试次数 |
| FR-LOG-04 | P1 | 前端查看器，多条件筛选 + 实时日志流 |
| FR-LOG-05 | P0 | 敏感脱敏：含 `access_token`/`task_white_token` 的 URL、AES 密钥、site key |
| FR-LOG-06 | P2 | 导出（CSV/文本） |

### 9.12 监控与统计

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-MON-01 | P1 | 统计：接收/补偿补发/成功(code1)/失败/死信、媒体取回与上传成败、成功率、平均耗时 |
| FR-MON-02 | P1 | 实时面板：SSE 状态、WeFlow /health、最近事件、断点、积压、上次补偿、媒体队列、运行时长 |
| FR-MON-03 | P2 | 异常告警 → 告警通道（首版日志，见 §8） |
| FR-MON-04 | P2 | 本地健康端点 `/healthz` |

### 9.13 Web 服务与前端（新增）

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-WEB-01 | P0 | Fastify 提供 §6 REST API + 同端口托管 Vue 构建产物 |
| FR-WEB-02 | P0 | 监听地址（默认内网 `0.0.0.0`）、端口可配；**内网可访问、无登录鉴权** |
| FR-WEB-03 | P0 | 两条 SSE 流（`/api/stream/status`、`/api/stream/logs`）推实时状态/日志 |
| FR-WEB-04 | P0 | 主动同步（立即 / 从指定时间点）：进度展示 + **防并发**置忙 |
| FR-WEB-05 | P1 | 死信管理界面：查看/重投/批量重投/删除/导出 |
| FR-WEB-06 | P1 | 配置界面分组表单 + 校验 + 掩码 + 导入导出 |

### 9.14 告警通道（新增，见 §8）

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-ALERT-01 | P0 | 定义 `AlertChannel` 抽象接口 + `AlertEvent` 数据结构 |
| FR-ALERT-02 | P0 | 首版落地 `LogAlertChannel`（写结构化日志） |
| FR-ALERT-03 | P0 | **WeFlow 连接断开/不通时触发告警**（记日志 + 调告警通道） |
| FR-ALERT-04 | P1 | 触发条件可配：断连持续 N 秒、重连失败超阈值、死信新增、补偿超回溯上限、下游熔断 |
| FR-ALERT-05 | P1 | 去抖/限频：同类告警合并 + 冷却期 |
| FR-ALERT-06 | P2 | 留口子：`WebhookAlertChannel`/`WeComAlertChannel`/`EmailAlertChannel`（后续迭代） |

### 9.15 健康上报（心跳 · heartbeat）

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-HB-01 | P1 | 心跳开关；周期可配（默认 30s）；`POST {base}/extra_server/weflow/heartbeat?task_white_token=...`，JSON |
| FR-HB-02 | P1 | 心跳体字段：`agentId`/`version`/`timestamp`/`sseStatus`/`weflowHealth`/`lastMessageTime`/`breakpointTimestamp`/`queueBacklog`/`dlqCount`/`lastCatchupResult`/`mediaStats`/`totalSuccess`/`totalFail` |
| FR-HB-03 | P1 | 解析响应 `data`：`server_time`（校时）；`suggest_interval`（非强制） |
| FR-HB-04 | P1 | 双重故障可见：心跳内 `sseStatus`/`weflowHealth` 异常=上游问题；下游超 N 周期未收=代理/主机/网络问题 |
| FR-HB-05 | P2 | 状态变更（SSE 断开/恢复、补偿起止）额外即时上报一次 |

### 9.16 安全

| 编号 | 优先级 | 需求 |
|------|--------|------|
| FR-SEC-01 | P0 | 凭据加密存储（AES-256-GCM + 机器绑定 keyfile），不明文落盘 |
| FR-SEC-02 | P0 | 下游全程**强制 HTTPS**；上游本机 loopback 不出网 |
| FR-SEC-03 | P0 | 日志/界面敏感脱敏（尤其含 token 的 URL） |
| FR-SEC-04 | P1 | 媒体临时文件按用户权限存放，转存成功后清理 |

---

## 10. 配置项清单

| 分组 | 配置项 | 默认/示例 |
|------|--------|-----------|
| WeFlow | host:port / Access Token(加密) / SSE路径 / 读超时(s) / 重连退避 / 最大次数 / health间隔 | 127.0.0.1:5031 / — / /api/v1/push/messages / 60 / 1→30 / 0 / 30 |
| 下游 | Base URL / site key(加密) / AES密钥前16字节(加密) / 实时生成token / 成功判定 / 请求·ACK超时(s) / 重试次数 / 退避 | https://… / weflow-agent-… / — / 是 / HTTP200且code==1 / 15 / 3 / 2s |
| 媒体 | 启用 / 判定方式 / 占位符列表 / 取回超时 / 取回重试 / 单文件上限(MB) / 超限处理 / 临时目录 / 总量上限 | 是 / 占位符 / [图片],[视频],[语音],[动画表情] / 10s / 3 / 50 / 入死信 / media-tmp / — |
| 补偿 | 启用 / 触发时机 / 定时间隔 / 回溯上限 / 单次条数 | 是 / 重连+启动+定时 / 5min / 24h / 1000 |
| 去重 | 键 / 保留时长(h) | event+rawid(固定) / 48 |
| 过滤 | 转发 revoke / 会话白黑名单 | 是 / — |
| 心跳 | 启用 / 端点 / 间隔(s) / 状态变更即报 / agentId / version | 是 / …/heartbeat / 30 / 是 / 自动 / 自动 |
| 同步 | 初始策略 / 初始回溯窗口(h) / 指定起点 | 从现在开始 / — / — |
| 告警 | 开关 / 断连告警阈值(s) / 去抖冷却(s) / 通道 | 是 / 30 / 300 / 日志 |
| Web服务 | 监听地址 / 端口 | 0.0.0.0 / 8787 |
| 运行 | 开机自启 | 是 |
| 日志 | 级别 / 保留天数 / 单文件上限(MB) | Info / 30 / 20 |
| 高级 | Dry-run 演练 | 否 |

---

## 11. 错误码与重试策略（照搬下游契约）

| `code` | 含义 | `data.retryable` | 桥接动作 |
|--------|------|------------------|----------|
| `1` | 成功（含幂等命中） | — | 完成、推进断点、出队 |
| `0` | 通用失败 | `true` | 退避重试 |
| `1001` | 鉴权失败 | `false`*（*time 过期则重生 token 后重试） | 一般入死信/告警；过期则重试 |
| `1002` | 请求体解析失败/缺参/危险媒体类型 | `false` | 入死信，勿重发 |
| `1003` | 媒体引用无效（file_id 失效） | `false` | 重新走媒体上传 |
| `1004` | 媒体上传失败（存储/IO） | `true` | 退避重试 |
| `1005` | 服务端内部错误 | `true` | 退避重试 |

> 未识别的非 1 码按 `code=0` 处理，缺省 `retryable` 按可重试。

---

## 12. 非功能需求

- **性能**：文本端到端转发延迟（ACK 及时返回时）≤ 1s；媒体延迟更高（导出等待 + 本地读 + 上传），媒体处理与文本转发互不阻塞。
- **可靠性**：SSE 断连自动重连 + 拉取补偿兜底；至少一次 + `event+rawid` 去重 + 下游幂等。媒体事务性：先上传后引用，整条同成败。
- **资源占用**：常驻内存建议 ≤ 200MB（媒体处理期短时升高）；媒体临时文件与队列/日志有上限与清理。
- **兼容性**：Windows 10/11（64 位），同用户会话保证媒体缓存读权限；Node.js 20 LTS。
- **易用性**：错误提示区分 WeFlow 未启动 / Token 错 / 下游不可达 / token 鉴权失败(1001) / 报文问题(1002) / 媒体引用失效(1003) / 媒体上传失败(1004) / 服务端错(1005) / 补偿异常。
- **可维护性**：模块化、完善日志、平滑升级保留配置/断点/未投递消息；核心模块单测（沿用历史 jest + nock 思路，迁移到 vitest）。

---

## 13. 待确认 / 联调前置事项

**A. 待下游（work-order-system）提供 / 确认**

| 项 | 说明 |
|----|------|
| Base URL | 测试 + 生产环境域名 |
| site key | 确认分配值并写入 `extra_server` 白名单 |
| AES 密钥 | 线下安全交付（前 16 字节即生效） |
| 媒体单文件上限 | 默认建议 50MB，确认最终值 |
| `time` 时效校验 | 是否启用、容差时长 |
| 错误码落地 | 下游 `Weflow` 控制器按 §11 实现 `1001~1005` 与 `data.retryable` |

**B. 需双方对齐**

| 编号 | 问题 | 处理建议 |
|------|------|----------|
| Q-S1 | `sessionType` 取值：WeFlow 实际为 `group`/`other`，下游示例写了 `single` | 以 WeFlow 为准 = `group`/`other`（无 `single`），告知下游据此映射 |
| Q-S2 | `avatarUrl` 是否远端可达：下游示例为 `127.0.0.1` 本机地址 | 确认形态：公网 CDN 则直通；本机 URL 则决定"不要头像"或"头像也走 uploadMedia" |
| Q-S3 | 是否存在多媒体消息 | 若一条含多个媒体，`file` 改数组并多次上传；首版按单媒体（FR-MEDIA-11） |
| Q-S5 | 下游 `event+rawid` 幂等去重表的保留期 | 须覆盖"重装/数据丢失后回灌"窗口，否则太老回灌会重复建工单（FR-SYNC-05） |

**C. 本侧待评估（不阻塞主体）**

- 告警通道真实渠道（企业微信/webhook/邮件）选型与接入（后续迭代）。
- media=1 触发后媒体就绪时延与并发限制（决定取回重试参数，可实测）。
- 事件峰值速率、是否严格保序、媒体平均大小。

---

## 14. 验收标准

1. 配置（WeFlow Token + 下游 Base/site key/AES 密钥）正确后：WeFlow `/health`+SSE 连接稳定；下游 `ping` 鉴权通过。
2. **token 自测**：本地实现对下游测试向量产出**完全一致**的 `task_white_token`。
3. 文本消息以信封 `{event,data}` 发 `receiveMessage`，**`code==1` 判定成功**；`code!=1` 按 `retryable` 重试/入死信。
4. **媒体消息**：先 `uploadMedia` 拿 `file_id`+`url`，再 `receiveMessage` 引用；**下游可正常访问该 url 的媒体**；先上传后引用、整条同成败（无"半条"）。
5. **幂等**：重复发同一 `event+rawid` 返 `code=1`+`duplicate=true`，桥接视为成功不重发。
6. **拉取补偿**：断开后重连，基于断点 `media=1` 拉取补发（含媒体），经去重+下游幂等不重复写工单。
7. **心跳**：下游周期收到并据此判断链路；停掉桥接后下游能因心跳缺失识别异常。
8. **WeFlow 断连告警**：拔掉/关闭 WeFlow，桥接在阈值后记录告警日志并调告警通道（首版日志可见）。
9. **Web 前端**：内网浏览器可访问；配置/测试/同步/日志/死信五页面可用；实时状态与日志经 SSE 推送刷新。
10. **首次安装**：默认仅转发安装后新收到的消息，**不回灌历史**；首启可选择同步起点。
11. **重启/升级**：停机期间 WeFlow 收到的消息在重启后由拉取补偿补回，不丢；停机超回溯上限时告警并可人工补；升级（替换程序）保留断点与队列、续投不丢。
12. **凭据加密**：配置文件中敏感字段非明文；日志对 token/密钥脱敏；随登录自启生效；7×24 资源达标。

---

## 15. 关键决策记录（ADR 摘要）

| 编号 | 决策 | 理由 |
|------|------|------|
| ADR-01 | 运行形态 = 随用户登录自启的常驻进程（非 Windows 服务） | WeFlow 仅登录会话工作，免登录服务无意义；同会话保证媒体目录权限 |
| ADR-02 | 部署拓扑 = 与 WeFlow 同机同用户 | 媒体可直接读 `mediaLocalPath`，最稳 |
| ADR-03 | 凭据加密 = AES-256-GCM + 机器绑定 keyfile（无主密码） | 兼顾"配置不明文落盘"与"开机无人值守自启"；无原生依赖 |
| ADR-04 | Web 前端 = 内网可访问、无登录鉴权 | 内部受控环境，降低运维摩擦（如威胁模型变化可后续加登录） |
| ADR-05 | 持久化 = better-sqlite3，dlq 用视图（status=dead） | 单文件可靠；死信同表避免数据搬运，重投仅改状态 |
| ADR-06 | 前后端实时 = 后端 SSE 推 | 单向够用，复用已有 SSE 能力，免轮询 |
| ADR-07 | 告警 = 可插拔通道抽象，首版仅 LogAlertChannel | 按需求"先留口子，后续迭代接真实渠道" |

---

## 16. 后续可扩展方向（Roadmap）

- 告警通道接入真实渠道：企业微信 / webhook / 邮件。
- 多媒体消息（`file` 数组）；头像取回转存（若 avatarUrl 为本机地址）。
- Web 前端登录鉴权（若部署环境威胁模型升级）。
- 媒体上传增强：断点续传、并发调优、媒体去重缓存。
- 可选 Windows 服务形态；Node SEA 单 exe 免装交付打磨。
- 指标对接 Prometheus / 集中日志。

---

*v2.0：形态由 .NET 桌面托盘改为 Node.js 服务 + Vue 前端，业务契约（鉴权/ACK/幂等/媒体两步式/信封）完全沿用下游契约 v0.1 与前身 SRS v1.3。落地前需先线下取得下游 Base URL / site key / AES 密钥，并与下游对齐 §13-B。务必牢记 **ACK = `HTTP200 且 code==1`**。*
