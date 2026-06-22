// SQLite 表结构（DDL），逐字对齐需求设计文档 §4.3。
// 当前同步落库只用到 meta / dedup / queue；audit / media_cache / dlq 视图一并建好，
// 供后续转发、审计、媒体模块直接接入，避免后期零散迁移。
import type BetterSqlite3 from 'better-sqlite3'

/** 库结构版本：结构有破坏性变更时 +1，并在 migrate 中补迁移分支 */
export const SCHEMA_VERSION = 1

const DDL = `
-- 1. meta —— 全局单例状态（k-v）
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- 2. dedup —— 去重表（幂等键 event+rawid）
CREATE TABLE IF NOT EXISTS dedup (
  event         TEXT    NOT NULL,
  rawid         TEXT    NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (event, rawid)
);
CREATE INDEX IF NOT EXISTS idx_dedup_seen ON dedup(first_seen_at);

-- 3. queue —— 持久化转发队列（核心表）
CREATE TABLE IF NOT EXISTS queue (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  event           TEXT    NOT NULL,
  rawid           TEXT    NOT NULL,
  msg_timestamp   INTEGER,
  data_json       TEXT    NOT NULL,
  file_json       TEXT,
  source          TEXT    NOT NULL,   -- 'sse' | 'catchup'
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending|sending|done|dead
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  fail_code       INTEGER,
  retryable       INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_pick ON queue(status, next_attempt_at, id);

-- 4. dlq —— 死信（视图，不单独建表）
CREATE VIEW IF NOT EXISTS dlq AS
  SELECT id, event, rawid, data_json, file_json,
         fail_code, retryable, last_error AS reason, attempts, updated_at
  FROM queue WHERE status='dead';

-- 5. audit —— 消息审计（前端日志/统计数据源）
CREATE TABLE IF NOT EXISTS audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT, event TEXT, rawid TEXT, msg_timestamp INTEGER,
  is_media      INTEGER, file_id TEXT,
  code          INTEGER, duplicate INTEGER, received_at INTEGER,
  latency_ms    INTEGER, attempts INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_key     ON audit(event, rawid);

-- 6. media_cache —— 媒体上传幂等
CREATE TABLE IF NOT EXISTS media_cache (
  rawid           TEXT    NOT NULL,
  media_file_name TEXT    NOT NULL,
  file_id         TEXT    NOT NULL,
  url             TEXT    NOT NULL,
  size            INTEGER, mime TEXT, uploaded_at INTEGER NOT NULL,
  PRIMARY KEY (rawid, media_file_name)
);
`

/**
 * 建表 + 迁移。读 meta.schemaVersion，低于内置版本则按版本顺序迁移。
 * 当前仅 v1，未来破坏性变更在此追加 if (from < N) { ... } 分支。
 * 迁移策略遵循需求文档 §4.4：失败应保留原库不覆盖（此处建表幂等，IF NOT EXISTS 安全重入）。
 */
export function migrate(db: BetterSqlite3.Database): void {
    db.exec(DDL)
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string } | undefined
    const current = row ? Number(row.value) : 0
    if (current < SCHEMA_VERSION) {
        // v0 → v1：基础表已由上面的 DDL 建好，这里只记录版本
        db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run('schemaVersion', String(SCHEMA_VERSION))
    }
}
