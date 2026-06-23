// SQLite 表结构（DDL）+ 迁移。多上游 v2：引入 channel_id/platform 维度。
// 设计依据见 docs/plans/2026-06-23-multi-upstream-schema-design.md。
import type BetterSqlite3 from 'better-sqlite3'

/** 库结构版本：结构有破坏性变更时 +1，并在 migrate 中补迁移分支 */
export const SCHEMA_VERSION = 2

const DDL = `
-- 1. meta —— 全局单例状态（仅放真正全局的键，如 schemaVersion）
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
  channel_id      TEXT    NOT NULL,                         -- 来源连接实例（weflow:default 等）
  platform        TEXT    NOT NULL,                         -- 平台类型：weflow|telegram|feishu|dingtalk
  event_type      TEXT    NOT NULL DEFAULT 'message.new',   -- 归一化事件类型
  external_id     TEXT,                                     -- 上游原生消息 ID（展示/排障，未必全局唯一）
  conversation_id TEXT,                                     -- 会话/群/chat ID
  sender_id       TEXT,                                     -- 发送者标识
  msg_timestamp   INTEGER,                                  -- 消息秒级时间戳
  has_media       INTEGER NOT NULL DEFAULT 0,               -- 是否含媒体：1 是 | 0 否
  raw_json        TEXT    NOT NULL,                         -- 上游原始整包 JSON（保真，便于回溯/换格式重转）
  media_json      TEXT,                                     -- 归一化附件列表（JSON 数组；无附件为 NULL）
  ingest_path     TEXT    NOT NULL,                         -- 采集路径：sse 实时 | catchup 补偿
  status          TEXT    NOT NULL DEFAULT 'pending',       -- pending|sending|done|dead
  attempts        INTEGER NOT NULL DEFAULT 0,               -- 已重试次数
  next_attempt_at INTEGER,                                  -- 下次重试时间（秒级时间戳）
  fail_code       INTEGER,                                  -- 失败错误码
  retryable       INTEGER,                                  -- 是否可重试：1 | 0
  last_error      TEXT,                                     -- 最近一次错误信息
  created_at      INTEGER NOT NULL,                         -- 入队时间（秒级时间戳）
  updated_at      INTEGER NOT NULL                          -- 更新时间（秒级时间戳）
);
CREATE INDEX IF NOT EXISTS idx_queue_pick    ON queue(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_queue_channel ON queue(channel_id, msg_timestamp);

-- 5. dlq —— 死信（视图，不单独建表）
CREATE VIEW IF NOT EXISTS dlq AS
  SELECT id, channel_id, platform, event_type, external_id, conversation_id,
         raw_json, media_json, fail_code, retryable, last_error AS reason, attempts, updated_at
  FROM queue WHERE status='dead';

-- 6. audit —— 消息审计（前端日志/统计数据源）
CREATE TABLE IF NOT EXISTS audit (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- 自增主键
  channel_id      TEXT,                               -- 来源连接实例
  platform        TEXT,                               -- 平台类型
  event_type      TEXT,                               -- 归一化事件类型
  external_id     TEXT,                               -- 上游原生消息 ID
  conversation_id TEXT,                               -- 会话/群 ID（便于按会话排查）
  msg_timestamp   INTEGER,                            -- 消息秒级时间戳
  is_media        INTEGER,                            -- 是否媒体：1|0
  file_id         TEXT,                               -- 媒体文件 ID
  code            INTEGER,                            -- 处理结果码
  duplicate       INTEGER,                            -- 是否重复命中去重：1|0
  received_at     INTEGER,                            -- 接收时间（秒级时间戳）
  latency_ms      INTEGER,                            -- 处理耗时（毫秒）
  attempts        INTEGER,                            -- 重试次数
  ingest_path     TEXT,                               -- 采集路径 sse|catchup
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
`

// v1 → v2 破坏性变更：早期阶段无保留价值，直接 DROP 旧对象重建（设计文档 §6）。
const DROP_LEGACY = `
DROP VIEW  IF EXISTS dlq;
DROP TABLE IF EXISTS dedup;
DROP TABLE IF EXISTS queue;
DROP TABLE IF EXISTS audit;
DROP TABLE IF EXISTS media_cache;
`

/**
 * 建表 + 迁移。
 * 先确保 meta 存在 → 读版本 → 低于 v2 则 DROP 旧数据表并清理迁走的旧水位键 → 建 v2 表 → 记录版本。
 * 未来破坏性变更在此追加 if (current < N) { ... } 分支。
 */
export function migrate(db: BetterSqlite3.Database): void {
    // meta 必须最先存在，否则下面读版本会报错
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string } | undefined
    const current = row ? Number(row.value) : 0

    if (current < 2) {
        db.exec(DROP_LEGACY)
        // 旧全局水位键迁往 channel_state，清理之
        db.exec('DELETE FROM meta WHERE key IN (\'installTime\',\'lastSyncTimestamp\',\'lastSyncRawid\')')
    }

    db.exec(DDL)

    if (current < SCHEMA_VERSION) {
        db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run('schemaVersion', String(SCHEMA_VERSION))
    }
}
