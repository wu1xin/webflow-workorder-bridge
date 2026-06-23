# 多上游数据表结构重设计

> 日期：2026-06-23
> 背景：当前 bridge 仅接入 WeFlow 单一上游。未来需接入 Telegram / 飞书 / 钉钉等多个上游，
> 且这些平台的载荷结构尚未明确。本设计在不预知各平台结构的前提下，重构 `dedup` / `queue` /
> `media_cache` / `audit` 等表，并以稳定的 schema 承载未知载荷。

## 决策摘要

| 维度 | 决策 |
|------|------|
| 部署拓扑 | **单实例单库** + `channel` 字段区分上游（一个 bridge 进程、一个 `bridge.db`） |
| channel 粒度 | **平台类型 + 实例号**：`channel_id` 标识逻辑连接实例，`platform` 为其属性，支持同平台多账号 |
| 载荷策略 | **原始 blob + 最小归一化信封**：`raw_json` 原样保真，另抽出 bridge 自身逻辑必需的少量归一化列 |

## 1. 核心标识模型

整套设计围绕「连接实例」这一新维度，并顺手修正一处命名坑。

**两个一等字段：**

| 字段 | 含义 | 各平台举例 |
|------|------|-----------|
| `platform` | 平台类型（枚举，决定用哪个 adapter） | `weflow` / `telegram` / `feishu` / `dingtalk` |
| `channel_id` | 逻辑连接实例（同平台多账号靠它区分） | `weflow:default` / `telegram:bot-A` |

`channel_id` 是用户在配置里为每个上游连接指定的稳定 ID；`platform` 是它的属性。所有去重、
水位、队列都以 `channel_id` 作为隔离命名空间。

**命名坑修正：** 现有 `source` 字段存的是 `'sse' | 'catchup'`，本质是**采集路径**而非上游平台。
多上游后该名字会严重误导，统一改名为 `ingest_path`；「上游是谁」交给 `platform` / `channel_id`。

**幂等键由 adapter 产出（关键不变量）：** 各平台原生消息 ID 的唯一性范围不同——WeFlow 的
`serverId` 在实例内唯一，但 Telegram 的 `message_id` 只在单个 chat 内唯一，必须拼上 `chat_id`。
因此 schema **不假设** rawid 全局唯一，而由每个 adapter 产出一个 `dedup_key`（保证在本 channel
内唯一，如 TG 用 `${chat_id}:${message_id}`）。schema 只认 `(channel_id, dedup_key)`，对未知平台
的 ID 语义完全解耦。

## 2. 表结构（DDL）

