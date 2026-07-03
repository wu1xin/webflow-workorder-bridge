# 下游 forwarder 核心闭环 实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 新增 forwarder（queue worker）消费 `queue` 的 pending 文本消息，发往下游 `receiveMessage`，按 `code==1` 判定成功，含重试/退避/熔断/死信、投递断点推进，并补齐下游客户端与简单档配置面。

**Architecture:** 单进程单 worker，串行取件（`has_media=0`、按 id 保序）；`kick()`（入队/启动/开关）+ 低频兜底 tick 驱动，排空即休眠。成功 = HTTP 200 且 `body.code===1`；`receiveMessage` 客户端只在传输层错误抛异常、`code!=1` 返回给 forwarder 决策。断点分两个水位：补偿起点保持 `last_sync_timestamp`（不动），forwarder 只推进新的投递标记 `breakpoint_timestamp`。媒体消息一期留 pending（worker 不取）。下游连接信息与 forwarder 调参走 `config.json` + 校验 + PUT，前端复用配置页加「下游」分组 + ping 测连 + 转发开关。

**Tech Stack:** Node.js 20 + TypeScript（ESM）、better-sqlite3、Fastify、undici/fetch、Vue 3 `<script setup>` + Element Plus + Pinia、vitest、ESLint flat config。

> 设计依据：[2026-07-03-下游forwarder对接-design.md](2026-07-03-下游forwarder对接-design.md)
> 下游契约：[docs/weflow-对接接口规格说明书（work-order-system侧）.md](../weflow-对接接口规格说明书（work-order-system侧）.md)
>
> **代码风格强约束（CLAUDE.md）**：语句末尾**不加分号**、字符串**单引号**；异步**优先 Promise 链** `fn().then().catch()`，仅当封装函数内多异步操作有**顺序依赖**时才用 async/await（HTTP `fetch→json` 属顺序依赖，可用 async/await）。每个任务完成 `npm run lint` 必须通过。
>
> **通用命令**
> - 跑单个测试文件：`npm -w server run test -- src/<path>.test.ts`
> - 跑全部后端测试：`npm -w server run test`
> - 构建 shared（改了 shared 类型后必跑）：`npm -w shared run build`
> - 全量构建：`npm run build`
> - Lint：`npm run lint`（自动修复 `npm run lint:fix`）
>
> **在当前分支 `rewrite/v2` 直接实现，不开 worktree。**

---

## Task 1: schema 升 v5 —— channel_state 增投递断点列

**Files:**
- Modify: `server/src/db/schema.ts`
- Test: `server/src/db/schema.test.ts`

**Step 1: 改测试（先失败）** — 编辑 `server/src/db/schema.test.ts`

1. 顶部 `describe` 版本号相关标题/断言：把 `SCHEMA_VERSION 为 4`/`'4'` 的用例改为 `5`/`'5'`（沿用文件里既有写法定位）。
2. 新增两个用例：

```ts
it('channel_state 含投递断点列', () => {
    const cols = columns(db, 'channel_state')
    expect(cols).toEqual(expect.arrayContaining(['breakpoint_timestamp', 'breakpoint_rawid']))
})

it('v4→v5 增量升级：补建断点列且保留既有 channel_state 数据', () => {
    // 用迁移好的 v5 库模拟老 v4 库：重建无断点列的 channel_state + 回退版本 + 塞一行
    db.exec('DROP TABLE channel_state')
    db.exec(`CREATE TABLE channel_state (
      channel_id TEXT PRIMARY KEY, platform TEXT NOT NULL, install_time INTEGER,
      last_sync_timestamp INTEGER, last_sync_rawid TEXT, updated_at INTEGER NOT NULL
    )`)
    db.prepare(`INSERT INTO channel_state(channel_id, platform, last_sync_timestamp, updated_at)
                VALUES ('weflow:default','weflow',123,1)`).run()
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('4', 'schemaVersion')

    migrate(db)

    expect(columns(db, 'channel_state')).toEqual(expect.arrayContaining(['breakpoint_timestamp', 'breakpoint_rawid']))
    const row = db.prepare('SELECT last_sync_timestamp t FROM channel_state WHERE channel_id = ?').get('weflow:default') as { t: number }
    expect(row.t).toBe(123)
    const ver = db.prepare('SELECT value FROM meta WHERE key = ?').get('schemaVersion') as { value: string }
    expect(ver.value).toBe('5')
})
```

> 若 `columns()` 帮手在文件里叫别的名字，按现有工具函数改（参考 chat_group 那期的 `columns/exists`）。

**Step 2: 跑测试确认失败** — `npm -w server run test -- src/db/schema.test.ts` → FAIL

**Step 3: 实现** — 编辑 `server/src/db/schema.ts`

1. `export const SCHEMA_VERSION = 4` → `= 5`。
2. DDL 里 `channel_state` 定义末尾（`updated_at` 行后）追加两列（供全新库带出）：

```sql
  last_sync_rawid     TEXT,                 -- 水位对应的上游消息 ID（同秒多条时精确定位）
  breakpoint_timestamp INTEGER,             -- 投递断点：最后成功转发（code==1）消息的秒级时间戳
  breakpoint_rawid     TEXT,                -- 投递断点对应 rawid（同秒多条精确定位）
  updated_at          INTEGER NOT NULL      -- 状态更新时间（秒级时间戳）
```

3. 顶部注释补一句「v5 给 channel_state 加投递断点列 breakpoint_timestamp/breakpoint_rawid」。
4. `migrate` 里，在既有 `queue.revocable_until` 自愈块之后、`db.exec(DDL)` 之前，加 channel_state 断点列的同款「按列是否存在」自愈块（channel_state 在 v1→v2 不被 DROP、会留存，故需 ALTER 补列）：

```ts
        // channel_state 断点列（v5）：老库有表无列 → 补列；全新库此时无表，跳过由 DDL 带出。
        const csExists = db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'channel_state')
        if (csExists) {
            const csCols = (db.pragma('table_info(channel_state)') as Array<{ name: string }>).map(c => c.name)
            if (!csCols.includes('breakpoint_timestamp')) db.exec('ALTER TABLE channel_state ADD COLUMN breakpoint_timestamp INTEGER')
            if (!csCols.includes('breakpoint_rawid')) db.exec('ALTER TABLE channel_state ADD COLUMN breakpoint_rawid TEXT')
        }
```

**Step 4: 跑测试确认通过** — `npm -w server run test -- src/db/schema.test.ts` → PASS

**Step 5: 提交**

```bash
git add server/src/db/schema.ts server/src/db/schema.test.ts
git commit -m "feat(db): schema 升 v5，channel_state 增投递断点列 breakpoint_timestamp/rawid

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: ChannelStateStore 读断点 + advanceBreakpoint

**Files:**
- Modify: `server/src/db/channelState.ts`
- Test: `server/src/db/channelState.test.ts`

**Step 1: 写失败测试** — 在 `channelState.test.ts` 追加：

```ts
it('advanceBreakpoint 仅在更大时推进，get 能读回', () => {
    store.advanceBreakpoint(CH, PF, 100, 'r1', 1)
    expect(store.get(CH)?.breakpointTimestamp).toBe(100)
    store.advanceBreakpoint(CH, PF, 50, 'r0', 2) // 更小，不动
    expect(store.get(CH)?.breakpointTimestamp).toBe(100)
    expect(store.get(CH)?.breakpointRawid).toBe('r1')
    store.advanceBreakpoint(CH, PF, 200, 'r2', 3)
    expect(store.get(CH)?.breakpointTimestamp).toBe(200)
    expect(store.get(CH)?.breakpointRawid).toBe('r2')
})

it('断点与同步水位互不干扰', () => {
    store.advanceWatermark(CH, PF, 500, 'w', 1)
    store.advanceBreakpoint(CH, PF, 100, 'b', 2)
    const s = store.get(CH)
    expect(s?.lastSyncTimestamp).toBe(500)
    expect(s?.breakpointTimestamp).toBe(100)
})
```

> `CH`/`PF` 常量沿用该测试文件顶部既有定义（如无则加 `const CH = 'weflow:default'`, `const PF = 'weflow'`）。

**Step 2: 跑测试确认失败** — `npm -w server run test -- src/db/channelState.test.ts` → FAIL

**Step 3: 实现** — 编辑 `server/src/db/channelState.ts`

1. `ChannelState` 接口加：`breakpointTimestamp: number | null`、`breakpointRawid: string | null`。
2. `Row` 接口加：`breakpoint_timestamp: number | null`、`breakpoint_rawid: string | null`。
3. `getStmt` 的 SELECT 列补 `breakpoint_timestamp, breakpoint_rawid`。
4. `get()` 返回值补两字段。
5. 构造函数加 `breakpointStmt`：

```ts
        this.breakpointStmt = db.prepare(`
            INSERT INTO channel_state(channel_id, platform, breakpoint_timestamp, breakpoint_rawid, updated_at)
            VALUES (@channelId, @platform, @ts, @rawid, @now)
            ON CONFLICT(channel_id) DO UPDATE SET
              breakpoint_timestamp = @ts,
              breakpoint_rawid     = @rawid,
              updated_at           = @now
        `)
```

6. 加方法：

```ts
    /** 推进投递断点：仅当 ts 大于当前断点时写入（单调，绝不回退） */
    advanceBreakpoint(channelId: string, platform: string, ts: number, rawid: string, now: number): void {
        const current = this.get(channelId)?.breakpointTimestamp ?? 0
        if (ts > current) {
            this.breakpointStmt.run({ channelId, platform, ts, rawid, now })
        }
    }
```

**Step 4: 跑测试确认通过** — PASS

**Step 5: 提交**

```bash
git add server/src/db/channelState.ts server/src/db/channelState.test.ts
git commit -m "feat(db): ChannelStateStore 读投递断点并新增 advanceBreakpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: QueueStore worker 取件与状态机方法

**Files:**
- Modify: `server/src/db/queue.ts`
- Test: `server/src/db/queue.test.ts`

**Step 1: 写失败测试** — 在 `queue.test.ts` 追加（沿用文件里既有 `enqueue` 帮手/常量；下例假设有 `CH='weflow:default'` 与 `enqueueOne(overrides)` 便捷函数，无则用 `db.queue.enqueue({...}, now)` 手写整包）：

