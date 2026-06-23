# 多上游数据表结构重设计 — 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 `dedup` / `queue` / `media_cache` / `audit` 等表重构为带 `channel_id` + `platform` 维度的多上游结构，幂等键由 adapter 产出，原始 blob + 最小归一化信封，新增 `channel_state` 表替代全局水位。

**Architecture:** 单实例单库，新增「连接实例」维度（`channel_id`）。每个上游平台实现一个 `UpstreamAdapter`，在入口把原始消息归一化成 `NormalizedMessage`（含 `dedupKey`、归一化附件列表、原始 `rawJson`）。SQLite schema 升到 v2，早期阶段 DROP 旧表重建。当前仅 WeFlow 落地，`channel_id` 固定为常量 `weflow:default`；多 channel 配置 UI 是后续独立功能（本计划不做）。

**Tech Stack:** Node.js (ESM, NodeNext) + TypeScript + better-sqlite3 + Fastify；本计划新增 **vitest** 作为数据层测试框架，用 better-sqlite3 `:memory:` 跑单测。

**设计依据：** [docs/plans/2026-06-23-multi-upstream-schema-design.md](2026-06-23-multi-upstream-schema-design.md)

---

## 通用约定

- **代码风格**：遵守 `eslint.config.mjs`——**无分号**、**单引号**、**4 空格缩进**。每个任务结束前 `npm run lint` 必须零报错。
- **异步风格**（见 `CLAUDE.md`）：优先 Promise 链；仅当封装函数内部有多个异步操作的顺序依赖时才用 `async/await`（`syncService` 的拉取循环属此例，保留 `async/await`）。
- **每条 commit 信息**用中文、conventional 风格，末尾加：
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  ```
- **测试文件位置**：与源码同目录，命名 `*.test.ts`。store/schema 测试直接 `new BetterSqlite3(':memory:')` + `migrate()`，不经 `Db` 包装、不碰真实文件系统。
- **测试运行**：`npm -w server run test`（全量）或 `npm -w server run test -- <路径片段>`（过滤单文件）。
- **构建校验**：`npm -w server run build`（`tsc -b`，做类型检查）。注意 test 文件已从 build 排除，类型问题靠 vitest 运行期 + 评审兜住。

---

## Task 1: 搭 vitest 测试骨架

**Files:**
- Modify: `server/package.json`
- Create: `server/vitest.config.ts`
- Modify: `server/tsconfig.json:17`（加 `exclude`）
- Modify: `package.json:11-21`（根加 `test` 脚本）
- Create: `server/src/db/smoke.test.ts`（临时 sanity，本任务末尾删）

**Step 1: 加依赖与脚本**

`server/package.json` 的 `scripts` 加一行，`devDependencies` 加 `vitest`：

```jsonc
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -b",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  // ...
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.13",
    "@types/node": "^22.10.2",
    "tsx": "^4.19.2",
    "vitest": "^3.2.4"
  }
```

根 `package.json` 的 `scripts` 加：

```jsonc
    "test": "npm -w server run test",
```

**Step 2: 创建 vitest 配置**

`server/vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['src/**/*.test.ts'],
        environment: 'node',
    },
})
```

**Step 3: 让 build 跳过 test 文件**

`server/tsconfig.json` 增加 `exclude`（与 `include` 同级）：

```jsonc
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts"],
  "references": [{ "path": "../shared" }]
```

**Step 4: 装依赖**

Run: `npm install`
Expected: 安装 vitest，无报错。

**Step 5: 写一个 sanity 测试验证 better-sqlite3 + vitest 能跑**

`server/src/db/smoke.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'

describe('vitest 骨架', () => {
    it('能开内存库并查询', () => {
        const db = new BetterSqlite3(':memory:')
        const row = db.prepare('SELECT 1 AS n').get() as { n: number }
        expect(row.n).toBe(1)
        db.close()
    })
})
```

**Step 6: 跑测试确认通过**

Run: `npm -w server run test`
Expected: 1 passed。

**Step 7: 删掉 sanity 测试并校验**

删除 `server/src/db/smoke.test.ts`，然后：
Run: `npm run lint`
Expected: 零报错。

**Step 8: Commit**

```bash
git add server/package.json server/vitest.config.ts server/tsconfig.json package.json package-lock.json
git commit -m "test(server): 引入 vitest 数据层测试骨架"
```

---

## Task 2: schema 升 v2 —— 新表结构 + DROP 重建迁移

**Files:**
- Create: `server/src/db/schema.test.ts`
- Modify: `server/src/db/schema.ts`（整体重写 DDL + migrate）

**Step 1: 写失败测试**

`server/src/db/schema.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate, SCHEMA_VERSION } from './schema.js'

function columns(db: BetterSqlite3.Database, table: string): string[] {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map(c => c.name)
}
function exists(db: BetterSqlite3.Database, name: string): boolean {
    return db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined
}

