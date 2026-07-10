# WeFlow 群组放行同步接口 · 下游对接文档

> 本文档描述**一个接口**：`syncGroups`（群聊放行同步）。
> 用途：本系统（WeFlow 消息转发代理，**上游/调用方**）把发现的群聊清单同步给下游（work-order-system，**服务方/被调用方**），由**下游裁定哪些群可接收推送**，并把放行名单返回。本系统据此只转发被放行群的消息。
>
> 通用约定（鉴权、统一响应结构、错误码）与《weflow-对接接口规格说明书（work-order-system侧）.md》一致，本文对必要部分做了内联，可独立阅读。

---

## 1. 文档信息

| 项 | 内容 |
|----|------|
| 接口名称 | 群聊放行同步 `syncGroups` |
| 调用方（上游） | WeFlow 消息转发代理（本系统） |
| 服务方（下游） | work-order-system（**本接口由下游实现并提供**） |
| 方向 | 上游 → 下游，单向请求 + 同步应答 |
| 关联接口 | `receiveMessage`（消息接收）；本接口是其**前置闸门**——只有被放行的群，其消息才会走 `receiveMessage` 推送 |

---

## 2. 为什么需要这个接口（放行标志的作用）

本系统会连上 WeFlow、发现该账号下的**所有群聊**。但并非所有群都需要转成工单——**由下游决定放行范围**。

- 本系统本地为每个群维护一个放行标志 `pushAllowed`（`true`/`false`），**默认 `false`（不放行）**。
- 该标志**不由本系统自行决定**，而是每次调用 `syncGroups` 后，用下游返回的 `allowed` 名单回写。
- 放行标志是「群聊转发闸门」的唯一数据源：本系统在两处用它把关——
  1. **拉消息前**：只对放行群拉取/回查历史与实时消息；
  2. **入队前**：逐条消息再校验一次所属群是否放行，未放行一律丢弃、不推 `receiveMessage`。

因此：**下游把某个群放进 `allowed` = 允许该群消息进入工单系统；不放进去 = 该群消息永远不会被推送。**

---

## 3. 接口定义

| 项 | 值 |
|----|----|
| URL | `POST {baseUrl}/extra_server/weflow/syncGroups?task_white_token=<URL编码后的token>` |
| 方法 | `POST` |
| Content-Type | `application/json; charset=utf-8` |
| 请求体读取 | 原始 JSON body（`php://input`），非 form-urlencoded |
| 超时 | 上游侧 30s |

### 3.1 鉴权（task_white_token）

沿用下游 `extra_server` 现有机制，所有接口都用 URL 查询参数 `task_white_token` 鉴权：

1. 上游构造明文 JSON（**字段顺序固定：`key` 在前、`time` 在后、无多余空格**）：
   `{"key":"<分配给本系统的站点key>","time":<unix秒>}`
2. `AES-128-ECB / PKCS7` 加密 → `base64` 编码，得到 `task_white_token`
3. URL 编码后作为 query 附加到请求（base64 含 `+ / =` 必须转义）
4. AES 密钥取约定密钥串的**前 16 字节（ASCII）**

> 详细算法、测试向量见主规格书 §7。鉴权失败下游应返回 `code != 1`（本系统按失败处理，保持原有放行裁决不变）。

---

## 4. 请求参数（本系统 → 下游）

请求体为群快照。**全量与单群增量同结构**（区别只在 `groups` 元素个数，见 §6 调用时机）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | 是 | 连接实例标识。当前单实例固定为 `weflow:default` |
| `platform` | string | 是 | 平台类型。当前固定为 `weflow`（多平台留位） |
| `groups` | array | 是 | 本次上报的群快照数组（可为 1 个或多个；空数组时本系统不会调用本接口） |
| `groups[].sessionId` | string | 是 | **群 ID（`xxx@chatroom`）**。裁决与回写的主键 |
| `groups[].groupName` | string \| null | 否 | 群名（可能为 `null`） |
| `groups[].avatarUrl` | string \| null | 否 | 群头像 URL（**现已启用**，来源 WeFlow ChatLab `meta.groupAvatar`；首次同步或尚未拉到该群消息时可能为 `null`，后续轮次补齐） |
| `groups[].lastMessageAt` | int \| null | 否 | 该群最近一条消息的时间（Unix 秒），供下游参考 |

**请求示例：**

```json
{
  "agentId": "weflow:default",
  "platform": "weflow",
  "groups": [
    { "sessionId": "12345678@chatroom", "groupName": "客户项目群A", "avatarUrl": "https://wx.qlogo.cn/mmcrhead/.../0", "lastMessageAt": 1738713600 },
    { "sessionId": "87654321@chatroom", "groupName": "内部测试群",   "avatarUrl": null, "lastMessageAt": 1738710000 }
  ]
}
```

---

## 5. 返回结果（下游 → 本系统）

统一响应结构，**HTTP 恒为 200**，成败看 `code`：

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | int | 业务码。**`1` = 成功（放行名单有效）**；其余为失败 |
| `msg` | string | 提示信息（成功 `success`，失败为原因） |
| `time` | int | 服务器处理时间（Unix 秒，可选） |
| `data.allowed` | string[] | **可接收推送的群 `sessionId` 集合**（放行名单） |

