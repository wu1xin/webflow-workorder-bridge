# weflow-wos-bridge

WeFlow ↔ Work-Order-System 消息中转代理（Windows 同机部署）

## 概述

本程序与 WeFlow 同机部署，作为轻量级消息中转代理：

- **SSE 接收**：订阅 WeFlow 本机 SSE 端点，实时获取新消息事件
- **文本直通**：`text` / `markdown` 类消息直接封装后转发给 WOS
- **媒体两步式**：图片、音频、视频、文件类消息先上传至 WOS 获取 `fileRef`，再以 `{event, data, file}` 信封调用 `receiveMessage`
- **成功判定**：以 WOS 返回体 `code === 1` 作为成功标准
- **拉取补偿**：SSE 断连重连时，自动拉取 `?since=<lastId>` 补偿期间丢失的消息
- **心跳**：定期向 WOS 发送心跳，让下游感知链路健康

## 目录结构

```
src/
  config.js           配置（全部可通过环境变量覆盖）
  index.js            入口，启动 SSE 客户端与心跳
  sseClient.js        SSE 客户端，含自动重连与补偿调用
  messageHandler.js   消息分发：文本直通 vs 媒体两步式
  mediaUploader.js    媒体上传（multipart/form-data → WOS）
  wosClient.js        WOS HTTP 客户端（receiveMessage / heartbeat）
  pullCompensation.js 断连补偿：拉取并重放遗漏消息
  heartbeat.js        定时心跳
test/
  messageHandler.test.js
  mediaUploader.test.js
  wosClient.test.js
  pullCompensation.test.js
```

## 快速开始

```bash
npm install
npm start
```

## 配置（环境变量）

| 变量                   | 默认值                                  | 说明                        |
|----------------------|-----------------------------------------|-----------------------------|
| `WEFLOW_SSE_URL`     | `http://127.0.0.1:9527/sse/messages`   | WeFlow SSE 端点              |
| `WEFLOW_PULL_URL`    | `http://127.0.0.1:9527/messages`       | WeFlow 拉取端点              |
| `WOS_BASE_URL`       | `http://127.0.0.1:8080`                | WOS 基础 URL                 |
| `WOS_RECEIVE_PATH`   | `/api/receiveMessage`                  | receiveMessage 路径          |
| `WOS_UPLOAD_PATH`    | `/api/uploadFile`                      | 文件上传路径                  |
| `WOS_HEARTBEAT_PATH` | `/api/heartbeat`                       | 心跳路径                     |
| `HEARTBEAT_INTERVAL_MS` | `30000`                             | 心跳周期（毫秒）               |
| `RECONNECT_DELAY_MS` | `5000`                                 | SSE 断连重连延迟（毫秒）       |
| `REQUEST_TIMEOUT_MS` | `10000`                                | HTTP 请求超时（毫秒）          |

## 消息信封格式

```json
{ "event": "newMessage", "data": { ... }, "file": "<fileRef>" }
```

`file` 字段仅媒体类消息存在，值为 WOS 上传接口返回的 `data.fileRef` 或 `data.url`。

## 运行测试

```bash
npm test
```

## 依赖

- [axios](https://github.com/axios/axios) ≥ 1.16.0
- [eventsource](https://github.com/EventSource/eventsource) ^2.0.2
- [form-data](https://github.com/form-data/form-data) ≥ 4.0.4