```ts
describe('QueueStore worker 方法', () => {
    // 便捷入队：默认文本消息
    function enq(over: Partial<EnqueueInput> = {}, now = 1000) {
        db.queue.enqueue({
            channelId: CH, platform: 'weflow', eventType: 'message.new',
            externalId: 's1', conversationId: 'g@chatroom', senderId: null,
            msgTimestamp: 100, hasMedia: 0, rawJson: '{"a":1}', mediaJson: null,
            ingestPath: 'catchup', revocableUntil: null, ...over,
        }, now)
    }

    it('claimNext 取最早 pending 文本并置 sending；跳过媒体行', () => {
        enq({ externalId: 'm1', hasMedia: 1 })          // 媒体：应被跳过
        enq({ externalId: 't1', hasMedia: 0 })
        const c = db.queue.claimNext(CH, 2000)
        expect(c?.externalId).toBe('t1')
        expect(db.queue.countByStatus('sending')).toBe(1)
        expect(db.queue.countByStatus('pending')).toBe(1) // 媒体行仍 pending
    })

    it('claimNext 跳过未到期（next_attempt_at>now）的行', () => {
        enq({ externalId: 't1' })
        const c1 = db.queue.claimNext(CH, 2000)!
        db.queue.markRetry(c1.id, { failCode: 0, retryable: 1, lastError: 'x', nextAttemptAt: 9999 }, 2000)
        expect(db.queue.claimNext(CH, 3000)).toBeNull()      // 未到期
        expect(db.queue.claimNext(CH, 10000)?.externalId).toBe('t1') // 到期可再取
    })

    it('markDone → done', () => {
        enq(); const c = db.queue.claimNext(CH, 2000)!
        db.queue.markDone(c.id, 2000)
        expect(db.queue.countByStatus('done')).toBe(1)
    })

    it('markRetry 回 pending 且 attempts+1', () => {
        enq(); const c = db.queue.claimNext(CH, 2000)!
        db.queue.markRetry(c.id, { failCode: 1005, retryable: 1, lastError: 'boom', nextAttemptAt: 2005 }, 2000)
        const d = db.queue.getById(CH, c.id)!
        expect(d.status).toBe('pending')
        expect(d.attempts).toBe(1)
    })

    it('markDead → dead 且 attempts+1', () => {
        enq(); const c = db.queue.claimNext(CH, 2000)!
        db.queue.markDead(c.id, { failCode: 1002, retryable: 0, lastError: 'bad' }, 2000)
        const d = db.queue.getById(CH, c.id)!
        expect(d.status).toBe('dead')
        expect(d.attempts).toBe(1)
    })

    it('resetStuck 把残留 sending 全部回 pending', () => {
        enq({ externalId: 'a' }); enq({ externalId: 'b' })
        db.queue.claimNext(CH, 2000); db.queue.claimNext(CH, 2000)
        expect(db.queue.countByStatus('sending')).toBe(2)
        db.queue.resetStuck(CH, 3000)
        expect(db.queue.countByStatus('sending')).toBe(0)
        expect(db.queue.countByStatus('pending')).toBe(2)
    })

    it('retryDead 仅对 dead 生效：回 pending、清计数/错误', () => {
        enq(); const c = db.queue.claimNext(CH, 2000)!
        db.queue.markDead(c.id, { failCode: 1002, retryable: 0, lastError: 'bad' }, 2000)
        expect(db.queue.retryDead(CH, c.id, 4000)).toBe(true)
        const d = db.queue.getById(CH, c.id)!
        expect(d.status).toBe('pending')
        expect(d.attempts).toBe(0)
        expect(d.lastError).toBeNull()
        expect(db.queue.retryDead(CH, c.id, 5000)).toBe(false) // 已非 dead
    })
})
```

> 顶部需 `import type { EnqueueInput } from './queue.js'`（若已导出）；`CH`/`db` 沿用该文件既有 setup。

**Step 2: 跑测试确认失败** — FAIL（方法不存在）

**Step 3: 实现** — 编辑 `server/src/db/queue.ts`

1. 顶部导出取件返回类型：

```ts
/** claimNext 返回：worker 发送所需的最小字段 */
export interface ClaimedMessage {
    id: number
    eventType: string
    rawJson: string
    msgTimestamp: number | null
    externalId: string | null
}
```

2. 类内加 `private readonly db: BetterSqlite3.Database`，构造函数首行 `this.db = db`。
3. 构造函数新增 prepared statements：

```ts
        this.pickStmt = db.prepare(`
            SELECT id, event_type, raw_json, msg_timestamp, external_id FROM queue
            WHERE channel_id = @channelId AND status = 'pending' AND has_media = 0
              AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
            ORDER BY id LIMIT 1
        `)
        this.toSendingStmt = db.prepare('UPDATE queue SET status = \'sending\', updated_at = @now WHERE id = @id')
        this.doneStmt = db.prepare('UPDATE queue SET status = \'done\', updated_at = @now WHERE id = @id')
        this.retryStmt = db.prepare(`
            UPDATE queue SET status = 'pending', attempts = attempts + 1,
              next_attempt_at = @nextAttemptAt, fail_code = @failCode, retryable = @retryable,
              last_error = @lastError, updated_at = @now
            WHERE id = @id
        `)
        this.deadStmt = db.prepare(`
            UPDATE queue SET status = 'dead', attempts = attempts + 1,
              fail_code = @failCode, retryable = @retryable, last_error = @lastError, updated_at = @now
            WHERE id = @id
        `)
        this.resetStuckStmt = db.prepare(
            'UPDATE queue SET status = \'pending\', updated_at = @now WHERE channel_id = @channelId AND status = \'sending\'',
        )
        this.retryDeadStmt = db.prepare(`
            UPDATE queue SET status = 'pending', attempts = 0, next_attempt_at = NULL,
              fail_code = NULL, retryable = NULL, last_error = NULL, updated_at = @now
            WHERE channel_id = @channelId AND id = @id AND status = 'dead'
        `)
```

4. 加方法：

```ts
    /** 取下一条待投（pending 文本、已到期），原子置 sending；无则 null（事务保证单进程内一致） */
    claimNext(channelId: string, now: number): ClaimedMessage | null {
        return this.db.transaction(() => {
            const row = this.pickStmt.get({ channelId, now }) as {
                id: number, event_type: string, raw_json: string, msg_timestamp: number | null, external_id: string | null
            } | undefined
            if (!row) return null
            this.toSendingStmt.run({ id: row.id, now })
            return { id: row.id, eventType: row.event_type, rawJson: row.raw_json, msgTimestamp: row.msg_timestamp, externalId: row.external_id }
        })()
    }

    /** 转发成功：置 done */
    markDone(id: number, now: number): void {
        this.doneStmt.run({ id, now })
    }

    /** 可重试失败：attempts+1、设退避时间、回 pending */
    markRetry(id: number, info: { failCode: number | null, retryable: 0 | 1, lastError: string, nextAttemptAt: number }, now: number): void {
        this.retryStmt.run({ id, now, ...info })
    }

    /** 终止失败：attempts+1、置 dead */
    markDead(id: number, info: { failCode: number | null, retryable: 0 | 1, lastError: string }, now: number): void {
        this.deadStmt.run({ id, now, ...info })
    }

    /** 启动自愈：把残留 sending（崩溃遗留）全部回 pending */
    resetStuck(channelId: string, now: number): void {
        this.resetStuckStmt.run({ channelId, now })
    }

    /** 死信重投：dead → pending 并清计数/错误；非 dead 不动，返回是否命中 */
    retryDead(channelId: string, id: number, now: number): boolean {
        return this.retryDeadStmt.run({ channelId, id, now }).changes > 0
    }
```

（`claimNext`/`markDone` 等内部单条语句无顺序依赖，用 Promise 链或直接同步 API 即可——better-sqlite3 是同步的，此处无 async。事务用 `this.db.transaction`。）

**Step 4: 跑测试确认通过** — PASS

**Step 5: 提交**

```bash
git add server/src/db/queue.ts server/src/db/queue.test.ts
git commit -m "feat(db): QueueStore 增 worker 取件与状态机方法（claim/done/retry/dead/reset/retryDead）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: AuditStore（审计访问层）+ Db 聚合

**Files:**
- Create: `server/src/db/audit.ts`
- Modify: `server/src/db/database.ts`
- Test: `server/src/db/audit.test.ts`

> audit 表已在 schema DDL 中存在（Task 前先 `grep 'CREATE TABLE IF NOT EXISTS audit' server/src/db/schema.ts` 确认，见 design §9），本任务只补访问层，不动 schema。

**Step 1: 写失败测试** — 新建 `server/src/db/audit.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { AuditStore } from './audit.js'

const CH = 'weflow:default'

describe('AuditStore', () => {
    let db: BetterSqlite3.Database
    let store: AuditStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new AuditStore(db) })
    afterEach(() => db.close())

    it('record 落一行，stats 聚合成功/失败', () => {
        store.record({ channelId: CH, platform: 'weflow', eventType: 'message.new', externalId: 's1', conversationId: 'g', msgTimestamp: 100, isMedia: 0, fileId: null, code: 1, duplicate: 0, receivedAt: 101, latencyMs: 30, attempts: 0, ingestPath: 'catchup' }, 101)
        store.record({ channelId: CH, platform: 'weflow', eventType: 'message.new', externalId: 's2', conversationId: 'g', msgTimestamp: 100, isMedia: 0, fileId: null, code: 1002, duplicate: 0, receivedAt: 102, latencyMs: 40, attempts: 1, ingestPath: 'catchup' }, 102)
        expect(store.stats(CH)).toEqual({ totalSuccess: 1, totalFail: 1 })
    })
})
```

**Step 2: 跑测试确认失败** — FAIL（模块不存在）

**Step 3: 实现** — 新建 `server/src/db/audit.ts`

```ts
// audit 表访问：每条消息终态（done/dead）写一行，供状态统计与前端日志。表结构见 schema.ts。
import type BetterSqlite3 from 'better-sqlite3'

