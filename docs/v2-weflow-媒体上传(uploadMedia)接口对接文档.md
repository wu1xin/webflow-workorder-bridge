# WeFlow 媒体上传接口 · 下游对接文档（uploadMedia）

> 本文档描述**一个接口**：`uploadMedia`（媒体上传）。
> 用途：本系统（WeFlow 消息转发代理，**上游/调用方**）在转发**媒体消息**（图片/语音/视频/文件等）时，先把媒体二进制上传到下游（work-order-system，**服务方/被调用方**），换回一个 `file_id` + 可访问 `url`；随后在 `receiveMessage` 的信封里用 `file` 字段引用它，完成「先传媒体、再发消息」的两步式转发。
>
> 鉴权、统一响应结构、错误码→重试/死信等通用约定与《v2-weflow-消息接收(receiveMessage)接口对接文档.md》《weflow-群组放行同步接口对接文档.md》一致，本文对必要部分做了内联，可独立阅读。
>
> **实施状态**：本接口下游侧**已实现并可用**（含上传至阿里云 OSS、幂等复用、安全类型拦截）。但端到端媒体转发链路属**二期**——当前 `receiveMessage` 信封尚无 `file` 字段、上游本期不转发媒体（见 receiveMessage 文档 §5/§11）。本文为二期媒体链路启用前的对接契约，届时上游开始「先 `uploadMedia` 再在 `receiveMessage` 引用」即自动生效。

---

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 接口名称 | 媒体上传 `uploadMedia` |
| 调用方（上游） | WeFlow 消息转发代理（本系统） |
| 服务方（下游） | work-order-system（**本接口由下游实现并提供**） |
| 方向 | 上游 → 下游，单向上传 + 同步应答 |
| 传输编码 | `multipart/form-data`（**二进制文件 + 表单字段**，非 JSON body） |
| 关联接口 | `receiveMessage`（消息接收）——媒体消息在其信封 `file` 字段引用本接口返回的 `file_id`，见 §8 |
| 传输保证 | **至少一次（at-least-once）**：网络抖动/应答丢失会触发重传，下游按 §6 幂等复用（同一媒体不重复落地） |

---

## 2. 角色与两步式调用链

媒体消息采用「**先传媒体、再发消息**」两步式（普通文本消息只走第 2 步、无需第 1 步）：

```
① 上传媒体                                            ② 发送消息（引用媒体）
本系统  ──multipart POST uploadMedia──▶  下游          本系统  ──JSON POST receiveMessage──▶  下游
        ◀── { file_id, url, ... } ──                          ◀── ACK(code=1) ──
```

- **第 1 步（本接口）**：上游把一条媒体的二进制 `POST` 到 `uploadMedia`，下游落地存储（当前上传至阿里云 OSS）并返回 `file_id` + 公网 `url`。
- **第 2 步（receiveMessage）**：上游在消息信封里带上 `file`（引用第 1 步的 `file_id`），把这条媒体消息作为普通消息推送；下游校验 `file_id` 有效后落库（`file_id` 无效返回 `1003`）。
- 下游**只作为服务方**：接收、存储、返回结果；不主动回连上游。

---

## 3. 接口定义

| 项 | 值 |
|----|----|
| URL | `POST {baseUrl}/extra_server/weflow/uploadMedia?task_white_token=<URL编码后的token>` |
| 方法 | `POST` |
| Content-Type | `multipart/form-data`（由 HTTP 客户端按 multipart 自动生成 boundary，**勿手工拼 JSON**） |
| 请求体 | 一个二进制文件字段 `file` + 若干文本表单字段（见 §4） |
| 单文件限制 | **仅支持单文件**：`file` 为数组（多文件）时报 `1002` |
| 大小上限 | **50 MB**（`MEDIA_MAX_SIZE`，待双方最终确认，见 §12） |
| 超时 | 上游侧建议 ≥30s（大文件上传耗时更长，可适当放大） |

### 3.1 鉴权（task_white_token）

与 `receiveMessage`/`syncGroups`/`ping` **完全一致**，走 `extra_server` 的 URL 查询参数鉴权：

1. 上游构造明文 JSON（**字段顺序固定：`key` 在前、`time` 在后、无多余空格**）：
   `{"key":"<分配给本系统的站点key>","time":<unix秒>}`