describe('schema v2', () => {
    let db: BetterSqlite3.Database
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db) })
    afterEach(() => db.close())

    it('SCHEMA_VERSION 为 2 且写入 meta', () => {
        expect(SCHEMA_VERSION).toBe(2)
        const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string }
        expect(row.value).toBe('2')
    })

    it('queue 含归一化信封列，且不再有旧 source 列', () => {
        const cols = columns(db, 'queue')
        expect(cols).toEqual(expect.arrayContaining([
            'channel_id', 'platform', 'event_type', 'external_id', 'conversation_id',
            'sender_id', 'msg_timestamp', 'has_media', 'raw_json', 'media_json', 'ingest_path',
        ]))
        expect(cols).not.toContain('source')
        expect(cols).not.toContain('data_json')
        expect(cols).not.toContain('file_json')
    })

    it('dedup 主键为 channel_id + dedup_key', () => {
        const cols = columns(db, 'dedup')
        expect(cols).toEqual(expect.arrayContaining(['channel_id', 'dedup_key', 'first_seen_at']))
        expect(cols).not.toContain('event')
        expect(cols).not.toContain('rawid')
    })

    it('channel_state / media_cache / audit / dlq 都建好', () => {
        expect(exists(db, 'channel_state')).toBe(true)
        expect(columns(db, 'media_cache')).toEqual(expect.arrayContaining(['channel_id', 'media_key', 'media_file_name']))
        expect(columns(db, 'audit')).toEqual(expect.arrayContaining(['channel_id', 'platform', 'event_type', 'ingest_path']))
        expect(exists(db, 'dlq')).toBe(true)
    })

    it('迁移幂等：重复 migrate 不报错', () => {
        expect(() => { migrate(db); migrate(db) }).not.toThrow()
    })
})
```

**Step 2: 跑测试确认失败**

Run: `npm -w server run test -- schema`
Expected: FAIL（SCHEMA_VERSION 仍为 1、queue 仍有 source/data_json 列等）。

**Step 3: 重写 schema.ts**

整体替换 `server/src/db/schema.ts`：

```ts
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
        db.exec("DELETE FROM meta WHERE key IN ('installTime','lastSyncTimestamp','lastSyncRawid')")
    }

    db.exec(DDL)

    if (current < SCHEMA_VERSION) {
        db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run('schemaVersion', String(SCHEMA_VERSION))
    }
}
```

**Step 4: 跑测试确认通过**

Run: `npm -w server run test -- schema`
Expected: PASS（5 个用例全过）。

**Step 5: Commit**

```bash
git add server/src/db/schema.ts server/src/db/schema.test.ts
git commit -m "feat(db): schema 升 v2，引入 channel 维度并 DROP 重建旧表"
```

---

## Task 3: 新增 ChannelStateStore（替代全局水位）

**Files:**
- Create: `server/src/db/channelState.test.ts`
- Create: `server/src/db/channelState.ts`

**Step 1: 写失败测试**

`server/src/db/channelState.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { ChannelStateStore } from './channelState.js'

const CH = 'weflow:default'
const PLATFORM = 'weflow'

describe('ChannelStateStore', () => {
    let db: BetterSqlite3.Database
    let store: ChannelStateStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new ChannelStateStore(db) })
    afterEach(() => db.close())

    it('未初始化时 installTime 为 null', () => {
        expect(store.getInstallTime(CH)).toBeNull()
    })

    it('markInstalled 首次写入，二次不覆盖', () => {
        store.markInstalled(CH, PLATFORM, 1000)
        expect(store.getInstallTime(CH)).toBe(1000)
        store.markInstalled(CH, PLATFORM, 2000)
        expect(store.getInstallTime(CH)).toBe(1000)
    })

    it('advanceWatermark 仅在更大时推进', () => {
        store.advanceWatermark(CH, PLATFORM, 100, 'a', 9000)
        expect(store.get(CH)?.lastSyncTimestamp).toBe(100)
        store.advanceWatermark(CH, PLATFORM, 50, 'b', 9001)
        expect(store.get(CH)?.lastSyncTimestamp).toBe(100)
        expect(store.get(CH)?.lastSyncRawid).toBe('a')
        store.advanceWatermark(CH, PLATFORM, 200, 'c', 9002)
        expect(store.get(CH)?.lastSyncTimestamp).toBe(200)
        expect(store.get(CH)?.lastSyncRawid).toBe('c')
    })

    it('install 与 watermark 互不影响', () => {
        store.advanceWatermark(CH, PLATFORM, 100, 'a', 9000)
        expect(store.getInstallTime(CH)).toBeNull()
        store.markInstalled(CH, PLATFORM, 1000)
        expect(store.get(CH)?.lastSyncTimestamp).toBe(100)
    })

    it('不同 channel 相互隔离', () => {
        store.markInstalled('weflow:a', PLATFORM, 1)
        expect(store.getInstallTime('weflow:b')).toBeNull()
    })
})
```

**Step 2: 跑测试确认失败**

Run: `npm -w server run test -- channelState`
Expected: FAIL（找不到 `./channelState.js`）。

**Step 3: 实现 ChannelStateStore**

`server/src/db/channelState.ts`：

```ts
// channel_state 表访问：每个连接实例的同步状态（首装时刻 + 同步水位）。
// 取代旧 meta 里的全局 installTime/lastSyncTimestamp/lastSyncRawid（设计文档 §2、§4）。
import type BetterSqlite3 from 'better-sqlite3'

