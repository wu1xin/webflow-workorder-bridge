# weflow → work-order-system 消息接收接口规格说明书
# （work-order-system 侧 / 对接文档）

> 本文档是 **work-order-system（工单系统，下游/服务方）** 对外提供的接口契约，供 **WeFlow 消息转发代理（Windows 客户端，上游/调用方）** 对接。
> 它是对方《weflow 工单消息转发代理 需求规格说明书 v0.5》中三个核心待确认项的回应：**Q-B（业务接口与 ACK）**、**Q-L（媒体接收方式）**、**Q-C（心跳端点）**，并明确 **Q-E（幂等键）**。
> **首版仅定稿"线上契约"（端点、字段、鉴权、ACK、幂等、错误码），具体业务落库逻辑由 work-order-system 后续实现。**

---

## 文档信息

| 项目 | 内容 |
|------|------|
| 文档名称 | weflow 消息接收接口规格说明书（work-order-system 侧） |
| 版本 | v0.1（草稿，待评审） |
| 编写日期 | 2026-06-10 |
| 服务方 | work-order-system（ThinkPHP 5 / FastAdmin） |
| 调用方 | WeFlow 消息转发代理（.NET 8 Windows 客户端） |
| 对应上游文档 | 《weflow 工单消息转发代理 需求规格说明书 v0.5》 |

### 关键决策（已确认）

| 决策点 | 结论 |
|--------|------|
| 鉴权方式 | **复用现有 `extra_server` 模式**：`task_white_token`（AES 加密 `{key,time}` + 站点 key 白名单） |
| 媒体接收 | **两步式上传端点**：代理先 `multipart` 上传媒体 → 我方返回 `file_id`+`url`；消息体再引用 `file_id` |
| 消息请求体 | **信封 `{event, data, file}`**：`data` 为 WeFlow 原始数据直通，`file` 为已上传到本系统的媒体文件信息（仅媒体消息含），我方内部自行映射 |

---

## 0. 本文档与对方 SRS 待确认项的对应关系

| 对方编号 | 对方问题 | 本文档回应 |
|----------|----------|-----------|
| **Q-B** | 业务接口地址/方法/鉴权/请求体，及 ACK 格式/成功判定字段 | §2.2 鉴权、§2.3 响应、§2.4 ACK、§4.3 消息接收 |
| **Q-L** | 下游如何接收媒体（上传端点/内联/对象存储）；类型与大小上限 | §4.2 媒体上传（两步式上传端点） |
| **Q-C** | 心跳接收端点地址/方法/鉴权/请求体 | §4.4 心跳上报 |
| **Q-E** | 下游是否支持幂等键 | §2.5 幂等与去重（支持，键 = `event + rawid`） |
| Q-G/Q-I | 媒体导出就绪时延、峰值速率等 | 属上游侧参数，本文档不约束；见 §8 |

---

## 1. 角色与调用方向

```
WeFlow(本机)  ──SSE──▶  代理(Windows/.NET)  ──HTTPS POST──▶  work-order-system(本系统)
                                                       ◀── ACK(code/msg/time/data) ──
```

- 本系统**只作为服务方（被调用方）**，对外暴露 HTTP 接口；不主动连接代理，不下发反向控制命令（对方 Q-F 已确认无需）。
- 全部业务消息单向：WeFlow → 代理 → 本系统。心跳为代理→本系统的附加出站调用。
- 代理与本系统之间为公网/内网 HTTP 调用，**强制 HTTPS**。

---

## 2. 通用约定

### 2.1 网络与协议

| 项 | 约定 |
|----|------|
| Base URL | `https://{work-order-system 域名}`（具体域名我方线下提供，见 §8） |
| 路由风格 | `{base}/extra_server/weflow/{action}`（ThinkPHP 模块/控制器/方法；若未开启 URL 重写则为 `{base}/index.php/extra_server/weflow/{action}`） |
| 方法 | `POST`（媒体上传为 `POST multipart/form-data`；连通性测试 `ping` 兼容 `GET`） |
| Content-Type | 消息/心跳：`application/json; charset=utf-8`；媒体上传：`multipart/form-data` |
| 字符编码 | UTF-8 |
| 请求体读取 | 我方以 `php://input` 读取**原始 JSON body**（非 form-urlencoded），请代理以 JSON 原文发送 |