export interface AuditInput {
    channelId: string
    platform: string
    eventType: string
    externalId: string | null
    conversationId: string | null
    msgTimestamp: number | null
    isMedia: 0 | 1
    fileId: string | null
    code: number | null
    duplicate: 0 | 1 | null
    receivedAt: number | null
    latencyMs: number | null
    attempts: number
    ingestPath: string | null
}

export class AuditStore {
    private readonly insertStmt: BetterSqlite3.Statement
    private readonly statsStmt: BetterSqlite3.Statement

    constructor(db: BetterSqlite3.Database) {
        this.insertStmt = db.prepare(`
            INSERT INTO audit(channel_id, platform, event_type, external_id, conversation_id, msg_timestamp,
              is_media, file_id, code, duplicate, received_at, latency_ms, attempts, ingest_path, created_at)
            VALUES (@channelId, @platform, @eventType, @externalId, @conversationId, @msgTimestamp,
              @isMedia, @fileId, @code, @duplicate, @receivedAt, @latencyMs, @attempts, @ingestPath, @now)
        `)
        // 终态审计：code=1 计成功，其余（含 NULL 之外的失败码）计失败
        this.statsStmt = db.prepare(`
            SELECT
              SUM(CASE WHEN code = 1 THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN code IS NOT NULL AND code <> 1 THEN 1 ELSE 0 END) AS fail
            FROM audit WHERE channel_id = ?
        `)
    }

    /** 写一行终态审计 */
    record(input: AuditInput, now: number): void {
        this.insertStmt.run({ ...input, now })
    }

    /** 累计成功/失败数（状态快照用） */
    stats(channelId: string): { totalSuccess: number, totalFail: number } {
        const r = this.statsStmt.get(channelId) as { ok: number | null, fail: number | null }
        return { totalSuccess: r.ok ?? 0, totalFail: r.fail ?? 0 }
    }
}
```

**Step 4: Db 聚合** — 编辑 `server/src/db/database.ts`

1. import：`import { AuditStore } from './audit.js'`
2. 字段：`readonly audit: AuditStore`
3. 构造函数：`this.audit = new AuditStore(raw)`
4. 顶部注释「封装 meta / channelState / dedup / queue / chatGroup 五个数据访问对象」→ 补 `audit`（六个）。

**Step 5: 跑测试确认通过** — `npm -w server run test -- src/db/audit.test.ts` → PASS

**Step 6: 提交**

```bash
git add server/src/db/audit.ts server/src/db/audit.test.ts server/src/db/database.ts
git commit -m "feat(db): 新增 AuditStore（终态审计 + 成功/失败聚合）并接入 Db

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 下游客户端补 receiveMessage + ping

**Files:**
- Modify: `server/src/downstream/client.ts`
- Test: `server/src/downstream/client.test.ts`

**Step 1: 写失败测试** — 在 `client.test.ts` 追加：

```ts
describe('HttpDownstreamClient.receiveMessage', () => {
    function clientWith(fetchImpl: typeof fetch) {
        return new HttpDownstreamClient(CFG, undefined, { fetchImpl, now: () => 1750000000 })
    }

    it('code!==1 不抛错，原样返回 code/retryable 供 forwarder 决策', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ code: 1002, msg: '缺参', data: { retryable: false } }),
        })) as unknown as typeof fetch
        const ack = await clientWith(fetchImpl).receiveMessage({ event: 'message.new', data: { rawid: '1' } })
        expect(ack.code).toBe(1002)
        expect(ack.retryable).toBe(false)
    })

    it('code===1 解析 duplicate/message_id/received_at', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ code: 1, data: { message_id: 9, duplicate: true, received_at: 1750000001 } }),
        })) as unknown as typeof fetch
        const ack = await clientWith(fetchImpl).receiveMessage({ event: 'message.new', data: {} })
        expect(ack).toMatchObject({ code: 1, duplicate: true, messageId: 9, receivedAt: 1750000001 })
    })

    it('传输层错误（非200）抛异常，错误信息不含 token', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: false, status: 502, text: () => Promise.resolve('bad gateway'),
        })) as unknown as typeof fetch
        await expect(clientWith(fetchImpl).receiveMessage({ event: 'message.new', data: {} }))
            .rejects.toThrow(/502/)
    })

    it('URL 带 receiveMessage 端点与 task_white_token，body 为 {event,data} 信封', async () => {
        let captured: { url: string, body: string } | null = null
        const fetchImpl = ((url: string, init: { body: string }) => {
            captured = { url, body: init.body }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ code: 1, data: {} }) })
        }) as unknown as typeof fetch
        await clientWith(fetchImpl).receiveMessage({ event: 'message.new', data: { rawid: '1' } })
        expect(captured!.url).toContain('/extra_server/weflow/receiveMessage?task_white_token=')
        const body = JSON.parse(captured!.body)
        expect(body.event).toBe('message.new')
        expect(body.data.rawid).toBe('1')
        expect(body.file).toBeUndefined()
    })
})

describe('HttpDownstreamClient.ping', () => {
    it('code===1 → ok=true 且带 server_time/version', async () => {
        const fetchImpl = (() => Promise.resolve({
            ok: true, json: () => Promise.resolve({ code: 1, data: { server_time: 1750000000, version: '1.0.0' } }),
        })) as unknown as typeof fetch
        const res = await new HttpDownstreamClient(CFG, undefined, { fetchImpl, now: () => 1750000000 }).ping()
        expect(res).toMatchObject({ ok: true, serverTime: 1750000000, version: '1.0.0' })
    })
})
```

**Step 2: 跑测试确认失败** — FAIL

**Step 3: 实现** — 编辑 `server/src/downstream/client.ts`

1. 端点常量：

```ts
const RECEIVE_MESSAGE_PATH = '/extra_server/weflow/receiveMessage'
const PING_PATH = '/extra_server/weflow/ping'
```

2. 类型：

```ts
/** receiveMessage 信封（一期不带 file；file 下期媒体链路补） */
export interface ReceiveEnvelope {
    event: string
    data: unknown
}

/** receiveMessage 解析后的 ACK（code!=1 不抛错，交 forwarder 决策） */
export interface ReceiveAck {
    code: number
    msg?: string
    retryable?: boolean
    messageId?: number | string
    duplicate?: boolean
    receivedAt?: number
}

/** ping 结果 */
export interface PingResult {
    ok: boolean
    serverTime?: number
    version?: string
    message?: string
}
```

3. 扩展 `DownstreamClient` 接口：加 `receiveMessage(env: ReceiveEnvelope): Promise<ReceiveAck>` 与 `ping(): Promise<PingResult>`。
4. `HttpDownstreamClient` 加方法（沿用 syncGroups 的脱敏 + 传输层判定模式）：

```ts
    // fetch→json 顺序依赖，用 async/await（与 syncGroups 一致）
    async receiveMessage(env: ReceiveEnvelope): Promise<ReceiveAck> {
        const token = buildTaskWhiteToken(this.cfg.siteKey, this.cfg.aesKey, this.now())
        const url = `${this.cfg.baseUrl}${RECEIVE_MESSAGE_PATH}?task_white_token=${encodeURIComponent(token)}`
        const res = await this.fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify(env),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        })
        // 传输层错误才抛（forwarder 当瞬时可重试）；业务码 code!=1 不抛，交调用方决策。
        if (!res.ok) {
            const text = await res.text().catch(() => '')
            const snippet = text.slice(0, 500)
            this.log?.error({ path: RECEIVE_MESSAGE_PATH, status: res.status, body: snippet }, `[downstream] receiveMessage 返回 HTTP ${res.status}`)
            throw new Error(`下游 ${RECEIVE_MESSAGE_PATH} 返回 HTTP ${res.status}${snippet ? `：${snippet}` : ''}`)
        }
        const body = await res.json() as {
            code?: number, msg?: string
            data?: { retryable?: boolean, message_id?: number | string, duplicate?: boolean, received_at?: number }
        }
        return {
            code: body.code ?? 0,
            msg: body.msg,
            retryable: body.data?.retryable,
            messageId: body.data?.message_id,
            duplicate: body.data?.duplicate,
            receivedAt: body.data?.received_at,
        }
    }

    async ping(): Promise<PingResult> {
        const token = buildTaskWhiteToken(this.cfg.siteKey, this.cfg.aesKey, this.now())
        const url = `${this.cfg.baseUrl}${PING_PATH}?task_white_token=${encodeURIComponent(token)}`
        const res = await this.fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (!res.ok) return { ok: false, message: `HTTP ${res.status}` }
        const body = await res.json() as { code?: number, msg?: string, data?: { server_time?: number, version?: string } }
        return { ok: body.code === 1, serverTime: body.data?.server_time, version: body.data?.version, message: body.msg }
    }
```

> 注：桩测试里的假 `res` 需带 `ok:true`（现有 syncGroups 桩若无 `ok` 字段，syncGroups 用例不受影响，但新方法读 `res.ok`——测试桩已按上面补了 `ok`）。

**Step 4: 跑测试确认通过** — `npm -w server run test -- src/downstream/client.test.ts` → PASS

**Step 5: 提交**

```bash
git add server/src/downstream/client.ts server/src/downstream/client.test.ts
git commit -m "feat(downstream): 客户端补 receiveMessage（code!=1 不抛错）与 ping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: 转发决策纯函数 + 熔断器

**Files:**
- Create: `server/src/downstream/forwardPolicy.ts`
- Create: `server/src/downstream/circuitBreaker.ts`
- Test: `server/src/downstream/forwardPolicy.test.ts`
- Test: `server/src/downstream/circuitBreaker.test.ts`

**Step 1: 写失败测试** — 新建 `forwardPolicy.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { decideOutcome, isDownstreamUnavailable, type SendResult } from './forwardPolicy.js'

const POLICY = { maxAttempts: 3, authMaxAttempts: 2, backoffBaseMs: 2000, backoffCapMs: 60000 }
const ack = (code: number, retryable?: boolean): SendResult => ({ type: 'ack', ack: { code, retryable, duplicate: code === 1 } })
const transport = (): SendResult => ({ type: 'transport', error: 'timeout' })