export interface ChannelState {
    channelId: string
    platform: string
    installTime: number | null
    lastSyncTimestamp: number | null
    lastSyncRawid: string | null
}

interface Row {
    channel_id: string
    platform: string
    install_time: number | null
    last_sync_timestamp: number | null
    last_sync_rawid: string | null
}

export class ChannelStateStore {
    private readonly getStmt: BetterSqlite3.Statement
    private readonly installStmt: BetterSqlite3.Statement
    private readonly watermarkStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.getStmt = db.prepare(
            'SELECT channel_id, platform, install_time, last_sync_timestamp, last_sync_rawid FROM channel_state WHERE channel_id = ?',
        )
        // 写 install_time：行不存在则插入；已存在且非空则保留原值（COALESCE 不覆盖）
        this.installStmt = db.prepare(`
            INSERT INTO channel_state(channel_id, platform, install_time, updated_at)
            VALUES (@channelId, @platform, @now, @now)
            ON CONFLICT(channel_id) DO UPDATE SET
              install_time = COALESCE(install_time, @now),
              updated_at   = @now
        `)
        this.watermarkStmt = db.prepare(`
            INSERT INTO channel_state(channel_id, platform, last_sync_timestamp, last_sync_rawid, updated_at)
            VALUES (@channelId, @platform, @ts, @rawid, @now)
            ON CONFLICT(channel_id) DO UPDATE SET
              last_sync_timestamp = @ts,
              last_sync_rawid     = @rawid,
              updated_at          = @now
        `)
    }

    /** 取整行状态（不存在返回 null） */
    get(channelId: string): ChannelState | null {
        const row = this.getStmt.get(channelId) as Row | undefined
        if (!row) return null
        return {
            channelId: row.channel_id,
            platform: row.platform,
            installTime: row.install_time,
            lastSyncTimestamp: row.last_sync_timestamp,
            lastSyncRawid: row.last_sync_rawid,
        }
    }

    /** 首装时刻（不存在返回 null），用于首装/重启分流 */
    getInstallTime(channelId: string): number | null {
        return this.get(channelId)?.installTime ?? null
    }

    /** 标记首装时刻：幂等，已有则保留原值 */
    markInstalled(channelId: string, platform: string, now: number): void {
        this.installStmt.run({ channelId, platform, now })
    }

    /** 推进水位：仅当 ts 大于当前水位时写入 */
    advanceWatermark(channelId: string, platform: string, ts: number, rawid: string, now: number): void {
        const current = this.get(channelId)?.lastSyncTimestamp ?? 0
        if (ts > current) {
            this.watermarkStmt.run({ channelId, platform, ts, rawid, now })
        }
    }
}
```

**Step 4: 跑测试确认通过**

Run: `npm -w server run test -- channelState`
Expected: PASS。

**Step 5: Commit**

```bash
git add server/src/db/channelState.ts server/src/db/channelState.test.ts
git commit -m "feat(db): 新增 ChannelStateStore 按 channel 记首装时刻与同步水位"
```

---

## Task 4: DedupStore 改 (channel_id, dedup_key)

**Files:**
- Create: `server/src/db/dedup.test.ts`
- Modify: `server/src/db/dedup.ts`

**Step 1: 写失败测试**

`server/src/db/dedup.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { DedupStore } from './dedup.js'

describe('DedupStore', () => {
    let db: BetterSqlite3.Database
    let store: DedupStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new DedupStore(db) })
    afterEach(() => db.close())

    it('首次出现返回 true，重复返回 false', () => {
        expect(store.markIfNew('weflow:default', 'k1', 1000)).toBe(true)
        expect(store.markIfNew('weflow:default', 'k1', 1001)).toBe(false)
    })

    it('不同 channel 的同名 key 互不冲突', () => {
        expect(store.markIfNew('weflow:default', 'k1', 1000)).toBe(true)
        expect(store.markIfNew('telegram:bot-a', 'k1', 1000)).toBe(true)
    })
})
```

**Step 2: 跑测试确认失败**

Run: `npm -w server run test -- dedup`
Expected: FAIL（`markIfNew` 旧签名是 `(event, rawid, seenAt)`，插入列名不符）。

**Step 3: 改 dedup.ts**

整体替换 `server/src/db/dedup.ts`：

```ts
// dedup 表访问：(channel_id, dedup_key) 幂等去重（设计文档 §1、§2）。
// dedup_key 由各上游 adapter 产出，保证在本 channel 内唯一。实时/补偿/重投共用同一张表。
import type BetterSqlite3 from 'better-sqlite3'