**成功判定（重要）**：本系统仅在 `HTTP 200 且 body.code == 1` 时采纳 `data.allowed`。其余情况按失败处理。

**响应示例（放行第一个群、拒绝第二个）：**

```json
{
  "code": 1,
  "msg": "success",
  "time": 1738800000,
  "data": { "allowed": ["12345678@chatroom"] }
}
```

**全部拒绝时**（合法结果，不是错误）：

```json
{ "code": 1, "msg": "success", "data": { "allowed": [] } }
```

---

## 6. 放行语义（下游必须遵守）

1. **白名单 + 全量覆盖式裁定**：对本次请求 `groups` 里的每个 `sessionId`，下游要么放进 `allowed`（放行），要么不放（拒绝）。本系统按本次 `groups` 逐个回写：
   - 在 `allowed` 中的 → `pushAllowed = true`
   - **发了但不在 `allowed` 中的 → `pushAllowed = false`**（即：可通过重发这批群 + 从 `allowed` 移除，来**撤销**此前的放行）
2. **仅影响本次上报的群**：本系统只对本次 `groups` 中的 `sessionId` 做回写，不会动本次未上报的群。因此单群增量同步（§6.1 改名场景）只重裁那一个群。
3. **`allowed` 应是本次 `groups` 的子集**：返回未在本次 `groups` 里的 `sessionId` 无效（本系统不会为其建档/放行，直接忽略）。
4. **无需幂等键**：快照覆盖式声明，同一批可重复调用，结果以最后一次为准。

### 6.1 本系统的调用时机（下游据此预期调用频率）

| 时机 | groups 内容 | 说明 |
|------|-------------|------|
| 连接建立（首装/重连/重启） | **全量**：当前 WeFlow 账号下所有群 | 每次成功连上 WeFlow 都会先做一次群同步 |
| 手动「立即同步群」 | 全量 | 运维在本系统后台点触发（`POST /api/weflow/groups/sync`） |
| SSE 检测到新入群 | **单群**：仅该群 | 保活期间 SSE 首次见到一个未登记的群（被拉进新群）时，即时以该群回推、由下游裁决放行（群名此时可能为 `null`，后续轮次补齐） |
| 检测到群改名 | **单群**：仅该群 | 收到群改名系统消息时，以新群名回推该单群、重新裁决；**非放行群的改名经 SSE 同样会触发**该单群重裁（放行后新名可能被下游翻关，改名后新名也可能被翻开） |

> 下游应把每次请求当作**对本次 `groups` 的最新一次权威裁定**来处理，返回完整放行判断即可，无需累积历史。

---

## 7. 失败与容错

| 情形 | 本系统行为 | 对下游的要求 |
|------|-----------|-------------|
| `code == 1` | 采纳 `allowed`，回写放行标志，标记 `synced` | 正常返回放行名单（含空名单） |
| `code != 1` / HTTP 非 200 / 网络错误 / 返回非 JSON | **保持本批群原有放行裁决不变**（不误开、不误关），标记 `failed` 记录原因并告警，下次连接/手动/改名时重试 | 仅在**真正失败**时返回非 `1`；不要用错误码表达「全部拒绝」——「全部拒绝」应是 `code=1 + allowed:[]` |

**关键约定**：`code != 1` 不等于「拒绝所有群」，而是「本次裁定无效、维持现状」。要真正拒绝某群，必须 `code=1` 且把它排除在 `allowed` 之外。

---

## 8. 完整调用示例（curl）

```bash
curl -X POST \
  'https://work-order.example.com/extra_server/weflow/syncGroups?task_white_token=<URL编码后的token>' \
  -H 'Content-Type: application/json; charset=utf-8' \
  -d '{
    "agentId": "weflow:default",
    "platform": "weflow",
    "groups": [
      { "sessionId": "12345678@chatroom", "groupName": "客户项目群A", "lastMessageAt": 1738713600 }
    ]
  }'
```

下游应答：

```json
{ "code": 1, "msg": "success", "time": 1738800000, "data": { "allowed": ["12345678@chatroom"] } }
```

---

## 9. 下游实现清单（最小契约）

- [ ] 提供端点 `POST /extra_server/weflow/syncGroups`，走 `extra_server` 的 `task_white_token` 鉴权
- [ ] 解析请求体 `{ agentId, platform, groups[] }`，以 `groups[].sessionId` 为主键
- [ ] 按自身业务规则（哪些群已开通工单接入）裁定每个群是否放行
- [ ] 返回统一结构，`code=1` 且 `data.allowed` 为**本次放行群 `sessionId` 数组**（是 `groups` 的子集）
- [ ] 「无一放行」返回 `code=1 + allowed:[]`；仅在真正处理失败时返回 `code != 1`
- [ ] 幂等无关：同一批可重复调用，以最后一次为准

---

## 10. 待双方确认

| 项 | 说明 |
|----|------|
| Base URL / 站点 key / AES 密钥 | 由下游线下安全交付 |
| 裁决数据来源 | 下游内部如何维护「哪些群开通工单接入」（后台配置 / 群绑定关系等），属下游业务，不在本契约内 |
| 放行变更是否需实时生效 | 目前放行更新依赖本系统主动调用（连接/手动/改名）；若下游希望「后台改了放行立即生效」，需另约反向通知或缩短本系统的同步周期，请提出 |
