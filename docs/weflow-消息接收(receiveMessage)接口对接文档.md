# WeFlow 消息接收接口 · 下游对接文档（receiveMessage）

> 本文档描述**一个接口**：`receiveMessage`（消息接收）。
> 用途：本系统（WeFlow 消息转发代理，**上游/调用方**）把**放行群**里发现的消息，逐条推送给下游（work-order-system，**服务方/被调用方**）落库成工单。
>
> 本文按**当前代码实现**（`server/src/downstream/client.ts`、`forwarder.ts`、`forwardPolicy.ts`）重写，**以本文为准**——与旧版《weflow-对接接口规格说明书》§4.3 若有出入，以本文为准（差异见 §11）。
> 鉴权、统一响应结构等通用约定与《weflow-群组放行同步接口对接文档.md》一致，本文对必要部分做了内联，可独立阅读。

---

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 接口名称 | 消息接收 `receiveMessage` |
| 调用方（上游） | WeFlow 消息转发代理（本系统） |
| 服务方（下游） | work-order-system（**本接口由下游实现并提供**） |
| 方向 | 上游 → 下游，单向推送 + 同步 ACK 应答 |
| 前置接口 | `syncGroups`（群放行同步）——**只有被放行的群，其消息才会走本接口推送**；见《weflow-群组放行同步接口对接文档.md》 |
| 传输保证 | **至少一次（at-least-once）**：网络抖动/ACK 丢失会触发重投，下游须按 §9 幂等去重 |

---

## 2. 角色与调用链

```
WeFlow(本机)  ──拉取/SSE──▶  本系统(转发代理)  ──HTTPS POST──▶  work-order-system(下游)
                                                          ◀── ACK(code/msg/time/data) ──
```

- 本系统从 WeFlow 拉取消息、按放行群过滤、去重后入本地队列，再由转发 worker 逐条 `POST` 到本接口。
- 下游**只作为服务方**：接收、落库、同步返回 ACK；不主动回连本系统，不下发反向命令。
- 本系统按 ACK 的 `code` 决定该条消息「已送达 / 退避重试 / 进死信」（见 §7、§8）。

---

## 3. 接口定义

| 项 | 值 |
|----|----|
| URL | `POST {baseUrl}/extra_server/weflow/receiveMessage?task_white_token=<URL编码后的token>` |
| 方法 | `POST` |
| Content-Type | `application/json; charset=utf-8` |
| 请求体读取 | 原始 JSON body（`php://input`），**非 form-urlencoded** |
| 超时 | 上游侧 30s（超时按传输层失败处理，见 §7） |

### 3.1 鉴权（task_white_token）

沿用下游 `extra_server` 现有机制，所有接口都用 URL 查询参数 `task_white_token` 鉴权（与 `syncGroups`/`ping` 完全一致）：

1. 上游构造明文 JSON（**字段顺序固定：`key` 在前、`time` 在后、无多余空格**）：
   `{"key":"<分配给本系统的站点key>","time":<unix秒>}`
2. `AES-128-ECB / PKCS7` 加密 → `base64` 编码，得到 `task_white_token`
3. URL 编码后作为 query 附加到请求（base64 含 `+ / =` 必须转义）
4. AES 密钥取约定密钥串的**前 16 字节（ASCII）**
5. 本系统**每次请求实时生成**新 token（`time` 取当前 Unix 秒）

> 详细算法与测试向量见《weflow-对接接口规格说明书（work-order-system侧）.md》§7。
> 鉴权失败下游应返回 `code=1001`（见 §8），本系统据此有限重试后进死信。

---

## 4. 请求体：信封 `{ event, data }`

**⚠️ 当前请求体有三个顶层字段 `event`、`sessionId`、`data`，没有 `file` 字段。**（旧规格书的 `{event, data, file}` 中的 `file` 属媒体链路，本期未启用，见 §11。）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件类型，取值见 §4.1 |
| `sessionId` | string | 是 | **消息所属群/会话 ID（`xxx@chatroom`）**。下游据此把消息归到对应群，见 §4.3 |
| `sender` | object | 否 | **发送人身份**（信封层补充元数据，非 `data` 内字段）：`{ username, name, avatar }`，见 §4.6 |
| `data` | object | 是 | **WeFlow 单条原始消息对象，原样透传**（本系统不增删字段），结构见 §4.2 |

