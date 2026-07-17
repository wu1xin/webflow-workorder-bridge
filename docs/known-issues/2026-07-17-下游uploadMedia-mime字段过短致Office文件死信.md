# 下游 uploadMedia：`mime` 字段过短导致 Office 文件上传失败（需下游修复）

- 日期：2026-07-17
- 状态：**待下游修复**（桥侧无代码问题，修复后死信可重投恢复）
- 影响接口：`POST /extra_server/weflow/uploadMedia`
- 影响范围：所有 MIME 类型较长的文件，实测 xlsx 必现；docx / pptx 同理必现

## 1. 现象

群里一条文件消息 `2026-06绩效 吴鑫.xlsx`（49313 字节），桥侧成功定位本地文件并上传，
下游 uploadMedia 三次均返回 `code=1004`，按重试策略（maxAttempts=3）耗尽后进入死信（DLQ）。

桥侧队列死信记录（queue 表 id=2364，external_id=368643480206921459）：

```
status:     dead
attempts:   3
fail_code:  1004
last_error: code=1004 msg=媒体元数据写入失败：SQLSTATE[22001]: String data,
            right truncated: 1406 Data too long for column 'mime' at row 1
```

三次尝试均为同一错误，间隔 2s / 4s 退避，从入队到死信共约 19 秒——典型的**确定性错误重试无效**特征。

## 2. 根因

下游在写媒体元数据时，MySQL 对 `mime` 列报 `1406 Data too long`（严格模式下写入直接失败）。

xlsx 的标准 MIME 类型为：

```
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
```

长度 **65 字符**，超过了下游媒体表 `mime` 列的当前宽度（推测为 VARCHAR(32) 或更短）。

同族 Office 类型全部超长，只要有人发这类文件就必然失败：

| 扩展名 | MIME 类型 | 长度 |
| --- | --- | --- |
| .xlsx | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | 65 |
| .docx | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | 71 |
| .pptx | `application/vnd.openxmlformats-officedocument.presentationml.presentation` | 73 |

说明：桥侧 multipart 的 `file` 分片未显式携带 Content-Type（等效 `application/octet-stream`），
该长 MIME 值是下游按文件扩展名自行推断后写库的，问题完全在下游侧。

## 3. 修复建议（下游）

### 3.1 必改：加宽 `mime` 列

```sql
ALTER TABLE <媒体表> MODIFY COLUMN `mime` VARCHAR(255) NOT NULL DEFAULT '';
```

按 RFC 6838，MIME 的 type / subtype 各最长 127 字符，加 `/` 理论上限 255，
建议一步到位用 `VARCHAR(255)`，避免以后再踩别的长类型（如某些 vendor 类型、带后缀的 `+json` 类型）。

### 3.2 建议：写库前防御性截断或规范化

即使加宽到 255，写入前对 `mime` 做一次 `mb_substr($mime, 0, 255)`（或等效）兜底，
保证元数据写入永远不会因单个字段超长而使整条上传失败。

### 3.3 建议：确定性错误返回 `retryable: false`

本次错误是确定性的（字段长度不够，重试结果不变），但下游返回的 `code=1004` 未携带
`retryable` 字段，桥侧按"未知/可能临时"处理，白白烧掉 3 次重试才进死信。

建议下游对这类**确定性失败**（写库约束错误、参数校验失败等）在响应中显式返回：

```json
{ "code": 1004, "msg": "...", "data": { "retryable": false } }
```

桥侧已支持：收到 `retryable: false` 会直接判死信，不做无效重试。

## 4. 修复后验证

1. 下游执行 DDL 后，用任意 xlsx/docx/pptx 文件调 uploadMedia，确认返回 `code=1`，`data.file_id` 非空；
2. 通知桥侧（或自行在桥的消息管理页）对死信消息点击「重投」，该消息将带附件正常送达；
3. 查下游媒体表确认 `mime` 完整写入 `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`。

## 5. 相关文档

- 上传接口契约：[v2-weflow-媒体上传(uploadMedia)接口对接文档](../v2-weflow-媒体上传(uploadMedia)接口对接文档.md)
- 桥侧重试/死信策略：`server/src/downstream/forwardPolicy.ts`（1004 按 maxAttempts=3 退避重试；`retryable:false` 直接死信）