describe('decideOutcome', () => {
    it('code=1 → done（带 duplicate）', () => {
        expect(decideOutcome({ type: 'ack', ack: { code: 1, duplicate: true } }, 0, POLICY)).toEqual({ kind: 'done', duplicate: true })
    })
    it('code=0 可重试且未耗尽 → retry（退避递增）', () => {
        const o = decideOutcome(ack(0), 0, POLICY)
        expect(o.kind).toBe('retry')
        if (o.kind === 'retry') expect(o.backoffMs).toBe(2000)
    })
    it('可重试耗尽 maxAttempts → dead', () => {
        expect(decideOutcome(ack(1005), 2, POLICY).kind).toBe('dead') // 第3次失败即死
    })
    it('1002/1003 立即 dead', () => {
        expect(decideOutcome(ack(1002), 0, POLICY).kind).toBe('dead')
        expect(decideOutcome(ack(1003), 0, POLICY).kind).toBe('dead')
    })
    it('1001 有限重试（authMaxAttempts=2）：第1次 retry、第2次 dead', () => {
        expect(decideOutcome(ack(1001), 0, POLICY).kind).toBe('retry')
        expect(decideOutcome(ack(1001), 1, POLICY).kind).toBe('dead')
    })
    it('显式 retryable=false → dead；retryable=true → retry', () => {
        expect(decideOutcome(ack(0, false), 0, POLICY).kind).toBe('dead')
        expect(decideOutcome(ack(9999, true), 0, POLICY).kind).toBe('retry') // 未识别码但显式可重试
    })
    it('传输层错误 → retry（未耗尽）/ dead（耗尽）', () => {
        expect(decideOutcome(transport(), 0, POLICY).kind).toBe('retry')
        expect(decideOutcome(transport(), 2, POLICY).kind).toBe('dead')
    })
    it('退避指数增长且封顶', () => {
        const b = (n: number) => { const o = decideOutcome(ack(0), n, { ...POLICY, maxAttempts: 99 }); return o.kind === 'retry' ? o.backoffMs : -1 }
        expect(b(0)).toBe(2000); expect(b(1)).toBe(4000); expect(b(2)).toBe(8000)
        expect(b(20)).toBe(60000) // 封顶
    })
})

describe('isDownstreamUnavailable', () => {
    it('传输错误与 0/1004/1005/未识别码 计入熔断；1001/1002/1003 不计', () => {
        expect(isDownstreamUnavailable(transport())).toBe(true)
        expect(isDownstreamUnavailable(ack(0))).toBe(true)
        expect(isDownstreamUnavailable(ack(1005))).toBe(true)
        expect(isDownstreamUnavailable(ack(1001))).toBe(false)
        expect(isDownstreamUnavailable(ack(1002))).toBe(false)
        expect(isDownstreamUnavailable(ack(1))).toBe(false)
    })
})
```

新建 `circuitBreaker.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { CircuitBreaker } from './circuitBreaker.js'

describe('CircuitBreaker', () => {
    it('连续失败达阈值 → 打开；冷却期内 isOpen=true', () => {
        let t = 1000
        const cb = new CircuitBreaker(3, 30, () => t)
        cb.recordFailure(); cb.recordFailure(); expect(cb.isOpen()).toBe(false)
        cb.recordFailure(); expect(cb.isOpen()).toBe(true)
        t = 1020; expect(cb.isOpen()).toBe(true)   // 冷却未到
        t = 1031; expect(cb.isOpen()).toBe(false)  // 冷却到点 → 半开放行
    })
    it('成功复位', () => {
        let t = 1000
        const cb = new CircuitBreaker(2, 30, () => t)
        cb.recordFailure(); cb.recordFailure(); expect(cb.isOpen()).toBe(true)
        cb.recordSuccess(); expect(cb.isOpen()).toBe(false)
        expect(cb.state()).toBe('closed')
    })
    it('半开探测再失败 → 重新打开', () => {
        let t = 1000
        const cb = new CircuitBreaker(1, 30, () => t)
        cb.recordFailure(); expect(cb.isOpen()).toBe(true)
        t = 1031; expect(cb.isOpen()).toBe(false) // 半开
        cb.recordFailure(); t = 1032; expect(cb.isOpen()).toBe(true) // 再关
    })
})
```

**Step 2: 跑测试确认失败** — FAIL

**Step 3: 实现** — 新建 `server/src/downstream/forwardPolicy.ts`

```ts
// 转发决策纯函数：给定一次发送结果 + 已尝试次数 + 策略 → 该消息该走 done/retry/dead。
// 不含副作用、不读时钟（退避不含抖动，抖动由 forwarder 叠加），便于穷举测试。
import type { ReceiveAck } from './client.js'

/** 一次发送的结果：拿到业务 ACK，或传输层错误 */
export type SendResult =
  | { type: 'ack', ack: ReceiveAck }
  | { type: 'transport', error: string }

export interface RetryPolicy {
    /** 通用可重试码的最大尝试次数 */
    maxAttempts: number
    /** 鉴权失败(1001)的有限重试次数 */
    authMaxAttempts: number
    backoffBaseMs: number
    backoffCapMs: number
}

export type ForwardOutcome =
  | { kind: 'done', duplicate: boolean }
  | { kind: 'retry', failCode: number | null, lastError: string, backoffMs: number }
  | { kind: 'dead', failCode: number | null, lastError: string }

/** 指数退避（不含抖动）：min(base * 2^(nextAttempt-1), cap) */
function backoffMs(nextAttempt: number, p: RetryPolicy): number {
    return Math.min(p.backoffBaseMs * 2 ** (nextAttempt - 1), p.backoffCapMs)
}

/** 该失败是否属「下游不可用」，用于熔断计数（内容类错误不计） */
export function isDownstreamUnavailable(result: SendResult): boolean {
    if (result.type === 'transport') return true
    const c = result.ack.code
    if (c === 1 || c === 1001 || c === 1002 || c === 1003) return false
    return true // 0 / 1004 / 1005 / 未识别非 1 码
}

export function decideOutcome(result: SendResult, attemptsSoFar: number, p: RetryPolicy): ForwardOutcome {
    const next = attemptsSoFar + 1
    const retryOrDead = (cap: number, failCode: number | null, reason: string): ForwardOutcome =>
        next >= cap
            ? { kind: 'dead', failCode, lastError: reason }
            : { kind: 'retry', failCode, lastError: reason, backoffMs: backoffMs(next, p) }

    if (result.type === 'transport') return retryOrDead(p.maxAttempts, null, `传输错误：${result.error}`)

    const { code, retryable, msg } = result.ack
    const reason = `code=${code}${msg ? ` msg=${msg}` : ''}`
    if (code === 1) return { kind: 'done', duplicate: result.ack.duplicate === true }
    if (code === 1001) return retryOrDead(p.authMaxAttempts, 1001, `鉴权失败(${reason})，查 siteKey/aesKey/时钟`)
    if (code === 1002 || code === 1003) return { kind: 'dead', failCode: code, lastError: reason }
    if (retryable === false) return { kind: 'dead', failCode: code, lastError: reason }
    if (retryable === true) return retryOrDead(p.maxAttempts, code, reason)
    // retryable 未给：0/1004/1005/未识别码一律按可重试
    return retryOrDead(p.maxAttempts, code, reason)
}
```

新建 `server/src/downstream/circuitBreaker.ts`

```ts
// 轻量熔断器：只统计「下游不可用」类连续失败；达阈值打开，冷却期后半开放行一条探测。
// 时钟注入便于测试；时间单位秒。
export type CircuitState = 'closed' | 'open' | 'half-open'

export class CircuitBreaker {
    private consecutive = 0
    private openedAt: number | null = null

    constructor(
        private readonly threshold: number,
        private readonly cooldownSec: number,
        private readonly now: () => number,
    ) {}

    recordSuccess(): void {
        this.consecutive = 0
        this.openedAt = null
    }

    recordFailure(): void {
        this.consecutive += 1
        if (this.consecutive >= this.threshold) this.openedAt = this.now()
    }

    /** 是否处于熔断（阻断取件）。冷却到点后返回 false（半开：放行一条探测） */
    isOpen(): boolean {
        if (this.openedAt === null) return false
        return this.now() - this.openedAt < this.cooldownSec
    }

    state(): CircuitState {
        if (this.openedAt === null) return 'closed'
        return this.now() - this.openedAt < this.cooldownSec ? 'open' : 'half-open'
    }
}
```

**Step 4: 跑测试确认通过** — 两个测试文件 PASS

**Step 5: 提交**

```bash
git add server/src/downstream/forwardPolicy.ts server/src/downstream/circuitBreaker.ts server/src/downstream/forwardPolicy.test.ts server/src/downstream/circuitBreaker.test.ts
git commit -m "feat(downstream): 转发决策纯函数 decideOutcome 与轻量熔断器 CircuitBreaker

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Forwarder（queue worker 编排）

**Files:**
- Create: `server/src/downstream/forwarder.ts`
- Test: `server/src/downstream/forwarder.test.ts`