### 4.1 `event` 取值

| 值 | 含义 | 触发来源 |
|----|------|---------|
| `message.new` | 新消息（文本） | 全量/补偿同步、SSE 实时回查 |
| `message.revoke` | 消息撤回 | 撤回对账扫描检测到某条消息被撤回 |

> 本期**只会**出现这两种。`message.revoke` 的 `data` 同样是一条 WeFlow 原始消息（即被撤回消息在 WeFlow 侧的当前行），下游可用 `data.serverId` 定位到此前已落库的原消息，按自身规则处理撤回。

### 4.2 `data` 的结构（WeFlow 原始消息，原样透传）

`data` 是 WeFlow HTTP API `/api/v1/messages` 返回的**单条消息对象**，本系统 `JSON.stringify(message)` 后原样放进信封，**不做字段映射、不增删字段**。常见字段如下（均为 WeFlow 侧定义，下游按需取用、宽松解析）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `serverId` | string | **微信服务端消息 id**。去重/定位主键来源，见 §9。**可能缺失**，缺失时本系统回退用 `localId` |
| `localId` | number | WeFlow 本地消息 id（`serverId` 缺失时的回退键） |
| `localType` | number | WeFlow 消息类型码（文本、系统消息等；映射见《http-api.md》ChatLab 类型表可参考，但此处为 WeFlow 原始码） |
| `createTime` | number | 消息时间戳。**单位以 WeFlow 实际返回为准**——其 API 文档示例为 **13 位毫秒**时间戳（如 `1738713600000`），下游落库前请自行确认并归一 |
| `isSend` | number | 是否本账号发出（`0/1`） |
| `senderUsername` | string | 发送者 `wxid`（群消息为群内成员的 wxid） |
| `content` | string | 消息显示文本 |
| `rawContent` | string | 原始内容（可能存在） |
| `parsedContent` | string | 解析后内容（可能存在） |
| `mediaType` / `mediaFileName` / `mediaUrl` / `mediaLocalPath` | string | 媒体相关字段。**本期媒体消息不经本接口转发（见 §5），故正常不会出现**；即便出现，`mediaUrl`/`mediaLocalPath` 也是 WeFlow 本机地址，**远端不可达**，下游不应依赖 |

> **除上表字段外，WeFlow 返回的其它字段也会一并透传**（本系统不裁剪），下游应对未知字段保持宽容。

### 4.3 群标识：用顶层 `sessionId` 关联

消息所属的群/会话 ID 由**顶层 `sessionId`** 字段携带（值形如 `xxx@chatroom`），下游据此把消息落到对应群/会话。

- `sessionId` 是**信封层的路由元数据**，独立于 `data`；`data` 保持 WeFlow 原文不动、不含群标识（故请**用 `sessionId`、而非 `data` 里的字段**来判断群归属）。
- 请勿依赖 `data.senderUsername` 反推群——它是发送者 wxid、不是会话。
- 群消息该字段恒为群 ID（`xxx@chatroom`）；本期只转发群聊，正常不会出现空值。

### 4.4 请求示例（`message.new` · 文本）

```json
{
  "event": "message.new",
  "sessionId": "12345678@chatroom",
  "sender": {
    "username": "wxid_sender",
    "name": "无心",
    "avatar": "https://wx.qlogo.cn/mmhead/ver_1/xxxxx/0"
  },
  "data": {
    "localId": 123,
    "serverId": "7382910473820193",
    "localType": 1,
    "createTime": 1738713600000,
    "isSend": 0,
    "senderUsername": "wxid_sender",
    "content": "你好，我的订单还没发货"
  }
}
```

### 4.5 请求示例（`message.revoke` · 撤回）