### 2.2 鉴权（task_white_token）

所有接口均通过 URL 查询参数 `task_white_token` 鉴权（复用本系统 `extra_server` 现有机制）：

1. 代理构造明文 JSON：`{"key":"<分配给代理的站点key>","time":<unix秒>}`
2. 用约定密钥做 **AES-128-ECB / PKCS7** 加密，再 **base64** 编码，得到 `task_white_token`
3. 作为查询参数附加到每个请求 URL（**base64 含 `+ / =`，务必 URL 编码**）

```
POST https://{base}/extra_server/weflow/receiveMessage?task_white_token=<URL编码后的token>
```

| 参数 | 说明 |
|------|------|
| `key` | 我方为 WeFlow 代理分配的站点标识，加入服务端白名单后生效。建议值：`weflow-agent-7f3c2a91-0d44-4e6b-bc2f-1a9e88d54c10`（**待我方确认并写入白名单**） |
| `time` | 当前 Unix 时间戳（秒）。建议代理**每次请求实时生成**新 token（见 §6 时效校验） |
| AES 密钥 | 由我方**线下安全交付**（与现有 `extra_server` 共用同一密钥；AES-128 实际仅取密钥串前 16 字节，详见 §7 与示例代码） |

> 鉴权失败时返回 `code=0`（见 §4 各接口错误码表），代理应将其视为**不可重试的配置类错误**（除非 `time` 过期，重新生成 token 后可重试）。

### 2.3 统一响应结构

所有接口**统一返回 HTTP 200**，业务结果体现在 body 内（本系统框架会把业务码归一化到 HTTP 200）：