export class DedupStore {
    private readonly insertStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        // INSERT OR IGNORE：命中已存在主键则忽略，changes===0 即重复
        this.insertStmt = db.prepare(
            'INSERT OR IGNORE INTO dedup(channel_id, dedup_key, first_seen_at) VALUES (?, ?, ?)',
        )
    }

    /**
     * 标记一条事件。返回 true 表示首次出现（应处理/入队）；false 表示重复（跳过）。
     * @param channelId 来源连接实例
     * @param dedupKey  adapter 产出的幂等键（channel 内唯一）
     */
    markIfNew(channelId: string, dedupKey: string, seenAt: number): boolean {
        return this.insertStmt.run(channelId, dedupKey, seenAt).changes > 0
    }
}
```

**Step 4: 跑测试确认通过**

Run: `npm -w server run test -- dedup`
Expected: PASS。

**Step 5: Commit**

```bash
git add server/src/db/dedup.ts server/src/db/dedup.test.ts
git commit -m "feat(db): DedupStore 改用 (channel_id, dedup_key) 幂等键"
```

---

## Task 5: QueueStore 改归一化信封入队

**Files:**
- Create: `server/src/db/queue.test.ts`
- Modify: `server/src/db/queue.ts`

**Step 1: 写失败测试**

`server/src/db/queue.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { QueueStore, type EnqueueInput } from './queue.js'

function sample(over: Partial<EnqueueInput> = {}): EnqueueInput {
    return {
        channelId: 'weflow:default',
        platform: 'weflow',
        eventType: 'message.new',
        externalId: 'srv-1',
        conversationId: 'alice',
        senderId: 'bob',
        msgTimestamp: 1700000000,
        hasMedia: 0,
        rawJson: '{"a":1}',
        mediaJson: null,
        ingestPath: 'catchup',
        ...over,
    }
}

describe('QueueStore', () => {
    let db: BetterSqlite3.Database
    let store: QueueStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new QueueStore(db) })
    afterEach(() => db.close())

    it('入队写入归一化信封字段，状态为 pending', () => {
        store.enqueue(sample(), 1700000001)
        const row = db.prepare('SELECT * FROM queue').get() as Record<string, unknown>
        expect(row.channel_id).toBe('weflow:default')
        expect(row.platform).toBe('weflow')
        expect(row.external_id).toBe('srv-1')
        expect(row.conversation_id).toBe('alice')
        expect(row.raw_json).toBe('{"a":1}')
        expect(row.ingest_path).toBe('catchup')
        expect(row.status).toBe('pending')
        expect(row.attempts).toBe(0)
    })

    it('含媒体时 has_media=1 且写入 media_json', () => {
        store.enqueue(sample({ hasMedia: 1, mediaJson: '[{"mediaKey":"srv-1:a.png"}]' }), 1700000001)
        const row = db.prepare('SELECT has_media, media_json FROM queue').get() as { has_media: number, media_json: string }
        expect(row.has_media).toBe(1)
        expect(row.media_json).toContain('a.png')
    })

    it('countByStatus 统计积压', () => {
        store.enqueue(sample(), 1)
        store.enqueue(sample({ externalId: 'srv-2' }), 2)
        expect(store.countByStatus('pending')).toBe(2)
        expect(store.countByStatus('dead')).toBe(0)
    })
})
```

**Step 2: 跑测试确认失败**

Run: `npm -w server run test -- queue`
Expected: FAIL（旧 `EnqueueInput` 字段不符、插入列名不符）。

**Step 3: 改 queue.ts**

整体替换 `server/src/db/queue.ts`：

```ts
// queue 表访问：持久化转发队列（设计文档 §2）。
// 同步/实时去重后把归一化信封 + 原始 blob 以 pending 入队，等下游 forwarder 消费。
import type BetterSqlite3 from 'better-sqlite3'

/** 入队负载：最小归一化信封 + 原始 blob + 采集元数据 */
export interface EnqueueInput {
    /** 来源连接实例（weflow:default 等） */
    channelId: string
    /** 平台类型：weflow|telegram|feishu|dingtalk */
    platform: string
    /** 归一化事件类型 */
    eventType: string
    /** 上游原生消息 ID（展示/排障，未必全局唯一） */
    externalId: string | null
    /** 会话/群/chat ID */
    conversationId: string | null
    /** 发送者标识 */
    senderId: string | null
    /** 消息秒级时间戳 */
    msgTimestamp: number | null
    /** 是否含媒体：1 是 | 0 否 */
    hasMedia: 0 | 1
    /** 上游原始整包 JSON（调用方已 JSON.stringify） */
    rawJson: string
    /** 归一化附件列表 JSON 数组；无附件为 null */
    mediaJson: string | null
    /** 采集路径：sse 实时 | catchup 补偿 */
    ingestPath: 'sse' | 'catchup'
}