```json
{
  "event": "message.revoke",
  "sessionId": "12345678@chatroom",
  "data": {
    "localId": 456,
    "serverId": "7382910473820199",
    "localType": 10000,
    "createTime": 1738713900000,
    "senderUsername": "wxid_sender",
    "content": "对方撤回了一条消息"
  }
}
```

> `data.serverId` 与被撤回原消息一致，下游据此关联。

### 4.6 发送人身份 `sender`（信封层补充元数据）

`data` 里只有 `senderUsername`（wxid），没有微信名和头像。本系统在同步时从 WeFlow ChatLab 成员信息补出发送人身份，放到**顶层 `sender`**（不写入 `data`，`data` 仍原样透传）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `sender.username` | string \| null | 发送人 wxid，等于 `data.senderUsername`；下游可统一从 `sender.*` 取用 |
| `sender.name` | string \| null | 发送人微信名（群昵称/昵称）。**可能为 `null`**（非好友、系统消息、或该条未解析到成员） |
| `sender.avatar` | string \| null | 发送人头像 URL（`wx.qlogo.cn` 链接）。**可能为 `null`**（同上） |

- 下游展示发言人时**优先用 `sender.name`/`sender.avatar`**，为 `null` 时请自行兜底（如名字首字 + 色块占位）。
- `avatar` 是微信 CDN 直链，是否代理/缓存由下游决定。
- `message.revoke` 事件本期 `sender` 为 `null`（撤回靠 `data.serverId` 定位原消息，不依赖 sender）。

| 消息种类 | 是否经本接口推送 | 说明 |
|---------|-----------------|------|
| 放行群的**文本**新消息 | ✅ 是 | `event=message.new` |
| 放行群的**撤回**事件 | ✅ 是 | `event=message.revoke` |
| 放行群的**媒体**消息（图片/语音/视频/表情/文件） | ❌ **本期不推送** | 本系统队列中保留为 pending，待二期媒体链路上线后补发；下游本期不会收到媒体 |
| **未放行群**的任何消息 | ❌ 永不推送 | 由 `syncGroups` 放行闸门在推送前拦截 |
| 非群会话（单聊等） | ❌ 不推送 | 本期仅转发群聊 |

---

## 6. 响应结构（下游 → 本系统）

统一响应结构，**HTTP 恒为 200**，成败看 `code`：