**Step 1: 写失败测试** — 新建 `server/src/downstream/forwarder.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db } from '../db/database.js'
import { Forwarder } from './forwarder.js'
import type { DownstreamClient, ReceiveAck, ReceiveEnvelope } from './client.js'
import type { EnqueueInput } from '../db/queue.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never
const CFG = { baseUrl: 'https://dn', siteKey: 'k', aesKey: 'sixteen-byte-key' }

function enqueue(db: Db, over: Partial<EnqueueInput> = {}, now = 1000) {
    db.queue.enqueue({
        channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: 'message.new',
        externalId: 's1', conversationId: 'g@chatroom', senderId: null, msgTimestamp: 100,
        hasMedia: 0, rawJson: '{"rawid":"s1"}', mediaJson: null, ingestPath: 'catchup', revocableUntil: null, ...over,
    }, now)
}

/** 造一个 Forwarder：注入桩 client + 固定下游配置 + 固定时钟 */
function makeForwarder(db: Db, receive: (env: ReceiveEnvelope) => Promise<ReceiveAck>, alert = { send() {} }) {
    const client: DownstreamClient = { syncGroups: () => Promise.resolve({ allowed: [] }), receiveMessage: receive, ping: () => Promise.resolve({ ok: true }) }
    const store = { getDownstream: () => CFG } as never
    return new Forwarder({ db, store, log: noopLog, alert, createClient: () => client, now: () => 2000 })
}

describe('Forwarder.drainOnce', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('code=1 → done + 推进投递断点 + 写审计', async () => {
        enqueue(db)
        await makeForwarder(db, () => Promise.resolve({ code: 1, receivedAt: 2001 })).drainOnce()
        expect(db.queue.countByStatus('done')).toBe(1)
        expect(db.channelState.get(WEFLOW_CHANNEL_ID)?.breakpointTimestamp).toBe(100)
        expect(db.audit.stats(WEFLOW_CHANNEL_ID)).toEqual({ totalSuccess: 1, totalFail: 0 })
    })

    it('duplicate=true 视为成功（done、不再发）', async () => {
        enqueue(db)
        let calls = 0
        await makeForwarder(db, () => { calls++; return Promise.resolve({ code: 1, duplicate: true }) }).drainOnce()
        expect(calls).toBe(1)
        expect(db.queue.countByStatus('done')).toBe(1)
    })

    it('code=1002 → dead + 审计计失败', async () => {
        enqueue(db)
        await makeForwarder(db, () => Promise.resolve({ code: 1002, retryable: false })).drainOnce()
        expect(db.queue.countByStatus('dead')).toBe(1)
        expect(db.audit.stats(WEFLOW_CHANNEL_ID)).toEqual({ totalSuccess: 0, totalFail: 1 })
    })

    it('code=0 可重试 → 回 pending 且设 next_attempt_at（本轮不再取）', async () => {
        enqueue(db)
        await makeForwarder(db, () => Promise.resolve({ code: 0 })).drainOnce()
        expect(db.queue.countByStatus('pending')).toBe(1)
        expect(db.queue.getById(WEFLOW_CHANNEL_ID, 1)?.attempts).toBe(1)
    })

    it('媒体消息(has_media=1)不取件，留 pending', async () => {
        enqueue(db, { hasMedia: 1 })
        let calls = 0
        await makeForwarder(db, () => { calls++; return Promise.resolve({ code: 1 }) }).drainOnce()
        expect(calls).toBe(0)
        expect(db.queue.countByStatus('pending')).toBe(1)
    })

    it('多条按 id 串行排空', async () => {
        enqueue(db, { externalId: 'a', msgTimestamp: 100 })
        enqueue(db, { externalId: 'b', msgTimestamp: 200 })
        await makeForwarder(db, () => Promise.resolve({ code: 1 })).drainOnce()
        expect(db.queue.countByStatus('done')).toBe(2)
        expect(db.channelState.get(WEFLOW_CHANNEL_ID)?.breakpointTimestamp).toBe(200)
    })

    it('熔断：连续下游不可用达阈值后打开、暂停取件并告警', async () => {
        for (let i = 0; i < 6; i++) enqueue(db, { externalId: `e${i}` })
        const alerts: string[] = []
        const fw = makeForwarder(db, () => Promise.resolve({ code: 1005 }), { send: (a: { type: string }) => { alerts.push(a.type) } })
        await fw.drainOnce()
        // 阈值默认 5：前 5 条 retry 计失败触发熔断，之后停止取件（剩余仍 pending）
        expect(alerts).toContain('downstream_circuit_open')
        expect(fw.circuitState()).toBe('open')
    })

    it('未配置下游 → 空转不报错', async () => {
        enqueue(db)
        const client: DownstreamClient = { syncGroups: () => Promise.resolve({ allowed: [] }), receiveMessage: () => Promise.reject(new Error('should not call')), ping: () => Promise.resolve({ ok: true }) }
        const fw = new Forwarder({ db, store: { getDownstream: () => undefined } as never, log: noopLog, alert: { send() {} }, createClient: () => client, now: () => 2000 })
        await fw.drainOnce()
        expect(db.queue.countByStatus('pending')).toBe(1)
    })
})

describe('Forwarder.start', () => {
    it('start 时 resetStuck 把残留 sending 回 pending', async () => {
        const db = Db.openMemory()
        enqueue(db)
        db.queue.claimNext(WEFLOW_CHANNEL_ID, 2000) // 造 sending
        const fw = makeForwarder(db, () => Promise.resolve({ code: 1 }))
        fw.start()
        await fw.drainOnce()
        expect(db.queue.countByStatus('done')).toBe(1)
        fw.stop()
        db.close()
    })
})
```

**Step 2: 跑测试确认失败** — FAIL

**Step 3: 实现** — 新建 `server/src/downstream/forwarder.ts`

```ts
// 下游转发 worker：消费 queue 的 pending 文本消息 → receiveMessage → 按 code==1 判定 →
// done+推进投递断点 / 退避重试 / 死信。kick 唤醒 + 兜底 tick，单 worker 串行、排空即休眠。
// 媒体消息(has_media=1)一期不取（留 pending，二期媒体链路补发）。
import type { ConfigStore } from '../config/store.js'
import type { DownstreamConfig } from '@wb/shared/types'
import type { Db } from '../db/database.js'
import type { Logger } from '../weflow/logger.js'
import type { AlertChannel } from '../weflow/hooks.js'
import { HttpDownstreamClient, type DownstreamClient, type ReceiveAck } from './client.js'
import { decideOutcome, isDownstreamUnavailable, type RetryPolicy, type SendResult } from './forwardPolicy.js'
import { CircuitBreaker } from './circuitBreaker.js'
import { WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM } from '../weflow/adapter.js'

/** forwarder 调参默认值（下游 config.forwarder 缺省即用） */
const DEFAULTS = {
    maxAttempts: 3,
    authMaxAttempts: 2,
    backoffBaseMs: 2000,
    backoffCapMs: 60000,
    circuitThreshold: 5,
    circuitCooldownSec: 30,
}
/** 兜底 tick 间隔（秒）：复查到期重试项与半开探测 */
const TICK_SEC = 10

export interface ForwarderDeps {
    db: Db
    store: ConfigStore
    log: Logger
    alert: AlertChannel
    /** 客户端工厂（默认 HttpDownstreamClient）；测试注入桩 */
    createClient?: (cfg: DownstreamConfig) => DownstreamClient
    now?: () => number
}

export class Forwarder {
    private readonly db: Db
    private readonly store: ConfigStore
    private readonly log: Logger
    private readonly alert: AlertChannel
    private readonly createClient: (cfg: DownstreamConfig) => DownstreamClient
    private readonly clock: () => number

    private enabled = false
    private draining = false
    private tickTimer: NodeJS.Timeout | null = null
    private circuit: CircuitBreaker
    private warnedNoConfig = false

    constructor(deps: ForwarderDeps) {
        this.db = deps.db
        this.store = deps.store
        this.log = deps.log
        this.alert = deps.alert
        this.createClient = deps.createClient ?? ((cfg) => new HttpDownstreamClient(cfg, this.log))
        this.clock = deps.now ?? (() => Math.floor(Date.now() / 1000))
        this.circuit = new CircuitBreaker(DEFAULTS.circuitThreshold, DEFAULTS.circuitCooldownSec, this.clock)
    }

    /** 启动：自愈残留 sending → 开启 → 起兜底 tick → 踢一脚 */
    start(): void {
        this.db.queue.resetStuck(WEFLOW_CHANNEL_ID, this.clock())
        this.enabled = true
        if (!this.tickTimer) {
            this.tickTimer = setInterval(() => this.kick(), TICK_SEC * 1000)
            this.tickTimer.unref?.()
        }
        this.kick()
    }

    stop(): void {
        this.enabled = false
        if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null }
    }

    /** 运行期转发总开关 */
    setEnabled(on: boolean): void {
        if (on && !this.enabled) this.start()
        else if (!on && this.enabled) this.enabled = false // 保留 tick，仅停取件
    }

    isEnabled(): boolean { return this.enabled }
    circuitState(): string { return this.circuit.state() }

    /** 踢一脚：非重入地触发一轮排空（fire-and-forget） */
    kick(): void {
        if (this.draining || !this.enabled) return
        void this.drainOnce()
    }

    /** 排空一轮（可 await，测试用）：循环取件直到无待投 / 熔断打开 / 停用 */
    async drainOnce(): Promise<void> {
        if (this.draining) return
        this.draining = true
        try {
            const cfg = this.store.getDownstream()
            if (!cfg) {
                if (!this.warnedNoConfig) { this.log.warn('[forward] 未配置下游，转发空转'); this.warnedNoConfig = true }
                return
            }
            this.warnedNoConfig = false
            const client = this.createClient(cfg)
            const policy = this.policyFrom(cfg)
            for (;;) {
                if (this.circuit.isOpen()) return
                const msg = this.db.queue.claimNext(WEFLOW_CHANNEL_ID, this.clock())
                if (!msg) return
                await this.processOne(client, policy, msg)
            }
        } finally {
            this.draining = false
        }
    }

    private policyFrom(cfg: DownstreamConfig): RetryPolicy {
        const f = cfg.forwarder ?? {}
        return {
            maxAttempts: f.maxAttempts ?? DEFAULTS.maxAttempts,
            authMaxAttempts: DEFAULTS.authMaxAttempts,
            backoffBaseMs: f.backoffBaseMs ?? DEFAULTS.backoffBaseMs,
            backoffCapMs: f.backoffCapMs ?? DEFAULTS.backoffCapMs,
        }
    }

    /** 发一条 + 判定 + 落库 + 熔断计数 + 审计。send→decide 属顺序依赖，用 async/await */
    private async processOne(
        client: DownstreamClient,
        policy: RetryPolicy,
        msg: { id: number, eventType: string, rawJson: string, msgTimestamp: number | null, externalId: string | null },
    ): Promise<void> {
        const startMs = Date.now()
        let result: SendResult
        let ack: ReceiveAck | null = null
        try {
            ack = await client.receiveMessage({ event: msg.eventType, data: JSON.parse(msg.rawJson) })
            result = { type: 'ack', ack }
        } catch (e) {
            result = { type: 'transport', error: e instanceof Error ? e.message : String(e) }
        }

        const attemptsSoFar = this.attemptsOf(msg.id)
        const outcome = decideOutcome(result, attemptsSoFar, policy)
        const now = this.clock()
        const latencyMs = Date.now() - startMs

        // 熔断计数：仅「下游不可用」类失败计入；成功复位
        if (outcome.kind === 'done') this.circuit.recordSuccess()
        else if (isDownstreamUnavailable(result)) {
            this.circuit.recordFailure()
            if (this.circuit.isOpen()) {
                this.alert.send({ level: 'error', type: 'downstream_circuit_open', title: '下游熔断打开', message: `连续失败达阈值，暂停转发 ${DEFAULTS.circuitCooldownSec}s` })
            }
        }

        if (outcome.kind === 'done') {
            this.db.raw.transaction(() => {
                this.db.queue.markDone(msg.id, now)
                if (msg.msgTimestamp !== null) {
                    this.db.channelState.advanceBreakpoint(WEFLOW_CHANNEL_ID, WEFLOW_PLATFORM, msg.msgTimestamp, msg.externalId ?? '', now)
                }
            })()
            this.writeAudit(msg, ack, attemptsSoFar, latencyMs, now)
            return
        }
        if (outcome.kind === 'retry') {
            const jitter = Math.floor(Math.random() * 1000)
            this.db.queue.markRetry(msg.id, {
                failCode: outcome.failCode, retryable: 1, lastError: outcome.lastError,
                nextAttemptAt: now + Math.ceil((outcome.backoffMs + jitter) / 1000),
            }, now)
            this.log.warn({ id: msg.id, failCode: outcome.failCode, err: outcome.lastError }, '[forward] 转发失败，退避重试')
            return
        }
        // dead
        this.db.queue.markDead(msg.id, { failCode: outcome.failCode, retryable: 0, lastError: outcome.lastError }, now)
        this.writeAudit(msg, ack, attemptsSoFar, latencyMs, now)
        this.alert.send({ level: 'warn', type: 'dlq_new', title: '消息进死信', message: `id=${msg.id} ${outcome.lastError}` })
    }

    private writeAudit(
        msg: { eventType: string, msgTimestamp: number | null, externalId: string | null },
        ack: ReceiveAck | null, attempts: number, latencyMs: number, now: number,
    ): void {
        this.db.audit.record({
            channelId: WEFLOW_CHANNEL_ID, platform: WEFLOW_PLATFORM, eventType: msg.eventType,
            externalId: msg.externalId, conversationId: null, msgTimestamp: msg.msgTimestamp,
            isMedia: 0, fileId: null,
            code: ack?.code ?? null, duplicate: ack?.duplicate ? 1 : 0, receivedAt: ack?.receivedAt ?? null,
            latencyMs, attempts, ingestPath: null,
        }, now)
    }

    private attemptsOf(id: number): number {
        return this.db.queue.getById(WEFLOW_CHANNEL_ID, id)?.attempts ?? 0
    }
}
```