export class QueueStore {
    private readonly insertStmt: BetterSqlite3.Statement
    private readonly countStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.insertStmt = db.prepare(`
            INSERT INTO queue(
              channel_id, platform, event_type, external_id, conversation_id, sender_id,
              msg_timestamp, has_media, raw_json, media_json, ingest_path,
              status, attempts, created_at, updated_at
            ) VALUES (
              @channelId, @platform, @eventType, @externalId, @conversationId, @senderId,
              @msgTimestamp, @hasMedia, @rawJson, @mediaJson, @ingestPath,
              'pending', 0, @now, @now
            )
        `)
        this.countStmt = db.prepare('SELECT COUNT(*) AS c FROM queue WHERE status = ?')
    }

    /** 入队一条 pending 消息 */
    enqueue(input: EnqueueInput, now: number): void {
        this.insertStmt.run({ ...input, now })
    }

    /** 某状态的队列条数（默认 pending），用于状态快照展示积压 */
    countByStatus(status: string = 'pending'): number {
        return (this.countStmt.get(status) as { c: number }).c
    }
}
```

**Step 4: 跑测试确认通过**

Run: `npm -w server run test -- queue`
Expected: PASS。

**Step 5: Commit**

```bash
git add server/src/db/queue.ts server/src/db/queue.test.ts
git commit -m "feat(db): QueueStore 改为归一化信封 + 原始 blob 入队"
```

---

## Task 6: 精简 MetaStore 的 META_KEYS

**Files:**
- Modify: `server/src/db/meta.ts:4-17`

**说明：** `installTime` / `lastSyncTimestamp` / `lastSyncRawid` 已迁往 `channel_state`，从 `META_KEYS` 移除，避免误用。`MetaStore` 的 get/set 逻辑不变，仅保留 `schemaVersion`。

**Step 1: 改 meta.ts**

把 `server/src/db/meta.ts` 顶部的 `META_KEYS` 块（第 4-17 行）替换为：

```ts
/** 全局单例 meta 键（仅放真正全局、与具体 channel 无关的键） */
export const META_KEYS = {
    schemaVersion: 'schemaVersion',
} as const
```

文件第 1 行注释顺带更新为：

```ts
// meta 表访问：全局单例 k-v 状态（仅 schemaVersion 等全局键；按 channel 的水位见 channel_state）。
```

`MetaStore` 类（get/getNumber/set）保持不变。

**Step 2: 构建确认无类型错误**

此改动会让仍引用旧键的 `syncService.ts` 编译失败——这是预期的，Task 9 修复。本步只确认 `meta.ts` 自身无误：
Run: `npm -w server run test -- queue`（确认数据层测试仍过，间接验证 meta 模块可加载）
Expected: PASS。

> 注：暂不跑 `npm -w server run build`，因为 `syncService.ts` 此时仍引用旧 `META_KEYS`，会到 Task 9 才修好。

**Step 3: Commit**

```bash
git add server/src/db/meta.ts
git commit -m "refactor(db): META_KEYS 仅保留 schemaVersion，水位迁往 channel_state"
```

---

## Task 7: 上游 adapter 抽象 + WeflowAdapter

**Files:**
- Create: `server/src/upstream/types.ts`
- Create: `server/src/weflow/adapter.ts`
- Create: `server/src/weflow/adapter.test.ts`

**Step 1: 写失败测试**

`server/src/weflow/adapter.test.ts`：

```ts
import { describe, it, expect } from 'vitest'
import { WeflowAdapter, WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from './adapter.js'
import type { WeflowMessage } from './restClient.js'

const adapter = new WeflowAdapter()

function msg(over: Partial<WeflowMessage> = {}): WeflowMessage {
    return { serverId: 'srv-1', createTime: 1700000000, senderUsername: 'bob', content: 'hi', ...over }
}

describe('WeflowAdapter', () => {
    it('常量符合预期', () => {
        expect(WEFLOW_PLATFORM).toBe('weflow')
        expect(WEFLOW_CHANNEL_ID).toBe('weflow:default')
        expect(adapter.platform).toBe('weflow')
    })

    it('归一化基本字段', () => {
        const n = adapter.normalize({ talker: 'alice', message: msg() })
        expect(n.dedupKey).toBe('srv-1')
        expect(n.externalId).toBe('srv-1')
        expect(n.conversationId).toBe('alice')
        expect(n.senderId).toBe('bob')
        expect(n.msgTimestamp).toBe(1700000000)
        expect(n.media).toEqual([])
        expect(JSON.parse(n.rawJson).serverId).toBe('srv-1')
    })

    it('serverId 缺失时回退 localId 作为 dedupKey', () => {
        const n = adapter.normalize({ talker: 'alice', message: msg({ serverId: undefined, localId: 42 }) })
        expect(n.dedupKey).toBe('42')
        expect(n.externalId).toBe('42')
    })

    it('含媒体时产出 media 描述符', () => {
        const n = adapter.normalize({ talker: 'alice', message: msg({ mediaType: 'image', mediaFileName: 'a.png', mediaUrl: 'http://x/a.png' }) })
        expect(n.media).toHaveLength(1)
        expect(n.media[0].mediaKey).toBe('srv-1:a.png')
        expect(n.media[0].fileName).toBe('a.png')
        expect(n.media[0].sourceRef).toBe('http://x/a.png')
    })
})
```

**Step 2: 跑测试确认失败**

Run: `npm -w server run test -- adapter`
Expected: FAIL（找不到 `./adapter.js`）。

**Step 3: 实现 upstream 类型**

`server/src/upstream/types.ts`：

```ts
// 上游适配器抽象：把任意平台的原始消息翻成 bridge 的归一化信封（设计文档 §4）。
// 这是「未知结构」与「稳定 schema」之间的唯一翻译层。

/** 归一化附件描述符（落 queue.media_json 的单个元素） */
export interface MediaDescriptor {
    /** 媒体幂等键，对应 media_cache 的 (channel_id, media_key) */
    mediaKey: string
    /** 原始文件名（可空：语音/贴纸等可能无名） */
    fileName: string | null
    /** MIME 类型 */
    mime: string | null
    /** 文件大小（字节） */
    size: number | null
    /** 从上游下载该附件所需的原始引用（平台特有，如 url/fileId/path） */
    sourceRef: string | null
}

/** 归一化消息信封 */
export interface NormalizedMessage {
    /** 本 channel 内唯一的幂等键（去重/媒体都靠它派生） */
    dedupKey: string
    /** 归一化事件类型，如 message.new */
    eventType: string
    /** 上游原生消息 ID（展示/排障，未必全局唯一） */
    externalId: string | null
    /** 会话/群/chat ID */
    conversationId: string | null
    /** 发送者标识 */
    senderId: string | null
    /** 消息秒级时间戳 */
    msgTimestamp: number | null
    /** 归一化附件列表（空数组表示无媒体） */
    media: MediaDescriptor[]
    /** 上游原始整包（通常 JSON.stringify(原始消息)） */
    rawJson: string
}

/** 上游适配器：每个平台实现一个 */
export interface UpstreamAdapter<TRaw = unknown> {
    readonly platform: string
    normalize(raw: TRaw): NormalizedMessage
}
```

**Step 4: 实现 WeflowAdapter**

`server/src/weflow/adapter.ts`：

```ts
// WeFlow 上游适配器：把 WeflowMessage 归一化成 bridge 信封（设计文档 §4）。
import type { WeflowMessage } from './restClient.js'
import type { MediaDescriptor, NormalizedMessage, UpstreamAdapter } from '../upstream/types.js'

/** 平台类型常量 */
export const WEFLOW_PLATFORM = 'weflow'
/** 单实例阶段固定的连接实例 ID（多 channel 配置是后续功能） */
export const WEFLOW_CHANNEL_ID = 'weflow:default'

/** WeflowAdapter 的原始输入：会话 ID + 单条消息 */
export interface WeflowRawInput {
    talker: string
    message: WeflowMessage
}

export class WeflowAdapter implements UpstreamAdapter<WeflowRawInput> {
    readonly platform = WEFLOW_PLATFORM

    normalize(raw: WeflowRawInput): NormalizedMessage {
        const { talker, message } = raw
        // rawid 取 serverId（微信服务端消息 id，≈ SSE rawid），缺则回退 localId（链路文档 §11 待实测对齐）
        const externalId = String(message.serverId ?? message.localId ?? '').trim() || null
        return {
            dedupKey: externalId ?? '',
            eventType: 'message.new',
            externalId,
            conversationId: talker || null,
            senderId: message.senderUsername ?? null,
            msgTimestamp: typeof message.createTime === 'number' ? message.createTime : null,
            media: this.extractMedia(externalId, message),
            rawJson: JSON.stringify(message),
        }
    }

    /** 从 WeflowMessage 的媒体字段抽出归一化附件（当前每条消息至多一个媒体） */
    private extractMedia(externalId: string | null, message: WeflowMessage): MediaDescriptor[] {
        if (!message.mediaType && !message.mediaFileName && !message.mediaUrl) return []
        const fileName = message.mediaFileName ?? null
        return [{
            mediaKey: `${externalId ?? 'unknown'}:${fileName ?? 'media'}`,
            fileName,
            mime: null,
            size: null,
            sourceRef: message.mediaUrl ?? message.mediaLocalPath ?? null,
        }]
    }
}
```

**Step 5: 跑测试确认通过**

Run: `npm -w server run test -- adapter`
Expected: PASS。

**Step 6: Commit**

```bash
git add server/src/upstream/types.ts server/src/weflow/adapter.ts server/src/weflow/adapter.test.ts
git commit -m "feat(upstream): 新增 adapter 抽象与 WeflowAdapter 归一化实现"
```

---

## Task 8: Db 聚合接入 ChannelStateStore + 内存库工厂

**Files:**
- Modify: `server/src/db/database.ts`

**Step 1: 改 database.ts**

在 `Db` 类引入 `channelState`，并加一个测试用的内存库工厂 `openMemory()`：

- 顶部 import 增加：
  ```ts
  import { ChannelStateStore } from './channelState.js'
  ```
- 类字段与构造里增加 `channelState`：
  ```ts
      readonly channelState: ChannelStateStore
  ```
  ```ts
      private constructor(raw: BetterSqlite3.Database) {
          this.raw = raw
          this.meta = new MetaStore(raw)
          this.channelState = new ChannelStateStore(raw)
          this.dedup = new DedupStore(raw)
          this.queue = new QueueStore(raw)
      }
  ```
- 在 `open()` 之后追加内存库工厂（供 syncService 集成测试用，不碰真实文件系统）：
  ```ts
      /** 打开内存库（测试用）：跳过建目录与 WAL，仅开外键 + 迁移 */
      static openMemory(): Db {
          const raw = new BetterSqlite3(':memory:')
          raw.pragma('foreign_keys = ON')
          migrate(raw)
          return new Db(raw)
      }
  ```

**Step 2: 构建确认（仍预期 syncService 报错）**

Run: `npm -w server run test -- channelState queue dedup schema adapter`
Expected: 全部 PASS（确认 Db 依赖的 store 都在）。

> `npm -w server run build` 此时仍会因 `syncService.ts` 报错——Task 9 修复。

**Step 3: Commit**

```bash
git add server/src/db/database.ts
git commit -m "feat(db): Db 聚合接入 ChannelStateStore 并新增内存库工厂"
```

---

## Task 9: 重构 syncService 走 adapter + 新 store（含集成测试）

**Files:**
- Modify: `server/src/sync/syncService.ts`
- Create: `server/src/sync/syncService.test.ts`

**改造要点：**
1. 用 `WeflowAdapter` 归一化，落 `WEFLOW_CHANNEL_ID` / `WEFLOW_PLATFORM`。
2. dedup/queue 改新签名；水位与首装改读写 `db.channelState`。
3. `runFullSync` / `runCompensation` 由 `private async` 改为 **public async**（便于集成测试 await）。
4. 注入可替换的 client 工厂（`createClient`），默认 `new WeflowRestClient(cfg)`，使测试可喂桩数据。

**Step 1: 写失败的集成测试**

`server/src/sync/syncService.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db } from '../db/database.js'
import { SyncService } from './syncService.js'
import { WEFLOW_CHANNEL_ID } from '../weflow/adapter.js'
import type { WeflowSession, MessagesPage } from '../weflow/restClient.js'