```json
{
  "code": 1,
  "msg": "success",
  "time": 1750000001,
  "data": {
    "message_id": 0,
    "duplicate": false,
    "received_at": 1750000001,
    "retryable": true
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | int | 是 | 业务码。**`1` = 成功（肯定 ACK）**；其余为失败，取值见 §8 |
| `msg` | string | 否 | 提示信息（成功 `success`，失败为原因；会被本系统记入日志/审计） |
| `time` | int | 否 | 服务器处理时间（Unix 秒） |
| `data.message_id` | int\|string | 否 | 落库后的消息记录 id；本系统仅记录，不参与判定，未落库前可返回 `0`/占位 |
| `data.duplicate` | bool | 否 | 是否幂等命中（重复消息）。命中时**仍须返回 `code=1`**，本系统视为成功、不再重发 |
| `data.received_at` | int | 否 | 服务器接收时间（Unix 秒），本系统写入审计 |
| `data.retryable` | bool | 否 | **失败时**给出的重试建议：`true`=可重试、`false`=不可重试（本系统据此决定重试或直接死信，见 §8）。成功时忽略 |

> 本系统解析的 `data` 字段为 **snake_case**：`message_id` / `duplicate` / `received_at` / `retryable`，请严格按此命名。

---

## 7. 成功判定 ⚠️ 重点

本系统判定一条消息「已成功送达并被接受」（肯定 ACK）的规则**必须**为：

```
HTTP 状态码 == 200  且  响应 body 中  code == 1
```

- **不要**用 HTTP 状态码表达业务成败：本系统所有成功/失败业务应答都应是 **HTTP 200**，成败在 `body.code`。
- 仅当收到 `code==1`（含 `duplicate==true` 的幂等命中），本系统才把该条标记为 `done` 并推进投递断点、出队。
- 「传输层失败」——**HTTP 非 200 / 网络错误 / 超时 / 响应体非合法 JSON**——一律按可重试的传输错误处理（见 §8），与业务码无关。

---

## 8. 错误码与本系统的重试/死信决策

本系统按下表处理 ACK（默认参数：通用重试上限 **3 次尝试**、鉴权重试上限 **2 次尝试**；退避 `2s` 起指数增长、上限 `60s`，含随机抖动）：

| ACK `code` | `data.retryable` | 本系统行为 | 是否计入熔断¹ |
|-----------|------------------|-----------|:---:|
| `1` | — | **成功**（done）。`duplicate=true` 也是成功，不重发 | 否 |
| `1001` 鉴权失败 | — | **有限重试**（最多 2 次尝试）后进死信；应排查 siteKey/aesKey/时钟 | 否 |
| `1002` 请求体/参数错误 | — | **立即进死信**（不重试，确定性错误，重发也会失败） | 否 |
| `1003` 媒体引用无效 | — | **立即进死信**（不重试） | 否 |
| 其它非 `1`（`0`/`1004`/`1005`/未识别码） | `false` | **立即进死信** | 是 |
| 其它非 `1`（`0`/`1004`/`1005`/未识别码） | `true` 或缺省 | **退避重试**（最多 3 次尝试）后进死信 | 是 |
| — | — | **传输层失败**（非 200 / 网络错 / 超时 / 非 JSON）：退避重试（最多 3 次尝试）后进死信 | 是 |

> ¹ **熔断**：连续「计入熔断」的失败达 **5 次** → 打开熔断，暂停转发 **30s** 后半开重试。目的是下游整体不可用时不空烧重试。`1/1001/1002/1003` 不计入熔断（属单条消息层面的确定性结果，非「下游不可用」信号）。

**给下游的落地建议：**

- 消息成功落库（或幂等命中）→ 返回 `code=1`。
- 报文本身有问题（缺必填、解析失败）→ 返回 `code=1002`，本系统直接死信、不再骚扰。
- 鉴权失败 → 返回 `code=1001`。
- 服务端临时故障（DB 抖动、内部异常）→ 返回 `code=1005`（或 `1004`），并置 `data.retryable=true`，本系统会退避重试。
- **不要**用错误码表达「这条我不想要」——本系统会当失败重试/死信。放行范围由 `syncGroups` 控制，不在本接口。

---

## 9. 幂等与去重（下游必须实现）

传输保证是**至少一次**：ACK 丢失、传输层报错但下游其实已处理、退避重投等，都可能让**同一条消息到达下游多次**。下游必须去重。

- **去重键 = `event` + `data.serverId`**（`serverId` 缺失时回退 `data.localId`）。这与本系统内部去重键一致（本系统对同一 `serverId` 只会入队一次，但跨重试仍可能重复投递）。
- 命中重复：**不重复落库**，仍返回 `code=1` 且 `data.duplicate=true`。本系统据此视为成功、不再重发。
- `message.new` 与 `message.revoke` 是不同 `event`，即便 `serverId` 相同也不互相视为重复。

---

## 10. 完整调用示例（curl）

```bash
curl -X POST \
  'https://work-order.example.com/extra_server/weflow/receiveMessage?task_white_token=<URL编码后的token>' \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{
    "event": "message.new",
    "sessionId": "12345678@chatroom",
    "data": {
      "localId": 123,
      "serverId": "7382910473820193",
      "localType": 1,
      "createTime": 1738713600000,
      "isSend": 0,
      "senderUsername": "wxid_sender",
      "content": "你好，我的订单还没发货"
    }
  }'
