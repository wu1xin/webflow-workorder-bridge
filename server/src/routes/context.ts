// 路由共享的应用上下文：配置 store、WeFlow 连接管理器、同步服务、数据库。
import type { ConfigStore } from '../config/store.js'
import type { WeflowConnectionManager } from '../weflow/connectionManager.js'
import type { SyncService } from '../sync/syncService.js'
import type { Db } from '../db/database.js'

export interface AppContext {
    store: ConfigStore
    manager: WeflowConnectionManager
    sync: SyncService
    db: Db
}