// 最小桩 client：按 talker 返回预设消息页
function stubClient(sessions: WeflowSession[], pages: Record<string, MessagesPage>) {
    return {
        listSessions: () => Promise.resolve(sessions),
        fetchMessagesPage: (talker: string) => Promise.resolve(pages[talker] ?? { messages: [], hasMore: false }),
    }
}

function deps(db: Db, client: ReturnType<typeof stubClient>) {
    const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never
    return {
        store: { get: () => ({ weflow: { host: 'h', port: 1, accessToken: 't' } }) } as never,
        db,
        log: noopLog,
        alert: { send() {} },
        createClient: () => client as never,
    }
}

describe('SyncService 全量同步', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('首装全量：去重入队 + 推进水位 + 记首装', async () => {
        const client = stubClient(
            [{ username: 'alice' }],
            { alice: { messages: [
                { serverId: 's1', createTime: 100, content: 'a' },
                { serverId: 's2', createTime: 200, content: 'b' },
                { serverId: 's1', createTime: 100, content: 'a' }, // 重复
            ], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        await svc.runFullSync()

        expect(db.queue.countByStatus('pending')).toBe(2)
        expect(db.channelState.get(WEFLOW_CHANNEL_ID)?.lastSyncTimestamp).toBe(200)
        expect(db.channelState.getInstallTime(WEFLOW_CHANNEL_ID)).not.toBeNull()
        const status = svc.getStatus()
        expect(status.enqueued).toBe(2)
        expect(status.duplicates).toBe(1)
    })
})
```

**Step 2: 跑测试确认失败**

Run: `npm -w server run test -- syncService`
Expected: FAIL（`createClient` 不被支持、`runFullSync` 非 public、旧 store 签名等）。

**Step 3: 重构 syncService.ts**

按下列改动修改 `server/src/sync/syncService.ts`：

1. import 调整：
   ```ts
   import { WeflowRestClient, type WeflowMessage, type WeflowSession, type MessagesPage } from '../weflow/restClient.js'
   import { WeflowAdapter, WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'
   ```
   删除 `import { META_KEYS } from '../db/meta.js'`。

2. 定义最小 client 接口 + 在 deps 加注入：
   ```ts
   /** 同步所需的 WeFlow 拉取能力（便于测试注入桩） */
   export interface WeflowClientLike {
       listSessions(): Promise<WeflowSession[]>
       fetchMessagesPage(talker: string, start: number, offset: number, limit?: number): Promise<MessagesPage>
   }

   export interface SyncServiceDeps {
       store: ConfigStore
       db: Db
       log: Logger
       alert: AlertChannel
       /** client 工厂，默认 new WeflowRestClient(cfg)；测试可注入桩 */
       createClient?: (cfg: WeflowConfig) => WeflowClientLike
   }
   ```

3. 类字段加 adapter 与 client 工厂，构造里初始化：
   ```ts
       private readonly adapter = new WeflowAdapter()
       private readonly createClient: (cfg: WeflowConfig) => WeflowClientLike

       constructor(deps: SyncServiceDeps) {
           this.store = deps.store
           this.db = deps.db
           this.log = deps.log
           this.alert = deps.alert
           this.createClient = deps.createClient ?? ((cfg) => new WeflowRestClient(cfg))
       }
   ```

4. `onConnected` 的首装判定改读 channelState：
   ```ts
       onConnected(reason: SyncReason): void {
           if (this.progress.running) {
               this.log.warn('[sync] 已有同步在进行，跳过本次触发')
               return
           }
           const installed = this.db.channelState.getInstallTime(WEFLOW_CHANNEL_ID) !== null
           if (reason === 'initial' && !installed) {
               void this.runFullSync()
           } else {
               void this.runCompensation()
           }
       }
   ```

5. `runFullSync` / `runCompensation` 改为 **public async**，内部：
   - 建 client 改成 `const client = this.createClient(cfg)`。
   - 全量里首装写入改成：
     ```ts
     if (this.db.channelState.getInstallTime(WEFLOW_CHANNEL_ID) === null) {
         this.db.channelState.markInstalled(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, nowSec())
     }
     ```
   - 补偿起点改成：
     ```ts
     let start = sinceOverride
         ?? this.db.channelState.get(WEFLOW_CHANNEL_ID)?.lastSyncTimestamp
         ?? this.db.channelState.getInstallTime(WEFLOW_CHANNEL_ID)
         ?? nowSec()
     ```

6. `pullSession` 的 `client` 形参类型从 `WeflowRestClient` 改为 `WeflowClientLike`。

7. `processMessage` 改走 adapter + 新 store：
   ```ts
       private processMessage(
           talker: string,
           msg: WeflowMessage,
           now: number,
           watermark: { ts: number, rawid: string },
       ): void {
           const n = this.adapter.normalize({ talker, message: msg })
           if (!n.dedupKey) return
           this.progress.messagesPulled += 1

           if (!this.db.dedup.markIfNew(WEFLOW_CHANNEL_ID, n.dedupKey, now)) {
               this.progress.duplicates += 1
               return
           }

           this.db.queue.enqueue({
               channelId: WEFLOW_CHANNEL_ID,
               platform: WEFLOW_PLATFORM,
               eventType: n.eventType,
               externalId: n.externalId,
               conversationId: n.conversationId,
               senderId: n.senderId,
               msgTimestamp: n.msgTimestamp,
               hasMedia: n.media.length > 0 ? 1 : 0,
               rawJson: n.rawJson,
               mediaJson: n.media.length > 0 ? JSON.stringify(n.media) : null,
               ingestPath: 'catchup',
           }, now)
           this.progress.enqueued += 1

           if (n.msgTimestamp !== null && n.msgTimestamp > watermark.ts) {
               watermark.ts = n.msgTimestamp
               watermark.rawid = n.dedupKey
           }
       }
   ```

8. `advanceWatermark` 改写 channelState：
   ```ts
       private advanceWatermark(watermark: { ts: number, rawid: string }): void {
           if (watermark.ts > 0) {
               this.db.channelState.advanceWatermark(
                   WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, watermark.ts, watermark.rawid, nowSec(),
               )
           }
       }
   ```

**Step 4: 跑测试确认通过**

Run: `npm -w server run test -- syncService`
Expected: PASS。

**Step 5: 全量构建 + lint**

Run: `npm -w server run build`
Expected: 无类型错误（syncService 已不再引用旧 `META_KEYS`/旧 store 签名）。

Run: `npm run lint`
Expected: 零报错。

**Step 6: Commit**

```bash
git add server/src/sync/syncService.ts server/src/sync/syncService.test.ts
git commit -m "feat(sync): syncService 走 WeflowAdapter + channel_state 水位"
```

---

## Task 10: 全量验证 + 收尾

**Files:**
- 无新增；仅运行校验，必要时修小问题。

**Step 1: 跑完整测试套件**

Run: `npm -w server run test`
Expected: 所有用例 PASS（schema / channelState / dedup / queue / adapter / syncService）。

**Step 2: 全量构建**

Run: `npm run build`
Expected: server 与 web 均构建成功。

**Step 3: lint**

Run: `npm run lint`
Expected: 零报错。

**Step 4: 手动冒烟（可选但推荐）**

删除本机旧库后启动 dev，确认建库与连接流程不报错（迁移已 DROP 重建，通常无需手删；如遇异常再删）：
- 旧库路径：`%LOCALAPPDATA%\weflow-bridge\bridge.db`
- Run: `npm run dev`，观察 server 日志无 SQL/迁移错误。

**Step 5: 用 DB 工具确认字段备注可见**

用 DB Browser for SQLite 打开 `bridge.db`，确认 `queue` / `channel_state` 等表的字段在 schema 视图里带中文备注（验证「查库可见字段含义」这一原始诉求）。

**Step 6: 终审 commit（若 Step 1-3 有小修）**

```bash
git add -A
git commit -m "chore: 多上游 schema 重构全量校验通过"
```

---

## 范围之外（后续独立功能，本计划不做）

- **SSE 实时入队**：当前 SSE 路径尚未接入 queue（`ingest_path='sse'` 为预留）。实时入队 + 走 adapter 是独立任务。
- **多 channel 配置 UI/接口**：`channel_id` 现固定 `weflow:default`；支持同平台多账号需在配置层与前端补 channel 管理。
- **TG / 飞书 / 钉钉 adapter**：各自实现 `UpstreamAdapter`，待对接拿到真实载荷后落地。
- **audit 写入与 dlq 消费**：表/视图已建好，写入方（审计埋点）与读取方（forwarder/死信处理）是 forwarder 模块的事。
- **media_cache 实际读写**：随 forwarder 媒体上传落地。