> 说明：`processOne` 里 `attemptsOf` 读的是**入队以来已累计的 attempts**（markRetry 累加）；`decideOutcome(result, attemptsSoFar, ...)` 内部 `next=attemptsSoFar+1` 与 QueueStore 的 attempts+1 对齐，第 `maxAttempts` 次失败即 dead。熔断打开后 `drainOnce` 的 `for` 循环下一轮 `isOpen()` 命中直接 return，剩余消息留 pending，等兜底 tick 冷却后半开重试。

**Step 4: 跑测试确认通过** — `npm -w server run test -- src/downstream/forwarder.test.ts` → PASS

**Step 5: 提交**

```bash
git add server/src/downstream/forwarder.ts server/src/downstream/forwarder.test.ts
git commit -m "feat(downstream): 新增 Forwarder 队列 worker（转发/ACK/重试/熔断/死信/断点/审计）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: 下游配置类型 + 校验 + ConfigStore.saveDownstream

**Files:**
- Modify: `shared/src/types/config.ts`
- Modify: `shared/src/constants/config.ts`
- Modify: `server/src/config/validate.ts`
- Modify: `server/src/config/store.ts`
- Test: `server/src/config/store.test.ts`（若不存在则新建）

**Step 1: 加类型与常量** — 编辑 `shared/src/types/config.ts`

`DownstreamConfig` 增可选 `forwarder`，并加更新类型：

```ts
/** forwarder 调参（全可选，缺省用后端默认） */
export interface DownstreamForwarderConfig {
    requestTimeoutMs?: number
    maxAttempts?: number
    backoffBaseMs?: number
    backoffCapMs?: number
    circuitThreshold?: number
    circuitCooldownSec?: number
}

export interface DownstreamConfig {
    baseUrl: string
    siteKey: string
    aesKey: string
    /** forwarder 调参（可选） */
    forwarder?: DownstreamForwarderConfig
}

/** 下游配置更新负载（PUT /api/config/downstream）：与 DownstreamConfig 同构 */
export type DownstreamConfigUpdate = DownstreamConfig
```

编辑 `shared/src/constants/config.ts` 加边界：

```ts
/** 下游 forwarder 数值字段校验边界 */
export const DOWNSTREAM_LIMITS = {
    requestTimeoutMs: { min: 1000, max: 120000 },
    maxAttempts: { min: 1, max: 10 },
    backoffBaseMs: { min: 100, max: 60000 },
    backoffCapMs: { min: 1000, max: 600000 },
    circuitThreshold: { min: 1, max: 100 },
    circuitCooldownSec: { min: 1, max: 3600 },
} as const
```

**Step 2: 构建 shared** — `npm -w shared run build`（后端才能引用新类型）

**Step 3: 写失败测试** — 新建/追加 `server/src/config/validate.test.ts`（若已有 validate 测试文件则追加）

```ts
import { describe, it, expect } from 'vitest'
import { validateDownstreamUpdate } from './validate.js'

describe('validateDownstreamUpdate', () => {
    const ok = { baseUrl: 'https://dn.example.com', siteKey: 'site', aesKey: 'sixteen-byte-key' }
    it('合法配置通过', () => {
        expect(validateDownstreamUpdate(ok).ok).toBe(true)
    })
    it('baseUrl 非法 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, baseUrl: 'not a url' }).errors.baseUrl).toBeTruthy()
    })
    it('aesKey 不足 16 字节 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, aesKey: 'short' }).errors.aesKey).toBeTruthy()
    })
    it('siteKey 空 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, siteKey: '' }).errors.siteKey).toBeTruthy()
    })
    it('forwarder 数值越界 → 报错', () => {
        expect(validateDownstreamUpdate({ ...ok, forwarder: { maxAttempts: 0 } }).errors['forwarder.maxAttempts']).toBeTruthy()
    })
})
```

**Step 4: 实现校验** — 编辑 `server/src/config/validate.ts`

```ts
import { WEFLOW_LIMITS, DOWNSTREAM_LIMITS } from '@wb/shared/constants'
import type { WeflowConfigUpdate, DownstreamConfigUpdate } from '@wb/shared/types'
// …既有内容不变，末尾追加：

/** 校验下游配置更新（密钥线下交付、明文落盘；baseUrl 建议 https） */
export function validateDownstreamUpdate(update: DownstreamConfigUpdate): ValidationResult {
    const errors: FieldErrors = {}

    let url: URL | null = null
    try { url = new URL(update.baseUrl) } catch { /* ignore */ }
    if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) {
        errors.baseUrl = '请输入合法的下游 Base URL（建议 https）'
    }
    if (typeof update.siteKey !== 'string' || !update.siteKey.trim()) {
        errors.siteKey = '请输入站点 key'
    }
    if (typeof update.aesKey !== 'string' || Buffer.from(update.aesKey, 'ascii').length < 16) {
        errors.aesKey = 'AES 密钥不足 16 字节（AES-128 取前 16 字节）'
    }

    const f = update.forwarder
    if (f) {
        const check = (key: keyof typeof DOWNSTREAM_LIMITS) => {
            const v = f[key]
            if (v === undefined) return
            checkIntRange(errors, `forwarder.${key}`, v, DOWNSTREAM_LIMITS[key], key)
        }
        check('requestTimeoutMs'); check('maxAttempts'); check('backoffBaseMs')
        check('backoffCapMs'); check('circuitThreshold'); check('circuitCooldownSec')
    }

    return { ok: Object.keys(errors).length === 0, errors }
}
```

**Step 5: 实现 saveDownstream** — 编辑 `server/src/config/store.ts`

1. import 增补 `DownstreamConfigUpdate` 与 `validateDownstreamUpdate`。
2. 加方法（保留 weflow、明文落盘）：

```ts
    /** 校验并保存下游配置（保留 weflow）。失败抛 ConfigValidationError，返回更新后配置 */
    saveDownstream(update: DownstreamConfigUpdate): AppConfig {
        const result = validateDownstreamUpdate(update)
        if (!result.ok) throw new ConfigValidationError(result.errors)
        const next: AppConfig = {
            weflow: this.config.weflow,
            downstream: {
                baseUrl: update.baseUrl.trim(),
                siteKey: update.siteKey.trim(),
                aesKey: update.aesKey.trim(),
                forwarder: update.forwarder,
            },
        }
        this.persist(next)
        this.config = next
        return next
    }
```

**Step 6: 跑测试确认通过** — `npm -w server run test -- src/config/validate.test.ts` → PASS

**Step 7: 提交**

```bash
git add shared/src/types/config.ts shared/src/constants/config.ts server/src/config/validate.ts server/src/config/store.ts server/src/config/validate.test.ts
git commit -m "feat(config): 下游配置增 forwarder 调参、校验与 ConfigStore.saveDownstream

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: 路由（下游配置/测连/转发开关/死信/状态）

**Files:**
- Modify: `server/src/routes/context.ts`
- Modify: `server/src/routes/config.ts`
- Modify: `server/src/routes/test.ts`
- Modify: `server/src/routes/control.ts`
- Modify: `server/src/routes/status.ts`
- Create: `server/src/routes/dlq.ts`

> 路由层为薄封装，与仓库现状一致不加单测，靠 `npm run build` + 手测。

**Step 1: AppContext 加 forwarder** — 编辑 `context.ts`

```ts
import type { Forwarder } from '../downstream/forwarder.js'
// …interface AppContext 增字段：
    forwarder: Forwarder
```