```sql
-- 1. meta —— 全局单例状态（仅保留真正全局的键，如 schemaVersion）
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,  -- 配置/状态键名（主键）
  value TEXT               -- 键对应的值，统一以字符串存储
);

-- 2. channel_state —— 每个连接实例的同步状态（替代原 meta 里的全局水位）
CREATE TABLE IF NOT EXISTS channel_state (
  channel_id          TEXT    PRIMARY KEY,  -- 连接实例 ID（weflow:default 等）
  platform            TEXT    NOT NULL,     -- 平台类型
  install_time        INTEGER,              -- 首次初始化时刻（秒）：首装/重启分流判定
  last_sync_timestamp INTEGER,              -- 同步水位：已入队的最大消息时间戳（秒）
  last_sync_rawid     TEXT,                 -- 水位对应的上游消息 ID（同秒多条时精确定位）
  updated_at          INTEGER NOT NULL      -- 状态更新时间（秒级时间戳）
);

-- 3. dedup —— 跨平台去重表（幂等键由各 adapter 产出）
CREATE TABLE IF NOT EXISTS dedup (
  channel_id    TEXT    NOT NULL,  -- 来源连接实例，隔离命名空间
  dedup_key     TEXT    NOT NULL,  -- adapter 产出的幂等键，保证在本 channel 内唯一
  first_seen_at INTEGER NOT NULL,  -- 首次出现时间（秒级时间戳）
  PRIMARY KEY (channel_id, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_dedup_seen ON dedup(channel_id, first_seen_at);

-- 4. queue —— 持久化转发队列（核心表）
CREATE TABLE IF NOT EXISTS queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,        -- 自增主键
  -- ── 归一化信封（adapter 入口填写，bridge 自身逻辑只读这些列）──
  channel_id      TEXT    NOT NULL,                         -- 来源连接实例（weflow:default 等）
  platform        TEXT    NOT NULL,                         -- 平台类型：weflow|telegram|feishu|dingtalk
  event_type      TEXT    NOT NULL DEFAULT 'message.new',   -- 归一化事件类型
  external_id     TEXT,                                     -- 上游原生消息 ID（展示/排障，未必全局唯一）
  conversation_id TEXT,                                     -- 会话/群/chat ID
  sender_id       TEXT,                                     -- 发送者标识
  msg_timestamp   INTEGER,                                  -- 消息秒级时间戳
  has_media       INTEGER NOT NULL DEFAULT 0,               -- 是否含媒体：1 是 | 0 否
  -- ── 原始载荷（adapter 不改，直通保真）──
  raw_json        TEXT    NOT NULL,                         -- 上游原始整包 JSON（保真，便于回溯/换格式重转）
  -- ── 归一化附件列表 ──
  media_json      TEXT,                                     -- 归一化附件列表（JSON 数组，adapter 入口产出；无附件为 NULL）
  -- ── 采集元数据 ──
  ingest_path     TEXT    NOT NULL,                         -- 采集路径：sse 实时 | catchup 补偿（原 source）
  -- ── 转发状态机（沿用现状）──
  status          TEXT    NOT NULL DEFAULT 'pending',       -- pending|sending|done|dead
  attempts        INTEGER NOT NULL DEFAULT 0,               -- 已重试次数
  next_attempt_at INTEGER,                                  -- 下次重试时间（秒级时间戳）
  fail_code       INTEGER,                                  -- 失败错误码
  retryable       INTEGER,                                  -- 是否可重试：1 | 0
  last_error      TEXT,                                     -- 最近一次错误信息
  created_at      INTEGER NOT NULL,                         -- 入队时间（秒级时间戳）
  updated_at      INTEGER NOT NULL                          -- 更新时间（秒级时间戳）
);
CREATE INDEX IF NOT EXISTS idx_queue_pick    ON queue(status, next_attempt_at, id);  -- forwarder 取件
CREATE INDEX IF NOT EXISTS idx_queue_channel ON queue(channel_id, msg_timestamp);    -- 按 channel 查/排序

-- 5. dlq —— 死信（视图）
CREATE VIEW IF NOT EXISTS dlq AS
  SELECT id, channel_id, platform, event_type, external_id, conversation_id,
         raw_json, media_json, fail_code, retryable, last_error AS reason, attempts, updated_at
  FROM queue WHERE status='dead';

-- 6. audit —— 消息审计（前端日志/统计数据源）
CREATE TABLE IF NOT EXISTS audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  channel_id      TEXT,                               -- 来源连接实例
  platform        TEXT,                               -- 平台类型
  event_type      TEXT,                               -- 归一化事件类型（原 event）
  external_id     TEXT,                               -- 上游原生消息 ID（原 rawid）
  conversation_id TEXT,                               -- 会话/群 ID（便于按会话排查）
  msg_timestamp   INTEGER,                            -- 消息秒级时间戳
  is_media        INTEGER,                            -- 是否媒体：1|0
  file_id         TEXT,                               -- 媒体文件 ID
  code            INTEGER,                            -- 处理结果码
  duplicate       INTEGER,                            -- 是否重复命中去重：1|0
  received_at     INTEGER,                            -- 接收时间（秒级时间戳）
  latency_ms      INTEGER,                            -- 处理耗时（毫秒）
  attempts        INTEGER,                            -- 重试次数
  ingest_path     TEXT,                               -- 采集路径 sse|catchup（原 source）
  created_at      INTEGER NOT NULL                    -- 审计记录创建时间（秒级时间戳）
);
CREATE INDEX IF NOT EXISTS idx_audit_created  ON audit(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_channel  ON audit(channel_id, msg_timestamp);

-- 7. media_cache —— 媒体上传幂等
CREATE TABLE IF NOT EXISTS media_cache (
  channel_id      TEXT    NOT NULL,  -- 来源连接实例
  media_key       TEXT    NOT NULL,  -- adapter 产出的媒体幂等键（channel 内唯一）
  media_file_name TEXT,              -- 原始媒体文件名（展示/排障用，便于查库定位）
  file_id         TEXT    NOT NULL,  -- 上传后返回的文件 ID
  url             TEXT    NOT NULL,  -- 媒体访问 URL
  size            INTEGER,           -- 文件大小（字节）
  mime            TEXT,              -- MIME 类型
  uploaded_at     INTEGER NOT NULL,  -- 上传完成时间（秒级时间戳）
  PRIMARY KEY (channel_id, media_key)
);
```

