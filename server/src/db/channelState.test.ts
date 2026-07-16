import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import { migrate } from './schema.js'
import { ChannelStateStore } from './channelState.js'

const CH = 'weflow:default'
const PLATFORM = 'weflow'

describe('ChannelStateStore', () => {
    let db: BetterSqlite3.Database
    let store: ChannelStateStore
    beforeEach(() => { db = new BetterSqlite3(':memory:'); migrate(db); store = new ChannelStateStore(db) })
    afterEach(() => db.close())

    it('未初始化时 installTime 为 null', () => {
        expect(store.getInstallTime(CH)).toBeNull()
    })

    it('markInstalled 首次写入，二次不覆盖', () => {
        store.markInstalled(CH, PLATFORM, 1000)
        expect(store.getInstallTime(CH)).toBe(1000)
        store.markInstalled(CH, PLATFORM, 2000)
        expect(store.getInstallTime(CH)).toBe(1000)
    })

    it('advanceWatermark 仅在更大时推进', () => {
        store.advanceWatermark(CH, PLATFORM, 100, 'a', 9000)
        expect(store.get(CH)?.lastSyncTimestamp).toBe(100)
        store.advanceWatermark(CH, PLATFORM, 50, 'b', 9001)
        expect(store.get(CH)?.lastSyncTimestamp).toBe(100)
        expect(store.get(CH)?.lastSyncRawid).toBe('a')
        store.advanceWatermark(CH, PLATFORM, 200, 'c', 9002)
        expect(store.get(CH)?.lastSyncTimestamp).toBe(200)
        expect(store.get(CH)?.lastSyncRawid).toBe('c')
    })

    it('install 与 watermark 互不影响', () => {
        store.advanceWatermark(CH, PLATFORM, 100, 'a', 9000)
        expect(store.getInstallTime(CH)).toBeNull()
        store.markInstalled(CH, PLATFORM, 1000)
        expect(store.get(CH)?.lastSyncTimestamp).toBe(100)
    })

    it('不同 channel 相互隔离', () => {
        store.markInstalled('weflow:a', PLATFORM, 1)
        expect(store.getInstallTime('weflow:b')).toBeNull()
    })

    it('advanceBreakpoint 仅在更大时推进，get 能读回', () => {
        store.advanceBreakpoint(CH, PLATFORM, 100, 'r1', 1)
        expect(store.get(CH)?.breakpointTimestamp).toBe(100)
        store.advanceBreakpoint(CH, PLATFORM, 50, 'r0', 2) // 更小，不动
        expect(store.get(CH)?.breakpointTimestamp).toBe(100)
        expect(store.get(CH)?.breakpointRawid).toBe('r1')
        store.advanceBreakpoint(CH, PLATFORM, 200, 'r2', 3)
        expect(store.get(CH)?.breakpointTimestamp).toBe(200)
        expect(store.get(CH)?.breakpointRawid).toBe('r2')
    })

    it('断点与同步水位互不干扰', () => {
        store.advanceWatermark(CH, PLATFORM, 500, 'w', 1)
        store.advanceBreakpoint(CH, PLATFORM, 100, 'b', 2)
        const s = store.get(CH)
        expect(s?.lastSyncTimestamp).toBe(500)
        expect(s?.breakpointTimestamp).toBe(100)
    })

    it('resetWatermark 清空水位与断点，保留 install_time', () => {
        store.markInstalled(CH, PLATFORM, 1000)
        store.advanceWatermark(CH, PLATFORM, 500, 'w', 2)
        store.advanceBreakpoint(CH, PLATFORM, 300, 'b', 3)

        store.resetWatermark(CH)

        const s = store.get(CH)
        expect(s?.lastSyncTimestamp).toBeNull()
        expect(s?.lastSyncRawid).toBeNull()
        expect(s?.breakpointTimestamp).toBeNull()
        expect(s?.breakpointRawid).toBeNull()
        expect(s?.installTime).toBe(1000) // 保留：不被误判成首装
    })

    it('resetWatermark 对不存在的行是无害空操作', () => {
        store.resetWatermark(CH)
        expect(store.get(CH)).toBeNull()
    })
})