**Step 2: 下游配置保存** — 编辑 `config.ts`，追加：

```ts
    // 保存下游配置：校验 → 明文落盘 → 踢一脚 forwarder（新参数下轮生效）
    app.put<{ Body: DownstreamConfigUpdate }>('/api/config/downstream', async (req, reply) => {
        const body = req.body
        if (!body || typeof body !== 'object') return reply.code(400).send({ error: '请求体格式错误：缺少下游配置' })
        try {
            const saved = ctx.store.saveDownstream(body)
            ctx.forwarder.kick()
            return saved.downstream
        } catch (e) {
            if (e instanceof ConfigValidationError) return reply.code(400).send({ error: e.message, fields: e.fields })
            req.log.error({ err: e }, '[config] 下游配置保存失败')
            return reply.code(500).send({ error: '下游配置保存失败' })
        }
    })
```

（顶部 import 增补 `DownstreamConfigUpdate`。）

**Step 3: 下游测连** — 编辑 `test.ts`，追加：

```ts
    // 下游连通性测试：用当前已保存的下游配置打 ping
    app.post('/api/test/downstream-ping', async (_req, reply) => {
        const cfg = ctx.store.getDownstream()
        if (!cfg) return reply.code(400).send({ error: '未配置下游，无法测连' })
        return new HttpDownstreamClient(cfg, app.log).ping()
    })
```

（顶部 import `HttpDownstreamClient`。）

**Step 4: 转发开关** — 编辑 `control.ts`，追加：

```ts
    // 转发总开关：启/停 forwarder worker
    app.post<{ Body: { enabled: boolean } }>('/api/control/forwarding', async (req) => {
        const on = req.body?.enabled === true
        ctx.forwarder.setEnabled(on)
        return { forwarding: ctx.forwarder.isEnabled() }
    })
```

**Step 5: 状态快照接真值** — 编辑 `status.ts`

```ts
interface StatusSnapshot {
    weflow: WeflowConnectionStatus
    forwarding: boolean
    circuitState: string
    breakpointTimestamp: number | null
    queueBacklog: number
    dlqCount: number
    totalSuccess: number
    totalFail: number
    uptimeSec: number
}

export function registerStatusRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get('/api/status', async (): Promise<StatusSnapshot> => {
        const stats = ctx.db.audit.stats(WEFLOW_CHANNEL_ID)
        return {
            weflow: ctx.manager.getStatus(),
            forwarding: ctx.forwarder.isEnabled(),
            circuitState: ctx.forwarder.circuitState(),
            breakpointTimestamp: ctx.db.channelState.get(WEFLOW_CHANNEL_ID)?.breakpointTimestamp ?? null,
            queueBacklog: ctx.db.queue.countByStatus('pending'),
            dlqCount: ctx.db.queue.countByStatus('dead'),
            totalSuccess: stats.totalSuccess,
            totalFail: stats.totalFail,
            uptimeSec: Math.floor(process.uptime()),
        }
    })
}
```

（顶部 import `WEFLOW_CHANNEL_ID`。）

**Step 6: 死信最小档路由** — 新建 `server/src/routes/dlq.ts`

```ts
// 死信最小档：列 dead 行（复用 queue.list 的 status 过滤）+ 单条重投。
import type { FastifyInstance } from 'fastify'
import { WEFLOW_CHANNEL_ID } from '../weflow/adapter.js'
import type { AppContext } from './context.js'

export function registerDlqRoutes(app: FastifyInstance, ctx: AppContext): void {
    app.get<{ Querystring: { page?: string, pageSize?: string } }>('/api/dlq', async (req) => {
        const page = Math.max(1, Number(req.query.page ?? 1))
        const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50)))
        const { items, total } = ctx.db.queue.list(WEFLOW_CHANNEL_ID, { status: 'dead' }, pageSize, (page - 1) * pageSize)
        return { items, total, page, pageSize }
    })

    app.post<{ Params: { id: string } }>('/api/dlq/:id/retry', async (req, reply) => {
        const id = Number(req.params.id)
        if (!Number.isInteger(id)) return reply.code(400).send({ error: 'id 非法' })
        const ok = ctx.db.queue.retryDead(WEFLOW_CHANNEL_ID, id, Math.floor(Date.now() / 1000))
        if (!ok) return reply.code(404).send({ error: '死信不存在或已非 dead' })
        ctx.forwarder.kick()
        return { ok: true }
    })
}
```

**Step 7: 构建确认** — `npm run build`（此时 index.ts 尚未接 forwarder/dlq，会因 AppContext 缺 forwarder 报错——Task 10 一起过。故本步只跑 `npm -w shared run build` 确保类型 OK，完整构建放 Task 10。）

**Step 8: 提交**

```bash
git add server/src/routes/context.ts server/src/routes/config.ts server/src/routes/test.ts server/src/routes/control.ts server/src/routes/status.ts server/src/routes/dlq.ts
git commit -m "feat(routes): 下游配置保存/测连/转发开关/死信最小档/状态真值

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: 顶层接线（index.ts）+ 入队踢 forwarder

**Files:**
- Modify: `server/src/sync/syncService.ts`
- Modify: `server/src/sync/syncService.test.ts`
- Modify: `server/src/index.ts`

**Step 1: 写失败测试** — 在 `syncService.test.ts` 追加（验证入队回调触发）：

```ts
it('新入队时触发 onEnqueued 回调（供 forwarder kick）', async () => {
    allowGroup(db, 'proj@chatroom')
    let kicks = 0
    const client = stubClient(
        [{ username: 'proj@chatroom', type: 2 }],
        { 'proj@chatroom': { messages: [{ serverId: 's1', createTime: 100, content: 'a' }], hasMore: false } },
    )
    const d = deps(db, client)
    const svc = new SyncService({ ...d, onEnqueued: () => { kicks++ } })
    await svc.runFullSync()
    expect(kicks).toBeGreaterThanOrEqual(1)
})
```

（`allowGroup`/`stubClient`/`deps` 沿用该测试文件既有帮手。）

**Step 2: 跑测试确认失败** — FAIL

**Step 3: 实现 onEnqueued** — 编辑 `server/src/sync/syncService.ts`

1. `SyncServiceDeps` 加可选字段：

```ts
    /** 新消息入队后的回调（用于 kick 下游 forwarder）；缺省不做任何事 */
    onEnqueued?: () => void
```

2. 类内加字段 `private readonly onEnqueued: () => void` 并在构造函数 `this.onEnqueued = deps.onEnqueued ?? (() => {})`。
3. `ingestOne` 内入队成功后（`this.db.queue.enqueue(...)` 之后、`dispatchSystemEvent` 之前或之后均可）调用 `this.onEnqueued()`。同理 `emitRevoke` 入队撤回事件后也调用 `this.onEnqueued()`（撤回事件也要转发）。

**Step 4: 跑测试确认通过** — `npm -w server run test -- src/sync/syncService.test.ts` → PASS

**Step 5: 接线 index.ts** — 编辑 `server/src/index.ts`

1. import：

```ts
import { Forwarder } from './downstream/forwarder.js'
import { registerDlqRoutes } from './routes/dlq.js'
```

2. 装配段（`const sync = ...` 之前构造 forwarder；`sync` 传 `onEnqueued`）：

```ts
const forwarder = new Forwarder({ db, store, log: app.log, alert })
const sync = new SyncService({ store, db, log: app.log, alert, groupSync, onEnqueued: () => forwarder.kick() })
```

3. `ctx` 增 `forwarder`：`const ctx: AppContext = { store, manager, sync, db, forwarder }`
4. 注册 dlq 路由：`registerDlqRoutes(app, ctx)`
5. `app.listen(...).then(...)` 内追加 `forwarder.start()`（与 `manager.start()` / `sync.startReconcileLoop()` 并列）。
6. 顶部注释「尚未实现」段删掉「消息转发」，改述 forwarder 已接入。

**Step 6: 全量构建 + 测试 + lint**

```bash
npm run build
npm -w server run test
npm run lint
```

Expected: 全 PASS，无 lint 错。

**Step 7: 提交**

```bash
git add server/src/sync/syncService.ts server/src/sync/syncService.test.ts server/src/index.ts
git commit -m "feat(server): 接线 Forwarder，入队 kick、启动自启转发、注册死信路由

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: 前端 —— 配置页「下游」分组 + ping 测连 + 转发开关

**Files:**
- Modify: `web/src/api/config.ts`
- Modify: `web/src/stores/config.ts`
- Create: `web/src/components/config/DownstreamConfig.vue`
- Modify: `web/src/pages/ConfigPage.vue`

> 前端无组件测试框架（仓库现状），本任务验证 = `npm -w web run build` + 手测。镜像 `WeflowConfig.vue` 的 ElCard/ElForm 结构与 store/api 写法。

**Step 1: api 封装** — 编辑 `web/src/api/config.ts`，追加：

```ts
import { type AppConfig, type WeflowConfig, type WeflowConfigUpdate, type WeflowConnectTestResult, type DownstreamConfig, type DownstreamConfigUpdate } from '@wb/shared/types'

/** 保存下游配置，返回保存后的下游配置 */
export function updateDownstreamConfig(body: DownstreamConfigUpdate): Promise<DownstreamConfig> {
    return httpPut<DownstreamConfig>('/config/downstream', body)
}

/** 下游连通性测试（ping 当前已保存配置） */
export function testDownstreamPing(): Promise<{ ok: boolean, serverTime?: number, version?: string, message?: string }> {
    return httpPost('/test/downstream-ping', {})
}

/** 转发总开关 */
export function setForwarding(enabled: boolean): Promise<{ forwarding: boolean }> {
    return httpPost('/control/forwarding', { enabled })
}
```

**Step 2: store 动作** — 编辑 `web/src/stores/config.ts`，`saveWeflow` 旁加：

```ts
function saveDownstream(update: DownstreamConfigUpdate) {
    return new Promise<void>((resolve, reject) => {
        updateDownstreamConfig(update).then((cfg) => {
            config.value.downstream = JSON.parse(JSON.stringify(cfg))
            resolve()
        }).catch(reject)
    })
}
```

