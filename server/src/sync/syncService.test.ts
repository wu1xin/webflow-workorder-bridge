import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Db } from '../db/database.js'
import { SyncService } from './syncService.js'
import { WEFLOW_CHANNEL_ID } from '../weflow/adapter.js'
import type { WeflowSession, MessagesPage } from '../weflow/restClient.js'

// 最小桩 client：按 talker 返回预设消息页
function stubClient(sessions: WeflowSession[], pages: Record<string, MessagesPage>) {
    return {
        listSessions: () => Promise.resolve(sessions),
        fetchMessagesPage: (talker: string) => Promise.resolve(pages[talker] ?? { messages: [], hasMore: false }),
    }
}

function deps(db: Db, client: ReturnType<typeof stubClient>) {
    const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as never
    return {
        store: {
            get: () => ({ weflow: { host: 'h', port: 1, accessToken: 't' } }),
            getWeflow: () => ({ host: 'h', port: 1, accessToken: 't' }),
        } as never,
        db,
        log: noopLog,
        alert: { send() {} },
        createClient: () => client as never,
    }
}

describe('SyncService 全量同步', () => {
    let db: Db
    beforeEach(() => { db = Db.openMemory() })
    afterEach(() => db.close())

    it('首装全量：去重入队 + 推进水位 + 记首装', async () => {
        const client = stubClient(
            [{ username: 'alice' }],
            { alice: { messages: [
                { serverId: 's1', createTime: 100, content: 'a' },
                { serverId: 's2', createTime: 200, content: 'b' },
                { serverId: 's1', createTime: 100, content: 'a' }, // 重复
            ], hasMore: false } },
        )
        const svc = new SyncService(deps(db, client))
        await svc.runFullSync()

        expect(db.queue.countByStatus('pending')).toBe(2)
        expect(db.channelState.get(WEFLOW_CHANNEL_ID)?.lastSyncTimestamp).toBe(200)
        expect(db.channelState.getInstallTime(WEFLOW_CHANNEL_ID)).not.toBeNull()
        const status = svc.getStatus()
        expect(status.enqueued).toBe(2)
        expect(status.duplicates).toBe(1)
    })
})