2. `AES-128-ECB / PKCS7` 加密 → `base64` 编码，得到 `task_white_token`
3. URL 编码后作为 query 附加到请求（base64 含 `+ / =` 必须转义）
4. AES 密钥取约定密钥串的**前 16 字节（ASCII）**
5. 本系统**每次请求实时生成**新 token（`time` 取当前 Unix 秒）

> 详细算法与测试向量见《weflow-对接接口规格说明书（work-order-system侧）.md》§7。
> 鉴权失败下游返回 `code=1001`，上游据此有限重试后进死信。

---

## 4. 请求参数（multipart 表单字段）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file（二进制） | 是 | 媒体文件本体。**仅单文件**；缺失或传成数组（多文件）→ `1002` |
| `rawid` | string | 是 | 该媒体所属消息的去重键（语义即消息 `serverId`，缺失回退 `localId`，与 `receiveMessage` 去重键同源）。**幂等键组成之一**，见 §6；缺失 → `1002` |
| `mediaFileName` | string | 否 | 媒体原始文件名（带扩展名，如 `voice.amr`）。缺省时取上传文件自身的文件名。**扩展名用于安全校验与落地命名**，见 §4.2 |
| `mediaType` | string | 否 | WeFlow 媒体类型标识（如 image/voice/video/file），仅作元数据留存，不参与校验 |

> **对多余字段保持宽容**：上游若额外携带 `sessionId`/`timestamp` 等字段，下游当前**接收但忽略**，不因多字段报错。

### 4.1 幂等键与去重命名说明

- **幂等键 = `channel` + `rawid` + `mediaFileName`**（`channel` 由下游内部固定，上游无需传）。同一三元组重复上传 → 直接复用旧文件、返回 `duplicate=true`（见 §6）。
- 落地对象键（OSS object）由下游按 `weflow/YYYY/MM/DD/<hash>.<扩展名>` 生成（`<hash>` 由 `rawid`+文件名+时间派生），上游**无需关心**，只用返回的 `url`。

### 4.2 类型/大小约束（安全拦截，`1002` 不可重试）

1. **大小**：`file` 超过 **50 MB** → `1002`。
2. **扩展名黑名单**：从 `mediaFileName`（回退上传文件名）取扩展名，**无扩展名**或命中危险名单 → `1002`。名单为可执行/脚本 + 浏览器可执行类型：
   `php php3 php4 php5 phtml pht exe bat cmd com sh bash js jsp asp aspx jar msi dll vbs ps1 py pl htaccess html htm xhtml shtml mhtml svg svgz swf xml xsl xslt`
   > WeChat 真实媒体仅图片/语音/视频/文件，正常不会命中；黑名单作纵深防御（详见控制器 `DANGEROUS_EXT` 注释）。

### 4.3 请求示例（curl · multipart）

```bash
curl -X POST \
  'https://work-order.example.com/extra_server/weflow/uploadMedia?task_white_token=<URL编码后的token>' \
  -F 'file=@/path/to/photo.jpg;type=image/jpeg' \
  -F 'rawid=7382910473820193' \
  -F 'mediaFileName=photo.jpg' \
  -F 'mediaType=image'
```

---

## 5. 响应结构（下游 → 上游）

统一响应结构，**HTTP 恒为 200**，成败看 `code`：

