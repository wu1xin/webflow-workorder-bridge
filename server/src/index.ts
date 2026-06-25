/**
 * WeFlow → work-order-system 桥接服务 —— HTTP 入口。
 *
 * 已落地：WeFlow 上游连接生命周期（配置保存/加载、三级连接判定、初次连接、运行期掉线
 * 最终判断、固定间隔重连循环）与配套接口（/api/config、/api/test/weflow-connect、
 * /api/control/reconnect、/api/status）。逻辑见 docs/weflow-链路连接逻辑（仅上游）.md。
 *
 * 尚未实现（属其它模块）：消息转发、媒体处理、补偿/全量同步落库、死信、审计等，
 * 见 docs/plans/2026-06-17-weflow-bridge-v2-需求与架构设计.md。
 */
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { existsSync } from 'node:fs'
import { Db } from './db/database.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ConfigStore } from './config/store.js'
import { SyncService } from './sync/syncService.js'
import { HttpDownstreamClient } from './downstream/client.js'
import { GroupSyncService } from './sync/groupSyncService.js'
import { registerTestRoutes } from './routes/test.js'
import { registerSyncRoutes } from './routes/sync.js'
import { type AppContext } from './routes/context.js'
import { createLogAlertChannel } from './weflow/hooks.js'
import { registerStatusRoutes } from './routes/status.js'
import { registerStreamRoutes } from './routes/stream.js'
import { registerConfigRoutes } from './routes/config.js'
import { registerControlRoutes } from './routes/control.js'
import { WeflowConnectionManager } from './weflow/connectionManager.js'

const here = dirname(fileURLToPath(import.meta.url))

const HOST = process.env.HOST ?? '0.0.0.0'
const PORT = Number(process.env.PORT ?? 8787)

const app = Fastify({
    logger: {
        // 日志对 access_token 脱敏（FR-CONN-08 / FR-LOG-05）
        redact: {
            paths: ['req.headers.authorization', '*.access_token', 'target.access_token'],
            censor: '***',
        },
    },
})

// 加载配置（缺文件则为「未配置」态）、开库、装配同步服务与连接管理器
const store = ConfigStore.load()
const db = Db.open()
const alert = createLogAlertChannel(app.log)
const downstreamCfg = store.getDownstream()
const groupSync = downstreamCfg
    ? new GroupSyncService({ db, downstream: new HttpDownstreamClient(downstreamCfg, app.log), log: app.log, alert })
    : undefined
if (!groupSync) app.log.warn('[startup] 未配置 downstream，群同步停用，消息默认不推送')
const sync = new SyncService({ store, db, log: app.log, alert, groupSync })
const manager = new WeflowConnectionManager({
    store,
    log: app.log,
    sync,
    alert,
})
const ctx: AppContext = { store, manager, sync, db }

// 健康检查（本地 /healthz，对应 FR-MON-04）
app.get('/healthz', async () => ({ status: 'ok' }))

// 业务接口
registerConfigRoutes(app, ctx)
registerTestRoutes(app, ctx)
registerControlRoutes(app, ctx)
registerStatusRoutes(app, ctx)
registerStreamRoutes(app, ctx)
registerSyncRoutes(app, ctx)

// 生产环境：托管 Vue 构建产物（web/dist）。开发期前端走 Vite dev server（见 web/vite.config.ts 的 /api 代理）。
const webDist = join(here, '../../web/dist')
if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist })
    // SPA 回退：非 API 路由统一回 index.html，交给前端路由
    app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api') || req.url.startsWith('/healthz')) {
            reply.code(404).send({ error: 'Not Found' })
            return
        }
        reply.sendFile('index.html')
    })
}

app.listen({
    host: HOST,
    port: PORT,
}).then(() => {
    manager.start() // 服务起来后发起 WeFlow 连接
}).catch((err) => {
    app.log.error(err)
    process.exit(1)
})