```

下游应答（成功）：

```json
{ "code": 1, "msg": "success", "time": 1750000001, "data": { "message_id": 10086, "duplicate": false, "received_at": 1750000001 } }
```

---

## 11. 与旧规格书（§4.3）的差异说明

本接口的**实际实现**与旧版《weflow-对接接口规格说明书（work-order-system侧）.md》§4.3 有以下出入，**以本文为准**：

| 项 | 旧规格书 | 当前实现（本文） |
|----|---------|-----------------|
| 顶层字段 | `{ event, data, file }` | **`{ event, sessionId, data }`**，无 `file`（媒体链路二期） |
| 媒体消息 | 两步式（先 `uploadMedia` 拿 `file_id`，消息体引用 `file`） | **本期不转发媒体消息**，媒体链路（含 `uploadMedia`/`file`）二期再上 |
| `data` 字段样例 | `rawid` / `timestamp` / `sessionId` / `sourceName` 等理想化字段 | **WeFlow 原始消息原样透传**：`serverId` / `createTime` / `senderUsername` / `content` 等（无 `rawid`/`sourceName`） |
| 去重键 | `event + data.rawid` | **`event + data.serverId`**（回退 `localId`）——`rawid` 即对应 `serverId` |
| 群标识 | 曾示意 `data.sessionId`（在 `data` 内） | **顶层 `sessionId`**（信封层，独立于 `data`），见 §4.3 |

---

## 12. 下游实现清单（最小契约）

- [ ] 提供端点 `POST /extra_server/weflow/receiveMessage`，走 `extra_server` 的 `task_white_token` 鉴权
- [ ] 以 `php://input` 读原始 JSON body，解析顶层 `{ event, sessionId, data }`（`data` 为对象，宽松取字段）
- [ ] 用顶层 `sessionId`（`xxx@chatroom`）关联消息所属群/会话，**不要**从 `data` 里找群标识
- [ ] 展示发言人时用顶层 `sender.name`/`sender.avatar`（可能为 `null`，需兜底占位），见 §4.6
- [ ] 落库前按 §9 用 `event + data.serverId`（回退 `localId`）做幂等去重；重复返回 `code=1 + data.duplicate=true`
- [ ] 处理 `event=message.new`（新消息）与 `event=message.revoke`（撤回）两类
- [ ] 成功统一返回 **HTTP 200 + `code=1`**；失败返回对应错误码（`1001`/`1002`/`1003`/`1004`/`1005`）并在 `data.retryable` 给重试建议（§8）
- [ ] 对 `data` 的未知/多余字段保持宽容，不因多字段报错
- [ ] `createTime` 单位按 WeFlow 实际返回（疑似毫秒）自行归一，见 §4.2

---

## 13. 待双方确认

| 项 | 说明 |
|----|------|
| Base URL / 站点 key / AES 密钥 | 由下游线下安全交付（与 `syncGroups` 共用同一套鉴权） |
| `createTime` 单位 | 需确认 WeFlow 返回是秒还是毫秒（其 API 文档示例为 13 位毫秒），双方对齐归一口径 |
| 撤回落库行为 | `message.revoke` 的 `data` 为 WeFlow 侧撤回后的行；下游如何据 `serverId` 关联并标记原消息为撤回，属下游业务 |
| 媒体（二期） | 媒体消息经何种方式送达（两步式上传 `uploadMedia` + `file` 引用，或其它），二期启动前再定 |
| `data.localType` 取值 | 如需按 WeFlow 消息类型码精确分流，双方对齐 `localType` 到业务类型的映射表 |

---

## 14. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v1.0 | 2026-07-06 | 按当前代码实现重写：信封收敛为 `{event,data}`（无 `file`）、`data` 为 WeFlow 原始消息透传、明确本期只转发文本/撤回、ACK 判定与错误码→重试/死信/熔断决策、去重键改为 `event+serverId`、标注群标识缺失等待确认项 |
| v1.1 | 2026-07-06 | 信封新增顶层 `sessionId`（`xxx@chatroom`）承载群标识，下游据此关联消息到群；`data` 仍为 WeFlow 原文（§4.3）。同步更新示例/差异表/实现清单 |
| v1.2 | 2026-07-06 | 信封新增顶层 `sender`（发送人 `username/name/avatar`，来源 WeFlow ChatLab members，可为 `null`），下游据此展示发言人名字+头像；`data` 仍原样透传（§4.6）。同步更新字段表/示例 |