```json
{
  "code": 1,
  "msg": "success",
  "time": 1750000001,
  "data": {
    "file_id": "att_20260709_1a2b3c4d5e6f7a8b",
    "url": "https://static-task-system.oss-cn-hangzhou.aliyuncs.com/weflow/2026/07/09/9f2c1a7b3e4d5f6a7b8c.jpg",
    "size": 204813,
    "mime": "image/jpeg",
    "duplicate": false
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | int | 业务码。**`1` = 成功**；其余为失败，取值见 §7 |
| `msg` | string | 提示信息（成功 `success`，失败为原因） |
| `time` | int | 服务器处理时间（Unix 秒） |
| `data.file_id` | string | **媒体句柄（不透明 token）**，形如 `att_YYYYMMDD_<16位hex>`。上游**原样保存**，第 2 步在 `receiveMessage` 的 `file.file_id` 引用它 |
| `data.url` | string | 媒体的**公网可访问绝对 URL**（当前为阿里云 OSS 直链）。上游按**不透明字符串**对待，勿自行拼接/解析 |
| `data.size` | int | 文件字节数 |
| `data.mime` | string | 服务端探测的 MIME 类型（如 `image/jpeg`） |
| `data.duplicate` | bool | 是否幂等命中（该媒体此前已上传）。命中时**仍返回 `code=1`**，`file_id`/`url` 为旧记录值 |

### 5.1 成功判定（重要）

上游判定「上传成功」的规则**必须**为：

```
HTTP 状态码 == 200  且  响应 body 中  code == 1
```

- 收到 `code==1`（含 `duplicate==true`）即视为成功，保存 `file_id`/`url` 进入第 2 步。
- **不要**用 HTTP 状态码表达业务成败：所有业务应答都是 HTTP 200，成败在 `body.code`。
- 「传输层失败」（HTTP 非 200 / 网络错误 / 超时 / 响应体非合法 JSON）一律按可重试的传输错误处理（见 §7）。

---

## 6. 幂等与去重（下游已实现）

传输保证是**至少一次**，同一媒体可能因重传到达多次。下游按 **`channel + rawid + mediaFileName`** 去重：

- 命中已有记录：**不重复落地存储**，直接返回旧的 `file_id`/`url`，并置 `data.duplicate=true`（仍 `code=1`）。
- 因此上游对同一媒体安全重试；只要 `rawid` + `mediaFileName` 稳定，多次上传恒返回同一 `file_id`。

---

## 7. 错误码与上游的重试/死信决策

上游按下表处理应答（与 `receiveMessage` §8 同一套决策：默认通用重试上限 3 次、鉴权 2 次；退避 2s 起指数增长、上限 60s）：

| ACK `code` | `data.retryable` | 含义 | 上游行为 |
|-----------|------------------|------|-----------|
| `1` | — | 成功（含 `duplicate=true`） | 保存 `file_id`/`url`，进入第 2 步 |
| `1001` | — | 鉴权失败 | 有限重试（≤2 次）后死信；排查 siteKey/aesKey/时钟 |
| `1002` | `false` | 报文/参数错误、文件缺失/多文件、超大、类型不允许 | **立即死信**（确定性错误，重传也会失败） |
| `1004` | `true` | **媒体上传/存储失败**（OSS 上传异常、元数据写库失败等临时故障） | **退避重试**（≤3 次）后死信 |
| `1005` | `true` | 服务端内部错误 | 退避重试后死信 |
| — | — | 传输层失败（非 200 / 网络错 / 超时 / 非 JSON） | 退避重试后死信 |

> 本接口下游侧实际使用的失败码为：**`1002`（参数/类型/大小，不可重试）**、**`1004`（存储/写库失败，可重试）**；鉴权 `1001` 由框架统一处理。
> **给上游的落地建议**：`1002` 说明这条媒体本身不合法（改重试也没用），应直接放弃/告警而非死磕；`1004`/`1005` 是临时故障，退避重试即可。

---

## 8. 第二步：在 receiveMessage 里引用媒体（`file` 字段）

拿到 `file_id` 后，上游把这条媒体消息作为普通消息推送：在 `receiveMessage` 信封里增加顶层 `file` 字段引用它（其余字段同 receiveMessage 文档 §4）。

`file` 支持**单对象**或**数组**两种形态；每个元素**必须含 `file_id`**，且该 `file_id` 能在下游查到（否则整条消息返回 `1003` 媒体引用无效、不可重试）：

```json
{
  "event": "message.new",
  "sessionId": "12345678@chatroom",
  "sender": { "username": "wxid_sender", "name": "无心", "avatar": "https://wx.qlogo.cn/.../0" },
  "data": {
    "serverId": "7382910473820193",
    "localType": 3,
    "createTime": 1738713600,
    "isSend": 0,
    "senderUsername": "wxid_sender",
    "content": "[图片]"
  },
  "file": { "file_id": "att_20260709_1a2b3c4d5e6f7a8b", "url": "https://.../photo.jpg" }
}
```

> - 单媒体用对象 `{...}`；一条消息多媒体用数组 `[{...},{...}]`。
> - 下游只校验 `file_id` 存在性；`url` 等其它字段可带可不带（以 `file_id` 为准）。
> - ⚠️ **本期 `receiveMessage` 尚未启用 `file` 字段**（媒体链路二期），上述为二期启用后的引用方式。

---

## 9. 存储说明（媒体落地在哪）

- 媒体文件**上传至阿里云 OSS**（对象键 `weflow/YYYY/MM/DD/<hash>.<扩展名>`），下游本地**不留副本**；返回的 `url` 为 OSS 公网直链。
- `url` 是否可直接在浏览器/客户端打开，取决于 OSS bucket 为公共读（当前用法如此）。上游把 `url` 当不透明字符串使用即可。
- 该存储实现（本地 → OSS）为下游内部细节，**不影响本接口契约**：上游始终只关心 `file_id` + `url`。

---

## 10. 完整调用示例（两步 · curl）

**第 1 步 · 上传媒体：**

```bash
curl -X POST \
  'https://work-order.example.com/extra_server/weflow/uploadMedia?task_white_token=<token>' \
  -F 'file=@/path/to/photo.jpg;type=image/jpeg' \
  -F 'rawid=7382910473820193' \
  -F 'mediaFileName=photo.jpg' \
  -F 'mediaType=image'
