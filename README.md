# weflow-workorder-bridge

WeFlow → work-order-system 消息转发桥接服务（Node.js + Vue）。

与 WeFlow 同机部署，通过本机 SSE 接收微信消息事件，转发到远端工单系统。
详见需求与架构设计文档：[docs/plans/2026-06-17-weflow-bridge-v2-需求与架构设计.md](docs/plans/2026-06-17-weflow-bridge-v2-需求与架构设计.md)。

> 当前为**可运行的脚手架骨架**，业务逻辑尚未实现。

## 目录结构

```
.
├── server/          # 后端：Node.js + TypeScript + Fastify
│   └── src/index.ts # HTTP 入口（/healthz、/api/status 占位 + 托管前端产物）
├── web/             # 前端：Vue 3 + Vite + TypeScript + Element Plus + Pinia
│   └── src/         # main.ts / App.vue / router / pages（5 个占位页面）
└── docs/            # 对接文档与需求/架构设计
```

## 环境要求

- Node.js >= 20（已在 22.x 验证）

## 安装

在仓库根目录执行（npm workspaces 一次装好前后端）：

```bash
npm install
```

## 开发（前后端同时启动）

```bash
npm run dev
```

- 后端：http://localhost:8787 （`/healthz`、`/api/status`）
- 前端：http://localhost:5170 （Vite dev server，已代理 `/api`、`/healthz` 到后端）

浏览器打开 http://localhost:5170 ，在「总览/状态」页点「检查后端连通」可验证前后端打通。

也可分别启动：`npm run dev:server` / `npm run dev:web`。

## 构建与生产运行

```bash
npm run build   # 先构建前端（web/dist），再编译后端（server/dist）
npm start       # 启动后端，同端口托管前端产物，访问 http://localhost:8787
```

可用环境变量 `HOST`、`PORT` 覆盖监听地址与端口（默认 `0.0.0.0:8787`）。

## 数据存储与清除

运行期数据落在本机应用数据目录 `%LOCALAPPDATA%\weflow-bridge\`（非 Windows 回退 `~/.local/share/weflow-bridge/`）：

| 文件 | 作用 |
|------|------|
| `bridge.db`（+`-wal`/`-shm`） | SQLite 库：转发队列、去重、同步水位、审计、媒体幂等 |
| `config.json` | WeFlow 连接配置（`accessToken` 加密存储） |
| `key` | 加密 `config.json` 的机器绑定主密钥 |

### 清除数据（保留文件与表结构，回到初始状态）

> ⚠️ 清除前务必先停掉 server——`bridge.db` 被独占、`VACUUM` 需要独占锁，运行中会报锁错。

**仅清数据库**（清空 5 张业务表并 `VACUUM` 回收空间，保留 WeFlow 连接配置）：

```bash
npm -w server run reset-data
```

**数据库 + 配置**（额外把 `config.json` 重置为「未配置」态，需重新在界面填写连接参数；`key` 文件保留）：

```bash
npm -w server run reset-data -- --with-config
```

脚本（[server/scripts/reset-data.mjs](server/scripts/reset-data.mjs)）只清空 `queue`/`dedup`/`channel_state`/`audit`/`media_cache` 五张业务表内容，保留表结构、库文件与 `meta.schemaVersion`（清除版本号会让下次启动误判 schema 版本并触发重建）。下次启动时缺失的库表/配置会自动按默认值重建。