## 3. 附件链路

附件信息分两层，分别由不同处负责：

1. **附件「有哪些」（描述符）**：永远在 `raw_json` 里（上游原始包必带）。adapter 在入口解析后，
   产出归一化的 `media_json`，并置 `has_media=1`。
2. **附件「上传结果」（file_id/url）**：`media_cache` 负责，靠 `(channel_id, media_key)` 幂等，
   避免重转时重复上传。

`media_json` 每个元素结构统一，下游不必认识平台细节：

```json
[
  {
    "media_key":  "<与 media_cache 的幂等键对应>",
    "file_name":  "report.pdf",
    "mime":       "application/pdf",
    "size":       10240,
    "source_ref": "<从上游下载该附件所需的原始引用，如 fileId/url/path，平台特有>"
  }
]
```

**forwarder 取件流程：** 读 `media_json`（不碰平台格式）→ 逐个附件用 `(channel_id, media_key)`
查 `media_cache`：命中则复用 `file_id/url`；未命中则按 `source_ref` 下载/上传，再写回
`media_cache`。`raw_json` 始终是保真兜底，归一化逻辑变更后可重新解析。

## 4. adapter 抽象

adapter 是「未知结构」与「稳定 schema」之间的唯一翻译层。每个平台实现一个：

```ts
/** 上游适配器：把某平台的原始消息翻成 bridge 的归一化信封 */
interface UpstreamAdapter {
  readonly platform: string  // 'weflow' | 'telegram' | ...

  /** 把一条上游原始消息归一化（入口调用） */
  normalize(raw: unknown): NormalizedMessage
}

interface NormalizedMessage {
  dedupKey: string            // 本 channel 内唯一的幂等键（去重/媒体都靠它）
  eventType: string           // 'message.new' 等
  externalId: string | null   // 上游原生 ID（展示/排障）
  conversationId: string | null
  senderId: string | null
  msgTimestamp: number | null // 秒级
  media: MediaDescriptor[]    // 归一化附件列表 → 落 media_json，空数组则 has_media=0
  rawJson: string             // 原始包直通（通常 JSON.stringify(raw)）
}
```

`channel_id` 不属于 adapter（它表示「这条连接是谁」），由配置层在调用 `normalize` 时带入。
同一个 `WeflowAdapter` 因此能同时服务 `weflow:default` 与 `weflow:backup` 两个 channel。

## 5. 现有代码改动（WeFlow 落地）

- `syncService.processMessage` 里手搓的 `JSON.stringify({event, sessionId, content, ...})`
  收敛进 `WeflowAdapter.normalize`。
- SSE 路径（`stream.ts` / `hooks` 一侧）同样改走 adapter。
- `dedup` / `queue` / `media_cache` 的 store 接口签名改为新字段：
  - `DedupStore.markIfNew(channelId, dedupKey, seenAt)`
  - `QueueStore.enqueue({ channelId, platform, eventType, externalId, conversationId, senderId, msgTimestamp, hasMedia, rawJson, mediaJson, ingestPath }, now)`
- `MetaStore` 里的 `installTime` / `lastSyncTimestamp` / `lastSyncRawid` 迁出，由新的
  `ChannelStateStore` 按 `channel_id` 读写。`META_KEYS` 仅保留 `schemaVersion`。
- `syncService` 的 `onConnected`（首装判定）、`runCompensation`（补偿起点）、`advanceWatermark`
  全部改成按 `channel_id` 操作 `channel_state`。

## 6. 迁移策略

- `SCHEMA_VERSION` 升至 **2**。
- 当前处于 `rewrite/v2` 分支、同步落库早期阶段，旧库无保留价值：`migrate` 中 `from < 2` 分支
  **DROP 旧表重建**（而非逐列 ALTER），最省事。已有的 `bridge.db` 删除后重新初始化即可。
- 生产环境若已有数据，再单独评估数据搬迁方案。