（import 增补 `updateDownstreamConfig`、类型 `DownstreamConfigUpdate`；`return { ... }` 暴露 `saveDownstream`。）

**Step 3: 新建组件** — `web/src/components/config/DownstreamConfig.vue`（镜像 WeflowConfig.vue，字段：baseUrl/siteKey/aesKey 明文 + 折叠「高级」forwarder 参数 + footer 三个操作：保存 / 测试连接 / 转发开关）

```vue
<template>
    <ElCard v-loading="form.saving" class="downstream-config">
        <template #header>
            <div class="downstream-config-header">
                <span>下游（work-order-system）</span>
                <ElSwitch
                    v-model="forwarding"
                    active-text="转发中"
                    inactive-text="已暂停"
                    @change="onToggleForwarding"
                />
            </div>
        </template>
        <ElForm :ref="r => (form.formRef = r as FormInstance)" :model="form.model" :rules="form.rules" label-width="auto">
            <ElFormItem label="Base URL" prop="baseUrl">
                <ElInput v-model="form.model.baseUrl" placeholder="https://example.com" clearable />
            </ElFormItem>
            <ElFormItem label="站点 key" prop="siteKey">
                <ElInput v-model="form.model.siteKey" placeholder="weflow-agent-…" clearable />
            </ElFormItem>
            <ElFormItem label="AES 密钥" prop="aesKey">
                <ElInput v-model="form.model.aesKey" placeholder="约定密钥串（取前 16 字节）" clearable />
            </ElFormItem>
            <ElCollapse>
                <ElCollapseItem title="高级（转发调参，可留空用默认）">
                    <ElFormItem label="请求超时(ms)"><ElInputNumber v-model="form.model.forwarder.requestTimeoutMs" :min="0" :controls="false" /></ElFormItem>
                    <ElFormItem label="最大重试次数"><ElInputNumber v-model="form.model.forwarder.maxAttempts" :min="0" :controls="false" /></ElFormItem>
                    <ElFormItem label="退避基数(ms)"><ElInputNumber v-model="form.model.forwarder.backoffBaseMs" :min="0" :controls="false" /></ElFormItem>
                    <ElFormItem label="退避上限(ms)"><ElInputNumber v-model="form.model.forwarder.backoffCapMs" :min="0" :controls="false" /></ElFormItem>
                    <ElFormItem label="熔断阈值"><ElInputNumber v-model="form.model.forwarder.circuitThreshold" :min="0" :controls="false" /></ElFormItem>
                    <ElFormItem label="熔断冷却(s)"><ElInputNumber v-model="form.model.forwarder.circuitCooldownSec" :min="0" :controls="false" /></ElFormItem>
                </ElCollapseItem>
            </ElCollapse>
        </ElForm>
        <template #footer>
            <ElButton :loading="pinging" @click="onPing">测试连接</ElButton>
            <ElButton type="primary" :loading="form.saving" @click="onSave">保存</ElButton>
        </template>
    </ElCard>
</template>

<script setup lang="ts">
import { ApiError } from '@/api/http'
import { ref, watch } from 'vue'
import { useConfigStore } from '@/stores/config'
import { testDownstreamPing, setForwarding } from '@/api/config'
import { type DownstreamConfigUpdate } from '@wb/shared/types'
import { ElCard, ElForm, ElFormItem, ElButton, ElInput, ElInputNumber, ElSwitch, ElCollapse, ElCollapseItem, ElMessage, type FormInstance, type FormRules } from 'element-plus'

const store = useConfigStore()
const pinging = ref(false)
const forwarding = ref(false)

const form = ref({
    formRef: undefined as FormInstance | undefined,
    model: {
        baseUrl: '', siteKey: '', aesKey: '',
        forwarder: { requestTimeoutMs: undefined, maxAttempts: undefined, backoffBaseMs: undefined, backoffCapMs: undefined, circuitThreshold: undefined, circuitCooldownSec: undefined },
    } as Required<Pick<DownstreamConfigUpdate, 'baseUrl' | 'siteKey' | 'aesKey'>> & { forwarder: NonNullable<DownstreamConfigUpdate['forwarder']> },
    rules: {
        baseUrl: [{ required: true, message: '请输入 Base URL', trigger: 'blur' }],
        siteKey: [{ required: true, message: '请输入站点 key', trigger: 'blur' }],
        aesKey: [{ required: true, message: '请输入 AES 密钥', trigger: 'blur' }],
    } as FormRules,
    saving: false,
})

watch(() => store.config.downstream, (d) => {
    if (d) {
        form.value.model.baseUrl = d.baseUrl
        form.value.model.siteKey = d.siteKey
        form.value.model.aesKey = d.aesKey
        form.value.model.forwarder = { ...form.value.model.forwarder, ...d.forwarder }
    }
}, { immediate: true })

/** 组装更新负载：forwarder 里 undefined 字段过滤掉（留空即用后端默认） */
function buildUpdate(): DownstreamConfigUpdate {
    const f = form.value.model.forwarder
    const forwarder = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null))
    return {
        baseUrl: form.value.model.baseUrl.trim(),
        siteKey: form.value.model.siteKey.trim(),
        aesKey: form.value.model.aesKey.trim(),
        forwarder: Object.keys(forwarder).length ? forwarder : undefined,
    }
}

function onSave() {
    form.value.formRef?.validate((valid) => {
        if (!valid) return
        form.value.saving = true
        store.saveDownstream(buildUpdate()).then(() => {
            ElMessage.success('下游配置已保存')
        }).catch((e) => {
            ElMessage.error(e instanceof ApiError ? e.message : '保存失败')
        }).finally(() => { form.value.saving = false })
    })
}

function onPing() {
    pinging.value = true
    testDownstreamPing().then((r) => {
        if (r.ok) ElMessage.success(`下游可达${r.version ? `（v${r.version}）` : ''}`)
        else ElMessage.warning(`下游未通过：${r.message ?? 'code!=1'}`)
    }).catch((e) => {
        ElMessage.error(e instanceof ApiError ? e.message : '测连失败')
    }).finally(() => { pinging.value = false })
}

function onToggleForwarding(val: boolean) {
    setForwarding(val).then((r) => {
        forwarding.value = r.forwarding
        ElMessage.success(r.forwarding ? '已开启转发' : '已暂停转发')
    }).catch((e) => {
        forwarding.value = !val // 回滚
        ElMessage.error(e instanceof ApiError ? e.message : '切换失败')
    })
}
</script>

<style scoped lang="scss">
.downstream-config {
    &.el-card :deep(> .el-card__footer) { display: flex; justify-content: flex-end; gap: 8px; }
    .downstream-config-header { display: flex; align-items: center; justify-content: space-between; }
}
</style>
```

> 注：`forwarding` 开关初值可留 false，保存/测连不依赖它；如需精确回显当前转发态，后续从 `GET /api/status` 拉一次填充（本期从简）。ElInputNumber 绑 `undefined` 显示为空，符合「留空用默认」。若严格 TS 报 forwarder 字段类型，允许在 model 上用 `Record<string, number | undefined>` 兜底。

**Step 4: 挂到配置页** — 编辑 `web/src/pages/ConfigPage.vue`

```vue
<template>
    <div class="config_page">
        <WeflowConfig />
        <DownstreamConfig />
    </div>
</template>
```

`<script setup>` 内 `import DownstreamConfig from '@/components/config/DownstreamConfig.vue'`。

**Step 5: 构建确认** — `npm -w web run build`（或 `npm run build`）Expected: 通过。

**Step 6: 提交**

```bash
git add web/src/api/config.ts web/src/stores/config.ts web/src/components/config/DownstreamConfig.vue web/src/pages/ConfigPage.vue
git commit -m "feat(web): 配置页新增下游分组（保存/ping 测连/转发开关）

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: 全链路验收

**Step 1: 全量测试** — `npm -w server run test` → 全 PASS（schema/channelState/queue/audit/client/forwardPolicy/circuitBreaker/forwarder/validate/syncService）。

**Step 2: Lint** — `npm run lint` → 无错（无分号、单引号）。

**Step 3: 构建** — `npm run build` → `tsc -b` 与 web 构建均通过。

**Step 4: 自查清单（对齐 design §14 验收标准）**
- [ ] schema v5 迁移自动补断点列，v4→v5 不丢 channel_state 数据。
- [ ] 配下游后「测试连接」能打通 ping（或明确报下游未实现）。
- [ ] 文本消息 `code==1` → done、推进 `breakpoint_timestamp`、写 audit。
- [ ] `duplicate=true` 视为成功不重发。
- [ ] `0/1005`/传输错误退避重试；`1002` 立即死信；`1001` 2 次后死信 + 告警。
- [ ] 连续下游不可用达阈值 → 熔断打开 + 告警 + 暂停取件；冷却后半开。
- [ ] `has_media=1` 不取件、留 pending。
- [ ] 崩溃重启残留 sending 回 pending（start→resetStuck）。
- [ ] 补偿起点仍为 `last_sync_timestamp`（未受 forwarder 影响）。
- [ ] `GET /api/dlq` 可查、`POST /api/dlq/:id/retry` 可重投。
- [ ] 转发开关可运行期启/停；`GET /api/status` 含积压/死信/断点/累计成败/熔断态。

**Step 5（可选）：保存进度** — 用 `/commit-and-push` 推送 `rewrite/v2`。

---

## 备注 / 留待下期（design §13）

- **媒体两步上传**：`uploadMedia` + 从 WeFlow 取回（读 `mediaLocalPath`/回查补齐 `sourceRef`）+ `media_cache` 幂等 + 信封带 `file` + 取消 worker 的 `has_media=0` 过滤。
- **心跳 `heartbeat`**：周期上报 `breakpointTimestamp`/积压/死信/`sseStatus` 等。
- **热重配完整化**：当前下游改配后 forwarder 下轮 `getDownstream()` 即生效；**群同步（GroupSyncService）的客户端在启动时构造**，改下游密钥后群同步需重启进程才完全生效——如需群同步也热更，后续把其客户端也改为从 store 惰性取。
- **死信增强**：批量重投/导出/删除 + 前端 DlqPage 接线（`GET /api/dlq` 已就绪）。
- **done 行定时清理**：保留期 + 上限（维护任务）。