# ← { "code":1, "data":{ "file_id":"att_20260709_1a2b3c4d5e6f7a8b", "url":"https://.../photo.jpg", "size":204813, "mime":"image/jpeg", "duplicate":false } }
```

**第 2 步 · 发消息引用媒体（receiveMessage，二期启用）：**

```bash
curl -X POST \
  'https://work-order.example.com/extra_server/weflow/receiveMessage?task_white_token=<token>' \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{
    "event": "message.new",
    "sessionId": "12345678@chatroom",
    "data": { "serverId": "7382910473820193", "localType": 3, "createTime": 1738713600, "isSend": 0, "senderUsername": "wxid_sender", "content": "[图片]" },
    "file": { "file_id": "att_20260709_1a2b3c4d5e6f7a8b" }
  }'
# ← { "code":1, "msg":"success", "data":{ "message_id":10087, "duplicate":false, "received_at":1750000002 } }
```

---

## 11. 上游接入清单（最小契约）

- [ ] 用 `multipart/form-data` `POST` 到 `/extra_server/weflow/uploadMedia`，走 `task_white_token` 鉴权
- [ ] 表单必带 `file`（**单文件**）与 `rawid`；建议带 `mediaFileName`（含正确扩展名，供安全校验/命名）、`mediaType`
- [ ] 单文件 ≤ 50 MB；不要上传黑名单扩展名（会 `1002` 死信）
- [ ] 按 §5.1 判定成功（HTTP 200 且 `code==1`），保存返回的 `file_id`/`url`（当作不透明值）
- [ ] 同一媒体重传安全：保持 `rawid`+`mediaFileName` 稳定即幂等复用（`duplicate=true` 也是成功）
- [ ] 失败按 §7 处理：`1002` 直接放弃/告警，`1004`/`1005` 退避重试
- [ ] 二期发媒体消息时，在 `receiveMessage` 信封加顶层 `file`（单对象或数组，每项含 `file_id`），见 §8

---

## 12. 待双方确认

| 项 | 说明 |
|----|------|
| Base URL / 站点 key / AES 密钥 | 由下游线下安全交付（与 `receiveMessage`/`syncGroups` 共用同一套鉴权） |
| 单文件大小上限 | 当前下游取 **50 MB**，需与上游实际媒体大小分布对齐后最终确认 |
| `file` 引用形态 | 一条消息含多媒体时用数组；单媒体用对象——二期启用前确认上游实际发送形态 |
| `mediaType` 取值表 | 如需按媒体类型精确分流，双方对齐 WeFlow `mediaType` 到业务类型的映射 |
| OSS 直链可访问性 | 确认 bucket 公共读策略与直链在客户端/后台的可访问性（含防盗链/有效期，如有） |
| 媒体链路启用时机 | 二期何时开启 `receiveMessage` 的 `file` 字段与上游媒体转发，双方对齐排期 |

---

## 13. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-07-09 | 首版：按当前 `uploadMedia` 代码实现编写——multipart 上传（单文件/50MB/扩展名黑名单）、幂等键 `channel+rawid+mediaFileName`、响应 `file_id/url/size/mime/duplicate`、错误码 `1002`(不可重试)/`1004`(可重试)、媒体已改为上传阿里云 OSS、并说明第 2 步在 `receiveMessage` 用 `file` 引用（媒体链路二期启用） |