```json
{
  "code": 1,
  "msg": "success",
  "time": 1750000000,
  "data": { }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | int | **业务码。`1` = 成功（肯定 ACK）；`0` = 通用失败；其余见各接口错误码表** |
| `msg` | string | 提示信息（成功为 `success` 或具体描述；失败为错误原因） |
| `time` | int | 服务器处理时间（Unix 秒） |
| `data` | object\|null | 业务数据 |

### 2.4 ACK 成功判定 ⚠️ 重点

> **⚠️ 与对方 SRS 的默认假设相反，请代理务必按此配置成功判定规则。**
> 对方 SRS（FR-FWD-05）示例写的是 `code==0` 为成功；**本系统沿用 FastAdmin 约定，`code==1` 才是成功。**

代理判定一条消息"已成功送达并被接受"（肯定 ACK）的规则**必须**为：

```
HTTP 状态码 == 200  且  响应 body 中  code == 1
```

- **不要**用 HTTP 状态码判定成败：本系统所有响应都是 HTTP 200，真正的成败在 `body.code`。
- 仅当收到肯定 ACK（`code==1`）后，代理才推进断点、消息出队（对方 FR-FWD-06）。
- `code==0` 或其它非 1 业务码 → 按 §2.6 的 `retryable` 提示决定重试或入死信。

### 2.5 幂等与去重（Q-E：支持）

本系统**支持幂等**，幂等键为 **`event + data.rawid`**（对方已确认 `rawid == serverId`，实时与补偿路径共用同一去重表；下文简称 `event+rawid`）。

| 场景 | 行为 |
|------|------|
| 首次接收某 `event+rawid` | 正常处理，`data.duplicate = false` |
| 重复接收同一 `event+rawid`（补偿/重投/重试导致） | **不重复写工单**，仍返回 `code=1`（幂等成功），`data.duplicate = true`。代理应将其视为成功，**不再重发** |

- 媒体上传接口幂等键为 **`rawid + mediaFileName`**（可选，命中返回同一 `file_id`，避免同一媒体重复落地）。
- 该约定满足对方 FR-RECV-03 / FR-REL-04 的"至少一次 + 去重"语义。

### 2.6 错误码与可重试性

为配合对方 FR-FWD-07（区分可重试/不可重试），失败响应在 `data.retryable` 中给出建议（`true`=可重试，`false`=需人工/改配置，不应无脑重试）：

| `code` | 含义 | `data.retryable` | 说明 |
|--------|------|------------------|------|
| `1` | 成功（肯定 ACK） | — | 正常或幂等命中 |
| `0` | 通用失败/未分类 | `true` | 兜底失败码 |
| `1001` | 鉴权失败（token 无效/无权/过期） | `false`* | *若因 `time` 过期，重生成 token 后可重试 |
| `1002` | 请求体解析失败/必填参数缺失 | `false` | 报文问题，重发同样会失败 |
| `1003` | 媒体引用无效（`file_id` 不存在/已过期） | `false` | 需重新上传媒体 |
| `1004` | 媒体上传失败（存储/IO 错误） | `true` | 服务端临时故障 |
| `1005` | 服务端内部错误 | `true` | 服务端临时故障，建议退避重试 |

> 错误码为**目标契约**；当前 `extra_server` 基类对鉴权失败统一返回 `code=0`，我方实现 `Weflow` 控制器时按本表细化。代理实现时建议：未识别的 `code`（非 1）一律按 `code=0` 处理，并参考 `data.retryable`（缺省按可重试）。

---

## 3. 接口清单总览

| # | 用途 | 接口 | 方法 | 对应 SRS |
|---|------|------|------|----------|
| 1 | 连通性测试 | `/extra_server/weflow/ping` | GET/POST | FR-TEST-03 连接测试 |
| 2 | 媒体上传（第 1 步） | `/extra_server/weflow/uploadMedia` | POST multipart | Q-L / FR-MEDIA-04 |
| 3 | 消息接收（第 2 步） | `/extra_server/weflow/receiveMessage` | POST json | Q-B / FR-FWD-01 / FR-PASS |
| 4 | 心跳上报 | `/extra_server/weflow/heartbeat` | POST json | Q-C / FR-HB |
| 5 | 群聊同步 | `/extra_server/weflow/syncGroups` | POST json | 群推送白名单同步 |

所有接口均需 `?task_white_token=...`（§2.2）。

---

## 4. 接口详情

### 4.1 连通性测试 `ping`

供对方 FR-TEST-03（连接测试 / 一键诊断）探活，验证地址、鉴权是否正确。

- **URL**：`POST|GET {base}/extra_server/weflow/ping?task_white_token=...`
- **请求体**：无（或空 JSON `{}`）
- **响应**：

```json
{
  "code": 1,
  "msg": "pong",
  "time": 1750000000,
  "data": { "server_time": 1750000000, "version": "1.0.0" }
}
```

---

### 4.2 媒体上传 `uploadMedia`（Q-L · 两步式第 1 步）

代理判定为媒体消息后，先把从 WeFlow 取回的本地媒体文件上传到本系统，拿到 `file_id` 与可访问 `url`，再在 §4.3 消息体中引用。

- **URL**：`POST {base}/extra_server/weflow/uploadMedia?task_white_token=...`
- **Content-Type**：`multipart/form-data`

**请求字段（form fields）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | file（二进制） | 是 | 媒体文件本体（图片/语音/视频/动画表情） |
| `rawid` | string | 是 | 所属消息的 `rawid`（=`serverId`），用于关联与幂等 |
| `sessionId` | string | 否 | 会话标识 |
| `mediaType` | string | 否 | `image` / `voice` / `video` / `emoji` |
| `mediaFileName` | string | 否 | WeFlow 原始文件名（含扩展名） |
| `timestamp` | int | 否 | 消息时间戳（秒） |

**响应（成功）：**

```json
{
  "code": 1,
  "msg": "success",
  "time": 1750000000,
  "data": {
    "file_id": "att_20260610_8f3a2c91",
    "url": "https://{base}/uploads/weflow/2026/06/10/8f3a2c91.jpg",
    "size": 204813,
    "mime": "image/jpeg",
    "duplicate": false
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| `file_id` | string | 媒体在本系统的唯一标识，**消息体须引用此值** |
| `url` | string | 媒体可访问地址（下游/我方域名下，远端可达；解决"WeFlow 本机地址远端不可达"问题） |
| `size` | int | 字节大小 |
| `mime` | string | MIME 类型 |
| `duplicate` | bool | 是否为幂等命中（`rawid+mediaFileName` 已上传过，复用已有文件） |

**约束与错误：**

- **支持类型**：在本系统上传安全策略允许的范围内**尽量全部支持**（图片/语音/视频/动画表情等 WeFlow 产生的媒体，如 png/jpg/gif/webp/wav/mp3/mp4 等）。最终放行以本系统附件上传**白名单与安全校验**为准——出于安全会拦截可执行文件等危险类型；命中安全拦截返回 `code=1002`（不可重试）。
- **单文件大小上限**：建议 `50MB`（**待我方确认**，见 §8）。超限返回 `code=1002`（不可重试）。
- 存储/IO 失败返回 `code=1004`（可重试）。
- 媒体与消息的事务性由对方保证（FR-MEDIA-05）：媒体上传成功 → 再发消息引用；二者任一失败整条入对方重试/死信，不发"半条"。

---

### 4.3 消息接收 `receiveMessage`（Q-B · 两步式第 2 步）

接收 WeFlow 转发的消息。**请求体为 `{event, data, file}` 信封**：`data` 为 WeFlow 原始数据（JSON）直通，`file` 为 §4.2 上传后回传的媒体文件信息（仅媒体消息含此字段）。

- **URL**：`POST {base}/extra_server/weflow/receiveMessage?task_white_token=...`
- **Content-Type**：`application/json`

**请求体字段（顶层信封）：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `event` | string | 是 | 事件类型：`message.new` / `message.revoke` |
| `data` | object | 是 | **WeFlow 原始数据直通**（原样转发，字段不管；我方内部映射） |
| `file` | object | 否 | 上传到本系统的媒体文件信息（**仅媒体消息含此字段**，引用 §4.2 上传结果，字段见下表） |

**`data` 子对象（WeFlow 原始数据，对应对方 FR-RECV-01）：**

**`file` 子对象（仅媒体消息，引用 §4.2 上传结果）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `file_id` | string | §4.2 返回的 `file_id` |
| `url` | string | §4.2 返回的可访问 `url` |
| `mediaType` | string | `image` / `voice` / `video` / `emoji` / 其它（按 WeFlow 实际类型） |
| `mediaFileName` | string | 原始文件名 |
| `size` | int | 字节大小 |

> 注：若一条消息含多个媒体，`file` 可为对象数组；首版按单媒体对象约定，如对方有多媒体需求请在 §8 提出。

**请求示例（文本消息）：**

```json
{
  "event": "message.new",
  "data": {
    "rawid": "1009384756",
    "timestamp": 1750000000,
    "sessionId": "wxid_abc123",
    "sessionType": "single",
    "content": "你好，我的订单还没发货",
    "sourceName": "张三",
    "avatarUrl": "http://127.0.0.1:5031/avatar/abc.png"
  }
}
```

**请求示例（媒体消息）：**

```json
{
  "event": "message.new",
  "data": {
    "rawid": "1009384757",
    "timestamp": 1750000050,
    "sessionId": "wxid_abc123",
    "sessionType": "single",
    "content": "[图片]",
    "sourceName": "张三"
  },
  "file": {
    "file_id": "att_20260610_8f3a2c91",
    "url": "https://{base}/uploads/weflow/2026/06/10/8f3a2c91.jpg",
    "mediaType": "image",
    "mediaFileName": "IMG_0001.jpg",
    "size": 204813
  }
}
```

**响应（成功 / 肯定 ACK）：**

```json
{
  "code": 1,
  "msg": "success",
  "time": 1750000001,
  "data": {
    "message_id": 0,
    "duplicate": false,
    "received_at": 1750000001
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| `message_id` | int\|string | 本系统落库后的消息记录 id（**首版未实现落库前可能返回 `0`/占位**） |
| `duplicate` | bool | 是否幂等命中（重复消息）。命中时仍为 `code=1`，代理视为成功不重发 |
| `received_at` | int | 服务器接收时间（Unix 秒） |

**说明：**

- 同步 ACK：本接口在校验、去重（、后续落库）后**同步**返回 ACK，代理据此判定（§2.4）。
- `message.revoke`：默认接受并按 `event+rawid` 处理；本系统对撤回的具体落库行为后续实现。
- 字段映射：本系统内部把 `data` 映射到自身会话域（`Chat` 会话 / `ChatMessage` 消息 / `PlatformUser` 平台用户）。**该映射逻辑为我方内部实现，对代理透明**——代理只需按 `{event, data, file}` 信封发送（`data` 原样直通、`file` 引用上传结果）。

---

### 4.4 心跳上报 `heartbeat`（Q-C）

代理周期（默认 30s，对方可配）上报链路健康（对方 FR-HB）。本系统据此判断上下游链路是否正常；**不下发反向控制**（仅可在响应中给出非强制建议）。

- **URL**：`POST {base}/extra_server/weflow/heartbeat?task_white_token=...`
- **Content-Type**：`application/json`

**请求体字段（对应对方 FR-HB-02）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `agentId` | string | 代理实例标识 |
| `version` | string | 代理版本 |
| `timestamp` | int | 上报时间（Unix 秒） |
| `sseStatus` | string | SSE 连接状态：`connected`/`connecting`/`disconnected`/`reconnecting`/`authFailed`/`weflowNotReady` |
| `weflowHealth` | string | WeFlow `/health` 结果：`ok`/`down` |
| `lastMessageTime` | int | 最近收到消息的时间（Unix 秒） |
| `breakpointTimestamp` | int | 当前补偿断点时间戳 |
| `queueBacklog` | int | 队列积压条数 |
| `dlqCount` | int | 死信条数 |
| `lastCatchupResult` | object | 上次补偿结果，如 `{"at":1750000000,"pulled":12,"forwarded":10}` |
| `mediaStats` | object | 媒体统计，如 `{"fetched":5,"uploadOk":5,"uploadFail":0,"avgSizeKB":180}` |
| `totalSuccess` | int | 累计成功转发数 |
| `totalFail` | int | 累计失败数 |

**响应（成功）：**

```json
{
  "code": 1,
  "msg": "success",
  "time": 1750000000,
  "data": {
    "server_time": 1750000000,
    "suggest_interval": 30
  }
}
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| `server_time` | int | 服务器时间（可用于代理校时） |
| `suggest_interval` | int | （可选，非强制）建议的下次心跳间隔秒数；代理可忽略 |

**双重故障可见（对方 FR-HB-04）：**

- 心跳内 `sseStatus`/`weflowHealth` 异常 → 上游问题；
- 本系统超过 N 个周期未收到心跳 → 代理/主机/网络问题。该"心跳缺失告警"由**本系统侧后续实现**（如定时巡检最后心跳时间）。

---

### 4.5 群聊同步 `syncGroups`

代理拉取 WeFlow 群聊会话后，把群快照同步给本系统；本系统返回**可接收推送**的群名单（白名单语义）。代理据此只推送被放行群的消息。

- **URL**：`POST {base}/extra_server/weflow/syncGroups?task_white_token=...`
- **Content-Type**：`application/json`

**请求体字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | 代理/连接实例标识 |
| `platform` | string | 是 | 平台类型（多平台留位，当前 `weflow`） |
| `groups[].sessionId` | string | 是 | 群 ID（`xxx@chatroom`），裁决与回写主键 |
| `groups[].groupName` | string | 否 | 群名 |
| `groups[].avatarUrl` | string | 否 | 群头像 |
| `groups[].lastMessageAt` | int | 否 | 该群最近消息时间（秒） |

**请求示例：**

```json
{
  "agentId": "weflow:default",
  "platform": "weflow",
  "groups": [
    { "sessionId": "xxx@chatroom", "groupName": "项目群", "avatarUrl": "https://.../g.jpg", "lastMessageAt": 1738713600 }
  ]
}
```

**响应（成功 / 肯定 ACK）：**

```json
{ "code": 1, "msg": "success", "time": 1750000000, "data": { "allowed": ["xxx@chatroom"] } }
```

| 返回字段 | 类型 | 说明 |
|----------|------|------|
| `data.allowed` | string[] | 可接收推送的群 `sessionId` 集合 |

**语义约定：**

- **白名单**：本次请求里发了、但不在 `data.allowed` 的群 → 代理标记为不推送。
- 失败（`code!=1`）→ 代理保持该批群原有裁决（不误开），下次连接/增量触发重试。
- 快照覆盖式声明，本系统按 `agentId+allowed` 全量裁定，无需幂等键。
- 鉴权与成功判定沿用 §2.2（task_white_token）与 §2.4（`body.code==1` 为成功）。

---

## 5. 字段映射说明（仅供我方内部参考，对代理透明）

代理只负责"原样直通 + 媒体引用"，无需关心以下映射。本系统内部预期的映射方向（落库逻辑后续实现）：

| 信封字段 | 本系统会话域（参考） |
|----------|----------------------|
| `data.sessionId` / `data.sourceName` / `data.avatarUrl` | 平台用户 `PlatformUser`（昵称/头像/来源标识） |
| `data.sessionId`（+ 业务规则） | 会话 `Chat` 归属 |
| `data.content` / `file` | 消息 `ChatMessage`（`source=平台用户`；文本 `type=文本`、媒体 `type=文件`） |
| `event` + `data.rawid` | 去重键（持久化去重表） |
| `data.timestamp` | 消息时间 / 补偿断点 |

> 工单/会话的归属与创建规则（新会话 or 追加到已有工单、平台用户匹配等）属本系统业务，不在本对接契约范围内。

---

## 6. 安全要求

| 项 | 要求 |
|----|------|
| 传输 | 强制 HTTPS（媒体上传、消息、心跳） |
| 凭据保管 | 代理侧 AES 密钥、`site key` 加密存储（对方 FR-SEC-01 / DPAPI），日志脱敏含 token 的 URL |
| token 时效 | 现有 `extra_server` 的 `time` 时效校验暂未启用；**建议我方启用**并设容差（如 ±10 分钟），代理每次请求实时生成 token（见 §8） |
| 密钥下发 | AES 密钥与 `site key` 由我方**线下安全交付**，不写入共享文档正文 |
| 媒体清理 | 代理本地临时媒体转存成功后清理（对方 FR-SEC-04） |

---

## 7. 联调测试向量与 .NET 示例

### 7.1 鉴权算法（已用现网实现验证）

- 算法：**AES-128-ECB**，填充 **PKCS7**
- 密钥：约定密钥串的**前 16 字节（ASCII）**（AES-128 要求 16 字节密钥；与现有 PHP `openssl AES-128-ECB` 行为一致——超长密钥自动截断取前 16 字节，已实测确认）
- 流程：`base64( AES-128-ECB-PKCS7( utf8(明文JSON) ) )`，结果作为 `task_white_token`（URL 编码后附加到 query）

### 7.2 测试向量（请代理用此验证本地实现）

> 用固定明文加密，应得到与下方完全一致的 token（密钥前 16 字节由我方线下提供）。

```
明文(plaintext):
{"key":"weflow-agent-7f3c2a91-0d44-4e6b-bc2f-1a9e88d54c10","time":1750000000}

期望 token(base64):
xXV/+T/U3UK+JEyWdPirSkKCQD3nK0PDNlGUJtj0CdZNxH2z2jSM12UsRUnDOwx/p4a5OYEu9oawO0IOK2qWIP8CVrIMt6QvgZjowRwQGr0=
```

> 注：明文 JSON 的字段顺序与空格需与上方一致（`key` 在前、`time` 在后、无多余空格），否则密文不同。`time` 实际使用时为当前时间戳。

### 7.3 .NET（C#）生成 token 示例

```csharp
using System;
using System.Security.Cryptography;
using System.Text;

public static class WeflowAuth
{
    // 注意：AES-128 取约定密钥串的前 16 字节（ASCII）。完整密钥由 work-order-system 线下提供。
    private static readonly byte[] AesKey = Encoding.ASCII.GetBytes("<约定密钥前16字节>"); // 例如 16 个 ASCII 字符

    public static string BuildTaskWhiteToken(string siteKey)
    {
        long now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        // 字段顺序固定：key 在前，time 在后，无多余空格
        string payload = $"{{\"key\":\"{siteKey}\",\"time\":{now}}}";

        using var aes = Aes.Create();
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.PKCS7;
        aes.Key = AesKey;

        using var enc = aes.CreateEncryptor();
        byte[] data = Encoding.UTF8.GetBytes(payload);
        byte[] cipher = enc.TransformFinalBlock(data, 0, data.Length);
        return Convert.ToBase64String(cipher); // 附加到 URL 前需 Uri.EscapeDataString(...)
    }
}
```

---

## 8. 待双方进一步确认 / 待我方实现清单

### 8.1 待我方（work-order-system）提供或确认

| 项 | 说明 |
|----|------|
| Base URL（域名/环境） | 测试 + 生产环境域名 |
| `site key` | 确认分配给代理的站点 key 并写入 `extra_server` 白名单 |
| AES 密钥下发 | 线下安全交付（前 16 字节即生效密钥） |
| 媒体单文件大小上限 | 默认建议 50MB，确认最终值 |
| `time` 时效校验 | 是否启用、容差时长 |
| 错误码细化 | 在 `Weflow` 控制器中按 §2.6 落地 `1001~1005` 与 `data.retryable` |

### 8.2 待我方后续实现（首版仅契约，逻辑后续）

- `extra_server/Weflow` 控制器四个 action：`ping` / `uploadMedia` / `receiveMessage` / `heartbeat`
- 媒体落地存储（复用现有附件 `CommonAttachment` 基础设施）并返回可访问 `url`
- `event+rawid` 去重表与幂等返回
- WeFlow `data` → 会话域（`Chat`/`ChatMessage`/`PlatformUser`）映射与落库
- 心跳记录与"心跳缺失"巡检告警

### 8.3 待对方（代理）确认

| 项 | 说明 |
|----|------|
| 是否存在多媒体消息 | 若一条消息含多个媒体，`media` 改为数组（§4.3 注） |
| `sessionType` 取值集合 | 已明确：群聊 = `type===2` 或 `username` 以 `@chatroom` 结尾；本期仅转发群聊 |
| 媒体上传与消息发送的先后与事务 | 确认遵循"先上传媒体拿 file_id → 再发消息引用"（FR-MEDIA-05 事务性） |

---

## 9. 修订记录

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.1 | 2026-06-10 | 初稿：定稿鉴权（复用 task_white_token）、媒体两步式上传、消息直通、ACK（code==1）、幂等（event+rawid）、心跳端点、错误码、.NET 示例与已验证测试向量 |

---

*本文档为 work-order-system 侧对接契约 v0.1 草稿，与对方《weflow 消息转发代理 SRS v0.5》配套。最关键提醒：**ACK 成功判定为 `body.code == 1`**（与对方 SRS 示例相反），请按 §2.4 配置。*
